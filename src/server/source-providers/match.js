'use strict';

const MIN_PLAYABLE_AUDIO_BYTES = 500 * 1024;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/\([^)]*(?:伴奏|live|片段|试听|cover|翻自)[^)]*\)/gi, ' ')
    .replace(/（[^）]*(?:伴奏|live|片段|试听|cover|翻自)[^）]*）/gi, ' ')
    .replace(/\b(?:feat|ft|with)\.?\b/gi, ' ')
    .replace(/[【】《》「」『』()[\]{}.,，。:：;；'"“”‘’!?！？/\\|_\-+~·`^$#@%&*=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitArtists(value) {
  const text = Array.isArray(value) ? value.join(',') : value;
  return normalizeText(text)
    .split(/\s*(?:,|，|、|\/|&|和|;|；|\s+x\s+)\s*/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokenSet(value) {
  return new Set(normalizeText(value).split(/\s+/).filter(Boolean));
}

function overlapScore(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const token of left) {
    if (right.has(token)) hit += 1;
  }
  return hit / Math.max(left.size, right.size);
}

function artistScore(targetArtist, candidateArtist) {
  const target = splitArtists(targetArtist);
  const candidate = splitArtists(candidateArtist);
  if (!target.length || !candidate.length) return 0;
  let hit = 0;
  for (const t of target) {
    if (candidate.some((c) => c === t || c.includes(t) || t.includes(c))) hit += 1;
  }
  return hit / target.length;
}

function durationScore(targetDuration, candidateDuration) {
  const a = normalizeDurationSeconds(targetDuration);
  const b = normalizeDurationSeconds(candidateDuration);
  if (!a || !b) return 0;
  const diff = Math.abs(a - b);
  if (diff <= 2) return 1;
  if (diff <= 5) return 0.8;
  if (diff <= 10) return 0.45;
  return 0;
}

function normalizeDurationSeconds(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 10_000 ? Math.round(n / 1000) : Math.round(n);
}

function songMatchScore(target, candidate) {
  const targetName = normalizeText(target?.name || target?.title || target?.song || '');
  const candidateName = normalizeText(candidate?.name || candidate?.title || candidate?.song || '');
  if (!targetName || !candidateName) return 0;

  let score = 0;
  if (targetName === candidateName) {
    score += 48;
  } else if (targetName.includes(candidateName) || candidateName.includes(targetName)) {
    score += 36;
  } else {
    score += Math.round(overlapScore(targetName, candidateName) * 32);
  }

  const targetArtist = target?.artist || target?.author;
  const candidateArtist = candidate?.artist || candidate?.author;
  const targetArtists = splitArtists(targetArtist);
  const candidateArtists = splitArtists(candidateArtist);
  score += Math.round(artistScore(targetArtist, candidateArtist) * 32);
  score += Math.round(durationScore(target?.duration, candidate?.duration) * 12);

  if (targetArtists.length) {
    const exactArtist = candidateArtists.length === targetArtists.length
      && targetArtists.every((artist) => candidateArtists.includes(artist));
    if (exactArtist) score += 10;
    if (candidateArtists.length > targetArtists.length) score -= Math.min(16, (candidateArtists.length - targetArtists.length) * 8);
  }

  const candidateNameRaw = String(candidate?.name || candidate?.title || '');
  if (/(?:cover|翻唱|伴奏|片段|试听|抒情钢琴|加速|纯净|伤感|正式版)/i.test(candidateNameRaw)) score -= 14;
  if (/\blive\b|演唱会/i.test(candidateNameRaw) || /演唱会|live/i.test(String(candidate?.album || ''))) score -= 8;
  const candidateDurationSeconds = normalizeDurationSeconds(candidate?.duration);
  if (candidateDurationSeconds > 0 && candidateDurationSeconds < 30) score -= 32;

  // Prefer candidates that expose a real platform id/url id.
  if (candidate?.id || candidate?.url_id) score += 4;

  return Math.max(0, Math.min(score, 100));
}

function selectBestSongCandidate(target, candidates, options = {}) {
  const minScore = Number(options.minScore || 50);
  let best = null;
  for (const candidate of candidates || []) {
    const score = songMatchScore(target, candidate);
    if (!best || score > best.score) best = { ...candidate, matchScore: score };
  }
  if (!best || best.matchScore < minScore) return null;
  return best;
}

function isLikelyPreviewUrl(url) {
  const text = String(url || '').toLowerCase();
  return /\b(preview|audition|trylisten|demo|sample)\b/.test(text)
    || /(?:^|[^\d])(?:30|40|45|60)s(?:[^\d]|$)/.test(text);
}

function inferSearchTarget(keyword) {
  const parts = normalizeText(keyword).split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { name: keyword, artist: '' };
  return {
    artist: parts.slice(0, -1).join(' '),
    name: parts[parts.length - 1]
  };
}

function inferSearchTargets(keyword) {
  const parts = normalizeText(keyword).split(/\s+/).filter(Boolean);
  const targets = [{ name: keyword, artist: '' }];
  if (parts.length <= 1) return targets;

  targets.push({
    artist: parts.slice(0, -1).join(' '),
    name: parts[parts.length - 1]
  });
  targets.push({
    artist: parts[parts.length - 1],
    name: parts.slice(0, -1).join(' ')
  });

  return targets;
}

function rankSearchResults(keyword, candidates = []) {
  const targets = inferSearchTargets(keyword);
  return [...candidates]
    .map((candidate, index) => {
      return {
        ...candidate,
        _searchScore: Math.max(...targets.map((target) => songMatchScore(target, candidate))),
        _searchOrder: index
      };
    })
    .sort((a, b) => (b._searchScore - a._searchScore) || (a._searchOrder - b._searchOrder))
    .map(({ _searchOrder, _searchScore, ...candidate }) => candidate);
}

async function hasPlayableLength(axios, url, options = {}) {
  if (!url || isLikelyPreviewUrl(url)) return false;
  const minBytes = Number(options.minBytes || MIN_PLAYABLE_AUDIO_BYTES);
  const requestOptions = {
    timeout: options.timeout || 5000,
    headers: {
      'User-Agent': options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: options.referer,
      Range: 'bytes=0-0'
    },
    httpAgent: options.httpAgent,
    httpsAgent: options.httpsAgent,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400
  };

  try {
    const response = await axios.head(url, requestOptions);
    const length = Number(response.headers['content-length'] || 0);
    if (!length) return true;
    return length >= minBytes;
  } catch {
    // Some CDN links reject HEAD; do not discard otherwise plausible full URLs.
    return true;
  }
}

module.exports = {
  MIN_PLAYABLE_AUDIO_BYTES,
  normalizeText,
  splitArtists,
  songMatchScore,
  selectBestSongCandidate,
  inferSearchTarget,
  inferSearchTargets,
  rankSearchResults,
  isLikelyPreviewUrl,
  hasPlayableLength
};
