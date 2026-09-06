'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const { createDataStore, generateToken, hashPassword, ensurePlaylist, insertPlaylistSong } = require('../src/server/database');
const { createExpressApp } = require('../src/server/index');
const { OfflineMusicCache, cacheKey } = require('../src/server/offline-cache');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'music-offline-test-'));
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function insertUser(db) {
  db.prepare(`
    INSERT INTO users (username, email, password_hash, email_verified)
    VALUES ('offline_user', 'offline@example.test', ?, 1)
  `).run(hashPassword('secret123'));
  return db.prepare('SELECT id FROM users WHERE username = ?').get('offline_user').id;
}

function startAudioServer({
  audio = Buffer.from('fake-audio-content'),
  contentType = 'audio/mpeg',
  pathname = '/song.mp3'
} = {}) {
  const server = http.createServer((req, res) => {
    if (req.url !== pathname) {
      res.statusCode = 404;
      res.end('missing');
      return;
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', audio.length);
    res.end(audio);
  });
  return listen(server).then((url) => ({ server, url: `${url}${pathname}`, audio }));
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

async function postForm(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams(body)
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for condition');
}

test('playlist songs stay online until the user explicitly requests a download', async () => {
  const dataDir = createTempDir();
  const audioServer = await startAudioServer();
  let store;
  let cache;

  try {
    store = await createDataStore(dataDir);
    const userId = insertUser(store.db);
    const playlist = ensurePlaylist(store.db, userId, '常听');
    insertPlaylistSong(store.db, playlist.id, {
      id: 'song-1',
      source: 'netease',
      name: 'Song 1',
      artist: 'Artist',
      album: '',
      pic_id: ''
    });

    let dispatcherCalls = 0;
    const dispatcher = {
      async proxy(types, params) {
        dispatcherCalls += 1;
        assert.equal(types, 'url');
        assert.equal(params.br, '999');
        return {
          data: JSON.stringify({ url: audioServer.url, br: 999 }),
          contentType: 'application/json',
          providerName: 'fake'
        };
      }
    };
    cache = new OfflineMusicCache({ db: store.db, dataDir, dispatcher, minBytes: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(dispatcherCalls, 0);
    assert.equal(cache.getTrack('netease', 'song-1'), undefined);

    await cache.requestDownload({
      id: 'song-1',
      source: 'netease',
      name: 'Song 1',
      artist: 'Artist'
    });

    const downloaded = await waitFor(() => cache.getPlayableTrack('netease', 'song-1'));
    assert.equal(dispatcherCalls, 1);
    assert.equal(downloaded.status, 'downloaded');
    assert.equal(downloaded.user_requested, 1);
    assert.ok(fs.existsSync(downloaded.file_path));
    assert.equal(fs.readFileSync(downloaded.file_path, 'utf8'), 'fake-audio-content');

    store.db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?').run(playlist.id);
    assert.equal(cache.getPlayableTrack('netease', 'song-1').status, 'downloaded');
    assert.equal(fs.existsSync(downloaded.file_path), true);
  } finally {
    if (cache) cache.close();
    if (store) store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});

test('offline cache rejects tiny audio files instead of caching ad snippets', async () => {
  const dataDir = createTempDir();
  const audioServer = await startAudioServer({ audio: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1024, 1)]) });
  let store;
  let cache;

  try {
    store = await createDataStore(dataDir);
    const userId = insertUser(store.db);
    const playlist = ensurePlaylist(store.db, userId, 'Tiny Audio');
    insertPlaylistSong(store.db, playlist.id, {
      id: 'tiny-song',
      source: 'kuwo',
      name: '刚好遇见你',
      artist: '李玉刚',
      album: '刚好遇见你'
    });

    cache = new OfflineMusicCache({
      db: store.db,
      dataDir,
      dispatcher: {
        async proxy(types, params) {
          assert.equal(types, 'url');
          assert.equal(params.name, '刚好遇见你');
          assert.equal(params.artist, '李玉刚');
          return { data: JSON.stringify({ url: audioServer.url, br: 999 }) };
        }
      }
    });

    await cache.requestDownload({
      id: 'tiny-song',
      source: 'kuwo',
      name: '刚好遇见你',
      artist: '李玉刚',
      album: '刚好遇见你'
    });
    const failed = await waitFor(() => {
      const row = store.db.prepare('SELECT status, error FROM offline_tracks WHERE song_id = ?').get('tiny-song');
      return row?.status === 'error' ? row : null;
    });

    assert.match(failed.error, /音频文件过小/);
    assert.equal(cache.getPlayableTrack('kuwo', 'tiny-song'), null);
  } finally {
    if (cache) cache.close();
    if (store) await store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});

test('offline cache ignores existing tiny downloaded files and marks them invalid', async () => {
  const dataDir = createTempDir();
  let store;
  let cache;

  try {
    store = await createDataStore(dataDir);
    cache = new OfflineMusicCache({ db: store.db, dataDir, dispatcher: { async proxy() { return null; } } });
    const key = cacheKey('kuwo', 'bad-existing');
    const filePath = path.join(cache.audioDir, `${key}.mp3`);
    fs.writeFileSync(filePath, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1024, 1)]));

    store.db.prepare(`
      INSERT INTO offline_tracks
        (cache_key, song_id, source, name, artist, status, file_path, content_type, br, size, user_requested, updated_at)
      VALUES (?, ?, ?, ?, ?, 'downloaded', ?, 'audio/mpeg', 999, ?, 1, strftime('%s', 'now'))
    `).run(key, 'bad-existing', 'kuwo', 'Bad Existing', 'Artist', filePath, fs.statSync(filePath).size);

    assert.equal(cache.getPlayableTrack('kuwo', 'bad-existing'), null);
    const row = store.db.prepare('SELECT status, error FROM offline_tracks WHERE cache_key = ?').get(key);
    assert.equal(row.status, 'error');
    assert.match(row.error, /离线音频文件过小/);
  } finally {
    if (cache) cache.close();
    if (store) await store.close();
    removeTempDir(dataDir);
  }
});

