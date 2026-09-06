'use strict';

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 5 * 60 * 1000;
const SCORE_DECAY = 0.5;
const SCORE_RECOVER = 0.1;
const PRIORITY_RACE_TIMEOUT = 500;
const LOSSLESS_BR_THRESHOLD = 900;
const { isLikelyPreviewUrl, rankSearchResults } = require('./match');

let audioProbe;
function getAudioProbe() {
  if (!audioProbe) {
    try {
      audioProbe = require('../audio-probe');
    } catch {
      audioProbe = null;
    }
  }
  return audioProbe;
}

// Tracks per-provider health for adaptive ordering.
class ProviderHealth {
  constructor() {
    this.score = 1.0;
    this.consecutiveFailures = 0;
    this.unhealthyUntil = 0;
  }

  isHealthy() {
    return Date.now() > this.unhealthyUntil;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.unhealthyUntil = 0;
    this.score = Math.min(1.0, this.score + SCORE_RECOVER);
  }

  recordFailure() {
    this.consecutiveFailures += 1;
    this.score = Math.max(0, this.score * SCORE_DECAY);
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.unhealthyUntil = Date.now() + COOLDOWN_MS;
    }
  }

  // Effective score: unhealthy providers get a negative score to sort last.
  effectiveScore() {
    return this.isHealthy() ? this.score : -1;
  }
}

// Dispatches music requests across providers with fallback or race strategy.
class Dispatcher {
  constructor(providers = [], { strategy = 'fallback', racePriorityCount = 2, racePriorityTimeout = PRIORITY_RACE_TIMEOUT, requestTimeout = 12000, probeAudioUrl = null } = {}) {
    this.requestTimeout = requestTimeout;
    this.probeAudioUrl = probeAudioUrl;
    this._activeCalls = new Map();
    this.providers = providers.filter((provider) => provider.enabled);
    this.strategy = strategy;
    this.racePriorityCount = racePriorityCount;
    this.racePriorityTimeout = racePriorityTimeout;
    this._health = new Map();
    for (const provider of this.providers) {
      this._health.set(provider, new ProviderHealth());
    }
  }

  addProvider(provider) {
    if (provider.enabled) {
      this.providers.push(provider);
      this._health.set(provider, new ProviderHealth());
    }
  }

  _getHealth(provider) {
    let health = this._health.get(provider);
    if (!health) {
      health = new ProviderHealth();
      this._health.set(provider, health);
    }
    return health;
  }

  _sortedProviders(preferredName = '') {
    return [...this.providers].sort((a, b) => {
      if (preferredName) {
        if (a.name === preferredName && b.name !== preferredName) return -1;
        if (b.name === preferredName && a.name !== preferredName) return 1;
      }
      return this._getHealth(b).effectiveScore() - this._getHealth(a).effectiveScore();
    });
  }

  _recordSuccess(provider) {
    this._getHealth(provider).recordSuccess();
  }

  _recordFailure(provider) {
    const health = this._getHealth(provider);
    health.recordFailure();
    if (!health.isHealthy()) {
      console.warn(`[Dispatcher] provider "${provider.name}" marked unhealthy for ${COOLDOWN_MS / 60000}min (${health.consecutiveFailures} failures)`);
    }
  }

  // A stalled adapter cannot hold a request forever or accumulate duplicate work.
  async _call(provider, method, args) {
    const key = JSON.stringify([this.providers.indexOf(provider), method, args]);
    let pending = this._activeCalls.get(key);
    if (!pending) {
      if (this._activeCalls.size >= 256) throw new Error('provider queue full');
      pending = Promise.resolve().then(() => provider[method](...args));
      this._activeCalls.set(key, pending);
      pending.finally(() => this._activeCalls.delete(key)).catch(() => {});
    }
    let timer;
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider deadline exceeded')), this.requestTimeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  async _fallback(method, ...args) {
    const sorted = this._sortedProviders(preferredProviderName(method, args));
    for (const provider of sorted) {
      const health = this._getHealth(provider);
      if (!health.isHealthy()) {
        console.log(`[Dispatcher] ${method} skip unhealthy: ${provider.name}`);
        continue;
      }
      try {
        const result = await this._call(provider, method, args);
        if (hasProviderResult(method, result, args)) {
          console.log(`[Dispatcher] ${method} hit: ${provider.name}`);
          this._recordSuccess(provider);
          return attachProviderName(method, result, provider.name);
        }
      } catch (error) {
        this._recordFailure(provider);
        console.warn(`[Dispatcher] ${method} failed on ${provider.name}:`, errorMessage(error));
      }
    }
    return emptyResult(method);
  }

