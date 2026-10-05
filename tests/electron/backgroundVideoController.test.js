'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { translate } = require('../../src/electron/renderer/i18n');

function fixture(withImage = false) {
  const classes = () => {
    const values = new Set();
    return { add: (v) => values.add(v), remove: (v) => values.delete(v), contains: (v) => values.has(v),
      toggle(v, enabled) { if (enabled) values.add(v); else values.delete(v); } };
  };
  const nodes = new Map();
  const styles = new Map();
  const shell = { classList: classes(), children: [], prepend(el) { this.children.unshift(el); },
    style: { setProperty: (name, value) => styles.set(name, value), removeProperty: (name) => styles.delete(name) } };
  class Element extends EventTarget { constructor() { super(); this.classList = classes(); } }
  class Video extends Element {
    constructor() { super(); this.paused = true; this.videoWidth = 320; this.videoHeight = 240; }
    setAttribute() {}
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event(this.src.includes('bad') ? 'error' : 'loadeddata'))); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    remove() { shell.children = shell.children.filter((x) => x !== this); }
  }
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    createElement() { return new Video(); }
  });
  const window = new EventTarget();
  let reduced = false;
  let shown = true;
  let blocked = false;
  let locale = 'en';
  let imageBusy = false;
  let commits = 0;
  const record = { id: 'saved', name: 'saved.mp4', url: 'video://good' };
  const api = {
    getBackgroundVideo: async () => record,
    chooseBackgroundVideo: async () => ({ preview: { id: 'bad', name: 'bad.mp4', url: 'video://bad' } }),
    commitBackgroundVideo: async () => { commits += 1; return record; },
    cancelBackgroundVideo: async () => {},
    clearBackgroundVideo: async () => {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/backgroundVideoController.js'), 'utf8'),
    { window, document, setTimeout, clearTimeout, console });
  let renderer;
  if (withImage) {
    window.tokenMonitor = api;
    let imageId = 0;
    const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
    const context = {
      window, document, Uint8Array, Blob,
      URL: { createObjectURL: () => `blob:image-${++imageId}`, revokeObjectURL() {} },
      els: { shell, ...Object.fromEntries(['backgroundImageStatus', 'clearBackgroundImageButton',
        'chooseBackgroundImageButton', 'backgroundImageOpacityRow'].map((id) => [id, document.getElementById(id)])) },
      t: (key, params) => translate(locale, key, params), nativeMaterialState: { type: 'vibrancy' },
      prefersReducedMotion: () => reduced, state: { windowVisible: true, floatingBubble: { collapsed: false } }
    };
    vm.runInNewContext(app.slice(app.indexOf('let backgroundImageActive ='), app.indexOf('const themePresetsApi =')) +
      '\nglobalThis.renderer = { controller: backgroundVideoController, changeImage: changeBackgroundImage, applyImage: applyBackgroundImage };', context);
    renderer = context.renderer;
  }
  const controller = renderer?.controller || window.TokenMonitorBackgroundVideo.createBackgroundVideoController({
    api, shell, t: (key, params) => translate(locale, key, params), imageActive: () => true,
    imageBusy: () => imageBusy,
    reducedMotion: () => reduced, visible: () => shown && !document.hidden, blocked: () => blocked
  });
  return { ...renderer, controller, shell, document, nodes, api, styles, isBlocked: window.TokenMonitorBackgroundVideo.isBackgroundVideoBlocked, commits: () => commits,
    setBlocked(value) { blocked = value; }, setLocale(value) { locale = value; }, setImageBusy(value) { imageBusy = value; },
    setReduced(value) { reduced = value; }, setShown(value) { shown = value; } };
}

test('an expanded floating-bubble state object does not hide the ordinary window video', () => {
  const f = fixture();
  assert.equal(f.isBlocked({ type: 'vibrancy' }, { collapsed: false, side: null }), false);
  assert.equal(f.isBlocked({ type: 'vibrancy' }, { collapsed: true, side: 'left' }), true);
  assert.equal(f.isBlocked({ type: 'opaque' }, { collapsed: false }), true);
  assert.equal(f.isBlocked({ type: 'vibrancy', reducedTransparency: true }, { collapsed: false }), true);
});