test('legacy playlist-driven cache files are removed during the explicit-download upgrade', async () => {
  const dataDir = createTempDir();
  let store;
  let cache;

  try {
    store = await createDataStore(dataDir);
    cache = new OfflineMusicCache({ db: store.db, dataDir, dispatcher: { async proxy() { return null; } } });
    const key = cacheKey('netease', 'legacy-auto');
    const filePath = path.join(cache.audioDir, `${key}.mp3`);
    fs.writeFileSync(filePath, Buffer.from('legacy automatic cache'));
    store.db.prepare(`
      INSERT INTO offline_tracks
        (cache_key, song_id, source, name, status, file_path, content_type, br, size, updated_at)
      VALUES (?, ?, ?, ?, 'downloaded', ?, 'audio/mpeg', 999, ?, strftime('%s', 'now'))
    `).run(key, 'legacy-auto', 'netease', 'Legacy Auto', filePath, fs.statSync(filePath).size);

    assert.equal(cache.getPlayableTrack('netease', 'legacy-auto'), null);
    assert.equal(await cache.removeUnrequestedTracks(), 1);
    assert.equal(cache.getTrack('netease', 'legacy-auto'), undefined);
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    if (cache) cache.close();
    if (store) store.close();
    removeTempDir(dataDir);
  }
});

