'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');

const { createDataStore } = require('../src/server/database');
const { createExpressApp } = require('../src/server/index');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'music-api-test-'));
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

test('music API upstream fallback failures do not create unhandled rejections', async () => {
  const dataDir = createTempDir();
  const originalAxiosGet = axios.get;
  const unhandled = [];
  let store;
  let appServer;

  const onUnhandledRejection = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  axios.get = async (url, ...args) => {
    if (String(url).startsWith('https://music-api.gdstudio.xyz/api.php')) {
      const error = new Error('simulated upstream failure');
      error.response = { status: 400, data: '{"detail":"Value of `source` is not supported."}' };
      throw error;
    }
    return originalAxiosGet.call(axios, url, ...args);
  };

  try {
    store = await createDataStore(dataDir);
    const app = createExpressApp({
      store,
      uploadsDir: path.join(dataDir, 'uploads', 'avatars'),
      cacheDir: path.join(dataDir, 'cache'),
      dispatcher: {
        async proxy() {
          return null;
        }
      }
    });
    appServer = http.createServer(app);
    const baseUrl = await listen(appServer);

    const response = await fetch(`${baseUrl}/api.php?types=pic&source=kugou&id=bad-pic&size=120`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: '音乐服务暂时不可用，请稍后重试' });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    axios.get = originalAxiosGet;
    process.off('unhandledRejection', onUnhandledRejection);
    if (appServer) await new Promise((resolve) => appServer.close(resolve));
    if (store) await store.close();
    removeTempDir(dataDir);
  }
});


test('URL refresh bypasses server caches and failures never resurrect stale signed URLs', async (t) => {
  const dataDir = createTempDir();
  const store = await createDataStore(dataDir);
  const originalAxiosGet = axios.get;
  let calls = 0;
  let fail = false;
  const audioServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/flac' });
    res.end(Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(32)]));
  });
  const audioBase = await listen(audioServer);
  const app = createExpressApp({
    store, uploadsDir: path.join(dataDir, 'uploads'), cacheDir: path.join(dataDir, 'cache'),
    dispatcher: { async proxy(types, params) {
      calls++;
      assert.equal(params.refresh, undefined);
      if (fail) throw new Error('expired provider');
      return { data: JSON.stringify({ url: `${audioBase}/audio?generation=${calls}`, br: 999 }) };
    } }
  });
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(async () => {
    axios.get = originalAxiosGet;
    server.closeAllConnections(); audioServer.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => audioServer.close(r))]);
    await store.close(); removeTempDir(dataDir);
  });
  const url = `${base}/api.php?types=url&id=refresh-regression&br=999`;
  const first = await (await fetch(url)).json();
  const cached = await (await fetch(url)).json();
  assert.equal(first.url, cached.url); assert.equal(calls, 1);
  const fresh = await (await fetch(url + '&refresh=1')).json();
  assert.notEqual(fresh.url, first.url); assert.equal(calls, 2);
  fail = true;
  axios.get = async () => { throw new Error('upstream down'); };
  const failed = await fetch(url + '&refresh=1');
  assert.equal(failed.status, 503);
  assert.notEqual(failed.headers.get('X-Cache'), 'STALE');
});
