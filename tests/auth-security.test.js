'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const test = require('node:test');

const { createDataStore, generateToken, hashPassword } = require('../src/server/database');
const { createExpressApp, processArtworkImage } = require('../src/server/index');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'music-auth-test-'));
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function startAuthApp(appOptions = {}) {
  const dataDir = createTempDir();
  const uploadsDir = path.join(dataDir, 'uploads', 'avatars');
  const cacheDir = path.join(dataDir, 'cache');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const store = await createDataStore(dataDir);
  const app = createExpressApp({
    store,
    uploadsDir,
    cacheDir,
    dispatcher: {
      async search() {
        return [{ id: 'cache-test', name: '缓存测试', artist: 'music', source: 'netease' }];
      },
      async proxy() {
        throw new Error('music provider should not be called during auth tests');
      }
    },
    ...appOptions
  });
  const server = http.createServer(app);
  const baseUrl = await listen(server);
  return { baseUrl, cacheDir, dataDir, server, store };
}

function closeAuthApp(ctx) {
  if (!ctx) return;
  ctx.server?.close();
  ctx.store?.close();
  removeTempDir(ctx.dataDir);
}

async function postForm(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams(body)
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after') || '',
    body: await response.json()
  };
}

function insertUser(db, { username, email, password = 'CorrectPass123', verified = 1 }) {
  db.prepare(`
    INSERT INTO users (username, email, password_hash, email_verified)
    VALUES (?, ?, ?, ?)
  `).run(username, email, hashPassword(password), verified);
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

function latestCode(dataDir, target) {
  const logFile = path.join(dataDir, 'email_log.txt');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).reverse();
  const line = lines.find((item) => item.includes(`To: ${target}`));
  assert.ok(line, `missing verification code for ${target}`);
  const match = line.match(/Code: (\d{6})/);
  assert.ok(match, `missing code in ${line}`);
  return match[1];
}

test('verify_token requires a valid token and rejects user_id-only restore', async () => {
  let ctx;
  try {
    ctx = await startAuthApp();
    const userId = insertUser(ctx.store.db, {
      username: 'token_user',
      email: 'token@example.test'
    });

    const userIdOnly = await postForm(ctx.baseUrl, '/php/verify_token.php', { user_id: String(userId) });
    assert.equal(userIdOnly.status, 200);
    assert.equal(userIdOnly.body.success, false);

    const token = generateToken(userId);
    const valid = await postForm(ctx.baseUrl, '/php/verify_token.php', { token, user_id: String(userId) });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.success, true);
    assert.equal(valid.body.user.username, 'token_user');

    const mismatched = await postForm(ctx.baseUrl, '/php/verify_token.php', { token, user_id: String(userId + 1) });
    assert.equal(mismatched.status, 200);
    assert.equal(mismatched.body.success, false);
  } finally {
    closeAuthApp(ctx);
  }
});

test('login uses generic errors and temporarily locks an account after repeated failures', async () => {
  let ctx;
  try {
    ctx = await startAuthApp();
    insertUser(ctx.store.db, {
      username: 'login_user',
      email: 'login@example.test'
    });
    insertUser(ctx.store.db, {
      username: 'unverified_user',
      email: 'unverified@example.test',
      verified: 0
    });

    const unknown = await postForm(ctx.baseUrl, '/php/login.php', {
      username: 'missing_user',
      password: 'WrongPass123'
    });
    assert.equal(unknown.body.success, false);
    assert.equal(unknown.body.message, '用户名或密码错误');

    const unverified = await postForm(ctx.baseUrl, '/php/login.php', {
      username: 'unverified_user',
      password: 'CorrectPass123'
    });
    assert.equal(unverified.body.success, false);
    assert.equal(unverified.body.message, '用户名或密码错误');
    assert.equal('email' in unverified.body, false);
    assert.equal('need_email_verification' in unverified.body, false);

    for (let i = 0; i < 6; i += 1) {
      const failed = await postForm(ctx.baseUrl, '/php/login.php', {
        username: 'login_user',
        password: `WrongPass${i}`
      });
      assert.equal(failed.status, 200);
      assert.equal(failed.body.success, false);
    }

    const locked = await postForm(ctx.baseUrl, '/php/login.php', {
      username: 'login_user',
      password: 'CorrectPass123'
    });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.success, false);
    assert.match(locked.body.message, /登录尝试过多/);
    assert.notEqual(locked.retryAfter, '');
  } finally {
    closeAuthApp(ctx);
  }
});