test('music API returns local offline URL when the track is downloaded', async () => {
  const dataDir = createTempDir();
  const audioServer = await startAudioServer();
  let store;
  let cache;
  let appServer;

  try {
    store = await createDataStore(dataDir);
    const userId = insertUser(store.db);
    const playlist = ensurePlaylist(store.db, userId, '常听');
    insertPlaylistSong(store.db, playlist.id, {
      id: 'song-2',
      source: 'netease',
      name: 'Song 2',
      artist: 'Artist'
    });

    cache = new OfflineMusicCache({
      db: store.db,
      dataDir,
      minBytes: 1,
      dispatcher: {
        async proxy() {
          return { data: JSON.stringify({ url: audioServer.url, br: 999 }) };
        }
      }
    });
    await cache.requestDownload({
      id: 'song-2',
      source: 'netease',
      name: 'Song 2',
      artist: 'Artist'
    });
    await waitFor(() => cache.getPlayableTrack('netease', 'song-2'));

    const app = createExpressApp({
      store,
      uploadsDir: path.join(dataDir, 'uploads', 'avatars'),
      cacheDir: path.join(dataDir, 'cache'),
      dispatcher: {
        async proxy() {
          throw new Error('online provider should not be called for downloaded track');
        }
      },
      offlineCache: cache
    });
    appServer = http.createServer(app);
    const baseUrl = await listen(appServer);

    const response = await fetch(`${baseUrl}/api.php?types=url&source=netease&id=song-2&br=320`);
    const body = await response.json();

    assert.equal(response.headers.get('x-cache'), 'OFFLINE');
    assert.equal(response.headers.get('x-music-source'), 'offline');
    assert.equal(body.offline, true);
    assert.match(body.url, /^\/offline\/audio\//);

    const audioResponse = await fetch(`${baseUrl}${body.url}`, {
      headers: { Range: 'bytes=0-3' }
    });
    assert.equal(audioResponse.status, 206);
    assert.equal(await audioResponse.text(), 'fake');

    const originalCreateReadStream = fs.createReadStream;
    fs.createReadStream = () => new Readable({
      read() {
        const error = new Error('simulated missing file');
        error.code = 'ENOENT';
        this.destroy(error);
      }
    });
    try {
      const failedAudioResponse = await fetch(`${baseUrl}${body.url}`);
      assert.equal(failedAudioResponse.status, 404);
    } finally {
      fs.createReadStream = originalCreateReadStream;
    }
  } finally {
    if (appServer) appServer.close();
    if (cache) cache.close();
    if (store) store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});

test('music API downgrades fake lossless metadata when the audio URL is MP3', async () => {
  const dataDir = createTempDir();
  const mp3Audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 1)]);
  const audioServer = await startAudioServer({
    audio: mp3Audio,
    contentType: 'audio/x-flac',
    pathname: '/fake-lossless.flac'
  });
  let store;
  let appServer;

  try {
    store = await createDataStore(dataDir);
    const app = createExpressApp({
      store,
      uploadsDir: path.join(dataDir, 'uploads', 'avatars'),
      cacheDir: path.join(dataDir, 'cache'),
      dispatcher: {
        async proxy(types, params) {
          assert.equal(types, 'url');
          assert.equal(params.br, '999');
          return {
            data: JSON.stringify({ url: audioServer.url, br: 999 }),
            contentType: 'application/json',
            providerName: 'fake-online'
          };
        }
      }
    });
    appServer = http.createServer(app);
    const baseUrl = await listen(appServer);

    const response = await fetch(`${baseUrl}/api.php?types=url&source=netease&id=mp3-song&br=999`);
    const body = await response.json();

    assert.equal(response.headers.get('x-music-source'), 'fake-online');
    assert.equal(body.url, audioServer.url);
    assert.equal(body.verified_audio, true);
    assert.equal(body.lossless, false);
    assert.equal(body.codec, 'mp3');
    assert.equal(body.content_type, 'audio/mpeg');
    assert.equal(body.br, 320);
  } finally {
    if (appServer) appServer.close();
    if (store) store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});

test('music API keeps lossless metadata when the audio URL is FLAC', async () => {
  const dataDir = createTempDir();
  const flacAudio = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(32, 1)]);
  const audioServer = await startAudioServer({
    audio: flacAudio,
    contentType: 'audio/mpeg',
    pathname: '/wrong-type.mp3'
  });
  let store;
  let appServer;

  try {
    store = await createDataStore(dataDir);
    const app = createExpressApp({
      store,
      uploadsDir: path.join(dataDir, 'uploads', 'avatars'),
      cacheDir: path.join(dataDir, 'cache'),
      dispatcher: {
        async proxy() {
          return {
            data: JSON.stringify({ url: audioServer.url, br: 811 }),
            contentType: 'application/json',
            providerName: 'fake-online'
          };
        }
      }
    });
    appServer = http.createServer(app);
    const baseUrl = await listen(appServer);

    const response = await fetch(`${baseUrl}/api.php?types=url&source=netease&id=flac-song&br=999`);
    const body = await response.json();

    assert.equal(body.url, audioServer.url);
    assert.equal(body.verified_audio, true);
    assert.equal(body.lossless, true);
    assert.equal(body.codec, 'flac');
    assert.equal(body.content_type, 'audio/x-flac');
    assert.equal(body.br, 999);
  } finally {
    if (appServer) appServer.close();
    if (store) store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});

