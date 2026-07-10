'use strict';

const CACHE_VERSION = 'music-pwa-v38';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const LEGACY_CACHE_PREFIXES = ['musiq-pwa-'];

const APP_SHELL = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './?source=pwa',
  './css/style.css?v=2.1.13',
  './js/pwa-runtime.js?v=1.0.10',
  './js/media-session-artwork.js?v=1.0.1',
  './js/main.js?v=2.2.26',
  './js/source-selector.js?v=1.0.4',
  './js/pwa.js?v=1.1.9',
  './public/music-default.png',
  './public/icons/icon-192.png',
  './public/icons/apple-touch-icon-180.png',
  './public/icons/maskable-512.png',
  './public/avatars/default1.png'
];

const API_PREFIXES = [
  '/api.php',
  '/php/',
  '/api_check/',
  '/check_version.php'
];

const AUDIO_PREFIXES = [
  '/offline/audio/'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => (key.startsWith('music-pwa-') || LEGACY_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
          && ![APP_SHELL_CACHE, RUNTIME_CACHE].includes(key))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isAudioRequest(url)) {
    event.respondWith(fetch(request).catch(() => new Response('', {
      status: 503,
      statusText: 'Audio unavailable offline'
    })));
    return;
  }

  if (isApiRequest(url)) {
    event.respondWith(networkFirstApi(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationFallback(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

function isApiRequest(url) {
  return API_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix));
}

function isAudioRequest(url) {
  return AUDIO_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

async function networkFirstApi(request) {
  try {
    return await fetch(request, { cache: 'no-store' });
  } catch {
    return jsonResponse({
      success: false,
      error: '当前离线或后端不可用，搜索、播放、歌词和账号同步需要网络连接。'
    }, 503);
  }
}

async function navigationFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(APP_SHELL_CACHE);
      cache.put('./index.html', response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return (await caches.match('./index.html'))
      || (await caches.match('./offline.html'))
      || new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request).then(async (response) => {
    if (response.ok && shouldRuntimeCache(request, response)) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => cached);

  return cached || network || caches.match('./offline.html');
}

function shouldRuntimeCache(request, response) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (isApiRequest(url) || isAudioRequest(url)) return false;
  const type = response.headers.get('content-type') || '';
  return /text\/css|javascript|image\/|font\/|manifest/.test(type);
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
