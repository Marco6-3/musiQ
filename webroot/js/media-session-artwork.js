(() => {
    'use strict';

    const allowedHostSuffixes = Object.freeze([
        'music.126.net',
        'kuwo.cn',
        'kugou.com',
        'gtimg.cn',
        'qpic.cn',
        'migu.cn',
        'miguvideo.com',
        'hdslb.com',
        'baidu.com'
    ]);

    function isAllowedHost(hostname) {
        const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
        return allowedHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    }

    function resolve(value, options = {}) {
        const baseUrl = options.baseUrl || window.location.href;
        const fallback = new URL(options.fallback || '/public/icons/icon-192.png', baseUrl).href;
        let candidate;
        try {
            candidate = new URL(String(value || ''), baseUrl);
        } catch {
            return fallback;
        }

        const base = new URL(baseUrl);
        if (candidate.origin === base.origin && ['http:', 'https:'].includes(candidate.protocol)) {
            return candidate.href;
        }
        if (!['http:', 'https:'].includes(candidate.protocol) || !isAllowedHost(candidate.hostname)) {
            return fallback;
        }

        const proxy = new URL('/media/artwork', base.origin);
        proxy.searchParams.set('url', candidate.href);
        return proxy.href;
    }

    function buildSet(value, options = {}) {
        const src = resolve(value, options);
        try {
            const url = new URL(src, options.baseUrl || window.location.href);
            if (url.pathname === '/media/artwork') {
                return [{ src, sizes: '512x512', type: 'image/jpeg' }];
            }
        } catch {}
        return [{ src }];
    }

    window.__musicMediaArtwork = Object.freeze({
        allowedHostSuffixes,
        isAllowedHost,
        resolve,
        buildSet
    });
})();
