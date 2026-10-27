import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app/server.mjs';
import { PHOTOS, PHOTO_GROUPS, photoFor, photoPath } from '../public/seoa-gallery.js';
import { SCENES } from '../public/seoa-portrait.js';

test('daily scene cards cover four official photos and cycle without repeating within a group', () => {
  assert.equal(PHOTOS.length, 4);
  assert.equal(new Set(PHOTOS.map(photo => photo.file)).size, 4);
  assert.deepEqual([...new Set(Object.values(PHOTO_GROUPS).flat())].sort((a, b) => a - b), [1, 2, 3, 4]);
  const date = new Date(2026, 9, 19, 12);
  for (const [view, group] of Object.entries(PHOTO_GROUPS)) {
    const ids = Array.from({ length: group.length }, (_, offset) => photoFor(view, offset, date).id);
    assert.equal(new Set(ids).size, group.length);
    assert.equal(photoFor(view, group.length, date).id, ids[0]);
    assert.equal(photoFor(view, 0, new Date(2026, 9, 19, 23)).id, ids[0]);
    assert.equal(photoFor(view, 0, new Date(2026, 9, 20, 0)).id, ids[1]);
  }
});

test('official photos match their recorded source hashes and use unmodified photo scenes', () => {
  const directory = join(import.meta.dirname, '..', 'public', 'assets', 'asa');
  const sources = JSON.parse(readFileSync(join(directory, 'sources.json'), 'utf8'));
  assert.match(sources.credit, /YG ENTERTAINMENT/);
  assert.deepEqual(sources.photos.map(photo => photo.file).sort(), PHOTOS.map(photo => photo.file).sort());
  for (const photo of sources.photos) {
    const bytes = readFileSync(join(directory, photo.file));
    assert.equal(bytes.length, photo.bytes, photo.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), photo.sha256, photo.file);
    for (const source of [photo.page, photo.url]) {
      const url = new URL(source);
      assert.equal(url.protocol, 'https:');
      assert.ok(['www.ygfamily.com', 'yg-life.com', 'yg-babymonster-official.jp'].includes(url.hostname), source);
    }
  }
  assert.deepEqual(Object.values(SCENES).map(scene => scene.base), ['/assets/asa/moon.jpg', '/assets/asa/choom.jpg', '/assets/asa/supa-dupa-luv.jpg']);
  for (const scene of Object.values(SCENES)) assert.equal(scene.frames, undefined);
});

test('every official photo is served as JPEG while old portraits and private files stay unavailable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'seoa-art-test-'));
  const app = createApp({ dataPath: join(directory, 'test.sqlite') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const paths = new Set([...PHOTOS.map(photo => photoPath(photo.id)), ...Object.values(SCENES).map(scene => scene.base)]);
    assert.equal(paths.size, 4);
    for (const path of paths) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), 'image/jpeg', path);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff', path);
      assert.equal(bytes.subarray(-2).toString('hex'), 'ffd9', path);
    }
    assert.equal((await fetch(origin + '/seoa-gallery.js')).status, 200);
    for (const path of ['/assets/asa/unlisted.jpg', '/assets/asa/sources.json', '/assets/seoa/portrait.png', '/assets/seoa/gallery/01.png', '/assets/seoa/motion/studio-manifest.json', '/data/rin.sqlite']) {
      assert.equal((await fetch(origin + path)).status, 404, path);
    }
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    rmSync(directory, { recursive: true });
  }
});