test('actual background controller loops muted, pauses when hidden/reduced-motion and resumes when visible', async () => {
  const f = fixture();
  await f.controller.load();
  const video = f.shell.children[0];
  assert.equal(video.muted, true);
  assert.equal(video.loop, true);
  assert.equal(video.paused, false);
  f.document.hidden = true;
  f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(video.paused, true);
  f.document.hidden = false;
  f.setReduced(true); f.controller.sync();
  assert.equal(video.paused, true);
  f.setReduced(false); f.controller.sync();
  assert.equal(video.paused, false);
  f.setBlocked(true); f.controller.sync();
  assert.equal(video.hidden, true);
  assert.equal(video.paused, true);
  f.setBlocked(false); f.controller.sync();
  assert.equal(video.hidden, false);
  assert.equal(video.paused, false);
  f.setShown(false); f.controller.sync();
  assert.equal(video.paused, true);
  await f.controller.clear();
  assert.equal(f.shell.classList.contains('has-background-video'), false);
  assert.equal(f.nodes.get('backgroundImageOpacityRow').classList.contains('hidden'), false);
});

test('a video that cannot decode never replaces the existing background', async () => {
  const f = fixture();
  await f.controller.load();
  const existing = f.shell.children[0];
  f.nodes.get('chooseBackgroundVideoButton').dispatchEvent(new Event('click'));
  await new Promise(setImmediate);
  assert.equal(f.commits(), 0);
  assert.equal(f.shell.children[0], existing);
  assert.match(f.nodes.get('backgroundVideoStatus').textContent, /Cannot play/);
});

test('canceling a picker preserves the video and image controls serialize selections', async () => {
  const f = fixture();
  await f.controller.load();
  const existing = f.shell.children[0];
  let finish;
  f.api.chooseBackgroundVideo = () => new Promise((resolve) => { finish = resolve; });
  f.nodes.get('chooseBackgroundVideoButton').dispatchEvent(new Event('click'));
  assert.equal(f.controller.isBusy(), true);
  assert.equal(f.nodes.get('chooseBackgroundImageButton').disabled, true);
  finish({ canceled: true });
  await new Promise(setImmediate);
  assert.equal(f.commits(), 0);
  assert.equal(f.shell.children[0], existing);
  assert.equal(f.controller.isBusy(), false);
  assert.equal(f.nodes.get('chooseBackgroundImageButton').disabled, false);
  f.setImageBusy(true); f.controller.sync();
  assert.equal(f.nodes.get('chooseBackgroundVideoButton').disabled, true);
});

test('late startup reads cannot restore a video after the user clears it', async () => {
  const f = fixture();
  let resolve;
  f.api.getBackgroundVideo = () => new Promise((done) => { resolve = done; });
  const loading = f.controller.load();
  await f.controller.clear();
  resolve({ id: 'old', name: 'old.mp4', url: 'video://good' });
  await loading;
  assert.equal(f.shell.children.length, 0);
  assert.equal(f.shell.classList.contains('has-background-video'), false);
});

test('clearing a video blocks new selections and repeated removal until it finishes', async () => {
  const f = fixture();
  await f.controller.load();
  let finish;
  let clears = 0;
  let selections = 0;
  f.api.clearBackgroundVideo = () => {
    clears += 1;
    return new Promise((resolve) => { finish = resolve; });
  };
  f.api.chooseBackgroundVideo = async () => {
    selections += 1;
    return { canceled: true };
  };

  const clearing = f.controller.clear();
  assert.equal(f.controller.isBusy(), true);
  for (const id of ['chooseBackgroundVideoButton', 'clearBackgroundVideoButton', 'chooseBackgroundImageButton', 'clearBackgroundImageButton']) {
    assert.equal(f.nodes.get(id).disabled, true);
  }
  f.nodes.get('chooseBackgroundVideoButton').dispatchEvent(new Event('click'));
  f.nodes.get('clearBackgroundVideoButton').dispatchEvent(new Event('click'));
  assert.equal(selections, 0);
  assert.equal(clears, 1);

  finish();
  await clearing;
  assert.equal(f.controller.isBusy(), false);
  assert.equal(f.shell.children.length, 0);
  assert.equal(f.nodes.get('chooseBackgroundVideoButton').disabled, false);
  assert.equal(f.nodes.get('chooseBackgroundImageButton').disabled, false);
});

test('a presentation reset removes video without a second clear while image controls are busy', async () => {
  const f = fixture();
  await f.controller.load();
  let clears = 0;
  f.api.clearBackgroundVideo = async () => { clears += 1; };
  f.setImageBusy(true);

  f.controller.reset();

  assert.equal(clears, 0);
  assert.equal(f.shell.children.length, 0);
  assert.equal(f.controller.isBusy(), false);
  assert.equal(f.nodes.get('chooseBackgroundImageButton').disabled, true);
  f.setImageBusy(false); f.controller.sync();
  assert.equal(f.nodes.get('chooseBackgroundImageButton').disabled, false);
});

test('a presentation reset invalidates a late startup video read', async () => {
  const f = fixture();
  let finish;
  f.api.getBackgroundVideo = () => new Promise((resolve) => { finish = resolve; });
  const loading = f.controller.load();
  f.controller.reset();
  finish({ id: 'old', name: 'old.mp4', url: 'video://good' });
  await loading;
  assert.equal(f.shell.children.length, 0);
  assert.equal(f.shell.classList.contains('has-background-video'), false);
});

