// ==UserScript==
// @name         ChatGPT 会话 HTML 导出器
// @namespace    https://github.com/JKwarn/upload-my
// @version      2.7.8
// @description  通过会话接口校验消息，并复用 ChatGPT 原生 DOM 与 CSS 导出独立 HTML
// @match        https://chatgpt.com/c/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '2.7.8';
  const PREFIX = '[ChatGPT 会话 HTML 导出器]';
  const IDS = {
    button: 'chatgpt-html-exporter-button',
    controls: 'chatgpt-html-exporter-controls',
    speed: 'chatgpt-html-exporter-speed',
    style: 'chatgpt-html-exporter-style',
    toast: 'chatgpt-html-exporter-toast',
    logDownload: 'chatgpt-html-exporter-log-download',
    logToggle: 'chatgpt-html-exporter-log-toggle',
    logToggleLabel: 'chatgpt-html-exporter-log-toggle-label',
    stopButton: 'chatgpt-html-exporter-stop'
  };
  const CONFIG = {
    sessionApi: '/api/auth/session',
    conversationApi: '/backend-api/conversations/',
    numTurns: 10,
    maxPaginationPages: 100,
    requestTimeout: 30000,
    maxMessageLength: 20000000,
    defaultScrollDelay: 1500,
    minScrollDelay: 200,
    maxScrollDelay: 10000,
    scrollDelayStorageKey: 'chatgpt-html-exporter-scroll-delay'
  };
  const state = { running: false, observer: null, abortController: null, stopRequested: false, currentTraversal: null, currentScrollElement: null };
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
    mermaid: { events: [], waitResults: [] },
    result: null
  };

  function throwIfStopped() {
    if (state.stopRequested || state.abortController?.signal.aborted) {
      const error = new Error('用户请求停止导出。'); error.name = 'AbortError'; throw error;
    }
  }
  function requestStop() {
    if (!state.running || state.stopRequested) return;
    state.stopRequested = true;
    diagnostics.stop = {
      requestedAt: new Date().toISOString(),
      stage: state.currentTraversal?.preheat?.currentStage || 'unknown',
      scrollTop: state.currentScrollElement?.scrollTop ?? window.scrollY,
      maxScrollTop: state.currentScrollElement ? Math.max(0, state.currentScrollElement.scrollHeight - state.currentScrollElement.clientHeight) : null,
      recentScrollTrace: state.currentTraversal?.preheat?.recentTrace?.slice(-20) || [],
      pageScrollY: window.scrollY
    };
    diagnostics.warnings.push('用户点击停止按钮，中止当前导出流程。');
    state.abortController?.abort();
    setStatus('正在停止并保存诊断日志…', 'info');
  }
  function createDiagnosticFilename() {
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const conversation = String(diagnostics.conversationId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-');
    return 'ChatGPT-export-v' + VERSION + '-' + conversation + '-' + timestamp + '.json';
  }

  function downloadDiagnostics() {
    const filename = createDiagnosticFilename();
    const content = JSON.stringify(diagnostics, null, 2);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const manualButton = document.getElementById(IDS.logDownload);
    if (manualButton) {
      manualButton.dataset.filename = filename;
      manualButton.hidden = false;
      manualButton.disabled = false;
      manualButton.textContent = '↓ 重新下载日志';
    }
    return { filename, size: blob.size };
  }

  function log(force = false) {
    const logToggle = document.getElementById(IDS.logToggle);
    if (!force && !logToggle?.checked) return;
    const success = Boolean(diagnostics.result && diagnostics.result.success);
    try {
      const file = downloadDiagnostics();
      const selectedCount = (diagnostics.api.selectedUserCount || 0) + (diagnostics.api.selectedAssistantFinalCount || 0);
      console[success ? 'log' : 'error'](PREFIX + ' ' + (success ? 'SUCCESS' : 'FAILED'), {
        version: VERSION, conversationId: diagnostics.conversationId, diagnosticFile: file.filename,
        diagnosticBytes: file.size, requestCount: diagnostics.api.requestPageCount || 0,
        apiMessageCount: diagnostics.api.mergedMessageCount || 0, selectedMessageCount: selectedCount,
        exportedMessageCount: diagnostics.result.exportedMessageCount || 0,
        errors: diagnostics.errors.length, warnings: diagnostics.warnings.length,
        result: diagnostics.result.reason || (success ? 'success' : 'failed')
      });
      setStatus('诊断日志已下载：' + file.filename, 'success');
    } catch (error) {
      console.error(PREFIX + ' 诊断日志自动下载失败', error);
      const manualButton = document.getElementById(IDS.logDownload);
      if (manualButton) { manualButton.hidden = false; manualButton.disabled = false; manualButton.textContent = '↓ 手动下载诊断日志'; }
      setStatus('诊断日志自动下载失败，请点击“手动下载诊断日志”。', 'error');
    }
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
      mermaid: { events: [] },
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


  function getScrollDelay() {
    const input = document.getElementById(IDS.speed);
    let stored = null;
    try { stored = localStorage.getItem(CONFIG.scrollDelayStorageKey); } catch {}
    const raw = input?.value ?? stored;
    const value = Number(raw);
    if (!Number.isFinite(value)) return CONFIG.defaultScrollDelay;
    return Math.min(CONFIG.maxScrollDelay, Math.max(CONFIG.minScrollDelay, Math.round(value)));
  }

  function injectUI() {
    if (!document.body) return;
    if (!document.getElementById(IDS.style)) {
      const style = document.createElement('style');
      style.id = IDS.style;
      style.textContent = `
        #${IDS.controls}{position:fixed;right:24px;bottom:24px;z-index:2147483646;display:flex;align-items:center;gap:9px;padding:6px;border:1px solid rgba(128,128,128,.2);border-radius:13px;background:rgba(32,33,35,.94);box-shadow:0 4px 16px rgba(0,0,0,.2);backdrop-filter:blur(8px)}
        #${IDS.controls} label{display:flex;align-items:center;gap:6px;padding-left:7px;color:#fff;font-family:inherit;font-size:12px;white-space:nowrap}
        #${IDS.speed}{width:76px;height:34px;box-sizing:border-box;padding:0 7px;border:1px solid rgba(255,255,255,.24);border-radius:7px;background:#fff;color:#202123;font:13px inherit;text-align:center;outline:none}
        #${IDS.speed}:focus{border-color:#10a37f;box-shadow:0 0 0 2px rgba(16,163,127,.2)}
        #${IDS.speed}:disabled{opacity:.6}
        #${IDS.logToggleLabel}{display:flex;align-items:center;gap:8px;padding:0 5px;color:#fff;font-family:inherit;font-size:12px;white-space:nowrap;cursor:pointer;user-select:none}
        #${IDS.logToggle}{appearance:none!important;-webkit-appearance:none!important;position:relative;display:inline-block;flex:0 0 34px;width:34px!important;height:19px!important;box-sizing:border-box;margin:0!important;padding:0!important;border:1px solid rgba(255,255,255,.28)!important;border-radius:999px!important;background:#666!important;cursor:pointer;transition:background .18s ease,border-color .18s ease;vertical-align:middle}
        #${IDS.logToggle}::before{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .18s ease}
        #${IDS.logToggle}:checked{background:#10a37f!important;border-color:#10a37f!important}
        #${IDS.logToggle}:checked::before{transform:translateX(15px)}
        #${IDS.logToggle}:focus-visible{outline:2px solid #fff;outline-offset:3px}
        #${IDS.logToggle}:disabled{opacity:.55;cursor:not-allowed}
        #${IDS.logToggleLabel}[data-enabled="true"]{color:#fff}
        #${IDS.logToggleLabel}[data-enabled="false"]{color:rgba(255,255,255,.78)}
        #${IDS.button}{display:flex;align-items:center;justify-content:center;gap:8px;min-width:148px;height:40px;padding:0 15px;border:1px solid rgba(255,255,255,.15);border-radius:9px;background:#10a37f;color:#fff;font-family:inherit;font-size:14px;font-weight:600;line-height:1.2;cursor:pointer}
        #${IDS.button}:hover{background:#0d8f70}
        #${IDS.button}:disabled{opacity:.65;cursor:wait}
        #${IDS.stopButton}{height:40px;padding:0 12px;border:1px solid rgba(255,255,255,.18);border-radius:9px;background:#b42318;color:#fff;font:600 13px inherit;cursor:pointer}
        #${IDS.stopButton}:hover{background:#912018}
        #${IDS.stopButton}[hidden]{display:none!important}
        #${IDS.logDownload}{height:40px;padding:0 11px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:rgba(255,255,255,.12);color:#fff;font-family:inherit;font-size:12px;cursor:pointer}
        #${IDS.logDownload}:hover{background:rgba(255,255,255,.2)}
        #${IDS.logDownload}:disabled{opacity:.6;cursor:wait}
        #${IDS.logDownload}[hidden]{display:none!important}
        #${IDS.toast}{position:fixed;right:24px;bottom:84px;z-index:2147483647;max-width:min(460px,calc(100vw - 32px));padding:11px 15px;border-radius:9px;background:#202123;color:#fff;font-family:inherit;font-size:13px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.2);opacity:0;pointer-events:none;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease}
        #${IDS.toast}.visible{opacity:1;transform:translateY(0)}
        #${IDS.toast}[data-type="success"]{border-left:4px solid #10a37f}
        #${IDS.toast}[data-type="error"]{border-left:4px solid #ef4444}
        #${IDS.toast}[data-type="info"]{border-left:4px solid #3b82f6}
        @media(max-width:520px){#${IDS.controls}{right:10px;bottom:10px;gap:5px}#${IDS.controls} label{font-size:11px}#${IDS.speed}{width:64px}#${IDS.logToggleLabel}{font-size:11px}#${IDS.button}{min-width:128px;padding:0 10px;font-size:13px}#${IDS.logDownload}{padding:0 8px;font-size:11px}#${IDS.toast}{right:10px;bottom:72px}}
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    let controls = document.getElementById(IDS.controls);
    if (!controls) {
      controls = document.createElement('div');
      controls.id = IDS.controls;
      const label = document.createElement('label');
      label.htmlFor = IDS.speed;
      label.textContent = '滚动等待';
      const input = document.createElement('input');
      input.id = IDS.speed;
      input.type = 'number';
      input.min = String(CONFIG.minScrollDelay);
      input.max = String(CONFIG.maxScrollDelay);
      input.step = '100';
      input.value = String(getScrollDelay());
      input.title = '每次滚动后至少等待的毫秒数（200–10000 ms）';
      input.setAttribute('aria-label', '滚动等待时间，单位毫秒');
      input.addEventListener('change', () => {
        const value = getScrollDelay();
        input.value = String(value);
        try { localStorage.setItem(CONFIG.scrollDelayStorageKey, String(value)); } catch {}
      });
      label.appendChild(input);
      const unit = document.createElement('span');
      unit.textContent = 'ms';
      label.appendChild(unit);
      controls.appendChild(label);
      document.body.appendChild(controls);
    }
    if (!document.getElementById(IDS.logToggle)) {
      const logLabel = document.createElement('label');
      logLabel.id = IDS.logToggleLabel;
      logLabel.htmlFor = IDS.logToggle;
      logLabel.title = '开启后，导出成功或失败时自动下载 JSON 诊断日志';
      const logCheckbox = document.createElement('input');
      logCheckbox.id = IDS.logToggle;
      logCheckbox.type = 'checkbox';
      logCheckbox.checked = false;
      logCheckbox.setAttribute('role', 'switch');
      logCheckbox.setAttribute('aria-checked', 'false');
      logCheckbox.setAttribute('aria-label', '自动下载诊断日志');
      logLabel.dataset.enabled = 'false';
      logCheckbox.addEventListener('change', () => {
        const enabled = logCheckbox.checked;
        logCheckbox.setAttribute('aria-checked', String(enabled));
        logLabel.dataset.enabled = String(enabled);
        logLabel.title = enabled
          ? '日志开关：已开启。导出成功或失败时自动下载 JSON 诊断日志。'
          : '日志开关：已关闭。导出时不会自动下载 JSON 诊断日志。';
      });
      const logText = document.createElement('span');
      logText.textContent = '日志';
      logLabel.append(logCheckbox, logText);
      controls.appendChild(logLabel);
    }
    if (!document.getElementById(IDS.button)) {
      const button = document.createElement('button');
      button.id = IDS.button;
      button.type = 'button';
      button.textContent = '↓ 导出会话 HTML';
      button.addEventListener('click', handleExport);
      controls.appendChild(button);
    } else {
      const button = document.getElementById(IDS.button);
      if (button.parentElement !== controls) controls.appendChild(button);
    }
    if (!document.getElementById(IDS.stopButton)) {
      const stopButton = document.createElement('button');
      stopButton.id = IDS.stopButton; stopButton.type = 'button';
      stopButton.textContent = '■ 停止'; stopButton.hidden = true;
      stopButton.addEventListener('click', requestStop);
      controls.appendChild(stopButton);
    }
    if (!document.getElementById(IDS.logDownload)) {
      const logButton = document.createElement('button');
      logButton.id = IDS.logDownload;
      logButton.type = 'button';
      logButton.textContent = '↓ 下载诊断日志';
      logButton.hidden = true;
      logButton.addEventListener('click', () => {
        try {
          const file = downloadDiagnostics();
          setStatus('诊断日志已下载：' + file.filename, 'success');
        } catch (error) {
          console.error(PREFIX + ' 手动下载诊断日志失败', error);
          setStatus('日志下载失败：' + (error && error.message ? error.message : String(error)), 'error');
        }
      });
      controls.appendChild(logButton);
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
    throwIfStopped();
    const controller = new AbortController();
    const externalSignal = state.abortController?.signal;
    const abortFromExport = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abortFromExport, { once: true });
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
      externalSignal?.removeEventListener('abort', abortFromExport);
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

  function summarizeApiMessage(message) {
    return {
      id: typeof message?.id === 'string' ? message.id : null,
      parentId: typeof message?.parent_id === 'string' ? message.parent_id : null,
      conversationId: message?.conversation_id ?? message?.conversationId ?? null,
      role: roleOf(message),
      createTime: message?.create_time ?? null,
      updateTime: message?.update_time ?? null,
      contentType: message?.content?.content_type ?? null,
      channel: channelOf(message)
    };
  }

  async function fetchMessages(conversationId) {
    const auth = await getAuthentication();
    const base = CONFIG.conversationApi + encodeURIComponent(conversationId);
    const requests = [];
    const requestPage = async (url, label) => { requests.push({label,url}); return requestConversation(url,auth); };
    const newer = await requestPage(`${base}?num_turns=${CONFIG.numTurns}&include_has_versions=true`,'newer');
    const firstCursor = newer?.page_info?.start_cursor;
    if (typeof firstCursor !== 'string' || !firstCursor) throw new Error('第一阶段响应缺少 page_info.start_cursor。');
    const olderPages=[]; const seenCursors=new Set([firstCursor]); let cursor=firstCursor;
    const readBoundaryInfo = response => {
      const continuation = response?.context_truncation_continuation;
      const nestedId = continuation?.boundary_message_id;
      const legacyId = response?.boundary_message_id;
      const id = typeof nestedId === 'string' ? nestedId : typeof legacyId === 'string' ? legacyId : null;
      if (!id) return null;
      return {
        messageId: id,
        source: typeof nestedId === 'string' ? 'context_truncation_continuation.boundary_message_id' : 'boundary_message_id',
        sourceConversationId: continuation?.source_conversation_id ?? null,
        sourceConversationTitle: continuation?.source_conversation_title ?? null,
        visibleFromMessageId: continuation?.visible_from_message_id ?? null
      };
    };
    let boundaryInfo = readBoundaryInfo(newer);
    let boundaryMessageId = boundaryInfo?.messageId ?? null;
    let boundaryReached=false; let stopReason=null;
    for(let i=0;i<CONFIG.maxPaginationPages;i++){
      const url=`${base}/messages?before=${encodeURIComponent(cursor)}&num_turns=${CONFIG.numTurns}&include_has_versions=true`;
      const page=await requestPage(url,`older-${i+1}`); olderPages.push(page);
      if(!boundaryInfo) boundaryInfo = readBoundaryInfo(page);
      if(!boundaryMessageId && boundaryInfo) boundaryMessageId = boundaryInfo.messageId;
      const pageStart=page?.page_info?.start_cursor??null;
      const ids=new Set(page.messages.map(m=>m?.id).filter(id=>typeof id==='string'));
      if(boundaryMessageId&&(ids.has(boundaryMessageId)||pageStart===boundaryMessageId)){
        boundaryReached=true; stopReason=ids.has(boundaryMessageId)?'boundary-message-in-response':'page-start-cursor-equals-boundary'; break;
      }
      if(page?.page_info?.has_previous_page===false){stopReason='has_previous_page-false';break;}
      if(typeof pageStart!=='string'||!pageStart){stopReason='missing-start-cursor';warn('历史分页响应缺少 start_cursor，已停止继续请求。');break;}
      if(seenCursors.has(pageStart)){stopReason='repeated-start-cursor';warn('历史分页返回重复 start_cursor，已停止继续请求。');break;}
      seenCursors.add(pageStart);cursor=pageStart;
      if(i===CONFIG.maxPaginationPages-1){stopReason='max-pagination-pages-reached';warn(`历史分页达到安全上限 ${CONFIG.maxPaginationPages} 页。`);}
    }
    const summarizePage=page=>({messageCount:page.messages.length,
      boundaryMessageId:readBoundaryInfo(page)?.messageId??null,
      boundarySource:readBoundaryInfo(page)?.source??null,
      pageInfo:{startCursor:page.page_info?.start_cursor??null,endCursor:page.page_info?.end_cursor??null,
      hasPreviousPage:page.page_info?.has_previous_page??null,hasNextPage:page.page_info?.has_next_page??null},
      messages:page.messages.map(summarizeApiMessage)});
    const orderedPages=[...olderPages].reverse().concat(newer); const merged=[]; const seenIds=new Set();
    let duplicateCount=0,missingIdCount=0;
    for(const page of orderedPages) for(const message of page.messages){
      if(!message||typeof message!=='object')continue; const id=typeof message.id==='string'?message.id:null;
      if(id&&seenIds.has(id)){duplicateCount++;continue;} if(id)seenIds.add(id);else missingIdCount++; merged.push(message);
    }
    const newestInfo=newer.page_info||{}; const oldestInfo=olderPages.length?olderPages[olderPages.length-1].page_info||{}:{};
    const terminalPage=olderPages.length?olderPages[olderPages.length-1]:null;
    let boundarySource=boundaryInfo?.source??(boundaryMessageId?'response.boundary_message_id':null);
    if(!boundaryMessageId&&terminalPage?.page_info?.has_previous_page===false){
      const start=terminalPage.page_info?.start_cursor;
      const end=terminalPage.page_info?.end_cursor;
      if(typeof start==='string'&&start&&start===end){
        boundaryMessageId=start;
        boundarySource='terminal-page.start_cursor=end_cursor';
      }
    }
    const boundaryMessagePresent=Boolean(boundaryMessageId&&merged.some(message=>message.id===boundaryMessageId));
    const filteredMessages=boundaryMessageId
      ? merged.filter(message=>message.id!==boundaryMessageId)
      : merged;
    const hasUnfetchedPages=['max-pagination-pages-reached','missing-start-cursor','repeated-start-cursor'].includes(stopReason)||
      (!boundaryReached&&oldestInfo.has_previous_page===true);
    diagnostics.api={newerMessageCount:newer.messages.length,olderMessageCount:olderPages.reduce((n,p)=>n+p.messages.length,0),
      requestPageCount:requests.length,requests,pages:{newer:summarizePage(newer),older:olderPages.map(summarizePage)},
      mergedMessageCount:merged.length,exportableMessageCount:filteredMessages.length,
      duplicateCount,missingIdCount,responseOrder:['最旧历史页到较新历史页','第一阶段新消息 response'],
      boundary:{
        boundaryMessageId,boundarySource,reached:boundaryReached,stopReason,boundaryMessagePresent,
        excludedBoundaryMessageCount:merged.length-filteredMessages.length,
        sourceConversationId:boundaryInfo?.sourceConversationId??null,
        sourceConversationTitle:boundaryInfo?.sourceConversationTitle??null,
        visibleFromMessageId:boundaryInfo?.visibleFromMessageId??null
      },
      pagination:{newerPage:{hasPreviousPage:newestInfo.has_previous_page??null,hasNextPage:newestInfo.has_next_page??null},
      oldestFetchedPage:{hasPreviousPage:oldestInfo.has_previous_page??null,hasNextPage:oldestInfo.has_next_page??null},fetchedOlderPageCount:olderPages.length},
      hasUnfetchedPages};
    if(missingIdCount)warn(`${missingIdCount} 条消息缺少 ID，无法精确匹配 DOM。`);
    if(!boundaryMessageId)warn('响应未提供 boundary_message_id，且无法从终止页游标推导边界 ID。');
    else if(boundarySource==='context_truncation_continuation.boundary_message_id')
      warn('已读取 context_truncation_continuation 中的上下文截断边界消息，并从当前会话导出候选中排除该消息。');
    else if(boundarySource!=='boundary_message_id')
      warn('未提供 boundary_message_id；已根据 has_previous_page=false 且 start_cursor=end_cursor 推导边界消息，并从导出候选中排除该边界消息。');
    return filteredMessages;
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
    // 新版 ChatGPT 的 data-chatgpt-search-unit-key 是最明确的消息边界，
    // 优先使用它，避免把隐藏的“你说/ChatGPT 说”标签误判为消息正文节点。
    const keyed = [
      ...(anchor.matches?.('[data-chatgpt-search-unit-key]') ? [anchor] : []),
      ...anchor.querySelectorAll('[data-chatgpt-search-unit-key]')
    ].find(element => normalizedRole(element) === role);
    if (keyed) return keyed;

    const ownRole = normalizedRole(anchor);
    if (ownRole === role && !anchor.matches('[data-conversation-role]')) return anchor;
    const descendants = [...anchor.querySelectorAll(
      '[data-message-author-role],[data-role],[data-user-message-bubble="true"]'
    )];
    return descendants.find(element => normalizedRole(element) === role) || null;
  }

  function findDomMessage(item) {
    const messageId = item.message?.id;
    if (!messageId) return null;

    const keyedMatches = [...document.querySelectorAll('[data-chatgpt-search-unit-key]')]
      .filter(element => normalizedRole(element) === item.role)
      .filter(element => {
        let ancestor = element;
        for (let depth = 0; ancestor && depth < 10; depth++, ancestor = ancestor.parentElement) {
          if (idAttributeMatches(ancestor, messageId)) return true;
        }
        return false;
      });

    if (keyedMatches.length === 1) return { element: keyedMatches[0], matchSource: 'data-chatgpt-search-unit-key' };
    if (keyedMatches.length > 1) {
      return { error: 'duplicate-keyed-dom-match', matchCount: keyedMatches.length };
    }

    const anchors = [...document.querySelectorAll(
      '[data-message-id],[data-message-uuid],[data-chatgpt-selection-message-id],[data-chatgpt-search-message-ids],[data-turn-id]'
    )].filter(element => idAttributeMatches(element, messageId));
    const matches = [];
    for (const anchor of anchors) {
      const roleElement = findRoleElement(anchor, item.role);
      if (roleElement && !matches.includes(roleElement)) matches.push(roleElement);
    }
    if (matches.length !== 1) {
      return { error: matches.length > 1 ? 'duplicate-dom-match' : 'not-found', matchCount: matches.length };
    }
    return { element: matches[0], matchSource: 'legacy-id-anchor' };
  }

  function getCloneRoot(roleElement, messageId, expectedRole) {
    // data-chatgpt-search-unit-key 本身就是当前页面中最精确的单条消息容器。
    if (roleElement.matches?.('[data-chatgpt-search-unit-key]') &&
        normalizedRole(roleElement) === expectedRole) {
      return roleElement;
    }
    return roleElement;
  }

  function validateMessageCloneRoot(root, roleElement, messageId, expectedRole) {
    const keyedRoot = root.matches?.('[data-chatgpt-search-unit-key]');
    const keyedRole = normalizedRole(root);
    const keyedIdMatch = keyedRoot && idAttributeMatches(root, messageId);
    if (keyedRoot) {
      const nestedUnits = root.querySelectorAll('[data-chatgpt-search-unit-key]');
      return {
        valid: keyedRole === expectedRole && keyedIdMatch &&
          root === roleElement && nestedUnits.length === 0,
        roleNodeCount: 1 + nestedUnits.length,
        actualRole: keyedRole,
        messageIdAnchorFound: keyedIdMatch,
        validationMode: 'keyed-message-unit'
      };
    }

    // 旧版 DOM 的兼容回退：忽略 data-conversation-role 隐藏说话人标签，
    // 仅统计真正承载消息正文的 role 节点。
    const roleSelector = '[data-message-author-role],[data-role],[data-user-message-bubble="true"]';
    const roleNodes = [
      ...(root.matches(roleSelector) ? [root] : []),
      ...root.querySelectorAll(roleSelector)
    ].filter(node => normalizedRole(node));
    const uniqueRoleNodes = [...new Set(roleNodes)];
    return {
      valid: uniqueRoleNodes.length === 1 && uniqueRoleNodes[0] === roleElement &&
        normalizedRole(uniqueRoleNodes[0]) === expectedRole && root.contains(roleElement),
      roleNodeCount: uniqueRoleNodes.length,
      actualRole: uniqueRoleNodes.length === 1 ? normalizedRole(uniqueRoleNodes[0]) : null,
      messageIdAnchorFound: idAttributeMatches(root, messageId),
      validationMode: 'legacy-role-node'
    };
  }

  function describeMermaidState(root, stage, context = {}) {
    const containers = [];
    if (root instanceof Element && root.matches('[data-chatgpt-mermaid-preview]')) {
      containers.push(root);
    }
    if (root?.querySelectorAll) {
      containers.push(...root.querySelectorAll('[data-chatgpt-mermaid-preview]'));
    }
    return {
      type: 'MERMAID_DIAGNOSTIC',
      stage,
      timestamp: new Date().toISOString(),
      ...context,
      containerCount: containers.length,
      containers: containers.map((container, index) => {
        const svgs = [...container.querySelectorAll('svg')];
        const loadingIndicators = [...container.querySelectorAll('[data-loading-indicator], [aria-label*="加载"]')];
        return {
          index: index + 1,
          renderStatus: container.getAttribute('data-mermaid-render-status'),
          svgCount: svgs.length,
          svgs: svgs.map(svg => ({
            id: svg.id || null,
            width: svg.getAttribute('width'),
            height: svg.getAttribute('height'),
            viewBox: svg.getAttribute('viewBox'),
            ariaRoleDescription: svg.getAttribute('aria-roledescription'),
            outerHTMLLength: svg.outerHTML.length
          })),
          loadingIndicatorCount: loadingIndicators.length,
          hasLoadingIndicator: loadingIndicators.length > 0
        };
      })
    };
  }

  function recordMermaidState(root, stage, context = {}) {
    const snapshot = describeMermaidState(root, stage, context);
    diagnostics.mermaid.events.push(snapshot);
    return snapshot;
  }

  function removeVirtualizationArtifacts(root) {
    // Only reset the actual virtualized-turn wrapper. Descendant components may
    // use height/min-height/overflow as intentional layout (e.g. progress bars).
    const nodes = [];
    if (root instanceof HTMLElement && root.hasAttribute('data-virtualized-turn')) {
      nodes.push(root);
    }
    nodes.push(...root.querySelectorAll('[data-virtualized-turn]'));

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
      node.style.setProperty('height', 'auto', 'important');
      node.style.setProperty('min-height', '0', 'important');
      node.style.setProperty('max-height', 'none', 'important');
      node.style.setProperty('margin-top', '0', 'important');
      node.style.setProperty('contain', 'none', 'important');
      node.style.setProperty('overflow', 'visible', 'important');
      node.style.setProperty('content-visibility', 'visible', 'important');
    }
  }

  function describeCodeNode(element) {
    const style = getComputedStyle(element);
    const attributes = {};
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith('data-')) attributes[attribute.name] = attribute.value.slice(0, 120);
    }
    return {
      tag: element.tagName.toLowerCase(),
      className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
      testId: element.getAttribute('data-testid'),
      attributes,
      height: style.height,
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
      overflowX: style.overflowX,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollTop: element.scrollTop
    };
  }

  function expandNativeCodeContainers(sourceRoot, cloneRoot) {
    const sourceNodes = [sourceRoot, ...sourceRoot.querySelectorAll('*')];
    const cloneNodes = [cloneRoot, ...cloneRoot.querySelectorAll('*')];
    const diagnosticsForBlocks = [];
    const codeBlocks = [...sourceRoot.querySelectorAll('pre')].slice(0, 20);
    let overriddenNodeCount = 0;
    let codeSurfaceCount = 0;

    for (const [blockIndex, pre] of codeBlocks.entries()) {
      const preIndex = sourceNodes.indexOf(pre);
      const chain = [];
      let current = pre;
      while (current && sourceRoot.contains(current)) {
        chain.push(current);
        if (current === sourceRoot) break;
        current = current.parentElement;
      }
      const ancestors = [];
      for (const sourceNode of chain) {
        const sourceIndex = sourceNodes.indexOf(sourceNode);
        const cloneNode = cloneNodes[sourceIndex];
        if (!(sourceNode instanceof HTMLElement) || !(cloneNode instanceof HTMLElement)) continue;
        const before = describeCodeNode(sourceNode);
        const maxHeightLimited = before.maxHeight !== 'none' &&
          Number.parseFloat(before.maxHeight) > 0;
        const verticallyScrollable = ['auto', 'scroll', 'overlay'].includes(before.overflowY);
        const verticallyClipped = ['hidden', 'clip'].includes(before.overflowY);
        const horizontallyClipped = ['hidden', 'clip'].includes(before.overflowX);
        const internallyOverflowing = sourceNode.scrollHeight > sourceNode.clientHeight + 2;
        const isCodeSurface = sourceNode.matches('[data-code-block="true"]') ||
          (typeof sourceNode.className === 'string' && sourceNode.className.includes('CodeSurface-'));
        const shouldExpand = maxHeightLimited || verticallyScrollable ||
          verticallyClipped || horizontallyClipped || internallyOverflowing || isCodeSurface;
        let changed = false;
        if (shouldExpand) {
          cloneNode.style.setProperty('max-height', 'none', 'important');
          cloneNode.style.setProperty('height', 'auto', 'important');
          cloneNode.style.setProperty('min-height', '0', 'important');
          cloneNode.style.setProperty('overflow', isCodeSurface ? 'clip' : 'visible', 'important');
          cloneNode.style.setProperty('contain', 'none', 'important');
          changed = true;
          overriddenNodeCount++;
          if (isCodeSurface) codeSurfaceCount++;
        }
        ancestors.push({
          before,
          isCodeSurface,
          overridden: changed,
          after: changed ? {
            maxHeight: cloneNode.style.getPropertyValue('max-height'),
            height: cloneNode.style.getPropertyValue('height'),
            overflow: cloneNode.style.getPropertyValue('overflow'),
            contain: cloneNode.style.getPropertyValue('contain'),
            priority: cloneNode.style.getPropertyPriority('overflow')
          } : null
        });
      }
      diagnosticsForBlocks.push({
        index: blockIndex,
        sourcePathDepth: chain.length,
        sourcePre: describeCodeNode(pre),
        clonePre: preIndex >= 0 && cloneNodes[preIndex] ? describeCodeNode(cloneNodes[preIndex]) : null,
        ancestors
      });
    }
    return {
      codeBlockCount: sourceRoot.querySelectorAll('pre').length,
      diagnosedBlockCount: diagnosticsForBlocks.length,
      overriddenNodeCount,
      codeSurfaceCount,
      blocks: diagnosticsForBlocks
    };
  }
  function removeNonContentControls(root) {
    // Remove only the Writing Block header's right-side action toolbar.
    // Preserve the header, its title, the surrounding surface, and the block content.
    root.querySelectorAll('[data-oai-writing-block-surface] header > div').forEach(node => {
      const classes = node.classList;
      if (
        classes.contains('flex') &&
        classes.contains('flex-[0_0_auto]') &&
        classes.contains('items-center') &&
        classes.contains('gap-[var(--oai-wb-spacing)]')
      ) {
        node.remove();
      }
    });
    root.querySelectorAll('[data-chatgpt-mermaid-preview] [data-block-actions="true"]').forEach(node => {
      node.remove();
    });
    root.querySelectorAll(
      '[data-testid*="action-bar"],[role="toolbar"],.sr-only'
    ).forEach(node => {
      if (node.closest('pre,code,[data-testid*="code"],[class*="code-block"]')) return;
      node.remove();
    });
    root.querySelectorAll('[data-testid*="copy-button"]').forEach(node => {
      if (!node.closest('pre,code,[data-testid*="code"],[class*="code-block"]')) node.remove();
    });
    root.querySelectorAll('[data-code-block-controls="true"]').forEach(node => {
      const wrapper = node.closest('div.ms-auto.flex.items-center.min-w-0.max-w-full');
      if (wrapper) wrapper.remove();
      else node.remove();
    });
    root.querySelectorAll('div.flex.flex-row-reverse.items-center.gap-1').forEach(node => {
      node.remove();
    });
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


  function getVirtualizedIdentitySnapshot() {
    const ids = [], seen = new Set();
    const nodes = [...document.querySelectorAll('[data-chatgpt-search-unit-key],[data-message-id],[data-message-uuid],[data-chatgpt-selection-message-id],[data-chatgpt-search-message-ids],[data-turn-key],[data-turn-id]')];
    for (const node of nodes) {
      let current = node;
      for (let depth = 0; current && depth < 9; depth++, current = current.parentElement) {
        for (const name of ['data-message-id','data-message-uuid','data-chatgpt-selection-message-id','data-chatgpt-search-message-ids','data-turn-key','data-turn-id']) {
          const raw = current.getAttribute?.(name);
          if (!raw) continue;
          const values = name === 'data-chatgpt-search-message-ids' ? raw.split(/[\s,]+/).filter(Boolean) : [raw];
          for (const id of values) if (!seen.has(id)) { seen.add(id); ids.push(id); }
        }
      }
    }
    const turns = [...document.querySelectorAll('[data-virtualized-turn]')].map(node => ({
      testId: node.getAttribute('data-testid') || '', textLength: (node.innerText || '').length
    }));
    return { ids, turns, signature: ids.join('|') + '::' + turns.map(x => x.testId + ':' + x.textLength).join('|') };
  }

  function getVirtualizedSignature() {
    return getVirtualizedIdentitySnapshot().signature;
  }

  function waitForVirtualizedUpdate(previousSignature, timeout = 3500,
      minimumDelay = CONFIG.defaultScrollDelay, observedRoot = document.documentElement, signal = state.abortController?.signal) {
    return new Promise(resolve => {
      const startedAt = performance.now();
      let finished = false, mutationDetected = false, stableDetected = false;
      let latestSignature = getVirtualizedSignature();
      let minimumTimer = null, stableTimer = null, hardTimeoutTimer = null, completionPoll = null;
      const onAbort = () => finish('cancelled');
      const finish = finishReason => {
        if (finished) return;
        finished = true; observer.disconnect();
        clearTimeout(minimumTimer); clearTimeout(stableTimer); clearTimeout(hardTimeoutTimer); clearInterval(completionPoll);
        signal?.removeEventListener('abort', onAbort);
        resolve({ changed: getVirtualizedSignature() !== previousSignature, identitySnapshot: getVirtualizedIdentitySnapshot(),
          waitedMs: Math.round(performance.now()-startedAt), configuredMinimumDelayMs: minimumDelay,
          mutationDetected, stableDetected, finishReason, fallbackWaitMs: null });
      };
      const checkStable = () => {
        clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          if (getVirtualizedSignature() !== previousSignature) {
            stableDetected = true;
            if (performance.now()-startedAt >= minimumDelay) finish('identity-dom-stable');
          }
        }, 350);
      };
      const observer = new MutationObserver(() => {
        const signature = getVirtualizedSignature();
        if (signature === latestSignature) return;
        latestSignature = signature; mutationDetected = signature !== previousSignature;
        if (mutationDetected) checkStable();
      });
      if (signal?.aborted) { finish('cancelled'); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        observer.observe(observedRoot || document.documentElement, {childList:true,subtree:true,characterData:true,attributes:true,
          attributeFilter:['data-message-id','data-message-uuid','data-chatgpt-selection-message-id','data-chatgpt-search-message-ids','data-chatgpt-search-unit-key','data-turn-key','data-turn-id']});
      } catch { observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true}); }
      minimumTimer = setTimeout(() => {
        const signature = getVirtualizedSignature();
        if (signature !== previousSignature) { mutationDetected = true; latestSignature = signature; checkStable(); }
      }, minimumDelay);
      hardTimeoutTimer = setTimeout(() => finish('identity-wait-timeout'), Math.max(timeout,minimumDelay+1500));
      completionPoll = setInterval(() => {
        if (!finished && stableDetected && performance.now()-startedAt >= minimumDelay) finish('identity-dom-stable');
      },50);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const signature = getVirtualizedSignature();
        if (signature !== previousSignature) { mutationDetected = true; latestSignature = signature; checkStable(); }
      }));
    });
  }

  function collectVisibleDomMessageIds(target) {
    const roleNodes = [...document.querySelectorAll(
      ROLE_SELECTORS + ',[data-user-message-bubble="true"],[data-chatgpt-search-unit-key]'
    )];
    for (const roleElement of roleNodes) {
      const role = normalizedRole(roleElement);
      if (!role) continue;
      let current = roleElement;
      for (let depth = 0; current && depth < 9; depth++, current = current.parentElement) {
        for (const name of ID_ATTRIBUTES) {
          const value = current.getAttribute(name);
          if (!value) continue;
          const values = name === 'data-chatgpt-search-message-ids'
            ? value.split(/[\\s,]+/).filter(Boolean) : [value];
          for (const id of values) {
            if (!target.has(id)) target.set(id, { id, role, attribute: name });
          }
        }
      }
    }
  }

  const MERMAID_RENDER_TIMEOUT_MS = 15000;

  function getMermaidRenderStates(root) {
    const containers = [];
    if (root instanceof Element && root.matches('[data-chatgpt-mermaid-preview]')) containers.push(root);
    if (root?.querySelectorAll) containers.push(...root.querySelectorAll('[data-chatgpt-mermaid-preview]'));
    return containers.map((container, index) => {
      const svgs = [...container.querySelectorAll('svg[id^="chatgpt-mermaid-"], svg[aria-roledescription]')];
      const loadingIndicators = [...container.querySelectorAll('[data-loading-indicator], [aria-label*="加载"]')];
      return {
        index: index + 1,
        renderStatus: container.getAttribute('data-mermaid-render-status'),
        svgCount: svgs.length,
        svgs: svgs.map(svg => ({
          id: svg.id || null, width: svg.getAttribute('width'),
          height: svg.getAttribute('height'), viewBox: svg.getAttribute('viewBox'),
          ariaRoleDescription: svg.getAttribute('aria-roledescription'),
          outerHTMLLength: svg.outerHTML.length
        })),
        loadingIndicatorCount: loadingIndicators.length,
        hasLoadingIndicator: loadingIndicators.length > 0,
        complete: svgs.length > 0 && loadingIndicators.length === 0
      };
    });
  }

  function waitForMermaidRender(root, context = {}, timeoutMs = MERMAID_RENDER_TIMEOUT_MS, signal = state.abortController?.signal) {
    const startedAt = performance.now();
    const initialStates = getMermaidRenderStates(root);
    if (!initialStates.length || initialStates.every(item => item.complete)) {
      const result = {
        status: initialStates.length ? 'already-rendered' : 'not-present',
        elapsedMs: 0, timeoutMs, containerCount: initialStates.length, containers: initialStates
      };
      recordMermaidState(root, 'wait-before-clone-complete', { ...context, ...result });
      return Promise.resolve(result);
    }

    recordMermaidState(root, 'wait-before-clone-start', {
      ...context, timeoutMs, containers: initialStates
    });

    return new Promise(resolve => {
      let settled = false;
      let observer = null;
      let timeoutId = null;
      const onAbort = () => finish(true, getMermaidRenderStates(root), 'cancelled');
      const finish = (timedOut, states, forcedStatus = null) => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        if (timeoutId !== null) clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
        const result = {
          status: forcedStatus || (timedOut ? 'timeout' : 'rendered'),
          elapsedMs: Math.round(performance.now() - startedAt),
          timeoutMs, containerCount: states.length,
          incompleteContainerCount: states.filter(item => !item.complete).length,
          containers: states
        };
        diagnostics.mermaid.waitResults ||= [];
        diagnostics.mermaid.waitResults.push({ ...context, ...result });
        recordMermaidState(root, timedOut ? 'wait-before-clone-timeout' : 'wait-before-clone-complete', {
          ...context, ...result
        });
        resolve(result);
      };
      const check = () => {
        const states = getMermaidRenderStates(root);
        if (!states.length || states.every(item => item.complete)) finish(false, states);
      };
      if (signal?.aborted) { finish(true, initialStates, 'cancelled'); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        observer = new MutationObserver(check);
        observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      } catch (error) {
        diagnostics.errors.push({
          stage: 'mermaid-render-observer', message: error?.message || String(error), ...context
        });
      }
      timeoutId = setTimeout(() => finish(true, getMermaidRenderStates(root)), timeoutMs);
      check();
    });
  }

  async function captureVisibleMessages(selected, captured, duplicates, observedDom) {
    collectVisibleDomMessageIds(observedDom);
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
      const sourceRoot = getCloneRoot(result.element, messageId, item.role);
      const rootValidation = validateMessageCloneRoot(
        sourceRoot, result.element, messageId, item.role
      );
      if (!rootValidation.valid) {
        duplicates.set(messageId, {
          index, messageId, role: item.role,
          error: 'clone-root-validation-failed',
          ...rootValidation
        });
        continue;
      }
      throwIfStopped();
      const mermaidWait = await waitForMermaidRender(sourceRoot, {
        messageIndex: index + 1, messageId, role: item.role
      }, MERMAID_RENDER_TIMEOUT_MS, state.abortController?.signal);
      throwIfStopped();
      recordMermaidState(sourceRoot, 'source-before-clone', {
        messageIndex: index + 1, messageId, role: item.role,
        mermaidWaitStatus: mermaidWait.status,
        mermaidWaitElapsedMs: mermaidWait.elapsedMs
      });
      const clone = sourceRoot.cloneNode(true);
      recordMermaidState(clone, 'clone-immediately-after-clone', {
        messageIndex: index + 1, messageId, role: item.role
      });
      removeVirtualizationArtifacts(clone);
      const codeDiagnostics = expandNativeCodeContainers(sourceRoot, clone);
      removeNonContentControls(clone);
      recordMermaidState(clone, 'clone-after-export-cleanup', {
        messageIndex: index + 1, messageId, role: item.role
      });
      const wrapper = document.createElement('section');
      wrapper.className = 'export-message';
      wrapper.dataset.messageIndex = String(index + 1);
      wrapper.dataset.messageId = messageId;
      wrapper.dataset.role = item.role;
      wrapper.appendChild(clone);
      captured.set(messageId, { index, messageId, role: item.role, source: sourceRoot, clone: wrapper, codeDiagnostics });
      newlyCaptured++;
    }
    return newlyCaptured;
  }

  async function cloneNativeMessages(selected) {
    const discovery = diagnoseDom(selected);
    const scrollDelay = getScrollDelay();
    const captured = new Map();
    const duplicates = new Map();
    const observedDom = new Map();
    const traversal = {
      startedAt: new Date().toISOString(),
      strategy: 'preheat-top-bottom-top-then-forward-scan',
      preheat: { enabled: true, stepSize: null, mutationWaitTimeoutMs: 3500, identityDriven: true, directions: [] },
      container: null, initialScrollTop: null, finalScrollTop: null,
      maxScrollTop: null, stepSize: null, stepCount: 0,
      mutationWaitTimeoutMs: 3500, fallbackWaitMs: null, configuredMinimumDelayMs: scrollDelay,
      capturedPerStep: [], initialTopWait: null, codeBlocks: [],
      reachedTop: false, reachedBottom: false,
      restoredOriginalScrollTop: false, failure: null
    };
    traversal.mermaidWaitTimeoutMs = MERMAID_RENDER_TIMEOUT_MS;
    const found = findConversationScrollContainer();
    const scrollElement = found.element;
    state.currentTraversal = traversal;
    state.currentScrollElement = scrollElement;
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
        // Preheat both scroll directions before capturing any message snapshots.
        // This gives lazy-loaded content (including Mermaid) a chance to initialize.
        const preheatStepSize = traversal.stepSize;
        traversal.preheat.stepSize = preheatStepSize;

        const moveAndWait = async (direction, requestedTop, stepNumber) => {
          throwIfStopped();
          const beforeTop = scrollElement.scrollTop;
          const beforeMax = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
          const beforeSignature = getVirtualizedSignature();
          const beforeIds = [...document.querySelectorAll('[data-virtualized-turn]')].map(n => (n.innerText || '').slice(0,100));
          const moveStartedAt = new Date().toISOString();
          scrollElement.scrollTop = requestedTop;
          const waitResult = await waitForVirtualizedUpdate(
            beforeSignature, traversal.preheat.mutationWaitTimeoutMs, scrollDelay, scrollElement
          );
          throwIfStopped();
          const afterSignature = getVirtualizedSignature();
          const afterIds = [...document.querySelectorAll('[data-virtualized-turn]')].map(n => (n.innerText || '').slice(0,100));
          const entry = {
            step: stepNumber, timestamp: moveStartedAt, direction,
            beforeScrollTop: Math.round(beforeTop), beforeMaxScrollTop: Math.round(beforeMax),
            beforeSignature, afterSignature, beforeVisibleTurnFingerprints: beforeIds, afterVisibleTurnFingerprints: afterIds,
            requestedScrollTop: Math.round(requestedTop),
            actualScrollTop: Math.round(scrollElement.scrollTop),
            maxScrollTop: Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
            virtualizedTurnCount: document.querySelectorAll('[data-virtualized-turn]').length,
            waitResult
          };
          traversal.preheat.directions.at(-1).steps.push(entry);
          traversal.preheat.recentTrace ||= [];
          traversal.preheat.recentTrace.push({
            timestamp: moveStartedAt, direction, before: Math.round(beforeTop),
            requested: Math.round(requestedTop), actual: entry.actualScrollTop,
            maxBefore: Math.round(beforeMax), maxAfter: entry.maxScrollTop,
            beforeSignature, afterSignature, wait: waitResult.finishReason
          });
          if (traversal.preheat.recentTrace.length > 60) traversal.preheat.recentTrace.shift();
          return entry;
        };

        // Traverse using live scroll coordinates. Virtualized lists can change
        // their scroll range and the browser may adjust scrollTop after each render.
        const preheatTraverse = async (direction, label) => {
          const isUp = direction === 'up';
          const phase = traversal.preheat.directions.at(-1);
          let noProgressCount = 0, stepCount = 0;
          const repeatedTransitions = new Map(), seenIdentityIds = new Set();
          const selectedRank = new Map(selected.map((item,index) => [item.message.id,index]));
          let earliestSelectedRank = Number.POSITIVE_INFINITY, lastIdentitySequence = '', repeatedIdentitySequenceCount = 0;
          const maxSteps = 800, maxNoProgress = 4;

          while (stepCount < maxSteps) {
            throwIfStopped(); traversal.preheat.currentStage = label;
            const currentTop = Math.max(0, scrollElement.scrollTop);
            const currentMax = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
            const atBoundary = isUp ? currentTop <= 2 : currentTop >= currentMax - 2;
            if (atBoundary) {
              phase.reachedBoundary = true;
              phase.finalScrollTop = Math.round(currentTop);
              phase.finalMaxScrollTop = Math.round(currentMax);
              phase.noProgressCount = noProgressCount;
              return true;
            }

            const requestedTop = isUp
              ? Math.max(0, currentTop - preheatStepSize)
              : Math.min(currentMax, currentTop + preheatStepSize);
            const entry = await moveAndWait(direction, requestedTop, ++stepCount);
            throwIfStopped();
            const identity = getVirtualizedIdentitySnapshot();
            const newlyObservedIds = identity.ids.filter(id => !seenIdentityIds.has(id));
            identity.ids.forEach(id => seenIdentityIds.add(id));
            const ranks = identity.ids.map(id => selectedRank.get(id)).filter(Number.isInteger);
            const currentEarliestRank = ranks.length ? Math.min(...ranks) : Number.POSITIVE_INFINITY;
            const earlierSelectedMessageFound = isUp && currentEarliestRank < earliestSelectedRank;
            if (Number.isFinite(currentEarliestRank)) earliestSelectedRank = Math.min(earliestSelectedRank,currentEarliestRank);
            const identitySequence = identity.ids.join('|');
            repeatedIdentitySequenceCount = identitySequence && identitySequence === lastIdentitySequence ? repeatedIdentitySequenceCount+1 : 0;
            lastIdentitySequence = identitySequence;
            entry.identityProgress = {visibleIdentityCount:identity.ids.length,newlyObservedIdentityIds:newlyObservedIds.slice(0,80),
              newlyObservedIdentityCount:newlyObservedIds.length,earliestVisibleSelectedRank:Number.isFinite(currentEarliestRank)?currentEarliestRank:null,
              earlierSelectedMessageFound,repeatedIdentitySequenceCount};
            const actualTop = Math.max(0, scrollElement.scrollTop);
            const newMax = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
            const positionStalled = isUp ? actualTop >= currentTop - 1 : actualTop <= currentTop + 1;
            const transitionKey = [
              direction, identitySequence, Math.round(actualTop), Math.round(newMax),
              entry.waitResult.finishReason
            ].join('|');
            // 身份序列稳定是虚拟列表正常状态；只有实际滚动位置也停滞时才累计循环次数。
            const transitionCount = positionStalled
              ? (repeatedTransitions.get(transitionKey) || 0) + 1
              : 0;
            if (positionStalled) repeatedTransitions.set(transitionKey, transitionCount);
            entry.transitionRepeatCount = transitionCount;
            entry.positionStalled = positionStalled;
            if (positionStalled && transitionCount >= 3 &&
                repeatedIdentitySequenceCount >= 2 && newlyObservedIds.length === 0) {
              phase.relocationLoopDetected = true;
              phase.relocationLoop = {
                key: transitionKey, repeatCount: transitionCount,
                repeatedIdentitySequenceCount, identityCount: identity.ids.length,
                scrollTop: Math.round(actualTop), maxScrollTop: Math.round(newMax),
                detectedAt: new Date().toISOString()
              };
              throw new Error(`检测到分页加载引起的滚动重定位循环：方向 ${direction}，请求位置 ${Math.round(requestedTop)}，实际位置 ${Math.round(actualTop)}，最大滚动位置 ${Math.round(newMax)}，停滞重复 ${transitionCount} 次。`);
            }
            const progressed = isUp
              ? actualTop < currentTop - 1 || earlierSelectedMessageFound || newlyObservedIds.length > 0
              : actualTop > currentTop + 1 || newlyObservedIds.length > 0;

            entry.beforeScrollTop = Math.round(currentTop);
            entry.beforeMaxScrollTop = Math.round(currentMax);
            entry.actualMaxScrollTop = Math.round(newMax);
            entry.progressed = progressed;

            const nowAtBoundary = isUp ? actualTop <= 2 : actualTop >= newMax - 2;
            if (nowAtBoundary) {
              phase.reachedBoundary = true;
              phase.finalScrollTop = Math.round(actualTop);
              phase.finalMaxScrollTop = Math.round(newMax);
              phase.noProgressCount = noProgressCount;
              return true;
            }

            if (progressed) {
              noProgressCount = 0;
            } else {
              noProgressCount++;
              entry.noProgressAttempt = noProgressCount;
              if (noProgressCount >= maxNoProgress) {
                throw new Error(
                  `预热${isUp ? '向上' : '向下'}滚动连续 ${noProgressCount} 次未取得进展；` +
                  `当前位置 ${Math.round(actualTop)}，最大滚动位置 ${Math.round(newMax)}。`
                );
              }
              // Re-read live coordinates on the next iteration instead of
              // reusing a stale target from before the virtualized DOM update.
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          }

          throw new Error(`预热${label}超过安全步数上限（${maxSteps}）。`);
        };

        // Phase 1: incrementally reach the top from the current position.
        setStatus('预热页面（1/3）：正在逐步滚动到顶部…');
        traversal.preheat.directions.push({ direction: 'up-to-top', steps: [] });
        traversal.preheat.reachedTop = await preheatTraverse('up', '向上到顶部');

        // Phase 2: incrementally traverse to the bottom.
        setStatus('预热页面（2/3）：正在逐步向下滚动以触发内容渲染…');
        traversal.preheat.directions.push({ direction: 'down-to-bottom', steps: [] });
        traversal.preheat.reachedBottom = await preheatTraverse('down', '向下到底部');

        // Phase 3: return to the top using the same live-coordinate algorithm.
        setStatus('预热页面（3/3）：正在逐步向上滚动以完成渲染…');
        traversal.preheat.directions.push({ direction: 'bottom-to-top', steps: [] });
        traversal.preheat.reachedTop = await preheatTraverse('up', '返回顶部');
        if (scrollElement.scrollTop > 2) {
          throw new Error('预热向上滚动结束后未能确认返回顶部。');
        }
        traversal.preheat.completed = true;
        traversal.preheat.completedAt = new Date().toISOString();

        setStatus('页面预热完成，正在正式采集消息…');
        throwIfStopped();
        const topWaitSignature = getVirtualizedSignature();
        const topWaitStartedAt = performance.now();
        scrollElement.scrollTop = 0;
        traversal.initialTopWait = await waitForVirtualizedUpdate(
          topWaitSignature, traversal.mutationWaitTimeoutMs, scrollDelay, scrollElement
        );
        traversal.initialTopWait.elapsedFromStartMs = Math.round(performance.now() - topWaitStartedAt);
        traversal.initialCaptureCount = await captureVisibleMessages(selected, captured, duplicates, observedDom);
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
          const beforeSignature = getVirtualizedSignature();
          scrollElement.scrollTop = nextTop;
          const waitResult = await waitForVirtualizedUpdate(
            beforeSignature, traversal.mutationWaitTimeoutMs, scrollDelay, scrollElement
          );
          const capturedNow = await captureVisibleMessages(selected, captured, duplicates, observedDom);
          traversal.stepCount++;
          traversal.capturedPerStep.push({
            step: traversal.stepCount, requestedScrollTop: nextTop,
            actualScrollTop: scrollElement.scrollTop,
            maxScrollTop: Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
            virtualizedTurnCount: document.querySelectorAll('[data-virtualized-turn]').length,
            newlyCapturedMessageCount: capturedNow,
            totalCapturedMessageCount: captured.size,
            waitResult
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
        traversal.stopped = error?.name === 'AbortError' || state.stopRequested;
        traversal.stopDetectedAt = traversal.stopped ? new Date().toISOString() : null;
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
    traversal.codeBlocks = exported.flatMap(item =>
      item.codeDiagnostics.blocks.map(block => ({
        messageIndex: item.index + 1,
        role: item.role,
        ...block
      }))
    ).slice(0, 20);
    traversal.codeBlockDiagnosticLimit = 20;
    traversal.codeBlockCountTotal = exported.reduce(
      (total, item) => total + item.codeDiagnostics.codeBlockCount, 0
    );
    const missing = selected.map((item, index) => ({
      index, messageId: item.message?.id || null, role: item.role
    })).filter(item => item.messageId && !captured.has(item.messageId));
    diagnostics.dom = {
      discovery, traversal, expectedMessageCount: selected.length,
      matchedMessageCount: exported.length, missingMessageCount: missing.length,
      duplicateMessageCount: duplicates.size, missing,
      duplicate: [...duplicates.values()],
      observedDomMessageCount: observedDom.size,
      observedDomMessages: [...observedDom.values()].slice(0, 5000),
      apiSelectedIdsNotObservedInDom: selected
        .filter(item => item.message?.id && !observedDom.has(item.message.id))
        .map(item => ({ id: item.message.id, role: item.role })),
      observedDomIdsNotInApiSelection: [...observedDom.values()]
        .filter(item => !selected.some(selectedItem => selectedItem.message?.id === item.id))
        .slice(0, 5000),
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

  async function inlineExternalSvgSprites(exported) {
    const references = [];
    const spriteUrls = new Set();
    for (const item of exported) {
      for (const use of item.clone.querySelectorAll('svg use')) {
        const reference = use.getAttribute('href') ||
          use.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ||
          use.getAttribute('xlink:href');
        if (!reference) continue;
        let url;
        try { url = new URL(reference, location.href); } catch { continue; }
        if (!url.hash) continue;
        const spriteUrl = new URL(url.href);
        spriteUrl.hash = '';
        const key = spriteUrl.href;
        spriteUrls.add(key);
        references.push({ use, key, id: decodeURIComponent(url.hash.slice(1)) });
      }
    }
    if (!references.length) return '';
    const spriteDocuments = new Map();
    for (const url of spriteUrls) {
      const response = await fetch(url, {
        method: 'GET',
        credentials: new URL(url).origin === location.origin ? 'same-origin' : 'include',
        cache: 'force-cache'
      });
      if (!response.ok) throw new Error('下载 SVG 图标资源失败：HTTP ' + response.status + '，' + url);
      const parsed = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
      const root = parsed.documentElement;
      if (!root || root.localName !== 'svg' || parsed.querySelector('parsererror')) {
        throw new Error('SVG 图标资源格式无效：' + url);
      }
      spriteDocuments.set(url, root);
    }
    for (const reference of references) {
      const sprite = spriteDocuments.get(reference.key);
      if (!sprite || !sprite.querySelector('#' + CSS.escape(reference.id))) {
        throw new Error('SVG 雪碧图中缺少图标定义：' + reference.id);
      }
      reference.use.setAttribute('href', '#' + reference.id);
      reference.use.removeAttribute('xlink:href');
    }
    const embedded = [...spriteDocuments.values()].map(root =>
      '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" ' +
      'style="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none">' +
      root.innerHTML + '</svg>'
    ).join('\n');
    diagnostics.dom.inlinedSvgReferenceCount = references.length;
    diagnostics.dom.inlinedSvgSpriteCount = spriteDocuments.size;
    return embedded;
  }
  function buildDocument(exported, selected, conversationId, svgSpriteMarkup = '') {
    const styles = collectPageStyles();
    let copiedCustomPropertyCount = 0;
    for (const item of exported) copiedCustomPropertyCount += preserveElementVariables(item.source, item.clone.firstElementChild);

    const title = escapeHTML(document.title || 'ChatGPT 会话导出');
    const links = styles.externalLinks.map(href => `<link rel="stylesheet" href="${escapeHTML(href)}">`).join('\n');
    const rootVars = styles.rootProperties.join(';');
    const bodyVars = styles.bodyProperties.join(';');
    const messages = exported.map(item => item.clone.outerHTML).join('\n');
    const selectedById = new Map(selected.map(item => [item.message.id, item]));
    const navigationItems = exported.map(item => {
      const message = selectedById.get(item.messageId)?.message;
      const preview = (item.clone.innerText || item.clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      const timestamp = Number(message?.create_time);
      const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toLocaleString() : '';
      const roleLabel = item.role === 'user' ? '用户' : 'ChatGPT';
      const messageDomId = String(item.messageId).replace(/[^a-zA-Z0-9_-]/g, '-');
      return `<div class="nav-item" id="nav-message-${messageDomId}" role="button" tabindex="0" data-target="${escapeHTML(item.messageId)}" data-role="${escapeHTML(item.role)}">
        <input class="nav-check" id="nav-checkbox-${messageDomId}" type="checkbox" aria-label="选择${roleLabel}消息">
        <span class="nav-index">${item.index + 1}</span>
        <span class="nav-content"><span class="nav-meta"><strong>${roleLabel}</strong><time>${escapeHTML(date)}</time></span>
        <span class="nav-preview">${escapeHTML(preview || '（无文本内容）')}</span></span>
      </div>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="zh-CN" class="${escapeHTML(styles.rootClass)}" data-theme="${escapeHTML(styles.rootTheme)}">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>${links}
<style>
:root{${rootVars}}body{${bodyVars}}${styles.css}
html{min-height:100%;background:var(--main-surface-primary,#fff);scroll-behavior:smooth}
body{margin:0;padding:0;background:var(--main-surface-primary,#fff);color:var(--text-primary,#0d0d0d)}
.export-layout{display:flex;min-height:100vh;width:100%;align-items:stretch}
.export-sidebar{position:sticky;top:0;flex:0 0 340px;width:340px;height:100vh;box-sizing:border-box;display:flex;flex-direction:column;border-right:1px solid var(--border-light,rgba(0,0,0,.12));background:var(--main-surface-primary,#fff);z-index:20}
.sidebar-header{min-height:76px;box-sizing:border-box;padding:18px 16px 12px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border-light,rgba(0,0,0,.1))}
.sidebar-title{min-width:0;font-size:15px;font-weight:650;line-height:1.45;overflow-wrap:anywhere}.sidebar-subtitle{margin-top:5px;color:var(--text-secondary,#777);font-size:12px}
.sidebar-toggle,.sidebar-menu-button{width:34px;height:34px;flex:0 0 34px;border:0;border-radius:8px;background:transparent;color:var(--text-secondary,#666);font-size:20px;cursor:pointer}
.sidebar-toggle:hover,.sidebar-menu-button:hover{background:var(--background-surface-secondary,#f1f1f1)}
.sidebar-list{flex:1;min-height:0;overflow:auto;padding:8px 10px;overscroll-behavior:contain}
.nav-item{width:100%;display:flex;align-items:flex-start;gap:9px;padding:10px 8px;border:0;border-radius:9px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.nav-item:hover,.nav-item.active{background:var(--background-surface-secondary,#f1f1f1)}.nav-item.active{outline:1px solid var(--border-light,rgba(0,0,0,.1))}
.nav-check,.footer-check{appearance:auto!important;-webkit-appearance:checkbox!important;display:inline-block!important;visibility:visible!important;opacity:1!important;width:17px!important;height:17px!important;min-width:17px!important;min-height:17px!important;flex:0 0 17px;margin:3px 0 0;padding:0;border:1px solid #9ca3af!important;border-radius:3px!important;background:#fff!important;accent-color:#2563eb;cursor:pointer}
.nav-index{min-width:24px;padding:2px 5px;border-radius:12px;background:var(--background-surface-secondary,#eee);color:var(--text-secondary,#666);font-size:11px;font-weight:650;text-align:center}
.nav-content{min-width:0;flex:1}.nav-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;line-height:1.5}
.nav-meta strong{font-size:13px;font-weight:650}.nav-meta time{color:var(--text-tertiary,#999);font-size:10px;white-space:nowrap}
.nav-preview{display:-webkit-box;margin-top:4px;color:var(--text-secondary,#555);font-size:12px;line-height:1.55;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}
.sidebar-footer{height:56px;flex:0 0 56px;display:flex;align-items:center;gap:12px;padding:0 14px;border-top:1px solid var(--border-light,rgba(0,0,0,.12));background:var(--main-surface-primary,#fff)}
.footer-check{margin:0}.selected-count{padding:4px 10px;border-radius:16px;background:var(--background-surface-secondary,#eee);color:var(--text-secondary,#666);font-size:12px;font-weight:650}
.sidebar-footer-spacer{flex:1}.menu-wrap{position:relative}.sidebar-menu-button{font-size:22px;letter-spacing:1px}
.quick-menu{position:absolute;right:0;bottom:44px;width:190px;padding:7px;border:1px solid var(--border-light,rgba(0,0,0,.16));border-radius:10px;background:var(--main-surface-primary,#fff);box-shadow:0 8px 28px rgba(0,0,0,.18);display:none;z-index:30}
.quick-menu.open{display:block}.quick-menu button{width:100%;padding:10px 11px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;font:inherit;font-size:13px;cursor:pointer}
.quick-menu button:hover{background:var(--background-surface-secondary,#f1f1f1)}
.export-main{flex:1;min-width:0;box-sizing:border-box;padding:12mm}.export-page{width:100%;max-width:186mm;margin:0 auto;box-sizing:border-box}
.export-message{width:100%;min-width:0;margin:0 auto 28px;box-sizing:border-box;overflow:visible;scroll-margin-top:20px;border-radius:10px;transition:background-color .25s,outline-color .25s}
.export-message>*{width:100%;min-width:0;max-width:100%}.export-message.nav-highlight{outline:2px solid #3b82f6;outline-offset:8px;background:rgba(59,130,246,.035)}
.export-message [data-virtualized-turn]{height:auto!important;min-height:0!important;max-height:none!important;margin-top:0!important;contain:none!important;overflow:visible!important;content-visibility:visible!important}
.export-message pre,.export-message code,.export-message table{max-width:100%}
.export-message [data-code-block="true"],.export-message [class*="CodeSurface"]{height:auto!important;min-height:0!important;max-height:none!important;overflow:clip!important;contain:none!important}
.export-message [class*="InlineCodePane"],.export-message .chatgpt-code-scrollport{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;contain:none!important}
.export-message [data-code-block="true"] pre,.export-message [class*="CodeSurface"] pre{height:auto!important;max-height:none!important;overflow:visible!important}
.export-message img,.export-message video,.export-message svg{max-width:100%;height:auto}
.export-layout.sidebar-collapsed .export-sidebar{display:none}.export-layout.sidebar-collapsed .export-main{padding-left:12mm}
@media(max-width:760px){.export-sidebar{flex-basis:300px;width:300px}.export-main{padding:20px 14px}.export-layout.sidebar-collapsed .export-main{padding:20px 14px}}
@media print{.export-sidebar{display:none!important}.export-main{padding:0}.export-page{max-width:none}.export-message{break-inside:auto}pre,table,blockquote{break-inside:avoid}}
@page{size:A4;margin:12mm}
</style></head>
<body>
${svgSpriteMarkup}
<div class="export-layout" id="export-layout">
<aside class="export-sidebar" id="conversation-navigation-panel" aria-label="会话消息导航">
<header class="sidebar-header"><div style="min-width:0"><div class="sidebar-title" id="conversation-navigation-title">${title}</div><div class="sidebar-subtitle" id="conversation-navigation-summary">chatgpt.com · ${exported.length} 条消息</div></div>
<button class="sidebar-toggle" id="collapse-navigation-panel" type="button" title="收缩左侧面板" aria-label="收缩左侧面板">◧</button></header>
<nav class="sidebar-list" id="conversation-message-list">${navigationItems}</nav>
<footer class="sidebar-footer"><input class="footer-check" id="select-all-messages" type="checkbox" aria-label="全选消息">
<span class="selected-count" id="selected-message-count">0/${exported.length}</span><span class="sidebar-footer-spacer"></span>
<div class="menu-wrap"><button class="sidebar-menu-button" id="message-selection-menu-button" type="button" aria-label="快速选择" title="快速选择">···</button>
<div class="quick-menu" id="message-selection-menu"><button id="clear-message-selection" type="button" data-action="clear">清空</button><button id="select-user-questions" type="button" data-action="questions">只选问题</button><button id="select-assistant-answers" type="button" data-action="answers">只选回答</button></div></div></footer></aside>
<button class="sidebar-toggle" id="expand-navigation-panel" type="button" title="展开左侧面板" aria-label="展开左侧面板" style="display:none;position:fixed;top:16px;left:12px;z-index:40;background:var(--main-surface-primary,#fff);border:1px solid var(--border-light,rgba(0,0,0,.16));box-shadow:0 2px 8px rgba(0,0,0,.12)">◧</button>
<main class="export-main"><div class="export-page" data-conversation-id="${escapeHTML(conversationId)}">${messages}</div></main></div>
<script>
(() => {
const layout=document.getElementById('export-layout'),collapse=document.getElementById('collapse-navigation-panel'),expand=document.getElementById('expand-navigation-panel');
const list=document.getElementById('conversation-message-list'),menuButton=document.getElementById('message-selection-menu-button'),menu=document.getElementById('message-selection-menu');
const selectAll=document.getElementById('select-all-messages'),count=document.getElementById('selected-message-count');
const rows=[...list.querySelectorAll('.nav-item')],checks=rows.map(row=>row.querySelector('.nav-check'));
const update=()=>{const n=checks.filter(x=>x.checked).length;count.textContent=n+'/'+checks.length;selectAll.checked=checks.length>0&&n===checks.length;selectAll.indeterminate=n>0&&n<checks.length};
const choose=fn=>{rows.forEach((row,i)=>checks[i].checked=fn(row));update()};
const clearCurrentHighlight=()=>{document.querySelectorAll('.export-message.nav-highlight').forEach(node=>node.classList.remove('nav-highlight'));rows.forEach(row=>row.classList.remove('active'))};
checks.forEach(check=>{check.addEventListener('click',e=>e.stopPropagation());check.addEventListener('change',update)});
const activateMessage=(target,scroll=false)=>{if(!target)return;
clearCurrentHighlight();target.classList.add('nav-highlight');
const row=rows.find(item=>item.dataset.target===target.dataset.messageId);
if(row){row.classList.add('active');if(scroll)row.scrollIntoView({behavior:'smooth',block:'nearest'})}
if(scroll)target.scrollIntoView({behavior:'smooth',block:'start'})};
const navigate=row=>{const target=[...document.querySelectorAll('.export-message')].find(node=>node.dataset.messageId===row.dataset.target);if(!target)return;activateMessage(target,true)};
const content=document.querySelector('.export-main .export-page');
content?.addEventListener('click',e=>{const target=e.target.closest('.export-message');if(target&&content.contains(target))activateMessage(target,false)});
rows.forEach(row=>{row.addEventListener('click',e=>{if(e.target.closest('.nav-check'))return;navigate(row)});
row.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&!e.target.closest('.nav-check')){e.preventDefault();navigate(row)}})});
collapse.addEventListener('click',()=>{layout.classList.add('sidebar-collapsed');expand.style.display='block'});
expand.addEventListener('click',()=>{layout.classList.remove('sidebar-collapsed');expand.style.display='none'});
selectAll.addEventListener('change',()=>choose(()=>selectAll.checked));
menuButton.addEventListener('click',e=>{e.stopPropagation();menu.classList.toggle('open')});
menu.addEventListener('click',e=>{const action=e.target.closest('button')?.dataset.action;if(!action)return;
if(action==='clear'){choose(()=>false);clearCurrentHighlight()}
if(action==='questions')choose(row=>row.dataset.role==='user');
if(action==='answers')choose(row=>row.dataset.role==='assistant');
menu.classList.remove('open')});
document.addEventListener('click',e=>{if(!e.target.closest('.menu-wrap'))menu.classList.remove('open')});update();
})();
</script>
</body></html>`;

    diagnostics.css.copiedElementCustomPropertyCount = copiedCustomPropertyCount;
    diagnostics.dom.exportedMessageCount = exported.length;
    diagnostics.dom.exportedTextLength = exported.reduce((total, item) => total + (item.clone.innerText || item.clone.textContent || '').length, 0);
    diagnostics.dom.navigationItemCount = navigationItems ? exported.length : 0;
    return html;
  }
  function validateDocument(html, expectedCount) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const actualCount = parsed.querySelectorAll('.export-message').length;
    const textLength = (parsed.body.innerText || parsed.body.textContent || '').length;
    const ids = [...parsed.querySelectorAll('.export-message')].map(node => node.dataset.messageId);
    const uniqueIds = new Set(ids.filter(Boolean));
    const mermaidContainers = [...parsed.querySelectorAll('[data-chatgpt-mermaid-preview]')];
    const mermaidSvgCount = mermaidContainers.reduce((total, node) => total + node.querySelectorAll('svg').length, 0);
    const mermaidLoadingCount = mermaidContainers.reduce(
      (total, node) => total + node.querySelectorAll('[data-loading-indicator], [aria-label*="加载"]').length, 0
    );
    const incompleteMermaidContainers = mermaidContainers
      .map((node, index) => ({
        containerIndex: index + 1,
        messageId: node.closest('.export-message')?.dataset.messageId || null,
        messageIndex: Number(node.closest('.export-message')?.dataset.messageIndex) || null,
        svgCount: node.querySelectorAll('svg[id^="chatgpt-mermaid-"], svg[aria-roledescription]').length,
        loadingIndicatorCount: node.querySelectorAll('[data-loading-indicator], [aria-label*="加载"]').length
      }))
      .filter(item => item.svgCount === 0 || item.loadingIndicatorCount > 0);
    diagnostics.mermaid.documentValidation = {
      timestamp: new Date().toISOString(),
      containerCount: mermaidContainers.length,
      incompleteContainerCount: incompleteMermaidContainers.length,
      incompleteContainers: incompleteMermaidContainers,
      svgCount: mermaidSvgCount,
      loadingIndicatorCount: mermaidLoadingCount,
      containers: mermaidContainers.map((node, index) => ({
        index: index + 1,
        renderStatus: node.getAttribute('data-mermaid-render-status'),
        svgCount: node.querySelectorAll('svg').length,
        loadingIndicatorCount: node.querySelectorAll('[data-loading-indicator], [aria-label*="加载"]').length
      }))
    };
    const validation = {
      expectedMessageCount: expectedCount,
      actualMessageCount: actualCount,
      uniqueMessageIdCount: uniqueIds.size,
      textLength,
      hasDoctype: /^<!doctype html>/i.test(html),
      hasOriginalMarkdownRoots: parsed.querySelectorAll('[class*="MarkdownRoot-"]').length > 0,
      hasCodeBlocks: parsed.querySelectorAll('pre, [data-code-block="true"]').length > 0,
      hasSvg: parsed.querySelectorAll('svg').length > 0,
      mermaidContainerCount: mermaidContainers.length,
      mermaidSvgCount,
      mermaidLoadingIndicatorCount: mermaidLoadingCount
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

  function getConversationTitle() {
    const rawTitle = (document.title || '').replace(/\s*\|\s*ChatGPT\s*$/i, '').trim();
    const fallback = document.querySelector('main h1')?.textContent?.trim() || '未命名会话';
    return (rawTitle || fallback).replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').slice(0, 120) || '未命名会话';
  }

  function downloadHTML(html, conversationId) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ChatGPT-${getConversationTitle()}-v${VERSION}.html`;
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
    state.stopRequested = false;
    state.abortController = new AbortController();
    const button = document.getElementById(IDS.button);
    if (button) {
      button.disabled = true;
      button.textContent = '正在导出…';
    }
    const stopButton = document.getElementById(IDS.stopButton);
    if (stopButton) stopButton.hidden = false;
    const speedInput = document.getElementById(IDS.speed);
    if (speedInput) speedInput.disabled = true;
    const logToggle = document.getElementById(IDS.logToggle);
    if (logToggle) logToggle.disabled = true;
    resetDiagnostics(conversationId);
    recordMermaidState(document, 'export-button-click', {
      conversationId,
      scrollTop: window.scrollY,
      documentReadyState: document.readyState
    });
    diagnostics.dom.configuredScrollDelayMs = getScrollDelay();

    try {
      setStatus('正在获取会话数据…');
      const allMessages = await fetchMessages(conversationId);
      throwIfStopped();
      const selected = selectMessages(allMessages);
      if (!selected.length) throw new Error('没有找到可导出的用户消息或 assistant 最终回答。');
      if (diagnostics.api.hasUnfetchedPages) {
        warn('分页标志存在未解决状态；继续进行 DOM 对照诊断。该状态本身不作为失败依据。');
      }
      if (selected.some(item => !item.message?.id)) {
        throw new Error('部分目标消息缺少 ID，无法与原生 DOM 精确对应。');
      }

      setStatus(`接口已筛选 ${selected.length} 条消息，正在遍历虚拟滚动页面…`);
      const exported = await cloneNativeMessages(selected);
      throwIfStopped();
      if (exported.length !== selected.length) {
        const missingCount = diagnostics.dom.missingMessageCount + diagnostics.dom.duplicateMessageCount;
        throw new Error(`虚拟滚动遍历后仍无法完整对应接口消息：目标 ${selected.length} 条，匹配 ${exported.length} 条，缺失或歧义 ${missingCount} 条。未生成不完整文件。`);
      }

      setStatus('正在内嵌 SVG 图标资源…');
      const svgSpriteMarkup = await inlineExternalSvgSprites(exported);

      setStatus('正在提取 ChatGPT 原生样式并生成 HTML…');
      const html = buildDocument(exported, selected, conversationId, svgSpriteMarkup);
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
      const wasStopped = error?.name === 'AbortError' || state.stopRequested;
      diagnostics.result = { success: false, cancelled: wasStopped, reason: error?.message || String(error) };
      setStatus(wasStopped ? '已停止导出，正在保存诊断日志。' : `导出失败：${error?.message || String(error)}`, wasStopped ? 'info' : 'error');
      log(wasStopped);
    } finally {
      state.running = false;
      state.abortController = null;
      state.currentTraversal = null;
      state.currentScrollElement = null;
      const currentStopButton = document.getElementById(IDS.stopButton);
      if (currentStopButton) currentStopButton.hidden = true;
      const currentButton = document.getElementById(IDS.button);
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.textContent = '↓ 导出会话 HTML';
      }
      const currentSpeedInput = document.getElementById(IDS.speed);
      if (currentSpeedInput) currentSpeedInput.disabled = false;
      const currentLogToggle = document.getElementById(IDS.logToggle);
      if (currentLogToggle) currentLogToggle.disabled = false;
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
