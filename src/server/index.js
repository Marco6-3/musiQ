'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const axios = require('axios');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const {
  CODE_EXPIRY_SECONDS,
  createDataStore,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  generateCode,
  publicUser,
  userWithCollections,
  getUserFavorites,
  getUserPlaylistsObject,
  getUserPlaylistsArray,
  ensurePlaylist,
  songFromBody,
  insertPlaylistSong,
  parseJson,
  stringValue,
  normalizeArtist,
  formatDateTime
} = require('./database');
const { createDefaultDispatcher } = require('./source-providers');
const { registerPlayHistory } = require('./play-history');
const { syncUserData } = require('./user-sync');
const { handleAgentAssistant } = require('./agent-assistant');
const { startMonitoring } = require('./api-monitor');
const { OfflineMusicCache, offlineAudioUrl } = require('./offline-cache');
const { musicSources } = require('../config');
const {
  probeAudioUrl,
  audioMetadataFromContentTypeAndPath,
  isLosslessRequest,
  normalizeAudioBitrate
} = require('./audio-probe');

const projectRoot = path.resolve(__dirname, '../..');
const webroot = resolveWebroot();
const MUSIC_API_CACHE_VERSION = 'music-api-v7';
const ARTWORK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ARTWORK_CACHE_MAX = 96;
const ARTWORK_ALLOWED_HOST_SUFFIXES = Object.freeze([
  'music.126.net',
  'kuwo.cn',
  'kugou.com',
  'gtimg.cn',
  'qpic.cn',
  'migu.cn',
  'miguvideo.com',
  'hdslb.com',
  'baidu.com'
]);
const ARTWORK_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif'
]);
const AUTH_BODY_LIMIT_BYTES = 32 * 1024;
const SYNC_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const LOGIN_FAILURE_MAX = 6;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
const LOGIN_LOCK_MS = 15 * 60_000;
const VERIFICATION_FAILURE_MAX = 5;
const VERIFICATION_FAILURE_WINDOW_MS = 10 * 60_000;
const VERIFICATION_LOCK_MS = 10 * 60_000;
const GENERIC_LOGIN_ERROR = '用户名或密码错误';
const GENERIC_CODE_SENT_MESSAGE = '如果账号可以接收验证码，验证码已发送';
const GENERIC_CODE_ERROR = '验证码错误或已过期';
const PASSWORD_POLICY_MESSAGE = '密码长度需在8-128位之间，且不能使用常见弱密码';
const AUTH_ENDPOINTS = new Set([
  '/php/register_verification.php',
  '/php/register.php',
  '/php/login.php',
  '/php/logout.php',
  '/php/verify_token.php',
  '/php/verify_email.php',
  '/php/forgot_password.php',
  '/php/change_password.php'
]);
const PROTECTED_USER_ENDPOINTS = new Set([
  '/php/verify_email.php',
  '/php/change_password.php',
  '/php/update_avatar.php',
  '/php/favorite.php',
  '/php/get_favorites.php',
  '/php/sync_favorites.php',
  '/php/sync_bundle.php',
  '/php/playlist.php',
  '/php/get_playlists.php',
  '/php/get_playlist_id.php',
  '/php/rename_playlist.php',
  '/php/sync_playlists.php',
  '/php/agent_assistant.php',
  '/php/play_history.php'
]);
const COMMON_PASSWORDS = new Set([
  '000000',
  '111111',
  '112233',
  '123123',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  'abc123',
  'admin123',
  'iloveyou',
  'password',
  'password1',
  'qwerty',
  'qwerty123'
]);
const DUMMY_PASSWORD_HASH = hashPassword('dummy-password-for-auth-timing');

// In-memory LRU cache for hot API responses (search, url, lyric)
const memCache = new Map();
const MEM_CACHE_MAX = 300;

function memCacheGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memCache.delete(key);
    return null;
  }
  // Move to end (most recently used)
  memCache.delete(key);
  memCache.set(key, entry);
  return entry.data;
}

