'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { isGeneratedTrayIconMode } = require('../../src/shared/trayText');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
function fixture() {
  const services = [];
  const state = { visible: true, minimized: false, dark: false, observations: 0, resets: 0, schedules: 0, opens: 0 };
  const win = { isDestroyed: () => false, isVisible: () => state.visible, isMinimized: () => state.minimized, webContents: {} };
  const context = {
    trayImageTimer: null, trayImageService: null, trayImageHealthy: false, trayArtworkKey: '',
    trayRendererVisibility: new WeakMap(), trayRendererGeneration: new WeakMap(),
    rendererSnapshots: { clear() {} }, presentationCache: { clear() {} }, allTimeSessionsCache: { clear() {} }, mainWindow: win, lightweightViewState: null,
    reopeningWindows: new WeakSet(),
    settings: { lightweightMode: true, trayContent: 'custom' }, tray: { isDestroyed: () => false }, quitRequested: false,
    process: { platform: 'darwin' }, latestStats: { periods: {} },
    trayRateTracker: { observe() { state.observations += 1; }, reset() { state.resets += 1; }, samples: () => ({}), nextExpiryAt: () => Infinity },
    createTrayImageService(options) {
      const service = { options, stopped: false, updates: [], update(input) { this.updates.push(input); }, stop() { this.stopped = true; } };
      services.push(service); return service;
    },
    BrowserWindow: {}, ipcMain: {}, applyTrayIcons() {}, updateTrayDisplay() {},
    lightweightWindow: { schedule() { state.schedules += 1; }, cancel() {} },
    electronPresentationStats: stats => stats, codexAccountsForRenderer: () => [],
    codexPresentationPendingAccountId: '', codexPresentationActiveAccountId: '', hubModeGeneration: 1,
    currentSystemDarkTrayUi: () => state.dark, effectiveRates: {}, trayMenuLocale: () => 'en',
    localLiveCodexProvider: () => null, trayRenderInput: (stats, settings, extra) => ({ stats, settings, ...extra }),
    isGeneratedTrayIconMode, trayLayoutNeedsClock: () => false,
    clearTimeout() {}, setTimeout() { throw Error('unexpected clock timer'); },
    focusExistingWindow() { state.opens += 1; context.mainWindow = win; }
  };
  const start = source.indexOf('function stopTrayImageService(');
  vm.runInNewContext(source.slice(start, source.indexOf('\nlet dashboardWindow', start)), context);
  return { state, context, win, services, update: () => context.updateIndependentTrayImages() };
}

test('foreground UI paints; occlusion, minimize and native hide hand off to one independent painter', () => {
  const f = fixture();
  f.update(); assert.equal(f.services.length, 0);
  f.context.trayRendererVisibility.set(f.win.webContents, false);
  f.update(); f.update();
  assert.equal(f.services.length, 1, 'occlusion is distinct from native visibility');
  f.context.trayRendererVisibility.set(f.win.webContents, true);
  f.update(); assert.equal(f.services[0].stopped, true);
  assert.equal(f.state.resets, 0, 'handoff preserves main rate observations');
  f.state.minimized = true; f.update(); assert.equal(f.services.length, 2);
  f.state.minimized = false; f.update(); assert.equal(f.services[1].stopped, true);
  f.state.visible = false; f.update(); assert.equal(f.services.length, 3);
  f.services[2].options.applyIcons({ app: 'png', custom: 'png' });
  assert.equal(f.context.trayImageHealthy, true);
  assert.ok(f.state.schedules > 0);
  f.context.mainWindow = null; f.update(); assert.equal(f.services.length, 3, 'painter survives UI reclamation');
});