  async _race(method, ...args) {
    const sorted = this._sortedProviders(preferredProviderName(method, args));
    const healthy = sorted.filter((p) => this._getHealth(p).isHealthy());

    if (healthy.length === 0) return emptyResult(method);

    const priority = healthy.slice(0, this.racePriorityCount);
    const rest = healthy.slice(this.racePriorityCount);
    const pending = new Set();

    const raceOne = (provider) => {
      const promise = this._call(provider, method, args)
        .then((result) => {
          if (!hasProviderResult(method, result, args)) throw new Error('empty');
          return { provider: provider.name, result, ref: provider };
        })
        .catch((error) => {
          this._recordFailure(provider);
          console.warn(`[Dispatcher] ${method} failed on ${provider.name}:`, errorMessage(error));
          throw error;
        });
      pending.add(promise);
      promise.finally(() => pending.delete(promise)).catch(() => {});
      return promise;
    };

    for (const provider of priority) raceOne(provider);

    if (rest.length > 0) {
      const waitForPriority = Promise.any([...pending]);
      const priorityTimeout = delay(this.racePriorityTimeout)
        .then(() => Promise.reject(new Error('priority timeout')));
      try {
        const winner = await Promise.race([waitForPriority, priorityTimeout]);
        console.log(`[Dispatcher] ${method} race winner (priority): ${winner.provider}`);
        this._recordSuccess(winner.ref);
        return attachProviderName(method, winner.result, winner.provider);
      } catch {
        for (const provider of rest) raceOne(provider);
      }
    }

    try {
      const winner = await Promise.any([...pending]);
      console.log(`[Dispatcher] ${method} race winner: ${winner.provider}`);
      this._recordSuccess(winner.ref);
      return attachProviderName(method, winner.result, winner.provider);
    } catch {
      return emptyResult(method);
    }
  }

  async _dispatch(method, ...args) {
    if (this.strategy === 'race') {
      return this._race(method, ...args);
    }
    return this._fallback(method, ...args);
  }