function memCacheSet(key, data, ttlMs) {
  if (memCache.size >= MEM_CACHE_MAX) {
    // Evict oldest entry (first in map)
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// In-flight request deduplication
const inflightRequests = new Map();
const iosLosslessTranscodes = new Map();
const IOS_LOSSLESS_SUFFIX = '.ios-lossless.m4a';
const IOS_LOSSLESS_CONTENT_TYPE = 'audio/mp4';

function resolveWebroot() {
  const resourceWebroot = process.resourcesPath ? path.join(process.resourcesPath, 'webroot') : null;
  if (resourceWebroot && fs.existsSync(resourceWebroot)) {
    return resourceWebroot;
  }
  return path.join(projectRoot, 'webroot');
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function resolveCorsOrigin(req) {
  const configured = envValue('MUSIC_CORS_ORIGIN', 'MUSIQ_CORS_ORIGIN');
  if (!configured) return '';

  const origin = stringValue(req.headers.origin);
  const allowed = configured.split(',').map((item) => item.trim()).filter(Boolean);
  if (allowed.includes('*')) return '*';
  if (origin && allowed.includes(origin)) return origin;
  return '';
}

async function startLocalBackend({ preferredPort = 41731, host, dataDir, musicSourceConfig, migrateFromDataDir = '' } = {}) {
  const resolvedPort = Number(envValue('MUSIC_PORT', 'MUSIQ_PORT', 'PORT') || preferredPort) || preferredPort;
  const resolvedHost = host || envValue('MUSIC_HOST', 'MUSIQ_HOST') || '127.0.0.1';
  const resolvedDataDir = dataDir || envValue('MUSIC_DATA_DIR', 'MUSIQ_DATA_DIR', 'XCLOUD_DATA_DIR') || path.join(projectRoot, 'data');
  const uploadsDir = path.join(resolvedDataDir, 'uploads', 'avatars');
  const cacheDir = path.join(resolvedDataDir, 'cache');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  // Prune cache after server starts (non-blocking)
  setImmediate(() => pruneCacheDirAsync(cacheDir));
  // Periodic cache prune every 10 minutes
  const pruneTimer = setInterval(() => pruneCacheDirAsync(cacheDir), 10 * 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  const store = await createDataStore(resolvedDataDir, { migrateFromDataDir });
  const dispatcher = createDefaultDispatcher(musicSourceConfig || musicSources);
  const offlineCache = new OfflineMusicCache({ db: store.db, dataDir: resolvedDataDir, dispatcher });
  offlineCache.scheduleSync(500);
  // Repair stale metadata (wrong content_type / br) from previous downloads.
  offlineCache.repairMetadata().catch((err) => {
    console.warn('[offline-cache] metadata repair failed:', err.message);
  });
  const app = createExpressApp({ store, uploadsDir, cacheDir, dispatcher, offlineCache });
  const stopMonitor = startMonitoring(store.db, dispatcher);
  const server = http.createServer(app);
  let closed = false;
  const port = await listen(server, resolvedPort, resolvedHost);
  const urlHost = resolvedHost === '0.0.0.0' ? '127.0.0.1' : resolvedHost;

  return {
    port,
    host: resolvedHost,
    url: `http://${urlHost}:${port}`,
    mode: 'express-sqlite',
    dbPath: store.dbPath,
    close: async () => {
      if (closed) return;
      closed = true;
      stopMonitor();
      offlineCache.close();
      try {
        await closeHttpServer(server);
      } finally {
        store.close();
      }
    }
  };
}

function createExpressApp({
  store,
  uploadsDir,
  cacheDir,
  dispatcher = createDefaultDispatcher(musicSources),
  offlineCache = null,
  iosLosslessConverter = undefined,
  artworkFetcher = fetchArtworkImage,
  artworkProcessor = processArtworkImage,
  agentModelClient = null,
  agentConfigResolver = undefined,
  agentUsagePolicy = undefined
}) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const app = express();
  const db = store.db;
  const upload = createUploadMiddleware(uploadsDir);
  const parseForm = upload.none();
  const loginIpLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
  const loginSubjectLimiter = createRateLimiter({
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    max: 30,
    keyGenerator: (req) => `login:${normalizeAuthIdentifier(req.body?.username) || clientKey(req)}`
  });
  const codeIpLimiter = createRateLimiter({ windowMs: 60_000, max: 8 });
  const codeSubjectLimiter = createRateLimiter({
    windowMs: VERIFICATION_FAILURE_WINDOW_MS,
    max: 3,
    message: '验证码请求过于频繁，请稍后再试',
    keyGenerator: (req) => `code:${normalizeEmail(req.body?.email) || normalizeAuthIdentifier(req.body?.user_id) || clientKey(req)}`
  });
  const loginFailures = createFailureTracker({
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    max: LOGIN_FAILURE_MAX,
    lockMs: LOGIN_LOCK_MS
  });
  const verificationFailures = createFailureTracker({
    windowMs: VERIFICATION_FAILURE_WINDOW_MS,
    max: VERIFICATION_FAILURE_MAX,
    lockMs: VERIFICATION_LOCK_MS
  });
  const artworkCache = new Map();

  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    setSecurityHeaders(req, res);
    const corsOrigin = resolveCorsOrigin(req);
    if (corsOrigin) res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('X-Music-Backend', 'express-sqlite');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(rejectOversizedAuthPayload);
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: true, limit: '16mb' }));

  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);
  app.get('/index.php', sendIndex);
  app.get('/manifest.webmanifest', (_req, res) => {
    res.type('application/manifest+json').sendFile(path.join(webroot, 'manifest.webmanifest'));
  });
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(path.join(webroot, 'sw.js'));
  });
  app.get('/offline.html', (_req, res) => {
    res.type('html').sendFile(path.join(webroot, 'offline.html'));
  });
  app.use('/css', express.static(path.join(webroot, 'css'), { fallthrough: false }));
  app.use('/js', express.static(path.join(webroot, 'js'), { fallthrough: false }));
  app.use('/public', express.static(path.join(webroot, 'public'), { fallthrough: false }));
  app.use('/uploads', express.static(path.join(store.dataDir, 'uploads'), { fallthrough: false }));
  app.get('/media/artwork', (req, res) => {
    handleMediaArtwork(req, res, { artworkFetcher, artworkProcessor, artworkCache }).catch((error) => {
      console.warn('[express-backend] artwork proxy failed:', error.message);
      if (!res.headersSent) {
        res.status(502).json({ success: false, message: '封面暂时不可用' });
      }
    });
  });
  app.get('/api_check/check_api.php', (_req, res) => {
    res.type('html').sendFile(path.join(webroot, 'api_check', 'check_api.php'));
  });
  app.get('/api_check/api_doubtful.php', (_req, res) => handleApiDoubtful(db, res));
  const offlineAudioHandler = (options = {}) => (req, res) => {
    handleOfflineAudio(req, res, offlineCache, { iosLosslessConverter, ...options }).catch((error) => {
      console.warn('[express-backend] offline audio request failed:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: '离线音频处理失败' });
        return;
      }
      res.destroy(error);
    });
  };
  app.get('/offline/audio/:key/alac.m4a', offlineAudioHandler({ format: 'alac' }));
  app.get('/offline/audio/:key', offlineAudioHandler());
  app.get('/api.php', (req, res) => proxyMusicApi(req, res, cacheDir, dispatcher, offlineCache, { iosLosslessConverter }));

  app.get('/php/check_version.php', (_req, res) => {
    res.json({
      version: '1.7.2',
      require_update: false,
      download_url: 'https://music.xcloudv.top/download/',
      message: '当前已是最新版本'
    });
  });
  app.get('/check_version.php', (_req, res) => {
    res.json({ version: '1.7.2' });
  });
  app.get('/php/toplist.php', (req, res) => handleToplist(req, res, cacheDir, dispatcher));
  app.get('/php/get_netease_playlist.php', (req, res) => handleNeteasePlaylist(req, res));

  app.post('/php/register_verification.php', codeIpLimiter, parseForm, codeSubjectLimiter, (req, res) => handleRegisterVerification(db, store.dataDir, req, res, { verificationFailures }));
  app.post('/php/register.php', loginIpLimiter, parseForm, (req, res) => handleRegister(db, req, res, { verificationFailures }));
  app.post('/php/login.php', loginIpLimiter, parseForm, loginSubjectLimiter, (req, res) => handleLogin(db, req, res, { loginFailures }));
  app.post('/php/logout.php', parseForm, (_req, res) => res.json({ success: true, message: '已安全退出登录' }));
  app.post('/php/verify_token.php', parseForm, (req, res) => handleVerifyToken(db, req, res));
  app.post('/php/verify_email.php', codeIpLimiter, parseForm, requireUserAuth(db), (req, res) => handleVerifyEmail(db, store.dataDir, req, res, { verificationFailures }));
  app.post('/php/forgot_password.php', codeIpLimiter, parseForm, codeSubjectLimiter, (req, res) => handleForgotPassword(db, store.dataDir, req, res, { verificationFailures }));
  app.post('/php/change_password.php', loginIpLimiter, parseForm, requireUserAuth(db), (req, res) => handleChangePassword(db, req, res));
  app.post('/php/update_avatar.php', upload.single('avatar'), requireUserAuth(db), (req, res) => handleUpdateAvatar(db, req, res));
  app.post('/php/favorite.php', parseForm, requireUserAuth(db), (req, res) => handleFavorite(db, req, res));
  app.post('/php/get_favorites.php', parseForm, requireUserAuth(db), (req, res) => handleGetFavorites(db, req, res));
  app.post('/php/sync_favorites.php', parseForm, requireUserAuth(db), (req, res) => handleSyncFavorites(db, req, res));
  app.post('/php/sync_bundle.php', parseForm, requireUserAuth(db), (req, res) => handleSyncBundle(db, req, res, offlineCache));
  app.post('/php/playlist.php', parseForm, requireUserAuth(db), (req, res) => handlePlaylist(db, req, res, offlineCache));
  app.post('/php/get_playlists.php', parseForm, requireUserAuth(db), (req, res) => handleGetPlaylists(db, req, res));
  app.post('/php/get_playlist_id.php', parseForm, requireUserAuth(db), (req, res) => handleGetPlaylistId(db, req, res));
  app.post('/php/rename_playlist.php', parseForm, requireUserAuth(db), (req, res) => handleRenamePlaylist(db, req, res));
  app.post('/php/sync_playlists.php', parseForm, requireUserAuth(db), (req, res) => handleSyncPlaylists(db, req, res, offlineCache));
  app.post('/php/agent_assistant.php', parseForm, requireUserAuth(db), (req, res, next) => {
    handleAgentAssistant(db, req, res, {
      dispatcher,
      offlineCache,
      agentModelClient,
      agentConfigResolver,
      agentUsagePolicy
    }).catch(next);
  });
  registerPlayHistory(app, db, requireUserAuth(db));

  app.use((req, res) => {
    res.status(404).json({ success: false, message: `Not found: ${req.path}` });
  });
  app.use((error, _req, res, _next) => {
    console.error('[express-backend]', error);
    const message = process.env.NODE_ENV === 'production' ? '服务器错误' : (error.message || '服务器错误');
    res.status(500).json({ success: false, message });
  });

  return app;
}

function sendIndex(_req, res) {
  res.type('html').sendFile(path.join(webroot, 'index.html'));
}

async function handleMediaArtwork(req, res, options = {}) {
  const artworkFetcher = options.artworkFetcher || fetchArtworkImage;
  const artworkProcessor = options.artworkProcessor || processArtworkImage;
  const artworkCache = options.artworkCache || null;
  const target = parseAllowedArtworkUrl(req.query.url);
  if (!target) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ success: false, message: '不支持的封面地址' });
    return;
  }

  const cacheKey = crypto.createHash('sha256').update(target.href).digest('hex');
  let image = artworkCache?.get(cacheKey) || null;
  if (image && artworkCache) {
    artworkCache.delete(cacheKey);
    artworkCache.set(cacheKey, image);
  }
  if (!image) {
    const sourceImage = await artworkFetcher(target);
    image = await artworkProcessor(sourceImage);
    if (artworkCache) {
      artworkCache.set(cacheKey, image);
      while (artworkCache.size > ARTWORK_CACHE_MAX) {
        artworkCache.delete(artworkCache.keys().next().value);
      }
    }
  }
  const body = Buffer.isBuffer(image?.data) ? image.data : Buffer.from(image?.data || '');
  const contentType = String(image?.contentType || '').split(';')[0].trim().toLowerCase();
  if (!body.length || body.length > ARTWORK_IMAGE_MAX_BYTES || !ARTWORK_CONTENT_TYPES.has(contentType)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ success: false, message: '封面响应无效' });
    return;
  }

  const etag = `"${crypto.createHash('sha256').update(body).digest('hex')}"`;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.status(200).send(body);
}

async function fetchArtworkImage(target) {
  const response = await axios.get(target.href, {
    timeout: 8000,
    responseType: 'arraybuffer',
    maxContentLength: ARTWORK_IMAGE_MAX_BYTES,
    maxBodyLength: ARTWORK_IMAGE_MAX_BYTES,
    maxRedirects: 3,
    validateStatus: (status) => status >= 200 && status < 300,
    beforeRedirect: (options) => {
      const protocol = String(options.protocol || '').toLowerCase();
      const hostname = String(options.hostname || '').toLowerCase();
      if (!['http:', 'https:'].includes(protocol) || !isAllowedArtworkHost(hostname)) {
        throw new Error('artwork redirect blocked');
      }
    },
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
      Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1'
    }
  });
  return {
    data: Buffer.from(response.data || ''),
    contentType: response.headers['content-type'] || ''
  };
}

