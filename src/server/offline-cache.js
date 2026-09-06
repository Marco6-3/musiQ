'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const axios = require('axios');
const { MIN_PLAYABLE_AUDIO_BYTES } = require('./source-providers/match');

const DEFAULT_QUALITY = '999';
const DOWNLOAD_CONCURRENCY = 2;

class OfflineMusicCache {
  constructor({
    db,
    dataDir,
    dispatcher,
    quality = DEFAULT_QUALITY,
    concurrency = DOWNLOAD_CONCURRENCY,
    minBytes = MIN_PLAYABLE_AUDIO_BYTES
  } = {}) {
    this.db = db;
    this.dataDir = dataDir;
    this.dispatcher = dispatcher;
    this.quality = String(quality || DEFAULT_QUALITY);
    this.concurrency = Math.max(1, Number(concurrency) || DOWNLOAD_CONCURRENCY);
    this.minBytes = Math.max(1, Number(minBytes) || MIN_PLAYABLE_AUDIO_BYTES);
    this.audioDir = path.join(dataDir, 'offline-audio');
    this.queue = [];
    this.queued = new Set();
    this.active = 0;
    this.closed = false;
    fs.mkdirSync(this.audioDir, { recursive: true });
  }

  async requestDownload(song) {
    if (this.closed) throw new Error('离线缓存已关闭');
    await fsp.mkdir(this.audioDir, { recursive: true });

    const item = normalizeSong(song);
    if (!item.id) throw new Error('缺少歌曲ID');
    item.cache_key = cacheKey(item.source, item.id);

    const previous = this.getTrack(item.source, item.id);
    if (previous && !previous.user_requested) {
      await this._deleteTrack(previous.cache_key, previous.file_path);
    }

    this._upsertPending(item);
    const track = this.getTrack(item.source, item.id);
    if (this._isUsableDownloadedTrack(track)) return { track, queued: false };

    this.enqueue(item);
    return { track: this.getTrack(item.source, item.id), queued: true };
  }

  async removeUnrequestedTracks() {
    const rows = this.db.prepare(`
      SELECT cache_key, file_path
      FROM offline_tracks
      WHERE user_requested = 0
    `).all();
    for (const row of rows) {
      await this._deleteTrack(row.cache_key, row.file_path);
    }
    return rows.length;
  }

  enqueue(song) {
    if (this.closed || !song?.id) return;
    const item = normalizeSong(song);
    item.cache_key = cacheKey(item.source, item.id);
    if (this.queued.has(item.cache_key)) return;
    this.queued.add(item.cache_key);
    this.queue.push(item);
    this._pump();
  }

  getTrack(source, songId) {
    return this.db.prepare(`
      SELECT cache_key, song_id, source, name, artist, album, pic_id, status, file_path, content_type, br, size, user_requested
      FROM offline_tracks
      WHERE source = ? AND song_id = ?
    `).get(String(source || 'netease'), String(songId || ''));
  }

  getTrackByKey(cacheKeyValue) {
    return this.db.prepare(`
      SELECT cache_key, song_id, source, name, artist, album, pic_id, status, file_path, content_type, br, size, user_requested
      FROM offline_tracks
      WHERE cache_key = ?
    `).get(String(cacheKeyValue || ''));
  }

  getPlayableTrack(source, songId) {
    const track = this.getTrack(source, songId);
    if (!track?.user_requested || track.status !== 'downloaded' || !track.file_path || !fs.existsSync(track.file_path)) {
      return null;
    }
    if (!this._isUsableDownloadedTrack(track)) return null;
    return track;
  }

  close() {
    this.closed = true;
  }

  _pump() {
    while (!this.closed && this.active < this.concurrency && this.queue.length) {
      const song = this.queue.shift();
      this.active += 1;
      this._download(song)
        .catch((error) => {
          if (this.closed) return;
          this._markError(song.cache_key, error);
          console.warn(`[offline-cache] download failed (${song.source}:${song.id}):`, error.message);
        })
        .finally(() => {
          this.active -= 1;
          this.queued.delete(song.cache_key);
          this._pump();
        });
    }
  }

  async _download(song) {
    this._markDownloading(song);
    const audio = await this._resolveAudio(song);
    if (!audio.url) throw new Error('没有可下载的播放地址');

    const response = await axios.get(audio.url, {
      timeout: 45_000,
      responseType: 'stream',
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'audio/*,*/*'
      }
    });

    const reportedLength = Number(response.headers['content-length'] || 0);
    if (reportedLength > 0 && reportedLength < this.minBytes) {
      response.data?.destroy?.();
      throw new Error(`音频文件过小，疑似广告或试听片段 (${reportedLength} bytes)`);
    }