  async _searchMerged(platform, keyword, count) {
    const sorted = this._sortedProviders();
    const healthy = sorted.filter((p) => this._getHealth(p).isHealthy());
    if (healthy.length === 0) return [];

    const settled = await Promise.allSettled(
      healthy.map(async (provider) => {
        try {
          let results = await this._call(provider, 'search', [platform, keyword, count]);
          if ((!Array.isArray(results) || results.length === 0) && platform) {
            results = await this._call(provider, 'search', [null, keyword, count]);
          }
          if (!Array.isArray(results) || results.length === 0) return [];
          this._recordSuccess(provider);
          return results.map((song) => ({
            ...song,
            providerName: song.providerName || provider.name
          }));
        } catch (error) {
          this._recordFailure(provider);
          console.warn(`[Dispatcher] search failed on ${provider.name}:`, errorMessage(error));
          return [];
        }
      })
    );

    const merged = [];
    const seen = new Set();
    for (const item of settled) {
      if (item.status !== 'fulfilled') continue;
      for (const song of item.value || []) {
        const key = [
          song.source || '',
          song.id || song.url_id || '',
          normalizeLoose(song.name || song.title || ''),
          normalizeLoose(song.artist || song.author || '')
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(song);
      }
    }

    if (!merged.length) return [];
    const ranked = rankSearchResults(keyword, merged).slice(0, count || merged.length);
    console.log(`[Dispatcher] search merged: ${ranked.length}/${merged.length} candidates`);
    return ranked;
  }

  // Probe as soon as each provider resolves; a verified lossless stream can win
  // without waiting for an unrelated slow provider. Lossy fallback waits for all.
  async _selectBest(method, ...args) {
    const healthy = this._sortedProviders(preferredProviderName(method, args))
      .filter((provider) => this._getHealth(provider).isHealthy());
    if (!healthy.length) return emptyResult(method);
    const probe = this.probeAudioUrl || getAudioProbe()?.probeAudioUrl;
    const tasks = healthy.map(async (provider) => {
      try {
        const result = await this._call(provider, method, args);
        if (!hasProviderResult(method, result, args)) return null;
        const metadata = probe ? await probe(result.url) : {};
        if (metadata.playable === false) return null;
        const lossless = Boolean(metadata.verified && metadata.lossless);
        return {
          result, ref: provider, provider: provider.name, lossless,
          br: lossless ? 999 : downgradeFakeLosslessBitrate(extractBitrate(result)),
          verified: Boolean(metadata.verified), codec: metadata.codec,
          contentType: metadata.contentType
        };
      } catch (error) {
        this._recordFailure(provider);
        return null;
      }
    });
    const all = Promise.all(tasks).then((items) => items.filter(Boolean).sort((a, b) =>
      Number(b.lossless) - Number(a.lossless) || Number(b.verified) - Number(a.verified) || b.br - a.br
    )[0] || null);
    const lossless = Promise.any(tasks.map(async (task) => {
      const candidate = await task;
      if (!candidate?.lossless) throw new Error('not verified lossless');
      return candidate;
    })).catch(() => all);
    const best = await Promise.race([lossless, all]);
    if (!best) return emptyResult(method);
    this._recordSuccess(best.ref);
    return attachProviderName(method, annotateUrlResult(best.result, best), best.provider);
  }

  async search(platform, keyword, count) {
    if (this.strategy === 'race') {
      return this._dispatch('search', platform, keyword, count);
    }
    return this._searchMerged(platform, keyword, count);
  }

  async url(song, quality) {
    // For lossless requests, use best-of-all strategy: query all providers,
    // probe each result, and pick the highest verified quality.
    const isLossless = Number(quality) >= LOSSLESS_BR_THRESHOLD || ['flac', 'lossless', 'sq'].includes(String(quality).toLowerCase());
    if (isLossless) {
      return this._selectBest('url', song, quality);
    }
    return this._dispatch('url', song, quality);
  }

  async lyric(song) {
    return this._dispatch('lyric', song);
  }

  async pic(song, size) {
    return this._dispatch('pic', song, size);
  }

  async proxy(types, params) {
    if (types === 'url' && (Number(params.br) >= LOSSLESS_BR_THRESHOLD || ['flac', 'lossless', 'sq'].includes(String(params.br).toLowerCase()))) {
      const result = await this.url(params, params.br || '320');
      if (!result) return null;
      return { ok: true, data: JSON.stringify(result), contentType: 'application/json', providerName: result.providerName };
    }
    return this._dispatch('proxy', types, params);
  }

  // Expose health info for monitoring/debugging.
  getHealthStatus() {
    const status = {};
    for (const provider of this.providers) {
      const health = this._getHealth(provider);
      status[provider.name] = {
        score: Math.round(health.score * 100) / 100,
        healthy: health.isHealthy(),
        consecutiveFailures: health.consecutiveFailures
      };
    }
    return status;
  }
}

function preferredProviderName(method, args) {
  let types = method;
  let params = args?.[0];
  if (method === 'proxy') {
    [types, params] = args || [];
  }
  if (!['url', 'lyric', 'pic'].includes(types)) return '';
  return {
    kuwo: 'kuwo-direct',
    kugou: 'kugou-direct'
  }[params?.source] || '';
}

function emptyResult(method) {
  return method === 'search' ? [] : null;
}

function attachProviderName(method, result, providerName) {
  if (!['proxy', 'url'].includes(method) || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  return { ...result, providerName };
}

function hasProviderResult(method, result, args = []) {
  if (Array.isArray(result)) return result.length > 0;
  if (result == null) return false;

  if (method === 'url' || method === 'pic') {
    if (!result.url) return false;
    if (method === 'url' && isLikelyPreviewUrl(result.url)) return false;
    return true;
  }
  if (method === 'lyric') {
    return Boolean(result.lyric || result.tlyric);
  }
  if (method !== 'proxy') return true;

  const types = args[0];
  const body = typeof result === 'string' ? result : result.data;
  if (typeof body !== 'string') return body != null;

  const text = body.trim();
  if (!text) return false;

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (!parsed || typeof parsed !== 'object') return true;
    if (types === 'url') {
      const url = parsed.url || parsed.data?.url;
      return Boolean(url) && !isLikelyPreviewUrl(url);
    }
    if (types === 'lyric') return Boolean(parsed.lyric || parsed.tlyric);
    if (types === 'pic') return Boolean(parsed.url);
    if (types === 'search' && Array.isArray(parsed.data)) return parsed.data.length > 0;
  } catch {
    return true;
  }

  return true;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error == null) return 'unknown error';
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLoose(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '').trim();
}

function extractBitrate(result) {
  if (!result) return 0;
  const br = result.br || result.data?.br || 0;
  const n = Number(br);
  if (!n || !Number.isFinite(n)) return 0;
  // Normalize: values like 999000 are in bps, convert to kbps-style for comparison
  if (n > 5000) return Math.round(n / 1000);
  return n;
}

function downgradeFakeLosslessBitrate(br) {
  return br >= LOSSLESS_BR_THRESHOLD ? 320 : br;
}

function annotateUrlResult(result, metadata) {
  if (!result || typeof result !== 'object') return result;
  const output = { ...result };
  const payload = output.data && typeof output.data === 'object' && !Array.isArray(output.data)
    ? { ...output.data }
    : output;

  payload.br = metadata.br;
  payload.verified_audio = Boolean(metadata.verified);
  payload.lossless = Boolean(metadata.lossless);
  if (metadata.codec) payload.codec = metadata.codec;
  if (metadata.contentType) payload.content_type = metadata.contentType;

  if (payload !== output) output.data = payload;
  return output;
}

module.exports = { Dispatcher, ProviderHealth, hasProviderResult, errorMessage };