async function processArtworkImage(image) {
  const source = Buffer.isBuffer(image?.data) ? image.data : Buffer.from(image?.data || '');
  const sourceType = String(image?.contentType || '').split(';')[0].trim().toLowerCase();
  if (!source.length || source.length > ARTWORK_IMAGE_MAX_BYTES || !ARTWORK_CONTENT_TYPES.has(sourceType)) {
    throw new Error('invalid artwork source');
  }

  const data = await sharp(source, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(512, 512, {
      fit: 'contain',
      background: { r: 7, g: 17, b: 13, alpha: 1 }
    })
    .flatten({ background: { r: 7, g: 17, b: 13 } })
    .jpeg({ quality: 86, progressive: true, mozjpeg: true })
    .toBuffer();

  return { data, contentType: 'image/jpeg' };
}

function parseAllowedArtworkUrl(value) {
  try {
    const target = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(target.protocol)) return null;
    if (target.username || target.password) return null;
    if (!isAllowedArtworkHost(target.hostname)) return null;
    if (target.port && !['80', '443'].includes(target.port)) return null;
    return target;
  } catch {
    return null;
  }
}

function isAllowedArtworkHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return ARTWORK_ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function createUploadMiddleware(uploadsDir) {
  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadsDir),
    filename: (req, file, callback) => {
      const userId = String(req.body.user_id || '0').replace(/[^0-9]/g, '') || '0';
      const ext = extensionFromFile(file);
      callback(null, `avatar_${userId}_${Date.now()}${ext}`);
    }
  });

  return multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
      if (!['image/jpeg', 'image/png', 'image/jpg'].includes(file.mimetype)) {
        callback(new Error('仅支持 JPG、PNG 格式'));
        return;
      }
      callback(null, true);
    }
  });
}

function extensionFromFile(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext) return ext;
  return file.mimetype === 'image/png' ? '.png' : '.jpg';
}

function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (AUTH_ENDPOINTS.has(req.path) || PROTECTED_USER_ENDPOINTS.has(req.path)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
}

function rejectOversizedAuthPayload(req, res, next) {
  if (AUTH_ENDPOINTS.has(req.path) || PROTECTED_USER_ENDPOINTS.has(req.path)) {
    const contentLength = Number(req.headers['content-length'] || 0);
    const limit = req.path === '/php/sync_bundle.php' ? SYNC_BODY_LIMIT_BYTES : AUTH_BODY_LIMIT_BYTES;
    if (contentLength > limit) {
      res.status(413).json({ success: false, message: '请求体过大' });
      return;
    }
  }
  next();
}

function requireUserAuth(db) {
  return (req, res, next) => {
    const token = tokenFromRequest(req);
    const uid = token ? verifyToken(token) : null;
    const requestedUserId = Number(req.body?.user_id || 0);
    if (!uid || (requestedUserId && requestedUserId !== Number(uid))) {
      cleanupUploadedFile(req);
      res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
      return;
    }

    const user = publicUser(db, uid);
    if (!user) {
      cleanupUploadedFile(req);
      res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
      return;
    }

    req.authUserId = uid;
    req.authUser = user;
    req.body.user_id = String(uid);
    next();
  };
}

function tokenFromRequest(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return stringValue(req.body?.token || (match ? match[1] : ''));
}

function cleanupUploadedFile(req) {
  if (!req.file?.path) return;
  fs.unlink(req.file.path, () => {});
}

function createRateLimiter({ windowMs, max, keyGenerator = clientKey, message = '请求过于频繁，请稍后再试' }) {
  const hits = new Map();
  let lastCleanup = Date.now();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.path}:${safeRateLimitKey(req, keyGenerator)}`;
    const record = hits.get(key);

    if (now - lastCleanup > 300_000) {
      lastCleanup = now;
      for (const [k, v] of hits) {
        if (now > v.resetAt) hits.delete(k);
      }
    }

    if (!record || now > record.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    record.count += 1;
    if (record.count > max) {
      setRetryAfter(res, record.resetAt, now);
      res.status(429).json({ success: false, message });
      return;
    }

    next();
  };
}

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'local');
}

function safeRateLimitKey(req, keyGenerator) {
  try {
    const key = keyGenerator(req);
    return normalizeAuthIdentifier(key) || clientKey(req);
  } catch {
    return clientKey(req);
  }
}

function setRetryAfter(res, resetAt, now = Date.now()) {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
}

function createFailureTracker({ windowMs, max, lockMs }) {
  const failures = new Map();

  function cleanup(now) {
    for (const [key, record] of failures) {
      if ((record.lockedUntil && now > record.lockedUntil) || now > record.resetAt + lockMs) {
        failures.delete(key);
      }
    }
  }

  return {
    check(key) {
      const now = Date.now();
      cleanup(now);
      const record = failures.get(key);
      if (!record || !record.lockedUntil || now > record.lockedUntil) return null;
      return record;
    },
    recordFailure(key) {
      const now = Date.now();
      cleanup(now);
      const record = failures.get(key);
      if (!record || now > record.resetAt) {
        failures.set(key, { count: 1, resetAt: now + windowMs, lockedUntil: 0 });
        return null;
      }

      record.count += 1;
      if (record.count >= max) {
        record.lockedUntil = now + lockMs;
      }
      return record.lockedUntil ? record : null;
    },
    reset(key) {
      failures.delete(key);
    }
  };
}

function loginFailureKey(identifier) {
  return `login:${normalizeEmail(identifier) || normalizeAuthIdentifier(identifier) || 'unknown'}`;
}

function verificationKey(purpose, identifier) {
  return `${purpose}:${normalizeAuthIdentifier(identifier) || 'unknown'}`;
}

function lockedResponse(res, lock, message) {
  setRetryAfter(res, lock.lockedUntil);
  return res.status(429).json({ success: false, message });
}

function normalizeAuthIdentifier(value) {
  return stringValue(value).toLowerCase().slice(0, 254);
}

function normalizeEmail(value) {
  return stringValue(value).toLowerCase();
}

function normalizeVerificationCode(value) {
  return stringValue(value).replace(/\s+/g, '');
}

function isVerificationCode(value) {
  return /^\d{6}$/.test(String(value || ''));
}

function validateUsername(username) {
  if (username.length < 3 || username.length > 30) {
    return '用户名长度需在3-30位之间';
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(username)) {
    return '用户名只能包含文字、数字、下划线或短横线';
  }
  return '';
}

function validateNewPassword(password, label = '密码') {
  const message = label === '密码'
    ? PASSWORD_POLICY_MESSAGE
    : `${label}长度需在8-128位之间，且不能使用常见弱密码`;
  if (password.length < 8 || password.length > 128) return message;
  if (!password.trim()) return message;
  if (COMMON_PASSWORDS.has(password.trim().toLowerCase())) return message;
  return '';
}

function userByRecoveryEmail(db, email) {
  if (!email) return null;
  return db.prepare('SELECT id, verification_code, code_expires_at FROM users WHERE lower(email) = ? AND email_verified = 1').get(email);
}

function recoveryKey(email) {
  return verificationKey('forgot_password', email);
}

function handleRegisterVerification(db, dataDir, req, res, { verificationFailures } = {}) {
  const email = normalizeEmail(req.body.email);
  if (!isEmail(email)) return res.json({ success: false, message: '请填写正确的邮箱地址' });

  const existing = db.prepare('SELECT id, email_verified FROM users WHERE lower(email) = ?').get(email);
  if (existing && existing.email_verified) {
    return res.json({ success: true, message: GENERIC_CODE_SENT_MESSAGE });
  }

  const code = generateCode();
  const expires = nowSeconds() + CODE_EXPIRY_SECONDS;
  if (existing) {
    db.prepare('UPDATE users SET verification_code = ?, code_expires_at = ? WHERE id = ?').run(code, expires, existing.id);
  } else {
    const tempUsername = `temp_${crypto.createHash('sha256').update(email).digest('hex').slice(0, 16)}`;
    db.prepare(`
      INSERT INTO users (username, email, password_hash, verification_code, code_expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tempUsername, email, hashPassword(crypto.randomUUID()), code, expires);
  }

  verificationFailures?.reset(verificationKey('register', email));
  logVerificationEmail(dataDir, email, code, 'register');
  return res.json({ success: true, message: GENERIC_CODE_SENT_MESSAGE });
}

