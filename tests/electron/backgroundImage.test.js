'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createBackgroundVideoManager, installBackgroundVideo } = require('../../src/electron/backgroundVideo');
const {
  backgroundImagePath,
  clearBackgroundImage,
  getBackgroundImage,
  importBackgroundImage
} = require('../../src/electron/backgroundImage');

async function imagePickerFixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'background-image-picker-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'userData');
  await fs.promises.mkdir(data);
  const source = path.join(root, 'chosen.jpg');
  const videoSource = path.join(root, 'chosen.mp4');
  await fs.promises.writeFile(source, 'source');
  await fs.promises.writeFile(videoSource, 'saved-video');
  await fs.promises.writeFile(backgroundImagePath(data), 'saved-image');
  const output = Buffer.from('new-image');
  const handlers = new Map();
  const dialog = { showOpenDialog: async () => ({ filePaths: [source] }) };
  const nativeImage = { createFromBuffer: () => ({
    isEmpty: () => false, getSize: () => ({ width: 100, height: 100 }), toPNG: () => output
  }) };
  let manager;
  // Execute the actual main-process image IPC wiring with the real storage
  // managers, without booting Electron and its unrelated application services.
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = main.lastIndexOf('\n', main.indexOf('installBackgroundVideo({ app,')) + 1;
  vm.runInNewContext(main.slice(start, main.indexOf('\n\n', start)), {
    app: { getPath: () => data }, ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
    dialog, protocol: { handle() {} }, net: {}, mainWindow: null, nativeImage,
    clearBackgroundImage, getBackgroundImage, importBackgroundImage,
    installBackgroundVideo(options) { manager = installBackgroundVideo(options); return manager; }
  });
  const selection = await manager.prepare(videoSource);
  const saved = await manager.commit(selection.id);
  return { data, output, dialog, nativeImage, manager, saved,
    source, videoSource, choose: () => handlers.get('appearance:chooseBackgroundImage')(),
    remove: () => handlers.get('appearance:clearBackgroundImage')() };
}

test('image picker publishes a private PNG with a durable backup before clearing the video', async (t) => {
  const f = await imagePickerFixture(t);
  const savedVideo = await f.manager.resolve(f.saved.url);
  const unlink = fs.promises.unlink.bind(fs.promises);
  let clears = 0;
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (file === savedVideo) {
      clears += 1;
      assert.deepEqual(await getBackgroundImage(f.data), f.output);
      const recovery = path.join(f.data, '.background-image-recovery.json');
      const saved = JSON.parse(await fs.promises.readFile(recovery, 'utf8'));
      assert.equal(Buffer.from(saved.previousImage, 'base64').toString(), 'saved-image');
      assert.equal(saved.previousVideoId, f.saved.id);
      if (process.platform !== 'win32') {
        assert.equal((await fs.promises.stat(recovery)).mode & 0o777, 0o600);
        assert.equal((await fs.promises.stat(backgroundImagePath(f.data))).mode & 0o777, 0o600);
      }
    }
    return unlink(file);
  });

  const result = await f.choose();

  assert.equal(clears, 1);
  assert.deepEqual(result.bytes, f.output);
  assert.deepEqual(await getBackgroundImage(f.data), f.output);
  assert.equal(await f.manager.get(), null);
  assert.deepEqual(await fs.promises.readdir(f.data), ['background-image.png']);
});

test('failed video removal rejects the image picker and preserves both saved backgrounds', async (t) => {
  const f = await imagePickerFixture(t);
  const savedVideo = await f.manager.resolve(f.saved.url);
  const before = (await fs.promises.readdir(f.data)).sort();
  const unlink = fs.promises.unlink.bind(fs.promises);
  const failure = Object.assign(new Error('Video is in use'), { code: 'EPERM' });
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (file === savedVideo) throw failure;
    return unlink(file);
  });

  await assert.rejects(f.choose(), failure);

  assert.equal((await getBackgroundImage(f.data)).toString(), 'saved-image');
  assert.deepEqual(await f.manager.get(), f.saved);
  assert.equal(await fs.promises.readFile(savedVideo, 'utf8'), 'saved-video');
  assert.deepEqual((await fs.promises.readdir(f.data)).sort(), before);
});

