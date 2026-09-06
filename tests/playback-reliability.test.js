'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const { audioMetadataFromBytes, probeAudioUrl } = require('../src/server/audio-probe');
const { Dispatcher } = require('../src/server/source-providers/dispatcher');

const provider = (name, url) => ({ name, enabled: true, url });
const verified = async () => ({ verified: true, lossless: true, codec: 'flac' });

test('HTML at a .flac URL is rejected, not verified by its filename or MIME', () => {
  const result = audioMetadataFromBytes(Buffer.from('<html>expired</html>'), 'audio/flac', 'https://example.test/music.flac');
  assert.equal(result.lossless, false);
  assert.equal(result.signature, false);
  assert.equal(result.playable, false);
});

test('unknown bytes and an alac string in an MP4 container do not prove lossless', () => {
  assert.equal(audioMetadataFromBytes(Buffer.from('garbage'), 'audio/flac', '/x.flac').lossless, false);
  assert.equal(audioMetadataFromBytes(Buffer.from('\0\0\0\x20ftypM4A alac'), '', '/x.m4a').lossless, false);
});

test('AAC ADTS is not mislabeled MP3', () => {
  assert.equal(audioMetadataFromBytes(Buffer.from([255, 241, 80, 128])).codec, 'aac');
});

test('WAVE compressed format is not labeled lossless; PCM is', () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF'); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(85, 20);
  assert.equal(audioMetadataFromBytes(wav).lossless, false);
  wav.writeUInt16LE(1, 20);
  assert.equal(audioMetadataFromBytes(wav).lossless, true);
});

test('range-ignoring CDN is probed as a bounded stream; HTTP failures are rejected', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/bad') { res.writeHead(403); res.end('expired'); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(1024 * 1024)]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const good = await probeAudioUrl(base);
  assert.equal(good.verified, true); assert.equal(good.lossless, true);
  const bad = await probeAudioUrl(base + '/bad');
  assert.equal(bad.playable, false); assert.equal(bad.probe_status, 403);
});

test('proxy URL requests use verified lossless selection and report the winning provider', async () => {
  const d = new Dispatcher([
    provider('lossy', async () => ({ url: 'mp3', br: 999 })),
    provider('lossless', async () => ({ url: 'flac', br: 999 }))
  ], { probeAudioUrl: async url => ({ verified: true, lossless: url === 'flac', codec: url }) });
  const response = await d.proxy('url', { id: 'one', br: '999' });
  assert.equal(response.providerName, 'lossless');
  assert.equal(JSON.parse(response.data).lossless, true);
});

test('verified lossless can finish before a stalled provider; duplicate stalls share work', async () => {
  let calls = 0;
  const d = new Dispatcher([
    provider('stalled', () => { calls++; return new Promise(() => {}); }),
    provider('working', async () => ({ url: 'flac', br: 999 }))
  ], { requestTimeout: 80, probeAudioUrl: verified });
  const result = await Promise.race([d.url({ id: 1 }, 'sq'), new Promise(resolve => setTimeout(() => resolve(null), 60))]);
  assert.equal(result?.providerName, 'working');
  await d.url({ id: 1 }, 'sq');
  assert.equal(calls, 1);
});

test('lossy fallback is not tagged lossless and rejects known dead candidates', async () => {
  const d = new Dispatcher([
    provider('dead', async () => ({ url: 'dead', br: 999 })),
    provider('live', async () => ({ url: 'mp3', br: 999 }))
  ], { probeAudioUrl: async url => url === 'dead' ? { playable: false } : { verified: true, lossless: false, codec: 'mp3' } });
  const result = await d.url({ id: 1 }, 'lossless');
  assert.equal(result.providerName, 'live'); assert.equal(result.lossless, false); assert.equal(result.br, 320);
});

test('fallback handles synchronous adapter exceptions and enforces a deadline', async () => {
  const d = new Dispatcher([
    provider('throws', () => { throw new Error('adapter failed'); }),
    provider('hangs', () => new Promise(() => {})),
    provider('ok', async () => ({ url: 'audio', br: 320 }))
  ], { requestTimeout: 15 });
  assert.equal((await d.url({ id: 1 }, 320)).providerName, 'ok');
});

test('the UI never calls unverified high bitrate metadata lossless', () => {
  const source = fs.readFileSync(require.resolve('../webroot/js/main.js'), 'utf8');
  const fn = source.slice(source.indexOf('    function qualityLabel('), source.indexOf('    function formatBytes('));
  const label = vm.runInNewContext(fn + '; qualityLabel');
  assert.equal(label(999, { br: 999 }), '音质未验证');
  assert.notEqual(label(999, { lossless: true, verified_audio: false }), '无损 SQ');
  assert.equal(label(999, { lossless: true, verified_audio: true, codec: 'flac' }), '无损 SQ FLAC');
});