function handleRegister(db, req, res, { verificationFailures } = {}) {
  const username = stringValue(req.body.username);
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const verificationCode = normalizeVerificationCode(req.body.verification_code);

  if (!username || !email || !password || !verificationCode) {
    return res.json({ success: false, message: '所有字段均为必填项' });
  }
  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.json({ success: false, message: usernameError });
  }
  if (!isEmail(email)) return res.json({ success: false, message: '邮箱格式不正确' });
  const passwordError = validateNewPassword(password);
  if (passwordError) return res.json({ success: false, message: passwordError });
  if (!isVerificationCode(verificationCode)) return res.json({ success: false, message: GENERIC_CODE_ERROR });

  const key = verificationKey('register', email);
  const lock = verificationFailures?.check(key);
  if (lock) return lockedResponse(res, lock, '验证码错误次数过多，请稍后再试');

  const existing = db.prepare(`
    SELECT id, verification_code, code_expires_at, email_verified
    FROM users
    WHERE lower(email) = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(email);

  if (!existing || existing.email_verified || existing.verification_code !== verificationCode || existing.code_expires_at < nowSeconds()) {
    verificationFailures?.recordFailure(key);
    return res.json({ success: false, message: GENERIC_CODE_ERROR });
  }

  try {
    db.prepare(`
      UPDATE users
      SET username = ?, password_hash = ?, email_verified = 1, verification_code = NULL, code_expires_at = NULL
      WHERE id = ?
    `).run(username, hashPassword(password), existing.id);
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed: users.username')) {
      return res.json({ success: false, message: '用户名已被注册' });
    }
    throw error;
  }

  verificationFailures?.reset(key);
  const user = userWithCollections(db, existing.id);
  return res.json({ success: true, token: generateToken(existing.id), user });
}

function handleLogin(db, req, res, { loginFailures } = {}) {
  const username = stringValue(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.json({ success: false, message: '用户名和密码不能为空' });
  if (username.length > 254 || password.length > 128) {
    loginFailures?.recordFailure(loginFailureKey(username));
    return res.json({ success: false, message: GENERIC_LOGIN_ERROR });
  }

  const key = loginFailureKey(username);
  const lock = loginFailures?.check(key);
  if (lock) return lockedResponse(res, lock, '登录尝试过多，请稍后再试');

  const user = db.prepare(`
    SELECT id, username, email, password_hash, avatar, email_verified
    FROM users
    WHERE username = ? OR lower(email) = ?
  `).get(username, normalizeEmail(username));
  const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);

  if (!user || !passwordOk || !user.email_verified) {
    loginFailures?.recordFailure(key);
    return res.json({ success: false, message: GENERIC_LOGIN_ERROR });
  }

  loginFailures?.reset(key);
  return res.json({
    success: true,
    token: generateToken(user.id),
    user: userWithCollections(db, user.id)
  });
}

function handleVerifyToken(db, req, res) {
  const token = stringValue(req.body.token);
  const userId = Number(req.body.user_id || 0);
  if (!token) return res.json({ success: false, message: '登录已过期，请重新登录' });

  const finalUid = verifyToken(token);
  if (!finalUid) return res.json({ success: false, message: '登录已过期，请重新登录' });
  if (userId && Number(userId) !== Number(finalUid)) {
    return res.json({ success: false, message: '登录已过期，请重新登录' });
  }

  const user = userWithCollections(db, finalUid);
  if (!user) return res.json({ success: false, message: '用户不存在' });
  return res.json({ success: true, user });
}

function handleVerifyEmail(db, dataDir, req, res, { verificationFailures } = {}) {
  const action = stringValue(req.body.action);
  if (action === 'send_code') {
    const userId = Number(req.body.user_id || 0);
    const email = normalizeEmail(req.body.email);
    const tempEmail = normalizeEmail(req.body.temp_email);
    if (!userId) return res.json({ success: false, message: '缺少用户ID' });

    const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ success: false, message: '用户不存在' });

    const targetEmail = tempEmail || email || user.email;
    if (!isEmail(targetEmail)) return res.json({ success: false, message: '邮箱格式不正确' });

    const code = generateCode();
    db.prepare('UPDATE users SET verification_code = ?, code_expires_at = ? WHERE id = ?').run(code, nowSeconds() + CODE_EXPIRY_SECONDS, userId);
    verificationFailures?.reset(verificationKey('verify_email', userId));
    logVerificationEmail(dataDir, targetEmail, code, 'verify_email');
    return res.json({ success: true, message: '验证码已发送' });
  }

  if (action === 'verify' || action === 'verify_code') {
    const userId = Number(req.body.user_id || 0);
    const code = normalizeVerificationCode(req.body.code);
    if (!userId || !code) return res.json({ success: false, message: '缺少必要参数' });
    if (!isVerificationCode(code)) return res.json({ success: false, message: GENERIC_CODE_ERROR });

    const key = verificationKey('verify_email', userId);
    const lock = verificationFailures?.check(key);
    if (lock) return lockedResponse(res, lock, '验证码错误次数过多，请稍后再试');

    const user = db.prepare('SELECT verification_code, code_expires_at FROM users WHERE id = ?').get(userId);
    if (!user || user.verification_code !== code || user.code_expires_at < nowSeconds()) {
      verificationFailures?.recordFailure(key);
      return res.json({ success: false, message: GENERIC_CODE_ERROR });
    }

    db.prepare('UPDATE users SET email_verified = 1, verification_code = NULL, code_expires_at = NULL WHERE id = ?').run(userId);
    verificationFailures?.reset(key);
    return res.json({ success: true, message: '邮箱验证成功' });
  }

  return res.json({ success: false, message: '未知操作' });
}

function handleForgotPassword(db, dataDir, req, res, { verificationFailures } = {}) {
  const action = stringValue(req.body.action);
  if (action === 'send_code') {
    const email = normalizeEmail(req.body.email);
    if (email && !isEmail(email)) return res.json({ success: false, message: '邮箱格式不正确' });
    if (req.body.phone) return res.json({ success: false, message: '当前仅支持邮箱验证码' });
    if (!email) return res.json({ success: false, message: '请填写邮箱' });

    const user = db.prepare('SELECT id FROM users WHERE lower(email) = ? AND email_verified = 1').get(email);
    if (!user) return res.json({ success: true, message: GENERIC_CODE_SENT_MESSAGE });

    const code = generateCode();
    db.prepare('UPDATE users SET verification_code = ?, code_expires_at = ? WHERE id = ?').run(code, nowSeconds() + CODE_EXPIRY_SECONDS, user.id);
    verificationFailures?.reset(recoveryKey(email));
    logVerificationEmail(dataDir, email, code, 'forgot_password');
    return res.json({ success: true, message: GENERIC_CODE_SENT_MESSAGE });
  }

  if (action === 'reset_password') {
    const email = normalizeEmail(req.body.email);
    const code = normalizeVerificationCode(req.body.code);
    const newPassword = String(req.body.new_password || '');
    if (email && !isEmail(email)) return res.json({ success: false, message: '邮箱格式不正确' });
    if (req.body.phone) return res.json({ success: false, message: '当前仅支持邮箱验证码' });
    if (!email || !code || !newPassword) return res.json({ success: false, message: '请填写所有必填项' });
    const passwordError = validateNewPassword(newPassword);
    if (passwordError) return res.json({ success: false, message: passwordError });
    if (!isVerificationCode(code)) return res.json({ success: false, message: GENERIC_CODE_ERROR });

    const key = recoveryKey(email);
    const lock = verificationFailures?.check(key);
    if (lock) return lockedResponse(res, lock, '验证码错误次数过多，请稍后再试');

    const user = userByRecoveryEmail(db, email);
    if (!user || user.verification_code !== code || user.code_expires_at < nowSeconds()) {
      verificationFailures?.recordFailure(key);
      return res.json({ success: false, message: GENERIC_CODE_ERROR });
    }

    db.prepare('UPDATE users SET password_hash = ?, verification_code = NULL, code_expires_at = NULL WHERE id = ?').run(hashPassword(newPassword), user.id);
    verificationFailures?.reset(key);
    return res.json({ success: true, message: '密码重置成功' });
  }

  return res.json({ success: false, message: '未知操作' });
}

function handleChangePassword(db, req, res) {
  const userId = Number(req.body.user_id || 0);
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  if (!userId || !currentPassword || !newPassword) return res.json({ success: false, message: '请填写所有必填项' });
  const passwordError = validateNewPassword(newPassword, '新密码');
  if (passwordError) return res.json({ success: false, message: passwordError });
  if (currentPassword.length > 128) return res.json({ success: false, message: '当前密码错误' });

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    return res.json({ success: false, message: '当前密码错误' });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  return res.json({ success: true, message: '密码修改成功' });
}

function handleUpdateAvatar(db, req, res) {
  const userId = Number(req.body.user_id || 0);
  if (!userId) return res.json({ success: false, message: '缺少用户ID' });
  if (!req.file) return res.json({ success: false, message: '头像上传失败' });

  const avatarUrl = `uploads/avatars/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, userId);
  return res.json({ success: true, avatar_url: avatarUrl });
}

