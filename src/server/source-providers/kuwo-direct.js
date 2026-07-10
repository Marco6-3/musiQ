'use strict';

const http = require('node:http');
const https = require('node:https');
const axios = require('axios');
const { BaseProvider } = require('./base');
const { hasPlayableLength } = require('./match');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

// Quality tiers: try lossless first, fall back to lower bitrate
const QUALITY_MAP = {
  flac: { format: 'flac', br: 2000 },
  '320': { format: 'mp3', br: 320 },
  '128': { format: 'mp3', br: 128 },
};

/**
 * Direct Kuwo provider — bypasses UNM, calls kuwo APIs directly.
 * Search uses search.kuwo.cn, playback uses antiserver.kuwo.cn.
 */
class KuwoDirectProvider extends BaseProvider {
  constructor(options = {}) {
    super('kuwo-direct', options);
    this.timeout = options.timeout || 10_000;
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  }

  async search(platform, keyword, count = 30) {
    if (platform && platform !== 'kuwo') return [];

    try {
      const response = await axios.get('https://search.kuwo.cn/r.s', {
        timeout: this.timeout,
        params: {
          all: keyword,
          ft: 'music',
          rn: count,
          pn: 0,
          vipver: 'MUSIC_9.1.1.2_BCS2',
          newsearch: 1,
          alflac: 1,
          encoding: 'utf8',
        },
        headers: {
          'User-Agent': this.userAgent,
          Referer: 'https://www.kuwo.cn/',
          Accept: '*/*',
        },
        httpAgent,
        httpsAgent,
      });

      const body = typeof response.data === 'string' ? response.data : '';
      const songs = this._parseSearchResult(body);
      return songs.slice(0, count);
    } catch (error) {
      return [];
    }
  }

  // Kuwo search returns key-value pairs separated by newlines.
  // Songs are separated by blank-line blocks. Do not use SONGNAME as the only
  // delimiter: many useful fields (MUSICRID/IMG/ALBUM) appear before SONGNAME,
  // so a SONGNAME-based parser can accidentally mix the previous title with
  // the next song id.
  _parseSearchResult(body) {
    const songs = [];
    for (const section of body.split(/\r?\n\s*\r?\n/g)) {
      const current = {};
      for (const line of section.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;

        const key = trimmed.substring(0, eqIdx);
        const val = trimmed.substring(eqIdx + 1);
        current[key] = val;
      }
      if (current.SONGNAME !== undefined && current.MUSICRID) {
        songs.push(this._buildSong(current));
      }
    }

    return songs.filter((s) => s.id && s.title);
  }

  _buildSong(item) {
    const rid = (item.MUSICRID || '').replace('MUSIC_', '').replace(/\D/g, '');
    const name = this._decodeHtmlEntity(item.SONGNAME || '');
    return {
      id: rid,
      url_id: rid,
      lyric_id: rid,
      pic_id: rid,
      name,
      title: name,
      artist: this._decodeHtmlEntity(item.ARTIST || ''),
      album: this._decodeHtmlEntity(item.ALBUM || ''),
      source: 'kuwo',
      duration: Number(item.DURATION || 0) * 1000,
      pic: normalizeKuwoImageUrl(item.IMG || item.hts_MVPIC || (item.web_albumpic_short ? `https://img4.kuwo.cn/star/albumcover/${item.web_albumpic_short}` : '')),
    };
  }

  _decodeHtmlEntity(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
  }

  async url(song, quality = '320') {
    if (song?.source && song.source !== 'kuwo') return null;
    const q = QUALITY_MAP[String(quality) === '999' ? 'flac' : String(quality)] || QUALITY_MAP['320'];

    try {
      // Try antiserver endpoint with requested format
      const result = await this._fetchUrl(song.id, q.format, q.br);
      if (result) return result;

      // Fallback: try MP3 320k
      if (q.format === 'flac') {
        const fallback = await this._fetchUrl(song.id, 'mp3', 320);
        if (fallback) return fallback;
      }

      return null;
    } catch {
      return null;
    }
  }