for (const outcome of ['canceled', 'invalid', 'staging failure']) {
  test(`an image picker ${outcome} never clears the saved video`, async (t) => {
    const f = await imagePickerFixture(t);
    const before = (await fs.promises.readdir(f.data)).sort();
    const clear = t.mock.method(f.manager, 'clear', async () => { throw new Error('Must not clear'); });
    if (outcome === 'canceled') f.dialog.showOpenDialog = async () => ({ canceled: true });
    else if (outcome === 'invalid') f.nativeImage.createFromBuffer = () => ({ isEmpty: () => true });
    else {
      const open = fs.promises.open.bind(fs.promises);
      t.mock.method(fs.promises, 'open', async (file, ...args) => {
        if (path.basename(file) === 'candidate.png') throw new Error('Disk full');
        return open(file, ...args);
      });
    }

    if (outcome === 'canceled') assert.equal((await f.choose()).canceled, true);
    else await assert.rejects(f.choose(), outcome === 'invalid' ? /not supported/ : /Disk full/);

    t.mock.restoreAll();
    assert.equal(clear.mock.callCount(), 0);
    assert.equal((await getBackgroundImage(f.data)).toString(), 'saved-image');
    assert.deepEqual(await f.manager.get(), f.saved);
    assert.deepEqual((await fs.promises.readdir(f.data)).sort(), before);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a failed image publication preserves the old PNG and video without deleting either', async (t) => {
  const f = await imagePickerFixture(t);
  const before = (await fs.promises.readdir(f.data)).sort();
  const failure = new Error('Cannot publish PNG');
  const rename = fs.promises.rename.bind(fs.promises);
  t.mock.method(fs.promises, 'rename', async (...args) => {
    if (args[1] === backgroundImagePath(f.data)) throw failure;
    return rename(...args);
  });
  await assert.rejects(f.choose(), failure);
  assert.equal((await getBackgroundImage(f.data)).toString(), 'saved-image');
  assert.deepEqual(await f.manager.get(), f.saved);
  assert.deepEqual((await fs.promises.readdir(f.data)).sort(), before);
});

test('a failed recovery journal creation cannot clear the video or publish the candidate', async (t) => {
  const f = await imagePickerFixture(t);
  const before = (await fs.promises.readdir(f.data)).sort();
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    if (path.basename(file) === 'recovery.json' && args[0] === 'wx') throw new Error('Cannot save backup');
    return open(file, ...args);
  });
  await assert.rejects(f.choose(), /Cannot save backup/);
  assert.equal((await getBackgroundImage(f.data)).toString(), 'saved-image');
  assert.deepEqual(await f.manager.get(), f.saved);
  assert.deepEqual((await fs.promises.readdir(f.data)).sort(), before);
});

