'use strict';

const http = require('node:http');
const https = require('node:https');
const axios = require('axios');
const { BaseProvider } = require('./base');
const { KuwoDirectProvider } = require('./kuwo-direct');
const { selectBestSongCandidate } = require('./match');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

/**
 * Kugou provider with cross-platform fallback.
 *
 * Kugou's playback API now requires VIP for all songs.
 * Strategy: search on kugou (rich catalog), then resolve URL on kuwo (free MP3).
 * This gives access to kugou's search index while using kuwo's free playback.
 */
class KugouDirectProvider extends BaseProvider {
  constructor(options = {}) {
    super('kugou-direct', options);
    this.timeout = options.timeout || 10_000;
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    this.kuwoFallback = new KuwoDirectProvider({ timeout: this.timeout });
  }

  async search(platform, keyword, count = 30) {
    if (platform && platform !== 'kugou') return [];

    try {
      const response = await axios.get('https://songsearch.kugou.com/song_search_v2', {
        timeout: this.timeout,
        params: {
          keyword,
          page: 1,
          pagesize: count,
          platform: 'WebFilter',
        },
        headers: {
          'User-Agent': this.userAgent,
          Referer: 'https://www.kugou.com/',
          Accept: 'application/json, text/plain, */*',
        },
        httpAgent,
        httpsAgent,
      });

      const data = response.data;
      const list = data?.data?.lists || [];
      return list
        .filter((item) => item.FileHash || item.Hash)
        .map((item) => {
          const id = item.FileHash || item.Hash;
          const name = (item.SongName || '').replace(/<\/?em>/g, '');
          const coverUrl = normalizeKugouImageUrl(item.Image || item.AlbumImage);
          return {
            id,
            url_id: id,
            lyric_id: id,
            pic_id: item.AlbumID || id,
            name,
            title: name,
            artist: (item.SingerName || '').replace(/<\/?em>/g, ''),
            album: item.AlbumName || '',
            source: 'kugou',
            duration: (Number(item.Duration || 0)) * 1000,
            pic: coverUrl,
            cover_url: coverUrl,
            // Store additional hashes for quality fallback
            _hash: item.Hash || item.FileHash,
            _sqHash: item.SQHash || '',
            _hqHash: item.HQHash || '',
            _albumId: item.AlbumID || '',
          };
        })
        .filter((s) => s.id && s.title);
    } catch {
      return [];
    }
  }

  async url(song, quality = '320') {
    if (song?.source && song.source !== 'kugou') return null;
    // Kugou's API requires VIP for all songs.
    // Cross-platform fallback: search the same song on kuwo (free MP3).
    const title = song.title || song.name || '';
    const artist = song.artist || '';
    if (!title) return null;

    const keyword = artist ? `${artist} ${title}` : title;

    try {
      const candidates = await this.kuwoFallback.search('kuwo', keyword, 8);
      const best = selectBestSongCandidate(song, candidates, { minScore: artist ? 58 : 44 });
      if (!best) return null;

      const result = await this.kuwoFallback.url(best, quality);
      if (result?.url) {
        return {
          ...result,
          from: 'kugou-via-kuwo',
          matched_source: 'kuwo',
          matched_id: best.id,
          match_score: best.matchScore
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  // Extract first MUSICRID from kuwo search response
  _extractKuwoRid(body) {
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('MUSICRID=')) {
        const rid = trimmed.replace('MUSICRID=MUSIC_', '').replace(/\D/g, '');
        if (rid) return rid;
      }
    }
    return null;
  }

  async lyric(song) {
    if (song?.source && song.source !== 'kugou') return null;
    try {
      // Kugou lyrics require a different ID (lyrics_id from search)
      const hash = song._hash || song.id;
      if (!hash) return null;

      // First get the lyrics ID from the song detail
      const detailResp = await axios.get('https://wwwapi.kugou.com/play/songinfo', {
        timeout: this.timeout,
        params: {
          srcappid: 2919,
          clientver: 20000,
          hash,
        },
        headers: { 'User-Agent': this.userAgent },
        httpAgent,
        httpsAgent,
      });

      const lyricsId = detailResp.data?.data?.lyrics_id || detailResp.data?.data?.lyric;
      if (!lyricsId) return null;

      const lrcResp = await axios.get('https://lyrics.kugou.com/search', {
        timeout: this.timeout,
        params: {
          ver: 1,
          man: 'yes',
          client: 'mobi',
          hash,
          timelength: song.duration || 0,
        },
        headers: { 'User-Agent': this.userAgent },
        httpAgent,
        httpsAgent,
      });

      const candidates = lrcResp.data?.candidates || [];
      if (candidates.length === 0) return null;

      // Get the best match (first candidate)
      const best = candidates[0];
      const lrcContent = await axios.get('https://lyrics.kugou.com/download', {
        timeout: this.timeout,
        params: {
          ver: 1,
          client: 'pc',
          id: best.id,
          accesskey: best.accesskey,
          fmt: 'lrc',
          charset: 'utf8',
        },
        headers: { 'User-Agent': this.userAgent },
        httpAgent,
        httpsAgent,
      });

      const content = lrcContent.data?.content || '';
      if (content) {
        // Decode base64 if needed
        const decoded = Buffer.from(content, 'base64').toString('utf8');
        return { lyric: decoded };
      }
      return null;
    } catch {
      return null;
    }
  }

  async pic(song, size = 300) {
    if (song?.source && song.source !== 'kugou') return null;
    // Kugou album art requires album ID
    const albumId = song._albumId || song.albumId;
    if (!albumId) return null;

    try {
      const response = await axios.get(`https://imge.kugou.com/v2/album_portrait/${albumId}.jpg`, {
        timeout: this.timeout,
        params: { size },
        headers: { 'User-Agent': this.userAgent },
        httpAgent,
        httpsAgent,
        maxRedirects: 5,
        validateStatus: (status) => status < 400,
      });

      if (response.status === 200) {
        return { url: response.config.url };
      }
      return null;
    } catch {
      return null;
    }
  }

  async proxy(types, params) {
    try {
      if (types === 'search') {
        const results = await this.search(params.source || 'kugou', params.name || params.keyword || '', Number(params.count) || 30);
        if (!results.length) return null;
        return { ok: true, data: JSON.stringify(results), contentType: 'application/json', providerName: this.name };
      }

      if (types === 'url') {
        if (params.source && params.source !== 'kugou') return null;
        const result = await this.url({
          id: params.id,
          name: params.name,
          title: params.name,
          artist: params.artist,
          duration: Number(params.duration || 0),
          source: 'kugou'
        }, params.br || '320');
        if (!result?.url) return null;
        return { ok: true, data: JSON.stringify(result), contentType: 'application/json', providerName: this.name };
      }

      if (types === 'lyric') {
        const result = await this.lyric({
          id: params.id,
          _hash: params.id,
          duration: Number(params.duration || 0)
        });
        if (!result) return null;
        return { ok: true, data: JSON.stringify(result), contentType: 'application/json', providerName: this.name };
      }

      if (types === 'pic') {
        const result = await this.pic({ id: params.id, albumId: params.id }, Number(params.size) || 300);
        if (!result?.url) return null;
        return { ok: true, data: JSON.stringify(result), contentType: 'application/json', providerName: this.name };
      }
    } catch {
      return null;
    }
    return null;
  }
}

function normalizeKugouImageUrl(value, size = 400) {
  return String(value || '')
    .replaceAll('{size}', String(size))
    .replace(/^http:\/\//i, 'https://');
}

module.exports = { KugouDirectProvider, normalizeKugouImageUrl };
