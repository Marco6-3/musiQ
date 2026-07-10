(() => {
    'use strict';

    const storageKeys = {
        iosInstallDismissed: ['music_ios_install_dismissed', 'musiq_ios_install_dismissed'],
        inAppNoticeDismissed: ['music_in_app_notice_dismissed', 'musiq_in_app_notice_dismissed'],
        reinstallNoticeDismissed: ['music_pwa_reinstall_dismissed', 'musiq_pwa_reinstall_dismissed'],
        updateDismissed: ['music_pwa_update_dismissed', 'musiq_pwa_update_dismissed'],
        versionSeen: ['music_pwa_version_seen', 'musiq_pwa_version_seen']
    };
    const runtime = window.__musiqRuntime || {};
    runtime.refresh?.();
    const appVersion = runtime.appVersion || '2026.07.10.6';
    const isStandalone = Boolean(runtime.isStandalonePwa)
        || window.navigator.standalone === true
        || window.matchMedia('(display-mode: standalone)').matches;
    const isIos = Boolean(runtime.isIOS)
        || /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isInAppBrowser = Boolean(runtime.isInAppBrowser);
    const isSafari = Boolean(runtime.isSafari);
    const isBrowserClient = !window.electronAPI;

    document.documentElement.classList.toggle('is-standalone-pwa', isStandalone);
    document.documentElement.classList.toggle('is-ios-webkit', isIos);
    document.documentElement.classList.toggle('is-browser-client', isBrowserClient);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        document.body.classList.toggle('is-standalone-pwa', isStandalone);
        document.body.classList.toggle('is-ios-webkit', isIos);
        document.body.classList.toggle('is-in-app-browser', isInAppBrowser);
        document.body.classList.toggle('is-safari', isSafari);
        document.body.classList.toggle('is-secure-context', Boolean(runtime.isSecureContext));
        document.body.classList.toggle('is-browser-client', isBrowserClient);

        registerServiceWorker();
        bindNetworkStatus();
        showInAppBrowserNotice();
        showIosInstallHint();
        showStandaloneReinstallNotice();
        bindChromiumInstallPrompt();
        showStandaloneVersionNotice();
    }

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        if (!window.isSecureContext && !isLocalhost()) return;

        navigator.serviceWorker.register('sw.js', { scope: './' })
            .then((registration) => {
                watchForUpdates(registration);
                if (registration.waiting) showUpdateNotice(registration.waiting);
                checkForServiceWorkerUpdate(registration);
                bindServiceWorkerUpdateChecks(registration);
            })
            .catch(() => {
                // PWA registration failure must not block the music app.
            });

        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return;
            refreshing = true;
            window.location.reload();
        });
    }

    function watchForUpdates(registration) {
        registration.addEventListener('updatefound', () => {
            const worker = registration.installing;
            if (!worker) return;
            worker.addEventListener('statechange', () => {
                if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                    showUpdateNotice(worker);
                }
            });
        });
    }

    function bindServiceWorkerUpdateChecks(registration) {
        window.addEventListener('pageshow', () => checkForServiceWorkerUpdate(registration));
        window.addEventListener('focus', () => checkForServiceWorkerUpdate(registration));
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) checkForServiceWorkerUpdate(registration);
        });
    }

    function checkForServiceWorkerUpdate(registration) {
        if (!navigator.onLine) return;
        registration.update?.().catch(() => {
            // Update checks are best-effort on iOS PWA.
        });
    }

    function showUpdateNotice(worker) {
        if (readLocal(storageKeys.updateDismissed) === CACHE_BUST_KEY()) return;
        showNotice({
            id: 'pwa-update-notice',
            message: `music 有新版本可用：${appVersion}`,
            actionText: '刷新',
            onAction: () => {
                if (worker) {
                    worker.postMessage({ type: 'SKIP_WAITING' });
                } else {
                    window.location.reload();
                }
            },
            onClose: () => writeLocal(storageKeys.updateDismissed, CACHE_BUST_KEY())
        });
    }

    function showStandaloneVersionNotice() {
        if (!isStandalone || !isBrowserClient) return;
        const seenVersion = readLocal(storageKeys.versionSeen);
        if (seenVersion === appVersion) return;
        showNotice({
            id: 'pwa-version-notice',
            message: seenVersion
                ? `music 已更新到 ${appVersion}`
                : `music 当前版本 ${appVersion}`,
            actionText: '知道了',
            onAction: () => writeLocal(storageKeys.versionSeen, appVersion),
            onClose: () => writeLocal(storageKeys.versionSeen, appVersion),
            timeoutMs: 0
        });
    }

    function bindNetworkStatus() {
        window.addEventListener('offline', () => {
            showNotice({
                id: 'pwa-network-notice',
                message: '当前离线：只能浏览已缓存界面，搜索和播放需要网络',
                actionText: '知道了'
            });
        });
        window.addEventListener('online', () => {
            showNotice({
                id: 'pwa-network-notice',
                message: '网络已恢复，可以继续搜索和播放',
                actionText: '好的',
                timeoutMs: 3800
            });
        });
    }

    function showIosInstallHint() {
        if (!isIos || isStandalone || !isBrowserClient) return;
        if (isInAppBrowser) return;
        if (readLocal(storageKeys.iosInstallDismissed) === '1') return;

        showNotice({
            id: 'pwa-ios-install-notice',
            message: '锁屏/灵动岛返回体验只有从主屏幕 App 打开时最稳定。请在 Safari 中添加到主屏幕。',
            actionText: '知道了',
            onAction: () => writeLocal(storageKeys.iosInstallDismissed, '1'),
            onClose: () => writeLocal(storageKeys.iosInstallDismissed, '1'),
            timeoutMs: 0
        });
    }

    function showInAppBrowserNotice() {
        if (!isIos || !isInAppBrowser || !isBrowserClient) return;
        if (readLocal(storageKeys.inAppNoticeDismissed) === '1') return;

        showNotice({
            id: 'pwa-in-app-browser-notice',
            message: '当前在支付宝/微信等内置浏览器中，music 会禁止播放以避免 iOS 锁屏入口回到错误 App。请复制链接到 Safari 并添加到主屏幕。',
            actionText: '知道了',
            onAction: () => writeLocal(storageKeys.inAppNoticeDismissed, '1'),
            onClose: () => writeLocal(storageKeys.inAppNoticeDismissed, '1'),
            timeoutMs: 0
        });
    }

    function showStandaloneReinstallNotice() {
        if (!isStandalone || !runtime.reinstallRecommended) return;
        if (readLocal(storageKeys.reinstallNoticeDismissed) === '1') return;

        showNotice({
            id: 'pwa-reinstall-notice',
            message: '建议删除旧图标后从 Safari 重新添加 music 到主屏幕。',
            actionText: '知道了',
            onAction: () => writeLocal(storageKeys.reinstallNoticeDismissed, '1'),
            onClose: () => writeLocal(storageKeys.reinstallNoticeDismissed, '1'),
            timeoutMs: 0
        });
    }

    function bindChromiumInstallPrompt() {
        let promptEvent = null;
        window.addEventListener('beforeinstallprompt', (event) => {
            if (isIos || isStandalone) return;
            event.preventDefault();
            promptEvent = event;
            showNotice({
                id: 'pwa-install-notice',
                message: '可以将 music 安装到桌面',
                actionText: '安装',
                onAction: () => {
                    promptEvent?.prompt();
                    promptEvent = null;
                }
            });
        });
    }

    function showNotice({ id, message, actionText = '关闭', onAction, onClose, timeoutMs = 6000 }) {
        let notice = document.getElementById(id);
        if (!notice) {
            notice = document.createElement('div');
            notice.id = id;
            notice.className = 'pwa-notice';
            notice.innerHTML = `
                <span class="pwa-notice-text"></span>
                <button type="button" class="pwa-notice-action"></button>
                <button type="button" class="pwa-notice-close" aria-label="关闭">×</button>
            `;
            document.body.appendChild(notice);
        }

        notice.querySelector('.pwa-notice-text').textContent = message;
        notice.querySelector('.pwa-notice-action').textContent = actionText;
        notice.classList.add('show');

        const close = () => {
            notice.classList.remove('show');
            onClose?.();
        };
        notice.querySelector('.pwa-notice-action').onclick = () => {
            onAction?.();
            close();
        };
        notice.querySelector('.pwa-notice-close').onclick = close;

        if (timeoutMs > 0) {
            clearTimeout(notice._hideTimer);
            notice._hideTimer = setTimeout(close, timeoutMs);
        }
    }

    function isLocalhost() {
        return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    }

    function readLocal(key) {
        try {
            const keys = Array.isArray(key) ? key : [key];
            for (const candidate of keys) {
                const value = localStorage.getItem(candidate);
                if (value !== null) {
                    if (candidate !== keys[0]) localStorage.setItem(keys[0], value);
                    return value;
                }
            }
            return '';
        } catch {
            return '';
        }
    }

    function writeLocal(key, value) {
        try {
            localStorage.setItem(Array.isArray(key) ? key[0] : key, value);
        } catch {}
    }

    function CACHE_BUST_KEY() {
        return appVersion;
    }
})();