test('static tray artwork is painted once; theme/badge changes repaint without a permanent helper', () => {
  const f = fixture(); f.state.visible = false; f.context.settings.trayContent = 'tokens';
  f.update(); f.services[0].options.applyIcons({ app: 'png' });
  assert.equal(f.services[0].stopped, true);
  f.update(); assert.equal(f.services.length, 1);
  assert.equal(f.context.trayImageHealthy, true);
  f.state.dark = true; f.update(); assert.equal(f.services.length, 2);
  assert.equal(f.context.trayImageHealthy, false, 'old cached artwork does not certify the replacement painter');
  f.services[1].options.applyIcons({ app: 'dark-png' });
  f.context.settings.showTrayProviderBadge = true; f.update(); assert.equal(f.services.length, 3);
  f.services[2].options.applyIcons({ app: 'badge-png' });
  f.context.settings.trayContent = 'liveTokenRate'; f.update(); assert.equal(f.services.length, 4);
  f.services[3].options.applyIcons({ liveTokenRate: 'rate-png' });
  assert.equal(f.services[3].stopped, false, 'generated modes keep background clock/rate painting');
});

test('disabling after static idle reclamation restores the UI even with no remaining helper window', () => {
  const f = fixture(); f.context.mainWindow = null; f.context.lightweightViewState = { scrollTop: 12 };
  f.context.settings.lightweightMode = false; f.update();
  assert.equal(f.state.opens, 1);
  assert.equal(f.state.resets, 1);
});

test('visibility and artwork IPC reject other windows and retired renderer senders', () => {
  const f = fixture(); const listeners = {}, handlers = {};
  f.context.ipcMain = { on: (channel, callback) => { listeners[channel] = callback; }, handle: (channel, callback) => { handlers[channel] = callback; } };
  const start = source.indexOf("  ipcMain.on('tray:rendererVisibility'");
  const end = source.indexOf("  ipcMain.handle('stats:get'", start);
  vm.runInNewContext(source.slice(start, end), f.context);
  listeners['tray:rendererVisibility']({ sender: {} }, false); assert.equal(f.services.length, 0);
  listeners['tray:rendererVisibility']({ sender: f.win.webContents }, 'false'); assert.equal(f.services.length, 0);
  listeners['tray:rendererVisibility']({ sender: f.win.webContents }, false); assert.equal(f.services.length, 1);
  assert.equal(handlers['tray:setIcons']({ sender: {} }, {}), false);
  assert.equal(handlers['tray:setIcons']({ sender: f.win.webContents }, {}), false, 'paused renderer cannot overwrite background painter');
  listeners['tray:rendererVisibility']({ sender: f.win.webContents }, true);
  assert.equal(handlers['tray:setIcons']({ sender: f.win.webContents }, {}), true);
});

test('clock and rate timers transfer to the background painter and stop on foreground return', () => {
  const f = fixture(); const timers = [], cleared = [];
  f.context.trayLayoutNeedsClock = () => true;
  f.context.setTimeout = (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; };
  f.context.clearTimeout = timer => { if (timer) cleared.push(timer); };
  f.context.trayRendererVisibility.set(f.win.webContents, false);
  f.update(); assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= 29_990 && timers[0].ms <= 30_020);
  timers[0].callback(); assert.equal(f.services[0].updates.length, 2);
  f.context.trayRendererVisibility.set(f.win.webContents, true); f.update();
  assert.equal(f.services[0].stopped, true);
  assert.equal(f.context.trayImageTimer, null);
  assert.ok(cleared.includes(timers.at(-1)));
  assert.equal(f.state.resets, 0);
});

test('a crashed or unresponsive main renderer hands off painting; retired windows cannot take it over', () => {
  const f = fixture(); const wcEvents = {}, events = {};
  f.win.on = (name, callback) => { events[name] = callback; };
  f.win.webContents.on = (name, callback) => { wcEvents[name] = callback; };
  f.context.win = f.win;
  let visibilityRequests = 0;
  f.context.sendMainWindowVisibility = () => { visibilityRequests += 1; };
  const start = source.indexOf('  const trayRendererUnavailable =');
  const end = source.indexOf("  win.webContents.on('did-finish-load'", start);
  vm.runInNewContext(source.slice(start, end), f.context);
  wcEvents['render-process-gone'](); assert.equal(f.services.length, 1);
  f.context.trayRendererVisibility.set(f.win.webContents, true); f.update();
  events.unresponsive(); assert.equal(f.services.length, 2);
  events.responsive(); assert.equal(visibilityRequests, 1, 'renderer must confirm visibility before returning ownership');
  f.context.mainWindow = null;
  wcEvents['render-process-gone'](); assert.equal(f.services.length, 2, 'old callback cannot reassign ownership');
});