    const reportedContentType = response.headers['content-type'] || audio.contentType || 'audio/mpeg';
    const ext = extensionFor(reportedContentType, audio.url);
    const finalPath = path.join(this.audioDir, `${song.cache_key}${ext}`);
    const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    await pipeline(response.data, fs.createWriteStream(tempPath));
    if (this.closed) {
      await fsp.rm(tempPath, { force: true });
      return;
    }
    const stat = await fsp.stat(tempPath);
    if (stat.size <= 0) {
      await fsp.rm(tempPath, { force: true });
      throw new Error('下载结果为空');
    }
    if (stat.size < this.minBytes) {
      await fsp.rm(tempPath, { force: true });
      throw new Error(`音频文件过小，疑似广告或试听片段 (${stat.size} bytes)`);
    }

    // Detect actual audio format from file header (magic bytes) instead of
    // trusting the API's Content-Type, which is often wrong.
    const detected = await detectAudioFormat(tempPath);
    const actualContentType = detected.contentType || reportedContentType;
    const actualExt = detected.contentType ? extensionFor(detected.contentType, '') : ext;

    // If the detected format differs from the original extension, rename the file.
    let renamedPath = finalPath;
    if (actualExt && actualExt !== ext) {
      renamedPath = path.join(this.audioDir, `${song.cache_key}${actualExt}`);
    }

    await this._removeSiblingAudioFiles(song.cache_key, renamedPath);
    await fsp.rename(tempPath, renamedPath);
    if (this.closed) return;

    // Use requested quality (this.quality) as the nominal bitrate when the API
    // returns a non-standard value. The API reports values like 811, 1567 etc.
    // for lossless requests — these are not meaningful bitrate indicators.
    const requestedBr = Number(this.quality) || 999;
    const apiBr = normalizeBitrate(audio.br);
    const isLosslessRequest = requestedBr >= 900;
    const br = isLosslessRequest
      ? (apiBr && apiBr >= 900 ? apiBr : requestedBr)
      : (apiBr || requestedBr);

    this._markDownloaded(song, {
      filePath: renamedPath,
      contentType: actualContentType,
      br,
      size: stat.size
    });
  }

  async _resolveAudio(song) {
    if (!this.dispatcher) throw new Error('音乐源调度器不可用');
    const result = await this.dispatcher.proxy('url', {
      source: song.source || 'netease',
      id: song.id,
      br: this.quality,
      name: song.name || '',
      artist: song.artist || '',
      album: song.album || '',
      pic_id: song.pic_id || ''
    });
    const parsed = parseProviderBody(result);
    return {
      url: parsed?.url || parsed?.data?.url || '',
      br: parsed?.br || parsed?.data?.br || this.quality,
      contentType: result?.contentType
    };
  }

  _isUsableDownloadedTrack(track) {
    if (!track || track.status !== 'downloaded' || !track.file_path || !fs.existsSync(track.file_path)) {
      return false;
    }
    const size = Number(track.size || safeFileSize(track.file_path) || 0);
    if (size >= this.minBytes) return true;

    const error = new Error(`离线音频文件过小，疑似广告或试听片段 (${size} bytes)`);
    this._markError(track.cache_key, error);
    console.warn(`[offline-cache] invalid cached audio (${track.source}:${track.song_id}):`, error.message);
    return false;
  }

  // Scan all downloaded tracks and fix content_type / br / file extension
  // based on actual file content (magic bytes). Called once on startup.
  async repairMetadata() {
    const rows = this.db.prepare(`
      SELECT cache_key, file_path, content_type, br
      FROM offline_tracks
      WHERE status = 'downloaded' AND file_path IS NOT NULL
    `).all();

    let repaired = 0;
    for (const row of rows) {
      if (!row.file_path || !fs.existsSync(row.file_path)) continue;

      const detected = await detectAudioFormat(row.file_path);
      if (!detected.contentType) continue;

      const needsContentTypeFix = row.content_type !== detected.contentType;
      const currentExt = path.extname(row.file_path).toLowerCase();
      const correctExt = extensionFor(detected.contentType, '');
      const needsRename = correctExt && currentExt !== correctExt;

      // Fix br: if the stored br is a non-standard value (< 900) but the file
      // is actually lossless, set br to 999.
      const isLosslessFile = detected.format === 'flac' || detected.format === 'wav';
      const needsBrFix = isLosslessFile && (row.br || 0) < 900;

      if (!needsContentTypeFix && !needsRename && !needsBrFix) continue;

      let newPath = row.file_path;
      if (needsRename) {
        newPath = path.join(this.audioDir, `${row.cache_key}${correctExt}`);
        try {
          await fsp.rename(row.file_path, newPath);
        } catch {
          continue;
        }
      }

      const newBr = needsBrFix ? 999 : row.br;
      const newCt = needsContentTypeFix ? detected.contentType : row.content_type;

      this.db.prepare(`
        UPDATE offline_tracks
        SET content_type = ?, br = ?, file_path = ?, updated_at = strftime('%s', 'now')
        WHERE cache_key = ?
      `).run(newCt, newBr, newPath, row.cache_key);
      repaired++;
    }

    if (repaired > 0) {
      console.log(`[offline-cache] repaired metadata for ${repaired} tracks`);
    }
    return repaired;
  }

  _upsertPending(song) {
    this.db.prepare(`
      INSERT INTO offline_tracks
        (cache_key, song_id, source, name, artist, album, pic_id, status, user_requested, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, strftime('%s', 'now'))
      ON CONFLICT(cache_key) DO UPDATE SET
        name = excluded.name,
        artist = excluded.artist,
        album = excluded.album,
        pic_id = excluded.pic_id,
        user_requested = 1,
        updated_at = strftime('%s', 'now')
    `).run(
      song.cache_key,
      song.id,
      song.source,
      song.name || '',
      song.artist || '',
      song.album || '',
      song.pic_id || ''
    );
  }

  _markDownloading(song) {
    this.db.prepare(`
      UPDATE offline_tracks
      SET status = 'downloading',
          error = NULL,
          attempts = attempts + 1,
          updated_at = strftime('%s', 'now')
      WHERE cache_key = ?
    `).run(song.cache_key);
  }

  _markDownloaded(song, { filePath, contentType, br, size }) {
    this.db.prepare(`
      UPDATE offline_tracks
      SET status = 'downloaded',
          file_path = ?,
          content_type = ?,
          br = ?,
          size = ?,
          error = NULL,
          updated_at = strftime('%s', 'now'),
          downloaded_at = strftime('%s', 'now')
      WHERE cache_key = ?
    `).run(filePath, contentType, br, size, song.cache_key);
  }

  _markError(cacheKey, error) {
    this.db.prepare(`
      UPDATE offline_tracks
      SET status = 'error',
          error = ?,
          updated_at = strftime('%s', 'now')
      WHERE cache_key = ?
    `).run(String(error?.message || error || '下载失败').slice(0, 500), cacheKey);
  }

  async _deleteTrack(cacheKeyValue, filePath) {
    if (filePath) await fsp.rm(filePath, { force: true }).catch(() => {});
    await this._removeSiblingAudioFiles(cacheKeyValue, '');
    this.db.prepare('DELETE FROM offline_tracks WHERE cache_key = ?').run(cacheKeyValue);
  }

  async _removeSiblingAudioFiles(cacheKeyValue, keepPath) {
    const keep = keepPath ? path.resolve(keepPath) : '';
    const entries = await fsp.readdir(this.audioDir).catch(() => []);
    await Promise.all(entries
      .filter((name) => name.startsWith(`${cacheKeyValue}.`))
      .filter((name) => !name.includes('.tmp-'))
      .map(async (name) => {
        const target = path.join(this.audioDir, name);
        if (keep && path.resolve(target) === keep) return;
        await fsp.rm(target, { force: true }).catch(() => {});
      }));
  }
}