test('failed PNG restoration preserves its private backup and blocks later mutations until restart recovery', async (t) => {
  const f = await imagePickerFixture(t);
  const video = await f.manager.resolve(f.saved.url);
  const unlink = fs.promises.unlink.bind(fs.promises);
  const rename = fs.promises.rename.bind(fs.promises);
  let publishes = 0;
  t.mock.method(fs.promises, 'rename', async (...args) => {
    if (args[1] === backgroundImagePath(f.data) && ++publishes > 1) throw new Error('Restore blocked');
    return rename(...args);
  });
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (file === video) throw new Error('Video locked');
    return unlink(file);
  });
  await assert.rejects(f.choose(), (error) => error.errors?.some((cause) => cause.message === 'Restore blocked'));
  const recovery = path.join(f.data, '.background-image-recovery.json');
  const saved = JSON.parse(await fs.promises.readFile(recovery, 'utf8'));
  assert.equal(Buffer.from(saved.previousImage, 'base64').toString(), 'saved-image');
  assert.equal(await fs.promises.readFile(video, 'utf8'), 'saved-video');
  assert.deepEqual(await getBackgroundImage(f.data), f.output);
  assert.equal((await f.manager.getImage()).toString(), 'saved-image');
  assert.deepEqual(await f.manager.get(), { ...f.saved, cleanupPending: true });
  await assert.rejects(f.remove(), /Restore blocked/);
  await assert.rejects(f.manager.clear(), /Restore blocked/);
  assert.equal(await fs.promises.readFile(video, 'utf8'), 'saved-video');
  t.mock.restoreAll();
  const restarted = createBackgroundVideoManager(f.data);
  assert.equal((await restarted.getImage()).toString(), 'saved-image');
  assert.deepEqual(await restarted.get(), f.saved);
  await assert.rejects(fs.promises.stat(recovery), { code: 'ENOENT' });
  await restarted.importImage(f.source, f.nativeImage);
  assert.deepEqual(await restarted.getImage(), f.output);
  assert.equal(await restarted.get(), null);
});

test('failed manifest removal keeps the committed PNG and exposes metadata cleanup for restart retry', async (t) => {
  const f = await imagePickerFixture(t);
  const video = await f.manager.resolve(f.saved.url);
  const manifest = path.join(f.data, 'background-video.json');
  const unlink = fs.promises.unlink.bind(fs.promises);
  const failure = new Error('Metadata locked');
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (file === manifest) throw failure;
    return unlink(file);
  });
  await assert.rejects(f.choose(), failure);
  assert.deepEqual(await getBackgroundImage(f.data), f.output);
  await assert.rejects(fs.promises.stat(video), { code: 'ENOENT' });
  assert.deepEqual(await f.manager.get(), { cleanupPending: true });
  const restarted = createBackgroundVideoManager(f.data);
  assert.deepEqual(await restarted.get(), { cleanupPending: true });
  t.mock.restoreAll();
  await restarted.clear();
  assert.deepEqual(await fs.promises.readdir(f.data), ['background-image.png']);
});

test('failed journal cleanup reports partial success and never restores the retired image after restart', async (t) => {
  const f = await imagePickerFixture(t);
  const recovery = path.join(f.data, '.background-image-recovery.json');
  const unlink = fs.promises.unlink.bind(fs.promises);
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (file === recovery) throw new Error('Backup cleanup locked');
    return unlink(file);
  });
  await assert.rejects(f.choose(), /Backup cleanup locked/);
  assert.deepEqual(await getBackgroundImage(f.data), f.output);
  await assert.rejects(f.manager.clearImage(), /Backup cleanup locked/);
  assert.deepEqual(await f.manager.getImage(), f.output);
  assert.deepEqual(await f.manager.get(), { cleanupPending: true });
  const saved = JSON.parse(await fs.promises.readFile(recovery, 'utf8'));
  assert.equal(Buffer.from(saved.previousImage, 'base64').toString(), 'saved-image');
  t.mock.restoreAll();
  const restarted = createBackgroundVideoManager(f.data);
  assert.deepEqual(await restarted.getImage(), f.output);
  assert.equal(await restarted.get(), null);
  assert.deepEqual(await fs.promises.readdir(f.data), ['background-image.png']);
});

test('image publication, image removal, and a newer video commit share one mutation lane', async (t) => {
  const f = await imagePickerFixture(t);
  const ready = deferred();
  const release = deferred();
  const rename = fs.promises.rename.bind(fs.promises);
  t.after(() => release.resolve());
  t.mock.method(fs.promises, 'rename', async (...args) => {
    if (args[1] === backgroundImagePath(f.data)) { ready.resolve(); await release.promise; }
    return rename(...args);
  });
  const choosing = f.choose();
  await ready.promise;
  const removing = f.remove();
  const preview = await f.manager.prepare(f.videoSource);
  const committing = f.manager.commit(preview.id);
  assert.equal((await getBackgroundImage(f.data)).toString(), 'saved-image');
  release.resolve();
  const [, , saved] = await Promise.all([choosing, removing, committing]);
  assert.equal(await f.manager.getImage(), null);
  assert.deepEqual(await f.manager.get(), saved);
  assert.equal(await fs.promises.readFile(await f.manager.resolve(saved.url), 'utf8'), 'saved-video');
});

