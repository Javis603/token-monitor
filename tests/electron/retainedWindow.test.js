'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createRetainedWindow, restoreRetainedWindowState } = require('../../src/electron/retainedWindow');

test('frame-starved visible restores complete via synchronous fallback before the queue continues', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const win = f.create({ width: 400, height: 600, show: true });
  const scripts = [];
  let finishFallback;
  win.webContents.executeJavaScript = script => {
    scripts.push(script);
    return scripts.length === 1 ? new Promise(() => {}) : new Promise(resolve => { finishFallback = resolve; });
  };
  let complete = false;
  const restored = restoreRetainedWindowState(win).then(() => { complete = true; });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(scripts.length, 2);
  assert.match(scripts[1], /"afterPaint":false/);
  assert.equal(complete, false, 'the queue must wait until the fallback actually restores the page');
  finishFallback();
  await restored;
  assert.equal(complete, true);
});

test('hidden restores retain the viewport until show and obsolete owners cannot replay it', async () => {
  const f = fixture();
  const old = f.create({ width: 400, height: 600, show: false });
  const scripts = [];
  old.webContents.executeJavaScript = async script => { scripts.push(script); };
  await restoreRetainedWindowState(old);
  assert.match(scripts[0], /"releaseSnapshot":false/);
  const win = f.create({ width: 400, height: 600, show: true }, old);
  old.emit('show');
  assert.equal(scripts.length, 1, 'a delayed show on an obsolete host must not touch the transferred page');
  await restoreRetainedWindowState(win);
  assert.match(scripts[1], /"releaseSnapshot":true/);
});

function fixture() {
  const views = [];
  class BaseWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.size = [options.width, options.height];
      this.contentView = { addChildView: view => { this.view = view; } };
    }
    getContentSize() { return this.size; }
    isDestroyed() { return this.destroyed === true; }
    isVisible() { return this.options.show === true; }
    isMinimized() { return false; }
    setTitle(title) { this.title = title; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  class WebContentsView {
    constructor(options) {
      this.options = options;
      const webContents = new EventEmitter();
      Object.assign(webContents, {
        closes: 0, focuses: 0, getTitle: () => 'Token Monitor',
        isDestroyed: () => webContents.closes > 0,
        close: () => webContents.closes++, focus: () => webContents.focuses++
      });
      this.webContents = webContents;
      views.push(this);
    }
    setBackgroundColor(color) { this.color = color; }
    setBounds(bounds) { this.bounds = bounds; }
  }
  return { views, create: (options, previous) => createRetainedWindow({ BaseWindow, WebContentsView }, options, previous) };
}

test('changing transparency and mini-window chrome retains a single page across repeated host transfers', () => {
  const f = fixture();
  let win = f.create({ width: 400, height: 600, transparent: false, webPreferences: { contextIsolation: true } });
  const page = win.webContents;
  for (const options of [
    { width: 400, height: 600, transparent: true },
    { width: 18, height: 34, thickFrame: false },
    { width: 400, height: 600, transparent: false }
  ]) {
    const old = win;
    win = f.create(options, old);
    old.destroy();
    assert.equal(win.webContents, page);
    assert.equal(page.isDestroyed(), false, 'closing the old host must leave the page alive');
    const bounds = { ...f.views[0].bounds };
    old.size = [999, 999];
    old.emit('resize');
    assert.deepEqual(f.views[0].bounds, bounds, 'old host events cannot resize the retained view');
  }
  assert.equal(f.views.length, 1);
  assert.deepEqual(f.views[0].options.webPreferences, { contextIsolation: true });
  win.destroy();
  assert.equal(page.closes, 1, 'closing the final host releases its page exactly once');
});

test('content sizing, keyboard focus and title follow only the current owner', () => {
  const f = fixture();
  const old = f.create({ width: 400, height: 600 });
  const win = f.create({ width: 18, height: 34 }, old);
  const page = win.webContents;
  assert.equal(win.title, 'Token Monitor');
  win.size = [80, 34]; win.emit('resize');
  assert.deepEqual(f.views[0].bounds, { x: 0, y: 0, width: 80, height: 34 });
  old.emit('focus');
  assert.equal(page.focuses, 0);
  win.emit('focus');
  assert.equal(page.focuses, 1);
  page.emit('page-title-updated', {}, 'Updated title');
  assert.equal(win.title, 'Updated title');
  assert.equal(old.title, 'Token Monitor');
  assert.equal(page.listenerCount('page-title-updated'), 1);
});
