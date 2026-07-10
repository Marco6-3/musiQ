'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

const TOKEN_EXPIRY_SECONDS = 86400 * 30;
const CODE_EXPIRY_SECONDS = 600;
const PERSIST_DEBOUNCE_MS = 500;
const LOCK_OWNER_APP = 'music-sqljs-datastore';
const LOCK_TIME_TOLERANCE_MS = 10_000;
let tokenSecret = process.env.MUSIC_TOKEN_SECRET || process.env.MUSIQ_TOKEN_SECRET || process.env.XCLOUD_TOKEN_SECRET || '';
let sqlJsPromise;

async function createDataStore(dataDir, { migrateFromDataDir = '' } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const releaseLock = acquireDataStoreLock(dataDir);
  try {
    const dbPath = resolveDataFile(dataDir, 'music.db', 'musiq.db', 'xcloud_music.db');
    const SQL = await loadSqlJs();
    const migrationSource = findMigrationSource(SQL, dbPath, dataDir, migrateFromDataDir);
    if (migrationSource) {
      fs.copyFileSync(migrationSource, dbPath);
      syncTokenSecretFromDataDir(dataDir, path.dirname(migrationSource));
    }
    ensureTokenSecret(dataDir);
    const db = new PersistentSqlJsDatabase(SQL, dbPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('foreign_keys = ON');
    initDb(db);

    return {
      db,
      dbPath,
      dataDir,
      close: () => {
        try {
          db.close();
        } finally {
          releaseLock();
        }
      }
    };
  } catch (error) {
    releaseLock();
    throw error;
  }
}

function loadSqlJs() {
  if (!sqlJsPromise) {
    const wasmDir = path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist');
    sqlJsPromise = initSqlJs({
      locateFile: (file) => path.join(wasmDir, file)
    });
  }
  return sqlJsPromise;
}

function resolveDataFile(dataDir, fileName, ...legacyFileNames) {
  const dbPath = path.join(dataDir, fileName);
  if (fs.existsSync(dbPath)) {
    return dbPath;
  }

  for (const legacyFileName of legacyFileNames) {
    const legacyPath = path.join(dataDir, legacyFileName);
    if (fs.existsSync(legacyPath)) {
      fs.copyFileSync(legacyPath, dbPath);
      break;
    }
  }
  return dbPath;
}

function findMigrationSource(SQL, targetDbPath, targetDataDir, legacyDataDir) {
  if (getUserCount(SQL, targetDbPath) > 0) return null;

  const legacyDirs = [];
  const normalizedTarget = path.resolve(targetDataDir);
  if (legacyDataDir) legacyDirs.push(path.resolve(legacyDataDir));
  if (normalizedTarget && !legacyDirs.includes(normalizedTarget)) legacyDirs.push(normalizedTarget);

  for (const dataDir of legacyDirs) {
    for (const dbName of ['music.db', 'musiq.db', 'xcloud_music.db']) {
      const candidate = path.join(dataDir, dbName);
      if (path.resolve(candidate) === path.resolve(targetDbPath)) continue;
      if (getUserCount(SQL, candidate) > 0) return candidate;
    }
  }

  return null;
}

function getUserCount(SQL, dbPath) {
  if (!fs.existsSync(dbPath)) return 0;
  let db;
  try {
    db = new SQL.Database(fs.readFileSync(dbPath));
    const rows = db.exec('SELECT COUNT(*) AS count FROM users');
    if (!rows.length) return 0;
    const count = rows[0].values[0]?.[0];
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
  } finally {
    if (db) db.close();
  }
}

function syncTokenSecretFromDataDir(targetDataDir, sourceDataDir) {
  const targetFile = path.join(targetDataDir, 'token-secret');
  const sourceFile = path.join(sourceDataDir, 'token-secret');
  if (fs.existsSync(targetFile) || !fs.existsSync(sourceFile)) return;

  fs.copyFileSync(sourceFile, targetFile);
  tokenSecret = '';
}

class PersistentSqlJsDatabase {
  constructor(SQL, dbPath) {
    this.dbPath = dbPath;
    this.transactionDepth = 0;
    this.dirty = false;
    this.persistTimer = null;
    this.closed = false;
    const bytes = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
    this.raw = bytes && bytes.length ? new SQL.Database(bytes) : new SQL.Database();
  }

  exec(sql) {
    const result = this.raw.run(sql);
    this.persistIfNeeded(sql);
    return result;
  }

  prepare(sql) {
    return new SqlJsStatement(this, sql);
  }

  pragma(sql) {
    this.raw.run(`PRAGMA ${sql}`);
    this.persistIfNeeded(`PRAGMA ${sql}`);
  }

  transaction(fn) {
    return (...args) => {
      if (this.transactionDepth > 0) {
        return fn(...args);
      }

      this.raw.run('BEGIN IMMEDIATE');
      this.transactionDepth += 1;
      let committed = false;
      try {
        const result = fn(...args);
        this.raw.run('COMMIT');
        committed = true;
        this.markDirty();
        this.flushPersist();
        return result;
      } catch (error) {
        if (!committed) {
          try {
            this.raw.run('ROLLBACK');
          } catch (rollbackError) {
            if (error && typeof error === 'object') {
              error.rollbackError = rollbackError;
            } else {
              console.warn('[database] transaction rollback failed:', rollbackError.message);
            }
          }
        }
        throw error;
      } finally {
        this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      }
    };
  }

  persistIfNeeded(sql) {
    if (this.transactionDepth > 0) return;
    if (!isWriteSql(sql)) return;
    this.markDirty();
    this.schedulePersist();
  }

  persist() {
    this.markDirty();
    this.flushPersist();
  }

  markDirty() {
    this.dirty = true;
  }

  schedulePersist() {
    if (this.closed || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.flushPersist();
      } catch (error) {
        console.error('[database] sql.js persist failed:', error);
      }
    }, PERSIST_DEBOUNCE_MS);
    if (this.persistTimer.unref) this.persistTimer.unref();
  }

  flushPersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const data = Buffer.from(this.raw.export());
    const tempPath = `${this.dbPath}.tmp`;
    fs.writeFileSync(tempPath, data);
    this._renameWithRetry(tempPath, this.dbPath);
    this.dirty = false;
  }

  _renameWithRetry(src, dst, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        fs.renameSync(src, dst);
        return;
      } catch (error) {
        if (error.code === 'EBUSY' && i < retries - 1) {
          // Windows Defender or other file scanners may briefly lock the file.
          const start = Date.now();
          while (Date.now() - start < 50) { /* busy-wait 50ms */ }
        } else {
          throw error;
        }
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.flushPersist();
    } finally {
      this.raw.close();
    }
  }
}

class SqlJsStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  run(...params) {
    const statement = this.db.raw.prepare(this.sql);
    try {
      statement.run(flattenParams(params));
      this.db.persistIfNeeded(this.sql);
      return { changes: this.db.raw.getRowsModified(), lastInsertRowid: this.lastInsertRowid() };
    } finally {
      statement.free();
    }
  }

  get(...params) {
    const statement = this.db.raw.prepare(this.sql);
    try {
      statement.bind(flattenParams(params));
      return statement.step() ? statement.getAsObject() : undefined;
    } finally {
      statement.free();
    }
  }

  all(...params) {
    const statement = this.db.raw.prepare(this.sql);
    const rows = [];
    try {
      statement.bind(flattenParams(params));
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  lastInsertRowid() {
    const rows = this.db.raw.exec('SELECT last_insert_rowid() AS id');
    return rows[0]?.values?.[0]?.[0] ?? 0;
  }
}

function flattenParams(params) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

function isWriteSql(sql) {
  const firstToken = String(sql || '').trim().split(/\s+/, 1)[0]?.toUpperCase();
  return ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER', 'PRAGMA'].includes(firstToken);
}

function acquireDataStoreLock(dataDir) {
  const lockPath = path.join(dataDir, 'music.lock');

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify(createLockOwner(dataDir)));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const owner = readLockOwner(lockPath);
      if (isLockOwnerActive(owner, dataDir)) {
        throw new Error(`SQLite data directory is already in use by process ${owner.pid}: ${dataDir}`);
      }

      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
}

function createLockOwner(dataDir) {
  return {
    app: LOCK_OWNER_APP,
    pid: process.pid,
    created_at: formatDateTime(new Date()),
    data_dir: path.resolve(dataDir),
    exec_path: process.execPath,
    argv: process.argv,
    process_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString()
  };
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return {};
  }
}

