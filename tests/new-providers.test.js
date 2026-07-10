'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { LrclibProvider } = require('../src/server/source-providers/lrclib');
const { Dispatcher } = require('../src/server/source-providers/dispatcher');
const { createDefaultDispatcher } = require('../src/server/source-providers/index');
const { MetingProvider } = require('../src/server/source-providers/meting');
const { UnmProvider } = require('../src/server/source-providers/unm');
const { UnmExternalProvider } = require('../src/server/source-providers/unm-external');
const { KuwoDirectProvider } = require('../src/server/source-providers/kuwo-direct');
const { KugouDirectProvider, normalizeKugouImageUrl } = require('../src/server/source-providers/kugou-direct');
const { rankSearchResults } = require('../src/server/source-providers/match');
const { checkSourceHealth, healthProbeForProvider } = require('../src/server/api-monitor');
const config = require('../src/config');

describe('LrclibProvider lyrics', () => {
  it('should fetch lyrics for a known song', async () => {
    const p = new LrclibProvider();
    const result = await p.lyric({ name: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera' });
    if (result) {
      assert.ok(result.lyric, 'should have lyric text');
      console.log(`  [LRCLIB] got lyrics (${result.lyric.length} chars), synced: ${!!result.tlyric}`);
    } else {
      console.log('  [LRCLIB] no result for Bohemian Rhapsody (API may be down)');
    }
  });

  it('should fetch lyrics for a Chinese song', async () => {
    const p = new LrclibProvider();
    const result = await p.lyric({ name: '晴天', artist: '周杰伦' });
    if (result) {
      assert.ok(result.lyric, 'should have lyric text');
      console.log(`  [LRCLIB] got 晴天 lyrics (${result.lyric.length} chars)`);
    } else {
      console.log('  [LRCLIB] no result for 晴天 (may not be in LRCLIB database)');
    }
  });

  it('should return null for missing song info', async () => {
    const p = new LrclibProvider();
    const result = await p.lyric({ name: '', artist: '' });
    assert.equal(result, null);
  });

  it('should return null for nonexistent song', async () => {
    const p = new LrclibProvider({ timeout: 5000 });
    const result = await p.lyric({ name: 'zzzznonexistent_song_xyz_12345', artist: 'nobody' });
    assert.equal(result, null);
  });

  it('should work via proxy method', async () => {
    const p = new LrclibProvider();
    const result = await p.proxy('lyric', { name: 'Yesterday', artist: 'The Beatles' });
    if (result) {
      assert.equal(result.ok, true);
      assert.equal(result.providerName, 'lrclib');
      const parsed = JSON.parse(result.data);
      assert.ok(parsed.lyric);
      console.log(`  [LRCLIB] proxy returned ${parsed.lyric.length} chars`);
    } else {
      console.log('  [LRCLIB] proxy returned null');
    }
  });

  it('should return null for non-lyric proxy types', async () => {
    const p = new LrclibProvider();
    const result = await p.proxy('search', { name: 'test' });
    assert.equal(result, null);
  });
});

describe('Dispatcher integration', () => {
  it('should create dispatcher with lrclib enabled from config', () => {
    const dispatcher = createDefaultDispatcher(config.musicSources);
    const names = dispatcher.providers.map(p => p.name);
    assert.ok(names.includes('lrclib'), `providers should include lrclib, got: ${names}`);
    assert.ok(names.includes('gdstudio'), `providers should include gdstudio, got: ${names}`);
    console.log(`  [Dispatcher] provider order: ${names.join(' -> ')}`);
  });

  it('should fallback to lrclib for lyrics when other providers fail', async () => {
    const dispatcher = createDefaultDispatcher({
      ...config.musicSources,
      gdstudio: { enabled: false },
      meting: { enabled: false },
      unm: { enabled: false },
      lrclib: { enabled: true }
    });
    const result = await dispatcher.lyric({ name: 'Yesterday', artist: 'The Beatles' });
    if (result) {
      assert.ok(result.lyric || result.tlyric);
      console.log(`  [Dispatcher] lrclib lyric fallback worked`);
    } else {
      console.log('  [Dispatcher] lrclib lyric fallback returned null');
    }
  });

  it('should expand race providers after the priority timeout', async () => {
    const slow = fakeProvider('slow-priority', 200, [{ id: 'slow' }]);
    const fast = fakeProvider('fast-fallback', 30, [{ id: 'fast' }]);
    const dispatcher = new Dispatcher([slow, fast], {
      strategy: 'race',
      racePriorityCount: 1,
      racePriorityTimeout: 20
    });

    const startedAt = Date.now();
    const result = await dispatcher.search('netease', 'test', 1);

    assert.equal(result[0].id, 'fast');
    assert.ok(Date.now() - startedAt < 150, 'fallback provider should not wait for slow priority timeout');
  });

  it('should probe a single lossless URL candidate before returning it', async () => {
    const audioServer = await startAudioServer(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 1)]), 'audio/mpeg');
    const dispatcher = new Dispatcher([{
      name: 'fake-url',
      enabled: true,
      async url() {
        return { url: audioServer.url, br: 999000 };
      }
    }]);

    try {
      const result = await dispatcher.url({ id: 'fake-song' }, '999');
      assert.equal(result.url, audioServer.url);
      assert.equal(result.br, 320);
      assert.equal(result.verified_audio, true);
      assert.equal(result.lossless, false);
      assert.equal(result.codec, 'mp3');
      assert.equal(result.content_type, 'audio/mpeg');
    } finally {
      audioServer.server.close();
    }
  });

  it('prefers a source-specific direct provider before generic URL fallbacks', async () => {
    const calls = [];
    const generic = {
      name: 'generic-fallback',
      enabled: true,
      async proxy() {
        calls.push('generic-fallback');
        return { data: JSON.stringify({ url: 'https://example.test/wrong.mp3' }) };
      }
    };
    const direct = {
      name: 'kuwo-direct',
      enabled: true,
      async proxy() {
        calls.push('kuwo-direct');
        return { data: JSON.stringify({ url: 'https://example.test/correct.mp3' }) };
      }
    };
    const dispatcher = new Dispatcher([generic, direct]);

    const result = await dispatcher.proxy('url', { source: 'kuwo', id: '228908' });

    assert.deepEqual(calls, ['kuwo-direct']);
    assert.equal(JSON.parse(result.data).url, 'https://example.test/correct.mp3');
  });

  it('uses the same source preference for direct Dispatcher URL calls', async () => {
    const calls = [];
    const generic = {
      name: 'generic-fallback',
      enabled: true,
      async url() {
        calls.push('generic-fallback');
        return { url: 'https://example.test/wrong.mp3', br: 320 };
      }
    };
    const direct = {
      name: 'kuwo-direct',
      enabled: true,
      async url() {
        calls.push('kuwo-direct');
        return { url: 'https://example.test/correct.mp3', br: 320 };
      }
    };
    const dispatcher = new Dispatcher([generic, direct]);

    const result = await dispatcher.url({ source: 'kuwo', id: '228908' }, '320');

    assert.deepEqual(calls, ['kuwo-direct']);
    assert.equal(result.url, 'https://example.test/correct.mp3');
  });
});