test('verification code sending is rate-limited per email and hides registered-email state', async () => {
  let ctx;
  try {
    ctx = await startAuthApp();
    insertUser(ctx.store.db, {
      username: 'existing_user',
      email: 'existing@example.test'
    });

    const existing = await postForm(ctx.baseUrl, '/php/register_verification.php', {
      email: 'existing@example.test'
    });
    assert.equal(existing.status, 200);
    assert.equal(existing.body.success, true);
    assert.match(existing.body.message, /验证码已发送/);
    assert.equal(fs.existsSync(path.join(ctx.dataDir, 'email_log.txt')), false);

    for (let i = 0; i < 3; i += 1) {
      const sent = await postForm(ctx.baseUrl, '/php/register_verification.php', {
        email: 'new@example.test'
      });
      assert.equal(sent.status, 200);
      assert.equal(sent.body.success, true);
    }

    const limited = await postForm(ctx.baseUrl, '/php/register_verification.php', {
      email: 'new@example.test'
    });
    assert.equal(limited.status, 429);
    assert.match(limited.body.message, /验证码请求过于频繁/);
  } finally {
    closeAuthApp(ctx);
  }
});

test('registration rejects common weak passwords after a valid verification code', async () => {
  let ctx;
  try {
    ctx = await startAuthApp();
    const email = 'weak-password@example.test';
    const sent = await postForm(ctx.baseUrl, '/php/register_verification.php', { email });
    assert.equal(sent.body.success, true);
    const code = latestCode(ctx.dataDir, email);

    const weak = await postForm(ctx.baseUrl, '/php/register.php', {
      username: 'weak_user',
      email,
      verification_code: code,
      password: '12345678'
    });
    assert.equal(weak.status, 200);
    assert.equal(weak.body.success, false);
    assert.match(weak.body.message, /8-128/);

    const strong = await postForm(ctx.baseUrl, '/php/register.php', {
      username: 'strong_user',
      email,
      verification_code: code,
      password: 'BetterPass123'
    });
    assert.equal(strong.status, 200);
    assert.equal(strong.body.success, true);
    assert.equal(strong.body.user.username, 'strong_user');
  } finally {
    closeAuthApp(ctx);
  }
});

