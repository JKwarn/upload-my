// ==UserScript==
// @name         ChatGPT 会话 PDF 导出器
// @namespace    https://github.com/JKwarn/upload-my
// @version      1.16.0
// @description  诊断 ChatGPT API 与虚拟滚动 DOM 中用户消息的数量、顺序和内容一致性
// @match        https://chatgpt.com/c/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(async () => {
    'use strict';

    const VERSION = '1.16.0';

    const CONFIG = {
        apiNumTurns: 100,

        maxScrollStepsPerDirection: 1500,
        scrollStepRatio: 0.60,
        minScrollStep: 200,

        settleDelay: 250,
        stableCheckDelay: 80,
        stableCheckCount: 3,
        maxStableWait: 3000,

        maxReportChars: 150 * 1024
    };

    const PREFIX = '[ChatGPT API-DOM Diagnostic]';

    const sleep = ms =>
        new Promise(resolve => setTimeout(resolve, ms));

    const normalizeText = value =>
        String(value ?? '')
            .replace(/\r\n?/g, '\n')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

    const conversationId = (() => {
        const match = location.pathname.match(/\/c\/([^/?#]+)/);
        return match?.[1] || null;
    })();

    // ============================================================
    // 1. API 数据获取
    // ============================================================

    const getRole = message =>
        message?.author?.role ||
        message?.message?.author?.role ||
        '';

    const getMessageId = message =>
        message?.id ||
        message?.message?.id ||
        null;

    const getMessageText = message => {
        if (!message || typeof message !== 'object') {
            return '';
        }

        const content = message.content;

        if (!content) {
            return '';
        }

        if (typeof content.text === 'string') {
            return normalizeText(content.text);
        }

        if (!Array.isArray(content.parts)) {
            return '';
        }

        const parts = content.parts.map(part => {
            if (typeof part === 'string') {
                return part;
            }

            if (!part || typeof part !== 'object') {
                return '';
            }

            if (typeof part.text === 'string') {
                return part.text;
            }

            if (typeof part.transcript === 'string') {
                return part.transcript;
            }

            const type = String(
                part.content_type || part.type || ''
            ).toLowerCase();

            if (type.includes('image')) return '[图片内容]';
            if (type.includes('audio')) return '[音频内容]';
            if (type.includes('video')) return '[视频内容]';
            if (type.includes('file')) return '[文件内容]';

            return '';
        });

        return normalizeText(parts.filter(Boolean).join('\n'));
    };

    const extractApiMessages = data => {
        if (!data || typeof data !== 'object') {
            throw new Error('API 响应不是有效对象');
        }

        let rawMessages = [];
        let extractionMode = 'unknown';
        let coverageScope = 'unknown';

        if (
            data.mapping &&
            typeof data.mapping === 'object'
        ) {
            extractionMode = 'mapping-current-node';
            coverageScope = 'current_node 活动路径';

            const mapping = data.mapping;
            const path = [];
            const visited = new Set();

            let currentId = data.current_node;

            while (
                currentId &&
                mapping[currentId] &&
                !visited.has(currentId)
            ) {
                visited.add(currentId);

                const node = mapping[currentId];

                if (node.message) {
                    path.push(node.message);
                }

                currentId = node.parent;
            }

            path.reverse();
            rawMessages = path;

        } else if (Array.isArray(data.messages)) {
            extractionMode = 'messages-array';
            coverageScope = 'API messages 数组';
            rawMessages = data.messages;

        } else if (Array.isArray(data.items)) {
            extractionMode = 'items-array';
            coverageScope = 'API items 数组';
            rawMessages = data.items;

        } else {
            throw new Error(
                'API 响应中没有识别到 mapping、messages 或 items'
            );
        }

        const userMessages = rawMessages
            .filter(message => getRole(message) === 'user')
            .map((message, index) => {
                const text = getMessageText(message);

                return {
                    index: index + 1,
                    id: getMessageId(message),
                    text,
                    textLength: text.length
                };
            });

        return {
            extractionMode,
            coverageScope,
            rawMessageCount: rawMessages.length,
            userMessages
        };
    };

    const fetchJson = async url => {
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: {
                Accept: 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}: ${response.statusText}`
            );
        }

        return response.json();
    };

    const getApiData = async id => {
        // 注意：使用单数 conversation。
        const endpoint =
            `/backend-api/conversation/${encodeURIComponent(id)}` +
            `?include_has_versions=true&num_turns=${CONFIG.apiNumTurns}`;

        const data = await fetchJson(endpoint);
        const extracted = extractApiMessages(data);

        // 不猜测分页协议。
        // 只有 API 明确返回布尔值 false，才确认不存在上一页。
        const rawHasPrevious =
            data.has_previous_page ??
            data.hasPreviousPage ??
            data.page_info?.has_previous_page ??
            data.pageInfo?.hasPreviousPage;

        const hasPreviousPage =
            typeof rawHasPrevious === 'boolean'
                ? rawHasPrevious
                : null;

        const paginationComplete =
            hasPreviousPage === false;

        return {
            success: true,
            endpoint,
            extractionMode: extracted.extractionMode,
            coverageScope: extracted.coverageScope,

            rawMessageCount: extracted.rawMessageCount,
            userMessageCount: extracted.userMessages.length,

            userMessages: extracted.userMessages,

            pagination: {
                hasPreviousPage,
                paginationComplete,
                paginationProtocol: '仅检查响应中的明确分页状态；本版本不猜测历史分页接口'
            },

            complete: paginationComplete
        };
    };

    // ============================================================
    // 2. DOM 消息节点识别
    // ============================================================

    const USER_SELECTOR = '.group\\/user-message';

    const getCandidateElements = root => {
        const result = [];

        if (root?.matches?.(USER_SELECTOR)) {
            result.push(root);
        }

        if (root?.querySelectorAll) {
            result.push(...root.querySelectorAll(USER_SELECTOR));
        }

        return result;
    };

    const getCandidateText = element => {
        if (!element) return '';

        const content =
            element.querySelector('.contents') ||
            element.querySelector(
                '[data-message-author-role="user"]'
            ) ||
            element;

        return normalizeText(
            content.innerText || content.textContent || ''
        );
    };

    const getDomMessageId = element => {
        const selectors = [
            '[data-message-id]',
            '[data-turn-id]'
        ];

        for (const selector of selectors) {
            const target =
                element.matches?.(selector)
                    ? element
                    : element.querySelector(selector);

            if (!target) continue;

            const value =
                target.getAttribute('data-message-id') ||
                target.getAttribute('data-turn-id');

            if (value) return value;
        }

        return null;
    };

    const getTranscriptRoot = () => {
        const main = document.querySelector('main');

        if (!main) {
            throw new Error('没有找到 main 元素');
        }

        const candidates = getCandidateElements(main);

        if (!candidates.length) {
            throw new Error(
                'main 中没有找到 .group/user-message 候选节点'
            );
        }

        return {
            root: main,
            candidateCount: candidates.length
        };
    };

    const getCandidateDepth = (element, root) => {
        let depth = 0;
        let parent = element.parentElement;

        while (parent && parent !== root) {
            if (parent.matches?.(USER_SELECTOR)) {
                depth++;
            }

            parent = parent.parentElement;
        }

        return depth;
    };

    const collectSnapshot = (root, position) => {
        const candidates = getCandidateElements(root);

        const records = candidates.map((element, index) => ({
            index,
            element,
            depth: getCandidateDepth(element, root),
            id: getDomMessageId(element),
            text: getCandidateText(element)
        }));

        const topLevel = records.filter(record => {
            let parent = record.element.parentElement;

            while (parent && parent !== root) {
                if (parent.matches?.(USER_SELECTOR)) {
                    return false;
                }

                parent = parent.parentElement;
            }

            return true;
        });

        return {
            scrollPosition: position,

            rawCandidateCount: records.length,

            nestedCandidateCount: records.filter(
                record => record.depth > 0
            ).length,

            topLevelCandidateCount: topLevel.length,

            messages: topLevel
                .filter(record => record.text)
                .map(record => ({
                    id: record.id,
                    text: record.text
                }))
        };
    };

    // ============================================================
    // 3. 滚动容器识别
    // ============================================================

    const getDocumentScroller = () =>
        document.scrollingElement ||
        document.documentElement;

    const isScrollableElement = element => {
        if (!element || element === document.body) {
            return false;
        }

        const style = getComputedStyle(element);

        const overflowAllowsScroll =
            /(auto|scroll|overlay)/.test(style.overflowY);

        const hasScrollRange =
            element.scrollHeight > element.clientHeight + 20;

        return overflowAllowsScroll && hasScrollRange;
    };

    const getElementAncestors = element => {
        const result = [];
        let current = element;

        while (current && current !== document.body) {
            result.push(current);
            current = current.parentElement;
        }

        return result;
    };

    const getScrollCandidates = root => {
        const messages = getCandidateElements(root);

        const candidates = new Map();

        const add = (element, source) => {
            if (!element || !isScrollableElement(element)) {
                return;
            }

            const existing = candidates.get(element);

            if (existing) {
                existing.sources.push(source);
            } else {
                candidates.set(element, {
                    element,
                    sources: [source]
                });
            }
        };

        // 路径 A：检查每个用户消息节点的祖先。
        for (const message of messages) {
            for (const ancestor of getElementAncestors(message)) {
                add(ancestor, '用户消息节点的祖先');
            }
        }

        // 路径 B：检查 main 内部所有真正可滚动的元素。
        for (const element of root.querySelectorAll('*')) {
            add(element, 'main 内部可滚动元素');
        }

        // 路径 C：检查 document 页面滚动区域。
        const documentScroller = getDocumentScroller();

        if (
            documentScroller &&
            documentScroller.scrollHeight >
                documentScroller.clientHeight + 20
        ) {
            add(documentScroller, 'document 页面滚动区域');
        }

        return [...candidates.values()].map(candidate => {
            const element = candidate.element;

            const containedMessageCount = messages.filter(
                message => element.contains(message)
            ).length;

            const maxScroll = Math.max(
                0,
                element.scrollHeight - element.clientHeight
            );

            return {
                ...candidate,
                containedMessageCount,
                maxScroll,
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight
            };
        });
    };

    const chooseScrollContainer = root => {
        const candidates = getScrollCandidates(root);

        if (!candidates.length) {
            throw new Error(
                '没有找到具有实际滚动范围的容器'
            );
        }

        // 优先选择包含最多用户消息节点的滚动区域。
        // 同等情况下，选择滚动范围较大的区域。
        candidates.sort((a, b) => {
            if (
                b.containedMessageCount !==
                a.containedMessageCount
            ) {
                return (
                    b.containedMessageCount -
                    a.containedMessageCount
                );
            }

            return b.maxScroll - a.maxScroll;
        });

        const selected = candidates[0];

        if (selected.containedMessageCount === 0) {
            throw new Error(
                '找到滚动容器，但该容器不包含用户消息节点'
            );
        }

        return {
            selected,
            candidates
        };
    };

    // ============================================================
    // 4. 滚动控制与稳定性检测
    // ============================================================

    const getPosition = element =>
        element.scrollTop;

    const getMetrics = element => ({
        top: element.scrollTop,
        height: element.scrollHeight,
        client: element.clientHeight,
        max: Math.max(
            0,
            element.scrollHeight - element.clientHeight
        )
    });

    const waitForStableScroll = async element => {
        let previous = getPosition(element);
        let stableCount = 0;
        let elapsed = 0;

        while (
            stableCount < CONFIG.stableCheckCount &&
            elapsed < CONFIG.maxStableWait
        ) {
            await sleep(CONFIG.stableCheckDelay);
            elapsed += CONFIG.stableCheckDelay;

            const current = getPosition(element);

            if (Math.abs(current - previous) <= 1) {
                stableCount++;
            } else {
                stableCount = 0;
            }

            previous = current;
        }

        await sleep(CONFIG.settleDelay);

        return {
            stable: stableCount >= CONFIG.stableCheckCount,
            elapsed
        };
    };

    const setScrollPosition = (element, position) => {
        element.scrollTop = position;
    };

    const getObservationKey = message =>
        message.id
            ? `id:${message.id}`
            : `text:${message.text}`;

    const findSnapshotOverlap = (left, right) => {
        const max = Math.min(left.length, right.length);

        for (let size = max; size > 0; size--) {
            let matched = true;

            for (let i = 0; i < size; i++) {
                if (
                    getObservationKey(
                        left[left.length - size + i]
                    ) !==
                    getObservationKey(right[i])
                ) {
                    matched = false;
                    break;
                }
            }

            if (matched) return size;
        }

        return 0;
    };

    // ============================================================
    // 5. 单方向扫描
    // ============================================================

    const scanDirection = async (
        root,
        scroller,
        direction,
        snapshots
    ) => {
        let steps = 0;
        let actualMovementCount = 0;
        let reachedBoundary = false;
        let noMovementCount = 0;

        const takeSnapshot = () => {
            snapshots.push(
                collectSnapshot(
                    root,
                    Math.round(getPosition(scroller))
                )
            );
        };

        await waitForStableScroll(scroller);
        takeSnapshot();

        while (
            steps < CONFIG.maxScrollStepsPerDirection
        ) {
            steps++;

            const before = getMetrics(scroller);

            const atTop = before.top <= 2;
            const atBottom = before.top >= before.max - 2;

            if (
                direction === 'up' && atTop
            ) {
                reachedBoundary = true;
                break;
            }

            if (
                direction === 'down' && atBottom
            ) {
                reachedBoundary = true;
                break;
            }

            const increment = Math.max(
                CONFIG.minScrollStep,
                Math.floor(
                    before.client * CONFIG.scrollStepRatio
                )
            );

            const target = direction === 'up'
                ? Math.max(0, before.top - increment)
                : Math.min(before.max, before.top + increment);

            if (Math.abs(target - before.top) <= 1) {
                break;
            }

            setScrollPosition(scroller, target);

            const stableResult =
                await waitForStableScroll(scroller);

            const after = getMetrics(scroller);

            const movement = Math.abs(
                after.top - before.top
            );

            if (movement > 1) {
                actualMovementCount++;
                noMovementCount = 0;
            } else {
                noMovementCount++;
            }

            takeSnapshot();

            // 页面没有发生实际滚动，不能假装扫描成功。
            if (noMovementCount >= 2) {
                break;
            }

            // 滚动高度发生变化时，重新使用最新 max。
            if (
                stableResult.stable &&
                direction === 'up' &&
                after.top <= 2
            ) {
                reachedBoundary = true;
                break;
            }

            if (
                stableResult.stable &&
                direction === 'down' &&
                after.top >= after.max - 2
            ) {
                reachedBoundary = true;
                break;
            }
        }

        const finalMetrics = getMetrics(scroller);

        if (
            direction === 'up' &&
            finalMetrics.top <= 2
        ) {
            reachedBoundary = true;
        }

        if (
            direction === 'down' &&
            finalMetrics.top >= finalMetrics.max - 2
        ) {
            reachedBoundary = true;
        }

        return {
            direction,
            steps,
            actualMovementCount,
            reachedBoundary,
            finalScrollTop: finalMetrics.top,
            finalScrollMax: finalMetrics.max,
            noMovementCount
        };
    };

    // ============================================================
    // 6. 双向扫描
    // ============================================================

    const mergeSnapshots = snapshots => {
        const ordered = [...snapshots].sort(
            (a, b) =>
                a.scrollPosition - b.scrollPosition
        );

        let messages = [];
        let overlapObservationCount = 0;
        let zeroOverlapTransitions = 0;

        for (const snapshot of ordered) {
            const current = snapshot.messages;

            if (!current.length) continue;

            if (!messages.length) {
                messages = [...current];
                continue;
            }

            const overlap = findSnapshotOverlap(
                messages,
                current
            );

            overlapObservationCount += overlap;

            if (overlap === 0) {
                zeroOverlapTransitions++;
            }

            messages.push(...current.slice(overlap));
        }

        return {
            messages,
            overlapObservationCount,
            zeroOverlapTransitions
        };
    };

    const collectDomMessages = async () => {
        const { root, candidateCount } =
            getTranscriptRoot();

        const {
            selected,
            candidates
        } = chooseScrollContainer(root);

        const scroller = selected.element;

        const originalScrollTop = scroller.scrollTop;
        const originalScrollBehavior =
            scroller.style.scrollBehavior;

        const snapshots = [];

        const initialMetrics = getMetrics(scroller);

        const result = {
            success: false,

            transcriptFound: true,
            initialCandidateCount: candidateCount,

            scrollContainer: {
                tagName: scroller.tagName,
                id: scroller.id || null,
                className:
                    typeof scroller.className === 'string'
                        ? scroller.className.slice(0, 300)
                        : null,

                sources: selected.sources,

                containedMessageCount:
                    selected.containedMessageCount,

                initialScrollTop: originalScrollTop,
                initialScrollHeight:
                    initialMetrics.height,
                initialClientHeight:
                    initialMetrics.client,
                initialScrollMax:
                    initialMetrics.max
            },

            candidateScrollContainers: candidates.map(item => ({
                tagName: item.element.tagName,
                id: item.element.id || null,
                className:
                    typeof item.element.className === 'string'
                        ? item.element.className.slice(0, 200)
                        : null,

                sources: item.sources,
                containedMessageCount:
                    item.containedMessageCount,

                scrollHeight: item.scrollHeight,
                clientHeight: item.clientHeight,
                maxScroll: item.maxScroll
            })),

            initialPositionIsBottom:
                originalScrollTop >= initialMetrics.max - 2,

            upScan: null,
            downScan: null,

            scanComplete: false,

            snapshotCount: 0,
            rawCandidateCount: 0,
            nestedCandidateCount: 0,

            domMessageCount: 0,
            overlapObservationCount: 0,
            zeroOverlapTransitions: 0,

            messages: []
        };

        scroller.style.scrollBehavior = 'auto';

        try {
            // 先确认脚本选中的滚动容器具有实际滚动范围。
            if (initialMetrics.max <= 2) {
                throw new Error(
                    '所选滚动容器没有有效滚动范围'
                );
            }

            // 第一次扫描：从当前页面位置向顶部。
            // 如果刷新后页面位于底部，则从底部开始。
            result.upScan = await scanDirection(
                root,
                scroller,
                'up',
                snapshots
            );

            if (!result.upScan.reachedBoundary) {
                throw new Error(
                    '向上扫描未能确认到达顶部'
                );
            }

            // 到达顶部后，第二次扫描向底部。
            result.downScan = await scanDirection(
                root,
                scroller,
                'down',
                snapshots
            );

            if (!result.downScan.reachedBoundary) {
                throw new Error(
                    '向下扫描未能确认到达底部'
                );
            }

            const merged = mergeSnapshots(snapshots);

            result.snapshotCount = snapshots.length;

            result.rawCandidateCount =
                snapshots.reduce(
                    (sum, item) =>
                        sum + item.rawCandidateCount,
                    0
                );

            result.nestedCandidateCount =
                snapshots.reduce(
                    (sum, item) =>
                        sum + item.nestedCandidateCount,
                    0
                );

            result.domMessageCount =
                merged.messages.length;

            result.overlapObservationCount =
                merged.overlapObservationCount;

            result.zeroOverlapTransitions =
                merged.zeroOverlapTransitions;

            result.messages = merged.messages.map(
                (message, index) => ({
                    index: index + 1,
                    id: message.id,
                    text: message.text,
                    textLength: message.text.length
                })
            );

            result.scanComplete =
                result.upScan.reachedBoundary &&
                result.downScan.reachedBoundary &&
                result.upScan.actualMovementCount > 0 &&
                result.downScan.actualMovementCount > 0;

            result.success = result.scanComplete;

            result.candidateRecognition = {
                selector: USER_SELECTOR,
                primaryContentSelector: '.contents',

                groupingRule:
                    '仅选择没有祖先 user-message 候选节点的顶层候选作为消息代表',

                nestedCandidatesPreservedInDiagnostics: true,
                finalExportDeduplication: false
            };

            result.snapshotStructure = snapshots.map(
                snapshot => ({
                    scrollPosition:
                        snapshot.scrollPosition,

                    rawCandidateCount:
                        snapshot.rawCandidateCount,

                    nestedCandidateCount:
                        snapshot.nestedCandidateCount,

                    topLevelCandidateCount:
                        snapshot.topLevelCandidateCount,

                    messageCount:
                        snapshot.messages.length
                })
            );

        } finally {
            // 不论扫描是否成功，恢复执行前的滚动位置。
            scroller.scrollTop = originalScrollTop;

            scroller.style.scrollBehavior =
                originalScrollBehavior;

            await sleep(150);

            result.restoredScrollTop =
                scroller.scrollTop;
        }

        return result;
    };

    // ============================================================
    // 7. API 与 DOM 消息比较
    // ============================================================

    const compareMessages = (
        apiMessages,
        domMessages
    ) => {
        const apiTexts = apiMessages.map(
            item => normalizeText(item.text)
        );

        const domTexts = domMessages.map(
            item => normalizeText(item.text)
        );

        const n = apiTexts.length;
        const m = domTexts.length;

        const dp = Array.from(
            { length: n + 1 },
            () => new Uint32Array(m + 1)
        );

        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                if (apiTexts[i] === domTexts[j]) {
                    dp[i][j] = dp[i + 1][j + 1] + 1;
                } else {
                    dp[i][j] = Math.max(
                        dp[i + 1][j],
                        dp[i][j + 1]
                    );
                }
            }
        }

        const matchedPairs = [];

        let i = 0;
        let j = 0;

        while (i < n && j < m) {
            if (apiTexts[i] === domTexts[j]) {
                matchedPairs.push({
                    apiIndex: i,
                    domIndex: j
                });

                i++;
                j++;

            } else if (
                dp[i + 1][j] >= dp[i][j + 1]
            ) {
                i++;
            } else {
                j++;
            }
        }

        const matchedApi = new Set(
            matchedPairs.map(pair => pair.apiIndex)
        );

        const matchedDom = new Set(
            matchedPairs.map(pair => pair.domIndex)
        );

        const missingFromDom = apiMessages
            .map((message, index) => ({
                message,
                index
            }))
            .filter(item => !matchedApi.has(item.index))
            .map(item => ({
                apiIndex: item.index + 1,
                id: item.message.id,
                text: item.message.text
            }));

        const extraInDom = domMessages
            .map((message, index) => ({
                message,
                index
            }))
            .filter(item => !matchedDom.has(item.index))
            .map(item => ({
                domIndex: item.index + 1,
                id: item.message.id,
                text: item.message.text
            }));

        const countMatch = n === m;

        const exactSequenceMatch =
            countMatch &&
            matchedPairs.length === n &&
            missingFromDom.length === 0 &&
            extraInDom.length === 0;

        return {
            apiCount: n,
            domCount: m,

            countMatch,

            orderMatch:
                matchedPairs.every(
                    (pair, index, array) =>
                        index === 0 ||
                        (
                            pair.apiIndex >
                                array[index - 1].apiIndex &&
                            pair.domIndex >
                                array[index - 1].domIndex
                        )
                ),

            contentMatch: exactSequenceMatch,
            exactSequenceMatch,

            matchedCount: matchedPairs.length,

            matchedPairs: matchedPairs.map(pair => ({
                apiIndex: pair.apiIndex + 1,
                domIndex: pair.domIndex + 1
            })),

            missingFromDom,
            extraInDom
        };
    };

    // ============================================================
    // 8. 报告生成
    // ============================================================

    const buildReport = async () => {
        if (!conversationId) {
            throw new Error(
                '无法从 URL 解析 conversationId'
            );
        }

        const report = {
            diagnostic:
                'ChatGPT API vs DOM User Message Consistency',

            version: VERSION,
            timestamp: new Date().toISOString(),

            conversationId,
            url: location.href,

            status: 'INCONCLUSIVE',

            api: null,
            dom: null,
            comparison: null,

            completeness: null,

            errors: [],

            reportIntegrity: {
                complete: true,
                characterLimit: CONFIG.maxReportChars,
                messageTextTruncated: false
            }
        };

        try {
            report.api = await getApiData(conversationId);
        } catch (error) {
            report.errors.push({
                stage: 'API',
                message: String(
                    error?.message || error
                )
            });
        }

        try {
            report.dom = await collectDomMessages();
        } catch (error) {
            report.errors.push({
                stage: 'DOM',
                message: String(
                    error?.message || error
                )
            });
        }

        if (
            report.api?.success &&
            report.dom?.success
        ) {
            report.comparison = compareMessages(
                report.api.userMessages,
                report.dom.messages
            );
        }

        const apiComplete =
            report.api?.complete === true;

        const domComplete =
            report.dom?.scanComplete === true;

        const exactMatch =
            report.comparison?.exactSequenceMatch === true;

        report.completeness = {
            apiComplete,
            domScanComplete: domComplete,
            exactSequenceMatch: exactMatch,

            apiPaginationConfirmed:
                report.api?.pagination?.hasPreviousPage === false,

            passRequirements: [
                'API 请求成功',
                'API 明确确认不存在上一页',
                'DOM 双向扫描实际发生滚动',
                'DOM 扫描成功到达顶部和底部',
                'API 与 DOM 用户消息数量一致',
                'API 与 DOM 用户消息顺序一致',
                'API 与 DOM 用户消息文本完全一致'
            ]
        };

        if (
            apiComplete &&
            domComplete &&
            exactMatch
        ) {
            report.status = 'PASS';

        } else if (
            report.api?.success &&
            report.dom?.success &&
            report.comparison
        ) {
            report.status = 'MISMATCH';

        } else {
            report.status = 'INCONCLUSIVE';
        }

        return report;
    };

    // ============================================================
    // 9. 单条日志输出
    // ============================================================

    try {
        const report = await buildReport();

        let output = JSON.stringify(report);

        if (output.length > CONFIG.maxReportChars) {
            report.reportIntegrity.complete = false;

            report.reportIntegrity.actualCharacterCount =
                output.length;

            report.reportIntegrity.reason =
                '报告超过安全输出上限。移除非消息正文的快照结构后重新检查。';

            report.status = 'INCONCLUSIVE';

            if (report.dom?.snapshotStructure) {
                delete report.dom.snapshotStructure;
            }

            if (report.dom?.candidateScrollContainers) {
                delete report.dom.candidateScrollContainers;
            }

            output = JSON.stringify(report);
        }

        if (output.length > CONFIG.maxReportChars) {
            const fallback = {
                diagnostic:
                    'ChatGPT API vs DOM User Message Consistency',

                version: VERSION,
                timestamp: report.timestamp,
                conversationId: report.conversationId,

                status: 'INCONCLUSIVE',

                reason:
                    '完整报告超过安全输出上限。未截断消息文本，也未输出不完整消息列表。',

                reportIntegrity: {
                    complete: false,
                    characterLimit: CONFIG.maxReportChars,
                    actualCharacterCount: output.length,
                    messageTextTruncated: false
                },

                apiUserMessageCount:
                    report.api?.userMessageCount ?? null,

                domMessageCount:
                    report.dom?.domMessageCount ?? null,

                scrollContainer:
                    report.dom?.scrollContainer ?? null,

                errors: report.errors
            };

            console.log(
                `${PREFIX} ${JSON.stringify(fallback)}`
            );

            return;
        }

        console.log(`${PREFIX} ${output}`);

    } catch (error) {
        console.log(
            `${PREFIX} ${JSON.stringify({
                diagnostic:
                    'ChatGPT API vs DOM User Message Consistency',

                version: VERSION,
                timestamp: new Date().toISOString(),

                status: 'INCONCLUSIVE',

                error: String(
                    error?.message || error
                )
            })}`
        );
    }
})();
