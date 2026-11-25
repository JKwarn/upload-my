// ==UserScript==
// @name         ChatGPT 会话 HTML 导出器
// @namespace    https://github.com/JKwarn/upload-my
// @version      2.3.2
// @description  通过两阶段会话接口导出消息，保留 Markdown、静态 DIL 布局和 Mermaid 图表
// @match        https://chatgpt.com/c/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.3/mermaid.min.js
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '2.3.2';
  const PREFIX = '[ChatGPT 会话 HTML 导出器]';
  const IDS = {
    button: 'chatgpt-html-exporter-button',
    style: 'chatgpt-html-exporter-style',
    toast: 'chatgpt-html-exporter-toast'
  };
  const CONFIG = {
    sessionApi: '/api/auth/session',
    conversationApi: '/backend-api/conversations/',
    numTurns: 10,
    requestTimeout: 30000,
    maxMessageLength: 20000000,
    mermaidTheme: 'default'
  };

  const state = { running: false, observer: null };
  const diagnostics = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    conversationId: null,
    errors: [],
    warnings: [],
    authentication: { success: false },
    api: {},
    rendering: {},
    result: null
  };

  const COMPONENTS = new Set([
    'box', 'col', 'row', 'grid', 'grid-item', 'flow', 'flow-item',
    'card', 'title', 'text', 'caption', 'badge', 'icon', 'divider',
    'list', 'list-item', 'table', 'table-section', 'table-row', 'table-cell',
    'radio', 'radio-group', 'checkbox', 'button', 'segmented-control',
    'select', 'input', 'textarea', 'math', 'popover', 'popover-trigger',
    'popover-content', 'pressable', 'spacer', 'underline', 'bold',
    'italic', 'strikethrough'
  ]);

  function log() {
    const method = diagnostics.result?.success ? 'log' : 'error';
    console[method](
      `${PREFIX} ${diagnostics.result?.success ? 'SUCCESS' : 'FAILED'}`,
      JSON.stringify(diagnostics, null, 2)
    );
  }

  function resetDiagnostics(conversationId) {
    Object.assign(diagnostics, {
      timestamp: new Date().toISOString(),
      conversationId,
      errors: [],
      warnings: [],
      authentication: { success: false },
      api: {},
      rendering: {},
      result: null
    });
  }

  function warn(message) {
    diagnostics.warnings.push(String(message));
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;',
      '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function getConversationId() {
    return location.pathname.match(/^\/c\/([0-9a-f-]{36})(?:\/|$)/i)?.[1] || null;
  }

  function setStatus(message, type = 'info') {
    let node = document.getElementById(IDS.toast);
    if (!node) {
      node = document.createElement('div');
      node.id = IDS.toast;
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.dataset.type = type;
    node.classList.add('visible');
    clearTimeout(setStatus.timer);
    setStatus.timer = setTimeout(() => node.classList.remove('visible'), 5500);
  }

  function injectUI() {
    if (!document.body) return;
    if (!document.getElementById(IDS.style)) {
      const style = document.createElement('style');
      style.id = IDS.style;
      style.textContent = `
        #${IDS.button} {
          position:fixed;right:24px;bottom:24px;z-index:2147483646;
          display:flex;align-items:center;gap:8px;min-width:148px;height:42px;
          padding:0 17px;border:1px solid rgba(255,255,255,.15);
          border-radius:11px;background:#10a37f;color:#fff;
          font-family:inherit;font-size:14px;font-weight:600;line-height:1.2;cursor:pointer;
          box-shadow:0 4px 14px rgba(0,0,0,.18);
        }
        #${IDS.button}:hover{background:#0d8f70}
        #${IDS.button}:disabled{opacity:.65;cursor:wait}
        #${IDS.toast}{
          position:fixed;right:24px;bottom:76px;z-index:2147483647;
          max-width:min(420px,calc(100vw - 32px));padding:11px 15px;
          border-radius:9px;background:#202123;color:#fff;
          font-family:inherit;font-size:13px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.2);
          opacity:0;pointer-events:none;transform:translateY(8px);
          transition:opacity .18s ease,transform .18s ease
        }
        #${IDS.toast}.visible{opacity:1;transform:translateY(0)}
        #${IDS.toast}[data-type="success"]{border-left:4px solid #10a37f}
        #${IDS.toast}[data-type="error"]{border-left:4px solid #ef4444}
        #${IDS.toast}[data-type="info"]{border-left:4px solid #3b82f6}
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    if (!document.getElementById(IDS.button)) {
      const button = document.createElement('button');
      button.id = IDS.button;
      button.type = 'button';
      button.innerHTML = '<span aria-hidden="true">↓</span><span>导出会话 HTML</span>';
      button.addEventListener('click', handleExport);
      document.body.appendChild(button);
    }
  }

  function installObserver() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(() => {
      if (!document.getElementById(IDS.button) || !document.getElementById(IDS.style)) {
        injectUI();
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function fetchJSON(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeout);
    try {
      const response = await fetch(url, {
        ...options,
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) {
        let detail = '';
        try {
          const body = await response.json();
          detail = body?.detail?.message || body?.message || '';
        } catch {}
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function getAuthentication() {
    const session = await fetchJSON(CONFIG.sessionApi, {
      headers: { Accept: 'application/json' }
    });
    if (typeof session?.accessToken !== 'string' || !session.accessToken ||
        typeof session?.account?.id !== 'string' || !session.account.id) {
      throw new Error('当前登录会话缺少必要的认证信息。');
    }
    diagnostics.authentication.success = true;
    return { accessToken: session.accessToken, accountId: session.account.id };
  }

  async function requestConversation(url, auth) {
    const data = await fetchJSON(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-Id': auth.accountId
      }
    });
    if (!data || !Array.isArray(data.messages)) {
      throw new Error('接口响应结构异常：缺少 messages 数组。');
    }
    return data;
  }

  async function fetchMessages(conversationId) {
    const auth = await getAuthentication();
    const base = CONFIG.conversationApi + encodeURIComponent(conversationId);
    const newer = await requestConversation(
      `${base}?num_turns=${CONFIG.numTurns}&include_has_versions=true`, auth
    );
    const cursor = newer?.page_info?.start_cursor;
    if (typeof cursor !== 'string' || !cursor) {
      throw new Error('第一阶段响应缺少 page_info.start_cursor，无法执行第二阶段请求。');
    }
    const older = await requestConversation(
      `${base}/messages?before=${encodeURIComponent(cursor)}&num_turns=${CONFIG.numTurns}&include_has_versions=true`,
      auth
    );

    const merged = [];
    const seen = new Set();
    let duplicateCount = 0;
    let missingIdCount = 0;

    for (const message of [...older.messages, ...newer.messages]) {
      if (!message || typeof message !== 'object') continue;
      const id = typeof message.id === 'string' ? message.id : null;
      if (id && seen.has(id)) {
        duplicateCount++;
        continue;
      }
      if (id) seen.add(id);
      else missingIdCount++;
      merged.push(message);
    }

    const oldPage = older.page_info || {};
    const newPage = newer.page_info || {};
    const hasUnfetchedPages =
      oldPage.has_next_page === true ||
      newPage.has_next_page === true ||
      oldPage.has_previous_page === true;

    diagnostics.api = {
      newerMessageCount: newer.messages.length,
      olderMessageCount: older.messages.length,
      mergedMessageCount: merged.length,
      duplicateCount,
      missingIdCount,
      responseOrder: ['第二阶段旧消息 response', '第一阶段新消息 response'],
      pagination: {
        newerPage: {
          hasPreviousPage: newPage.has_previous_page ?? null,
          hasNextPage: newPage.has_next_page ?? null
        },
        olderPage: {
          hasPreviousPage: oldPage.has_previous_page ?? null,
          hasNextPage: oldPage.has_next_page ?? null
        }
      },
      hasUnfetchedPages
    };
    if (missingIdCount) warn(`${missingIdCount} 条消息缺少 ID，无法参与 ID 去重。`);
    if (hasUnfetchedPages) {
      warn('接口分页标志表明可能仍有未获取的消息；按两阶段约束未继续请求。');
    }
    return merged;
  }

  function roleOf(message) {
    return message?.author?.role || 'unknown';
  }

  function contentTypeOf(message) {
    return message?.content?.content_type || 'unknown';
  }

  function channelOf(message) {
    return message?.channel ?? message?.metadata?.channel ?? null;
  }

  function selectMessages(messages) {
    const selected = [];
    const counts = {
      roles: {}, contentTypes: {}, channels: {},
      user: 0, assistantFinal: 0, reasoningRecap: 0, thoughts: 0, ignored: 0
    };
    for (const message of messages) {
      const role = roleOf(message);
      const contentType = contentTypeOf(message);
      const channel = channelOf(message) || '(null)';
      counts.roles[role] = (counts.roles[role] || 0) + 1;
      counts.contentTypes[contentType] = (counts.contentTypes[contentType] || 0) + 1;
      counts.channels[channel] = (counts.channels[channel] || 0) + 1;

      if (contentType === 'reasoning_recap') {
        counts.reasoningRecap++;
        continue;
      }
      if (contentType === 'thoughts') {
        counts.thoughts++;
        continue;
      }
      if (role === 'user') {
        selected.push({ message, role });
        counts.user++;
      } else if (role === 'assistant' && channel === 'final') {
        selected.push({ message, role });
        counts.assistantFinal++;
      } else {
        counts.ignored++;
      }
    }
    diagnostics.api.roleCounts = counts.roles;
    diagnostics.api.contentTypeCounts = counts.contentTypes;
    diagnostics.api.channelCounts = counts.channels;
    diagnostics.api.selectedUserCount = counts.user;
    diagnostics.api.selectedAssistantFinalCount = counts.assistantFinal;
    diagnostics.api.ignoredReasoningRecapCount = counts.reasoningRecap;
    diagnostics.api.ignoredThoughtsCount = counts.thoughts;
    diagnostics.api.ignoredOtherCount = counts.ignored;
    return selected;
  }

  function getParts(message) {
    const content = message?.content;
    if (Array.isArray(content?.parts)) return content.parts;
    if (typeof content?.text === 'string') return [content.text];
    if (typeof content?.content === 'string') return [content.content];
    return [];
  }

  function partToText(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (typeof part.caption === 'string') return part.caption;
    if (part.content_type === 'text' && Array.isArray(part.parts)) {
      return part.parts.map(partToText).filter(Boolean).join('\n');
    }
    return '';
  }

  function getMessageMarkdown(message) {
    const parts = getParts(message);
    let text = parts.map(partToText).filter(Boolean).join('\n\n');
    if (!text.trim() && typeof message?.metadata?.model_dil_v2?.fallbackMarkdown === 'string') {
      text = message.metadata.model_dil_v2.fallbackMarkdown;
    }
    if (text.length > CONFIG.maxMessageLength) {
      throw new Error(`消息 ${message.id || '(unknown)'} 的正文超过长度限制。`);
    }
    return text;
  }

  function getTimestamp(message) {
    const value = message?.create_time;
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false });
  }

  function configureMarkdown() {
    if (!window.marked || !window.DOMPurify) {
      throw new Error('Markdown 或 HTML 清洗库加载失败。');
    }
    const renderer = new marked.Renderer();
    renderer.code = ({ text, lang }) => {
      const language = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
      const escaped = escapeHTML(text);
      if (language === 'mermaid') return `<pre class="mermaid">${escaped}</pre>`;
      const langClass = language ? ` class="language-${escapeHTML(language)}"` : '';
      return `<pre class="export-code"><code${langClass}>${escaped}</code></pre>`;
    };
    marked.setOptions({ renderer, gfm: true, breaks: false, async: false });
  }

  function sanitizeHTML(html) {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_TAGS: [...COMPONENTS],
      ADD_ATTR: [
        'value', 'label', 'color', 'size', 'weight', 'variant',
        'background', 'border', 'radius', 'padding', 'gap',
        'direction', 'align', 'justify', 'columns', 'rows',
        'width', 'height', 'aspectratio', 'textalign', 'strong',
        'italic', 'inline', 'disabled', 'checked', 'name', 'type',
        'marker', 'span', 'rowspan', 'colspan', 'header',
        'href', 'target', 'rel', 'start', 'class', 'id'
      ],
      ALLOW_DATA_ATTR: true,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'style', 'input'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'oninput']
    });
  }

  function attrValue(node, name) {
    return node.getAttribute(name)?.replace(/^\{(.*)\}$/s, '$1') ?? null;
  }

  function spacing(value, fallback = '0px') {
    if (value == null || value === '') return fallback;
    const raw = String(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(raw)) return `${Number(raw) * 4}px`;
    if (/^\d+(?:\.\d+)?(?:px|rem|pt|%)$/.test(raw) || raw === '0') return raw;
    return fallback;
  }

  function applyComponentStyle(element, name, attrs) {
    const get = key => attrs[key] ?? null;
    const numericGap = spacing(get('gap'), null);
    const padding = spacing(get('padding'), null);
    if (numericGap) element.style.gap = numericGap;
    if (padding) element.style.padding = padding;

    const direction = get('direction');
    const align = get('align');
    const justify = get('justify');
    const columns = get('columns');

    if (['box', 'card', 'col', 'row', 'flow', 'grid'].includes(name)) {
      element.style.minWidth = '0';
      if (name === 'row') {
        element.style.display = 'flex';
        element.style.flexDirection = 'row';
        element.style.alignItems = align || 'center';
      } else if (name === 'col' || name === 'card' || name === 'box') {
        element.style.display = 'flex';
        element.style.flexDirection = direction || 'column';
        if (align) element.style.alignItems = align;
      } else if (name === 'flow') {
        element.style.display = 'flex';
        element.style.flexWrap = 'wrap';
        if (align) element.style.alignItems = align;
      } else if (name === 'grid') {
        const count = Math.max(1, Math.min(12, Number(columns) || 2));
        element.style.display = 'grid';
        element.style.gridTemplateColumns = `repeat(${count},minmax(0,1fr))`;
      }
      if (justify) element.style.justifyContent = justify;
      if (name === 'card' || get('border') !== null) {
        const border = get('border');
        if (border !== 'false' && border !== 'none') {
          element.style.border = border && border !== 'true'
            ? border : '1px solid #e5e7eb';
        }
      }
      if (get('background')) element.style.background = get('background');
      const radius = get('radius');
      if (radius) {
        element.style.borderRadius = ({ sm: '4px', md: '8px', lg: '12px', xl: '16px', full: '999px' })[radius] || radius;
      }
      if (name === 'card') element.style.margin = '1em 0';
    }
    if (name === 'grid-item' || name === 'flow-item') element.style.minWidth = '0';
    if (name === 'title') {
      const sizes = { xs: '12px', sm: '14px', md: '18px', lg: '22px', xl: '28px' };
      element.style.fontSize = sizes[get('size')] || '18px';
      element.style.fontWeight = get('weight') || '650';
      element.style.lineHeight = '1.35';
      element.style.margin = '.5em 0';
    }
    if (name === 'text' || name === 'caption') {
      if (get('color')) element.style.color = get('color');
      if (get('size')) element.style.fontSize = get('size');
      if (get('weight')) element.style.fontWeight = get('weight');
      if (get('textalign')) element.style.textAlign = get('textalign');
      if (get('italic') === 'true') element.style.fontStyle = 'italic';
      if (name === 'caption') {
        element.style.fontSize = get('size') || '12px';
        element.style.color = get('color') || '#6b7280';
      }
    }
    if (name === 'badge') {
      element.style.display = 'inline-block';
      element.style.width = 'fit-content';
      element.style.padding = '2px 9px';
      element.style.borderRadius = '999px';
      element.style.background = get('background') || '#e5e7eb';
      element.style.color = get('color') || '#374151';
      element.style.fontSize = get('size') || '12px';
      element.style.fontWeight = '600';
    }
    if (name === 'divider') {
      element.style.border = '0';
      element.style.borderTop = '1px solid #e5e7eb';
      element.style.margin = '1.5em 0';
    }
    if (name === 'spacer') element.style.minHeight = spacing(get('size'), '8px');
    if (name === 'list') {
      element.style.display = 'block';
      element.style.paddingLeft = '1.5em';
      element.style.margin = '.75em 0';
    }
    if (name === 'list-item') element.style.margin = '.35em 0';
    if (name === 'button' || name === 'pressable') {
      element.style.display = 'inline-block';
      element.style.padding = '7px 13px';
      element.style.border = '1px solid #cbd5e1';
      element.style.borderRadius = '7px';
      element.style.background = '#f8fafc';
    }
    if (name === 'radio' || name === 'checkbox') {
      element.style.display = 'block';
      element.style.margin = '8px 0';
      element.style.padding = '10px 12px';
      element.style.border = '1px solid #e2e8f0';
      element.style.borderRadius = '8px';
    }
    if (name === 'popover-content') {
      element.style.padding = '10px';
      element.style.border = '1px solid #e2e8f0';
      element.style.borderRadius = '8px';
    }
    if (get('width')) element.style.width = get('width');
    if (get('height')) element.style.minHeight = get('height');
  }

  function iconGlyph(name) {
    const map = {
      'arrow-down': '↓', 'arrow-up': '↑', 'arrow-right': '→',
      'arrow-left': '←', 'arrow-down-up': '↕', check: '✓',
      'check-circle': '✓', alert: '⚠', info: 'ⓘ',
      'external-link': '↗', 'chevron-down': '⌄'
    };
    return map[name] || '';
  }

  function convertDIL(root) {
    const nodes = [...root.querySelectorAll([...COMPONENTS].join(','))].reverse();
    let converted = 0;
    for (const node of nodes) {
      if (!node.parentNode) continue;
      const name = node.localName;
      const attrs = Object.fromEntries([...node.attributes].map(attr => [
        attr.name.toLowerCase(),
        attr.value.replace(/^\{(.*)\}$/s, '$1')
      ]));
      const tag = name === 'divider' ? 'hr' : name === 'list' ? (attrs.marker === 'number' ? 'ol' : 'ul') : name === 'list-item' ? 'li' : name === 'table' ? 'table' :
        name === 'table-section' ? 'tbody' : name === 'table-row' ? 'tr' :
        name === 'table-cell' ? (attrs.header === 'true' ? 'th' : 'td') :
        name === 'bold' ? 'strong' : name === 'italic' ? 'em' :
        name === 'underline' ? 'u' : name === 'strikethrough' ? 's' :
        name === 'radio' || name === 'checkbox' ? 'div' :
        name === 'button' || name === 'pressable' ? 'span' : 'div';
      const replacement = document.createElement(tag);
      replacement.className = `dil-${name}`;
      for (const [key, value] of Object.entries(attrs)) {
        if (['class', 'style', 'id'].includes(key)) continue;
        if (key.startsWith('on')) continue;
        replacement.dataset[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      }
      while (node.firstChild) replacement.appendChild(node.firstChild);
      if (name === 'math' && attrs.value) replacement.textContent = attrs.value;
      if (name === 'icon') {
        replacement.textContent = iconGlyph(attrValue(node, 'name'));
        replacement.setAttribute('aria-hidden', 'true');
      }
      if (name === 'badge' && attrs.variant) replacement.dataset.variant = attrs.variant;
      if (name === 'radio' && attrs.value) {
        const value = document.createElement('span');
        value.className = 'dil-radio-value';
        value.textContent = attrs.value;
        replacement.prepend(value);
      }
      if (name === 'checkbox' && attrs.label) {
        replacement.prepend(document.createTextNode(`${attrs.checked === 'true' ? '☑' : '☐'} ${attrs.label} `));
      }
      applyComponentStyle(replacement, name, attrs);
      node.replaceWith(replacement);
      converted++;
    }
    return converted;
  }

  function renderMarkdown(markdown) {
    const html = marked.parse(String(markdown || ''));
    return sanitizeHTML(html);
  }

  async function renderMermaid(root) {
    const nodes = [...root.querySelectorAll('pre.mermaid')];
    diagnostics.rendering.mermaidBlockCount = nodes.length;
    diagnostics.rendering.mermaidRenderedCount = 0;
    diagnostics.rendering.mermaidErrors = [];
    if (!nodes.length) return;
    if (!window.mermaid) {
      diagnostics.rendering.mermaidErrors.push('Mermaid 库未加载。');
      warn('Mermaid 库未加载，图表保留为原始代码。');
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
        const result = await mermaid.render(`chatgpt-export-${index}-${Date.now()}`, source);
        const wrapper = document.createElement('div');
        wrapper.className = 'export-mermaid';
        wrapper.innerHTML = DOMPurify.sanitize(result.svg, {
          USE_PROFILES: { svg: true, svgFilters: true }
        });
        node.replaceWith(wrapper);
        diagnostics.rendering.mermaidRenderedCount++;
      } catch (error) {
        diagnostics.rendering.mermaidErrors.push({
          index, message: error?.message || String(error)
        });
        node.classList.add('mermaid-error');
      }
    }
  }


  function parseStaticDIL(message) {
    const model = message?.metadata?.model_dil_v2;
    const source = model?.code;
    const constants = model?.constants;
    if (typeof source !== 'string' || !constants || typeof constants !== 'object') return null;
    const marker = 'return __dil.jsx(';
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return null;
    if (/DIL\\.use(?:State|Effect|Callback|Ref|Memo)|on(?:Click|Change|Submit)/.test(source)) {
      diagnostics.rendering.unsupportedDILExpressionCount++;
    }
    let cursor = markerIndex + 'return '.length;

    function skipSpace() {
      while (/\s/.test(source[cursor] || '')) cursor++;
    }

    function parseString() {
      const quote = source[cursor];
      const start = cursor++;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) {
          cursor++;
          return JSON.parse(source.slice(start, cursor));
        }
        cursor++;
      }
      throw new Error('DIL 字符串常量未闭合。');
    }

    function parseObject() {
      const result = {};
      cursor++;
      skipSpace();
      while (cursor < source.length && source[cursor] !== '}') {
        const key = source[cursor] === '"' || source[cursor] === "'" ? parseString() : null;
        if (key === null) throw new Error('DIL 属性对象包含不支持的键。');
        skipSpace();
        if (source[cursor++] !== ':') throw new Error('DIL 属性对象缺少冒号。');
        skipSpace();
        result[key] = parseValue();
        skipSpace();
        if (source[cursor] === ',') {
          cursor++;
          skipSpace();
        } else if (source[cursor] !== '}') {
          throw new Error('DIL 属性对象格式异常。');
        }
      }
      if (source[cursor++] !== '}') throw new Error('DIL 属性对象未闭合。');
      return result;
    }

    function parseArray() {
      const result = [];
      cursor++;
      skipSpace();
      while (cursor < source.length && source[cursor] !== ']') {
        result.push(parseValue());
        skipSpace();
        if (source[cursor] === ',') {
          cursor++;
          skipSpace();
        } else if (source[cursor] !== ']') {
          throw new Error('DIL 数组格式异常。');
        }
      }
      if (source[cursor++] !== ']') throw new Error('DIL 数组未闭合。');
      return result;
    }

    function skipUnknownExpression() {
      let round = 0, square = 0, curly = 0, quote = null;
      while (cursor < source.length) {
        const ch = source[cursor];
        if (quote) {
          if (ch === '\\') cursor += 2;
          else {
            if (ch === quote) quote = null;
            cursor++;
          }
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          cursor++;
          continue;
        }
        if (ch === '(') round++;
        else if (ch === ')') {
          if (round === 0 && square === 0 && curly === 0) break;
          round--;
        } else if (ch === '[') square++;
        else if (ch === ']') square--;
        else if (ch === '{') curly++;
        else if (ch === '}') {
          if (round === 0 && square === 0 && curly === 0) break;
          curly--;
        } else if (ch === ',' && round === 0 && square === 0 && curly === 0) break;
        cursor++;
      }
    }

    function parseValue() {
      skipSpace();
      if (source.startsWith('__dil.jsx(', cursor)) {
        cursor += '__dil.jsx('.length;
        const args = [];
        skipSpace();
        while (cursor < source.length && source[cursor] !== ')') {
          args.push(parseValue());
          skipSpace();
          if (source[cursor] === ',') {
            cursor++;
            skipSpace();
          } else if (source[cursor] !== ')') {
            throw new Error('DIL JSX 参数格式异常。');
          }
        }
        if (source[cursor++] !== ')') throw new Error('DIL JSX 调用未闭合。');
        return {
          type: args[0],
          props: args[1] && typeof args[1] === 'object' && !Array.isArray(args[1]) ? args[1] : {},
          children: args.slice(2)
        };
      }
      if (source.startsWith('__dil.Fragment', cursor)) {
        cursor += '__dil.Fragment'.length;
        return 'Fragment';
      }
      if (source.startsWith('__dilConstants[', cursor)) {
        cursor += '__dilConstants['.length;
        skipSpace();
        const key = parseString();
        skipSpace();
        if (source[cursor++] !== ']') throw new Error('DIL 常量引用格式异常。');
        return Object.prototype.hasOwnProperty.call(constants, key) ? constants[key] : '';
      }
      if (source[cursor] === '"' || source[cursor] === "'") return parseString();
      if (source[cursor] === '{') return parseObject();
      if (source[cursor] === '[') return parseArray();
      for (const [literal, value] of [['null', null], ['true', true], ['false', false], ['undefined', null]]) {
        if (source.startsWith(literal, cursor)) {
          cursor += literal.length;
          return value;
        }
      }
      const number = source.slice(cursor).match(/^-?\d+(?:\.\d+)?/);
      if (number) {
        cursor += number[0].length;
        return Number(number[0]);
      }
      skipUnknownExpression();
      return null;
    }

    try {
      const tree = parseValue();
      return tree && typeof tree === 'object' ? tree : null;
    } catch (error) {
      diagnostics.rendering.modelDILErrors.push(error?.message || String(error));
      return null;
    }
  }

  function renderStaticDILNode(node) {
    if (node == null || typeof node === 'boolean') return document.createDocumentFragment();
    if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node));
    if (Array.isArray(node)) {
      const fragment = document.createDocumentFragment();
      for (const child of node) fragment.appendChild(renderStaticDILNode(child));
      return fragment;
    }
    if (node.type === 'Fragment') {
      const fragment = document.createDocumentFragment();
      for (const child of node.children || []) fragment.appendChild(renderStaticDILNode(child));
      return fragment;
    }
    const name = String(node.type || 'text');
    const element = document.createElement(COMPONENTS.has(name) ? name : 'span');
    for (const [rawKey, value] of Object.entries(node.props || {})) {
      if (value == null || rawKey === 'key' || rawKey === 'ref' || /^on[A-Z]/.test(rawKey) || rawKey === 'style') continue;
      const key = rawKey === 'className' ? 'class' : rawKey.replace(/[A-Z]/g, char => '-' + char.toLowerCase());
      if (typeof value === 'boolean') {
        if (['disabled', 'checked', 'strong', 'italic', 'inline', 'header'].includes(key)) {
          element.setAttribute(key, String(value));
        }
      } else if (typeof value === 'string' || typeof value === 'number') {
        element.setAttribute(key, String(value));
      }
    }
    for (const child of node.children || []) element.appendChild(renderStaticDILNode(child));
    return element;
  }

  function renderMessage(item, index) {
    const markdown = getMessageMarkdown(item.message);
    const article = document.createElement('article');
    article.className = `export-message export-${item.role}`;
    article.dataset.messageIndex = String(index + 1);
    if (item.message.id) article.dataset.messageId = item.message.id;

    const header = document.createElement('header');
    header.className = 'export-message-header';
    const role = document.createElement('span');
    role.textContent = item.role === 'user' ? '用户' : 'ChatGPT';
    const time = document.createElement('time');
    time.textContent = getTimestamp(item.message);
    header.append(role);
    if (time.textContent) header.append(time);

    const content = document.createElement('div');
    content.className = 'export-message-content';
    const modelTree = parseStaticDIL(item.message);
    if (modelTree) {
      content.appendChild(renderStaticDILNode(modelTree));
      diagnostics.rendering.modelDILRenderedCount++;
    } else {
      content.innerHTML = renderMarkdown(markdown);
    }
    const componentCount = convertDIL(content);
    diagnostics.rendering.dilComponentCount += componentCount;

    if (/\{@body\b|\{@module\b|\{#(?:if|each)\b|\{:\s*else/.test(markdown)) {
      diagnostics.rendering.unsupportedDILExpressionCount++;
    }

    article.append(header, content);
    return article;
  }

  function exportStyles() {
    return `
      :root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;color:#242424;background:#fff}
      *{box-sizing:border-box}
      html,body{margin:0;padding:0;background:#fff}
      body{padding:36px 24px;line-height:1.65;font-size:15px}
      .export-page{width:100%;max-width:900px;margin:0 auto}
      .export-title{margin:0 0 10px;font-size:24px;font-weight:700}
      .export-meta{margin-bottom:28px;color:#777;font-size:12px}
      .export-message{margin:0 0 34px;min-width:0;overflow:visible}
      .export-message-header{display:flex;justify-content:space-between;gap:12px;margin-bottom:12px;color:#777;font-size:12px;font-weight:600}
      .export-user .export-message-content{padding:14px 18px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb}
      .export-assistant .export-message-content{padding:0 2px}
      .export-message-content{min-width:0;overflow-wrap:anywhere;word-break:normal}
      .export-message-content>:first-child{margin-top:0}
      .export-message-content>:last-child{margin-bottom:0}
      h1,h2,h3,h4,h5,h6{margin:1.5em 0 .65em;line-height:1.3;font-weight:650}
      h1{font-size:1.8em}h2{font-size:1.5em}h3{font-size:1.25em}h4{font-size:1.1em}
      p{margin:.75em 0}ul,ol{padding-left:1.8em;margin:.75em 0}li{margin:.3em 0}
      blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid #cbd5e1;color:#64748b;background:#f8fafc}
      hr{border:0;border-top:1px solid #e5e7eb;margin:1.5em 0}
      a{color:#2563eb;text-decoration:underline;overflow-wrap:anywhere}
      strong,b{font-weight:650}
      code{padding:.15em .35em;border-radius:4px;background:#f1f5f9;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.9em}
      pre{width:100%;max-width:100%;margin:1em 0;padding:14px 16px;overflow-x:auto;overflow-y:visible;border:1px solid #e2e8f0;border-radius:9px;background:#f8fafc;white-space:pre;tab-size:4;max-height:none!important;height:auto!important}
      pre code{display:block;padding:0;background:transparent;font-size:13px;line-height:1.6;white-space:pre;max-height:none!important}
      table{width:100%;max-width:100%;margin:1em 0;border-collapse:collapse;font-size:.94em;overflow-wrap:anywhere}
      th,td{padding:9px 12px;border:1px solid #dbe1e8;text-align:left;vertical-align:top}th{background:#f1f5f9;font-weight:650}
      img,video,svg{max-width:100%;height:auto}
      .export-mermaid{width:100%;margin:1.2em 0;padding:14px;overflow-x:auto;border:1px solid #e5e7eb;border-radius:10px;background:#fff;text-align:center}
      .export-mermaid svg{max-width:100%;height:auto}
      .mermaid-error{border:1px solid #ef4444;background:#fef2f2}
      .dil-box,.dil-card{margin:1em 0;min-width:0}
      .dil-row{display:flex;flex-direction:row;align-items:center;gap:12px;min-width:0}
      .dil-col{display:flex;flex-direction:column;gap:10px;min-width:0}
      .dil-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;min-width:0}
      .dil-grid-item,.dil-flow-item{min-width:0}
      .dil-flow{display:flex;flex-wrap:wrap;gap:12px}
      .dil-title{font-size:1.2em;font-weight:700}
      .dil-text{line-height:1.65}
      .dil-badge{display:inline-block;width:fit-content;padding:2px 9px;border-radius:999px;background:#e2e8f0;color:#334155;font-size:12px;font-weight:600}
      .dil-list-item{margin:5px 0}
      .dil-radio-value{display:block;margin-bottom:5px;color:#64748b;font-size:12px}
      .dil-icon{display:inline-block;margin:0 4px}
      .dil-spacer{min-height:8px}
      .dil-static-button{display:inline-block;padding:7px 13px;border:1px solid #cbd5e1;border-radius:7px;background:#f8fafc}
      .export-footer{margin-top:50px;padding-top:15px;border-top:1px solid #e5e7eb;color:#94a3b8;font-size:11px;text-align:center}
      @media(max-width:640px){body{padding:18px 12px}.dil-grid{grid-template-columns:1fr}.dil-row{flex-wrap:wrap}table{display:block;overflow-x:auto}}
      @media print{body{padding:0}.export-page{max-width:none}pre,table,blockquote,.dil-box,.dil-card{break-inside:avoid}a{color:inherit;text-decoration:none}}
      @page{size:A4;margin:15mm}
    `;
  }

  function buildDocument(messages, conversationId) {
    const title = document.title || 'ChatGPT 会话导出';
    const timestamp = new Date().toLocaleString('zh-CN');
    const page = document.createElement('main');
    page.className = 'export-page';

    const heading = document.createElement('h1');
    heading.className = 'export-title';
    heading.textContent = title;
    const meta = document.createElement('div');
    meta.className = 'export-meta';
    meta.textContent = `会话 ID：${conversationId} · 导出时间：${timestamp} · 消息数量：${messages.length} · 版本：${VERSION}`;
    page.append(heading, meta);

    const rendered = messages.map(renderMessage);
    for (const message of rendered) page.appendChild(message);
    const footer = document.createElement('footer');
    footer.className = 'export-footer';
    footer.textContent = `Generated by ChatGPT 会话 HTML 导出器 v${VERSION}`;
    page.appendChild(footer);

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)} - ChatGPT 会话导出</title>
<style>${exportStyles()}</style>
</head>
<body>${page.outerHTML}</body>
</html>`;
    return { html, rendered };
  }

  function validateDocument(html, expectedCount) {
    if (!html.startsWith('<!DOCTYPE html>')) throw new Error('生成的 HTML 缺少 DOCTYPE。');
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    if (parsed.querySelector('parsererror')) throw new Error('最终 HTML 解析失败。');
    const articles = [...parsed.querySelectorAll('.export-message')];
    if (articles.length !== expectedCount) {
      throw new Error(`消息数量校验失败：预期 ${expectedCount}，实际 ${articles.length}。`);
    }
    let codeBlockCount = 0;
    let emptyMessageCount = 0;
    let textLength = 0;
    for (const article of articles) {
      const body = article.querySelector('.export-message-content');
      if (!body) throw new Error('发现缺少正文容器的消息。');
      if (!body.textContent.trim() && !body.querySelector('img,svg,video')) emptyMessageCount++;
      codeBlockCount += body.querySelectorAll('pre code').length;
      textLength += body.textContent.length;
    }
    if (!textLength) throw new Error('导出文档没有有效正文。');
    return {
      messageCount: articles.length,
      codeBlockCount,
      emptyMessageCount,
      parsedTextLength: textLength,
      dilComponentCount: parsed.querySelectorAll('[class^="dil-"],[class*=" dil-"]').length
    };
  }

  function downloadHTML(html) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = `ChatGPT-会话导出-${timestamp}.html`;
    link.style.display = 'none';
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    return link.download;
  }

  async function handleExport() {
    if (state.running) return;
    const conversationId = getConversationId();
    if (!conversationId) {
      setStatus('无法从当前 URL 获取会话 ID。', 'error');
      return;
    }
    if (!window.marked || !window.DOMPurify) {
      setStatus('Markdown 清洗依赖尚未加载，请稍后重试。', 'error');
      return;
    }
    state.running = true;
    const button = document.getElementById(IDS.button);
    if (button) {
      button.disabled = true;
      button.textContent = '正在导出…';
    }
    resetDiagnostics(conversationId);
    diagnostics.rendering = {
      dilComponentCount: 0,
      modelDILRenderedCount: 0,
      modelDILErrors: [],
      unsupportedDILExpressionCount: 0,
      mermaidBlockCount: 0,
      mermaidRenderedCount: 0,
      mermaidErrors: []
    };

    try {
      configureMarkdown();
      setStatus('正在获取会话数据…');
      const allMessages = await fetchMessages(conversationId);
      const selected = selectMessages(allMessages);
      if (!selected.length) throw new Error('没有找到可导出的用户消息或 assistant 最终回答。');
      if (!diagnostics.api.selectedUserCount) warn('当前响应中没有用户消息。');
      if (!diagnostics.api.selectedAssistantFinalCount) warn('当前响应中没有 channel=final 的 assistant 消息。');

      setStatus(`已筛选 ${selected.length} 条消息，正在渲染内容…`);
      const { html, rendered } = buildDocument(selected, conversationId);
      const renderRoot = document.createElement('div');
      for (const message of rendered) renderRoot.appendChild(message);
      await renderMermaid(renderRoot);

      const finalMessages = [...renderRoot.querySelectorAll('.export-message')];
      const finalPage = document.createElement('main');
      finalPage.className = 'export-page';
      const parsedOriginal = new DOMParser().parseFromString(html, 'text/html');
      const originalPage = parsedOriginal.querySelector('.export-page');
      if (originalPage) {
        const footer = originalPage.querySelector('.export-footer');
        originalPage.querySelectorAll('.export-message').forEach(message => message.remove());
        for (const message of finalMessages) originalPage.insertBefore(message, footer || null);
      }
      const finalHTML = originalPage
        ? `<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(document.title || 'ChatGPT 会话导出')}</title><style>${exportStyles()}</style></head><body>${originalPage.outerHTML}</body></html>`
        : html;

      const validation = validateDocument(finalHTML, selected.length);
      const filename = downloadHTML(finalHTML);
      const hasUnfetchedPages = diagnostics.api.hasUnfetchedPages === true;
      if (diagnostics.rendering.unsupportedDILExpressionCount) {
        warn('检测到 DIL 运行时表达式；导出保留其静态可读内容，不执行模型生成的 JavaScript 或交互绑定。');
      }
      if (diagnostics.rendering.mermaidErrors.length) {
        warn(`${diagnostics.rendering.mermaidErrors.length} 个 Mermaid 图表渲染失败，原始代码已保留。`);
      }

      diagnostics.result = {
        success: true,
        completeness: {
          isComplete: hasUnfetchedPages ? false : null,
          status: hasUnfetchedPages ? 'partial' : 'unverified',
          reason: hasUnfetchedPages
            ? ['接口分页标志表明可能仍有未获取的数据；未执行第三阶段请求。']
            : ['两阶段响应已按接口顺序合并，且未发现明确的剩余分页标志；这不能证明会话的所有分支均已导出。']
        },
        filename,
        htmlLength: finalHTML.length,
        exportedMessageCount: selected.length,
        userMessageCount: diagnostics.api.selectedUserCount,
        assistantFinalCount: diagnostics.api.selectedAssistantFinalCount,
        validation
      };
      setStatus(`导出完成：${filename}${hasUnfetchedPages ? '（部分数据）' : ''}`, 'success');
      log();
    } catch (error) {
      diagnostics.errors.push({
        name: error?.name || 'Error',
        message: error?.message || String(error),
        stack: error?.stack || ''
      });
      diagnostics.result = { success: false, reason: error?.message || String(error) };
      setStatus(`导出失败：${error?.message || String(error)}`, 'error');
      log();
    } finally {
      state.running = false;
      const currentButton = document.getElementById(IDS.button);
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.innerHTML = '<span aria-hidden="true">↓</span><span>导出会话 HTML</span>';
      }
    }
  }

  function initialize() {
    if (!document.body) {
      requestAnimationFrame(initialize);
      return;
    }
    injectUI();
    installObserver();
  }

  initialize();
})();
