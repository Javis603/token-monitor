'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { installBackgroundVideo } = require('../../src/electron/backgroundVideo');
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
    choose: () => handlers.get('appearance:chooseBackgroundImage')() };
}

test('image picker stages a private PNG and clears the video before publishing it', async (t) => {
  const f = await imagePickerFixture(t);
  const savedVideo = await f.manager.resolve(f.saved.url);
  const unlink = fs.promises.unlink.bind(fs.promises);
  let clears = 0;
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (file === savedVideo) {
      clears += 1;
      assert.equal((await getBackgroundImage(f.data)).toString(), 'saved-image');
      const temporary = (await fs.promises.readdir(f.data)).filter((name) => name.startsWith('.background-image-'));
      assert.equal(temporary.length, 1);
      const staged = path.join(f.data, temporary[0]);
      assert.deepEqual(await fs.promises.readFile(staged), f.output);
      if (process.platform !== 'win32') assert.equal((await fs.promises.stat(staged)).mode & 0o777, 0o600);
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
    else t.mock.method(fs.promises, 'writeFile', async () => { throw new Error('Disk full'); });

    if (outcome === 'canceled') assert.equal((await f.choose()).canceled, true);
    else await assert.rejects(f.choose(), outcome === 'invalid' ? /not supported/ : /Disk full/);

    assert.equal(clear.mock.callCount(), 0);
    assert.equal((await getBackgroundImage(f.data)).toString(), 'saved-image');
    assert.deepEqual(await f.manager.get(), f.saved);
    assert.deepEqual((await fs.promises.readdir(f.data)).sort(), before);
  });
}

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