function handleFavorite(db, req, res) {
  const userId = Number(req.body.user_id || 0);
  const songId = stringValue(req.body.song_id || req.body.id);
  const source = stringValue(req.body.source || 'netease');
  const action = stringValue(req.body.action || 'add');
  if (!userId || !songId) return res.json({ success: false, message: '缺少必要参数' });

  if (action === 'check') {
    const exists = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND song_id = ? AND source = ?').get(userId, songId, source);
    return res.json({ success: true, is_favorite: Boolean(exists) });
  }

  if (action === 'add') {
    const song = songFromBody(req.body);
    db.prepare(`
      INSERT OR IGNORE INTO favorites (user_id, song_id, source, name, artist, album, pic_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, song.id, song.source, song.name, song.artist, song.album, song.pic_id);
    return res.json({ success: true, is_favorite: true });
  }

  if (action === 'update') {
    const song = songFromBody(req.body);
    db.prepare('UPDATE favorites SET album = ?, pic_id = ? WHERE user_id = ? AND song_id = ? AND source = ?').run(song.album, song.pic_id, userId, song.id, song.source);
    return res.json({ success: true, is_favorite: true });
  }

  if (action === 'remove') {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND song_id = ? AND source = ?').run(userId, songId, source);
    return res.json({ success: true, is_favorite: false });
  }

  return res.json({ success: false, message: '未知操作' });
}

function handleGetFavorites(db, req, res) {
  const userId = Number(req.body.user_id || 0);
  if (!userId) return res.json({ success: false, message: '缺少用户ID' });
  return res.json({ success: true, favorites: getUserFavorites(db, userId) });
}

function handleSyncFavorites(db, req, res) {
  const userId = Number(req.body.user_id || 0);
  if (!userId) return res.json({ success: false, message: '缺少用户ID' });

  const favorites = parseJson(req.body.favorites, null);
  if (!Array.isArray(favorites)) return res.json({ success: false, message: '收藏数据格式错误' });

  const sync = db.transaction(() => {
    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(userId);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO favorites (user_id, song_id, source, name, artist, album, pic_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const rawSong of favorites) {
      const song = songFromBody(rawSong);
      if (!song.id) continue;
      insert.run(userId, song.id, song.source, song.name, song.artist, song.album, song.pic_id);
    }
  });

  sync();
  return res.json({ success: true, message: '收藏同步成功' });
}

function handleSyncBundle(db, req, res, offlineCache) {
  const userId = Number(req.body.user_id || 0);
  if (!userId) return res.json({ success: false, message: '缺少用户ID' });

  const payload = parseJson(req.body.payload || req.body.data || '{}', null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.json({ success: false, message: '同步数据格式错误' });
  }

  const mode = stringValue(req.body.mode || req.body.action || 'merge') === 'replace' ? 'replace' : 'merge';
  const synced = syncUserData(db, userId, payload, { mode });
  scheduleOfflineSync(offlineCache);
  return res.json({
    success: true,
    message: mode === 'replace' ? '云端数据已替换' : '云端数据已合并',
    mode,
    user: userWithCollections(db, userId),
    recent_plays: synced.recent_plays,
    sync_state: synced.sync_state
  });
}

function handlePlaylist(db, req, res, offlineCache) {
  const userId = Number(req.body.user_id || 0);
  const action = stringValue(req.body.action);
  if (!userId) return res.json({ success: false, message: '缺少用户ID' });

  if (action === 'create') {
    const name = stringValue(req.body.name || req.body.playlist_name);
    if (!name) return res.json({ success: false, message: '歌单名称不能为空' });
    const playlist = ensurePlaylist(db, userId, name);
    return res.json({ success: true, playlist_id: playlist.id, name: playlist.name });
  }

  if (action === 'add_song' || (!action && req.body.song_id)) {
    const playlistId = Number(req.body.playlist_id || 0);
    const song = songFromBody(req.body);
    if (!playlistId || !song.id) return res.json({ success: false, message: '缺少必要参数' });
    if (!ownsPlaylist(db, userId, playlistId)) return res.json({ success: false, message: '歌单不存在' });
    insertPlaylistSong(db, playlistId, song);
    scheduleOfflineSync(offlineCache);
    return res.json({ success: true, message: '已添加到歌单' });
  }

  if (action === 'remove_song' || action === 'remove') {
    const playlistId = Number(req.body.playlist_id || 0);
    const songId = stringValue(req.body.song_id);
    const source = stringValue(req.body.source || 'netease');
    if (!ownsPlaylist(db, userId, playlistId)) return res.json({ success: false, message: '歌单不存在' });
    db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ? AND source = ?').run(playlistId, songId, source);
    scheduleOfflineSync(offlineCache);
    return res.json({ success: true, message: '已从歌单移除' });
  }

  if (action === 'delete') {
    const playlistId = Number(req.body.playlist_id || 0);
    if (!ownsPlaylist(db, userId, playlistId)) return res.json({ success: false, message: '歌单不存在' });
    const deletePlaylist = db.transaction(() => {
      db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?').run(playlistId);
      db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(playlistId, userId);
    });
    deletePlaylist();
    scheduleOfflineSync(offlineCache);
    return res.json({ success: true, message: '歌单已删除' });
  }

  if (action === 'get') {
    const playlistId = Number(req.body.playlist_id || 0);
    const playlist = db.prepare('SELECT id, name FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
    if (!playlist) return res.json({ success: false, message: '歌单不存在' });

    const songs = db.prepare(`
      SELECT song_id AS id, source, name, artist, album, pic_id, original_title, original_artist
      FROM playlist_songs
      WHERE playlist_id = ?
      ORDER BY created_at DESC
    `).all(playlistId);
    return res.json({ success: true, playlist, songs });
  }

  if (action === 'update_songs' || action === 'import_songs') {
    const playlistId = Number(req.body.playlist_id || 0);
    const songs = parseJson(req.body.songs, null);
    if (!Array.isArray(songs)) return res.json({ success: false, message: '歌曲数据格式错误' });
    if (!ownsPlaylist(db, userId, playlistId)) return res.json({ success: false, message: '歌单不存在' });

    const update = db.transaction(() => {
      if (action === 'import_songs') {
        db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?').run(playlistId);
      }
      for (const rawSong of songs) {
        const song = songFromBody(rawSong);
        if (song.id) insertPlaylistSong(db, playlistId, song);
      }
    });
    update();
    scheduleOfflineSync(offlineCache);
    return res.json({ success: true, message: '歌曲导入成功' });
  }

  return res.json({ success: false, message: '未知操作' });
}

function handleGetPlaylists(db, req, res) {
  const userId = Number(req.body.user_id || 0);
  if (!userId) return res.json({ success: false, message: '缺少用户ID' });
  return res.json({ success: true, playlists: getUserPlaylistsArray(db, userId) });
}

function handleGetPlaylistId(db, req, res) {
  const userId = Number(req.body.user_id || 0);
  const playlistName = stringValue(req.body.playlist_name);
  if (!userId || !playlistName) return res.json({ success: false, message: '缺少必要参数' });
  const playlist = ensurePlaylist(db, userId, playlistName);
  return res.json({ success: true, playlist_id: playlist.id });
}

function handleRenamePlaylist(db, req, res) {
  const userId = Number(req.body.user_id || 0);
  const oldName = stringValue(req.body.old_name);
  const newName = stringValue(req.body.new_name);
  if (!userId || !oldName || !newName) return res.json({ success: false, message: '缺少必要参数' });
  if (oldName === newName) return res.json({ success: true, message: '名称未变更' });

  const exists = db.prepare('SELECT id FROM playlists WHERE user_id = ? AND name = ?').get(userId, newName);
  if (exists) return res.json({ success: false, message: '歌单名称已存在' });

  db.prepare('UPDATE playlists SET name = ? WHERE user_id = ? AND name = ?').run(newName, userId, oldName);
  return res.json({ success: true, message: '歌单已重命名' });
}

function handleSyncPlaylists(db, req, res, offlineCache) {
  const userId = Number(req.body.user_id || 0);
  if (!userId) return res.json({ success: false, message: '缺少用户ID' });

  const playlists = parseJson(req.body.playlists, null);
  if (!playlists || typeof playlists !== 'object' || Array.isArray(playlists)) {
    return res.json({ success: false, message: '歌单数据格式错误' });
  }

  const sync = db.transaction(() => {
    for (const [name, songs] of Object.entries(playlists)) {
      if (!Array.isArray(songs)) continue;
      const playlist = ensurePlaylist(db, userId, name);
      db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?').run(playlist.id);
      for (const rawSong of songs) {
        const song = songFromBody(rawSong);
        if (song.id) insertPlaylistSong(db, playlist.id, song);
      }
    }
  });
  sync();
  scheduleOfflineSync(offlineCache);
  return res.json({ success: true, message: '歌单同步成功' });
}

async function handleToplist(req, res, cacheDir, dispatcher) {
  const type = req.query.type || 'soaring';
  const cached = readDailyToplistCache(cacheDir, type);
  if (cached) {
    res.setHeader('X-Toplist-Cache', 'HIT');
    return res.json(cached);
  }

  const toplistMap = {
    soaring: 19723756,
    new: 3779629,
    original: 2884035,
    hot: 3778678,
    douyin: 2250011882,
    rap: 5213356842,
    electronic: 1978921795,
    euro_america: 2809513713,
    billboard: 60198,
    beatport: 3812895,
    korean: 745956260,
    uk: 180106
  };
  if (type === 'qq_music') return handleQqMusicToplist(res, cacheDir, type, dispatcher);

  const playlistId = toplistMap[type] || toplistMap.soaring;

  try {
    const response = await axios.get(`https://music.163.com/api/playlist/detail?id=${playlistId}`, {
      timeout: 10_000,
      headers: neteaseHeaders()
    });
    const tracks = response.data?.result?.tracks || [];
    if (!tracks.length) return res.json({ code: 500, message: '榜单数据为空', data: [] });

    const data = tracks.slice(0, 100).map((track, index) => ({
      id: String(track.id),
      name: track.name,
      artist: (track.artists || []).map((artist) => artist.name),
      album: track.album?.name || '',
      pic_id: track.album?.picId ? String(track.album.picId) : '',
      source: 'netease',
      rank: index + 1
    }));
    const payload = { code: 200, data };
    writeDailyToplistCache(cacheDir, type, payload);
    res.setHeader('X-Toplist-Cache', 'MISS');
    return res.json(payload);
  } catch {
    return res.json({ code: 500, message: '获取榜单数据失败', data: [] });
  }
}

