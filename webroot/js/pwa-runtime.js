(() => {
    'use strict';

    const IN_APP_SIGNATURES = [
        ['alipay', [/AlipayClient/i, /AliApp\(AP\//i, /\bAliApp\b/i, /AlipayDefined/i, /APWebView/i, /\bNebula\b/i, /\bmPaaS\b/i]],
        ['wechat', [/MicroMessenger/i]],
        ['qq', [/\bQQ\//i]],
        ['weibo', [/Weibo/i]],
        ['dingtalk', [/DingTalk/i]],
        ['feishu', [/Feishu/i, /Lark/i]],
        ['uc', [/UCBrowser/i]],
        ['quark', [/Quark/i]],
        ['baidu', [/Baidu/i]],
        ['sogou', [/SogouMobileBrowser/i]]
    ];
    const NON_SAFARI_PATTERNS = /CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Android/i;
    const MEDIA_ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward', 'stop'];
    const APP_VERSION = '2026.07.12.1';
    const CLASS_MAP = {
        isIOS: 'is-ios',
        isStandalonePwa: 'is-standalone-pwa',
        isInAppBrowser: 'is-in-app-browser',
        isSafari: 'is-safari',
        isSecureContext: 'is-secure-context'
    };
    const runtime = window.__musiqRuntime || {};

    window.__musiqRuntime = runtime;
    window.__MUSIQ_RUNTIME__ = runtime;

    Object.assign(runtime, {
        mediaSessionEnabled: false,
        mediaSessionBlockedReason: '',
        appVersion: APP_VERSION,
        lastMetadataAt: '',
        lastMetadataTitle: '',
        lastMetadataArtwork: '',
        lastAudioErrorCode: '',
        lastRouteRestoreTime: '',
        pageshowPersisted: false,
        manifestId: '',
        manifestStartUrl: '',
        reinstallRecommended: false,
        inAppHost: '',
        refresh,
        clearMediaSession,
        canUseFullMediaSession,
        isPlaybackBlocked,
        markMetadata,
        markAudioError,
        markRouteRestore
    });

    refresh();
    sanitizeStandaloneLaunchUrl();
    loadManifestInfo();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => applyRuntimeClasses(runtime));
    } else {
        applyRuntimeClasses(runtime);
    }

    window.addEventListener('pageshow', (event) => {
        runtime.pageshowPersisted = Boolean(event.persisted);
        refresh();
    });
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);

    function refresh() {
        const ua = navigator.userAgent || '';
        const isIOS = /iPad|iPhone|iPod/.test(ua)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const isStandalonePwa = window.navigator.standalone === true
            || window.matchMedia?.('(display-mode: standalone)').matches === true;
        const inAppHost = detectInAppHost(ua);
        const isInAppBrowser = Boolean(inAppHost);
        const isSafari = /Safari/i.test(ua) && !NON_SAFARI_PATTERNS.test(ua) && !isInAppBrowser;

        Object.assign(runtime, {
            ua,
            isIOS,
            isStandalonePwa,
            isSafari,
            isInAppBrowser,
            inAppHost,
            isSecureContext: Boolean(window.isSecureContext),
            hasMediaSession: 'mediaSession' in navigator,
            serviceWorkerController: Boolean(navigator.serviceWorker?.controller),
            serviceWorkerControllerUrl: navigator.serviceWorker?.controller?.scriptURL || ''
        });

        if (isPlaybackBlocked()) clearMediaSession(`in-app-browser:${runtime.inAppHost || 'unknown'}`);
        applyRuntimeClasses(runtime);
        return runtime;
    }

    function detectInAppHost(ua) {
        if (typeof window.AlipayJSBridge !== 'undefined') return 'alipay';
        if (typeof window.AlipayJSBridgeReady !== 'undefined') return 'alipay';
        if (typeof window.WeixinJSBridge !== 'undefined') return 'wechat';

        for (const [host, patterns] of IN_APP_SIGNATURES) {
            if (patterns.some((pattern) => pattern.test(ua))) return host;
        }
        return '';
    }

    function applyRuntimeClasses(value) {
        for (const [key, className] of Object.entries(CLASS_MAP)) {
            document.documentElement.classList.toggle(className, Boolean(value[key]));
            if (document.body) document.body.classList.toggle(className, Boolean(value[key]));
        }
    }

    function canUseFullMediaSession() {
        refresh();
        return Boolean(runtime.hasMediaSession
            && runtime.isSecureContext
            && !runtime.isInAppBrowser
            && (runtime.isStandalonePwa || runtime.isSafari || !runtime.isIOS));
    }

    function isPlaybackBlocked() {
        return Boolean(runtime.isIOS && runtime.isInAppBrowser);
    }

    function clearMediaSession(reason = '') {
        runtime.mediaSessionEnabled = false;
        runtime.mediaSessionBlockedReason = reason || runtime.mediaSessionBlockedReason || '';
        if (!runtime.hasMediaSession) return;
        try {
            navigator.mediaSession.playbackState = 'none';
        } catch {}
        try {
            navigator.mediaSession.metadata = null;
        } catch {}
        for (const action of MEDIA_ACTIONS) {
            try {
                navigator.mediaSession.setActionHandler(action, null);
            } catch {}
        }
    }

    function markMetadata({ title = '', artwork = '' } = {}) {
        runtime.lastMetadataAt = new Date().toISOString();
        runtime.lastMetadataTitle = title;
        runtime.lastMetadataArtwork = artwork;
    }

    function markAudioError(errorCode) {
        runtime.lastAudioErrorCode = errorCode ? String(errorCode) : '';
    }

    function markRouteRestore() {
        runtime.lastRouteRestoreTime = new Date().toISOString();
    }

    function sanitizeStandaloneLaunchUrl() {
        if (!runtime.isStandalonePwa || window.location.origin === 'null') return;
        const url = new URL(window.location.href);
        const inAppSource = hasInAppSource(url.searchParams) || hasInAppSource(new URLSearchParams(window.location.hash.replace(/^#/, '?')));
        const referrerLooksInApp = Boolean(detectInAppHost(document.referrer || ''));
        if (!inAppSource && !referrerLooksInApp) return;

        runtime.reinstallRecommended = true;
        const clean = new URL('/?source=pwa', window.location.origin);
        const view = url.searchParams.get('view');
        const panel = url.searchParams.get('panel');
        const debugPwa = url.searchParams.get('debugPwa');
        if (view) clean.searchParams.set('view', view);
        if (panel) clean.searchParams.set('panel', panel);
        if (debugPwa) clean.searchParams.set('debugPwa', debugPwa);
        window.history.replaceState(window.history.state, '', clean.pathname + clean.search + clean.hash);
    }

    function hasInAppSource(params) {
        for (const [key, value] of params.entries()) {
            const pair = `${key}=${value}`;
            if (/from/i.test(key) && /alipay|wechat|weixin|qq|weibo|dingtalk|feishu|lark|baidu|quark|uc/i.test(value)) {
                return true;
            }
            if (detectInAppHost(pair)) return true;
        }
        return false;
    }

    async function loadManifestInfo() {
        const link = document.querySelector('link[rel="manifest"]');
        if (!link?.href) return;
        try {
            const response = await fetch(link.href, { cache: 'no-store' });
            const manifest = await response.json();
            runtime.manifestId = manifest.id || '';
            runtime.manifestStartUrl = manifest.start_url || '';
            window.dispatchEvent(new CustomEvent('musiq-runtime:manifest', { detail: manifest }));
        } catch {
            runtime.manifestId = '';
            runtime.manifestStartUrl = '';
        }
    }
})();
