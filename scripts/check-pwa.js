'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const webroot = path.join(root, 'webroot');
const failures = [];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function has(text, needle, label = needle) {
  expect(text.includes(needle), `missing ${label}`);
}

function checkManifest() {
  const file = 'webroot/manifest.webmanifest';
  expect(exists(file), `${file} does not exist`);
  if (!exists(file)) return;

  const manifest = JSON.parse(read(file));
  for (const field of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'background_color', 'theme_color', 'orientation']) {
    expect(Boolean(manifest[field]), `manifest missing ${field}`);
  }
  expect(manifest.display === 'standalone', 'manifest display must be standalone');
  expect(manifest.id === '/?app=music-pwa', 'manifest id must be fixed to /?app=music-pwa');
  expect(manifest.start_url === '/?source=pwa', 'manifest start_url must be canonical PWA URL');
  expect(manifest.scope === '/', 'manifest scope must be /');
  expect(manifest.name === 'music', 'manifest name must be music');
  expect(manifest.short_name === 'music', 'manifest short_name must be music');
  expect(Array.isArray(manifest.icons), 'manifest icons must be an array');
  const iconSizes = (manifest.icons || []).flatMap((icon) => String(icon.sizes || '').split(/\s+/));
  expect(iconSizes.includes('192x192'), 'manifest missing 192x192 icon');
  expect(iconSizes.includes('512x512'), 'manifest missing 512x512 icon');
  for (const icon of manifest.icons || []) {
    const src = String(icon.src || '').replace(/^\//, 'webroot/');
    expect(exists(src), `manifest icon missing file: ${icon.src}`);
  }
  const shortcuts = manifest.shortcuts || [];
  expect(shortcuts.length >= 3, 'manifest should include search/favorites/queue shortcuts');
  expect(shortcuts.some((item) => /search/.test(item.url || '')), 'manifest missing search shortcut');
  expect(shortcuts.some((item) => /favorites/.test(item.url || '')), 'manifest missing favorites shortcut');
  expect(shortcuts.some((item) => /queue/.test(item.url || '')), 'manifest missing queue shortcut');
}

function checkIndex() {
  const html = read('webroot/index.html');
  has(html, 'viewport-fit=cover', 'viewport-fit=cover');
  has(html, 'rel="manifest"', 'manifest link');
  has(html, 'apple-mobile-web-app-capable', 'apple web app capable meta');
  has(html, 'apple-mobile-web-app-title', 'apple web app title meta');
  has(html, 'apple-mobile-web-app-status-bar-style', 'apple status bar meta');
  has(html, 'apple-touch-icon', 'apple touch icon');
  has(html, 'name="theme-color"', 'theme-color meta');
  has(html, 'window.__MUSIC_CONFIG__', 'runtime config hook');
  has(html, 'js/pwa-runtime.js', 'PWA runtime detection script');
  has(html, 'js/media-session-artwork.js', 'Media Session artwork script');
  has(html, 'js/pwa.js', 'PWA script');

  const sw = read('webroot/sw.js');
  const versionedAssets = [...html.matchAll(/(?:href|src)="((?:css|js)\/[^"]+\?v=[^"]+)"/g)].map((match) => match[1]);
  for (const asset of versionedAssets) {
    has(sw, `./${asset}`, `service worker versioned asset ${asset}`);
  }
}

function checkServiceWorker() {
  const file = 'webroot/sw.js';
  expect(exists(file), `${file} does not exist`);
  if (!exists(file)) return;

  const sw = read(file);
  for (const handler of ["'install'", "'activate'", "'fetch'"]) {
    has(sw, `addEventListener(${handler}`, `service worker ${handler} handler`);
  }
  for (const asset of ['/', 'index.html', 'offline.html', 'manifest.webmanifest', 'css/style.css', 'js/pwa-runtime.js', 'js/media-session-artwork.js', 'js/main.js', 'js/source-selector.js', 'js/pwa.js', 'public/music-default.png']) {
    has(sw, asset, `service worker cache asset ${asset}`);
  }
  expect(!/music-api\.gdstudio\.xyz|https:\/\/.*api\.php/.test(sw), 'service worker must not cache third-party music API URLs');
  expect(!/cache\.put\(request.*offline\/audio/s.test(sw), 'service worker must not runtime-cache offline audio requests');
}

function checkPwaJs() {
  const js = read('webroot/js/pwa.js');
  has(js, 'serviceWorker', 'service worker registration');
  has(js, 'is-standalone-pwa', 'standalone class hook');
  has(js, 'is-in-app-browser', 'in-app browser class hook');
  has(js, 'offline', 'offline listener');
  has(js, 'online', 'online listener');
  has(js, 'beforeinstallprompt', 'Chromium install prompt hook');

  const runtimeJs = read('webroot/js/pwa-runtime.js');
  const runtimeVersion = runtimeJs.match(/const APP_VERSION = '([^']+)'/)?.[1] || '';
  expect(Boolean(runtimeVersion), 'PWA runtime missing APP_VERSION');
  has(js, runtimeVersion, 'PWA notice version must match runtime APP_VERSION');
}

function checkPwaRuntimeJs() {
  const js = read('webroot/js/pwa-runtime.js');
  has(js, 'window.__musiqRuntime', 'global runtime object');
  for (const token of ['AlipayClient', 'AliApp', 'AlipayJSBridge', 'MicroMessenger', 'WeixinJSBridge', 'QQ\\/', 'Weibo', 'DingTalk', 'Feishu', 'Lark', 'UCBrowser', 'Quark', 'Baidu', 'SogouMobileBrowser']) {
    has(js, token, `in-app browser detection ${token}`);
  }
  has(js, 'inAppHost', 'in-app host diagnostics');
  has(js, 'isStandalonePwa', 'standalone runtime flag');
  has(js, 'isSecureContext', 'secure-context runtime flag');
  has(js, 'hasMediaSession', 'Media Session runtime flag');
  has(js, 'serviceWorkerController', 'service worker controller runtime flag');
}

function checkMainJs() {
  const js = read('webroot/js/main.js');
  has(js, 'buildApiUrl', 'API URL builder');
  has(js, 'window.__MUSIC_CONFIG__', 'window runtime config');
  has(js, "'mediaSession' in navigator", 'Media Session feature detection');
  has(js, 'mediaSessionBlockedReason', 'Media Session blocked reason diagnostics');
  has(js, 'in-app-playback-modal', 'in-app browser playback block modal');
  has(js, 'debugPwa', 'PWA diagnostics query flag');
  has(js, 'modal-open', 'modal body lock');
}

function checkCss() {
  const css = read('webroot/css/style.css');
  has(css, 'safe-area-inset-bottom', 'safe-area CSS');
  has(css, 'is-standalone-pwa', 'standalone CSS hook');
  has(css, '-webkit-overflow-scrolling: touch', 'iOS momentum scrolling');
  has(css, '.pwa-notice', 'PWA notice styles');
}

checkManifest();
checkIndex();
checkServiceWorker();
checkPwaJs();
checkPwaRuntimeJs();
checkMainJs();
checkCss();

if (!exists('webroot/offline.html')) failures.push('webroot/offline.html does not exist');
if (!fs.existsSync(webroot)) failures.push('webroot directory missing');

if (failures.length) {
  console.error('PWA check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('PWA check passed');
