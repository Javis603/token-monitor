'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { translate } = require('../../src/electron/renderer/i18n');

function fixture() {
  const classes = () => {
    const values = new Set();
    return { add: (v) => values.add(v), remove: (v) => values.delete(v), contains: (v) => values.has(v),
      toggle(v, enabled) { if (enabled) values.add(v); else values.delete(v); } };
  };
  const nodes = new Map();
  const shell = { classList: classes(), children: [], prepend(el) { this.children.unshift(el); } };
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
  const controller = window.TokenMonitorBackgroundVideo.createBackgroundVideoController({
    api, shell, t: (key, params) => translate(locale, key, params), imageActive: () => true,
    imageBusy: () => imageBusy,
    reducedMotion: () => reduced, visible: () => shown && !document.hidden, blocked: () => blocked
  });
  return { controller, shell, document, nodes, api, isBlocked: window.TokenMonitorBackgroundVideo.isBackgroundVideoBlocked, commits: () => commits,
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