test('failed exclusive staging-directory creation preserves a directory the importer does not own', async (t) => {
  const f = await imagePickerFixture(t);
  const collision = path.join(f.data, '.background-image-stage-collision');
  await fs.promises.mkdir(collision);
  await fs.promises.writeFile(path.join(collision, 'candidate.png'), 'not-owned');
  t.mock.method(fs.promises, 'mkdtemp', async () => { throw Object.assign(new Error('Collision'), { code: 'EEXIST' }); });
  await assert.rejects(f.choose(), { code: 'EEXIST' });
  assert.equal(await fs.promises.readFile(path.join(collision, 'candidate.png'), 'utf8'), 'not-owned');
  assert.equal((await getBackgroundImage(f.data)).toString(), 'saved-image');
  assert.deepEqual(await f.manager.get(), f.saved);
});

for (const stage of ['candidate write', 'candidate close', 'journal write', 'journal close']) {
  test(`failed ${stage} and cleanup retain discoverable staging and recover on retry`, async (t) => {
    const f = await imagePickerFixture(t);
    const target = stage.startsWith('candidate') ? 'candidate.png' : 'recovery.json';
    const open = fs.promises.open.bind(fs.promises);
    const unlink = fs.promises.unlink.bind(fs.promises);
    t.mock.method(fs.promises, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (path.basename(file) === target && args[0] === 'wx') {
        if (stage.endsWith('write')) {
          const writeFile = handle.writeFile.bind(handle);
          t.mock.method(handle, 'writeFile', async () => { await writeFile('partial'); throw new Error('Write failed'); });
        } else {
          const close = handle.close.bind(handle);
          t.mock.method(handle, 'close', async () => { await close(); throw new Error('Close failed'); });
        }
      }
      return handle;
    });
    t.mock.method(fs.promises, 'unlink', async (file) => {
      if (path.basename(file) === target) throw new Error('Cleanup locked');
      return unlink(file);
    });
    await assert.rejects(f.choose(), /cleanup failed/);
    assert.equal((await getBackgroundImage(f.data)).toString(), 'saved-image');
    await assert.rejects(fs.promises.stat(path.join(f.data, '.background-image-recovery.json')), { code: 'ENOENT' });
    const stages = (await fs.promises.readdir(f.data)).filter((name) => name.startsWith('.background-image-stage-'));
    assert.equal(stages.length, 1);
    await assert.rejects(f.manager.clear(), /Cleanup locked/);
    t.mock.restoreAll();
    const restarted = createBackgroundVideoManager(f.data);
    assert.equal((await restarted.getImage()).toString(), 'saved-image');
    assert.deepEqual(await restarted.get(), f.saved);
    assert.equal((await fs.promises.readdir(f.data)).some((name) => name.startsWith('.background-image-')), false);
    await restarted.importImage(f.source, f.nativeImage);
    assert.deepEqual(await restarted.getImage(), f.output);
  });
}

test('a locked retired copy in a cleanup-only manifest cannot replace the old PNG', async (t) => {
  const f = await imagePickerFixture(t);
  const oldVideo = await f.manager.resolve(f.saved.url);
  const selection = await f.manager.prepare(f.videoSource);
  const unlink = fs.promises.unlink.bind(fs.promises);
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (file === oldVideo) throw new Error('Retired video locked');
    return unlink(file);
  });
  await assert.rejects(f.manager.commit(selection.id), /Retired video locked/);
  const current = await f.manager.get();
  await unlink(await f.manager.resolve(current.url));
  await assert.rejects(f.choose(), /Retired video locked/);
  assert.equal((await getBackgroundImage(f.data)).toString(), 'saved-image');
  assert.equal(await fs.promises.readFile(oldVideo, 'utf8'), 'saved-video');
});