test('music API annotates nested URL payload metadata', async () => {
  const dataDir = createTempDir();
  const flacAudio = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(32, 1)]);
  const audioServer = await startAudioServer({
    audio: flacAudio,
    contentType: 'audio/x-flac',
    pathname: '/nested.flac'
  });
  let store;
  let appServer;

  try {
    store = await createDataStore(dataDir);
    const app = createExpressApp({
      store,
      uploadsDir: path.join(dataDir, 'uploads', 'avatars'),
      cacheDir: path.join(dataDir, 'cache'),
      dispatcher: {
        async proxy() {
          return {
            data: JSON.stringify({ data: { url: audioServer.url, br: 999 } }),
            contentType: 'application/json',
            providerName: 'fake-online'
          };
        }
      }
    });
    appServer = http.createServer(app);
    const baseUrl = await listen(appServer);

    const response = await fetch(`${baseUrl}/api.php?types=url&source=netease&id=nested-flac&br=999`);
    const body = await response.json();

    assert.equal(body.data.url, audioServer.url);
    assert.equal(body.data.verified_audio, true);
    assert.equal(body.data.lossless, true);
    assert.equal(body.data.codec, 'flac');
    assert.equal(body.data.content_type, 'audio/x-flac');
    assert.equal(body.data.br, 999);
    assert.equal(body.lossless, undefined);
  } finally {
    if (appServer) appServer.close();
    if (store) store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});

test('music API does not trust a FLAC extension when the audio probe fails', async () => {
  const dataDir = createTempDir();
  let store;
  let appServer;

  try {
    store = await createDataStore(dataDir);
    const app = createExpressApp({
      store,
      uploadsDir: path.join(dataDir, 'uploads', 'avatars'),
      cacheDir: path.join(dataDir, 'cache'),
      dispatcher: {
        async proxy() {
          return {
            data: JSON.stringify({ url: 'http://127.0.0.1:9/unreachable.flac', br: 999 }),
            contentType: 'application/json',
            providerName: 'fake-online'
          };
        }
      }
    });
    appServer = http.createServer(app);
    const baseUrl = await listen(appServer);

    const response = await fetch(`${baseUrl}/api.php?types=url&source=netease&id=unreachable&br=999`);
    const body = await response.json();

    assert.equal(body.verified_audio, false);
    assert.equal(body.lossless, false);
    assert.equal(body.codec, undefined);
    assert.equal(body.content_type, undefined);
    assert.equal(body.br, 320);
  } finally {
    if (appServer) appServer.close();
    if (store) store.close();
    removeTempDir(dataDir);
  }
});