function frontendFunction(name, nextName, context) {
  const source = fs.readFileSync(require.resolve('../webroot/js/main.js'), 'utf8');
  const start = source.indexOf(`    async function ${name}(`);
  const end = source.indexOf(`    async function ${nextName}(`, start + 1);
  return vm.runInNewContext(source.slice(start, end) + `; ${name}`, context);
}

test('late search responses cannot replace a newer query or navigate back from another view', async () => {
  const pending = [];
  const state = { searchRequestId: 0, view: 'search' };
  let renders = 0;
  const search = frontendFunction('searchSongs', 'loadToplist', {
    state, els: { sourceSelect: { value: 'netease' } },
    renderView: () => renders++, showToast: () => {}, normalizeSongList: x => x,
    apiGet: () => new Promise(resolve => pending.push(resolve))
  });
  const old = search('old'); const current = search('new');
  pending[1]([{ id: 'new' }]); await current;
  state.view = 'favorites'; const before = renders;
  pending[0]([{ id: 'old' }]); await old;
  assert.equal(state.searchResults[0].id, 'new');
  assert.equal(renders, before);
  const late = search('late'); state.view = 'home'; const homeRenders = renders;
  pending[2]([]); await late;
  assert.equal(renders, homeRenders);
});

test('clearing a pending search does not leave the loading spinner stuck', async () => {
  let resolve;
  const state = { searchRequestId: 0 };
  const search = frontendFunction('searchSongs', 'loadToplist', {
    state, els: { sourceSelect: { value: 'netease' } }, renderView: () => {},
    showToast: () => {}, normalizeSongList: x => x,
    apiGet: () => new Promise(r => { resolve = r; })
  });
  const old = search('old'); await search(''); resolve([]); await old;
  assert.equal(state.isLoading, false);
});

test('prefetch and playback share one URL resolution and normalize nested metadata', async () => {
  let calls = 0;
  const getUrl = frontendFunction('getAudioUrlForPlayback', 'fetchPreferredAudioUrl', {
    normalizeRequestedQuality: String, getCachedAudioUrl: () => null,
    audioUrlCacheKey: (song, quality) => `${song.id}|${quality}`,
    audioUrlInflight: new Map(), setCachedAudioUrl: () => {},
    fetchPreferredAudioUrl: async () => { calls++; return { data: { url: 'audio', br: 999 } }; }
  });
  const [first, second] = await Promise.all([getUrl({id:1},999), getUrl({id:1},999)]);
  assert.equal(calls, 1); assert.equal(first.url, 'audio'); assert.equal(second.br, 999);
});

test('a stream recovery resolving after a song change cannot overwrite the new audio', async () => {
  let resolve;
  const state = { currentSong: {id:1}, playRequestId: 1, qualityRetryLevel: 0 };
  const audio = { paused: false, currentTime: 10, src: 'new-song' };
  const recover = frontendFunction('recoverHighQualityStream', 'getAudioUrlForPlayback', {
    state, audio, navigator: { onLine: true }, els: { qualitySelect: {value:'999'} },
    guardPlaybackForRuntime: () => false, normalizeRequestedQuality: String,
    setPlayerStatus: () => {}, showToast: () => {}, formatArtists: () => '',
    apiGet: () => new Promise(r => {resolve=r;}),
    isCurrentPlayRequest: id => id === state.playRequestId
  });
  const pending = recover(); state.playRequestId = 2;
  resolve({url:'old-song',br:999}); await pending;
  assert.equal(audio.src, 'new-song'); assert.equal(state.recoveryRequestId, null);
});

test('quality badge keeps verified metadata when the shell redraws without a new URL', () => {
  const source = fs.readFileSync(require.resolve('../webroot/js/main.js'), 'utf8');
  const start = source.indexOf('    function updateQualityBadge(');
  const end = source.indexOf('    function normalizeRequestedQuality(', start);
  const state = { currentQuality: '999', currentAudioMetadata: null };
  const label = {};
  const update = vm.runInNewContext(source.slice(start, end) + '; updateQualityBadge', {
    state, els: { expandedQuality: label, qualitySelect: {value:'999'} },
    qualityLabel: (quality, data) => data?.verified_audio && data.lossless ? 'verified lossless' : 'unknown',
    formatBytes: () => ''
  });
  update({br:999,verified_audio:true,lossless:true}); update();
  assert.equal(label.textContent, 'verified lossless');
  state.currentAudioMetadata = null; update();
  assert.equal(label.textContent, 'unknown');
});