async function handleQqMusicToplist(res, cacheDir, type, dispatcher) {
  try {
    const response = await axios.get('https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg', {
      timeout: 10_000,
      params: {
        topid: 26,
        format: 'json',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: 0,
        platform: 'yqq.json',
        needNewCode: 1
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://y.qq.com/'
      }
    });
    const items = response.data?.songlist || [];
    if (!items.length) return res.json({ code: 500, message: 'QQ音乐榜单数据为空', data: [] });

    const data = await resolvePlayableToplistSongs(items.slice(0, 60), dispatcher);
    if (!data.length) return res.json({ code: 500, message: 'QQ音乐榜单歌曲解析失败', data: [] });
    const payload = { code: 200, data };
    writeDailyToplistCache(cacheDir, type, payload);
    res.setHeader('X-Toplist-Cache', 'MISS');
    return res.json(payload);
  } catch {
    return res.json({ code: 500, message: '获取QQ音乐榜单失败', data: [] });
  }
}

function readDailyToplistCache(cacheDir, type) {
  return readToplistCacheFile(toplistCacheFile(cacheDir, type, localDateKey()));
}

function writeDailyToplistCache(cacheDir, type, payload) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const dateKey = localDateKey();
  fs.writeFileSync(toplistCacheFile(cacheDir, type, dateKey), JSON.stringify(payload), 'utf8');
  pruneToplistCache(cacheDir, type, dateKey);
}

function pruneToplistCache(cacheDir, type, keepDateKey) {
  try {
    if (!fs.existsSync(cacheDir)) return;
    const safeType = safeCacheKey(type);
    const keepName = `toplist-${safeType}-${keepDateKey}.json`;
    const prefix = `toplist-${safeType}-`;
    for (const name of fs.readdirSync(cacheDir)) {
      if (name.startsWith(prefix) && name.endsWith('.json') && name !== keepName) {
        fs.unlinkSync(path.join(cacheDir, name));
      }
    }
  } catch (error) {
    console.warn('[express-backend] toplist cache prune failed:', error.message);
  }
}

function readToplistCacheFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return payload && payload.code === 200 && Array.isArray(payload.data) ? payload : null;
  } catch {
    return null;
  }
}

function toplistCacheFile(cacheDir, type, dateKey) {
  return path.join(cacheDir, `toplist-${safeCacheKey(type)}-${dateKey}.json`);
}

function localDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function safeCacheKey(value) {
  return String(value || 'soaring').replace(/[^a-z0-9_-]/gi, '_');
}

async function resolvePlayableToplistSongs(items, dispatcher) {
  const resolvedItems = await mapWithConcurrency(items, 8, async (item, index) => {
    const song = item.data || item;
    const name = stringValue(song.songname || song.name);
    const artists = (song.singer || song.singers || []).map((artist) => artist.name).filter(Boolean);
    if (!name) return null;

    const resolved = await resolvePlayableSong(name, artists, dispatcher);
    if (!resolved) return null;
    return {
      ...resolved,
      rank: index + 1,
      original_title: name,
      original_artist: artists.join(' / ')
    };
  });
  return resolvedItems.filter(Boolean).slice(0, 50);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolvePlayableSong(name, artists, dispatcher) {
  const keyword = [name, artists[0] || ''].filter(Boolean).join(' ');
  for (const source of ['kuwo', 'netease']) {
    const candidates = await searchMusicApi(source, keyword, dispatcher);
    const matched = chooseBestSongMatch(candidates, name, artists);
    if (matched) return matched;
  }
  return null;
}

async function searchMusicApi(source, keyword, dispatcher) {
  if (dispatcher) {
    return dispatcher.search(source, keyword, 5);
  }

  try {
    const response = await axios.get('https://music-api.gdstudio.xyz/api.php', {
      timeout: 8_000,
      params: {
        types: 'search',
        source,
        name: keyword,
        count: 5
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://music.xcloudv.top/'
      }
    });
    return Array.isArray(response.data) ? response.data : response.data?.data || [];
  } catch {
    return [];
  }
}

function chooseBestSongMatch(candidates, name, artists) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const normalizedName = normalizeMatchText(name);
  const normalizedArtists = artists.map(normalizeMatchText).filter(Boolean);
  return candidates.find((candidate) => {
    const candidateName = normalizeMatchText(candidate.name);
    const candidateArtists = artistList(candidate.artist).map(normalizeMatchText);
    const titleMatches = candidateName === normalizedName || candidateName.includes(normalizedName) || normalizedName.includes(candidateName);
    const artistMatches = !normalizedArtists.length || normalizedArtists.some((artist) => candidateArtists.some((candidateArtist) => candidateArtist.includes(artist) || artist.includes(candidateArtist)));
    return titleMatches && artistMatches;
  }) || candidates[0];
}

function artistList(value) {
  if (Array.isArray(value)) return value;
  return normalizeArtist(value).split(/[,/&、]/).map((artist) => artist.trim()).filter(Boolean);
}

function normalizeMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[（(].*?[）)]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

async function handleNeteasePlaylist(req, res) {
  let playlistId = stringValue(req.query.id);
  const link = stringValue(req.query.link);
  if (!playlistId && link) {
    playlistId = extractPlaylistId(link);
  }

  if (!playlistId || !/^\d+$/.test(playlistId)) {
    return res.json({ code: 400, message: '无法识别的歌单链接或ID', playlist: null });
  }

  try {
    const response = await axios.get(`https://music.163.com/api/playlist/detail?id=${playlistId}`, {
      timeout: 15_000,
      headers: neteaseHeaders()
    });
    const result = response.data?.result;
    if (!result) return res.json({ code: 500, message: '歌单数据为空', playlist: null });

    const tracks = (result.tracks || []).map((track) => ({
      id: String(track.id),
      name: track.name,
      artist: (track.artists || []).map((artist) => artist.name),
      album: track.album?.name || '',
      pic_id: track.album?.picId ? String(track.album.picId) : '',
      source: 'netease'
    }));

    return res.json({
      code: 200,
      playlist: {
        id: String(result.id),
        name: result.name || '未知歌单',
        cover: result.coverImgUrl || '',
        description: result.description || '',
        track_count: tracks.length,
        tracks
      }
    });
  } catch {
    return res.json({ code: 500, message: '获取歌单失败', playlist: null });
  }
}

function handleApiDoubtful(db, res) {
  const rows = db.prepare('SELECT source, name, search, play, last_check FROM api_status').all();
  const result = {};
  for (const row of rows) {
    result[row.source] = {
      name: row.name,
      search: row.search,
      play: row.play,
      last_check: row.last_check
    };
  }
  return res.json(result);
}