test('adding to a server playlist does not download until the protected download action is requested', async () => {
  const dataDir = createTempDir();
  const audioServer = await startAudioServer({
    audio: Buffer.from('server-account-audio-content'),
    contentType: 'audio/mpeg',
    pathname: '/account-song.mp3'
  });
  let store;
  let cache;
  let appServer;
  let downloadRequests = 0;

  try {
    store = await createDataStore(dataDir);
    const userId = insertUser(store.db);
    const token = generateToken(userId);

    cache = new OfflineMusicCache({
      db: store.db,
      dataDir,
      minBytes: 1,
      dispatcher: {
        async proxy(types, params) {
          downloadRequests += 1;
          assert.equal(types, 'url');
          assert.equal(params.id, 'account-song');
          return {
            data: JSON.stringify({ url: audioServer.url, br: 999 }),
            contentType: 'application/json',
            providerName: 'fake-cache-source'
          };
        }
      }
    });

    const app = createExpressApp({
      store,
      uploadsDir: path.join(dataDir, 'uploads', 'avatars'),
      cacheDir: path.join(dataDir, 'cache'),
      dispatcher: {
        async proxy() {
          throw new Error('online provider should not be called for downloaded account track');
        }
      },
      offlineCache: cache
    });
    appServer = http.createServer(app);
    const baseUrl = await listen(appServer);

    const created = await postForm(baseUrl, '/php/playlist.php', {
      token,
      user_id: String(userId),
      action: 'create',
      name: '服务器歌单'
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.success, true);

    const added = await postForm(baseUrl, '/php/playlist.php', {
      token,
      user_id: String(userId),
      action: 'add_song',
      playlist_id: String(created.body.playlist_id),
      song_id: 'account-song',
      source: 'netease',
      name: 'Account Song',
      artist: 'Artist'
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.success, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(downloadRequests, 0);
    assert.equal(cache.getTrack('netease', 'account-song'), undefined);

    const requested = await postForm(baseUrl, '/php/offline_track.php', {
      token,
      user_id: String(userId),
      action: 'download',
      song_id: 'account-song',
      source: 'netease',
      name: 'Account Song',
      artist: 'Artist'
    });
    assert.equal(requested.status, 202);
    assert.equal(requested.body.success, true);
    assert.equal(requested.body.status, 'pending');

    const downloaded = await waitFor(() => cache.getPlayableTrack('netease', 'account-song'));
    assert.equal(downloadRequests, 1);
    assert.equal(downloaded.status, 'downloaded');
    assert.ok(fs.existsSync(downloaded.file_path));

    const loggedIn = await postForm(baseUrl, '/php/login.php', {
      username: 'offline_user',
      password: 'secret123'
    });
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.body.success, true);
    assert.equal(loggedIn.body.user.playlists['服务器歌单'].length, 1);
    assert.equal(loggedIn.body.user.playlists['服务器歌单'][0].id, 'account-song');

    const playback = await fetch(`${baseUrl}/api.php?types=url&source=netease&id=account-song&br=999`);
    const body = await playback.json();
    assert.equal(playback.headers.get('x-cache'), 'OFFLINE');
    assert.equal(playback.headers.get('x-music-source'), 'offline');
    assert.equal(body.offline, true);
    assert.match(body.url, /^\/offline\/audio\//);

    const audioResponse = await fetch(`${baseUrl}${body.url}`, {
      headers: { Range: 'bytes=0-5' }
    });
    assert.equal(audioResponse.status, 206);
    assert.equal(await audioResponse.text(), 'server');
  } finally {
    if (appServer) appServer.close();
    if (cache) cache.close();
    if (store) store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});

test('music API returns and prewarms iPhone ALAC URL for offline FLAC lossless requests', async () => {
  const dataDir = createTempDir();
  const audioServer = await startAudioServer({
    audio: Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16, 1)]),
    contentType: 'audio/mpeg',
    pathname: '/song.flac'
  });
  let store;
  let cache;
  let appServer;
  let conversion;
  let conversionCount = 0;

  try {
    store = await createDataStore(dataDir);
    const userId = insertUser(store.db);
    const playlist = ensurePlaylist(store.db, userId, '常听');
    insertPlaylistSong(store.db, playlist.id, {
      id: 'song-ios',
      source: 'netease',
      name: 'Song iOS',
      artist: 'Artist'
    });

    cache = new OfflineMusicCache({
      db: store.db,
      dataDir,
      minBytes: 1,
      dispatcher: {
        async proxy() {
          return { data: JSON.stringify({ url: audioServer.url, br: 999 }) };
        }
      }
    });
    await cache.requestDownload({ id: 'song-ios', source: 'netease', name: 'Song iOS', artist: 'Artist' });
    const downloaded = await waitFor(() => cache.getPlayableTrack('netease', 'song-ios'));
    assert.equal(downloaded.content_type, 'audio/x-flac');

    const app = createExpressApp({
      store,
      uploadsDir: path.join(dataDir, 'uploads', 'avatars'),
      cacheDir: path.join(dataDir, 'cache'),
      dispatcher: {
        async proxy() {
          throw new Error('online provider should not be called for downloaded lossless iPhone track');
        }
      },
      offlineCache: cache,
      iosLosslessConverter: async (sourcePath, outputPath) => {
        conversionCount += 1;
        conversion = { sourcePath, outputPath };
        await fs.promises.writeFile(outputPath, Buffer.from('ftyp-alac-audio-content'));
      }
    });
    appServer = http.createServer(app);
    const baseUrl = await listen(appServer);

    const response = await fetch(`${baseUrl}/api.php?types=url&source=netease&id=song-ios&br=999`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
      }
    });
    const body = await response.json();

    assert.equal(response.headers.get('x-cache'), 'OFFLINE-ALAC');
    assert.equal(response.headers.get('x-music-source'), 'offline');
    assert.equal(response.headers.get('x-playback-compatibility'), 'ios-alac');
    assert.equal(body.url, `/offline/audio/${downloaded.cache_key}/alac.m4a`);
    assert.equal(body.br, 999);
    assert.equal(body.offline, true);
    assert.equal(body.lossless, true);
    assert.equal(body.codec, 'alac');

    const expectedAlacPath = path.join(path.dirname(downloaded.file_path), `${downloaded.cache_key}.ios-lossless.m4a`);
    await waitFor(() => fs.existsSync(expectedAlacPath));
    assert.equal(conversionCount, 1);
    assert.equal(conversion.sourcePath, downloaded.file_path);
    assert.match(conversion.outputPath, /\.ios-lossless\.m4a\.tmp-/);

    const audioResponse = await fetch(`${baseUrl}${body.url}`, {
      headers: { Range: 'bytes=0-3' }
    });
    assert.equal(audioResponse.status, 206);
    assert.equal(audioResponse.headers.get('content-type'), 'audio/mp4');
    assert.equal(audioResponse.headers.get('x-offline-transcode'), 'alac-cache');
    assert.equal(await audioResponse.text(), 'ftyp');
    assert.equal(conversionCount, 1);

    const cachedAudioResponse = await fetch(`${baseUrl}${body.url}`, {
      headers: { Range: 'bytes=5-8' }
    });
    assert.equal(cachedAudioResponse.status, 206);
    assert.equal(cachedAudioResponse.headers.get('x-offline-transcode'), 'alac-cache');
    assert.equal(await cachedAudioResponse.text(), 'alac');
  } finally {
    if (appServer) appServer.close();
    if (cache) cache.close();
    if (store) store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});