function offlineAudioUrl(track) {
  return `/offline/audio/${encodeURIComponent(track.cache_key)}`;
}

function cacheKey(source, songId) {
  return crypto.createHash('sha256').update(`${source || 'netease'}:${songId}`).digest('hex').slice(0, 32);
}

function normalizeSong(song) {
  return {
    id: String(song?.id || song?.song_id || '').trim(),
    source: String(song?.source || 'netease').trim() || 'netease',
    name: String(song?.name || '').trim(),
    artist: String(song?.artist || '').trim(),
    album: String(song?.album || '').trim(),
    pic_id: String(song?.pic_id || '').trim()
  };
}

function parseProviderBody(result) {
  if (!result) return null;
  if (typeof result === 'string') return parseJson(result);
  if (typeof result.data === 'string') return parseJson(result.data);
  if (result.data && typeof result.data === 'object') return result.data;
  if (typeof result === 'object') return result;
  return null;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeBitrate(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 5000 ? Math.round(numeric / 1000) : Math.round(numeric);
}

async function detectAudioFormat(filePath) {
  let fd;
  try {
    fd = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(12);
    await fd.read(buf, 0, 12, 0);

    const magic = buf.toString('ascii', 0, 4);
    if (magic === 'fLaC') return { format: 'flac', contentType: 'audio/x-flac' };
    if (magic.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { format: 'mp3', contentType: 'audio/mpeg' };
    if (magic.startsWith('OggS')) return { format: 'ogg', contentType: 'audio/ogg' };
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return { format: 'm4a', contentType: 'audio/mp4' };
    if (magic.startsWith('RIFF') && buf.toString('ascii', 8, 12) === 'WAVE') return { format: 'wav', contentType: 'audio/wav' };
  } catch { /* ignore */ }
  finally {
    if (fd) await fd.close().catch(() => {});
  }
  return { format: null, contentType: null };
}

function extensionFor(contentType, url) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('flac')) return '.flac';
  if (type.includes('mp4') || type.includes('aac') || type.includes('m4a')) return '.m4a';
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('wav')) return '.wav';
  const pathname = safeUrlPath(url).toLowerCase();
  const ext = path.extname(pathname);
  if (['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav'].includes(ext)) return ext;
  return '.mp3';
}

function safeUrlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

module.exports = {
  OfflineMusicCache,
  offlineAudioUrl,
  MIN_PLAYABLE_AUDIO_BYTES,
  cacheKey,
  extensionFor,
  parseProviderBody
};
