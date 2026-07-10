'use strict';

const http = require('node:http');
const https = require('node:https');
const { BaseProvider } = require('./base');
const { errorMessage } = require('./dispatcher');

let providerModules;
let unmSelect; // reference to UNM's internal select.js (reads ENABLE_FLAC at load time)

function loadUnmModules() {
  if (providerModules) return true;
  try {
    // Must set ENABLE_FLAC BEFORE requiring UNM modules — they read it at load time
    // via provider/select.js which caches process.env.ENABLE_FLAC as a module-level constant.
    if (!process.env.ENABLE_FLAC) process.env.ENABLE_FLAC = 'true';

    providerModules = {
      kuwo: tryRequire('@unblockneteasemusic/server/src/provider/kuwo'),
      kugou: tryRequire('@unblockneteasemusic/server/src/provider/kugou'),
      bilibili: tryRequire('@unblockneteasemusic/server/src/provider/bilibili'),
      bodian: tryRequire('@unblockneteasemusic/server/src/provider/bodian'),
      migu: tryRequire('@unblockneteasemusic/server/src/provider/migu'),
    };

    // Patch select.ENABLE_FLAC directly as a safety net (in case the require order matters)
    try {
      const selectPath = require.resolve('@unblockneteasemusic/server/src/provider/select');
      unmSelect = require(selectPath);
      if (!unmSelect.ENABLE_FLAC) {
        unmSelect.ENABLE_FLAC = true;
      }
    } catch {
      // select.js may not exist in all versions — ignore
    }

    return true;
  } catch (error) {
    console.warn('[UnmProvider] failed to load UNM modules:', error.message);
    return false;
  }
}

const MIN_SONG_SIZE_BYTES = 500 * 1024; // 500KB — ads/jingles are typically < 200KB
const SYNTHETIC_SONGS_MAX = 500;
const LOSSLESS_BR_THRESHOLD = 900; // br >= 900 means lossless request

function headContentLength(url) {
  return new Promise((resolve) => {
    const transport = url.startsWith('https') ? https : http;
    const req = transport.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      const size = Number(res.headers['content-length']) || 0;
      res.resume();
      resolve(size);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

// Probe first 8KB of audio to detect actual format via magic bytes.
function probeAudioFormat(url) {
  return new Promise((resolve) => {
    const transport = url.startsWith('https') ? https : http;
    const req = transport.get(url, {
      timeout: 6000,
      headers: { Range: 'bytes=0-8191', 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); if (Buffer.concat(chunks).length >= 8192) res.destroy(); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(audioFormatFromBytes(buf));
      });
      res.on('error', () => resolve({ codec: '', lossless: false }));
    });
    req.on('error', () => resolve({ codec: '', lossless: false }));
    req.on('timeout', () => { req.destroy(); resolve({ codec: '', lossless: false }); });
  });
}

function audioFormatFromBytes(buf) {
  if (buf.length >= 4) {
    const magic = buf.toString('ascii', 0, 4);
    if (magic === 'fLaC') return { codec: 'flac', lossless: true };
    if (magic.startsWith('RIFF') && buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WAVE') return { codec: 'wav', lossless: true };
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
      const ascii = buf.toString('ascii').toLowerCase();
      if (ascii.includes('alac')) return { codec: 'alac', lossless: true };
      return { codec: 'm4a', lossless: false };
    }
    if (magic.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { codec: 'mp3', lossless: false };
    if (magic.startsWith('OggS')) return { codec: 'ogg', lossless: false };
  }
  return { codec: '', lossless: false };
}

function tryRequire(id) {
  try {
    return require(id);
  } catch {
    return null;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('UNM timeout')), ms))
  ]);
}

// UNM-based provider for multi-source URL resolution and search fallback.
class UnmProvider extends BaseProvider {
  constructor(options = {}) {
    super('unm', options);
    this.sources = options.sources || ['kuwo', 'kugou', 'bodian', 'bilibili'];
    this.timeout = options.timeout || 10_000;
    this.syntheticSongs = new Map();
    this._syntheticOrder = []; // Track insertion order for LRU eviction
  }