test('music API skips offline FLAC for iPhone when compatible quality is requested', async () => {
  const dataDir = createTempDir();
  const audioServer = await startAudioServer({
    audio: Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16, 1)]),
    contentType: 'audio/mpeg',
    pathname: '/song.flac'
  });
  let store;
  let cache;
  let appServer;
  let onlineRequest;

  try {
    store = await createDataStore(dataDir);
    const userId = insertUser(store.db);
    const playlist = ensurePlaylist(store.db, userId, '常听');
    insertPlaylistSong(store.db, playlist.id, {
      id: 'song-ios-320',
      source: 'netease',
      name: 'Song iOS 320',
      artist: 'Artist'
    });

    cache = new OfflineMusicCache({
      db: store.db,
      dataDir,
      minBytes: 1,
      dispatcher: {
        async proxy() {
          return { data: JSON.stringify({ url: audioServer.url, br: 999 }) };
        }
      }
    });
    await cache.requestDownload({ id: 'song-ios-320', source: 'netease', name: 'Song iOS 320', artist: 'Artist' });
    const downloaded = await waitFor(() => cache.getPlayableTrack('netease', 'song-ios-320'));
    assert.equal(downloaded.content_type, 'audio/x-flac');

    const app = createExpressApp({
      store,
      uploadsDir: path.join(dataDir, 'uploads', 'avatars'),
      cacheDir: path.join(dataDir, 'cache'),
      dispatcher: {
        async proxy(types, params) {
          onlineRequest = { types, params };
          return {
            data: JSON.stringify({ url: 'https://example.test/song.mp3', br: 320 }),
            contentType: 'application/json',
            providerName: 'fake-online'
          };
        }
      },
      offlineCache: cache
    });
    appServer = http.createServer(app);
    const baseUrl = await listen(appServer);

    const response = await fetch(`${baseUrl}/api.php?types=url&source=netease&id=song-ios-320&br=320`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
      }
    });
    const body = await response.json();

    assert.equal(response.headers.get('x-offline-skip'), 'ios-incompatible-audio');
    assert.equal(response.headers.get('x-playback-compatibility'), null);
    assert.equal(response.headers.get('x-music-source'), 'fake-online');
    assert.deepEqual(onlineRequest, {
      types: 'url',
      params: { source: 'netease', id: 'song-ios-320', br: '320' }
    });
    assert.equal(body.url, 'https://example.test/song.mp3');
    assert.equal(body.br, 320);
    assert.equal(body.offline, undefined);
  } finally {
    if (appServer) appServer.close();
    if (cache) cache.close();
    if (store) store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});

