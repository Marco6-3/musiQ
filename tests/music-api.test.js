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