function isLockOwnerActive(owner, dataDir) {
  const pid = Number(owner?.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!isProcessAlive(pid)) return false;

  const processInfo = readProcessInfo(pid);
  if (!processInfo) return true;

  if (owner.data_dir && path.resolve(owner.data_dir) !== path.resolve(dataDir)) {
    return false;
  }

  if (hasLockOwnerIdentity(owner)) {
    return processMatchesLockOwner(owner, processInfo);
  }

  return processCouldOwnLegacyLock(owner, processInfo);
}

function hasLockOwnerIdentity(owner) {
  return Boolean(
    owner?.app
    || owner?.process_started_at
    || owner?.exec_path
    || Array.isArray(owner?.argv)
  );
}

function processMatchesLockOwner(owner, processInfo) {
  if (owner.app && owner.app !== LOCK_OWNER_APP) return false;
  if (lockWasCreatedBeforeProcessStarted(owner.process_started_at, processInfo.startedAt)) return false;

  const ownerExec = normalizeProcessText(owner.exec_path);
  const actualExec = normalizeProcessText(processInfo.executablePath);
  if (ownerExec && actualExec && ownerExec !== actualExec) return false;

  const commandLine = normalizeProcessText(processInfo.commandLine);
  const ownerArgs = Array.isArray(owner.argv) ? owner.argv.map(normalizeProcessText).filter(Boolean) : [];
  const strongArgs = ownerArgs.slice(1).filter((arg) => (
    path.isAbsolute(arg)
    || arg.includes('.asar')
    || arg.endsWith('.js')
    || arg.includes('src\\server\\index.js')
  ));

  if (commandLine && strongArgs.length && !strongArgs.some((arg) => commandLine.includes(arg))) {
    return false;
  }

  return true;
}

function processCouldOwnLegacyLock(owner, processInfo) {
  if (lockWasCreatedBeforeProcessStarted(owner?.created_at, processInfo.startedAt)) return false;

  const processText = normalizeProcessText([
    processInfo.name,
    processInfo.executablePath,
    processInfo.commandLine
  ].filter(Boolean).join(' '));

  return /(^|[\\\s"'])(node|electron|music|musiq|xcloud)(\.exe)?($|[\\\s"'])/.test(processText);
}

function lockWasCreatedBeforeProcessStarted(lockTime, processStartedAt) {
  const lockTimeMs = parseLockTime(lockTime);
  const processStartedMs = Date.parse(processStartedAt || '');
  return Number.isFinite(lockTimeMs)
    && Number.isFinite(processStartedMs)
    && processStartedMs - lockTimeMs > LOCK_TIME_TOLERANCE_MS;
}

function parseLockTime(value) {
  if (!value) return Number.NaN;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    const [, year, month, day, hour, minute, second] = match.map(Number);
    return new Date(year, month - 1, day, hour, minute, second).getTime();
  }
  return Date.parse(value);
}

function normalizeProcessText(value) {
  return String(value || '').replace(/\0/g, ' ').replace(/\//g, '\\').toLowerCase();
}

function readProcessInfo(pid) {
  if (process.platform === 'win32') return readWindowsProcessInfo(pid);
  return readProcProcessInfo(pid) || readPosixProcessInfo(pid);
}

function readWindowsProcessInfo(pid) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"`,
    'if ($p) {',
    '  [pscustomobject]@{',
    '    Name = $p.Name',
    '    ExecutablePath = $p.ExecutablePath',
    '    CommandLine = $p.CommandLine',
    "    StartedAt = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { $null }",
    '  } | ConvertTo-Json -Compress',
    '}'
  ].join('\n');

  try {
    const output = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true
    }).trim().replace(/^\uFEFF/, '');
    if (!output) return null;
    const info = JSON.parse(output);
    return {
      name: info.Name || '',
      executablePath: info.ExecutablePath || '',
      commandLine: info.CommandLine || '',
      startedAt: info.StartedAt || ''
    };
  } catch {
    return null;
  }
}

