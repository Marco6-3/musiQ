'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'webroot', 'js', 'pwa-runtime.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'webroot', 'js', 'main.js'), 'utf8');

function createRuntime({ userAgent, standalone = false, secure = true }) {
  const classList = { toggle() {} };
  const navigator = {
    userAgent,
    platform: /iPhone|iPad/.test(userAgent) ? 'iPhone' : 'MacIntel',
    maxTouchPoints: /iPhone|iPad/.test(userAgent) ? 5 : 0,
    standalone,
    mediaSession: {
      metadata: null,
      playbackState: 'none',
      setActionHandler() {}
    },
    serviceWorker: {}
  };
  const context = {
    URL,
    URLSearchParams,
    CustomEvent: class CustomEvent {},
    console,
    fetch: async () => ({ json: async () => ({}) }),
    navigator,
    location: new URL('https://music.example.test/?source=pwa'),
    isSecureContext: secure,
    matchMedia: () => ({ matches: standalone }),
    addEventListener() {},
    dispatchEvent() {},
    history: { state: null, replaceState() {} },
    document: {
      readyState: 'complete',
      referrer: '',
      documentElement: { classList },
      body: { classList },
      querySelector() { return null; }
    }
  };
  context.window = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'pwa-runtime.js' });
  return context.__musiqRuntime;
}

test('desktop secure browsers enable Media Session without requiring PWA installation', () => {
  const runtime = createRuntime({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150 Safari/537.36'
  });

  assert.equal(runtime.isIOS, false);
  assert.equal(runtime.isStandalonePwa, false);
  assert.equal(runtime.canUseFullMediaSession(), true);
});

test('iPhone Safari keeps full Media Session in browser and standalone PWA modes', () => {
  const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  const browserRuntime = createRuntime({ userAgent });
  const standaloneRuntime = createRuntime({ userAgent, standalone: true });

  assert.equal(browserRuntime.canUseFullMediaSession(), true);
  assert.equal(standaloneRuntime.canUseFullMediaSession(), true);
});

test('non-Safari iOS browsers do not claim the full Safari Media Session path', () => {
  const runtime = createRuntime({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/150.0 Mobile/15E148 Safari/604.1'
  });

  assert.equal(runtime.isSafari, false);
  assert.equal(runtime.canUseFullMediaSession(), false);
});

test('iOS in-app browsers never enable playback Media Session handlers', () => {
  const runtime = createRuntime({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0',
    standalone: true
  });

  assert.equal(runtime.isInAppBrowser, true);
  assert.equal(runtime.canUseFullMediaSession(), false);
});

test('background playback throttles hidden UI work without disabling track prefetching', () => {
  assert.match(mainSource, /now - state\.lastBackgroundTickAt < 5000/);
  assert.match(mainSource, /musiqRuntime\.isIOS\s*&& musiqRuntime\.isStandalonePwa/);
  assert.doesNotMatch(mainSource, /document\.hidden && !backgroundPlaybackNeedsPrefetch/);
  assert.match(mainSource, /scheduleLifecyclePlaybackRecovery\('hidden'\)/);
  assert.match(mainSource, /scheduleLifecyclePlaybackRecovery\('visible'\)/);
  assert.match(mainSource, /state\.playbackIntent/);
  assert.doesNotMatch(mainSource, /else if \(audio\.paused\) \{\s*clearOrDegradeMediaSession\('hidden-paused'\)/);
});
