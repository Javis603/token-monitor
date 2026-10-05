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
  // Windows uses the user-data directory ACL rather than POSIX mode bits.
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(saved)).mode & 0o777, 0o600);
  }
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

for (const size of [0, MAX_VIDEO_BYTES + 1]) {
  test(`commit rejects a selection changed to ${size} bytes and preserves the previous video`, async (t) => {
    const f = await fixture(t);
    const first = await f.manager.prepare(f.source);
    const saved = await f.manager.commit(first.id);
    const before = (await fs.readdir(f.data)).sort();
    const next = await f.manager.prepare(f.source);
    await fs.truncate(f.source, size);
    await assert.rejects(f.manager.commit(next.id), /256 MB/);
    assert.deepEqual(await f.manager.get(), saved);
    assert.deepEqual((await fs.readdir(f.data)).sort(), before);
  });
}

test('commit bounds the copy even if the source grows after its handle is checked', async (t) => {
  const f = await fixture(t);
  const selection = await f.manager.prepare(f.source);
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.source) {
      const stat = handle.stat.bind(handle);
      t.mock.method(handle, 'stat', async () => {
        const result = await stat();
        await fs.truncate(f.source, MAX_VIDEO_BYTES + 1);
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(f.manager.commit(selection.id), /256 MB/);
  assert.equal(await f.manager.get(), null);
  assert.deepEqual(await fs.readdir(f.data), ['background-image.png']);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('clear retains the saved record and reports a failed video deletion so it can be retried after restart', async (t) => {
  const f = await fixture(t);
  const selection = await f.manager.prepare(f.source);
  const saved = await f.manager.commit(selection.id);
  const destination = await f.manager.resolve(saved.url);
  const unlink = fs.unlink.bind(fs);
  const failure = Object.assign(new Error('Video is in use'), { code: 'EPERM' });
  const mocked = t.mock.method(fs, 'unlink', async (file) => {
    if (file === destination) throw failure;
    return unlink(file);
  });
  await assert.rejects(f.manager.clear(), failure);
  const restarted = createBackgroundVideoManager(f.data);
  assert.deepEqual(await restarted.get(), saved);
  assert.equal(await fs.readFile(destination, 'utf8'), 'video-fixture');
  mocked.mock.restore();
  await restarted.clear();
  assert.equal(await restarted.get(), null);
  assert.deepEqual(await fs.readdir(f.data), ['background-image.png']);
});

test('concurrent commits of the same selection cannot remove the winning copy', async (t) => {
  const f = await fixture(t);
  const selection = await f.manager.prepare(f.source);
  const ready = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  t.after(() => release.resolve());
  t.mock.method(fs, 'rename', async (...args) => {
    ready.resolve();
    await release.promise;
    return rename(...args);
  });
  const first = f.manager.commit(selection.id);
  await ready.promise;
  const second = f.manager.commit(selection.id);
  const results = Promise.allSettled([first, second]);
  release.resolve();
  const [winner, duplicate] = await results;
  assert.equal(winner.status, 'fulfilled');
  assert.equal(duplicate.status, 'rejected');
  assert.deepEqual(await f.manager.get(), winner.value);
  const saved = await f.manager.resolve(winner.value.url);
  assert.equal(await fs.readFile(saved, 'utf8'), 'video-fixture');
  assert.equal(await f.manager.resolve(selection.url), null);
  assert.equal((await fs.readdir(f.data)).filter((name) => name.endsWith('.mp4')).length, 1);
});

test('a selection prepared while a commit is publishing remains available for the next commit', async (t) => {
  const f = await fixture(t);
  const selection = await f.manager.prepare(f.source);
  const ready = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  t.after(() => release.resolve());
  t.mock.method(fs, 'rename', async (...args) => {
    ready.resolve();
    await release.promise;
    return rename(...args);
  });
  const first = f.manager.commit(selection.id);
  await ready.promise;
  const next = await f.manager.prepare(f.source);
  const second = f.manager.commit(next.id);
  release.resolve();
  const [previous, saved] = await Promise.all([first, second]);
  assert.deepEqual(await f.manager.get(), saved);
  assert.equal(await f.manager.resolve(previous.url), null);
  assert.equal(await f.manager.resolve(next.url), null);
  assert.equal(await fs.readFile(await f.manager.resolve(saved.url), 'utf8'), 'video-fixture');
  assert.deepEqual((await fs.readdir(f.data)).sort(), [
    'background-image.png', `background-video-${next.id}.mp4`, 'background-video.json'
  ].sort());
});

test('clear queued behind an in-flight replacement removes the newly committed video', async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(f.source);
  await f.manager.commit(original.id);
  const selection = await f.manager.prepare(f.source);
  const ready = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  t.after(() => release.resolve());
  t.mock.method(fs, 'rename', async (...args) => {
    ready.resolve();
    await release.promise;
    return rename(...args);
  });
  const committing = f.manager.commit(selection.id);
  await ready.promise;
  const clearing = f.manager.clear();
  release.resolve();
  await Promise.all([committing, clearing]);
  assert.equal(await f.manager.get(), null);
  assert.equal(await f.manager.resolve(selection.url), null);
  assert.deepEqual(await fs.readdir(f.data), ['background-image.png']);
});

test('clear preserves a newer pending selection and its queued commit', async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(f.source);
  const saved = await f.manager.commit(original.id);
  const destination = await f.manager.resolve(saved.url);
  const stale = await f.manager.prepare(f.source);
  const ready = deferred();
  const release = deferred();
  const unlink = fs.unlink.bind(fs);
  t.after(() => release.resolve());
  t.mock.method(fs, 'unlink', async (file) => {
    if (file === destination) {
      ready.resolve();
      await release.promise;
    }
    return unlink(file);
  });
  const clearing = f.manager.clear();
  await ready.promise;
  const next = await f.manager.prepare(f.source);
  const committing = f.manager.commit(next.id);
  release.resolve();
  const [, current] = await Promise.all([clearing, committing]);
  assert.deepEqual(await f.manager.get(), current);
  assert.equal(await f.manager.resolve(stale.url), null);
  assert.equal(await fs.readFile(await f.manager.resolve(current.url), 'utf8'), 'video-fixture');
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('a canceled queued commit cannot revive its selection or erase a newer preview', async (t) => {
  const f = await fixture(t);
  const selection = await f.manager.prepare(f.source);
  const ready = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  t.after(() => release.resolve());
  t.mock.method(fs, 'rename', async (...args) => {
    ready.resolve();
    await release.promise;
    return rename(...args);
  });
  const first = f.manager.commit(selection.id);
  await ready.promise;
  const canceled = await f.manager.prepare(f.source);
  const second = f.manager.commit(canceled.id);
  const rejected = assert.rejects(second, /Select the video again/);
  f.manager.cancel(canceled.id);
  const next = await f.manager.prepare(f.source);
  release.resolve();
  const saved = await first;
  await rejected;
  assert.deepEqual(await f.manager.get(), saved);
  assert.equal(await f.manager.resolve(next.url), f.source);
  assert.equal(await f.manager.resolve(canceled.url), null);
  await assert.rejects(fs.stat(path.join(f.data, `background-video-${canceled.id}.mp4`)), { code: 'ENOENT' });
  await f.manager.commit(next.id);
});

for (const collision of ['video', 'manifest']) {
  test(`failed exclusive ${collision} creation leaves the pre-existing file untouched`, async (t) => {
    const f = await fixture(t);
    const selection = await f.manager.prepare(f.source);
    const destination = path.join(f.data, collision === 'video'
      ? `background-video-${selection.id}.mp4`
      : `.background-video-${selection.id}.json`);
    await fs.writeFile(destination, 'pre-existing-file');
    const before = (await fs.readdir(f.data)).sort();
    await assert.rejects(f.manager.commit(selection.id), { code: 'EEXIST' });
    assert.equal(await fs.readFile(destination, 'utf8'), 'pre-existing-file');
    assert.equal(await f.manager.get(), null);
    assert.equal(await f.manager.resolve(selection.url), f.source);
    assert.deepEqual((await fs.readdir(f.data)).sort(), before);
    await fs.unlink(destination);
    const saved = await f.manager.commit(selection.id);
    assert.deepEqual(await f.manager.get(), saved);
  });
}

test('a failed publication cleans up its owned files and does not block a queued clear', async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(f.source);
  await f.manager.commit(original.id);
  const selection = await f.manager.prepare(f.source);
  const ready = deferred();
  const release = deferred();
  const failure = Object.assign(new Error('Cannot publish manifest'), { code: 'EACCES' });
  t.after(() => release.resolve());
  t.mock.method(fs, 'rename', async () => {
    ready.resolve();
    await release.promise;
    throw failure;
  });
  const committing = f.manager.commit(selection.id);
  const rejected = assert.rejects(committing, failure);
  await ready.promise;
  const clearing = f.manager.clear();
  release.resolve();
  await Promise.all([rejected, clearing]);
  assert.equal(await f.manager.get(), null);
  assert.equal(await f.manager.resolve(selection.url), null);
  assert.deepEqual(await fs.readdir(f.data), ['background-image.png']);
});

test('clear tolerates an already removed video and retries a failed manifest deletion', async (t) => {
  const f = await fixture(t);
  const selection = await f.manager.prepare(f.source);
  const saved = await f.manager.commit(selection.id);
  const destination = await f.manager.resolve(saved.url);
  const manifest = path.join(f.data, 'background-video.json');
  const unlink = fs.unlink.bind(fs);
  const failure = Object.assign(new Error('Manifest is in use'), { code: 'EPERM' });
  const mocked = t.mock.method(fs, 'unlink', async (file) => {
    if (file === destination) {
      await unlink(file);
      throw Object.assign(new Error('Already removed'), { code: 'ENOENT' });
    }
    if (file === manifest) throw failure;
    return unlink(file);
  });
  await assert.rejects(f.manager.clear(), failure);
  assert.deepEqual(await f.manager.get(), { cleanupPending: true });
  assert.equal(JSON.parse(await fs.readFile(manifest, 'utf8')).id, saved.id);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  mocked.mock.restore();
  await f.manager.clear();
  await f.manager.clear();
  assert.deepEqual(await fs.readdir(f.data), ['background-image.png']);
});


test('failed retired-video cleanup stays tracked and prevents later replacement from dropping it', async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(f.source);
  const old = await f.manager.commit(original.id);
  const oldFile = await f.manager.resolve(old.url);
  const next = await f.manager.prepare(f.source);
  const unlink = fs.unlink.bind(fs);
  t.mock.method(fs, 'unlink', async (file) => {
    if (file === oldFile) throw new Error('Old video locked');
    return unlink(file);
  });
  await assert.rejects(f.manager.commit(next.id), /Old video locked/);
  const current = await f.manager.get();
  assert.equal(current.id, next.id);
  assert.equal(current.cleanupPending, true);
  assert.equal(await fs.readFile(oldFile, 'utf8'), 'video-fixture');
  const manifest = JSON.parse(await fs.readFile(path.join(f.data, 'background-video.json'), 'utf8'));
  assert.deepEqual(manifest.cleanupFiles, [path.basename(oldFile)]);
  const restarted = createBackgroundVideoManager(f.data);
  const newer = await restarted.prepare(f.source);
  await assert.rejects(restarted.commit(newer.id), /Old video locked/);
  assert.equal((await restarted.get()).id, next.id);
  await assert.rejects(restarted.clear(), /Old video locked/);
  assert.equal(await fs.readFile(await restarted.resolve(current.url), 'utf8'), 'video-fixture');
  t.mock.restoreAll();
  await restarted.clear();
  assert.deepEqual(await fs.readdir(f.data), ['background-image.png']);
});

for (const file of ['../private.mp4', '/tmp/private.mp4', 'background-image.png', null]) {
  test(`invalid cleanup entry ${file} cannot authorize deletion`, async (t) => {
    const f = await fixture(t);
    const preview = await f.manager.prepare(f.source);
    const saved = await f.manager.commit(preview.id);
    const manifest = path.join(f.data, 'background-video.json');
    const record = JSON.parse(await fs.readFile(manifest, 'utf8'));
    record.cleanupFiles = [file];
    await fs.writeFile(manifest, JSON.stringify(record));
    await assert.rejects(f.manager.clear(), /Invalid saved background/);
    assert.equal(await fs.readFile(path.join(f.data, record.fileName), 'utf8'), 'video-fixture');
    assert.equal(record.id, saved.id);
  });
}


test('an absent user-data directory reads empty and is created on the first video commit', async (t) => {
  const f = await fixture(t);
  const missing = path.join(f.root, 'not-yet-created');
  const manager = createBackgroundVideoManager(missing);
  assert.equal(await manager.get(), null);
  assert.equal(await manager.getImage(), null);
  const preview = await manager.prepare(f.source);
  const saved = await manager.commit(preview.id);
  assert.deepEqual(await manager.get(), saved);
});

test('a manifest cleanup failure invalidates the old preview at the media deletion commit point', async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(f.source);
  await f.manager.commit(original.id);
  const preview = await f.manager.prepare(f.source);
  const unlink = fs.unlink.bind(fs);
  t.mock.method(fs, 'unlink', async (file) => {
    if (file === path.join(f.data, 'background-video.json')) throw new Error('Manifest locked');
    return unlink(file);
  });
  await assert.rejects(f.manager.clear(), /Manifest locked/);
  assert.equal(await f.manager.resolve(preview.url), null);
  await assert.rejects(f.manager.commit(preview.id), /Select the video again/);
});