async function handleOfflineAudio(req, res, offlineCache, options = {}) {
  if (!offlineCache) return res.status(404).json({ success: false, message: '离线缓存未启用' });

  const key = stringValue(req.params.key);
  const track = offlineCache.getTrackByKey(key);
  if (!track || track.status !== 'downloaded' || !track.file_path || !fs.existsSync(track.file_path)) {
    return res.status(404).json({ success: false, message: '离线音频不存在' });
  }

  let filePath = track.file_path;
  let contentType = track.content_type || 'audio/mpeg';
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('offline audio path is not a file');
  } catch {
    return res.status(404).json({ success: false, message: '离线音频不存在' });
  }

  const requestedFormat = stringValue(options.format || req.query.format).toLowerCase();
  if (requestedFormat === 'alac' && isIosIncompatibleLosslessTrack(track)) {
    const converted = await ensureIosLosslessAudio(track, {
      converter: options.iosLosslessConverter
    });
    filePath = converted.filePath;
    contentType = converted.contentType;
    stat = converted.stat;
    res.setHeader('X-Offline-Transcode', converted.cached ? 'alac-cache' : 'alac-created');
  }

  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

  if (!range) {
    res.setHeader('Content-Length', stat.size);
    pipeAudioFile(res, filePath);
    return;
  }

  const parsed = parseRangeHeader(range, stat.size);
  if (!parsed) {
    res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
    res.end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${parsed.start}-${parsed.end}/${stat.size}`);
  res.setHeader('Content-Length', parsed.end - parsed.start + 1);
  pipeAudioFile(res, filePath, parsed);
}

function pipeAudioFile(res, filePath, options) {
  const stream = fs.createReadStream(filePath, options);
  stream.on('error', (error) => {
    console.warn('[express-backend] offline audio stream failed:', error.message);
    if (!res.headersSent) {
      res.status(error.code === 'ENOENT' ? 404 : 500).end();
      return;
    }
    res.destroy(error);
  });
  stream.pipe(res);
}

async function proxyMusicApi(req, res, cacheDir, dispatcher, offlineCache, options = {}) {
  // The server owns music API caching and reports it through X-Cache. Browser
  // and intermediary caches must not pin stale provider metadata or signed URLs.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  const apiQuery = normalizeMusicApiQuery(req);

  if (apiQuery.types === 'url' && offlineCache) {
    const track = offlineCache.getPlayableTrack(apiQuery.source || 'netease', apiQuery.id);
    if (track && shouldServeIosLosslessAudio(req, apiQuery, track)) {
      res.setHeader('X-Cache', 'OFFLINE-ALAC');
      res.setHeader('X-Music-Source', 'offline');
      res.setHeader('X-Playback-Compatibility', 'ios-alac');
      warmIosLosslessAudio(track, { converter: options.iosLosslessConverter });
      res.json({
        url: iosLosslessAudioUrl(track),
        br: track.br || Number(apiQuery.br) || 999,
        size: track.size || 0,
        offline: true,
        verified_audio: true,
        content_type: IOS_LOSSLESS_CONTENT_TYPE,
        lossless: true,
        codec: 'alac'
      });
      return;
    }
    if (track && !shouldSkipOfflineTrack(req, track, apiQuery)) {
      res.setHeader('X-Cache', 'OFFLINE');
      res.setHeader('X-Music-Source', 'offline');
      res.json({
        url: offlineAudioUrl(track),
        br: track.br || Number(apiQuery.br) || 999,
        size: track.size || 0,
        offline: true,
        ...offlineTrackAudioMetadata(track)
      });
      return;
    }
    if (track && shouldSkipOfflineTrack(req, track, apiQuery)) {
      res.setHeader('X-Offline-Skip', 'ios-incompatible-audio');
    }
  }

  const query = new URLSearchParams(apiQuery).toString();
  const cacheKey = crypto.createHash('sha256').update(`${MUSIC_API_CACHE_VERSION}:${query}`).digest('hex');
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);
  const cacheTtl = cacheTtlForType(apiQuery.types);

  // Check in-memory cache first
  const memCached = memCacheGet(cacheKey);
  if (memCached) {
    res.setHeader('X-Cache', 'MEM-HIT');
    res.type('json').send(memCached);
    return;
  }

  // Check file cache
  const cachedBody = readFreshCacheFile(cacheFile, cacheTtl);
  if (cachedBody != null) {
    memCacheSet(cacheKey, cachedBody, cacheTtl);
    res.setHeader('X-Cache', 'HIT');
    res.type('json').send(cachedBody);
    return;
  }

  // Deduplicate identical concurrent requests
  if (inflightRequests.has(cacheKey)) {
    try {
      const body = await inflightRequests.get(cacheKey);
      res.setHeader('X-Cache', 'DEDUP');
      res.type('json').send(body);
      return;
    } catch {
      // Fall through to make a new request
    }
  }

  // Wrap actual fetch in a dedup promise
  const fetchPromise = (async () => {
    const upstreamUrl = `https://music-api.gdstudio.xyz/api.php?${query}`;

    if (dispatcher && apiQuery.types) {
      try {
        const params = Object.fromEntries(Object.entries(apiQuery).filter(([key]) => key !== 'types'));
        let result;
        if (apiQuery.types === 'search') {
          const searchResults = await dispatcher.search(
            params.source || 'netease',
            params.name || params.keyword || '',
            Number(params.count) || 30
          );
          if (Array.isArray(searchResults) && searchResults.length) {
            result = {
              ok: true,
              data: JSON.stringify(searchResults),
              contentType: 'application/json',
              providerName: 'dispatcher-search'
            };
          }
        } else {
          result = await dispatcher.proxy(apiQuery.types, params);
        }
        if (result) {
          let body = typeof result === 'string' ? result : result.data;
          const contentType = typeof result === 'string' ? 'application/json' : result.contentType;
          body = await verifyMusicApiUrlBody(body, apiQuery);
          if (typeof body === 'string' && /^[\[{]/.test(body.trim())) {
            fs.writeFileSync(cacheFile, body, 'utf8');
            memCacheSet(cacheKey, body, cacheTtl);
          }
          return { body, contentType: contentType || 'application/json', source: result.providerName || 'dispatcher' };
        }
      } catch (error) {
        console.warn('[proxyMusicApi] dispatcher request failed:', error.message);
      }
    }

    const response = await axios.get(upstreamUrl, {
      timeout: 15_000,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://music.xcloudv.top/'
      },
      transformResponse: [(data) => data]
    });

    const body = await verifyMusicApiUrlBody(response.data, apiQuery);
    if (typeof body === 'string' && /^[\[{]/.test(body.trim())) {
      fs.writeFileSync(cacheFile, body, 'utf8');
      memCacheSet(cacheKey, body, cacheTtl);
    }
    return { body, contentType: response.headers['content-type'] || 'application/json', source: null };
  })();

  const inflightBodyPromise = fetchPromise.then((r) => r.body);
  // The main request awaits `fetchPromise` below and handles failures there.
  // The derived body promise is only for request de-duplication; without an
  // attached rejection handler, a failed upstream fallback can surface as an
  // unhandled rejection and crash Node even though the response path recovers.
  inflightBodyPromise.catch(() => {});
  inflightRequests.set(cacheKey, inflightBodyPromise);

  try {
    const result = await fetchPromise;
    res.setHeader('X-Cache', 'MISS');
    if (result.source) res.setHeader('X-Music-Source', result.source);
    res.type(result.contentType).send(result.body);
  } catch {
    const staleBody = readCacheFile(cacheFile);
    if (staleBody != null) {
      res.setHeader('X-Cache', 'STALE');
      res.type('json').send(staleBody);
      return;
    }
    res.status(503).json({ error: '音乐服务暂时不可用，请稍后重试' });
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

async function verifyMusicApiUrlBody(body, apiQuery) {
  if (apiQuery.types !== 'url' || typeof body !== 'string') return body;

  const parsed = parseJson(body, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;

  const payload = musicApiUrlPayload(parsed);
  const audioUrl = stringValue(payload?.url);
  if (!payload || !audioUrl) return body;

  const metadata = await probeAudioUrl(audioUrl);
  applyVerifiedAudioMetadata(payload, apiQuery, metadata);

  return JSON.stringify(parsed);
}

function musicApiUrlPayload(parsed) {
  if (parsed.url) return parsed;
  if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
    return parsed.data;
  }
  return null;
}

function applyVerifiedAudioMetadata(payload, apiQuery, metadata) {
  const normalizedBr = normalizeAudioBitrate(payload.br || payload.data?.br || apiQuery.br);
  const requestedLossless = isLosslessRequest(apiQuery.br);
  const isLossless = Boolean(metadata.verified && metadata.lossless);

  payload.verified_audio = Boolean(metadata.verified);
  payload.lossless = isLossless;
  if (metadata.verified && metadata.codec) payload.codec = metadata.codec;
  if (metadata.verified && metadata.contentType) payload.content_type = metadata.contentType;

  if (isLossless) {
    payload.br = normalizedBr && normalizedBr >= 900 ? normalizedBr : 999;
    return;
  }

  if (requestedLossless) {
    payload.br = normalizedBr && normalizedBr < 900 ? normalizedBr : 320;
    return;
  }

  if (normalizedBr) payload.br = normalizedBr;
}

function offlineTrackAudioMetadata(track) {
  const metadata = audioMetadataFromContentTypeAndPath(track.content_type, track.file_path);
  return {
    verified_audio: Boolean(metadata.codec),
    content_type: track.content_type || metadata.contentType || '',
    lossless: Boolean(metadata.lossless || isIosIncompatibleLosslessTrack(track)),
    codec: metadata.codec || ''
  };
}

function normalizeMusicApiQuery(req) {
  return { ...req.query };
}

function shouldPreferIosCompatibleAudio(req) {
  const userAgent = stringValue(req.headers['user-agent']).toLowerCase();
  if (!userAgent) return false;
  return /\b(iphone|ipad|ipod)\b/.test(userAgent)
    || (userAgent.includes('macintosh') && userAgent.includes('mobile/'));
}

function shouldServeIosLosslessAudio(req, apiQuery, track) {
  return shouldPreferIosCompatibleAudio(req)
    && isLosslessRequest(apiQuery.br)
    && isIosIncompatibleLosslessTrack(track);
}

function shouldSkipOfflineTrack(req, track, apiQuery) {
  if (!shouldPreferIosCompatibleAudio(req)) return false;
  if (!isIosIncompatibleLosslessTrack(track)) return false;
  return !isLosslessRequest(apiQuery?.br);
}

function isIosIncompatibleLosslessTrack(track) {
  const contentType = stringValue(track.content_type).toLowerCase();
  const filePath = stringValue(track.file_path).toLowerCase();
  return contentType.includes('flac')
    || contentType.includes('wav')
    || filePath.endsWith('.flac')
    || filePath.endsWith('.wav');
}

function iosLosslessAudioUrl(track) {
  return `/offline/audio/${encodeURIComponent(track.cache_key)}/alac.m4a`;
}

function warmIosLosslessAudio(track, options = {}) {
  ensureIosLosslessAudio(track, options).catch((error) => {
    console.warn('[express-backend] iPhone ALAC warmup failed:', error.message);
  });
}

async function ensureIosLosslessAudio(track, { converter = transcodeToAlac } = {}) {
  const sourcePath = track.file_path;
  const outputPath = iosLosslessFilePath(track);
  const sourceStat = fs.statSync(sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error('offline audio source is not a file');
  }

  const cachedStat = readReusableIosLosslessStat(outputPath, sourceStat);
  if (cachedStat) {
    return {
      filePath: outputPath,
      contentType: IOS_LOSSLESS_CONTENT_TYPE,
      stat: cachedStat,
      cached: true
    };
  }

  const inflightKey = `${sourcePath}\n${outputPath}`;
  if (!iosLosslessTranscodes.has(inflightKey)) {
    const transcodePromise = createIosLosslessAudio(sourcePath, outputPath, converter)
      .finally(() => {
        iosLosslessTranscodes.delete(inflightKey);
      });
    iosLosslessTranscodes.set(inflightKey, transcodePromise);
  }

  const stat = await iosLosslessTranscodes.get(inflightKey);
  return {
    filePath: outputPath,
    contentType: IOS_LOSSLESS_CONTENT_TYPE,
    stat,
    cached: false
  };
}

function iosLosslessFilePath(track) {
  const key = stringValue(track.cache_key) || path.basename(track.file_path, path.extname(track.file_path));
  return path.join(path.dirname(track.file_path), `${key}${IOS_LOSSLESS_SUFFIX}`);
}

function readReusableIosLosslessStat(outputPath, sourceStat) {
  try {
    const stat = fs.statSync(outputPath);
    if (stat.isFile() && stat.size > 0 && stat.mtimeMs >= sourceStat.mtimeMs) {
      return stat;
    }
  } catch {}
  return null;
}

async function createIosLosslessAudio(sourcePath, outputPath, converter) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await converter(sourcePath, tempPath);
    const tempStat = fs.statSync(tempPath);
    if (!tempStat.isFile() || tempStat.size <= 0) {
      throw new Error('ALAC conversion produced an empty file');
    }
    await fs.promises.rm(outputPath, { force: true });
    await fs.promises.rename(tempPath, outputPath);
    return fs.statSync(outputPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function transcodeToAlac(sourcePath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
    const child = spawn(ffmpegBin, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      sourcePath,
      '-map',
      '0:a:0',
      '-vn',
      '-c:a',
      'alac',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      outputPath
    ], { windowsHide: true });
    let stderr = '';
    let settled = false;

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (error.code === 'ENOENT') {
        reject(new Error('ffmpeg is required to create iPhone ALAC lossless audio'));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      const details = stderr.trim();
      reject(new Error(`ffmpeg ALAC conversion failed with code ${code}${details ? `: ${details}` : ''}`));
    });
  });
}

