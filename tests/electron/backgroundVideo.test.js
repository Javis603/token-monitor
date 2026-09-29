'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MAX_VIDEO_BYTES, createBackgroundVideoManager, installBackgroundVideo } = require('../../src/electron/backgroundVideo');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'background-video-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'userData');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'background-image.png'), 'original-image');
  const source = path.join(root, 'chosen.mp4');
  await fs.writeFile(source, 'video-fixture');
  return { root, data, source, manager: createBackgroundVideoManager(data) };
}

test('validated video is copied privately, survives original removal and restart, and clearing restores the image', async (t) => {
  const f = await fixture(t);
  const preview = await f.manager.prepare(f.source);
  assert.equal(await f.manager.get(), null);
  assert.equal(await f.manager.resolve(preview.url), f.source);
  const record = await f.manager.commit(preview.id);
  const saved = await f.manager.resolve(record.url);
  assert.notEqual(saved, f.source);
  assert.equal((await fs.stat(saved)).mode & 0o777, 0o600);
  await fs.unlink(f.source);
  const restarted = createBackgroundVideoManager(f.data);
  assert.deepEqual(await restarted.get(), record);
  assert.equal(await fs.readFile(await restarted.resolve(record.url), 'utf8'), 'video-fixture');
  await restarted.clear();
  assert.equal(await restarted.get(), null);
  assert.equal(await fs.readFile(path.join(f.data, 'background-image.png'), 'utf8'), 'original-image');
  await assert.rejects(fs.stat(saved), { code: 'ENOENT' });
});

test('canceling or failing a replacement leaves the last background intact', async (t) => {
  const f = await fixture(t);
  const first = await f.manager.prepare(f.source);
  const saved = await f.manager.commit(first.id);
  const canceled = await f.manager.prepare(f.source);
  f.manager.cancel(canceled.id);
  await assert.rejects(f.manager.commit(canceled.id), /Select the video again/);
  assert.equal(await f.manager.resolve(canceled.url), null);
  const next = await f.manager.prepare(f.source);
  await fs.unlink(f.source);
  await assert.rejects(f.manager.commit(next.id));
  assert.deepEqual(await f.manager.get(), saved);
});

test('picker validation rejects unsupported formats and oversized files before replacing anything', async (t) => {
  const f = await fixture(t);
  const unsupported = path.join(f.root, 'file.txt');
  await fs.writeFile(unsupported, 'text');
  await assert.rejects(f.manager.prepare(unsupported), /MP4 or WebM/);
  const large = path.join(f.root, 'large.webm');
  const file = await fs.open(large, 'w');
  await file.truncate(MAX_VIDEO_BYTES + 1);
  await file.close();
  await assert.rejects(f.manager.prepare(large), /256 MB/);
  assert.equal(await f.manager.get(), null);
});

test('video URL can only resolve the chosen preview or committed video, not arbitrary local files', async (t) => {
  const f = await fixture(t);
  const selected = await f.manager.prepare(f.source);
  for (const url of [
    'token-monitor-background://video/../../credentials.json',
    'token-monitor-background://video/current?id=wrong',
    'token-monitor-background://other/preview?id='+selected.id,
    'file:///etc/passwd'
  ]) assert.equal(await f.manager.resolve(url), null);
});

test('Electron media handler forwards byte ranges only for a managed video', async (t) => {
  const f = await fixture(t);
  let handler;
  let fetched;
  const manager = installBackgroundVideo({
    app: { getPath: () => f.data },
    protocol: { handle(_scheme, fn) { handler = fn; } },
    ipcMain: { handle() {} },
    dialog: {},
    getWindow: () => null,
    net: { async fetch(url, init) { fetched = { url, init }; return new Response('part', { status: 206 }); } }
  });
  const preview = await manager.prepare(f.source);
  const response = await handler(new Request(preview.url, { headers: { Range: 'bytes=0-9' } }));
  assert.equal(response.status, 206);
  assert.equal(fetched.init.headers.Range, 'bytes=0-9');
  assert.ok(fetched.url.startsWith('file:'));
  assert.equal((await handler(new Request('token-monitor-background://video/current?id=wrong'))).status, 404);
});
