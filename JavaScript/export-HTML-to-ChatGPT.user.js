// ==UserScript==
// @name         ChatGPT 会话 HTML 导出器
// @namespace    https://github.com/JKwarn/upload-my
// @version      2.5.0
// @description  通过会话接口校验消息，并复用 ChatGPT 原生 DOM 与 CSS 导出独立 HTML
// @match        https://chatgpt.com/c/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '2.5.0';
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
    maxMessageLength: 20000000
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
    dom: {},
    css: {},
    result: null
  };

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
      dom: {},
      css: {},
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
    setStatus.timer = setTimeout(() => node.classList.remove('visible'), 6000);
  }

  function injectUI() {
    if (!document.body) return;
    if (!document.getElementById(IDS.style)) {
      const style = document.createElement('style');
      style.id = IDS.style;
      style.textContent = `
        #${IDS.button}{position:fixed;right:24px;bottom:24px;z-index:2147483646;display:flex;align-items:center;gap:8px;min-width:148px;height:42px;padding:0 17px;border:1px solid rgba(255,255,255,.15);border-radius:11px;background:#10a37f;color:#fff;font-family:inherit;font-size:14px;font-weight:600;line-height:1.2;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.18)}
        #${IDS.button}:hover{background:#0d8f70}
        #${IDS.button}:disabled{opacity:.65;cursor:wait}
        #${IDS.toast}{position:fixed;right:24px;bottom:76px;z-index:2147483647;max-width:min(460px,calc(100vw - 32px));padding:11px 15px;border-radius:9px;background:#202123;color:#fff;font-family:inherit;font-size:13px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.2);opacity:0;pointer-events:none;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease}
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
      button.textContent = '↓ 导出会话 HTML';
      button.addEventListener('click', handleExport);
      document.body.appendChild(button);
    }
  }

  function installObserver() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(() => {
      if (!document.getElementById(IDS.button) || !document.getElementById(IDS.style)) injectUI();
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
      oldPage.has_previous_page === true ||
      newPage.has_next_page === true;

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
    if (missingIdCount) warn(`${missingIdCount} 条消息缺少 ID，无法进行精确 DOM 对应。`);
    if (hasUnfetchedPages) warn('接口分页标志表明可能仍有未获取的消息；按两阶段约束未继续请求。');
    return merged;
  }

  function roleOf(message) {
    return message?.author?.role || 'unknown';
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
      const contentType = message?.content?.content_type || 'unknown';
      const channel = channelOf(message) || '(null)';
      counts.roles[role] = (counts.roles[role] || 0) + 1;
      counts.contentTypes[contentType] = (counts.contentTypes[contentType] || 0) + 1;
      counts.channels[channel] = (counts.channels[channel] || 0) + 1;
      if (contentType === 'reasoning_recap') {
        counts.reasoningRecap++;
      } else if (contentType === 'thoughts') {
        counts.thoughts++;
      } else if (role === 'user') {
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

  const ID_ATTRIBUTES = [
    'data-message-id',
    'data-message-uuid',
    'data-chatgpt-selection-message-id',
    'data-chatgpt-search-message-ids',
    'data-turn-id'
  ];
  const ROLE_SELECTORS = [
    '[data-message-author-role]',
    '[data-conversation-role]',
    '[data-role]'
  ].join(',');

  function idAttributeMatches(element, messageId) {
    for (const name of ID_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (!value) continue;
      if (value === messageId) return true;
      if (name === 'data-chatgpt-search-message-ids') {
        const values = value.split(/[\s,]+/).filter(Boolean);
        if (values.includes(messageId)) return true;
      }
    }
    return false;
  }

  function normalizedRole(element) {
    const raw = element?.getAttribute('data-message-author-role') ||
      element?.getAttribute('data-conversation-role') ||
      element?.getAttribute('data-role') || '';
    if (raw === 'user' || raw === 'assistant') return raw;
    if (element?.matches?.('[data-user-message-bubble="true"]')) return 'user';
    const unit = element?.getAttribute('data-chatgpt-search-unit-key') || '';
    const match = unit.match(/:(user|assistant)$/);
    return match?.[1] || null;
  }

  function findRoleElement(anchor, role) {
    const ownRole = normalizedRole(anchor);
    if (ownRole === role) return anchor;
    const descendants = [...anchor.querySelectorAll(ROLE_SELECTORS + ',[data-user-message-bubble="true"],[data-chatgpt-search-unit-key]')];
    return descendants.find(element => normalizedRole(element) === role) || null;
  }

  function findDomMessage(item) {
    const messageId = item.message?.id;
    if (!messageId) return null;
    const anchors = [...document.querySelectorAll(
      '[data-message-id],[data-message-uuid],[data-chatgpt-selection-message-id],[data-chatgpt-search-message-ids],[data-turn-id]'
    )].filter(element => idAttributeMatches(element, messageId));

    const matches = [];
    for (const anchor of anchors) {
      const roleElement = findRoleElement(anchor, item.role);
      if (roleElement && !matches.includes(roleElement)) matches.push(roleElement);
    }
    if (!matches.length) {
      const roleNodes = [...document.querySelectorAll(ROLE_SELECTORS + ',[data-user-message-bubble="true"],[data-chatgpt-search-unit-key]')];
      for (const roleElement of roleNodes) {
        if (normalizedRole(roleElement) !== item.role) continue;
        let ancestor = roleElement;
        for (let depth = 0; ancestor && depth < 9; depth++, ancestor = ancestor.parentElement) {
          if (idAttributeMatches(ancestor, messageId)) {
            if (!matches.includes(roleElement)) matches.push(roleElement);
            break;
          }
        }
      }
    }
    if (matches.length !== 1) {
      return { error: matches.length > 1 ? 'duplicate-dom-match' : 'not-found', matchCount: matches.length };
    }
    return { element: matches[0] };
  }

  function getCloneRoot(roleElement) {
    const selectors = [
      '[data-virtualized-turn]',
      '[data-testid^="conversation-turn-"]',
      'article[data-turn]',
      'section[data-turn-id][data-turn]',
      '[data-turn-key]'
    ];
    for (const selector of selectors) {
      const shell = roleElement.closest(selector);
      if (!shell) continue;
      const roleNodes = [...shell.querySelectorAll(ROLE_SELECTORS + ',[data-user-message-bubble="true"],[data-chatgpt-search-unit-key]')]
        .filter(node => normalizedRole(node));
      const ids = new Set();
      for (const node of roleNodes) {
        let current = node;
        for (let depth = 0; current && current !== shell.parentElement && depth < 8; depth++, current = current.parentElement) {
          for (const name of ID_ATTRIBUTES) {
            const value = current.getAttribute(name);
            if (!value) continue;
            if (name === 'data-chatgpt-search-message-ids') {
              value.split(/[\s,]+/).filter(Boolean).forEach(id => ids.add(id));
            } else {
              ids.add(value);
            }
          }
          if (current === shell) break;
        }
      }
      if (ids.size <= 1) return shell;
    }
    return roleElement;
  }

  function removeVirtualizationArtifacts(root) {
    const nodes = [root, ...root.querySelectorAll('*')];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      node.style.removeProperty('height');
      node.style.removeProperty('min-height');
      node.style.removeProperty('max-height');
      node.style.removeProperty('margin-top');
      node.style.removeProperty('contain');
      node.style.removeProperty('overflow');
      node.style.removeProperty('overflow-y');
      node.style.removeProperty('content-visibility');
      if (node.hasAttribute('data-virtualized-turn')) {
        node.style.height = 'auto';
        node.style.minHeight = '0';
        node.style.overflow = 'visible';
      }
    }
  }

  function removeNonContentControls(root) {
    root.querySelectorAll(
      'button,[role="toolbar"],[data-testid*="action-bar"],[data-testid*="copy-button"],.sr-only'
    ).forEach(node => node.remove());
  }


  function summarizeDomElement(element) {
    if (!(element instanceof Element)) return null;
    const attributes = {};
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith('data-')) attributes[attribute.name] = attribute.value.slice(0, 300);
    }
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    let visibility = null;
    try {
      const style = getComputedStyle(element);
      visibility = { display: style.display, visibility: style.visibility, opacity: style.opacity, contentVisibility: style.contentVisibility };
    } catch {}
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(), id: element.id || null,
      className: typeof element.className === 'string' ? element.className.slice(0, 500) : null,
      testId: element.getAttribute('data-testid'), role: normalizedRole(element),
      attributes, textLength: text.length, textPreview: text.slice(0, 240),
      hiddenAttribute: element.hasAttribute('hidden'), ariaHidden: element.getAttribute('aria-hidden'),
      hasClientRects: element.getClientRects().length > 0,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      visibility
    };
  }

  function diagnoseDom(selected) {
    const roleSelector = ROLE_SELECTORS + ',[data-user-message-bubble="true"],[data-chatgpt-search-unit-key]';
    const roleNodes = [...document.querySelectorAll(roleSelector)];
    const idSelector = ID_ATTRIBUTES.map(name => `[${name}]`).join(',');
    const idNodes = [...document.querySelectorAll(idSelector)];
    const selectedCandidates = selected.map((item, index) => {
      const messageId = item.message?.id || '';
      const anchors = idNodes.filter(element => idAttributeMatches(element, messageId));
      return {
        index, messageId, expectedRole: item.role,
        matchingIdAttributeElementCount: anchors.length,
        matchingIdAttributeElements: anchors.slice(0, 12).map(summarizeDomElement),
        matchingRoleDescendantCount: anchors.reduce((count, anchor) => count + (findRoleElement(anchor, item.role) ? 1 : 0), 0)
      };
    });
    const roleNodeDetails = roleNodes.slice(0, 120).map((element, index) => {
      const ancestors = [];
      let current = element;
      for (let depth = 0; current && depth < 9; depth++, current = current.parentElement) ancestors.push(summarizeDomElement(current));
      return { index, element: summarizeDomElement(element), ancestors };
    });
    const idAttributeCounts = Object.fromEntries(ID_ATTRIBUTES.map(name => [name, document.querySelectorAll(`[${name}]`).length]));
    return {
      capturedAt: new Date().toISOString(),
      document: {
        url: location.href, title: document.title, readyState: document.readyState,
        scrollY: Math.round(window.scrollY),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        documentHeight: document.documentElement?.scrollHeight || 0
      },
      selectorInventory: {
        roleSelector, roleNodeCount: roleNodes.length, idAttributeCounts,
        idAttributeElementCount: idNodes.length,
        roleNodeDetailsTruncated: roleNodes.length > roleNodeDetails.length,
        roleNodeDetails
      },
      selectedCandidates
    };
  }

  function findConversationScrollContainer() {
    const turn = document.querySelector('[data-virtualized-turn]');
    if (!turn) return { element: null, reason: 'no-virtualized-turn' };
    const candidates = [];
    let current = turn.parentElement;
    let depth = 0;
    while (current && current !== document.body && current !== document.documentElement && depth < 18) {
      const style = getComputedStyle(current);
      const range = current.scrollHeight - current.clientHeight;
      const turnCount = current.querySelectorAll('[data-virtualized-turn]').length;
      if (range > 80 && turnCount > 0 && /(auto|scroll|overlay|hidden)/.test(style.overflowY)) {
        const rect = current.getBoundingClientRect();
        candidates.push({ element: current, depth, overflowY: style.overflowY,
          scrollHeight: current.scrollHeight, clientHeight: current.clientHeight,
          scrollTop: current.scrollTop, scrollRange: range, turnCount,
          area: Math.max(0, rect.width) * Math.max(0, rect.height) });
      }
      current = current.parentElement;
      depth++;
    }
    candidates.sort((a, b) => b.turnCount - a.turnCount || b.scrollRange - a.scrollRange || b.area - a.area || a.depth - b.depth);
    const chosen = candidates[0] || null;
    return {
      element: chosen?.element || null,
      details: chosen ? {
        tag: chosen.element.tagName.toLowerCase(), id: chosen.element.id || null,
        className: typeof chosen.element.className === 'string' ? chosen.element.className.slice(0, 300) : null,
        testId: chosen.element.getAttribute('data-testid'), overflowY: chosen.overflowY,
        scrollHeight: chosen.scrollHeight, clientHeight: chosen.clientHeight,
        scrollTop: chosen.scrollTop, scrollRange: chosen.scrollRange,
        virtualizedTurnCount: chosen.turnCount, candidateCount: candidates.length,
        ancestorDepth: chosen.depth
      } : null,
      reason: chosen ? null : 'no-scrollable-ancestor-containing-virtualized-turn'
    };
  }

  function waitForVirtualizedUpdate(previousSignature, timeout = 700) {
    return new Promise(resolve => {
      let finished = false;
      let timer;
      let stableTimer;
      const signature = () => [...document.querySelectorAll('[data-virtualized-turn]')]
        .map(node => (node.getAttribute('data-testid') || '') + ':' + (node.innerText || '').length)
        .join('|');
      const observer = new MutationObserver(() => {
        clearTimeout(stableTimer);
        stableTimer = setTimeout(() => finish(signature() !== previousSignature), 100);
      });
      const finish = changed => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(stableTimer);
        resolve(changed);
      };
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(() => finish(signature() !== previousSignature), timeout);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (signature() !== previousSignature) stableTimer = setTimeout(() => finish(true), 100);
      }));
    });
  }

  function captureVisibleMessages(selected, captured, duplicates) {
    let newlyCaptured = 0;
    for (const [index, item] of selected.entries()) {
      const messageId = item.message?.id;
      if (!messageId || captured.has(messageId)) continue;
      const result = findDomMessage(item);
      if (!result?.element) {
        if (result?.error === 'duplicate-dom-match') duplicates.set(messageId, {
          index, messageId, role: item.role, matchCount: result.matchCount
        });
        continue;
      }
      const sourceRoot = getCloneRoot(result.element);
      const clone = sourceRoot.cloneNode(true);
      removeVirtualizationArtifacts(clone);
      removeNonContentControls(clone);
      const wrapper = document.createElement('section');
      wrapper.className = 'export-message';
      wrapper.dataset.messageIndex = String(index + 1);
      wrapper.dataset.messageId = messageId;
      wrapper.dataset.role = item.role;
      wrapper.appendChild(clone);
      captured.set(messageId, { index, messageId, role: item.role, source: sourceRoot, clone: wrapper });
      newlyCaptured++;
    }
    return newlyCaptured;
  }

  async function cloneNativeMessages(selected) {
    const discovery = diagnoseDom(selected);
    const captured = new Map();
    const duplicates = new Map();
    const traversal = {
      startedAt: new Date().toISOString(),
      strategy: 'reset-to-top-then-forward-scan',
      container: null, initialScrollTop: null, finalScrollTop: null,
      maxScrollTop: null, stepSize: null, stepCount: 0,
      mutationWaitTimeoutMs: 700, capturedPerStep: [],
      reachedTop: false, reachedBottom: false,
      restoredOriginalScrollTop: false, failure: null
    };
    traversal.initialCaptureCount = captureVisibleMessages(selected, captured, duplicates);
    const found = findConversationScrollContainer();
    const scrollElement = found.element;
    traversal.container = found.details;

    if (!scrollElement) {
      traversal.failure = found.reason;
      warn('未发现包含虚拟化对话轮次的可滚动容器；当前页面 DOM 可能仅包含部分消息。');
    } else {
      const originalScrollTop = scrollElement.scrollTop;
      traversal.initialScrollTop = originalScrollTop;
      traversal.maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
      traversal.stepSize = Math.max(240, Math.floor(scrollElement.clientHeight * 0.68));
      try {
        scrollElement.scrollTop = 0;
        await new Promise(resolve => setTimeout(resolve, 180));
        captureVisibleMessages(selected, captured, duplicates);
        traversal.reachedTop = scrollElement.scrollTop <= 2;
        let previousTop = scrollElement.scrollTop;
        const maxSteps = Math.min(600, Math.ceil(traversal.maxScrollTop / Math.max(1, traversal.stepSize)) + 8);
        for (let step = 0; step < maxSteps; step++) {
          const maxTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
          const nextTop = Math.min(maxTop, previousTop + traversal.stepSize);
          if (nextTop <= previousTop + 1) {
            traversal.reachedBottom = true;
            break;
          }
          const beforeSignature = [...document.querySelectorAll('[data-virtualized-turn]')]
            .map(node => (node.getAttribute('data-testid') || '') + ':' + (node.innerText || '').length)
            .join('|');
          scrollElement.scrollTop = nextTop;
          await waitForVirtualizedUpdate(beforeSignature, traversal.mutationWaitTimeoutMs);
          const capturedNow = captureVisibleMessages(selected, captured, duplicates);
          traversal.stepCount++;
          traversal.capturedPerStep.push({
            step: traversal.stepCount, requestedScrollTop: nextTop,
            actualScrollTop: scrollElement.scrollTop,
            maxScrollTop: Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
            virtualizedTurnCount: document.querySelectorAll('[data-virtualized-turn]').length,
            newlyCapturedMessageCount: capturedNow,
            totalCapturedMessageCount: captured.size
          });
          const actualTop = scrollElement.scrollTop;
          if (actualTop <= previousTop + 1) {
            traversal.reachedBottom = actualTop >= Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight) - 2;
            if (!traversal.reachedBottom) {
              traversal.failure = 'scroll-position-did-not-advance';
              break;
            }
          }
          previousTop = actualTop;
          if (traversal.reachedBottom) break;
        }
        if (!traversal.reachedBottom && !traversal.failure) {
          const currentMax = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
          traversal.reachedBottom = scrollElement.scrollTop >= currentMax - 2;
          if (!traversal.reachedBottom) traversal.failure = 'maximum-scroll-steps-reached';
        }
      } catch (error) {
        traversal.failure = error?.message || String(error);
      } finally {
        try {
          scrollElement.scrollTop = originalScrollTop;
          await new Promise(resolve => setTimeout(resolve, 120));
          traversal.restoredOriginalScrollTop = Math.abs(scrollElement.scrollTop - originalScrollTop) <= 2;
          traversal.finalScrollTop = scrollElement.scrollTop;
        } catch (error) {
          traversal.restoreError = error?.message || String(error);
        }
      }
    }

    const exported = selected.map(item => captured.get(item.message.id)).filter(Boolean);
    const missing = selected.map((item, index) => ({
      index, messageId: item.message?.id || null, role: item.role
    })).filter(item => item.messageId && !captured.has(item.messageId));
    diagnostics.dom = {
      discovery, traversal, expectedMessageCount: selected.length,
      matchedMessageCount: exported.length, missingMessageCount: missing.length,
      duplicateMessageCount: duplicates.size, missing,
      duplicate: [...duplicates.values()],
      mapping: exported.map(({ index, messageId, role }) => ({ index, messageId, role }))
    };
    return exported;
  }

  function collectCustomProperties(element) {
    const computed = getComputedStyle(element);
    const properties = [];
    for (let index = 0; index < computed.length; index++) {
      const name = computed[index];
      if (!name.startsWith('--')) continue;
      const value = computed.getPropertyValue(name).trim();
      if (value) properties.push(`${name}:${value}`);
    }
    return properties;
  }

  function preserveElementVariables(source, clone) {
    const sourceNodes = [source, ...source.querySelectorAll('*')];
    const cloneNodes = [clone, ...clone.querySelectorAll('*')];
    const count = Math.min(sourceNodes.length, cloneNodes.length);
    let copied = 0;
    for (let index = 0; index < count; index++) {
      const properties = collectCustomProperties(sourceNodes[index]);
      if (properties.length) {
        cloneNodes[index].style.cssText += `;${properties.join(';')};`;
        copied += properties.length;
      }
    }
    return copied;
  }

  function absolutizeCssUrls(cssText) {
    return cssText.replace(/url\(\s*(['"]?)(?!data:|https?:|blob:|#)([^)'"]+)\1\s*\)/gi, (match, quote, raw) => {
      const value = raw.trim();
      try {
        return `url("${new URL(value, location.href).href}")`;
      } catch {
        return match;
      }
    });
  }

  function collectPageStyles() {
    const cssParts = [];
    const externalLinks = [];
    const inaccessible = [];
    let accessibleCount = 0;
    let cssLength = 0;

    for (const [index, sheet] of [...document.styleSheets].entries()) {
      try {
        const rules = sheet.cssRules;
        if (!rules) throw new Error('cssRules 不可用');
        const cssText = [...rules].map(rule => rule.cssText).join('\n');
        if (cssText) {
          cssParts.push(absolutizeCssUrls(cssText));
          accessibleCount++;
          cssLength += cssText.length;
        }
      } catch (error) {
        inaccessible.push({
          index,
          href: sheet.href || '(inline)',
          reason: error?.message || String(error)
        });
        if (sheet.href) {
          try {
            externalLinks.push(new URL(sheet.href, location.href).href);
          } catch {}
        }
      }
    }

    const rootProperties = collectCustomProperties(document.documentElement);
    const bodyProperties = collectCustomProperties(document.body);
    const rootTheme = document.documentElement.getAttribute('data-theme') || '';
    const rootClass = typeof document.documentElement.className === 'string'
      ? document.documentElement.className : '';

    diagnostics.css = {
      stylesheetCount: document.styleSheets.length,
      accessibleStylesheetCount: accessibleCount,
      inaccessibleStylesheets: inaccessible,
      externalStylesheetFallbackCount: externalLinks.length,
      cssLength,
      rootCustomPropertyCount: rootProperties.length,
      bodyCustomPropertyCount: bodyProperties.length
    };
    if (inaccessible.length) warn('部分样式表无法读取 CSSOM；已在导出文档中保留其原始样式表链接。');
    return {
      css: cssParts.join('\n\n'),
      externalLinks: [...new Set(externalLinks)],
      rootProperties,
      bodyProperties,
      rootTheme,
      rootClass
    };
  }

  function buildDocument(exported, selected, conversationId) {
    const styles = collectPageStyles();
    let copiedCustomPropertyCount = 0;
    for (const item of exported) {
      copiedCustomPropertyCount += preserveElementVariables(item.source, item.clone.firstElementChild);
    }

    const title = escapeHTML(document.title || 'ChatGPT 会话导出');
    const links = styles.externalLinks.map(href =>
      `<link rel="stylesheet" href="${escapeHTML(href)}">`
    ).join('\n');
    const rootVars = styles.rootProperties.join(';');
    const bodyVars = styles.bodyProperties.join(';');
    const messages = exported.map(item => item.clone.outerHTML).join('\n');

    const html = `<!DOCTYPE html>
<html lang="zh-CN" class="${escapeHTML(styles.rootClass)}" data-theme="${escapeHTML(styles.rootTheme)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
${links}
<style>
:root{${rootVars}}
body{${bodyVars}}
${styles.css}
html{min-height:100%;background:var(--main-surface-primary,#fff)}
body{margin:0;padding:12mm;background:var(--main-surface-primary,#fff);color:var(--text-primary,#0d0d0d)}
.export-page{width:100%;max-width:186mm;margin:0 auto;box-sizing:border-box}
.export-message{width:100%;min-width:0;margin:0 auto 28px;box-sizing:border-box;overflow:visible}
.export-message>*{width:100%;min-width:0;max-width:100%}
.export-message [data-virtualized-turn]{height:auto!important;min-height:0!important;max-height:none!important;margin-top:0!important;contain:none!important;overflow:visible!important;content-visibility:visible!important}
.export-message pre,.export-message code,.export-message table{max-width:100%}
.export-message img,.export-message video,.export-message svg{max-width:100%;height:auto}
@media print{body{padding:0}.export-page{max-width:none}.export-message{break-inside:auto}pre,table,blockquote{break-inside:avoid}}
@page{size:A4;margin:12mm}
</style>
</head>
<body>
<main class="export-page" data-conversation-id="${escapeHTML(conversationId)}">
${messages}
</main>
</body>
</html>`;

    diagnostics.css.copiedElementCustomPropertyCount = copiedCustomPropertyCount;
    diagnostics.dom.exportedMessageCount = exported.length;
    diagnostics.dom.exportedTextLength = exported.reduce(
      (total, item) => total + (item.clone.innerText || item.clone.textContent || '').length, 0
    );
    return html;
  }

  function validateDocument(html, expectedCount) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const actualCount = parsed.querySelectorAll('.export-message').length;
    const textLength = (parsed.body.innerText || parsed.body.textContent || '').length;
    const ids = [...parsed.querySelectorAll('.export-message')].map(node => node.dataset.messageId);
    const uniqueIds = new Set(ids.filter(Boolean));
    const validation = {
      expectedMessageCount: expectedCount,
      actualMessageCount: actualCount,
      uniqueMessageIdCount: uniqueIds.size,
      textLength,
      hasDoctype: /^<!doctype html>/i.test(html),
      hasOriginalMarkdownRoots: parsed.querySelectorAll('[class*="MarkdownRoot-"]').length > 0,
      hasCodeBlocks: parsed.querySelectorAll('pre, [data-code-block="true"]').length > 0,
      hasSvg: parsed.querySelectorAll('svg').length > 0
    };
    if (!validation.hasDoctype) throw new Error('最终 HTML 缺少 DOCTYPE。');
    if (actualCount !== expectedCount) {
      throw new Error(`DOM 映射数量不一致：接口预期 ${expectedCount}，实际导出 ${actualCount}。`);
    }
    if (uniqueIds.size !== expectedCount) {
      throw new Error(`导出消息 ID 不唯一：预期 ${expectedCount}，实际唯一 ID ${uniqueIds.size}。`);
    }
    if (textLength < 1) throw new Error('最终 HTML 没有有效文本内容。');
    return validation;
  }

  function downloadHTML(html, conversationId) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ChatGPT-${conversationId}-v${VERSION}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return link.download;
  }

  async function handleExport() {
    if (state.running) return;
    const conversationId = getConversationId();
    if (!conversationId) {
      setStatus('当前页面不是有效的 ChatGPT 会话页面。', 'error');
      return;
    }
    state.running = true;
    const button = document.getElementById(IDS.button);
    if (button) {
      button.disabled = true;
      button.textContent = '正在导出…';
    }
    resetDiagnostics(conversationId);

    try {
      setStatus('正在获取会话数据…');
      const allMessages = await fetchMessages(conversationId);
      const selected = selectMessages(allMessages);
      if (!selected.length) throw new Error('没有找到可导出的用户消息或 assistant 最终回答。');
      if (diagnostics.api.hasUnfetchedPages) {
        throw new Error('接口分页标志表明仍可能存在未获取消息。为避免导出不完整，本次停止。');
      }
      if (selected.some(item => !item.message?.id)) {
        throw new Error('部分目标消息缺少 ID，无法与原生 DOM 精确对应。');
      }

      setStatus(`接口已筛选 ${selected.length} 条消息，正在遍历虚拟滚动页面…`);
      const exported = await cloneNativeMessages(selected);
      if (exported.length !== selected.length) {
        const missingCount = diagnostics.dom.missingMessageCount + diagnostics.dom.duplicateMessageCount;
        throw new Error(`虚拟滚动遍历后仍无法完整对应接口消息：目标 ${selected.length} 条，匹配 ${exported.length} 条，缺失或歧义 ${missingCount} 条。未生成不完整文件。`);
      }

      setStatus('正在提取 ChatGPT 原生样式并生成 HTML…');
      const html = buildDocument(exported, selected, conversationId);
      const validation = validateDocument(html, selected.length);
      const filename = downloadHTML(html, conversationId);

      diagnostics.result = {
        success: true,
        completeness: {
          isComplete: null,
          status: 'unverified',
          reason: ['两阶段 API 消息与原生 DOM 已按消息 ID 一一对应；未证明会话所有分支均已包含。']
        },
        rendering: 'ChatGPT 原生 DOM 克隆与原生 CSS 提取；未使用独立 Markdown、DIL 或 Mermaid 渲染器。',
        filename,
        htmlLength: html.length,
        exportedMessageCount: selected.length,
        userMessageCount: diagnostics.api.selectedUserCount,
        assistantFinalCount: diagnostics.api.selectedAssistantFinalCount,
        validation
      };
      setStatus(`导出完成：${filename}`, 'success');
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
        currentButton.textContent = '↓ 导出会话 HTML';
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