describe('Provider error tolerance', () => {
  it('MetingProvider returns empty results for non-JSON provider responses', async () => {
    const p = new MetingProvider();
    p._ensureMeting = async () => ({
      async search() { return '<html>error</html>'; },
      async url() { return '<html>error</html>'; },
      async lyric() { return '<html>error</html>'; },
      async pic() { return '<html>error</html>'; }
    });

    assert.deepEqual(await p.search('netease', 'test', 1), []);
    assert.deepEqual(await p.url({ id: '1', source: 'netease' }), { url: undefined, br: 320 });
    assert.deepEqual(await p.lyric({ id: '1', source: 'netease' }), { lyric: '' });
    assert.deepEqual(await p.pic({ pic_id: '1', source: 'netease' }), { url: undefined });
  });

  it('MetingProvider skips missing IDs and the unsafe Kugou artwork path', async () => {
    const p = new MetingProvider();
    let metingLoads = 0;
    p._ensureMeting = async () => {
      metingLoads += 1;
      throw new Error('should not load Meting for an unsupported artwork request');
    };

    assert.equal(await p.pic({ source: 'kugou', pic_id: 'hash' }), null);
    assert.equal(await p.pic({ source: 'netease', pic_id: '' }), null);
    assert.equal(await p.proxy('pic', { source: 'kugou', id: 'hash' }), null);
    assert.equal(await p.proxy('pic', { source: 'netease', id: '' }), null);
    assert.equal(metingLoads, 0);
  });

  it('UnmExternalProvider normalizes nullable and nested lyric payloads', async () => {
    const p = new UnmExternalProvider();

    p._get = async () => ({ lrc: null });
    assert.equal(await p.lyric({ id: '1', source: 'netease' }), null);

    p._get = async () => ({ lrc: { lyric: 'line one' } });
    assert.deepEqual(await p.lyric({ id: '1', source: 'netease' }), { lyric: 'line one' });
  });

  it('KuwoDirectProvider exposes search and url through proxy', async () => {
    const p = new KuwoDirectProvider();
    p.search = async () => ([{ id: '123', name: '晴天', title: '晴天', artist: '周杰伦', source: 'kuwo' }]);
    p.url = async () => ({ url: 'https://example.test/kuwo.mp3', br: 320, from: 'kuwo-direct' });

    const search = await p.proxy('search', { source: 'kuwo', name: '晴天', count: 1 });
    assert.equal(search.providerName, 'kuwo-direct');
    assert.deepEqual(JSON.parse(search.data), [{ id: '123', name: '晴天', title: '晴天', artist: '周杰伦', source: 'kuwo' }]);

    const url = await p.proxy('url', { id: '123', name: '晴天', artist: '周杰伦', br: '320' });
    assert.equal(url.providerName, 'kuwo-direct');
    assert.deepEqual(JSON.parse(url.data), { url: 'https://example.test/kuwo.mp3', br: 320, from: 'kuwo-direct' });
  });

  it('KuwoDirectProvider parses one blank-line song block without mixing fields', () => {
    const p = new KuwoDirectProvider();
    const songs = p._parseSearchResult(`RN=1

ARTIST=周杰伦
ALBUM=叶惠美
DURATION=269
IMG=http://img.example/cover.jpg
MUSICRID=MUSIC_228908
SONGNAME=晴天

ARTIST=周杰伦
ALBUM=Live
DURATION=249
MUSICRID=MUSIC_80456317
SONGNAME=晴天 (Live)
`);

    assert.equal(songs[0].id, '228908');
    assert.equal(songs[0].name, '晴天');
    assert.equal(songs[0].artist, '周杰伦');
    assert.equal(songs[0].album, '叶惠美');
    assert.equal(songs[0].pic, 'http://img.example/cover.jpg');
    assert.equal(songs[1].id, '80456317');
  });

  it('KuwoDirectProvider upgrades legacy image hosts to browser-safe HTTPS', () => {
    const p = new KuwoDirectProvider();
    const [song] = p._parseSearchResult(`ARTIST=周杰伦
ALBUM=叶惠美
DURATION=269
IMG=http://img2.sycdn.kuwo.cn/wmvpic/cover.jpg
MUSICRID=MUSIC_228908
SONGNAME=晴天
`);

    assert.equal(song.pic, 'https://img2.kuwo.cn/wmvpic/cover.jpg');
  });

  it('UnmProvider does not invent reversed title and artist metadata from a query', () => {
    const p = new UnmProvider();
    const song = p._buildSyntheticSong({
      id: 'synthetic',
      keyword: '周杰伦 晴天',
      sourceName: 'bodian',
      directUrl: 'https://example.test/audio.flac'
    });

    assert.equal(song.name, '周杰伦 晴天');
    assert.equal(song.artist, '');
  });

  it('direct source providers do not claim non-matching URL sources', async () => {
    const p = new KuwoDirectProvider();
    p.url = async () => {
      throw new Error('should not call url for non-matching source');
    };
    assert.equal(await p.proxy('url', {
      source: 'netease',
      id: 'netease-id',
      name: '晴天',
      artist: '周杰伦',
      br: '320'
    }), null);

    const kugou = new KugouDirectProvider();
    kugou.url = async () => {
      throw new Error('should not call url for non-matching source');
    };
    assert.equal(await kugou.proxy('url', {
      source: 'netease',
      id: 'netease-id',
      name: '晴天',
      artist: '周杰伦',
      br: '320'
    }), null);

    assert.equal(await new KuwoDirectProvider().url({ source: 'kugou', id: 'hash' }, '320'), null);
    assert.equal(await new KugouDirectProvider().url({ source: 'kuwo', id: 'rid', name: '晴天' }, '320'), null);
  });

  it('KugouDirectProvider exposes search and url through proxy', async () => {
    const p = new KugouDirectProvider();
    p.search = async () => ([{ id: 'hash', name: '晴天', title: '晴天', artist: '周杰伦', source: 'kugou' }]);
    p.url = async () => ({ url: 'https://example.test/kugou-via-kuwo.mp3', br: 320, from: 'kugou-via-kuwo' });

    const search = await p.proxy('search', { source: 'kugou', name: '晴天', count: 1 });
    assert.equal(search.providerName, 'kugou-direct');
    assert.deepEqual(JSON.parse(search.data), [{ id: 'hash', name: '晴天', title: '晴天', artist: '周杰伦', source: 'kugou' }]);

    const url = await p.proxy('url', { id: 'hash', name: '晴天', artist: '周杰伦', br: '320' });
    assert.equal(url.providerName, 'kugou-direct');
    assert.deepEqual(JSON.parse(url.data), { url: 'https://example.test/kugou-via-kuwo.mp3', br: 320, from: 'kugou-via-kuwo' });
  });

  it('KugouDirectProvider turns search artwork templates into secure cover URLs', () => {
    assert.equal(
      normalizeKugouImageUrl('http://imge.example.test/stdmusic/{size}/cover.jpg'),
      'https://imge.example.test/stdmusic/400/cover.jpg'
    );
    assert.equal(normalizeKugouImageUrl(''), '');
  });

  it('direct source providers only claim matching search sources', async () => {
    assert.deepEqual(await new KuwoDirectProvider().search('kugou', '晴天', 1), []);
    assert.deepEqual(await new KugouDirectProvider().search('kuwo', '晴天', 1), []);
  });

  it('api monitor probes direct providers with their own source', async () => {
    assert.deepEqual(healthProbeForProvider({ name: 'kuwo-direct' }), { platform: 'kuwo', keyword: '周杰伦 晴天' });
    assert.deepEqual(healthProbeForProvider({ name: 'kugou-direct' }), { platform: 'kugou', keyword: '周杰伦 晴天' });

    const calls = [];
    const health = await checkSourceHealth({
      name: 'kuwo-direct',
      options: {},
      async search(platform, keyword, count) {
        calls.push({ platform, keyword, count });
        return [{ id: 'kuwo-rid' }];
      }
    });

    assert.deepEqual(calls, [{ platform: 'kuwo', keyword: '周杰伦 晴天', count: 1 }]);
    assert.deepEqual(health, { search: true, play: true });
  });

  it('search ranking supports title-artist queries and demotes short snippets', () => {
    const ranked = rankSearchResults('刚好遇见你 李玉刚', [
      {
        id: '174972717',
        name: '《刚好遇见你》李玉刚',
        artist: '沐风之吻',
        source: 'kuwo',
        duration: 278000
      },
      {
        id: '157379982',
        name: '刚好遇见你 李玉刚',
        artist: 'Ta-洞朱',
        source: 'kuwo',
        duration: 14000
      },
      {
        id: '9950164',
        name: '刚好遇见你',
        artist: '李玉刚',
        source: 'kuwo',
        duration: 200000
      }
    ]);

    assert.equal(ranked[0].id, '9950164');
  });
});

function fakeProvider(name, delayMs, result) {
  return {
    name,
    enabled: true,
    async search() {
      await delay(delayMs);
      return result;
    }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startAudioServer(audio, contentType) {
  const server = http.createServer((req, res) => {
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': audio.length,
      'Content-Range': `bytes 0-${audio.length - 1}/${audio.length}`
    });
    res.end(audio);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/audio.flac` });
    });
  });
}
