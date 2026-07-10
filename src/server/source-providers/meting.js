'use strict';

const { BaseProvider } = require('./base');

let Meting;
let metingImportPromise;

async function loadMeting() {
  if (Meting) return Meting;
  if (!metingImportPromise) {
    metingImportPromise = import('@meting/core')
      .then((module) => {
        Meting = module.default || module;
        return Meting;
      })
      .catch((error) => {
        console.warn('[MetingProvider] @meting/core load failed:', error.message);
        return null;
      });
  }
  return metingImportPromise;
}

// Local multi-platform provider backed by @meting/core.
class MetingProvider extends BaseProvider {
  constructor(options = {}) {
    super('meting', options);
    this.defaultPlatform = options.defaultPlatform || 'netease';
    // Filter out empty cookie strings
    this.cookies = Object.fromEntries(
      Object.entries(options.cookies || {}).filter(([, v]) => v && v.trim())
    );
    this.metingByPlatform = new Map();
  }

  async _ensureMeting(platform) {
    const site = platform || this.defaultPlatform;
    let meting = this.metingByPlatform.get(site);
    if (!meting) {
      const MetingClass = await loadMeting();
      if (!MetingClass) return null;
      meting = new MetingClass(site);
      meting.format(true);
      // Set VIP cookie if configured for this platform
      const cookie = this.cookies[site];
      if (cookie && typeof meting.cookie === 'function') {
        meting.cookie(cookie);
      }
      this.metingByPlatform.set(site, meting);
    }
    return meting;
  }

  async search(platform, keyword, count = 30) {
    const meting = await this._ensureMeting(platform);
    if (!meting) return [];
    const result = await meting.search(keyword, { limit: count });
    const data = parseMetingJson(result, 'search');
    return Array.isArray(data) ? data : [];
  }

  async url(song, quality = '320') {
    const meting = await this._ensureMeting(song.source);
    if (!meting) return null;
    const result = await meting.url(song.id, Number(quality));
    const data = parseMetingJson(result, 'url');
    return { url: data?.url, br: Number(quality) };
  }

  async lyric(song) {
    const meting = await this._ensureMeting(song.source);
    if (!meting) return null;
    const result = await meting.lyric(song.lyric_id || song.id);
    const data = parseMetingJson(result, 'lyric');
    return { lyric: data?.lyric || data?.lrc?.lyric || '' };
  }

  async pic(song, size = 300) {
    const platform = song?.source || this.defaultPlatform;
    const pictureId = String(song?.pic_id || song?.id || '').trim();
    // @meting/core's Kugou artwork path dereferences a missing imgUrl for
    // unavailable tracks. KugouDirectProvider owns this source and can fail
    // cleanly without turning an ordinary missing cover into an exception.
    if (!pictureId || platform === 'kugou') return null;
    const meting = await this._ensureMeting(platform);
    if (!meting) return null;
    const result = await meting.pic(pictureId, size);
    const data = parseMetingJson(result, 'pic');
    return { url: data?.url };
  }

  async proxy(types, params) {
    params = params || {};
    const platform = params.source || this.defaultPlatform;
    const resourceId = String(params.id || '').trim();
    if (['url', 'lyric', 'pic'].includes(types) && !resourceId) return null;
    if (types === 'pic' && platform === 'kugou') return null;
    const meting = await this._ensureMeting(platform);
    if (!meting) return null;

    try {
      if (types === 'search') {
        const list = await this.search(platform, params.name || params.keyword, Number(params.count) || 30);
        return { data: JSON.stringify(list), contentType: 'application/json' };
      }
      if (types === 'url') {
        const result = await meting.url(resourceId, Number(params.br) || 320);
        const data = parseMetingJson(result, 'proxy:url');
        return { data: JSON.stringify({ url: data?.url, br: Number(params.br) || 320 }), contentType: 'application/json' };
      }
      if (types === 'lyric') {
        const result = await meting.lyric(resourceId);
        const data = parseMetingJson(result, 'proxy:lyric');
        return { data: JSON.stringify({ lyric: data?.lyric || data?.lrc?.lyric || '' }), contentType: 'application/json' };
      }
      if (types === 'pic') {
        const result = await meting.pic(resourceId, Number(params.size) || 300);
        const data = parseMetingJson(result, 'proxy:pic');
        return { data: JSON.stringify({ url: data?.url }), contentType: 'application/json' };
      }
    } catch (error) {
      console.warn(`[MetingProvider] proxy failed (${types}):`, error.message);
    }
    return null;
  }
}

function parseMetingJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn(`[MetingProvider] invalid JSON (${label}):`, error.message);
    return null;
  }
}

module.exports = { MetingProvider };