test('password reset uses email verification only', async () => {
  let ctx;
  try {
    ctx = await startAuthApp();
    const email = 'reset@example.test';
    insertUser(ctx.store.db, {
      username: 'reset_user',
      email,
      password: 'CorrectPass123'
    });

    const emailLogin = await postForm(ctx.baseUrl, '/php/login.php', {
      username: email,
      password: 'CorrectPass123'
    });
    assert.equal(emailLogin.status, 200);
    assert.equal(emailLogin.body.success, true);

    const phoneReset = await postForm(ctx.baseUrl, '/php/forgot_password.php', {
      action: 'send_code',
      phone: '13800138000'
    });
    assert.equal(phoneReset.status, 200);
    assert.equal(phoneReset.body.success, false);
    assert.match(phoneReset.body.message, /邮箱验证码/);

    const sent = await postForm(ctx.baseUrl, '/php/forgot_password.php', {
      action: 'send_code',
      email
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.success, true);
    const code = latestCode(ctx.dataDir, email);

    const reset = await postForm(ctx.baseUrl, '/php/forgot_password.php', {
      action: 'reset_password',
      email,
      code,
      new_password: 'NewEmailPass123'
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.success, true);

    const oldPassword = await postForm(ctx.baseUrl, '/php/login.php', {
      username: email,
      password: 'CorrectPass123'
    });
    assert.equal(oldPassword.body.success, false);

    const newPassword = await postForm(ctx.baseUrl, '/php/login.php', {
      username: email,
      password: 'NewEmailPass123'
    });
    assert.equal(newPassword.status, 200);
    assert.equal(newPassword.body.success, true);
  } finally {
    closeAuthApp(ctx);
  }
});

test('protected user data endpoints require a matching token', async () => {
  let ctx;
  try {
    ctx = await startAuthApp();
    const userA = insertUser(ctx.store.db, {
      username: 'owner_user',
      email: 'owner@example.test'
    });
    const userB = insertUser(ctx.store.db, {
      username: 'other_user',
      email: 'other@example.test'
    });
    const tokenA = generateToken(userA);

    const missingToken = await postForm(ctx.baseUrl, '/php/get_favorites.php', {
      user_id: String(userA)
    });
    assert.equal(missingToken.status, 401);
    assert.equal(missingToken.body.success, false);

    const mismatchedUser = await postForm(ctx.baseUrl, '/php/get_favorites.php', {
      user_id: String(userB),
      token: tokenA
    });
    assert.equal(mismatchedUser.status, 401);
    assert.equal(mismatchedUser.body.success, false);

    const valid = await postForm(ctx.baseUrl, '/php/get_favorites.php', {
      user_id: String(userA),
      token: tokenA
    });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.success, true);
    assert.deepEqual(valid.body.favorites, []);
  } finally {
    closeAuthApp(ctx);
  }
});

test('CORS is closed by default for arbitrary origins', async () => {
  let ctx;
  try {
    ctx = await startAuthApp();
    const response = await fetch(`${ctx.baseUrl}/php/check_version.php`, {
      headers: { Origin: 'https://evil.example.test' }
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally {
    closeAuthApp(ctx);
  }
});

test('music API responses disable browser caches while retaining server-side caching', async () => {
  let ctx;
  try {
    ctx = await startAuthApp();
    const response = await fetch(`${ctx.baseUrl}/api.php?types=search&source=netease&name=cache-test&count=1`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.equal(response.headers.get('x-cache'), 'MISS');
  } finally {
    closeAuthApp(ctx);
  }
});

test('media artwork proxy serves allowlisted images and blocks arbitrary hosts', async () => {
  let ctx;
  let fetchCount = 0;
  try {
    ctx = await startAuthApp({
      artworkFetcher: async (target) => {
        fetchCount += 1;
        assert.equal(target.hostname, 'img2.kuwo.cn');
        return { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg' };
      },
      artworkProcessor: async (image) => image
    });

    const allowedTarget = encodeURIComponent('https://img2.kuwo.cn/wmvpic/cover.jpg');
    const allowed = await fetch(`${ctx.baseUrl}/media/artwork?url=${allowedTarget}`);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('content-type'), 'image/jpeg');
    assert.match(allowed.headers.get('cache-control') || '', /max-age=86400/);
    assert.equal((await allowed.arrayBuffer()).byteLength, 4);
    assert.equal(fetchCount, 1);

    const cached = await fetch(`${ctx.baseUrl}/media/artwork?url=${allowedTarget}`, {
      headers: { 'If-None-Match': allowed.headers.get('etag') }
    });
    assert.equal(cached.status, 304);
    assert.equal(fetchCount, 1);

    const blockedTarget = encodeURIComponent('http://127.0.0.1/private-cover.jpg');
    const blocked = await fetch(`${ctx.baseUrl}/media/artwork?url=${blockedTarget}`);
    assert.equal(blocked.status, 400);
    assert.equal(fetchCount, 1);
  } finally {
    closeAuthApp(ctx);
  }
});

test('media artwork processor emits a square 512px JPEG for system controls', async () => {
  const source = await sharp({
    create: {
      width: 324,
      height: 182,
      channels: 3,
      background: { r: 40, g: 120, b: 200 }
    }
  }).jpeg().toBuffer();

  const result = await processArtworkImage({ data: source, contentType: 'image/jpeg' });
  const metadata = await sharp(result.data).metadata();

  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  assert.equal(metadata.format, 'jpeg');
});