function readProcProcessInfo(pid) {
  try {
    const procDir = path.join('/proc', String(pid));
    const commandLine = fs.readFileSync(path.join(procDir, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
    let executablePath = '';
    let name = '';
    try {
      executablePath = fs.readlinkSync(path.join(procDir, 'exe'));
      name = path.basename(executablePath);
    } catch {
      name = fs.readFileSync(path.join(procDir, 'comm'), 'utf8').trim();
    }
    return { name, executablePath, commandLine, startedAt: '' };
  } catch {
    return null;
  }
}

function readPosixProcessInfo(pid) {
  const args = ['-p', String(pid)];
  const options = {
    encoding: 'utf8',
    timeout: 3_000
  };

  try {
    const commandLine = childProcess.execFileSync('ps', [...args, '-o', 'command='], options).trim();
    if (!commandLine) return null;

    const name = childProcess.execFileSync('ps', [...args, '-o', 'comm='], options).trim();
    const startedText = childProcess.execFileSync('ps', [...args, '-o', 'lstart='], options).trim();
    const startedMs = Date.parse(startedText);
    return {
      name: name || path.basename(commandLine.split(/\s+/, 1)[0] || ''),
      executablePath: '',
      commandLine,
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : ''
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function ensureTokenSecret(dataDir) {
  if (tokenSecret) return tokenSecret;

  const secretFile = path.join(dataDir, 'token-secret');
  try {
    if (fs.existsSync(secretFile)) {
      tokenSecret = fs.readFileSync(secretFile, 'utf8').trim();
    }

    if (!tokenSecret) {
      tokenSecret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(secretFile, tokenSecret, { encoding: 'utf8', mode: 0o600 });
    }
  } catch {
    tokenSecret = crypto.randomBytes(32).toString('hex');
  }

  return tokenSecret;
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT DEFAULT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      verification_code TEXT DEFAULT NULL,
      code_expires_at INTEGER DEFAULT NULL,
      email_verified INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      song_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'netease',
      name TEXT DEFAULT NULL,
      artist TEXT DEFAULT NULL,
      album TEXT DEFAULT NULL,
      pic_id TEXT DEFAULT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(user_id, song_id, source)
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS playlist_songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      song_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'netease',
      name TEXT DEFAULT NULL,
      artist TEXT DEFAULT NULL,
      album TEXT DEFAULT NULL,
      pic_id TEXT DEFAULT NULL,
      original_title TEXT DEFAULT NULL,
      original_artist TEXT DEFAULT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(playlist_id, song_id, source)
    );

    CREATE TABLE IF NOT EXISTS api_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      search TEXT DEFAULT 'true',
      play TEXT DEFAULT 'true',
      last_check TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS offline_tracks (
      cache_key TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'netease',
      name TEXT DEFAULT NULL,
      artist TEXT DEFAULT NULL,
      album TEXT DEFAULT NULL,
      pic_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      file_path TEXT DEFAULT NULL,
      content_type TEXT DEFAULT NULL,
      br INTEGER DEFAULT NULL,
      size INTEGER DEFAULT NULL,
      error TEXT DEFAULT NULL,
      attempts INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      downloaded_at INTEGER DEFAULT NULL,
      UNIQUE(song_id, source)
    );

    CREATE TABLE IF NOT EXISTS user_sync_state (
      user_id INTEGER PRIMARY KEY,
      queue_json TEXT DEFAULT '[]',
      client_state_json TEXT DEFAULT '{}',
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS agent_usage (
      user_id INTEGER NOT NULL,
      usage_date TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY(user_id, usage_date)
    );
  `);
  const now = formatDateTime(new Date());
  const insertStatus = db.prepare(`
    INSERT OR IGNORE INTO api_status (source, name, search, play, last_check)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertStatus.run('netease', '网易云音乐', 'true', 'true', now);
  insertStatus.run('kuwo', '酷我音乐', 'true', 'true', now);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;

  const parts = String(storedHash).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, salt, expected] = parts;
  const actual = crypto.scryptSync(String(password), salt, 32);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(expectedBuffer, actual);
}

function generateToken(userId) {
  const time = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ uid: Number(userId), iat: time, exp: time + TOKEN_EXPIRY_SECONDS });
  const signature = crypto.createHmac('sha256', tokenSecret || ensureTokenSecret(process.cwd())).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64')}.${signature}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;

  const payload = Buffer.from(parts[0], 'base64').toString('utf8');
  const expected = crypto.createHmac('sha256', tokenSecret || ensureTokenSecret(process.cwd())).update(payload).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(parts[1]);
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    return null;
  }

  try {
    const data = JSON.parse(payload);
    if (!data || data.exp < Math.floor(Date.now() / 1000)) return null;
    return Number(data.uid) || null;
  } catch {
    return null;
  }
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function publicUser(db, userId) {
  const user = db.prepare(`
    SELECT id, username, email, avatar, created_at, email_verified
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    created_at: user.created_at,
    email_verified: user.email_verified
  };
}

function userWithCollections(db, userId) {
  const user = publicUser(db, userId);
  if (!user) return null;

  return {
    ...user,
    favorites: getUserFavorites(db, userId),
    playlists: getUserPlaylistsObject(db, userId),
    sync_state: getUserSyncState(db, userId)
  };
}

function getUserFavorites(db, userId) {
  return db.prepare(`
    SELECT song_id AS id, source, name, artist, album, pic_id
    FROM favorites
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
}

function getUserPlaylistsObject(db, userId) {
  const playlists = db.prepare(`
    SELECT id, name, created_at
    FROM playlists
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);

  const songsStmt = db.prepare(`
    SELECT song_id AS id, source, name, artist, album, pic_id, original_title, original_artist
    FROM playlist_songs
    WHERE playlist_id = ?
    ORDER BY created_at DESC
  `);

  const result = {};
  for (const playlist of playlists) {
    result[playlist.name] = songsStmt.all(playlist.id);
  }
  return result;
}

function getUserPlaylistsArray(db, userId) {
  const object = getUserPlaylistsObject(db, userId);
  return Object.entries(object).map(([name, songs]) => ({
    name,
    songs,
    song_count: songs.length
  }));
}

function getUserSyncState(db, userId) {
  const row = db.prepare(`
    SELECT queue_json, client_state_json, updated_at
    FROM user_sync_state
    WHERE user_id = ?
  `).get(userId);

  if (!row) {
    return {
      queue: [],
      client_state: {},
      updated_at: 0
    };
  }

  return {
    queue: parseJson(row.queue_json, []),
    client_state: parseJson(row.client_state_json, {}),
    updated_at: Number(row.updated_at || 0)
  };
}

function setUserSyncState(db, userId, { queue, client_state: clientState } = {}) {
  const current = getUserSyncState(db, userId);
  const nextQueue = Array.isArray(queue) ? queue : current.queue;
  const nextClientState = clientState && typeof clientState === 'object' && !Array.isArray(clientState)
    ? clientState
    : current.client_state;
  const updatedAt = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO user_sync_state (user_id, queue_json, client_state_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      queue_json = excluded.queue_json,
      client_state_json = excluded.client_state_json,
      updated_at = excluded.updated_at
  `).run(
    Number(userId),
    JSON.stringify(nextQueue),
    JSON.stringify(nextClientState),
    updatedAt
  );

  return {
    queue: nextQueue,
    client_state: nextClientState,
    updated_at: updatedAt
  };
}

function ensurePlaylist(db, userId, name) {
  const playlistName = String(name || '').trim();
  if (!playlistName) return null;

  db.prepare('INSERT OR IGNORE INTO playlists (user_id, name) VALUES (?, ?)').run(userId, playlistName);
  return db.prepare('SELECT id, name FROM playlists WHERE user_id = ? AND name = ?').get(userId, playlistName);
}

function songFromBody(body) {
  return {
    id: stringValue(body.song_id || body.id),
    source: stringValue(body.source || 'netease'),
    name: stringValue(body.song_title || body.song_name || body.name || body.title),
    artist: normalizeArtist(body.song_artist || body.artist),
    album: stringValue(body.album),
    pic_id: stringValue(body.song_cover || body.pic_id || body.pic),
    original_title: stringValue(body.original_title || body.original_name),
    original_artist: stringValue(body.original_artist)
  };
}

function insertPlaylistSong(db, playlistId, song) {
  db.prepare(`
    INSERT OR IGNORE INTO playlist_songs
      (playlist_id, song_id, source, name, artist, album, pic_id, original_title, original_artist)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    playlistId,
    song.id,
    song.source || 'netease',
    song.name || '',
    song.artist || '',
    song.album || '',
    song.pic_id || '',
    song.original_title || '',
    song.original_artist || ''
  );
}

function normalizeArtist(value) {
  if (Array.isArray(value)) return value.join(', ');
  return stringValue(value);
}

function stringValue(value) {
  return String(value ?? '').trim();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value ?? ''));
  } catch {
    return fallback;
  }
}

function formatDateTime(date) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

module.exports = {
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
  getUserSyncState,
  setUserSyncState,
  ensurePlaylist,
  songFromBody,
  insertPlaylistSong,
  parseJson,
  stringValue,
  normalizeArtist,
  formatDateTime
};