test('the image renderer keeps controls busy and displays the committed image without clearing video twice', async () => {
  const f = fixture(true);
  f.applyImage(Buffer.from('old-image'));
  await f.controller.load();
  const oldImage = f.styles.get('--custom-background-image');
  let finish;
  let selections = 0;
  let clears = 0;
  f.api.chooseBackgroundImage = () => {
    selections += 1;
    return new Promise((resolve) => { finish = resolve; });
  };
  f.api.clearBackgroundVideo = async () => { clears += 1; throw new Error('Unexpected second clear'); };

  const choosing = f.changeImage();
  for (const id of ['chooseBackgroundVideoButton', 'clearBackgroundVideoButton', 'chooseBackgroundImageButton', 'clearBackgroundImageButton']) {
    assert.equal(f.nodes.get(id).disabled, true);
  }
  await f.changeImage();
  f.nodes.get('clearBackgroundVideoButton').dispatchEvent(new Event('click'));
  assert.equal(selections, 1);
  assert.equal(clears, 0);
  assert.equal(f.styles.get('--custom-background-image'), oldImage);
  finish({ bytes: Buffer.from('committed-image') });
  await choosing;

  assert.equal(clears, 0);
  assert.notEqual(f.styles.get('--custom-background-image'), oldImage);
  assert.equal(f.shell.children.length, 0);
  assert.equal(f.shell.classList.contains('has-background-video'), false);
  assert.equal(f.nodes.get('clearBackgroundVideoButton').classList.contains('hidden'), true);
  assert.equal(f.nodes.get('chooseBackgroundImageButton').disabled, false);
  assert.equal(f.nodes.get('chooseBackgroundVideoButton').disabled, false);
});

for (const outcome of ['canceled', 'failed']) {
  test(`a ${outcome} image choice preserves the rendered image and video`, async () => {
    const f = fixture(true);
    f.applyImage(Buffer.from('old-image'));
    await f.controller.load();
    const oldImage = f.styles.get('--custom-background-image');
    const oldVideo = f.shell.children[0];
    f.api.chooseBackgroundImage = async () => {
      if (outcome === 'failed') throw new Error('Cannot remove video');
      return { canceled: true };
    };

    await f.changeImage();

    assert.equal(f.styles.get('--custom-background-image'), oldImage);
    assert.equal(f.shell.children[0], oldVideo);
    assert.equal(f.nodes.get('chooseBackgroundImageButton').disabled, false);
    assert.equal(f.nodes.get('chooseBackgroundVideoButton').disabled, false);
    if (outcome === 'failed') assert.match(f.nodes.get('backgroundImageStatus').textContent, /saving or cleaning/);
  });
}

test('a failed clear releases the busy state and preserves the existing video', async () => {
  const f = fixture();
  await f.controller.load();
  const existing = f.shell.children[0];
  f.api.clearBackgroundVideo = async () => { throw new Error('Cannot remove saved video'); };

  await assert.rejects(f.controller.clear(), /Cannot remove saved video/);

  assert.equal(f.controller.isBusy(), false);
  assert.equal(f.shell.children[0], existing);
  assert.equal(f.shell.classList.contains('has-background-video'), true);
  assert.equal(f.nodes.get('clearBackgroundVideoButton').classList.contains('hidden'), false);
  assert.equal(f.nodes.get('chooseBackgroundVideoButton').disabled, false);
  assert.equal(f.nodes.get('chooseBackgroundImageButton').disabled, false);
});

test('video status and shared opacity controls follow live language changes', async () => {
  const f = fixture();
  await f.controller.load();
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ko', 'ja']) {
    f.setLocale(locale); f.controller.sync();
    assert.equal(f.nodes.get('backgroundVideoStatus').textContent,
      translate(locale, 'settings.appearance.backgroundVideoActive', { name: 'saved.mp4' }));
    assert.equal(f.nodes.get('backgroundImageOpacityLabel').textContent,
      translate(locale, 'settings.appearance.backgroundOpacity'));
  }
  await f.controller.clear();
  assert.equal(f.nodes.get('backgroundImageOpacityLabel').textContent,
    translate('ja', 'settings.appearance.backgroundImageOpacity'));
});