test('chosen background survives source removal and can be cleared', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'token-background-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'chosen.png');
  const userData = path.join(dir, 'userData');
  await fs.promises.mkdir(userData);
  await fs.promises.writeFile(source, Buffer.from('source'));
  const output = Buffer.from('converted-png');
  const nativeImage = {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 120, height: 80 }),
      toPNG: () => output
    })
  };

  const bytes = await importBackgroundImage(source, userData, nativeImage);
  await fs.promises.unlink(source);
  assert.deepEqual(await getBackgroundImage(userData), bytes);
  assert.deepEqual(await fs.promises.readFile(backgroundImagePath(userData)), output);
  await clearBackgroundImage(userData);
  assert.equal(await getBackgroundImage(userData), null);
  await clearBackgroundImage(userData);
});

test('invalid replacement preserves the previous background', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'token-background-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'chosen.jpg');
  const userData = path.join(dir, 'userData');
  await fs.promises.mkdir(userData);
  await fs.promises.writeFile(source, Buffer.from('source'));
  let resizedTo;
  await importBackgroundImage(source, userData, {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 4000, height: 2000 }),
      resize: (size) => {
        resizedTo = size;
        return { toPNG: () => Buffer.from('first') };
      }
    })
  });
  assert.deepEqual(resizedTo, { width: 2000, height: 1000 });
  await assert.rejects(importBackgroundImage(source, userData, {
    createFromBuffer: () => ({ isEmpty: () => true })
  }), /not supported/);
  assert.deepEqual(await fs.promises.readFile(backgroundImagePath(userData)), Buffer.from('first'));
});

test('custom image layers over the glass instead of replacing it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'styles.css'), 'utf8');
  // The shell keeps its own glass while an image is set. Clearing it made the
  // image stand in for the glass, so the glass slider ended up driving the image.
  assert.doesNotMatch(css, /[.]shell[.]has-custom-background\s*\{/);
  const layer = css.match(/[.]shell[.]has-custom-background::before\s*\{([^}]*)\}/)?.[1];
  assert.match(layer, /z-index:\s*-1;/);
  assert.match(layer, /background-image:[^;]*var\(--custom-background-image\);/);
  assert.match(layer, /opacity:\s*var\(--background-image-alpha, 0[.]28\);/);
  // One rule for every material, so the image slider means the same thing under
  // native Liquid Glass as it does over the app's own glass.
  assert.doesNotMatch(css, /native-liquid-glass [.]shell[.]has-custom-background::before/);
  assert.match(css, /html[.]native-reduced-transparency [.]shell[.]has-custom-background::before\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(css, /linear-gradient\(var\(--glass\), var\(--glass\)\), var\(--custom-background-image\)/);
});

test('image opacity has its own slider, shown only while an image is set', () => {
  const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.match(html, /id="backgroundImageOpacityRow" class="[^"]*\bhidden\b/);
  assert.match(html, /id="backgroundImageOpacityInput" type="range" min="0" max="100"/);
  assert.match(app, /backgroundImageOpacityRow\?[.]classList[.]toggle\('hidden', !backgroundImageActive\)/);
  assert.match(app, /setProperty\('--background-image-alpha'/);
  // Native material locks the glass sliders; the image slider must stay usable.
  const locked = app.match(/for \(const control of \[([^\]]*)\]\) \{\n\s*if \(control\) control[.]disabled = nativeMaterial;/)?.[1];
  assert.ok(locked, 'native-material lock loop should exist');
  assert.doesNotMatch(locked, /backgroundImageOpacity/);
});
