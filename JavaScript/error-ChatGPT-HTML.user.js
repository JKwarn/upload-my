// ==UserScript==
// @name         ChatGPT 会话 HTML 导出器
// @namespace    https://github.com/JKwarn/upload-my
// @version      2.3.0
// @description  导出完整 ChatGPT 会话，保留 Markdown、DIL 布局组件及 Mermaid 图表
// @match        https://chatgpt.com/c/*
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js
// @require      https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '2.3.0';
  const PREFIX = '[ChatGPT 会话 HTML 导出器]';
  const BUTTON_ID = 'chatgpt-html-export-button';
  const STATUS_ID = 'chatgpt-html-export-status';

  const CONFIG = {
    numTurns: 10,
    requestTimeout: 30000,
    maxContentLength: 20_000_000,
    mermaidTheme: 'default'
  };

  const state = {
    running: false,
    observer: null,
    lastConversationId: null
  };

  const diagnostics = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    conversationId: null,
    errors: [],
    warnings: [],
    authentication: {
      success: false
    },
    api: {},
    rendering: {},
    result: null
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function log() {
    const method = diagnostics.result?.success ? 'log' : 'error';

    console[method](
      `${PREFIX} ${diagnostics.result?.success ? 'SUCCESS' : 'FAILED'}`,
      JSON.stringify(diagnostics, null, 2)
    );
  }

  function addError(message, detail) {
    diagnostics.errors.push({
      message,
      detail: detail == null ? null : String(detail)
    });
  }

  function addWarning(message) {
    diagnostics.warnings.push(message);
  }

  function getConversationId() {
    const match = location.pathname.match(/^\/c\/([0-9a-f-]+)/i);
    return match?.[1] || null;
  }

  function setStatus(message, type = 'info') {
    const element = document.getElementById(STATUS_ID);

    if (!element) return;

    element.textContent = message;
    element.dataset.type = type;
    element.style.display = 'block';

    if (type === 'success') {
      setTimeout(() => {
        if (element.isConnected) {
          element.style.display = 'none';
        }
      }, 5000);
    }
  }

  function createUI() {
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '导出 HTML';
    button.addEventListener('click', handleExport);

    const status = document.createElement('div');
    status.id = STATUS_ID;
    status.style.display = 'none';

    document.body.append(button, status);
  }

  function installStyles() {
    if (document.getElementById('chatgpt-html-export-style')) return;

    const style = document.createElement('style');
    style.id = 'chatgpt-html-export-style';
    style.textContent = `
      #${BUTTON_ID} {
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 999999;
        border: 1px solid rgba(128,128,128,.35);
        border-radius: 9px;
        padding: 10px 16px;
        color: #fff;
        background: #2563eb;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 3px 12px rgba(0,0,0,.18);
      }

      #${BUTTON_ID}:hover {
        background: #1d4ed8;
      }

      #${BUTTON_ID}:disabled {
        opacity: .65;
        cursor: wait;
      }

      #${STATUS_ID} {
        position: fixed;
        right: 24px;
        bottom: 76px;
        z-index: 999999;
        max-width: 360px;
        padding: 10px 14px;
        border-radius: 8px;
        color: #fff;
        background: #334155;
        font-size: 13px;
        line-height: 1.5;
        box-shadow: 0 3px 12px rgba(0,0,0,.18);
      }

      #${STATUS_ID}[data-type="error"] {
        background: #b91c1c;
      }

      #${STATUS_ID}[data-type="success"] {
        background: #15803d;
      }
    `;

    document.head.appendChild(style);
  }

  function installObserver() {
    if (state.observer || !document.body) return;

    state.observer = new MutationObserver(() => {
      if (!document.getElementById(BUTTON_ID)) {
        createUI();
      }

      if (!document.getElementById('chatgpt-html-export-style')) {
        installStyles();
      }
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.requestTimeout
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        credentials: 'include',
        cache: 'no-store'
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`
        );
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getAuthentication() {
    const response = await fetchWithTimeout('/api/auth/session', {
      headers: {
        Accept: 'application/json'
      }
    });

    const session = await response.json();

    if (!session?.accessToken || !session?.account?.id) {
      throw new Error('登录会话中缺少 accessToken 或 account.id。');
    }

    diagnostics.authentication = {
      success: true
    };

    return {
      accessToken: session.accessToken,
      accountId: session.account.id
    };
  }

  async function fetchConversationEndpoint(url, auth) {
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-Id': auth.accountId
      }
    });

    const data = await response.json();

    if (!data || !Array.isArray(data.messages)) {
      throw new Error('接口响应中不存在有效的 messages 数组。');
    }

    return data;
  }

  async function fetchConversationMessages(conversationId) {
    const auth = await getAuthentication();

    const baseUrl =
      `/backend-api/conversations/${encodeURIComponent(conversationId)}`;

    const newerResponse = await fetchConversationEndpoint(
      `${baseUrl}?num_turns=${CONFIG.numTurns}&include_has_versions=true`,
      auth
    );

    const startCursor = newerResponse.page_info?.start_cursor;

    if (!startCursor) {
      throw new Error('第一阶段响应缺少 page_info.start_cursor，无法执行第二阶段请求。');
    }

    const olderUrl =
      `${baseUrl}/messages?before=${encodeURIComponent(startCursor)}` +
      `&num_turns=${CONFIG.numTurns}&include_has_versions=true`;

    const olderResponse = await fetchConversationEndpoint(
      olderUrl,
      auth
    );

    const merged = mergeMessages(
      olderResponse.messages,
      newerResponse.messages
    );

    const olderPageInfo = olderResponse.page_info || {};
    const newerPageInfo = newerResponse.page_info || {};

    diagnostics.api = {
      newerMessageCount: newerResponse.messages.length,
      olderMessageCount: olderResponse.messages.length,
      mergedMessageCount: merged.messages.length,
      duplicateCount: merged.duplicateCount,
      responseOrder: [
        '较大的 response：较旧消息',
        '较小的 response：较新消息'
      ],
      responseSizes: {
        olderMessageCount: olderResponse.messages.length,
        newerMessageCount: newerResponse.messages.length
      },
      pagination: {
        newerPage: {
          start_cursor: newerPageInfo.start_cursor || null,
          end_cursor: newerPageInfo.end_cursor || null,
          has_previous_page: newerPageInfo.has_previous_page ?? null,
          has_next_page: newerPageInfo.has_next_page ?? null
        },
        olderPage: {
          start_cursor: olderPageInfo.start_cursor || null,
          end_cursor: olderPageInfo.end_cursor || null,
          has_previous_page: olderPageInfo.has_previous_page ?? null,
          has_next_page: olderPageInfo.has_next_page ?? null
        }
      }
    };

    if (olderPageInfo.has_next_page === true) {
      addWarning(
        '第二阶段响应的 has_next_page=true，可能仍存在更旧消息。本脚本遵守两阶段请求约束，不继续请求其他分页。'
      );
    }

    if (newerPageInfo.has_next_page === true) {
      addWarning(
        '第一阶段响应的 has_next_page=true，可能仍存在更新方向的分页数据。'
      );
    }

    return merged.messages;
  }

  function mergeMessages(olderMessages, newerMessages) {
    if (!Array.isArray(olderMessages) || !Array.isArray(newerMessages)) {
      throw new Error('合并消息时收到无效数组。');
    }

    const result = [];
    const seen = new Set();
    let duplicateCount = 0;

    for (const message of [...olderMessages, ...newerMessages]) {
      if (!message || typeof message !== 'object') continue;

      const id = message.id;

      if (!id) {
        addWarning('发现缺少 message.id 的消息，无法执行 ID 去重。');
        result.push(message);
        continue;
      }

      if (seen.has(id)) {
        duplicateCount++;
        continue;
      }

      seen.add(id);
      result.push(message);
    }

    return {
      messages: result,
      duplicateCount
    };
  }

  function getContentType(message) {
    return message?.content?.content_type || 'unknown';
  }

  function getMessageChannel(message) {
    return message?.channel ||
      message?.metadata?.channel ||
      null;
  }

  function isAssistantFinal(message) {
    return message?.author?.role === 'assistant' &&
      getMessageChannel(message) === 'final' &&
      !['reasoning_recap', 'thoughts'].includes(getContentType(message));
  }

  function selectMessages(messages) {
    const counts = {
      user: 0,
      system: 0,
      assistant: 0,
      text: 0,
      reasoning_recap: 0,
      thoughts: 0,
      final: 0,
      ignoredOther: 0
    };

    const selected = [];

    for (const message of messages) {
      const role = message?.author?.role;
      const contentType = getContentType(message);
      const channel = getMessageChannel(message);

      if (counts[role] !== undefined) {
        counts[role]++;
      }

      if (counts[contentType] !== undefined) {
        counts[contentType]++;
      }

      if (channel === 'final') {
        counts.final++;
      }

      if (contentType === 'reasoning_recap' ||
          contentType === 'thoughts') {
        continue;
      }

      if (role === 'user') {
        selected.push({
          message,
          role: 'user'
        });
        continue;
      }

      if (isAssistantFinal(message)) {
        selected.push({
          message,
          role: 'assistant'
        });
        continue;
      }

      counts.ignoredOther++;
    }

    diagnostics.api.roleCounts = {
      user: counts.user,
      system: counts.system,
      assistant: counts.assistant
    };

    diagnostics.api.contentTypeCounts = {
      text: counts.text,
      reasoning_recap: counts.reasoning_recap,
      thoughts: counts.thoughts
    };

    diagnostics.api.channelCounts = {
      final: counts.final
    };

    diagnostics.api.selectedUserCount =
      selected.filter(item => item.role === 'user').length;

    diagnostics.api.selectedAssistantFinalCount =
      selected.filter(item => item.role === 'assistant').length;

    diagnostics.api.ignoredReasoningRecapCount =
      counts.reasoning_recap;

    diagnostics.api.ignoredThoughtsCount =
      counts.thoughts;

    diagnostics.api.ignoredOtherCount =
      counts.ignoredOther;

    return selected;
  }

  function getParts(message) {
    const content = message?.content;

    if (!content) return [];

    if (Array.isArray(content.parts)) {
      return content.parts;
    }

    if (typeof content.text === 'string') {
      return [content.text];
    }

    if (typeof content.content === 'string') {
      return [content.content];
    }

    return [];
  }

  function getTextFromPart(part) {
    if (typeof part === 'string') return part;

    if (!part || typeof part !== 'object') return '';

    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (typeof part.caption === 'string') return part.caption;

    if (part.content_type === 'text' &&
        Array.isArray(part.parts)) {
      return part.parts.map(getTextFromPart).join('\n');
    }

    return '';
  }

  function getMessageMarkdown(message) {
    const parts = getParts(message);

    const text = parts
      .map(getTextFromPart)
      .filter(Boolean)
      .join('\n\n');

    if (text.length > CONFIG.maxContentLength) {
      throw new Error(`消息 ${message.id || '(unknown)'} 的正文超过长度限制。`);
    }

    return text;
  }

  function getMessageAttachments(message) {
    const parts = getParts(message);
    const attachments = [];

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;

      const asset = part.asset_pointer ||
        part.image_url ||
        part.file_id ||
        part.file;

      if (asset) {
        attachments.push({
          type: part.content_type || part.type || 'attachment',
          name: part.name || part.filename || '',
          description: part.text || part.caption || ''
        });
      }
    }

    return attachments;
  }

  function preprocessDIL(markdown) {
    const segments = String(markdown).split(
      /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g
    );

    return segments.map((segment, index) => {
      if (index % 2 === 1) return segment;

      return segment
        .replace(/\{@body\b[\s\S]*?\}/g, '')
        .replace(/\{@module\b[\s\S]*?\}/g, '')
        .replace(/\{\/if\}/g, '')
        .replace(/\{:else if [^}]*\}/g, '')
        .replace(/\{:else\}/g, '')
        .replace(/\{#if [^}]*\}/g, '')
        .replace(/\{#each [^}]*\}/g, '')
        .replace(/\{\/each\}/g, '')
        .replace(/\{[A-Za-z_$][\w$]*(?:\.[\w$]+)*\}/g, '');
    }).join('');
  }

  function configureMarkdown() {
    if (!window.marked || !window.DOMPurify) {
      throw new Error('Markdown 或 HTML 清洗库未成功加载。');
    }

    const renderer = new marked.Renderer();

    renderer.code = function ({ text, lang }) {
      const language = String(lang || '')
        .trim()
        .split(/\s+/)[0]
        .toLowerCase();

      const escaped = escapeHTML(text);

      if (language === 'mermaid') {
        return `<pre class="mermaid">${escaped}</pre>`;
      }

      const languageClass = language
        ? ` class="language-${escapeAttribute(language)}"`
        : '';

      return `<pre class="export-code"><code${languageClass}>${escaped}</code></pre>`;
    };

    marked.setOptions({
      renderer,
      gfm: true,
      breaks: false,
      async: false
    });
  }

  function escapeHTML(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttribute(value) {
    return escapeHTML(value);
  }

  function sanitizeHTML(html) {
    return DOMPurify.sanitize(html, {
      ADD_TAGS: [
        'box',
        'col',
        'row',
        'grid',
        'grid-item',
        'flow',
        'flow-item',
        'card',
        'title',
        'text',
        'caption',
        'badge',
        'icon',
        'divider',
        'list',
        'list-item',
        'table-section',
        'table-row',
        'table-cell',
        'radio',
        'radio-group',
        'checkbox',
        'button',
        'segmented-control',
        'select',
        'input',
        'textarea',
        'math',
        'popover',
        'popover-trigger',
        'popover-content',
        'pressable',
        'spacer',
        'underline',
        'bold',
        'italic',
        'strikethrough'
      ],
      ADD_ATTR: [
        'value',
        'label',
        'color',
        'size',
        'weight',
        'variant',
        'background',
        'border',
        'radius',
        'padding',
        'gap',
        'direction',
        'align',
        'justify',
        'columns',
        'rows',
        'width',
        'height',
        'aspectratio',
        'textalign',
        'strong',
        'italic',
        'inline',
        'disabled',
        'checked',
        'name',
        'type',
        'id',
        'class',
        'data-*'
      ],
      FORBID_TAGS: [
        'script',
        'iframe',
        'object',
        'embed',
        'form',
        'style'
      ],
      FORBID_ATTR: [
        'onerror',
        'onload',
        'onclick',
        'onmouseover',
        'onfocus',
        'oninput'
      ],
      ALLOW_DATA_ATTR: true
    });
  }

  function renderMarkdown(markdown) {
    const source = preprocessDIL(markdown);
    const rendered = marked.parse(source);
    return sanitizeHTML(rendered);
  }

  function convertDILComponents(root) {
    const componentNames = [
      'box',
      'col',
      'row',
      'grid',
      'grid-item',
      'flow',
      'flow-item',
      'card',
      'title',
      'text',
      'caption',
      'badge',
      'icon',
      'divider',
      'list',
      'list-item',
      'table-section',
      'table-row',
      'table-cell',
      'radio',
      'radio-group',
      'checkbox',
      'button',
      'segmented-control',
      'select',
      'input',
      'textarea',
      'math',
      'popover',
      'popover-trigger',
      'popover-content',
      'pressable',
      'spacer',
      'underline',
      'bold',
      'italic',
      'strikethrough'
    ];

    const nodes = [...root.querySelectorAll(componentNames.join(','))];

    for (const node of nodes) {
      if (!node.isConnected) continue;

      const name = node.localName;
      const replacement = document.createElement(
        name === 'divider' ? 'hr' : 'div'
      );

      replacement.className = `dil-${name}`;

      for (const attribute of [...node.attributes]) {
        if (attribute.name.startsWith('on')) continue;
        if (attribute.name === 'style') continue;

        replacement.dataset[attribute.name.replace(/-([a-z])/g,
          (_, letter) => letter.toUpperCase())] = attribute.value;
      }

      while (node.firstChild) {
        replacement.appendChild(node.firstChild);
      }

      if (name === 'icon') {
        replacement.textContent = getIconText(node.getAttribute('name'));
      }

      if (name === 'badge') {
        replacement.classList.add('dil-badge');
      }

      if (name === 'title') {
        replacement.classList.add('dil-title');
      }

      if (name === 'text') {
        replacement.classList.add('dil-text');
      }

      if (name === 'list-item') {
        replacement.classList.add('dil-list-item');
      }

      if (name === 'radio') {
        replacement.classList.add('dil-radio');
        const value = node.getAttribute('value');
        const label = document.createElement('span');
        label.className = 'dil-radio-value';

        if (value) {
          label.textContent = `选项 ${value}`;
          replacement.prepend(label);
        }
      }

      if (name === 'checkbox') {
        replacement.classList.add('dil-checkbox');
        const label = node.getAttribute('label');
        if (label) replacement.prepend(document.createTextNode(`${label} `));
      }

      if (name === 'button') {
        replacement.classList.add('dil-static-button');
      }

      if (name === 'divider') {
        replacement.className = 'dil-divider';
      }

      node.replaceWith(replacement);
    }

    applyDILLayoutAttributes(root);
  }

  function getIconText(name) {
    const icons = {
      'arrow-down': '↓',
      'arrow-up': '↑',
      'arrow-down-up': '↕',
      'arrow-right': '→',
      'arrow-left': '←',
      check: '✓',
      'check-circle': '✓',
      alert: '⚠',
      info: 'ⓘ',
      'external-link': '↗'
    };

    return icons[name] || '';
  }

  function applyDILLayoutAttributes(root) {
    const nodes = [
      root,
      ...root.querySelectorAll('[data-direction], [data-columns], [data-align], [data-gap], [data-padding], [data-background], [data-radius]')
    ];

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;

      const direction = node.dataset.direction;
      const align = node.dataset.align;
      const justify = node.dataset.justify;
      const columns = node.dataset.columns;
      const gap = node.dataset.gap;
      const padding = node.dataset.padding;
      const background = node.dataset.background;
      const radius = node.dataset.radius;

      if (direction) {
        node.style.display = 'flex';
        node.style.flexDirection = direction;
      }

      if (align) {
        node.style.alignItems = align;
      }

      if (justify) {
        node.style.justifyContent = justify;
      }

      if (columns && /^\d+$/.test(columns)) {
        node.style.display = 'grid';
        node.style.gridTemplateColumns =
          `repeat(${Math.min(Number(columns), 6)}, minmax(0, 1fr))`;
      }

      if (gap && /^\d+(\.\d+)?$/.test(gap)) {
        node.style.gap = `${Number(gap) * 4}px`;
      }

      if (padding && /^\d+(\.\d+)?$/.test(padding)) {
        node.style.padding = `${Number(padding) * 4}px`;
      }

      if (background && /^rgba?\(/i.test(background)) {
        node.style.background = background;
      }

      if (radius === 'md') node.style.borderRadius = '8px';
      if (radius === 'lg') node.style.borderRadius = '12px';
      if (radius === 'full') node.style.borderRadius = '999px';
    }
  }

  function prepareMessageContent(selectedMessages) {
    const messages = [];

    for (const item of selectedMessages) {
      const markdown = getMessageMarkdown(item.message);

      if (!markdown.trim()) {
        addWarning(
          `消息 ${item.message.id || '(unknown)'} 没有可导出的文本正文。`
        );
        continue;
      }

      messages.push({
        id: item.message.id || '',
        role: item.role,
        markdown,
        attachments: getMessageAttachments(item.message),
        createTime: item.message.create_time || null
      });
    }

    return messages;
  }

  function renderMessage(message, index) {
    const article = document.createElement('article');
    article.className = `export-message export-${message.role}`;
    article.dataset.messageIndex = String(index + 1);
    article.dataset.messageId = message.id;

    const header = document.createElement('div');
    header.className = 'export-message-header';
    header.textContent = message.role === 'user' ? '用户' : 'ChatGPT';

    const content = document.createElement('div');
    content.className = 'export-message-content';
    content.innerHTML = renderMarkdown(message.markdown);

    convertDILComponents(content);

    article.append(header, content);

    if (message.attachments.length) {
      const attachmentList = document.createElement('div');
      attachmentList.className = 'export-attachments';

      for (const attachment of message.attachments) {
        const item = document.createElement('div');
        item.className = 'export-attachment';
        item.textContent = [
          attachment.type,
          attachment.name,
          attachment.description
        ].filter(Boolean).join(' · ');

        attachmentList.appendChild(item);
      }

      article.appendChild(attachmentList);
    }

    return article;
  }

  async function renderMermaid(root) {
    const nodes = [...root.querySelectorAll('pre.mermaid')];

    diagnostics.rendering.mermaidBlockCount = nodes.length;
    diagnostics.rendering.mermaidRenderedCount = 0;
    diagnostics.rendering.mermaidErrors = [];

    if (!nodes.length) return;

    if (!window.mermaid) {
      diagnostics.rendering.mermaidErrors.push(
        'Mermaid 库未加载。'
      );
      return;
    }

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: CONFIG.mermaidTheme,
      fontFamily: 'Arial, sans-serif'
    });

    for (const [index, node] of nodes.entries()) {
      const source = node.textContent.trim();

      if (!source) continue;

      try {
        const result = await mermaid.render(
          `chatgpt-export-mermaid-${index}-${Date.now()}`,
          source
        );

        const wrapper = document.createElement('div');
        wrapper.className = 'export-mermaid';
        wrapper.innerHTML = DOMPurify.sanitize(result.svg, {
          USE_PROFILES: {
            svg: true,
            svgFilters: true
          }
        });

        node.replaceWith(wrapper);
        diagnostics.rendering.mermaidRenderedCount++;
      } catch (error) {
        diagnostics.rendering.mermaidErrors.push({
          index,
          message: error?.message || String(error)
        });

        node.classList.add('mermaid-error');
        node.dataset.mermaidError = 'true';
      }
    }
  }

  function getExportStyles() {
    return `
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
          "Noto Sans SC", "Microsoft YaHei", sans-serif;
        color: #242424;
        background: #fff;
      }

      * {
        box-sizing: border-box;
      }

      html, body {
        margin: 0;
        padding: 0;
        background: #fff;
      }

      body {
        padding: 36px 24px;
        line-height: 1.65;
        font-size: 15px;
      }

      .export-page {
        width: 100%;
        max-width: 900px;
        margin: 0 auto;
      }

      .export-title {
        margin: 0 0 12px;
        font-size: 24px;
        font-weight: 700;
      }

      .export-meta {
        margin-bottom: 28px;
        color: #777;
        font-size: 12px;
      }

      .export-message {
        margin: 0 0 34px;
        min-width: 0;
        overflow: visible;
      }

      .export-message-header {
        margin-bottom: 12px;
        color: #777;
        font-size: 12px;
        font-weight: 600;
      }

      .export-user .export-message-content {
        padding: 14px 18px;
        border: 1px solid #e5e7eb;
        border-radius: 14px;
        background: #f9fafb;
      }

      .export-assistant .export-message-content {
        padding: 0 2px;
      }

      .export-message-content {
        min-width: 0;
        overflow-wrap: anywhere;
        word-break: normal;
      }

      .export-message-content > :first-child {
        margin-top: 0;
      }

      .export-message-content > :last-child {
        margin-bottom: 0;
      }

      h1, h2, h3, h4, h5, h6 {
        margin: 1.5em 0 .65em;
        line-height: 1.3;
        font-weight: 650;
      }

      h1 { font-size: 1.8em; }
      h2 { font-size: 1.5em; }
      h3 { font-size: 1.25em; }
      h4 { font-size: 1.1em; }

      p {
        margin: .75em 0;
      }

      ul, ol {
        padding-left: 1.8em;
        margin: .75em 0;
      }

      li {
        margin: .3em 0;
      }

      blockquote {
        margin: 1em 0;
        padding: .2em 1em;
        border-left: 3px solid #cbd5e1;
        color: #64748b;
        background: #f8fafc;
      }

      hr, .dil-divider {
        border: 0;
        border-top: 1px solid #e5e7eb;
        margin: 1.5em 0;
      }

      a {
        color: #2563eb;
        text-decoration: underline;
        overflow-wrap: anywhere;
      }

      strong, b {
        font-weight: 650;
      }

      code {
        padding: .15em .35em;
        border-radius: 4px;
        background: #f1f5f9;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: .9em;
      }

      pre,
      pre.export-code {
        width: 100%;
        max-width: 100%;
        margin: 1em 0;
        padding: 14px 16px;
        overflow-x: auto;
        overflow-y: visible;
        border: 1px solid #e2e8f0;
        border-radius: 9px;
        background: #f8fafc;
        white-space: pre;
        tab-size: 4;
      }

      pre code {
        display: block;
        padding: 0;
        background: transparent;
        font-size: 13px;
        line-height: 1.6;
        white-space: pre;
      }

      table {
        width: 100%;
        max-width: 100%;
        margin: 1em 0;
        border-collapse: collapse;
        font-size: .94em;
        overflow-wrap: anywhere;
      }

      th, td {
        padding: 9px 12px;
        border: 1px solid #dbe1e8;
        text-align: left;
        vertical-align: top;
      }

      th {
        background: #f1f5f9;
        font-weight: 650;
      }

      img, video, svg {
        max-width: 100%;
        height: auto;
      }

      .export-mermaid {
        width: 100%;
        margin: 1.2em 0;
        padding: 14px;
        overflow-x: auto;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        background: #fff;
        text-align: center;
      }

      .export-mermaid svg {
        max-width: 100%;
        height: auto;
      }

      .mermaid-error {
        border: 1px solid #ef4444;
        background: #fef2f2;
      }

      .dil-box,
      .dil-card {
        display: flex;
        flex-direction: column;
        min-width: 0;
        gap: 12px;
        margin: 1em 0;
        padding: 14px;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
      }

      .dil-row {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .dil-col {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
      }

      .dil-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .dil-grid-item {
        min-width: 0;
      }

      .dil-flow {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }

      .dil-flow-item {
        min-width: 0;
      }

      .dil-title {
        margin: .5em 0;
        font-size: 1.2em;
        font-weight: 700;
      }

      .dil-text {
        line-height: 1.65;
      }

      .dil-badge {
        display: inline-block;
        width: fit-content;
        padding: 2px 9px;
        border-radius: 999px;
        background: #e2e8f0;
        color: #334155;
        font-size: 12px;
        font-weight: 600;
      }

      .dil-list-item {
        margin: 5px 0;
      }

      .dil-static-button {
        display: inline-block;
        width: fit-content;
        padding: 7px 13px;
        border: 1px solid #cbd5e1;
        border-radius: 7px;
        background: #f8fafc;
      }

      .dil-radio,
      .dil-checkbox {
        display: block;
        margin: 8px 0;
        padding: 10px 12px;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
      }

      .dil-radio-value {
        display: block;
        margin-bottom: 5px;
        color: #64748b;
        font-size: 12px;
      }

      .dil-icon {
        display: inline-block;
        margin: 0 4px;
      }

      .dil-popover-content {
        padding: 10px;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
      }

      .dil-spacer {
        min-height: 8px;
      }

      .export-attachments {
        margin-top: 12px;
        padding: 10px;
        border-radius: 8px;
        background: #f1f5f9;
        color: #475569;
        font-size: 12px;
      }

      .export-attachment {
        padding: 3px 0;
      }

      .export-footer {
        margin-top: 50px;
        padding-top: 15px;
        border-top: 1px solid #e5e7eb;
        color: #94a3b8;
        font-size: 11px;
        text-align: center;
      }

      @media (max-width: 640px) {
        body {
          padding: 18px 12px;
        }

        .dil-grid {
          grid-template-columns: 1fr;
        }

        .dil-row {
          flex-wrap: wrap;
        }

        table {
          display: block;
          overflow-x: auto;
        }
      }

      @media print {
        body {
          padding: 0;
        }

        .export-page {
          max-width: none;
        }

        pre, table, blockquote, .dil-box, .dil-card {
          break-inside: avoid;
        }

        a {
          color: inherit;
          text-decoration: none;
        }
      }

      @page {
        size: A4;
        margin: 15mm;
      }
    `;
  }

  function buildExportDocument(messages, renderedMessages) {
    const title = document.title || 'ChatGPT 会话导出';
    const timestamp = new Date().toLocaleString('zh-CN');

    const wrapper = document.createElement('main');
    wrapper.className = 'export-page';

    const heading = document.createElement('h1');
    heading.className = 'export-title';
    heading.textContent = title;

    const meta = document.createElement('div');
    meta.className = 'export-meta';
    meta.textContent =
      `导出时间：${timestamp} · 消息数量：${messages.length}`;

    wrapper.append(heading, meta);

    for (const element of renderedMessages) {
      wrapper.appendChild(element);
    }

    const footer = document.createElement('footer');
    footer.className = 'export-footer';
    footer.textContent =
      `ChatGPT 会话 HTML 导出器 v${VERSION}`;

    wrapper.appendChild(footer);

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>${getExportStyles()}</style>
</head>
<body>
${wrapper.outerHTML}
</body>
</html>`;

    return html;
  }

  function validateExport(html, expectedMessageCount) {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(html, 'text/html');

    const actualCount =
      parsed.querySelectorAll('.export-message').length;

    const codeBlockCount =
      parsed.querySelectorAll('pre.export-code').length;

    const mermaidCount =
      parsed.querySelectorAll('.export-mermaid').length;

    const parsedTextLength =
      (parsed.body.textContent || '').length;

    if (!html.startsWith('<!DOCTYPE html>')) {
      throw new Error('生成的 HTML 缺少 DOCTYPE。');
    }

    if (actualCount !== expectedMessageCount) {
      throw new Error(
        `消息数量验证失败：预期 ${expectedMessageCount}，实际 ${actualCount}。`
      );
    }

    if (parsedTextLength < 1) {
      throw new Error('导出 HTML 没有有效文本。');
    }

    return {
      messageCount: actualCount,
      codeBlockCount,
      mermaidCount,
      parsedTextLength
    };
  }

  function downloadHTML(html, conversationId) {
    const blob = new Blob(
      [html],
      { type: 'text/html;charset=utf-8' }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-');

    link.href = url;
    link.download =
      `ChatGPT-会话导出-${timestamp}.html`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 60000);

    return link.download;
  }

  async function handleExport() {
    if (state.running) return;

    const button = document.getElementById(BUTTON_ID);
    const conversationId = getConversationId();

    if (!conversationId) {
      setStatus('无法从当前页面 URL 获取会话 ID。', 'error');
      return;
    }

    if (!window.marked || !window.DOMPurify || !window.mermaid) {
      setStatus('渲染依赖尚未加载完成，请稍后重试。', 'error');
      return;
    }

    state.running = true;

    if (button) {
      button.disabled = true;
      button.textContent = '正在导出…';
    }

    Object.assign(diagnostics, {
      timestamp: new Date().toISOString(),
      conversationId,
      errors: [],
      warnings: [],
      authentication: {
        success: false
      },
      api: {},
      rendering: {},
      result: null
    });

    try {
      setStatus('正在获取会话数据…');

      configureMarkdown();

      const allMessages =
        await fetchConversationMessages(conversationId);

      const selectedMessages = selectMessages(allMessages);

      if (!selectedMessages.length) {
        throw new Error('没有找到可导出的用户消息或 assistant 最终回答。');
      }

      setStatus('正在处理消息内容…');

      const messages = prepareMessageContent(selectedMessages);

      if (!messages.length) {
        throw new Error('筛选后的消息没有可导出的正文。');
      }

      const renderedMessages = messages.map(renderMessage);

      setStatus('正在渲染 Mermaid 图表…');

      const renderRoot = document.createElement('div');

      for (const message of renderedMessages) {
        renderRoot.appendChild(message);
      }

      await renderMermaid(renderRoot);

      const finalMessages = [
        ...renderRoot.querySelectorAll('.export-message')
      ];

      const html = buildExportDocument(
        messages,
        finalMessages
      );

      const validation = validateExport(
        html,
        messages.length
      );

      const filename = downloadHTML(
        html,
        conversationId
      );

      const mermaidFailures =
        diagnostics.rendering.mermaidErrors || [];

      if (mermaidFailures.length) {
        addWarning(
          `${mermaidFailures.length} 个 Mermaid 图表渲染失败，已在 HTML 中保留原始代码。`
        );
      }

      diagnostics.rendering = {
        ...diagnostics.rendering,
        selectedMessageCount: messages.length,
        renderedMessageCount: finalMessages.length,
        codeBlockCount: validation.codeBlockCount,
        mermaidBlockCount:
          diagnostics.rendering.mermaidBlockCount || 0,
        mermaidRenderedCount:
          diagnostics.rendering.mermaidRenderedCount || 0,
        mermaidErrors: mermaidFailures
      };

      diagnostics.result = {
        success: true,
        completeness: {
          isComplete: false,
          status: 'partial',
          reason: [
            '本脚本仅执行两阶段 API 请求。',
            '接口分页标志及会话其他分支可能包含未获取的数据。',
            'DIL 交互组件以静态 HTML 方式呈现，不执行原始交互逻辑。'
          ]
        },
        filename,
        htmlLength: html.length,
        exportedMessageCount: messages.length,
        userMessageCount:
          messages.filter(item => item.role === 'user').length,
        assistantFinalCount:
          messages.filter(item => item.role === 'assistant').length,
        validation
      };

      setStatus(`导出成功：${filename}`, 'success');
      log();
    } catch (error) {
      addError(
        error?.message || '导出过程中发生未知错误。',
        error?.stack || ''
      );

      diagnostics.result = {
        success: false,
        reason: error?.message || String(error)
      };

      setStatus(
        `导出失败：${error?.message || String(error)}`,
        'error'
      );

      log();
    } finally {
      state.running = false;

      if (button) {
        button.disabled = false;
        button.textContent = '导出 HTML';
      }
    }
  }

  function initialize() {
    if (!document.body) {
      requestAnimationFrame(initialize);
      return;
    }

    installStyles();
    createUI();
    installObserver();
  }

  initialize();
})();