test('an image cleanup failure reloads the committed PNG and replaces a deleted video with a retryable cleanup state', async () => {
  const f = fixture(true);
  f.applyImage(Buffer.from('old-image'));
  await f.controller.load();
  const oldImage = f.styles.get('--custom-background-image');
  let reads = 0;
  f.api.getBackgroundImage = async () => { reads += 1; return Buffer.from('committed-image'); };
  f.api.getBackgroundVideo = async () => ({ cleanupPending: true });
  f.api.chooseBackgroundImage = async () => { throw new Error('Metadata cleanup failed'); };
  await f.changeImage();
  assert.equal(reads, 1);
  assert.notEqual(f.styles.get('--custom-background-image'), oldImage);
  assert.equal(f.shell.children.length, 0);
  assert.equal(f.nodes.get('clearBackgroundVideoButton').classList.contains('hidden'), false);
  assert.equal(f.nodes.get('clearBackgroundVideoButton').disabled, false);
  assert.match(f.nodes.get('backgroundImageStatus').textContent, /saving or cleaning/);
  assert.match(f.nodes.get('backgroundVideoStatus').textContent, /Remove video to retry/);
  f.api.clearBackgroundVideo = async () => {};
  await f.controller.clear();
  assert.equal(f.nodes.get('clearBackgroundVideoButton').classList.contains('hidden'), true);
});

test('a post-deletion clear failure releases the missing video and offers metadata cleanup retry', async () => {
  const f = fixture();
  await f.controller.load();
  f.api.getBackgroundVideo = async () => ({ cleanupPending: true });
  f.api.clearBackgroundVideo = async () => { throw new Error('Manifest locked'); };
  await assert.rejects(f.controller.clear(), /Manifest locked/);
  assert.equal(f.shell.children.length, 0);
  assert.equal(f.shell.classList.contains('has-background-video'), false);
  assert.equal(f.nodes.get('clearBackgroundVideoButton').classList.contains('hidden'), false);
  assert.equal(f.controller.isBusy(), false);
  assert.match(f.nodes.get('backgroundVideoStatus').textContent, /Remove video to retry/);
});

test('a committed video with failed old-copy cleanup is displayed and reports a storage error', async () => {
  const f = fixture();
  await f.controller.load();
  f.api.chooseBackgroundVideo = async () => ({ preview: { id: 'new', name: 'new.mp4', url: 'video://good-new' } });
  f.api.getBackgroundVideo = async () => ({ id: 'new', name: 'new.mp4', url: 'video://good-new', cleanupPending: true });
  f.api.commitBackgroundVideo = async () => { throw new Error('Retired file locked'); };
  f.nodes.get('chooseBackgroundVideoButton').dispatchEvent(new Event('click'));
  await new Promise(setImmediate);
  assert.equal(f.shell.children[0].src, 'video://good-new');
  assert.equal(f.controller.isBusy(), false);
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ko', 'ja']) {
    f.setLocale(locale); f.controller.sync();
    const message = f.nodes.get('backgroundVideoStatus').textContent;
    assert.equal(message, translate(locale, 'settings.appearance.backgroundVideoCleanupError'));
    assert.notEqual(message, translate(locale, 'settings.appearance.backgroundVideoError'));
  }
});


test('real storage reconciliation releases deleted video even while image-journal cleanup stays locked', async (t) => {
  const os = require('node:os');
  const { createBackgroundVideoManager } = require('../../src/electron/backgroundVideo');
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'background-renderer-recovery-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  await fs.promises.mkdir(data);
  const source = path.join(directory, 'source.mp4');
  const image = path.join(directory, 'source.png');
  await fs.promises.writeFile(source, 'video');
  await fs.promises.writeFile(image, 'source-image');
  await fs.promises.writeFile(path.join(data, 'background-image.png'), 'old-image');
  const manager = createBackgroundVideoManager(data);
  const preview = await manager.prepare(source);
  await manager.commit(preview.id);
  const f = fixture(true);
  f.api.getBackgroundVideo = () => manager.get();
  f.api.getBackgroundImage = () => manager.getImage();
  f.applyImage(await manager.getImage());
  await f.controller.load();
  const oldImage = f.styles.get('--custom-background-image');
  const nativeImage = { createFromBuffer: () => ({
    isEmpty: () => false, getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from('new-image')
  }) };
  f.api.chooseBackgroundImage = async () => ({ bytes: await manager.importImage(image, nativeImage) });
  const unlink = fs.promises.unlink.bind(fs.promises);
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (file === path.join(data, '.background-image-recovery.json')) throw new Error('Journal locked');
    return unlink(file);
  });
  await f.changeImage();
  assert.equal((await manager.getImage()).toString(), 'new-image');
  assert.notEqual(f.styles.get('--custom-background-image'), oldImage);
  assert.equal(f.shell.children.length, 0);
  assert.equal(f.nodes.get('clearBackgroundVideoButton').classList.contains('hidden'), false);
  assert.match(f.nodes.get('backgroundVideoStatus').textContent, /Remove video to retry/);
});
