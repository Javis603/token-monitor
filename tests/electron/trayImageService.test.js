'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createTrayImageService, createTrayRateTracker, trayRenderInput } = require('../../src/electron/trayImageService');

function fixture() {
  const ipcMain = new EventEmitter();
  const windows = [];
  const applied = [];
  const timers = new Map();
  let sequence = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel, payload) => this.sent.push({ channel, payload });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    async loadFile() {}
  }
  const service = createTrayImageService({
    BrowserWindow: Window, ipcMain, applyIcons: (icons) => applied.push(icons),
    setTimer: (callback, ms) => { const id = ++sequence; timers.set(id, { callback, ms }); return id; },
    clearTimer: (id) => timers.delete(id)
  });
  const ready = () => ipcMain.emit('trayImage:ready', { sender: windows.at(-1).webContents });
  const answer = (win = windows.at(-1), icons = { custom: 'png' }) => {
    ipcMain.emit('trayImage:rendered', { sender: win.webContents }, { id: win.sent.at(-1)?.payload.id, icons });
  };
  return { service, windows, ipcMain, applied, timers, ready, answer };
}
const input = (dark = false) => ({ settings: { showTrayProviderBadge: false }, platform: 'win32', systemDarkUi: dark });

test('one sandboxed painter coalesces updates and rejects obsolete artwork', () => {
  const f = fixture();
  f.service.update(input());
  const win = f.windows[0];
  assert.equal(win.options.show, false);
  assert.deepEqual([win.options.webPreferences.sandbox, win.options.webPreferences.nodeIntegration], [true, false]);
  f.ready();
  assert.equal(win.sent[0].payload.input.renderArtwork, true);
  f.service.update(input(true));
  f.service.update(input(true));
  f.answer();
  assert.equal(f.applied.length, 0);
  assert.equal(win.sent.length, 2);
  assert.equal(win.sent[1].payload.input.systemDarkUi, true);
  assert.equal(win.sent[1].payload.input.renderArtwork, true);
  f.answer();
  assert.equal(f.applied.length, 1);
  f.service.update(input(true));
  assert.equal(win.sent[2].payload.input.renderArtwork, false);
  assert.equal(f.windows.length, 1);
  f.service.stop();
});

test('foreign, duplicate and previous-window responses cannot update the tray', () => {
  const f = fixture();
  f.service.update(input());
  f.ready();
  const win = f.windows[0];
  f.ipcMain.emit('trayImage:rendered', { sender: {} }, { id: win.sent[0].payload.id, icons: { custom: 'foreign' } });
  assert.equal(f.applied.length, 0);
  f.answer();
  f.answer();
  assert.equal(f.applied.length, 1);
  f.service.stop();
  f.answer();
  assert.equal(f.applied.length, 1);
  assert.equal(f.ipcMain.listenerCount('trayImage:ready'), 0);
  assert.equal(f.ipcMain.listenerCount('trayImage:rendered'), 0);
  assert.equal(f.timers.size, 0);
});

test('a crashed painter is disposed and retries without a hot restart loop', () => {
  const f = fixture();
  f.service.update(input());
  f.ready();
  const old = f.windows[0];
  old.webContents.emit('render-process-gone');
  assert.equal(old.destroyed, true);
  assert.equal(f.windows.length, 1);
  assert.equal(f.timers.size, 1);
  const [id, retry] = [...f.timers.entries()][0];
  assert.equal(retry.ms, 5000);
  f.timers.delete(id);
  retry.callback();
  f.ready();
  f.answer(old);
  assert.equal(f.applied.length, 0);
  f.answer();
  assert.equal(f.applied.length, 1);
  f.service.stop();
});

test('failed render results retain last-good icons and restart the painter', () => {
  const f = fixture();
  f.service.update(input());
  f.ready();
  const win = f.windows[0];
  f.ipcMain.emit('trayImage:rendered', { sender: win.webContents }, { id: win.sent[0].payload.id, error: true });
  assert.equal(f.applied.length, 0);
  assert.equal(win.destroyed, true);
  f.service.stop();
  assert.equal(f.timers.size, 0);
});

test('painter DTO excludes credentials, sessions, projects, devices and source settings', () => {
  const result = trayRenderInput({
    devices: [{ secret: 'private' }],
    periods: { today: { totalTokens: 42, clients: { codex: 42 }, sessions: { private: {} }, projects: { private: {} } } },
    limits: { providers: [] }
  }, { trayContent: 'tokens', secret: 'never-send', deviceId: 'private', thirdPartyProfiles: { token: 'secret' } });
  assert.equal(result.settings.trayContent, 'tokens');
  assert.equal(result.stats.periods.today.totalTokens, 42);
  assert.doesNotMatch(JSON.stringify(result), /private|never-send|"secret"|sessions|projects|devices/);
});

test('live-rate history remains in main across painter rebuilds and expires without stats pushes', () => {
  let now = 1000;
  const tracker = createTrayRateTracker({ now: () => now });
  const settings = { trayContent: 'liveTokenRate', hubMode: 'local', deviceId: 'local' };
  const stats = (tokens, duration) => ({ periods: { today: { timedTokens: tokens, timedOutputTokens: tokens, timedDurationMs: duration } } });
  tracker.observe(stats(100, 1000), settings, 1);
  now += 1000;
  tracker.observe(stats(200, 2000), settings, 1);
  // The service/painter is deliberately absent from this tracker: rendering
  // restarts must not reset the sample baseline.
  assert.ok(tracker.samples().device);
  assert.ok(Number.isFinite(tracker.nextExpiryAt()));
  now += 200_000;
  assert.equal(tracker.samples().device, null);
  tracker.observe(stats(200, 2000), settings, 2);
  assert.equal(tracker.samples().device, null);
  now += 1000;
  tracker.observe(stats(300, 3000), settings, 2);
  assert.ok(tracker.samples().device);
  tracker.reset();
  now += 60_000;
  tracker.observe(stats(1000, 10_000), settings, 2);
  assert.equal(tracker.samples().device, null, 'reenabling starts a baseline rather than inventing a fresh hidden-interval rate');
});