  async search(platform, keyword, count = 30) {
    if (!loadUnmModules()) return [];

    const info = { keyword, duration: 0 };
    const results = [];

    const promises = this._filterSources(platform).map(async (sourceName) => {
      const mod = providerModules[sourceName];
      if (!mod) return;

      try {
        const checkFn = mod.check || mod.search;
        if (!checkFn) return;

        const result = await withTimeout(checkFn(info), this.timeout);
        if (!result) return;

        if (typeof result === 'string' && result.startsWith('http')) {
          // Validate file size to filter out ads
          const size = await headContentLength(result);
          if (size > 0 && size < MIN_SONG_SIZE_BYTES) {
            console.warn(`[UnmProvider] search: "${sourceName}" returned suspicious file (${(size / 1024).toFixed(0)}KB), skipping`);
            return;
          }

          const id = this._syntheticId(sourceName, results.length);
          const song = this._buildSyntheticSong({
            id,
            keyword,
            sourceName,
            directUrl: result
          });
          this._addToSyntheticSongs(id, song);
          results.push({
            id,
            name: song.name,
            artist: song.artist,
            source: sourceName
          });
        } else if (result && result.id) {
          const artists = result.artists ? [].concat(result.artists).map(a => a.name || a).filter(Boolean) : [];
          const id = String(result.id);
          const song = {
            id,
            name: result.name || keyword.split(' ')[0],
            artist: artists.join(', '),
            source: sourceName,
            album: result.album?.name || ''
          };
          this._addToSyntheticSongs(id, song);
          results.push({
            id: String(result.id),
            name: song.name,
            artist: song.artist,
            source: sourceName,
            album: song.album
          });
        }
      } catch {
        // source failed, skip
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  async url(song, quality = '320') {
    if (!loadUnmModules()) return null;

    // Check if this is a synthetic song from our search results
    const cached = this.syntheticSongs.get(String(song.id));
    if (cached?.directUrl) {
      return { url: cached.directUrl, br: Number(quality) * 1000 || 320000 };
    }

    const source = song.source || 'netease';
    const isLossless = Number(quality) >= LOSSLESS_BR_THRESHOLD || String(quality).toLowerCase() === 'flac';

    const songInfo = {
      keyword: [song.name || song.title, song.artist].filter(Boolean).join(' '),
      duration: Number(song.duration) || 0
    };

    const url = await this._resolveWithValidation(songInfo, source, isLossless);
    if (url) {
      const br = isLossless ? 999 : (Number(quality) || 320);
      return { url, br };
    }
    return null;
  }

  async lyric(song) {
    // UNM doesn't provide lyric resolution, let next provider handle it
    return null;
  }

  async pic(song, size = 300) {
    // UNM doesn't provide cover resolution, let next provider handle it
    return null;
  }

  async proxy(types, params) {
    if (!loadUnmModules()) return null;

    if (types === 'url') {
      const id = params.id;
      if (!id) return null;

      const cachedSong = this.syntheticSongs.get(String(id));
      if (cachedSong?.directUrl) {
        return {
          ok: true,
          data: JSON.stringify({ url: cachedSong.directUrl, br: Number(params.br) * 1000 || 320000 }),
          contentType: 'application/json',
          providerName: this.name
        };
      }

      const songInfo = {
        keyword: [params.name, params.artist, cachedSong?.name, cachedSong?.artist].filter(Boolean).join(' '),
        duration: Number(params.duration) || 0
      };

      if (!songInfo.keyword.trim()) return null;

      const br = Number(params.br) || 320;
      const isLossless = br >= LOSSLESS_BR_THRESHOLD;

      try {
        const url = await this._resolveWithValidation(songInfo, params.source || 'netease', isLossless);
        if (url) {
          const resultBr = isLossless ? 999 : (Number(params.br) || 320);
          return {
            ok: true,
            data: JSON.stringify({ url, br: resultBr }),
            contentType: 'application/json',
            providerName: this.name
          };
        }
      } catch (error) {
        console.warn('[UnmProvider] proxy url failed:', errorMessage(error));
      }
      return null;
    }

    if (types === 'search') {
      const keyword = params.name || params.keyword;
      if (!keyword) return null;
      try {
        const results = await this.search(params.source, keyword, Number(params.count) || 30);
        if (!results.length) return null;
        return {
          ok: true,
          data: JSON.stringify(results),
          contentType: 'application/json',
          providerName: this.name
        };
      } catch {
        return null;
      }
    }

    // lyric and pic: UNM doesn't support these
    return null;
  }

  _filterSources(preferredSource) {
    if (preferredSource && this.sources.includes(preferredSource)) {
      return [preferredSource];
    }
    return this.sources;
  }

  async _resolveWithValidation(songInfo, requestedSource = 'netease', requireLossless = false) {
    let bestLosslessUrl = null;
    let bestLosslessSize = 0;

    for (const sourceName of this._sourcesForUrl(requestedSource)) {
      const mod = providerModules[sourceName];
      if (!mod) continue;

      try {
        const checkFn = mod.check;
        if (!checkFn) continue;

        const url = await withTimeout(checkFn(songInfo), this.timeout);
        if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;

        const size = await headContentLength(url);
        if (size > 0 && size < MIN_SONG_SIZE_BYTES) {
          console.warn(`[UnmProvider] source "${sourceName}" returned suspicious file (${(size / 1024).toFixed(0)}KB), skipping`);
          continue;
        }

        // For lossless requests, probe the actual audio format
        if (requireLossless) {
          const probeResult = await probeAudioFormat(url);
          if (probeResult.lossless) {
            console.log(`[UnmProvider] lossless verified via ${sourceName}: ${probeResult.codec} (${size > 0 ? (size / 1024).toFixed(0) + 'KB' : 'size unknown'})`);
            return url;
          }
          // Not lossless — remember it as fallback if it's the biggest file so far
          if (size > bestLosslessSize) {
            bestLosslessUrl = url;
            bestLosslessSize = size;
          }
          console.log(`[UnmProvider] ${sourceName} returned ${probeResult.codec} (not lossless), trying next source`);
          continue;
        }

        console.log(`[UnmProvider] resolved via ${sourceName} (${size > 0 ? (size / 1024).toFixed(0) + 'KB' : 'size unknown'})`);
        return url;
      } catch {
        continue;
      }
    }

    // If lossless was required but none found, return best available as fallback
    if (requireLossless && bestLosslessUrl) {
      console.log('[UnmProvider] no lossless source found, returning best available');
      return bestLosslessUrl;
    }
    return null;
  }

  _sourcesForUrl(requestedSource) {
    if (requestedSource === 'kuwo') {
      return this.sources.filter((source) => source !== 'kuwo');
    }
    if (requestedSource && this.sources.includes(requestedSource)) {
      return [requestedSource, ...this.sources.filter((source) => source !== requestedSource)];
    }
    return this.sources;
  }

  _syntheticId(sourceName, index) {
    return `${sourceName}_${Date.now()}_${index}`;
  }

  _addToSyntheticSongs(id, song) {
    if (this.syntheticSongs.size >= SYNTHETIC_SONGS_MAX) {
      // Evict oldest entries
      const toEvict = Math.max(1, Math.floor(SYNTHETIC_SONGS_MAX * 0.2));
      for (let i = 0; i < toEvict && this._syntheticOrder.length > 0; i++) {
        const oldId = this._syntheticOrder.shift();
        this.syntheticSongs.delete(oldId);
      }
    }
    this.syntheticSongs.set(id, song);
    this._syntheticOrder.push(id);
  }

  _buildSyntheticSong({ id, keyword, sourceName, directUrl }) {
    return {
      id,
      // A direct URL response contains no trustworthy metadata. Preserve the
      // complete query instead of guessing title/artist from token order.
      name: String(keyword || '').trim(),
      artist: '',
      source: sourceName,
      directUrl
    };
  }
}

module.exports = { UnmProvider };