test('offline cache detects FLAC content when provider metadata is wrong', async () => {
  const dataDir = createTempDir();
  const flacAudio = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16, 1)]);
  const audioServer = await startAudioServer({
    audio: flacAudio,
    contentType: 'audio/mpeg',
    pathname: '/wrong-type.mp3'
  });
  let store;
  let cache;

  try {
    store = await createDataStore(dataDir);
    const userId = insertUser(store.db);
    const playlist = ensurePlaylist(store.db, userId, '常听');
    insertPlaylistSong(store.db, playlist.id, {
      id: 'song-flac',
      source: 'netease',
      name: 'FLAC Song',
      artist: 'Artist'
    });

    cache = new OfflineMusicCache({
      db: store.db,
      dataDir,
      minBytes: 1,
      dispatcher: {
        async proxy() {
          return { data: JSON.stringify({ url: audioServer.url, br: 811 }) };
        }
      }
    });
    await cache.requestDownload({ id: 'song-flac', source: 'netease', name: 'FLAC Song', artist: 'Artist' });

    const downloaded = await waitFor(() => cache.getPlayableTrack('netease', 'song-flac'));
    assert.equal(path.extname(downloaded.file_path), '.flac');
    assert.equal(downloaded.content_type, 'audio/x-flac');
    assert.equal(downloaded.br, 999);
    assert.deepEqual(fs.readFileSync(downloaded.file_path), flacAudio);
  } finally {
    if (cache) cache.close();
    if (store) store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});

test('offline cache preserves URL extension when content type is generic and format is unknown', async () => {
  const dataDir = createTempDir();
  const audioServer = await startAudioServer({
    audio: Buffer.from('unknown-audio-content'),
    contentType: 'application/octet-stream',
    pathname: '/provider-file.flac'
  });
  let store;
  let cache;

  try {
    store = await createDataStore(dataDir);
    const userId = insertUser(store.db);
    const playlist = ensurePlaylist(store.db, userId, '常听');
    insertPlaylistSong(store.db, playlist.id, {
      id: 'song-generic',
      source: 'netease',
      name: 'Generic Song',
      artist: 'Artist'
    });

    cache = new OfflineMusicCache({
      db: store.db,
      dataDir,
      minBytes: 1,
      dispatcher: {
        async proxy() {
          return { data: JSON.stringify({ url: audioServer.url, br: 999 }) };
        }
      }
    });
    await cache.requestDownload({ id: 'song-generic', source: 'netease', name: 'Generic Song', artist: 'Artist' });

    const downloaded = await waitFor(() => cache.getPlayableTrack('netease', 'song-generic'));
    assert.equal(path.extname(downloaded.file_path), '.flac');
    assert.equal(downloaded.content_type, 'application/octet-stream');
    assert.equal(fs.readFileSync(downloaded.file_path, 'utf8'), 'unknown-audio-content');
  } finally {
    if (cache) cache.close();
    if (store) store.close();
    audioServer.server.close();
    removeTempDir(dataDir);
  }
});