  async _fetchUrl(rid, format, br) {
    try {
      const response = await axios.get('https://antiserver.kuwo.cn/anti.s', {
        timeout: this.timeout,
        params: {
          type: 'convert_url3',
          rid,
          format,
          br: `${br}k`,
          response: 'url',
        },
        headers: {
          'User-Agent': this.userAgent,
          Referer: 'https://www.kuwo.cn/',
        },
        httpAgent,
        httpsAgent,
        maxRedirects: 0,
        validateStatus: (status) => status < 400,
      });

      // Response may be a direct URL string or JSON
      const data = response.data;
      const url = typeof data === 'string' ? data.trim() : data?.url || data?.data?.url || '';

      if (url && url.startsWith('http')) {
        const playable = await hasPlayableLength(axios, url, {
          timeout: this.timeout,
          userAgent: this.userAgent,
          referer: 'https://www.kuwo.cn/',
          httpAgent,
          httpsAgent
        });
        if (!playable) return null;
        return {
          url,
          br: br || 320,
          from: 'kuwo-direct',
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async lyric(song) {
    if (song?.source && song.source !== 'kuwo') return null;
    try {
      const response = await axios.get('https://m.kuwo.cn/newh5/singles/songinfoandlrc', {
        timeout: this.timeout,
        params: { musicId: song.id },
        headers: { 'User-Agent': this.userAgent },
        httpAgent,
        httpsAgent,
      });

      const data = response.data;
      if (!data?.status || !data?.data?.lrclist) return null;

      const lrc = data.data.lrclist
        .filter((line) => line.lineLyric)
        .map((line) => {
          const time = Number(line.time || 0);
          const min = Math.floor(time / 60);
          const sec = (time % 60).toFixed(2).padStart(5, '0');
          return `[${min}:${sec}]${line.lineLyric}`;
        })
        .join('\n');

      return { lyric: lrc };
    } catch {
      return null;
    }
  }

  async pic(song, size = 300) {
    if (song?.source && song.source !== 'kuwo') return null;
    // Kuwo pic is usually embedded in search results
    if (song.pic) return { url: song.pic };
    return null;
  }

  async proxy(types, params) {
    try {
      if (types === 'search') {
        const results = await this.search(params.source || 'kuwo', params.name || params.keyword || '', Number(params.count) || 30);
        if (!results.length) return null;
        return { ok: true, data: JSON.stringify(results), contentType: 'application/json', providerName: this.name };
      }

      if (types === 'url') {
        if (params.source && params.source !== 'kuwo') return null;
        const result = await this.url({
          id: params.id,
          name: params.name,
          title: params.name,
          artist: params.artist,
          source: 'kuwo'
        }, params.br || '320');
        if (!result?.url) return null;
        return { ok: true, data: JSON.stringify(result), contentType: 'application/json', providerName: this.name };
      }

      if (types === 'lyric') {
        if (params.source && params.source !== 'kuwo') return null;
        const result = await this.lyric({ id: params.id });
        if (!result) return null;
        return { ok: true, data: JSON.stringify(result), contentType: 'application/json', providerName: this.name };
      }

      if (types === 'pic') {
        if (params.source && params.source !== 'kuwo') return null;
        const result = await this.pic({ id: params.id, pic: params.pic }, Number(params.size) || 300);
        if (!result?.url) return null;
        return { ok: true, data: JSON.stringify(result), contentType: 'application/json', providerName: this.name };
      }
    } catch {
      return null;
    }
    return null;
  }
}

function normalizeKuwoImageUrl(value) {
  return String(value || '')
    .replace(/^http:\/\/(img\d+)\.sycdn\.kuwo\.cn\//i, 'https://$1.kuwo.cn/')
    .replace(/^http:\/\/(img\d+)\.kuwo\.cn\//i, 'https://$1.kuwo.cn/');
}

module.exports = { KuwoDirectProvider };
