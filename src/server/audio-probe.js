'use strict';

const AUDIO_PROBE_BYTES = 4096;
const AUDIO_PROBE_TIMEOUT_MS = 6000;

// Read only a prefix even when the CDN ignores Range. Never buffer a whole song.
async function probeAudioUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIO_PROBE_TIMEOUT_MS);
  let reader;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Range: `bytes=0-${AUDIO_PROBE_BYTES - 1}`, Accept: 'audio/*,*/*' }
    });
    if (!response.ok || !response.body) {
      return { codec: '', lossless: false, verified: false, playable: false, probe_status: response.status };
    }
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < AUDIO_PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.subarray(0, AUDIO_PROBE_BYTES - size));
      chunks.push(chunk);
      size += chunk.length;
    }
    const metadata = audioMetadataFromBytes(Buffer.concat(chunks), response.headers.get('content-type'), response.url);
    return { ...metadata, verified: Boolean(metadata.signature), playable: size > 0 && metadata.playable !== false, probe_status: response.status };
  } catch (error) {
    return { codec: '', lossless: false, verified: false, probe_error: error.message || 'audio probe failed' };
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Detect audio format from raw bytes using magic byte signatures.
 */
function audioMetadataFromBytes(bytes, contentType = '', url = '') {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length >= 4) {
    const magic = buffer.toString('ascii', 0, 4);
    if (magic === 'fLaC') return { codec: 'flac', contentType: 'audio/x-flac', lossless: true, signature: true };
    if (buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) {
      return { codec: 'aac', contentType: 'audio/aac', lossless: false, signature: true };
    }
    if (magic.startsWith('ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
      return { codec: 'mp3', contentType: 'audio/mpeg', lossless: false, signature: true };
    }
    if (magic.startsWith('OggS')) return { codec: 'ogg', contentType: 'audio/ogg', lossless: false, signature: true };
    if (magic.startsWith('RIFF') && buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WAVE') {
      // WAVE is a container: only PCM / IEEE float fmt chunks prove lossless.
      for (let offset = 12; offset + 8 <= buffer.length;) {
        const length = buffer.readUInt32LE(offset + 4);
        if (buffer.toString('ascii', offset, offset + 4) === 'fmt ' && length >= 16 && offset + 24 <= buffer.length) {
          const format = buffer.readUInt16LE(offset + 8);
          return { codec: 'wav', contentType: 'audio/wav', lossless: [1, 3].includes(format), signature: true };
        }
        offset += 8 + length + (length % 2);
      }
      return { codec: 'wav', contentType: 'audio/wav', lossless: false, signature: true };
    }
    if (buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
      // An MP4 brand or an arbitrary 'alac' string does not prove the sample codec.
      return { codec: 'm4a', contentType: 'audio/mp4', lossless: false, signature: true };
    }
  }

  const prefix = buffer.toString('utf8', 0, 128).trimStart();
  const invalid = /^(?:<|\{|\[)/.test(prefix) || /text\/html|application\/json/i.test(contentType || '');
  return { ...audioMetadataFromContentTypeAndPath(contentType, url), lossless: false, signature: false, playable: !invalid };
}

/**
 * Infer audio format from Content-Type header and URL path.
 */
function audioMetadataFromContentTypeAndPath(contentType = '', urlOrPath = '') {
  const type = stringValue(contentType).toLowerCase();
  const pathname = safeUrlPath(urlOrPath).toLowerCase() || stringValue(urlOrPath).toLowerCase();

  if (type.includes('flac') || pathname.endsWith('.flac')) {
    return { codec: 'flac', contentType: 'audio/x-flac', lossless: true };
  }
  if (type.includes('wav') || pathname.endsWith('.wav')) {
    return { codec: 'wav', contentType: 'audio/wav', lossless: true };
  }
  if (type.includes('alac') || pathname.includes('alac')) {
    return { codec: 'alac', contentType: 'audio/mp4', lossless: true };
  }
  if (type.includes('mpeg') || pathname.endsWith('.mp3')) {
    return { codec: 'mp3', contentType: 'audio/mpeg', lossless: false };
  }
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac') || pathname.endsWith('.m4a') || pathname.endsWith('.aac')) {
    return { codec: 'm4a', contentType: 'audio/mp4', lossless: false };
  }
  if (type.includes('ogg') || pathname.endsWith('.ogg')) {
    return { codec: 'ogg', contentType: 'audio/ogg', lossless: false };
  }
  return { codec: '', contentType: contentType || '', lossless: false };
}

function stringValue(v) {
  return v == null ? '' : String(v);
}

function safeUrlPath(urlOrPath) {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return stringValue(urlOrPath);
  }
}

/**
 * Check if a bitrate value indicates a lossless request.
 */
function isLosslessRequest(br) {
  const value = String(br || '').toLowerCase();
  if (value === 'flac' || value === 'lossless' || value === 'sq') return true;
  return Number(value || 0) >= 900;
}

/**
 * Normalize bitrate from various API quirks (811, 1567, etc.)
 */
function normalizeAudioBitrate(br) {
  const n = Number(br);
  if (!n || n <= 0) return 0;
  if (n >= 900 && n <= 2000) return 999; // lossless range
  if (n >= 300 && n < 900) return 320;
  if (n >= 128 && n < 300) return 128;
  return n > 2000 ? Math.round(n / 1000) : n;
}

module.exports = {
  probeAudioUrl,
  audioMetadataFromBytes,
  audioMetadataFromContentTypeAndPath,
  isLosslessRequest,
  normalizeAudioBitrate,
  AUDIO_PROBE_BYTES,
  AUDIO_PROBE_TIMEOUT_MS
};

