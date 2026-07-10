'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const artworkSource = fs.readFileSync(
  path.join(__dirname, '..', 'webroot', 'js', 'media-session-artwork.js'),
  'utf8'
);

function createArtworkResolver(baseUrl = 'https://music.example.test/?source=pwa') {
  const context = {
    URL,
    location: new URL(baseUrl)
  };
  context.window = context;
  vm.runInNewContext(artworkSource, context, { filename: 'media-session-artwork.js' });
  return context.__musicMediaArtwork;
}

test('Media Session artwork uses a same-origin proxy for known music CDNs', () => {
  const artwork = createArtworkResolver();
  const resolved = new URL(artwork.resolve('https://img2.kuwo.cn/wmvpic/cover.jpg'));

  assert.equal(resolved.origin, 'https://music.example.test');
  assert.equal(resolved.pathname, '/media/artwork');
  assert.equal(resolved.searchParams.get('url'), 'https://img2.kuwo.cn/wmvpic/cover.jpg');
  assert.deepEqual(
    JSON.parse(JSON.stringify(artwork.buildSet('https://img2.kuwo.cn/wmvpic/cover.jpg'))),
    [{ src: resolved.href, sizes: '512x512', type: 'image/jpeg' }]
  );
});

test('Media Session artwork keeps same-origin images and rejects unknown hosts', () => {
  const artwork = createArtworkResolver();

  assert.equal(
    artwork.resolve('/uploads/avatars/cover.jpg'),
    'https://music.example.test/uploads/avatars/cover.jpg'
  );
  assert.equal(
    artwork.resolve('https://untrusted.example.test/cover.jpg'),
    'https://music.example.test/public/icons/icon-192.png'
  );
});