function readFreshCacheFile(file, ttlMs) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || Date.now() - stat.mtimeMs >= ttlMs) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readCacheFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function pruneCacheDir(cacheDir, { maxFiles = 800, maxAgeMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
  try {
    if (!fs.existsSync(cacheDir)) return;

    const now = Date.now();
    const files = fs.readdirSync(cacheDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = path.join(cacheDir, name);
        const stat = fs.statSync(file);
        return { file, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const item of files) {
      if (now - item.mtimeMs > maxAgeMs) {
        fs.unlinkSync(item.file);
      }
    }

    const remaining = files.filter((item) => fs.existsSync(item.file));
    const overflow = remaining.length - maxFiles;
    if (overflow <= 0) return;

    for (const item of remaining.slice(0, overflow)) {
      fs.unlinkSync(item.file);
    }
  } catch (error) {
    console.warn('[express-backend] cache prune failed:', error.message);
  }
}

async function pruneCacheDirAsync(cacheDir, opts) {
  try {
    const { promises: fsp } = fs;
    if (!(await fsp.stat(cacheDir).catch(() => null))) return;

    const maxFiles = opts?.maxFiles ?? 800;
    const maxAgeMs = opts?.maxAgeMs ?? 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const entries = await fsp.readdir(cacheDir);
    const files = [];

    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(cacheDir, name);
      try {
        const stat = await fsp.stat(file);
        files.push({ file, mtimeMs: stat.mtimeMs });
      } catch { /* skip */ }
    }

    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const item of files) {
      if (now - item.mtimeMs > maxAgeMs) {
        await fsp.unlink(item.file).catch(() => {});
      }
    }

    const remaining = [];
    for (const item of files) {
      if (await fsp.stat(item.file).catch(() => null)) remaining.push(item);
    }

    const overflow = remaining.length - maxFiles;
    if (overflow <= 0) return;

    for (const item of remaining.slice(0, overflow)) {
      await fsp.unlink(item.file).catch(() => {});
    }
  } catch (error) {
    console.warn('[express-backend] async cache prune failed:', error.message);
  }
}

function ownsPlaylist(db, userId, playlistId) {
  return Boolean(db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId));
}

function scheduleOfflineSync(offlineCache) {
  if (offlineCache) offlineCache.scheduleSync();
}

function parseRangeHeader(range, size) {
  const match = String(range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size <= 0) return null;

  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function listen(server, preferredPort, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const tryListen = (port) => {
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && port < preferredPort + 20) {
          tryListen(port + 1);
          return;
        }
        reject(error);
      });

      server.listen(port, host, () => resolve(port));
    };
    tryListen(preferredPort);
  });
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function logVerificationEmail(dataDir, to, code, purpose) {
  const logFile = path.join(dataDir, 'email_log.txt');
  const line = `${formatDateTime(new Date())} | To: ${to} | Code: ${code} | Purpose: ${purpose}\n`;
  fs.appendFileSync(logFile, line, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(logFile, 0o600);
  } catch {}
}

function extractPlaylistId(value) {
  const match = String(value).match(/[?&]id=(\d+)/) || String(value).match(/playlist\/(\d+)/);
  return match ? match[1] : '';
}

function cacheTtlForType(type) {
  if (type === 'url') return 60_000;
  if (type === 'pic') return 86_400_000;
  if (type === 'lyric') return 604_800_000;
  return 300_000;
}

function neteaseHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://music.163.com/'
  };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isEmail(value) {
  const email = String(value || '');
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

if (require.main === module) {
  let standaloneServer = null;
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.resolve(standaloneServer?.close())
      .catch((error) => {
        console.error('[express-backend] shutdown failed:', error);
        process.exitCode = 1;
      })
      .finally(() => {
        if (signal) process.exit(process.exitCode || 0);
      });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  startLocalBackend().then((server) => {
    standaloneServer = server;
    console.log(`music Express backend running at ${server.url}`);
    console.log(`SQLite database: ${server.dbPath}`);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  startLocalBackend,
  createExpressApp,
  handleMediaArtwork,
  isAllowedArtworkHost,
  parseAllowedArtworkUrl,
  processArtworkImage
};
