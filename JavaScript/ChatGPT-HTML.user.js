// ==UserScript==
// @name         ChatGPT 会话 HTML 导出器
// @namespace    https://github.com/JKwarn/upload-my
// @version      2.2.3
// @description  通过 ChatGPT 两阶段接口获取会话消息，按接口顺序合并并导出独立 HTML 文件。
// @match        https://chatgpt.com/c/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js
// ==/UserScript==

(() => {
    'use strict';

    // ============================================================
    // 1. 基本配置
    // ============================================================

    const VERSION = '2.2.3';
    const LOG_PREFIX = '[ChatGPT 会话 HTML 导出器]';

    const CONFIG = {
        conversationApi: '/backend-api/conversations/',
        sessionApi: '/api/auth/session',

        firstRequestParams: {
            num_turns: 10,
            include_has_versions: true
        },

        secondRequestParams: {
            num_turns: 10,
            include_has_versions: true
        },

        buttonId: 'chatgpt-html-exporter-button',
        styleId: 'chatgpt-html-exporter-style',
        toastId: 'chatgpt-html-exporter-toast'
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

        api: {
            newerMessageCount: 0,
            olderMessageCount: 0,
            mergedMessageCount: 0,
            duplicateCount: 0,

            responseOrder: null,
            responseSizes: null,

            roleCounts: {},
            contentTypeCounts: {},
            channelCounts: {},

            selectedUserCount: 0,
            selectedAssistantFinalCount: 0,
            ignoredReasoningRecapCount: 0,
            ignoredThoughtsCount: 0,
            ignoredOtherCount: 0
        },

        css: {
            stylesheetCount: 0,
            accessibleStylesheets: 0,
            inaccessibleStylesheets: [],
            cssLength: 0,
            customPropertyCount: 0
        },

        result: null
    };

    let isExporting = false;

    // ============================================================
    // 2. 通用工具
    // ============================================================

    function log() {
        const status = diagnostics.result?.success
            ? 'SUCCESS'
            : 'FAILED';

        console.log(
            `${LOG_PREFIX} ${status}`,
            JSON.stringify(diagnostics, null, 2)
        );
    }

    function addError(message) {
        diagnostics.errors.push(String(message));
    }

    function addWarning(message) {
        diagnostics.warnings.push(String(message));
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getConversationId() {
        const match = location.pathname.match(
            /^\/c\/([0-9a-f-]{36})(?:\/|$)/i
        );

        return match?.[1] || null;
    }

    function buildQuery(params) {
        return new URLSearchParams(
            Object.entries(params).map(([key, value]) => [
                key,
                String(value)
            ])
        ).toString();
    }

    function getContentType(message) {
        return message?.content?.content_type || 'unknown';
    }

    function getChannel(message) {
        return message?.channel
            ?? message?.metadata?.channel
            ?? null;
    }

    function getRole(message) {
        return message?.author?.role || 'unknown';
    }

    function getMessageId(message) {
        return typeof message?.id === 'string'
            ? message.id
            : null;
    }

    // ============================================================
    // 3. UI
    // ============================================================

    function injectStyle() {
        if (document.getElementById(CONFIG.styleId)) {
            return;
        }

        const style = document.createElement('style');
        style.id = CONFIG.styleId;

        style.textContent = `
            #${CONFIG.buttonId} {
                position: fixed;
                right: 24px;
                bottom: 24px;
                z-index: 2147483646;

                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;

                min-width: 150px;
                height: 42px;
                padding: 0 18px;

                border: 1px solid rgba(255,255,255,.15);
                border-radius: 12px;

                background: #10a37f;
                color: #fff;

                font-size: 14px;
                font-weight: 600;
                font-family: inherit;

                cursor: pointer;
                box-shadow: 0 4px 14px rgba(0,0,0,.18);

                transition:
                    background .15s ease,
                    transform .15s ease,
                    opacity .15s ease;
            }

            #${CONFIG.buttonId}:hover {
                background: #0d8f70;
                transform: translateY(-1px);
            }

            #${CONFIG.buttonId}:disabled {
                opacity: .65;
                cursor: wait;
                transform: none;
            }

            #${CONFIG.buttonId} .exporter-icon {
                font-size: 16px;
                line-height: 1;
            }

            #${CONFIG.toastId} {
                position: fixed;
                right: 24px;
                bottom: 78px;
                z-index: 2147483647;

                max-width: 360px;
                padding: 12px 16px;

                border-radius: 10px;
                background: #202123;
                color: #fff;

                font-size: 13px;
                line-height: 1.5;
                font-family: inherit;

                box-shadow: 0 4px 16px rgba(0,0,0,.2);

                opacity: 0;
                pointer-events: none;
                transform: translateY(8px);

                transition:
                    opacity .2s ease,
                    transform .2s ease;
            }

            #${CONFIG.toastId}.visible {
                opacity: 1;
                transform: translateY(0);
            }

            #${CONFIG.toastId}.success {
                border-left: 4px solid #10a37f;
            }

            #${CONFIG.toastId}.error {
                border-left: 4px solid #ef4444;
            }

            #${CONFIG.toastId}.info {
                border-left: 4px solid #3b82f6;
            }
        `;

        (document.head || document.documentElement)
            .appendChild(style);
    }

    function showToast(message, type = 'info') {
        let toast = document.getElementById(CONFIG.toastId);

        if (!toast) {
            toast = document.createElement('div');
            toast.id = CONFIG.toastId;
            document.body.appendChild(toast);
        }

        toast.textContent = message;
        toast.className = `${type} visible`;

        clearTimeout(showToast.timer);

        showToast.timer = setTimeout(() => {
            toast.classList.remove('visible');
        }, 4000);
    }

    function setButtonState(button, text, disabled) {
        if (!button) return;

        button.disabled = disabled;

        button.innerHTML = `
            <span class="exporter-icon">
                ${disabled ? '⏳' : '↓'}
            </span>
            <span>${escapeHtml(text)}</span>
        `;
    }

    function createButton() {
        if (document.getElementById(CONFIG.buttonId)) {
            return;
        }

        injectStyle();

        const button = document.createElement('button');

        button.id = CONFIG.buttonId;
        button.type = 'button';

        button.innerHTML = `
            <span class="exporter-icon">↓</span>
            <span>导出会话 HTML</span>
        `;

        button.addEventListener('click', async () => {
            if (isExporting) return;

            isExporting = true;

            setButtonState(button, '正在获取会话...', true);

            try {
                await exportConversation();
            } catch (error) {
                addError({
                    name: error?.name || 'Error',
                    message: error?.message || String(error),
                    stack: error?.stack || ''
                });

                diagnostics.result = {
                    success: false,
                    reason: error?.message || String(error)
                };

                showToast(
                    `导出失败：${error?.message || String(error)}`,
                    'error'
                );

                log();
            } finally {
                isExporting = false;

                setButtonState(
                    button,
                    '导出会话 HTML',
                    false
                );
            }
        });

        document.body.appendChild(button);
    }

    // ============================================================
    // 4. 登录状态及认证信息
    // ============================================================

    async function getAuthentication() {
        const response = await fetch(CONFIG.sessionApi, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: {
                Accept: 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(
                `获取登录状态失败，HTTP ${response.status}`
            );
        }

        const session = await response.json();

        const accessToken = session?.accessToken;
        const accountId = session?.account?.id;

        if (
            typeof accessToken !== 'string' ||
            !accessToken ||
            typeof accountId !== 'string' ||
            !accountId
        ) {
            throw new Error(
                '当前登录会话中缺少 accessToken 或 account.id。'
            );
        }

        diagnostics.authentication.success = true;

        // 不将 token 或账户 ID 写入日志。
        return {
            accessToken,
            accountId
        };
    }

    // ============================================================
    // 5. API 请求
    // ============================================================

    async function requestJson(url, authentication) {
        const response = await fetch(url, {
            method: 'GET',

            credentials: 'include',
            cache: 'no-store',

            headers: {
                Accept: 'application/json',

                Authorization:
                    `Bearer ${authentication.accessToken}`,

                'ChatGPT-Account-Id':
                    authentication.accountId
            }
        });

        if (!response.ok) {
            let detail = '';

            try {
                const body = await response.json();

                detail =
                    body?.detail?.message ||
                    body?.message ||
                    '';
            } catch {
                // 忽略非 JSON 错误响应。
            }

            throw new Error(
                `接口请求失败：HTTP ${response.status}` +
                (detail ? `，${detail}` : '')
            );
        }

        const data = await response.json();

        if (!data || !Array.isArray(data.messages)) {
            throw new Error(
                '接口响应结构异常：没有找到 messages 数组。'
            );
        }

        return data;
    }

    async function fetchConversation(conversationId) {
        const authentication = await getAuthentication();

        // --------------------------------------------------------
        // 第一阶段：获取较新的消息及分页游标
        // --------------------------------------------------------

        const firstUrl =
            CONFIG.conversationApi +
            encodeURIComponent(conversationId) +
            '?' +
            buildQuery(CONFIG.firstRequestParams);

        const newerResponse = await requestJson(
            firstUrl,
            authentication
        );

        const startCursor = newerResponse
            ?.page_info
            ?.start_cursor;

        if (
            typeof startCursor !== 'string' ||
            !startCursor
        ) {
            throw new Error(
                '第一阶段响应缺少 page_info.start_cursor，无法执行第二阶段请求。'
            );
        }

        // --------------------------------------------------------
        // 第二阶段：获取较旧的消息
        // --------------------------------------------------------

        const secondParams = {
            ...CONFIG.secondRequestParams,
            before: startCursor
        };

        const secondUrl =
            CONFIG.conversationApi +
            encodeURIComponent(conversationId) +
            '/messages?' +
            buildQuery(secondParams);

        const olderResponse = await requestJson(
            secondUrl,
            authentication
        );

        diagnostics.api.newerMessageCount =
            newerResponse.messages.length;

        diagnostics.api.olderMessageCount =
            olderResponse.messages.length;

        return {
            newerResponse,
            olderResponse
        };
    }

    // ============================================================
    // 6. 两阶段消息合并
    // ============================================================

    function mergeMessages(newerResponse, olderResponse) {
        const newerMessages = newerResponse.messages;
        const olderMessages = olderResponse.messages;

        /*
         * 当前已验证的接口行为：
         *
         * - 消息数量较大的 response 包含更旧的对话。
         * - 消息数量较小的 response 包含更新的对话。
         *
         * 当前两份实测数据：
         *
         * - 较旧 response：19 条
         * - 较新 response：15 条
         *
         * 不通过 parent_id、create_time 或 DOM 顺序排序。
         */

        if (olderMessages.length <= newerMessages.length) {
            throw new Error(
                '两个 response 的消息数量不符合已确认的新旧关系：' +
                `第二阶段 ${olderMessages.length} 条，` +
                `第一阶段 ${newerMessages.length} 条。` +
                '为避免错误排序，本次终止导出。'
            );
        }

        diagnostics.api.responseOrder = [
            '较大的 response：较旧消息',
            '较小的 response：较新消息'
        ];

        diagnostics.api.responseSizes = {
            olderMessageCount: olderMessages.length,
            newerMessageCount: newerMessages.length
        };

        /*
         * 严格保持：
         *
         * 1. 较旧 response 的数组原始顺序。
         * 2. 较新 response 的数组原始顺序。
         * 3. 较旧 response 在前。
         * 4. 较新 response 在后。
         *
         * 不使用 parent_id。
         * 不使用 create_time。
         * 不使用 DOM 顺序。
         */

        const orderedMessages = [
            ...olderMessages,
            ...newerMessages
        ];

        // 仅按 id 去重，不建立父子关系。
        const seenIds = new Set();
        const mergedMessages = [];

        let duplicateCount = 0;

        for (const message of orderedMessages) {
            const id = getMessageId(message);

            if (id && seenIds.has(id)) {
                duplicateCount++;
                continue;
            }

            if (id) {
                seenIds.add(id);
            }

            mergedMessages.push(message);
        }

        diagnostics.api.duplicateCount = duplicateCount;
        diagnostics.api.mergedMessageCount =
            mergedMessages.length;

        return mergedMessages;
    }

    // ============================================================
    // 7. 消息分类
    // ============================================================

    function countMessageProperties(messages) {
        const roleCounts = {};
        const contentTypeCounts = {};
        const channelCounts = {};

        for (const message of messages) {
            const role = getRole(message);
            const contentType = getContentType(message);
            const channel = getChannel(message) || '(null)';

            roleCounts[role] =
                (roleCounts[role] || 0) + 1;

            contentTypeCounts[contentType] =
                (contentTypeCounts[contentType] || 0) + 1;

            channelCounts[channel] =
                (channelCounts[channel] || 0) + 1;
        }

        diagnostics.api.roleCounts = roleCounts;
        diagnostics.api.contentTypeCounts =
            contentTypeCounts;
        diagnostics.api.channelCounts = channelCounts;
    }

    function isAssistantFinal(message) {
        if (getRole(message) !== 'assistant') {
            return false;
        }

        /*
         * 真实接口样本中：
         *
         * channel = "final"
         * metadata.message_type = "next"
         *
         * 因此不能使用 metadata.message_type
         * 判断 assistant 是否为最终回答。
         *
         * 优先读取顶层 channel，
         * 同时兼容 metadata.channel。
         */

        return getChannel(message) === 'final';
    }

    function isReasoningRecap(message) {
        return getContentType(message) === 'reasoning_recap';
    }

    function isThoughts(message) {
        return getContentType(message) === 'thoughts';
    }

    function isUserMessage(message) {
        return getRole(message) === 'user';
    }

    function isExportableMessage(message) {
        if (isUserMessage(message)) {
            return true;
        }

        if (isAssistantFinal(message)) {
            return true;
        }

        return false;
    }

    function selectMessages(messages) {
        const selected = [];

        let userCount = 0;
        let assistantFinalCount = 0;
        let reasoningRecapCount = 0;
        let thoughtsCount = 0;
        let otherCount = 0;

        for (const message of messages) {
            if (isReasoningRecap(message)) {
                reasoningRecapCount++;
                continue;
            }

            if (isThoughts(message)) {
                thoughtsCount++;
                continue;
            }

            if (isUserMessage(message)) {
                selected.push(message);
                userCount++;
                continue;
            }

            if (isAssistantFinal(message)) {
                selected.push(message);
                assistantFinalCount++;
                continue;
            }

            otherCount++;
        }

        diagnostics.api.selectedUserCount = userCount;

        diagnostics.api.selectedAssistantFinalCount =
            assistantFinalCount;

        diagnostics.api.ignoredReasoningRecapCount =
            reasoningRecapCount;

        diagnostics.api.ignoredThoughtsCount =
            thoughtsCount;

        diagnostics.api.ignoredOtherCount =
            otherCount;

        return selected;
    }

    // ============================================================
    // 8. 提取消息正文
    // ============================================================

    function getMessageText(message) {
        const content = message?.content;

        if (!content || typeof content !== 'object') {
            return '';
        }

        if (Array.isArray(content.parts)) {
            return content.parts
                .map(part => {
                    if (typeof part === 'string') {
                        return part;
                    }

                    if (
                        part &&
                        typeof part === 'object' &&
                        typeof part.text === 'string'
                    ) {
                        return part.text;
                    }

                    return '';
                })
                .filter(Boolean)
                .join('\n\n');
        }

        if (typeof content.text === 'string') {
            return content.text;
        }

        if (typeof content.content === 'string') {
            return content.content;
        }

        return '';
    }

    function getMessageTimestamp(message) {
        const timestamp = message?.create_time;

        if (
            typeof timestamp !== 'number' ||
            !Number.isFinite(timestamp)
        ) {
            return '';
        }

        return new Date(timestamp * 1000).toLocaleString(
            'zh-CN',
            {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }
        );
    }

    // ============================================================
    // 9. Markdown 转 HTML
    // ============================================================

    function initializeMarkdown() {
        if (
            typeof marked === 'undefined' ||
            typeof DOMPurify === 'undefined'
        ) {
            throw new Error(
                'Markdown 渲染组件加载失败，请检查 @require 网络连接。'
            );
        }

        marked.setOptions({
            gfm: true,
            breaks: false,
            headerIds: false,
            mangle: false
        });
    }

    function renderMarkdown(markdown) {
        const source = String(markdown ?? '');

        if (!source.trim()) {
            return '<p class="empty-message">（此消息没有可显示的文本内容）</p>';
        }

        const rendered = marked.parse(source);

        return DOMPurify.sanitize(rendered, {
            USE_PROFILES: {
                html: true
            },

            ADD_ATTR: [
                'target',
                'rel',
                'class',
                'align',
                'start',
                'type'
            ],

            FORBID_TAGS: [
                'script',
                'iframe',
                'object',
                'embed',
                'form',
                'input',
                'button'
            ],

            FORBID_ATTR: [
                'onerror',
                'onclick',
                'onload',
                'onmouseover',
                'onfocus',
                'onmouseenter'
            ]
        });
    }

    // ============================================================
    // 10. 提取页面 CSS
    // ============================================================

    function getCustomProperties(element) {
        const computed = getComputedStyle(element);
        const properties = [];

        for (let i = 0; i < computed.length; i++) {
            const name = computed[i];

            if (!name.startsWith('--')) {
                continue;
            }

            const value = computed
                .getPropertyValue(name)
                .trim();

            if (value) {
                properties.push(`${name}:${value}`);
            }
        }

        return properties;
    }

    function extractPageCss() {
        const stylesheets = [...document.styleSheets];

        diagnostics.css.stylesheetCount =
            stylesheets.length;

        const cssParts = [];

        for (const [index, sheet] of stylesheets.entries()) {
            try {
                const rules = sheet.cssRules;

                if (!rules) {
                    diagnostics.css.inaccessibleStylesheets.push({
                        index,
                        href: sheet.href || '(inline)',
                        reason: 'cssRules 不可用'
                    });

                    continue;
                }

                const cssText = [...rules]
                    .map(rule => rule.cssText)
                    .join('\n');

                if (cssText) {
                    cssParts.push(cssText);

                    diagnostics.css.accessibleStylesheets++;

                    diagnostics.css.cssLength +=
                        cssText.length;
                }
            } catch (error) {
                diagnostics.css.inaccessibleStylesheets.push({
                    index,
                    href: sheet.href || '(inline)',
                    reason: String(error)
                });
            }
        }

        if (diagnostics.css.inaccessibleStylesheets.length) {
            addWarning(
                '部分页面样式表无法读取，导出文档可能存在样式差异。'
            );
        }

        return cssParts.join('\n\n');
    }

    // ============================================================
    // 11. 构建消息 HTML
    // ============================================================

    function buildMessageHtml(message, index) {
        const role = getRole(message);

        const isUser = role === 'user';

        const roleName = isUser
            ? '用户'
            : 'ChatGPT';

        const timestamp = getMessageTimestamp(message);

        const text = getMessageText(message);

        const bodyHtml = renderMarkdown(text);

        return `
            <section
                class="export-message ${isUser ? 'user-message' : 'assistant-message'}"
                data-message-index="${index + 1}"
            >
                <header class="message-header">
                    <span class="message-role">
                        ${roleName}
                    </span>

                    ${
                        timestamp
                            ? `<time class="message-time">${escapeHtml(timestamp)}</time>`
                            : ''
                    }
                </header>

                <div class="message-content markdown-body">
                    ${bodyHtml}
                </div>
            </section>
        `;
    }

    // ============================================================
    // 12. 构建完整 HTML 文档
    // ============================================================

    function buildExportDocument(messages, conversationId) {
        initializeMarkdown();

        const pageCss = extractPageCss();

        const rootProperties = getCustomProperties(
            document.documentElement
        );

        diagnostics.css.customPropertyCount =
            rootProperties.length;

        const rootVariableCss = rootProperties.join(';');

        const theme = document.documentElement.getAttribute(
            'data-theme'
        ) || 'light';

        const htmlClass =
            document.documentElement.className || '';

        const title = document.title || 'ChatGPT 会话';

        const messageHtml = messages
            .map((message, index) =>
                buildMessageHtml(message, index)
            )
            .join('\n');

        const exportDocument = `<!DOCTYPE html>
<html
    lang="zh-CN"
    class="${escapeHtml(htmlClass)}"
    data-theme="${escapeHtml(theme)}"
>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>${escapeHtml(title)} - ChatGPT 会话导出</title>

<style>
:root {
    ${rootVariableCss}
}

/* --------------------------------------------------
   ChatGPT 页面原始 CSS
-------------------------------------------------- */

${pageCss}

/* --------------------------------------------------
   独立导出文档布局
-------------------------------------------------- */

* {
    box-sizing: border-box;
}

html {
    min-height: 100%;
    background: #fff;
}

body {
    margin: 0;
    padding: 12mm;
    background: #fff;
    color: #0d0d0d;

    font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        "Microsoft YaHei",
        sans-serif;

    font-size: 15px;
    line-height: 1.65;
}

.export-page {
    width: 100%;
    max-width: 186mm;
    margin: 0 auto;
}

.export-title {
    margin: 0 0 28px;
    padding-bottom: 16px;
    border-bottom: 1px solid #e5e7eb;

    font-size: 22px;
    font-weight: 700;
    line-height: 1.4;
}

.export-info {
    margin: -16px 0 28px;
    color: #888;
    font-size: 12px;
}

.export-message {
    width: 100%;
    min-width: 0;
    margin: 0 auto 30px;
    padding: 18px 20px;

    border: 1px solid #e5e7eb;
    border-radius: 12px;

    background: #fff;

    overflow: visible;
}

.user-message {
    background: #f7f7f8;
}

.assistant-message {
    background: #fff;
}

.message-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    margin-bottom: 14px;
}

.message-role {
    font-size: 13px;
    font-weight: 700;
    color: #555;
}

.message-time {
    color: #999;
    font-size: 11px;
}

.message-content {
    min-width: 0;
    overflow-wrap: anywhere;
    word-break: normal;
}

.markdown-body {
    line-height: 1.7;
}

.markdown-body > :first-child {
    margin-top: 0;
}

.markdown-body > :last-child {
    margin-bottom: 0;
}

.markdown-body p {
    margin: 0 0 14px;
}

.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
    margin: 24px 0 12px;
    font-weight: 700;
    line-height: 1.4;
}

.markdown-body h1 {
    font-size: 1.8em;
}

.markdown-body h2 {
    font-size: 1.5em;
}

.markdown-body h3 {
    font-size: 1.25em;
}

.markdown-body ul,
.markdown-body ol {
    margin: 12px 0;
    padding-left: 28px;
}

.markdown-body li {
    margin: 5px 0;
}

.markdown-body blockquote {
    margin: 16px 0;
    padding: 4px 16px;
    border-left: 4px solid #d1d5db;
    color: #555;
}

.markdown-body hr {
    height: 1px;
    margin: 24px 0;
    border: 0;
    background: #e5e7eb;
}

.markdown-body a {
    color: #2563eb;
    text-decoration: underline;
    overflow-wrap: anywhere;
}

.markdown-body img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 14px 0;
}

.markdown-body table {
    display: block;
    width: 100%;
    max-width: 100%;
    margin: 16px 0;

    border-collapse: collapse;
    overflow-x: auto;
}

.markdown-body th,
.markdown-body td {
    padding: 8px 12px;
    border: 1px solid #d1d5db;
    text-align: left;
    vertical-align: top;
}

.markdown-body th {
    background: #f3f4f6;
    font-weight: 700;
}

.markdown-body code {
    padding: 2px 5px;
    border-radius: 4px;
    background: #f1f1f1;

    font-family:
        Consolas,
        "Courier New",
        monospace;

    font-size: .9em;
    overflow-wrap: anywhere;
}

/* --------------------------------------------------
   代码块：完整展开，不设置高度限制
-------------------------------------------------- */

.markdown-body pre {
    display: block;

    width: 100%;
    max-width: 100%;

    margin: 16px 0;
    padding: 14px 16px;

    border: 1px solid #e5e7eb;
    border-radius: 8px;

    background: #f6f8fa;

    white-space: pre;
    overflow-x: auto;
    overflow-y: visible;

    max-height: none !important;
    height: auto !important;

    break-inside: auto;
}

.markdown-body pre code {
    display: block;

    padding: 0;
    border: 0;
    border-radius: 0;

    background: transparent;

    white-space: pre;
    overflow: visible;

    max-height: none !important;
    height: auto !important;

    font-size: 13px;
    line-height: 1.6;
}

/* --------------------------------------------------
   其他内容
-------------------------------------------------- */

.markdown-body details {
    margin: 12px 0;
}

.markdown-body input[type="checkbox"] {
    margin-right: 6px;
}

.empty-message {
    color: #999;
    font-style: italic;
}

.export-footer {
    margin-top: 40px;
    padding-top: 14px;

    border-top: 1px solid #e5e7eb;

    color: #999;
    font-size: 11px;
    text-align: center;
}

@media print {
    body {
        padding: 0;
    }

    .export-page {
        width: 100%;
        max-width: none;
    }

    .export-message {
        break-inside: auto;
    }

    pre,
    table,
    blockquote {
        break-inside: avoid;
    }

    a {
        color: inherit;
    }
}

@page {
    size: A4;
    margin: 12mm;
}
</style>
</head>

<body>
<main class="export-page">

    <h1 class="export-title">
        ${escapeHtml(title)}
    </h1>

    <div class="export-info">
        会话 ID：${escapeHtml(conversationId)}
        <br>
        导出时间：${escapeHtml(new Date().toLocaleString('zh-CN'))}
        <br>
        导出版本：${VERSION}
        <br>
        消息数量：${messages.length}
    </div>

    ${messageHtml}

    <footer class="export-footer">
        Generated by ChatGPT 会话 HTML 导出器 v${VERSION}
    </footer>

</main>
</body>
</html>`;

        return {
            html: exportDocument,
            pageCssLength: pageCss.length,
            rootPropertyCount: rootProperties.length
        };
    }

    // ============================================================
    // 13. HTML 完整性检查
    // ============================================================

    function validateExportDocument(html, expectedMessageCount) {
        if (!html.startsWith('<!DOCTYPE html>')) {
            throw new Error(
                '生成的 HTML 文档缺少 DOCTYPE。'
            );
        }

        const parser = new DOMParser();

        const parsed = parser.parseFromString(
            html,
            'text/html'
        );

        if (parsed.querySelector('parsererror')) {
            throw new Error(
                '最终 HTML 文档解析失败。'
            );
        }

        const messages = parsed.querySelectorAll(
            '.export-message'
        );

        if (messages.length !== expectedMessageCount) {
            throw new Error(
                `消息数量校验失败：预期 ${expectedMessageCount}，` +
                `实际 ${messages.length}。`
            );
        }

        const markdownBodies = parsed.querySelectorAll(
            '.message-content'
        );

        if (markdownBodies.length !== expectedMessageCount) {
            throw new Error(
                '消息正文容器数量与预期不一致。'
            );
        }

        let codeBlockCount = 0;

        for (const message of messages) {
            const body = message.querySelector(
                '.message-content'
            );

            if (!body) {
                throw new Error(
                    '发现缺少正文容器的消息节点。'
                );
            }

            if (!body.textContent.trim()) {
                addWarning(
                    '检测到正文为空的消息节点。'
                );
            }

            codeBlockCount +=
                body.querySelectorAll('pre code').length;
        }

        return {
            messageCount: messages.length,
            codeBlockCount,
            parsedTextLength:
                parsed.body.textContent.length
        };
    }

    // ============================================================
    // 14. 文件下载
    // ============================================================

    function downloadHtml(html, filename) {
        const blob = new Blob(
            [html],
            {
                type: 'text/html;charset=utf-8'
            }
        );

        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');

        link.href = url;
        link.download = filename;
        link.style.display = 'none';

        document.body.appendChild(link);

        try {
            link.click();
        } finally {
            link.remove();

            setTimeout(() => {
                URL.revokeObjectURL(url);
            }, 30000);
        }

        return filename;
    }

    function createFilename() {
        const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, '-');

        return `ChatGPT-会话导出-${timestamp}.html`;
    }

    // ============================================================
    // 15. 主导出流程
    // ============================================================

    async function exportConversation() {
        diagnostics.timestamp = new Date().toISOString();

        diagnostics.errors = [];
        diagnostics.warnings = [];

        diagnostics.api = {
            newerMessageCount: 0,
            olderMessageCount: 0,
            mergedMessageCount: 0,
            duplicateCount: 0,

            responseOrder: null,
            responseSizes: null,

            roleCounts: {},
            contentTypeCounts: {},
            channelCounts: {},

            selectedUserCount: 0,
            selectedAssistantFinalCount: 0,
            ignoredReasoningRecapCount: 0,
            ignoredThoughtsCount: 0,
            ignoredOtherCount: 0
        };

        diagnostics.css = {
            stylesheetCount: 0,
            accessibleStylesheets: 0,
            inaccessibleStylesheets: [],
            cssLength: 0,
            customPropertyCount: 0
        };

        diagnostics.result = null;

        const conversationId = getConversationId();

        if (!conversationId) {
            throw new Error(
                '无法从当前 URL 中识别会话 ID。'
            );
        }

        diagnostics.conversationId = conversationId;

        showToast(
            '正在获取登录信息及会话数据...',
            'info'
        );

        // --------------------------------------------------------
        // 1. 两阶段 API 请求
        // --------------------------------------------------------

        const {
            newerResponse,
            olderResponse
        } = await fetchConversation(conversationId);

        // --------------------------------------------------------
        // 2. 按 response 大小及接口顺序合并
        // --------------------------------------------------------

        const mergedMessages = mergeMessages(
            newerResponse,
            olderResponse
        );

        // --------------------------------------------------------
        // 3. 统计消息类型
        // --------------------------------------------------------

        countMessageProperties(mergedMessages);

        // --------------------------------------------------------
        // 4. 选择用户消息和 assistant final
        // --------------------------------------------------------

        const selectedMessages = selectMessages(
            mergedMessages
        );

        if (!selectedMessages.length) {
            throw new Error(
                '没有找到可导出的用户消息或 ChatGPT 最终回答。'
            );
        }

        if (!diagnostics.api.selectedUserCount) {
            addWarning(
                '当前数据中没有找到用户消息。'
            );
        }

        if (!diagnostics.api.selectedAssistantFinalCount) {
            addWarning(
                '当前数据中没有找到 channel=final 的 assistant 消息。'
            );
        }

        // --------------------------------------------------------
        // 5. 检查分页完整性
        // --------------------------------------------------------

        const newerPageInfo =
            newerResponse.page_info || {};

        const olderPageInfo =
            olderResponse.page_info || {};

        const pagination = {
            newerPage: {
                hasPreviousPage:
                    newerPageInfo.has_previous_page ?? null,

                hasNextPage:
                    newerPageInfo.has_next_page ?? null
            },

            olderPage: {
                hasPreviousPage:
                    olderPageInfo.has_previous_page ?? null,

                hasNextPage:
                    olderPageInfo.has_next_page ?? null
            }
        };

        /*
         * 按用户已经确认的方案，只执行两阶段请求。
         *
         * 如果分页标志表明仍有未获取的数据，
         * 必须明确标记为部分数据，不伪造完整性。
         *
         * 不增加第三阶段请求。
         */

        const hasUnfetchedPages =
            newerPageInfo.has_previous_page === true ||
            newerPageInfo.has_next_page === true ||
            olderPageInfo.has_previous_page === true ||
            olderPageInfo.has_next_page === true;

        if (hasUnfetchedPages) {
            addWarning(
                '接口分页标志表明可能仍有未获取的消息。' +
                '根据当前两阶段请求约束，本次不会继续请求其他分页。'
            );
        }

        // --------------------------------------------------------
        // 6. 生成 HTML
        // --------------------------------------------------------

        showToast(
            `已获取 ${selectedMessages.length} 条正文，正在生成 HTML...`,
            'info'
        );

        const {
            html,
            pageCssLength
        } = buildExportDocument(
            selectedMessages,
            conversationId
        );

        // --------------------------------------------------------
        // 7. 最终验证
        // --------------------------------------------------------

        const validation = validateExportDocument(
            html,
            selectedMessages.length
        );

        // --------------------------------------------------------
        // 8. 下载文件
        // --------------------------------------------------------

        const filename = createFilename();

        downloadHtml(html, filename);

        // --------------------------------------------------------
        // 9. 结果记录
        // --------------------------------------------------------

        diagnostics.result = {
            success: true,

            completeness: {
                isComplete: !hasUnfetchedPages,

                status: hasUnfetchedPages
                    ? 'partial'
                    : 'complete',

                reason: hasUnfetchedPages
                    ? [
                        '当前两阶段接口响应的分页标志表明可能仍有未获取的数据。'
                    ]
                    : []
            },

            filename,

            htmlLength: html.length,

            cssLength: pageCssLength,

            exportedMessageCount:
                selectedMessages.length,

            userMessageCount:
                diagnostics.api.selectedUserCount,

            assistantFinalCount:
                diagnostics.api.selectedAssistantFinalCount,

            codeBlockCount:
                validation.codeBlockCount,

            validation
        };

        log();

        if (hasUnfetchedPages) {
            showToast(
                `已导出 ${selectedMessages.length} 条消息。注意：当前结果为部分数据。`,
                'success'
            );
        } else {
            showToast(
                `导出成功，共 ${selectedMessages.length} 条消息。`,
                'success'
            );
        }
    }

    // ============================================================
    // 16. 动态页面处理
    // ============================================================

    function initialize() {
        if (!document.body) {
            return;
        }

        createButton();
    }

    initialize();

    /*
     * ChatGPT 是动态页面。
     *
     * 页面切换或 DOM 更新时，确保导出按钮仍然存在。
     * 不操作会话滚动位置，不修改原始消息节点。
     */

    const observer = new MutationObserver(() => {
        if (!document.body) return;

        if (!document.getElementById(CONFIG.buttonId)) {
            createButton();
        }
    });

    observer.observe(
        document.documentElement,
        {
            childList: true,
            subtree: true
        }
    );

})();
