// ==UserScript==
// @name         B站动态下载图片
// @namespace    habixz.Bilibili.DynamicImageDownload
// @version      1.1.0
// @description  为 B 站动态大图预览添加“下载原图”按钮，并使用浏览器原生下载流程触发下载，同时给出页面内提示。
// @author       habixz
// @license      GPL-3.0
// @match        https://t.bilibili.com/*
// @match        https://www.bilibili.com/opus/*
// @match        https://space.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @run-at       document-idle
// ==/UserScript==

/* jshint esversion: 11 */
(function() {
    'use strict';

    /**
     * 下载按钮图标。
     * 这里直接内联 SVG，避免再引入额外资源。
     */
    const DOWNLOAD_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" style="width:16px;height:16px;transform:none !important;" fill="currentColor"><path d="M5 20h14v-2H5v2zm14-11h-4V3H9v6H5l7 7 7-7z"/></svg>';

    /**
     * 脚本内部使用的常量。
     * 它们分别控制：
     * 1. 样式和按钮的去重标记；
     * 2. 下载按钮的忙碌态样式；
     * 3. 打开预览后的短时扫描窗口；
     * 4. Blob 下载请求的超时；
     * 5. 预览上下文的保留时长。
     */
    const SCRIPT_FLAG = 'data-habixz-bili-dynamic-download';
    const BUTTON_FLAG = 'data-habixz-download-button';
    const BUTTON_BUSY_CLASS = 'is-downloading';
    const SCAN_WINDOW_MS = 2500;
    const BLOB_DOWNLOAD_TIMEOUT_MS = 20000;
    const PREVIEW_CONTEXT_TTL_MS = 15000;
    const BLOB_URL_REVOKE_DELAY_MS = 30000;
    const TOAST_DURATION_MS = 2600;
    const LOCKED_TOAST_COOLDOWN_MS = 1200;
    const DOWNLOAD_DIALOG_FAILSAFE_MS = 60000;

    /**
     * 运行时状态统一收口到一个对象里，避免状态散落。
     */
    const state = {
        scanObserver: null,
        scanStopTimer: 0,
        lastPreviewContext: null,
        currentDownloadTask: null,
        lastLockedToastAt: 0,
        toastWrap: null,
        toastNode: null,
        toastIconNode: null,
        toastTextNode: null,
        toastHideTimer: 0,
        toastRemoveTimer: 0
    };

    injectStyle();
    setupPreviewEntryWatcher();
    setupDownloadLockWatcher();
    scanAndMountButtons(document);

    /**
     * 只在“用户可能打开图片预览”时启动短时扫描。
     * 这样可以避免对整页 DOM 做长期、重负载的监听。
     */
    function setupPreviewEntryWatcher() {
        document.addEventListener('click', handleDocumentClick, true);
    }

    /**
     * 监听窗口焦点变化，用来推断浏览器原生下载确认框是否已被处理。
     * 注意：网页拿不到“确认/取消”的精确信号，这里只能用焦点离开再返回来近似判断。
     */
    function setupDownloadLockWatcher() {
        window.addEventListener('blur', handleWindowBlur, true);
        window.addEventListener('focus', handleWindowFocus, true);
        document.addEventListener('visibilitychange', handleVisibilityChange, true);
    }

    /**
     * 当浏览器原生下载确认框弹出时，页面通常会失去焦点。
     * 这里记录这个状态，后面在焦点返回时再解锁下载按钮。
     */
    function handleWindowBlur() {
        const task = getActiveDownloadTask();
        if (!task) {
            return;
        }

        task.sawBlur = true;
    }

    /**
     * 焦点回到页面时，如果之前确实离开过焦点，
     * 就认为用户已经处理了浏览器下载确认框。
     */
    function handleWindowFocus() {
        const task = getActiveDownloadTask();
        if (!task || !task.waitingFocusReturn) {
            return;
        }

        if (!task.sawBlur) {
            return;
        }

        releaseDownloadLock(task, true);
    }

    /**
     * 某些浏览器切到原生对话框时会触发可见性变化，这里也兼容一下。
     */
    function handleVisibilityChange() {
        const task = getActiveDownloadTask();
        if (!task) {
            return;
        }

        if (document.hidden) {
            task.sawBlur = true;
            return;
        }

        if (task.waitingFocusReturn && task.sawBlur) {
            releaseDownloadLock(task, true);
        }
    }

    /**
     * 处理页面点击。
     * 这里只关心两类点击：
     * 1. 点击了脚本自己插入的下载按钮；
     * 2. 点击了可能会打开图片预览的内容图片。
     * @param {MouseEvent} event 点击事件。
     */
    function handleDocumentClick(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        if (target.closest('[' + BUTTON_FLAG + ']')) {
            return;
        }

        /**
         * 如果当前点击发生在已经打开的预览弹层内部，
         * 直接尝试补挂按钮即可，不需要再开观察器。
         */
        const album = target.closest('.bili-album');
        if (album) {
            scanAndMountButtons(album);
            return;
        }

        const previewContext = collectPreviewContext(target);
        if (!previewContext) {
            return;
        }

        state.lastPreviewContext = previewContext;
        scheduleAlbumScan();
    }

    /**
     * 开始一次短时扫描。
     * 扫描逻辑会先立刻查找一次当前页面，
     * 如果此时弹层尚未插入，再用短时 MutationObserver 等待弹层出现。
     */
    function scheduleAlbumScan() {
        stopPendingAlbumScan();

        const mountedNow = scanAndMountButtons(document);
        if (mountedNow > 0) {
            return;
        }

        state.scanObserver = new MutationObserver((mutations) => {
            let mountedCount = 0;

            for (const mutation of mutations) {
                for (const addedNode of mutation.addedNodes) {
                    if (!(addedNode instanceof HTMLElement)) {
                        continue;
                    }

                    if (!isAlbumRelatedNode(addedNode)) {
                        continue;
                    }

                    mountedCount += scanAndMountButtons(addedNode);
                }
            }

            if (mountedCount > 0) {
                stopPendingAlbumScan();
            }
        });

        state.scanObserver.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });

        state.scanStopTimer = window.setTimeout(() => {
            stopPendingAlbumScan();
        }, SCAN_WINDOW_MS);
    }

    /**
     * 结束本轮短时扫描，释放观察器和定时器。
     */
    function stopPendingAlbumScan() {
        if (state.scanObserver) {
            state.scanObserver.disconnect();
            state.scanObserver = null;
        }

        if (state.scanStopTimer) {
            window.clearTimeout(state.scanStopTimer);
            state.scanStopTimer = 0;
        }
    }

    /**
     * 判断新增节点是否与图片预览弹层相关。
     * 只对相关节点继续扫描，减少无意义的 DOM 遍历。
     * @param {HTMLElement} node 新增节点。
     * @returns {boolean}
     */
    function isAlbumRelatedNode(node) {
        if (node.matches('.bili-album, .bili-album__watch, .bili-album__watch__control')) {
            return true;
        }

        if (node.closest('.bili-album')) {
            return true;
        }

        return Boolean(
            node.querySelector('.bili-album, .bili-album__watch, .bili-album__watch__control')
        );
    }

    /**
     * 在给定节点范围内查找所有图片预览弹层，并挂载按钮。
     * @param {ParentNode} root 扫描起点。
     * @returns {number} 成功找到控制栏并确认按钮存在的弹层数量。
     */
    function scanAndMountButtons(root) {
        const albums = collectAlbumRoots(root);
        let mountedCount = 0;

        for (const album of albums) {
            if (ensureDownloadButton(album)) {
                mountedCount += 1;
            }
        }

        return mountedCount;
    }

    /**
     * 从当前扫描范围里提取所有可能的弹层根节点。
     * @param {ParentNode} root 扫描起点。
     * @returns {Set<HTMLElement>}
     */
    function collectAlbumRoots(root) {
        const albums = new Set();

        if (root instanceof HTMLElement && root.matches('.bili-album')) {
            albums.add(root);
        }

        if (root instanceof HTMLElement) {
            const parentAlbum = root.closest('.bili-album');
            if (parentAlbum) {
                albums.add(parentAlbum);
            }
        }

        if ('querySelectorAll' in root) {
            for (const album of root.querySelectorAll('.bili-album')) {
                albums.add(album);
            }
        }

        return albums;
    }

    /**
     * 确保单个弹层里存在下载按钮。
     * @param {HTMLElement} album 图片预览弹层根节点。
     * @returns {boolean} 如果控制栏已就绪且按钮已存在，返回 true。
     */
    function ensureDownloadButton(album) {
        if (!(album instanceof HTMLElement)) {
            return false;
        }

        const controlBar = album.querySelector('.bili-album__watch__control');
        if (!controlBar) {
            return false;
        }

        const existingButton = controlBar.querySelector('[' + BUTTON_FLAG + ']');
        if (existingButton) {
            return true;
        }

        const referenceButton = controlBar.querySelector('.bili-album__watch__control__option');
        if (!referenceButton) {
            return false;
        }

        const button = buildDownloadButton(referenceButton);

        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await handleDownload(album, button);
        });

        button.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
                return;
            }

            event.preventDefault();
            button.click();
        });

        controlBar.appendChild(button);
        return true;
    }

    /**
     * 构造下载按钮。
     * 这里保留 B 站现有类名，以尽量复用站内样式。
     * 同时补齐可聚焦和键盘操作能力，避免只有鼠标才能点击。
     * @param {Element} referenceButton B 站现有按钮。
     * @returns {HTMLElement}
     */
    function buildDownloadButton(referenceButton) {
        const button = document.createElement(referenceButton.tagName.toLowerCase());
        const text = document.createElement('span');

        button.className = referenceButton.className;
        button.setAttribute(BUTTON_FLAG, 'true');
        button.setAttribute('title', '下载原图');
        button.setAttribute('tabindex', '0');
        button.setAttribute('role', 'button');
        button.setAttribute('aria-label', '下载原图');

        if (button.tagName === 'BUTTON') {
            button.setAttribute('type', 'button');
        }

        button.insertAdjacentHTML('beforeend', DOWNLOAD_ICON_SVG);

        text.className = 'habixz-bili-download-text';
        text.textContent = '下载原图';
        button.appendChild(text);

        return button;
    }

    /**
     * 处理下载逻辑。
     * 这里会：
     * 1. 防止重复点击造成并发下载；
     * 2. 根据当前图片和预览上下文生成更友好的文件名；
     * 3. 按策略顺序触发浏览器下载。
     * @param {HTMLElement} album 当前预览弹层。
     * @param {HTMLElement} button 当前下载按钮。
     */
    async function handleDownload(album, button) {
        if (getActiveDownloadTask()) {
            notifyDownloadLocked();
            return;
        }

        if (button.dataset.downloading === 'true') {
            notifyDownloadLocked();
            return;
        }

        const imageUrl = getCurrentImageUrl(album);
        if (!imageUrl) {
            showToast('未找到当前图片地址', 'error');
            return;
        }

        const downloadContext = resolveDownloadContext(album, imageUrl);
        const fileName = buildDownloadFileName(imageUrl, downloadContext);

        const task = beginDownloadLock();
        showToast('正在等待浏览器下载确认...', 'info');

        try {
            const result = await requestBrowserManagedDownload(imageUrl, fileName);
            showToast(result.message, result.type);

            if (!result.waitForDialogResolution) {
                releaseDownloadLock(task, false);
            }
        } catch (error) {
            console.error('[B站动态下载图片] 下载失败:', error);
            releaseDownloadLock(task, false);
            showToast('下载失败: ' + getErrorMessage(error), 'error');
        }
    }

    /**
     * 根据图片地址选择合适的策略顺序。
     * 同源资源优先直接交给浏览器下载；
     * 跨域图片优先用 Blob 方式，让浏览器更稳定地接管下载。
     * @param {string} imageUrl 图片地址。
     * @returns {Array<'direct'|'blob'|'open'>}
     */
    function getDownloadStrategyOrder(imageUrl) {
        try {
            const imageOrigin = new URL(imageUrl, location.href).origin;
            if (imageOrigin === location.origin) {
                return ['direct', 'blob', 'open'];
            }
        } catch (error) {
            // 地址解析失败时，直接走更稳妥的 Blob 策略。
        }

        return ['blob', 'direct', 'open'];
    }

    /**
     * 按策略顺序请求浏览器下载。
     * 这样主流程只关心“我要下载”，不用关心具体落到哪种实现。
     * @param {string} imageUrl 图片地址。
     * @param {string} fileName 期望文件名。
     * @returns {Promise<{message: string, type: 'success'|'info', waitForDialogResolution: boolean}>}
     */
    async function requestBrowserManagedDownload(imageUrl, fileName) {
        const strategyOrder = getDownloadStrategyOrder(imageUrl);
        const errors = [];

        for (const strategy of strategyOrder) {
            try {
                if (strategy === 'direct') {
                    return attemptDirectDownload(imageUrl, fileName);
                }

                if (strategy === 'blob') {
                    return await attemptBlobDownload(imageUrl, fileName);
                }

                if (strategy === 'open') {
                    return attemptOpenImage(imageUrl);
                }
            } catch (error) {
                errors.push(strategy + ': ' + getErrorMessage(error));
            }
        }

        throw new Error(errors.join(' | ') || '未知错误');
    }

    /**
     * 直接把原图地址交给浏览器。
     * 这种方式最轻，不需要先把整张图片读进页面内存。
     * @param {string} imageUrl 图片地址。
     * @param {string} fileName 文件名。
     * @returns {{message: string, type: 'success', waitForDialogResolution: boolean}}
     */
    function attemptDirectDownload(imageUrl, fileName) {
        triggerBrowserDownload(imageUrl, fileName, false);
        return {
            message: '已向浏览器发起下载请求: ' + fileName,
            type: 'success',
            waitForDialogResolution: true
        };
    }

    /**
     * 用 fetch + Blob 的方式触发浏览器下载。
     * 这种方式会稍微占一点内存，但对跨域图片通常更稳定，
     * 也能更稳地保住脚本生成的文件名。
     * @param {string} imageUrl 图片地址。
     * @param {string} fileName 文件名。
     * @returns {Promise<{message: string, type: 'success', waitForDialogResolution: boolean}>}
     */
    async function attemptBlobDownload(imageUrl, fileName) {
        const controller = new AbortController();
        const timerId = window.setTimeout(() => {
            controller.abort();
        }, BLOB_DOWNLOAD_TIMEOUT_MS);

        try {
            const response = await fetch(imageUrl, {
                credentials: 'omit',
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }

            const blob = await response.blob();
            const extension = getFileExtensionFromBlobType(blob.type) || getFileExtensionFromUrl(imageUrl);
            const finalFileName = ensureFileNameExtension(fileName, extension);
            const blobUrl = URL.createObjectURL(blob);

            triggerBrowserDownload(blobUrl, finalFileName, false);

            window.setTimeout(() => {
                URL.revokeObjectURL(blobUrl);
            }, BLOB_URL_REVOKE_DELAY_MS);

            return {
                message: '已交给浏览器下载: ' + finalFileName,
                type: 'success',
                waitForDialogResolution: true
            };
        } finally {
            window.clearTimeout(timerId);
        }
    }

    /**
     * 最后兜底：直接打开原图页面。
     * 这不一定会进入下载器，但至少能让用户立刻感知到脚本已经执行了动作。
     * @param {string} imageUrl 图片地址。
     * @returns {{message: string, type: 'info', waitForDialogResolution: boolean}}
     */
    function attemptOpenImage(imageUrl) {
        const link = document.createElement('a');
        link.href = imageUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        document.body.appendChild(link);
        link.click();
        link.remove();

        return {
            message: '站点限制了直接下载，已为你打开原图页面',
            type: 'info',
            waitForDialogResolution: false
        };
    }

    /**
     * 从当前弹层里读取正在显示的图片地址。
     * B 站图片链接后面常带有尺寸/格式后缀，这里统一剥掉，回到原图地址。
     * @param {HTMLElement} album 当前预览弹层。
     * @returns {string}
     */
    function getCurrentImageUrl(album) {
        const image = album.querySelector('.bili-album__watch__content img');
        const rawUrl = image ? (image.currentSrc || image.getAttribute('src') || '') : '';
        return normalizeImageUrl(rawUrl);
    }

    /**
     * 解析当前下载所需的上下文信息。
     * 这些信息用于生成更友好的文件名，例如作者名、动态 ID、图片序号。
     * @param {HTMLElement} album 当前预览弹层。
     * @param {string} imageUrl 当前图片原图地址。
     * @returns {{authorName: string, dynamicId: string, imageIndex: number}}
     */
    function resolveDownloadContext(album, imageUrl) {
        const freshPreviewContext = isFreshPreviewContext(state.lastPreviewContext)
            ? state.lastPreviewContext
            : null;

        return {
            authorName: detectAuthorName(album) || (freshPreviewContext ? freshPreviewContext.authorName : ''),
            dynamicId: detectDynamicId(album) || (freshPreviewContext ? freshPreviewContext.dynamicId : ''),
            imageIndex: detectCurrentImageIndex(album, imageUrl, freshPreviewContext)
        };
    }

    /**
     * 判断预览上下文是否仍然新鲜。
     * 只保留最近一次点击图片后的一小段时间，避免旧上下文误伤新下载。
     * @param {{capturedAt: number}|null} previewContext 预览上下文。
     * @returns {boolean}
     */
    function isFreshPreviewContext(previewContext) {
        return Boolean(
            previewContext &&
            Date.now() - previewContext.capturedAt <= PREVIEW_CONTEXT_TTL_MS
        );
    }

    /**
     * 收集一次“打开预览前”的上下文。
     * 这一步主要是为了在弹层打开后，仍然能尽量知道：
     * 1. 用户刚才点的是哪一张图；
     * 2. 这一组图一共有几张；
     * 3. 这一条动态是谁发的、动态 ID 是什么。
     * @param {HTMLElement} target 当前点击目标。
     * @returns {{capturedAt: number, imageUrl: string, imageIndex: number, galleryImages: string[], authorName: string, dynamicId: string}|null}
     */
    function collectPreviewContext(target) {
        const image = resolvePreviewTriggerImage(target);
        if (!image) {
            return null;
        }

        const imageUrl = normalizeImageUrl(image.currentSrc || image.getAttribute('src') || '');
        if (!imageUrl) {
            return null;
        }

        const galleryImages = collectGalleryImages(image, imageUrl);

        return {
            capturedAt: Date.now(),
            imageUrl: imageUrl,
            imageIndex: findImageIndex(galleryImages, imageUrl) || 1,
            galleryImages: galleryImages,
            authorName: detectAuthorName(image) || detectAuthorName(document),
            dynamicId: detectDynamicId(image) || extractDynamicIdFromLocation(location.href)
        };
    }

    /**
     * 解析当前点击目标是否为“可能打开大图预览”的图片。
     * 这里故意做得保守一些，尽量排除头像、图标等无关图片。
     * @param {HTMLElement} target 点击目标。
     * @returns {HTMLImageElement|null}
     */
    function resolvePreviewTriggerImage(target) {
        if (target instanceof HTMLImageElement && isLikelyDynamicContentImage(target)) {
            return target;
        }

        const container = target.closest(
            '.b-img__inner, .bili-album__preview__picture, .bili-album__preview, .opus-module-content, .dyn-card-opus, figure, picture'
        );

        if (!container) {
            return null;
        }

        const image = container.querySelector('img');
        if (image instanceof HTMLImageElement && isLikelyDynamicContentImage(image)) {
            return image;
        }

        return null;
    }

    /**
     * 判断一张图片是否像“动态正文里的内容图”。
     * 这一步主要用于过滤头像、表情、图标等无关资源。
     * @param {HTMLImageElement} image 图片元素。
     * @returns {boolean}
     */
    function isLikelyDynamicContentImage(image) {
        const rawUrl = image.currentSrc || image.getAttribute('src') || '';
        const normalizedUrl = normalizeImageUrl(rawUrl);
        if (!normalizedUrl) {
            return false;
        }

        if (!/(?:hdslb\.com|biliimg\.com)/i.test(normalizedUrl) &&
            !/\.(?:jpe?g|png|webp|avif|gif|bmp)$/i.test(getPathName(normalizedUrl))) {
            return false;
        }

        const classText = [
            image.className,
            image.getAttribute('alt') || '',
            image.getAttribute('data-testid') || ''
        ].join(' ');

        if (/(?:avatar|face|icon|emoji|pendant)/i.test(classText)) {
            return false;
        }

        const width = image.naturalWidth || image.width || 0;
        const height = image.naturalHeight || image.height || 0;

        if (width > 0 && height > 0 && width < 80 && height < 80) {
            return false;
        }

        return true;
    }

    /**
     * 为当前点击图片收集同组图片列表。
     * 后续即使用户在弹层中左右切换，也能尽量推导出当前是第几张。
     * @param {HTMLImageElement} image 被点击的图片。
     * @param {string} imageUrl 该图片的原图地址。
     * @returns {string[]}
     */
    function collectGalleryImages(image, imageUrl) {
        const galleryContainer = findGalleryContainer(image);
        const urls = [];

        if (galleryContainer) {
            for (const galleryImage of galleryContainer.querySelectorAll('img')) {
                if (!(galleryImage instanceof HTMLImageElement)) {
                    continue;
                }

                if (!isLikelyDynamicContentImage(galleryImage)) {
                    continue;
                }

                const url = normalizeImageUrl(galleryImage.currentSrc || galleryImage.getAttribute('src') || '');
                if (!url || urls.includes(url)) {
                    continue;
                }

                urls.push(url);
            }
        }

        if (!urls.includes(imageUrl)) {
            urls.unshift(imageUrl);
        }

        return urls;
    }

    /**
     * 尽量找到“同一组图片”的容器。
     * 这里沿着祖先节点向上试探，只选图片数量合理的那一层，避免把整页图片都混进来。
     * @param {HTMLImageElement} image 当前点击图片。
     * @returns {HTMLElement|null}
     */
    function findGalleryContainer(image) {
        let currentNode = image.parentElement;
        let bestContainer = null;
        let depth = 0;

        while (currentNode && currentNode !== document.body && depth < 7) {
            const images = Array.from(currentNode.querySelectorAll('img'))
                .filter((item) => item instanceof HTMLImageElement && isLikelyDynamicContentImage(item));

            if (images.length >= 1 && images.length <= 20) {
                bestContainer = currentNode;

                if (images.length > 1) {
                    return bestContainer;
                }
            }

            if (currentNode.matches('article, main, section')) {
                break;
            }

            currentNode = currentNode.parentElement;
            depth += 1;
        }

        return bestContainer;
    }

    /**
     * 尝试根据弹层里的图片列表和点击前上下文，推导当前是第几张图。
     * @param {HTMLElement} album 当前预览弹层。
     * @param {string} imageUrl 当前原图地址。
     * @param {{imageIndex: number, galleryImages: string[]}|null} previewContext 点击前上下文。
     * @returns {number}
     */
    function detectCurrentImageIndex(album, imageUrl, previewContext) {
        const albumImages = [];

        for (const image of album.querySelectorAll('img')) {
            if (!(image instanceof HTMLImageElement)) {
                continue;
            }

            const url = normalizeImageUrl(image.currentSrc || image.getAttribute('src') || '');
            if (!url || albumImages.includes(url)) {
                continue;
            }

            albumImages.push(url);
        }

        const albumIndex = findImageIndex(albumImages, imageUrl);
        if (albumIndex > 0) {
            return albumIndex;
        }

        if (previewContext) {
            const previewIndex = findImageIndex(previewContext.galleryImages, imageUrl);
            if (previewIndex > 0) {
                return previewIndex;
            }

            return previewContext.imageIndex || 1;
        }

        return 1;
    }

    /**
     * 在图片列表里查找某个图片的序号。
     * 返回值从 1 开始，方便直接用于“第 N 张”命名。
     * @param {string[]} imageList 图片地址列表。
     * @param {string} imageUrl 目标图片地址。
     * @returns {number}
     */
    function findImageIndex(imageList, imageUrl) {
        const index = imageList.indexOf(imageUrl);
        return index >= 0 ? index + 1 : 0;
    }

    /**
     * 生成更友好的下载文件名。
     * 命名格式优先为：
     * `B站动态_作者名_2026-08-10_动态123456_第03张.jpg`
     * 日期取下载当天（本地时区），方便后续按日期追溯归档。
     * @param {string} imageUrl 图片地址。
     * @param {{authorName: string, dynamicId: string, imageIndex: number}} context 命名上下文。
     * @returns {string}
     */
    function buildDownloadFileName(imageUrl, context) {
        const parts = ['B站动态'];
        const extension = getFileExtensionFromUrl(imageUrl) || '.jpg';

        if (context.authorName) {
            parts.push(context.authorName);
        }

        parts.push(formatDateStamp(new Date()));

        if (context.dynamicId) {
            parts.push('动态' + context.dynamicId);
        }

        if (context.imageIndex) {
            parts.push('第' + String(context.imageIndex).padStart(2, '0') + '张');
        }

        return ensureFileNameExtension(sanitizeFileName(parts.join('_')), extension);
    }

    /**
     * 把日期格式化为 `YYYY-MM-DD` 形式的字符串。
     * 这里手动拼接，避免 toLocaleDateString 在不同系统上的输出差异。
     * @param {Date} date 需要格式化的日期。
     * @returns {string}
     */
    function formatDateStamp(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');

        return year + '-' + month + '-' + day;
    }

    /**
     * 尝试在当前动态附近读取作者名。
     * 这里会优先从离当前节点最近的动态卡片里找，找不到再退回整个文档。
     * @param {ParentNode|HTMLElement|Document} root 搜索起点。
     * @returns {string}
     */
    function detectAuthorName(root) {
        const searchRoot = getNearestCardRoot(root) || document;
        const selectors = [
            '.opus-author__name',
            '.opus-module-author__name',
            '.bili-dyn-title__text',
            '.dyn-author__name',
            '.up-name',
            '.user-name',
            'a[href*="space.bilibili.com"]'
        ];

        for (const selector of selectors) {
            const node = searchRoot.querySelector(selector);
            if (!node) {
                continue;
            }

            const text = compactText(node.textContent || node.getAttribute('title') || '');
            if (!text) {
                continue;
            }

            if (text.length > 40) {
                continue;
            }

            return text;
        }

        return '';
    }

    /**
     * 尝试解析动态 ID。
     * 优先从最近的动态卡片属性和链接中提取，最后再回退到当前地址。
     * @param {ParentNode|HTMLElement|Document} root 搜索起点。
     * @returns {string}
     */
    function detectDynamicId(root) {
        let currentNode = root instanceof HTMLElement ? root : null;

        while (currentNode && currentNode !== document.body) {
            const attrId = extractDynamicIdFromNode(currentNode);
            if (attrId) {
                return attrId;
            }

            const anchor = currentNode.matches('a[href*="/opus/"], a[href*="t.bilibili.com/"]')
                ? currentNode
                : currentNode.querySelector('a[href*="/opus/"], a[href*="t.bilibili.com/"]');

            if (anchor) {
                const hrefId = extractDynamicIdFromLocation(anchor.getAttribute('href') || '');
                if (hrefId) {
                    return hrefId;
                }
            }

            currentNode = currentNode.parentElement;
        }

        return extractDynamicIdFromLocation(location.href);
    }

    /**
     * 从节点属性中提取动态 ID。
     * @param {HTMLElement} node 节点。
     * @returns {string}
     */
    function extractDynamicIdFromNode(node) {
        const attrs = ['data-did', 'data-dynamic-id', 'data-id', 'dyn-id'];

        for (const attr of attrs) {
            const value = node.getAttribute(attr);
            if (value && /^\d+$/.test(value)) {
                return value;
            }
        }

        return '';
    }

    /**
     * 从地址中提取动态 ID。
     * 同时兼容 `t.bilibili.com/123` 和 `/opus/123` 两种地址形式。
     * @param {string} value 地址文本。
     * @returns {string}
     */
    function extractDynamicIdFromLocation(value) {
        const match = String(value).match(/(?:t\.bilibili\.com\/|\/opus\/)(\d+)/);
        return match ? match[1] : '';
    }

    /**
     * 获取离当前节点最近的动态卡片根节点。
     * @param {ParentNode|HTMLElement|Document} root 搜索起点。
     * @returns {Element|null}
     */
    function getNearestCardRoot(root) {
        if (!(root instanceof HTMLElement)) {
            return document;
        }

        return root.closest(
            'article, .bili-dyn-list__item, .opus-detail, .opus-module, .dyn-card, .card, [data-did], [data-dynamic-id]'
        ) || root;
    }

    /**
     * 统一规范化图片地址。
     * 这里会去掉 B 站图片地址尾部的尺寸后缀，并补齐 `https://`。
     * @param {string} rawUrl 原始地址。
     * @returns {string}
     */
    function normalizeImageUrl(rawUrl) {
        if (!rawUrl) {
            return '';
        }

        return String(rawUrl)
            .replace(/@.*$/, '')
            .replace(/^\/\//, 'https://');
    }

    /**
     * 触发浏览器下载。
     * @param {string} href 下载地址，可以是原图地址，也可以是 Blob URL。
     * @param {string} fileName 下载文件名。
     * @param {boolean} openInNewTab 是否在新标签页中打开。
     */
    function triggerBrowserDownload(href, fileName, openInNewTab) {
        const link = document.createElement('a');
        link.href = href;
        link.download = fileName;
        link.rel = 'noopener noreferrer';

        if (openInNewTab) {
            link.target = '_blank';
        }

        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    /**
     * 设置按钮的下载中状态。
     * 忙碌时会：
     * 1. 阻止再次点击；
     * 2. 修改按钮标题；
     * 3. 把文案改成“下载中...”。
     * @param {HTMLElement} button 下载按钮。
     * @param {boolean} isBusy 是否忙碌中。
     * @param {string} busyText 忙碌态文案。
     */
    function setButtonBusy(button, isBusy, busyText) {
        const textNode = button.querySelector('.habixz-bili-download-text');

        button.dataset.downloading = isBusy ? 'true' : 'false';
        button.classList.toggle(BUTTON_BUSY_CLASS, isBusy);
        button.setAttribute('aria-disabled', isBusy ? 'true' : 'false');
        button.setAttribute('title', isBusy ? '正在下载...' : '下载原图');

        if (textNode) {
            textNode.textContent = isBusy ? (busyText || '下载中...') : '下载原图';
        }
    }

    /**
     * 开始一次全局下载锁。
     * 只要浏览器原生下载确认还没被处理，所有下载按钮都保持不可点击。
     */
    function beginDownloadLock() {
        const previousTask = getActiveDownloadTask();
        if (previousTask) {
            clearDownloadTaskTimer(previousTask);
        }

        const task = {
            id: Date.now() + Math.random(),
            waitingFocusReturn: true,
            sawBlur: document.hidden,
            timerId: 0
        };

        state.currentDownloadTask = task;

        setAllDownloadButtonsBusy(true, '等待确认...');

        /**
         * 兜底保护：
         * 如果某些浏览器没有触发焦点变化，脚本不能永久锁死。
         * 超时后自动恢复按钮，并给出说明。
         */
        task.timerId = window.setTimeout(() => {
            if (state.currentDownloadTask !== task) {
                return;
            }

            releaseDownloadLock(task, false);
            showToast('下载按钮已自动恢复，可继续操作', 'info');
        }, DOWNLOAD_DIALOG_FAILSAFE_MS);

        return task;
    }

    /**
     * 释放全局下载锁。
     * 只有当前活动任务本身才有权解锁，避免旧任务误清掉新任务。
     * @param {{id: number, waitingFocusReturn: boolean, sawBlur: boolean, timerId: number}|null} task 活动下载任务。
     * @param {boolean} byFocusReturn 是否因为浏览器焦点返回而解锁。
     */
    function releaseDownloadLock(task, byFocusReturn) {
        if (!task || state.currentDownloadTask !== task) {
            return;
        }

        clearDownloadTaskTimer(task);
        state.currentDownloadTask = null;

        setAllDownloadButtonsBusy(false, '下载原图');

        if (byFocusReturn) {
            showToast('已处理浏览器下载确认，可继续下载', 'success');
        }
    }

    /**
     * 取出当前仍然活动的下载任务。
     * @returns {{id: number, waitingFocusReturn: boolean, sawBlur: boolean, timerId: number}|null}
     */
    function getActiveDownloadTask() {
        return state.currentDownloadTask;
    }

    /**
     * 清理单个下载任务的定时器。
     * @param {{timerId: number}} task 活动下载任务。
     */
    function clearDownloadTaskTimer(task) {
        if (!task || !task.timerId) {
            return;
        }

        window.clearTimeout(task.timerId);
        task.timerId = 0;
    }

    /**
     * 统一更新当前页面里所有下载按钮的忙碌状态。
     * 这样可以防止用户在同一个弹层或不同弹层里重复触发多个下载确认框。
     * @param {boolean} isBusy 是否忙碌中。
     * @param {string} text 忙碌状态下的按钮文案。
     */
    function setAllDownloadButtonsBusy(isBusy, text) {
        for (const button of document.querySelectorAll('[' + BUTTON_FLAG + ']')) {
            if (!(button instanceof HTMLElement)) {
                continue;
            }

            setButtonBusy(button, isBusy, text);
        }
    }

    /**
     * 下载锁生效时的提示做节流，避免用户连点时出现一串重复 Toast。
     */
    function notifyDownloadLocked() {
        const now = Date.now();
        if (now - state.lastLockedToastAt < LOCKED_TOAST_COOLDOWN_MS) {
            return;
        }

        state.lastLockedToastAt = now;
        showToast('请先处理浏览器下载确认框', 'info');
    }

    /**
     * 从地址中提取扩展名。
     * @param {string} url 图片地址。
     * @returns {string}
     */
    function getFileExtensionFromUrl(url) {
        try {
            const pathName = new URL(url, location.href).pathname;
            const match = pathName.match(/\.(jpe?g|png|webp|avif|gif|bmp)$/i);
            if (!match) {
                return '';
            }

            return '.' + match[1].toLowerCase().replace('jpeg', 'jpg');
        } catch (error) {
            return '';
        }
    }

    /**
     * 根据 Blob 的 MIME 类型推导扩展名。
     * @param {string} mimeType Blob MIME 类型。
     * @returns {string}
     */
    function getFileExtensionFromBlobType(mimeType) {
        const mimeMap = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/webp': '.webp',
            'image/avif': '.avif',
            'image/gif': '.gif',
            'image/bmp': '.bmp'
        };

        return mimeMap[mimeType] || '';
    }

    /**
     * 确保文件名带有扩展名。
     * @param {string} fileName 文件名。
     * @param {string} extension 扩展名。
     * @returns {string}
     */
    function ensureFileNameExtension(fileName, extension) {
        if (!extension) {
            return fileName;
        }

        if (/\.[a-z0-9]{2,5}$/i.test(fileName)) {
            return fileName;
        }

        return fileName + extension;
    }

    /**
     * 清理文件名中的非法字符。
     * @param {string} value 原始文件名。
     * @returns {string}
     */
    function sanitizeFileName(value) {
        return String(value)
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/[. ]+$/g, '')
            .trim();
    }

    /**
     * 从 URL 中取 pathname。
     * @param {string} url 原始地址。
     * @returns {string}
     */
    function getPathName(url) {
        try {
            return new URL(url, location.href).pathname;
        } catch (error) {
            return '';
        }
    }

    /**
     * 压缩文本中的多余空白，得到更适合做文件名的短文本。
     * @param {string} value 原始文本。
     * @returns {string}
     */
    function compactText(value) {
        return String(value).replace(/\s+/g, ' ').trim();
    }

    /**
     * 统一提取错误信息。
     * @param {unknown} error 错误对象。
     * @returns {string}
     */
    function getErrorMessage(error) {
        if (error instanceof Error && error.message) {
            return error.message;
        }

        return String(error || '未知错误');
    }

    /**
     * 注入脚本需要的样式。
     * 包括按钮文字间距、忙碌态样式、窄屏适配，以及顶部居中的 Toast 提示。
     */
    function injectStyle() {
        if (document.documentElement.hasAttribute(SCRIPT_FLAG)) {
            return;
        }

        document.documentElement.setAttribute(SCRIPT_FLAG, 'true');

        const style = document.createElement('style');
        style.textContent = `
            .habixz-bili-download-text {
                margin-left: 6px;
            }

            .${BUTTON_BUSY_CLASS} {
                opacity: 0.65;
                pointer-events: none;
                cursor: not-allowed;
            }

            @media screen and (max-width: 1319px) {
                .bili-album__watch__control__option {
                    padding: 0 12px !important;
                }

                .habixz-bili-download-text {
                    display: none;
                }
            }

            .habixz-bili-toast-wrap {
                position: fixed;
                top: 242px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483647;
                pointer-events: none;
            }

            .habixz-bili-toast {
                min-width: 260px;
                max-width: 520px;
                padding: 12px 16px;
                border-radius: 10px;
                color: #ffffff;
                font-size: 14px;
                line-height: 1.5;
                box-shadow: 0 10px 24px rgba(0, 0, 0, 0.16);
                opacity: 0;
                transform: translateY(-8px);
                transition: opacity 0.2s ease, transform 0.2s ease;
                display: flex;
                align-items: center;
                gap: 10px;
                pointer-events: none;
            }

            .habixz-bili-toast.is-visible {
                opacity: 1;
                transform: translateY(0);
            }

            .habixz-bili-toast__icon {
                width: 22px;
                height: 22px;
                border-radius: 50%;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 22px;
                font-weight: 700;
                font-size: 14px;
                background: rgba(255, 255, 255, 0.22);
            }

            .habixz-bili-toast--success {
                background: rgba(103, 194, 58, 0.96);
            }

            .habixz-bili-toast--error {
                background: rgba(245, 108, 108, 0.96);
            }

            .habixz-bili-toast--info {
                background: rgba(64, 158, 255, 0.96);
            }
        `;

        document.head.appendChild(style);
    }

    /**
     * 显示顶部居中的非阻塞提示。
     * 这里不使用 alert，避免打断用户浏览和下载操作。
     * @param {string} message 提示文案。
     * @param {'success'|'error'|'info'} type 提示类型。
     */
    function showToast(message, type) {
        const toastType = type || 'info';
        const iconMap = {
            success: '✓',
            error: '×',
            info: 'i'
        };

        const toast = ensureToastNode();

        toast.className = 'habixz-bili-toast habixz-bili-toast--' + toastType;
        state.toastIconNode.textContent = iconMap[toastType] || 'i';
        state.toastTextNode.textContent = message;

        clearToastTimers();

        requestAnimationFrame(() => {
            toast.classList.add('is-visible');
        });

        state.toastHideTimer = window.setTimeout(() => {
            toast.classList.remove('is-visible');

            state.toastRemoveTimer = window.setTimeout(() => {
                /**
                 * 这里不移除节点，只是隐藏。
                 * 这样后续提示可以直接复用同一个 DOM，避免重复创建和堆叠。
                 */
            }, 220);
        }, TOAST_DURATION_MS);
    }

    /**
     * 确保页面里始终只有一个 Toast 实例。
     * 后续所有提示都只更新这一个节点的内容和样式。
     * @returns {HTMLElement}
     */
    function ensureToastNode() {
        if (state.toastNode && state.toastWrap && state.toastNode.isConnected) {
            return state.toastNode;
        }

        const wrap = document.createElement('div');
        const toast = document.createElement('div');
        const icon = document.createElement('span');
        const text = document.createElement('span');

        wrap.className = 'habixz-bili-toast-wrap';
        toast.className = 'habixz-bili-toast';
        icon.className = 'habixz-bili-toast__icon';

        toast.appendChild(icon);
        toast.appendChild(text);
        wrap.appendChild(toast);
        document.body.appendChild(wrap);

        state.toastWrap = wrap;
        state.toastNode = toast;
        state.toastIconNode = icon;
        state.toastTextNode = text;

        return toast;
    }

    /**
     * 清理 Toast 的隐藏定时器。
     * 这样新提示到来时，会覆盖旧提示而不是彼此排队。
     */
    function clearToastTimers() {
        if (state.toastHideTimer) {
            window.clearTimeout(state.toastHideTimer);
            state.toastHideTimer = 0;
        }

        if (state.toastRemoveTimer) {
            window.clearTimeout(state.toastRemoveTimer);
            state.toastRemoveTimer = 0;
        }
    }
})();
