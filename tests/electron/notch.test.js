'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createNotchController, springState, springDuration, NOTCH_SPRINGS, normalizeNotchHoverAction, normalizeNotchHoverDelay, SCROLL_GESTURE_GAP_MS } = require('../../src/electron/notch/controller');
const { NOTCH_METRICS, notchCanvasBounds, notchGeometry, notchMaxHeight, notchBounds, notchCommands, translateCommands, interpolateCommands } = require('../../src/electron/notch/geometry');
const { buildNotchData: projectNotchData, notchSummaryMode, summaryLayout } = require('../../src/electron/notch/data');
const { NOTCH_PANEL_STAT_ITEMS, notchLimitItems, notchPanelItems, notchWeek } = require('../../src/electron/notch/panel');
// These existing cases exercise the tray/custom contracts. Automatic mode has
// its own data and interaction coverage in notchPanel.test.js.
function buildNotchData(stats, cells, settings, options) {
  const preferences = Object.create(null, Object.getOwnPropertyDescriptors(settings || {}));
  if (preferences.notchSummaryMode === undefined) preferences.notchSummaryMode = 'tray';
  return projectNotchData(stats, cells, preferences, options);
}
const { EDGE_DOCK_TIMING, EDGE_DOCK_METRICS } = require('../../src/electron/edgeDock/geometry');
const { createEdgeDockController } = require('../../src/electron/edgeDock/controller');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');
const { RUNNING_WINDOW_MS } = require('../../src/shared/sessionLive');
const trayLayout = require('../../src/shared/trayLayout');
const { parseBoolean } = require('../../src/shared/limits/collector');

const mainSource = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const configuredDockItemsSource = mainSource.slice(mainSource.indexOf('function configuredDockItemLists('), mainSource.indexOf('function edgeDockShowsLiveRate('));
const dockForecastSource = configuredDockItemsSource
  + mainSource.slice(mainSource.indexOf('const EDGE_DOCK_FORECAST_REFRESH_MS'), mainSource.indexOf('function edgeDockCellsFor('));

const display = { id: 1, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1470, height: 956 }, workArea: { x: 0, y: 33, width: 1470, height: 923 } };
const native = { displayId: 1, frame: { origin: { x: 0, y: 0 }, size: { width: 1470, height: 956 } }, safeTop: 32,
  left: { origin: { x: 0, y: 924 }, size: { width: 646, height: 32 } },
  right: { origin: { x: 825, y: 924 }, size: { width: 645, height: 32 } } };
class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; this.bounds = { x: 0, y: 0, width: options.width, height: options.height }; this.webContents = new EventEmitter(); this.messages = []; this.webContents.send = (channel, payload) => this.messages.push({ channel, payload }); this.webContents.setWindowOpenHandler = () => {}; this.webContents.setZoomFactor = () => {}; }
  loadFile(_file, options) { this.query = options.query; return Promise.resolve(); }
  setBounds(value) { this.bounds = { ...value }; }
  getBounds() { return this.bounds; }
  isDestroyed() { return this.destroyed === true; }
  isVisible() { return this.shown === true; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  setOpacity(value) { this.opacity = value; }
  getOpacity() { return this.opacity; }
  setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setVibrancy() {}
  setHasShadow() {}
  showInactive() { this.shown = true; }
  hide() { this.shown = false; }
  getMediaSourceId() { return `window:${this.options.width}:0`; }
  moveAbove(id) { this.above = id; }
}
class Ipc extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); }
  handle(name, fn) { assert.equal(this.handlers.has(name), false, `duplicate ${name}`); this.handlers.set(name, fn); }
  removeHandler(name) { this.handlers.delete(name); }
}
function fixture(t, settings = {}, options = {}) {
  const windows = [];
  class RecordingWindow extends Window {
    constructor(windowOptions) { super(windowOptions); windows.push(this); }
    loadFile(file, loadOptions) { return options.loadFile ? options.loadFile(file, loadOptions) : super.loadFile(file, loadOptions); }
  }
  const ipcMain = new Ipc();
  const screen = new EventEmitter();
  screen.point = { x: 20, y: 400 };
  screen.getAllDisplays = () => [display]; screen.getPrimaryDisplay = () => display;
  screen.getCursorScreenPoint = () => screen.point;
  // Most cases exercise opening on hover; the default grow-only mode has its own cases.
  const preferences = { notchEnabled: true, edgeDockEnabled: false, notchHoverAction: 'open', ...settings };
  const deps = { BrowserWindow: RecordingWindow, ipcMain, screen, rendererDir: '/renderer', preloadPath: '/preload', getSettings: () => preferences, nativeGlass: options.nativeGlass || (() => false), liquidGlass: options.liquidGlass, createGlass: options.createGlass, prefersReducedMotion: () => options.reducedMotion !== false, platform: options.platform || 'darwin' };
  const controller = createNotchController({ ...deps, readScreens: options.readScreens || (() => ({ screens: [native], mainDisplayId: 1 })), onSwitchCodexAccount: (id) => ({ ok: true, id }), onToggleRateMode: options.onToggleRateMode, onCapabilitiesChanged: options.onCapabilitiesChanged, installNonActivatingInput: options.installNonActivatingInput, primaryButtonDown: options.primaryButtonDown || (() => false), naturalScrolling: options.naturalScrolling, monitorScrollGesture: options.monitorScrollGesture, isFullScreen: options.isFullScreen || (() => false), logger: options.logger, performHaptic: options.performHaptic, canRefreshLimits: options.canRefreshLimits, onRefreshLimits: options.onRefreshLimits, blurAvailable: options.blurAvailable, applyBlurMask: options.applyBlurMask });
  t.after(() => controller.dispose());
  const setData = controller.setData;
  controller.setData = (value) => {
    setData(value);
    // Most controller cases model a renderer that completes initial sizing.
    // Startup-specific cases opt out and exercise the handshake explicitly.
    if (options.measureSummary === false) return;
    const win = windows.findLast(win => win.query?.surface === 'notch' && !win.destroyed), measurement = last(win)?.summaryMeasurement;
    if (!measurement?.measuring) return;
    ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots: { left: 17, right: 42, minimumLeft: 17, minimumRight: 42 }, summaryMeasurement: { id: measurement.id } });
    ipcMain.emit('topNotch:size', { sender: win.webContents }, { summaryMeasurement: { id: last(win)?.summaryMeasurement?.id, ready: true } });
  };
  controller.sync();
  for (const win of windows) ipcMain.emit('topNotch:ready', { sender: win.webContents });
  return { controller, windows, deps, ipcMain, screen, preferences };
}
function last(win) { return win.messages.filter((message) => message.channel === 'topNotch:render').at(-1)?.payload; }
function notchWindow(f) { return f.windows.findLast(win => win.query?.surface === 'notch' && !win.destroyed); }
// Input the page reports once the window takes the pointer.
function press(f) { f.ipcMain.emit('topNotch:press', { sender: notchWindow(f).webContents }); }
function wheel(f, deltaY, deltaX = 0) { f.ipcMain.emit('topNotch:wheel', { sender: notchWindow(f).webContents }, { deltaX, deltaY }); }
function wiredNotchOptions(overrides = {}) {
  let options;
  const source = mainSource.slice(mainSource.indexOf('function ensureNotchController('), mainSource.indexOf('function syncNotch('));
  const ensure = vm.runInNewContext(`${source}; ensureNotchController`, {
    notchController: null, settings: {}, BrowserWindow: {}, ipcMain: {}, screen: {},
    path, __dirname: path.join(__dirname, '../../src/electron'), process: { platform: 'darwin' },
    toggleDockRateMode() {}, createFullScreenProbe: () => () => false,
    createNotchController: value => { options = value; return {}; }, ...overrides
  });
  ensure();
  return options;
}

function stats() {
  return { periods: { today: { totalTokens: 100, costUsd: 1, sessions: {
    a: { client: 'codex', lastUsedAt: new Date().toISOString(), totalTokens: 100 },
    b: { client: 'claude', lastUsedAt: new Date().toISOString(), totalTokens: 20 }
  } } }, limits: { providers: [{ provider: 'codex', status: 'ok', accountKey: 'local', planLabel: 'Plus', windows: [{ kind: 'session', remainingPercent: 67 }] }] } };
}

test('first summary is measured and committed before reveal on either screen shape', (t) => {
  for (const notched of [true, false]) {
    const f = fixture(t, {}, { measureSummary: false, reducedMotion: false,
      readScreens: () => ({ screens: notched ? [native] : [], mainDisplayId: 1 }) });
    const win = f.windows[0], before = last(win).motion.shape.d;
    const input = { cells: [], sessions: Object.values(stats().periods.today.sessions), summary: { items: [{ type: 'text', text: '123.46B' }] } };
    f.controller.setData(input);
    const request = last(win).summaryMeasurement;
    assert.equal(request.measuring, true);
    assert.equal(last(win).motion.shape.d, before, 'quiet shell does not resize to placeholder widths');
    const slots = { left: 17, right: 70, minimumLeft: 17, minimumRight: 70 };
    f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots, summaryMeasurement: { id: request.id + 1 } });
    assert.equal(last(win).motion.shape.d, before, 'stale measurement cannot settle this summary');
    f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { summaryMeasurement: { id: request.id, ready: true } });
    assert.equal(last(win).summaryMeasurement.measuring, true, 'ready before measurement is rejected');
    f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots, summaryMeasurement: { id: request.id } });
    const measured = last(win);
    assert.equal(measured.summaryMeasurement.measuring, false);
    const expected = notchBounds(display, notchGeometry(display, notched ? native : null), false, 180, slots);
    assert.equal(measured.geometry.headerWidth, expected.width);
    const shoulder = notched ? NOTCH_METRICS.restingFlare : 0;
    assert.equal(measured.motion.summaryEdges.left + win.bounds.x, expected.x + shoulder + 8);
    assert.equal(measured.motion.summaryEdges.right + win.bounds.x, expected.x + expected.width - shoulder - 8);
    assert.equal(win.messages.filter(m => m.channel === 'topNotch:animate').at(-1).payload.duration, 0);
    f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { summaryMeasurement: { id: request.id, ready: true } });
    assert.equal(last(win).summaryMeasurement, null);
    f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots: { ...slots, right: 90, minimumRight: 90 } });
    if (notched) assert.ok(win.messages.filter(m => m.channel === 'topNotch:animate').at(-1).payload.duration > 0, 'later width changes retain motion');
    else assert.equal(last(win).geometry.headerWidth, notchBounds(display, notchGeometry(display), false, 180, { left: 17, right: 90 }).width, 'resting width follows the compact summary');
  }
});

test('a replaced or withdrawn first summary cannot be revealed by a late size report', (t) => {
  const f = fixture(t, {}, { measureSummary: false });
  const win = f.windows[0], input = { cells: [], sessions: Object.values(stats().periods.today.sessions), summary: { items: [{ type: 'text', text: '100' }] } };
  f.controller.setData(input); const first = last(win).summaryMeasurement.id;
  f.controller.setData({ ...input, summary: { items: [{ type: 'text', text: '200' }] } });
  const second = last(win).summaryMeasurement.id; assert.notEqual(first, second);
  f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots: { left: 17, right: 40, minimumLeft: 17, minimumRight: 40 }, summaryMeasurement: { id: first } });
  assert.equal(last(win).summaryMeasurement.id, second);
  f.controller.setData({ ...input, summary: null });
  f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { summaryMeasurement: { id: second, ready: true } });
  assert.equal(last(win).summary, null); assert.equal(last(win).summaryMeasurement, null);
});

test('Notch defaults to the widget material and supports each explicit style', (t) => {
  for (const style of [undefined, 'black', 'vibrancy', 'liquid-glass', 'liquid-glass-clear', 'inherit']) {
    const f = fixture(t, style === undefined ? {} : { notchStyle: style });
    assert.equal(last(f.windows[0]).style, style || 'inherit');
  }
});

test('inherited notch material follows the widget without changing saved independent styles', (t) => {
  let enabled = true, available = true;
  const f = fixture(t, { notchStyle: 'inherit', macBackdrop: 'vibrancy', edgeDockMacBackdrop: 'liquid-glass' }, {
    nativeGlass: () => enabled,
    liquidGlass: () => available ? { dark: true } : null,
    createGlass: () => ({ update() {}, dispose() {} })
  });
  assert.equal(f.windows[0].options.vibrancy, 'hud');
  assert.equal(last(f.windows[0]).liquidGlass, false);
  f.preferences.macBackdrop = 'liquid-glass'; f.controller.sync();
  for (const win of f.windows.slice(-1)) f.ipcMain.emit('topNotch:ready', { sender: win.webContents });
  assert.equal(last(f.windows.findLast(win => win.query?.surface === 'notch' && !win.destroyed)).liquidGlass, true);
  available = false; f.controller.sync();
  assert.equal(f.windows.findLast(win => win.query?.surface === 'notch' && !win.destroyed).options.vibrancy, 'hud');
  available = true;
  f.preferences.notchStyle = 'vibrancy'; f.controller.sync();
  assert.equal(f.windows.findLast(win => win.query?.surface === 'notch' && !win.destroyed).options.vibrancy, 'hud');
  f.preferences.notchStyle = 'inherit'; enabled = false; f.controller.sync();
  assert.equal(f.windows.findLast(win => win.query?.surface === 'notch' && !win.destroyed).options.vibrancy, undefined);
  // An explicit style overrides System Glass; Pure black never has material.
  f.preferences.notchStyle = 'vibrancy'; f.controller.sync();
  assert.equal(f.windows.findLast(win => win.query?.surface === 'notch' && !win.destroyed).options.vibrancy, 'hud');
  f.preferences.notchStyle = 'black'; enabled = true; f.controller.sync();
  assert.equal(f.windows.findLast(win => win.query?.surface === 'notch' && !win.destroyed).options.vibrancy, undefined);
});

test('physical notch geometry uses AppKit gap and safe top, not menu-bar workArea or pixel scale', () => {
  const geometry = notchGeometry(display, native);
  assert.deepEqual(geometry, { notched: true, centerX: 735.5, gapWidth: 179, height: 32, y: 0 });
  const bounds = notchBounds(display, geometry, false);
  assert.equal(bounds.height, 32); assert.equal(bounds.y, 0);
  assert.equal(notchGeometry(display, { ...native, right: null }).notched, false);
  assert.equal(notchGeometry(display, { ...native, safeTop: 0 }).notched, false);
  const external = { ...display, bounds: { x: -1920, y: -300, width: 1920, height: 1080 } };
  const fallback = notchGeometry(external);
  assert.equal(fallback.gapWidth, 0); assert.equal(fallback.y, -294);
  assert.ok(notchBounds(external, fallback, false).width < notchBounds(external, fallback, true).width);
  assert.equal(notchCommands(200, 32, false, false).at(-1)[0], 'Z');
});

test('open flare stays within the physical notch height at every list size and zoom', () => {
  for (const zoom of [0.8, 1, 1.5]) {
    const short = notchCommands(381 * zoom, 220, true, true, 32, zoom);
    const tall = notchCommands(381 * zoom, 800, true, true, 32, zoom);
    assert.deepEqual(short[1], tall[1]);
    const f = NOTCH_METRICS.openFlare * zoom;
    assert.ok(f <= 32, 'the flare must end before the provider content starts');
    // A short handle off the menu bar and a long one into the side.
    assert.deepEqual(short[1], ['C', f * 0.35, 0, f, f * 0.15, f, f]);
    assert.deepEqual(short.at(-2), ['C', 381 * zoom - f, f * 0.15, 381 * zoom - f * 0.35, 0, 381 * zoom, 0]);
  }
});

test('equal ears reserve the wider content and preserve the physical notch center', () => {
  const geometry = notchGeometry(display, native);
  const closed = notchBounds(display, geometry, false, 180, { left: 17, right: 36 });
  assert.equal(closed.width, 179 + 2 * (36 + 12 + NOTCH_METRICS.restingFlare));
  assert.equal(closed.x + 36 + 12 + NOTCH_METRICS.restingFlare, 646);
  assert.equal(closed.x + closed.width - 36 - 12 - NOTCH_METRICS.restingFlare, 825);
  assert.equal(notchBounds(display, geometry, false, 180, null).width, 179 + 2 * NOTCH_METRICS.restingFlare, 'a quiet shell hugs the camera with its resting flares');
  const open = notchBounds(display, geometry, true, 800, { left: 17, right: 36 }, 1.5);
  assert.ok(Math.abs(open.x + open.width / 2 - geometry.centerX) <= 0.5, 'expanded shell remains centered on the physical notch');
  assert.equal(open.width, 1015, 'panel and flares follow the app zoom');
  assert.equal(open.height, notchMaxHeight(display, geometry), 'the panel keeps its proportions at every zoom');
  const short = { ...display, bounds: { ...display.bounds, height: 400 }, workArea: { ...display.workArea, height: 367 } };
  assert.equal(notchBounds(short, notchGeometry(short, native), true, 800, null, 1.5).height, notchMaxHeight(short, notchGeometry(short, native)), 'usable height still caps the panel');
  assert.equal(notchBounds(display, geometry, true, 100, null, 1.5).height, 132, 'reported content is not scaled twice');
});

test('expanded width reserves equal content padding and notch clearance for either wider ear', () => {
  const geometry = notchGeometry(display, native);
  for (const slots of [{ left: 17, right: 37 }, { left: 37, right: 17 }]) {
    const open = notchBounds(display, geometry, true, 180, slots);
    const inset = 28 + 14;
    const available = (open.width - geometry.gapWidth) / 2 - inset;
    assert.ok(available >= Math.max(slots.left, slots.right) + 8,
      'neither header side may consume the physical notch clearance');
    assert.ok(Math.abs(open.x + open.width / 2 - geometry.centerX) <= 0.5);
  }
});

test('top-only real provider projection updates while the side controller is absent', (t) => {
  const { controller, windows } = fixture(t);
  const input = stats();
  const settings = { edgeDockEnabled: false, notchEnabled: true, limitProviders: 'codex', trayContent: 'tokens' };
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = main.indexOf('function updateEdgeDockCells(');
  const code = main.slice(start, main.indexOf('\n// Hand cells', start))
    + main.slice(main.indexOf('function pushNotchCells('), main.indexOf('// The soonest moment any sessions cell'));
  const update = vm.runInNewContext(`${code}; updateEdgeDockCells`, {
    edgeDockController: null, notchController: controller,
    notchPanelItems, notchWeek, notchHistory: { read: () => null }, hubModeGeneration: 0,
    settings: {}, scheduleSessionExpiry() {}, notchLastCells: [],
    edgeDockCellsFor: (value) => buildEdgeDockCells(value, { limitProviders: 'codex' }),
    notchDataFor: (value, cells) => buildNotchData(value, cells, settings),
    pushEdgeDockCells() { assert.fail('side is disabled'); }
  });
  update(input);
  const open = windows[0];
  assert.equal(last(open).cells[0].accounts[0].record.windows[0].remainingPercent, 67);
  assert.equal(last(open).cells[0].showSessions, true, 'provider details follow the existing sessions preference');
  input.limits.providers[0].windows[0].remainingPercent = 55;
  update(input);
  assert.equal(last(open).cells[0].accounts[0].record.windows[0].remainingPercent, 55);
  assert.equal(last(windows[0]).summary.items[1].measure.value, 100);
});

test('collapsed summary stays visible without running tasks and never opens by activity', (t) => {
  for (const shape of ['auto', 'pill', 'notch']) {
    const f = fixture(t, { notchShape: shape }, {
      readScreens: () => ({ screens: shape === 'notch' ? [] : [native], mainDisplayId: 1 })
    });
    const input = stats();
    const project = () => buildNotchData(input, [], { trayContent: 'tokens' });
    for (const session of Object.values(input.periods.today.sessions)) session.turnEnded = true;
    f.controller.setData(project());
    const win = f.windows[0];
    assert.ok(last(win).summary, 'idle data still shows the configured summary');
    assert.equal(win.opacity, 1);
    assert.equal(last(win).expanded, false);
    input.periods.today.sessions.a.turnEnded = false;
    f.controller.setData(project());
    assert.equal(last(win).expanded, false, 'starting Codex does not open the quota list');
    input.periods.today.sessions.a.lastUsedAt = new Date(Date.now() - RUNNING_WINDOW_MS - 100).toISOString();
    f.controller.setData(project());
    assert.ok(last(win).summary, 'expired activity does not hide the summary');
    assert.equal(win.opacity, 1);
    assert.equal(last(win).expanded, false);
  }
});

test('fixed provider custom fields remain visible after every task ends', (t) => {
  const input = stats();
  for (const session of Object.values(input.periods.today.sessions)) session.turnEnded = true;
  const icon = trayLayout.createTrayLayoutItem('providerIcon');
  const percent = trayLayout.createTrayLayoutItem('percent');
  icon.source.provider = percent.source.provider = 'codex';
  const settings = { notchSummaryMode: 'custom', notchCustomLayout: { version: trayLayout.VERSION, items: [icon, percent] } };
  const data = buildNotchData(input, [], settings);
  assert.equal(data.summary.items[0].provider, 'codex');
  assert.equal(data.summary.items[0].providerCell.remainingPercent, 67);
  assert.equal(data.summary.items[1].available, true);
  assert.equal(data.summary.items[1].measure.value, 67);
  const f = fixture(t, settings);
  f.controller.setData(data);
  assert.equal(last(f.windows[0]).summary.items[1].measure.value, 67);
  assert.equal(last(f.windows[0]).expanded, false);
});

test('hover morph retains one opaque primary and unchanged canvas; lock hides all surfaces', (t) => {
  const { controller, screen, windows } = fixture(t, { notchHoverDelay: 100 });
  const primary = windows[0];
  const canvas = primary.getBounds();
  const head = last(primary).geometry;
  screen.point = { x: canvas.x + head.headerX + 20, y: canvas.y + 10 };
  controller.poll(100); controller.poll(199);
  assert.equal(last(primary).expanded, false, 'the configured hover duration holds the panel closed');
  controller.poll(200);
  assert.equal(last(primary).expanded, true);
  assert.equal(primary.opacity, 1);
  assert.deepEqual(primary.getBounds(), canvas);
  assert.equal(primary.ignoreMouse, false);
  assert.equal(primary.messages.filter((m) => m.channel === 'topNotch:motion').at(-1).payload.progress, 1);
  screen.point = { x: 10, y: 900 };
  controller.poll(300); controller.poll(399);
  assert.equal(last(primary).expanded, true);
  controller.poll(400);
  assert.equal(last(primary).expanded, false, 'the panel closes shortly after the pointer leaves');
  assert.equal(primary.opacity, 1, 'closing never fades the summary');
  assert.deepEqual(primary.getBounds(), canvas);
  controller.setLocked(true);
  assert.equal(primary.opacity, 0); assert.equal(primary.ignoreMouse, true);
  controller.setLocked(false); assert.equal(primary.opacity, 1);
});

test('Notch owns only the panel shell and ignores obsolete detail reports', (t) => {
  const f = fixture(t, { notchDetailSide: 'left' });
  const [primary] = f.windows;
  assert.equal(f.windows.length, 1, 'no hidden detail renderer is allocated');
  assert.deepEqual(primary.query, { surface: 'notch' });
  assert.equal(f.ipcMain.listenerCount('topNotch:bubbleSize'), 0);
  assert.equal(f.ipcMain.listenerCount('topNotch:openResetForecastSource'), 0);
  f.controller.setData({ cells: [{ id: 'codex', accounts: [] }], sessions: [], summary: null });
  f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { height: 100,
    rows: [{ id: 'codex', x: 28, y: 32, width: 280, height: 90 }] });
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(100);
  f.screen.point = { x: 735, y: 70 }; f.controller.poll(300); f.controller.poll(1000);
  assert.equal(last(primary).expanded, true);
  assert.equal(f.windows.length, 1, 'hovering provider content never opens a card window');
  assert.ok(primary.messages.every(message => message.payload.surface !== 'bubble'));
  const before = primary.messages.length;
  f.ipcMain.emit('topNotch:bubbleSize', { sender: primary.webContents }, { cellId: 'codex', height: 999 });
  assert.equal(primary.messages.length, before);
  f.screen.point = { x: 20, y: 900 }; f.controller.poll(1100); f.controller.poll(1200);
  assert.equal(last(primary).expanded, false, 'there is no old detail corridor holding the panel open');
});

test('side and top IPC coexist, reject other senders and dispose only their own handlers', async (t) => {
  const { controller, ipcMain, deps, preferences, windows } = fixture(t);
  preferences.edgeDockEnabled = true;
  const side = createEdgeDockController({ ...deps, onSwitchCodexAccount: () => ({ ok: true, side: true }) });
  t.after(() => side.stop());
  side.sync();
  const sideHandler = ipcMain.handlers.get('edgeDock:switchCodexAccount');
  const handler = ipcMain.handlers.get('topNotch:switchCodexAccount');
  assert.deepEqual(await handler({ sender: windows[0].webContents }, { accountId: 'b' }), { ok: true, id: 'b' });
  assert.equal((await handler({ sender: {} }, { accountId: 'b' })).ok, false);
  controller.stop(); controller.sync();
  assert.equal(ipcMain.listenerCount('topNotch:ready'), 1);
  assert.equal(ipcMain.handlers.get('edgeDock:switchCodexAccount'), sideHandler);
  controller.dispose();
  assert.equal(ipcMain.handlers.has('topNotch:switchCodexAccount'), false);
  assert.equal(ipcMain.handlers.get('edgeDock:switchCodexAccount'), sideHandler);
});

test('empty custom summary hides both ears while retaining provider data and hover expansion', (t) => {
  const input = stats();
  const cells = buildEdgeDockCells(input);
  for (const settings of [
    { notchSummaryMode: 'custom', notchCustomLayout: { version: 3, items: [] } },
    { notchSummaryMode: 'tray', trayContent: 'custom', trayCustomLayout: { version: 3, items: [] } }
  ]) {
    const data = buildNotchData(input, cells, settings);
    assert.equal(data.summary, null);
    assert.equal(data.cells, cells);
    const f = fixture(t, settings);
    f.controller.setData(data);
    const top = f.windows[0];
    assert.equal(last(top).geometry.headerWidth, 179 + 2 * NOTCH_METRICS.restingFlare, 'the quiet shell hugs the camera');
    assert.equal(last(top).geometry.shoulder, 0);
    assert.equal(last(top).summary, null);
    f.screen.point = { x: 735, y: 10 };
    f.controller.poll(100); f.controller.poll(240);
    assert.equal(last(top).expanded, true);
    assert.equal(last(top).cells, cells);
    f.screen.point = { x: 10, y: 500 };
    f.controller.poll(300); f.controller.poll(620);
    assert.equal(last(top).expanded, false);
    assert.equal(last(top).geometry.headerWidth, 179 + 2 * NOTCH_METRICS.restingFlare);
  }
  assert.ok(buildNotchData(input, cells, { trayContent: 'tokens', showTrayIcon: false }).summary,
    'hiding the actual tray never hides an independently configured notch summary');
});

test('notch summary switch preserves custom configuration, provider data and tray independence', () => {
  const input = stats();
  const cells = buildEdgeDockCells(input);
  const layout = trayLayout.createDefaultTrayLayout();
  for (const summaryMode of ['tray', 'custom']) {
    const settings = { notchSummaryMode: summaryMode, notchCustomLayout: layout, trayContent: 'tokens', showTrayIcon: false };
    const before = JSON.stringify(settings);
    assert.ok(buildNotchData(input, cells, settings).summary, 'both explicit summary modes show their configured content');
    const hidden = buildNotchData(input, cells, { ...settings, notchSummaryEnabled: false });
    assert.equal(hidden.summary, null);
    assert.equal(hidden.cells, cells);
    assert.equal(JSON.stringify(settings), before, 'display configuration remains intact');
    assert.ok(buildNotchData(input, cells, { ...settings, notchSummaryEnabled: true }).summary);
  }
});

test('custom top layout is independent of tray layout and carries raw animation values', () => {
  const layout = { version: trayLayout.VERSION, items: [trayLayout.createTrayLayoutItem('tokens')] };
  const input = stats();
  const data = buildNotchData(input, [], { notchSummaryMode: 'custom', notchCustomLayout: layout, trayContent: 'icon' });
  assert.deepEqual(summaryLayout({ notchSummaryMode: 'custom', notchCustomLayout: layout }), trayLayout.normalizeTrayLayout(layout));
  assert.ok(data.summary.items.some((item) => item.measure?.value === 100));
  assert.equal(summaryLayout({ trayContent: 'icon' }).items.length, 1);
});

// The endpoints must have equal command topology for interrupted/reversed motion.
test('resting curves and expanded EdgeDock curves interpolate linearly without a shape swap', () => {
  for (const notched of [true, false]) {
    const a = translateCommands(notchCommands(272, 32, notched, false), 32);
    const b = notchCommands(336, 300, notched, true);
    assert.deepEqual(a.map((c) => [c[0], c.length]), b.map((c) => [c[0], c.length]));
    const half = interpolateCommands(a, b, 0.5);
    const near = (x, y) => x.forEach((c, i) => c.forEach((v, j) => (j ? assert.ok(Math.abs(v - y[i][j]) < 1e-9) : assert.equal(v, y[i][j]))));
    near(interpolateCommands(a, b, 0), a);
    near(interpolateCommands(a, b, 1), b);
    for (let i = 0; i < a.length; i++) for (let j = 1; j < a[i].length; j++) assert.ok(Math.abs(half[i][j] - (a[i][j] + b[i][j]) / 2) < 1e-9);
    assert.deepEqual(interpolateCommands(half, a, 0), half, 'reverse starts at the visible frame');
    if (notched) { assert.equal(a[1][0], 'C'); assert.ok(a[1][6] > 0 && a[1][6] < 32); }
  }
});

test('display-frame driven expansion survives resize and rejects stale or invalid frames', (t) => {
  const { controller, screen, windows, ipcMain } = fixture(t, {}, { reducedMotion: false });
  const primary = windows[0], canvas = primary.getBounds(), head = last(primary).geometry;
  const animation = () => primary.messages.filter((m) => m.channel === 'topNotch:animate').at(-1).payload;
  const frame = () => primary.messages.filter((m) => m.channel === 'topNotch:motion').at(-1).payload;
  const tick = (id, elapsed) => ipcMain.emit('topNotch:frame', { sender: primary.webContents }, { id, elapsed });
  screen.point = { x: canvas.x + head.headerX + 20, y: 10 };
  controller.poll(100); controller.poll(240);
  const first = animation();
  assert.equal(first.duration, springDuration(NOTCH_SPRINGS.open));
  tick(first.id, 120);
  const middle = frame();
  assert.ok(middle.progress > 0 && middle.progress < 1);
  tick(first.id, 80);
  assert.deepEqual(frame(), middle, 'out-of-order frame cannot rewind the visible shape');
  // A shorter list than the panel's cap changes the open shape mid-motion.
  ipcMain.emit('topNotch:size', { sender: primary.webContents }, { height: 100 });
  const resumed = animation();
  assert.ok(resumed.id > first.id);
  const resized = frame();
  tick(first.id, first.duration);
  assert.deepEqual(frame(), resized, 'old transition cannot finish the resized shell');
  tick(resumed.id, resumed.duration);
  assert.equal(frame().progress, 1);
  assert.equal(primary.opacity, 1);
  assert.equal(primary.getBounds().height, notchCanvasBounds({ x: 0, y: 0, width: 381, height: 132 }, { x: 0, y: 0, width: 185, height: 32 }).height);
  tick(undefined, 0);
  assert.equal(frame().progress, 1, 'missing transition is rejected');
});

test('reversing the shell starts at the current shape without a jump or window fade', (t) => {
  const { controller, screen, windows, ipcMain } = fixture(t, {}, { reducedMotion: false });
  const primary = windows[0], canvas = primary.getBounds(), head = last(primary).geometry;
  screen.point = { x: canvas.x + head.headerX + 20, y: 10 };
  controller.poll(100); controller.poll(240);
  const first = primary.messages.filter((m) => m.channel === 'topNotch:animate').at(-1).payload;
  ipcMain.emit('topNotch:frame', { sender: primary.webContents }, { id: first.id, elapsed: 100 });
  const before = primary.messages.filter((m) => m.channel === 'topNotch:motion').at(-1).payload;
  ipcMain.emit('topNotch:dismiss', { sender: primary.webContents });
  const reverse = primary.messages.filter((m) => m.channel === 'topNotch:animate').at(-1).payload;
  ipcMain.emit('topNotch:frame', { sender: primary.webContents }, { id: reverse.id, elapsed: 0 });
  const after = primary.messages.filter((m) => m.channel === 'topNotch:motion').at(-1).payload;
  assert.equal(after.shape.d, before.shape.d);
  assert.equal(after.bodyHeight, before.bodyHeight);
  assert.equal(after.progress, before.progress);
  assert.equal(primary.opacity, 1);
});

test('attached Liquid Glass forwards the camera shade on every material frame and removes it on a capsule', (t) => {
  const material = [];
  const f = fixture(t, { notchStyle: 'liquid-glass-clear' }, { reducedMotion: false,
    nativeGlass: () => true, liquidGlass: () => ({ dark: true }),
    createGlass: () => ({ hardwareShade: true, update: value => material.push(value), dispose() {} }) });
  const win = f.windows[0], head = last(win).geometry;
  f.screen.point = { x: win.bounds.x + head.headerX + 20, y: 10 };
  f.controller.poll(100); f.controller.poll(240);
  const animation = win.messages.filter(message => message.channel === 'topNotch:animate').at(-1).payload;
  for (const elapsed of [80, 160, 240, animation.duration]) {
    f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: animation.id, elapsed });
    const payload = last(win), frame = win.messages.filter(message => message.channel === 'topNotch:motion').at(-1).payload;
    const native = material.filter(value => value.shape).at(-1);
    assert.equal(payload.nativeHardwareShade, true);
    assert.equal(native.hardwareShade.progress, frame.progress);
    assert.deepEqual(native.hardwareShade, { ...require('../../src/electron/renderer/notch/renderer').notchGlassGeometry(payload.geometry.height, frame.bodyHeight), progress: frame.progress });
    assert.equal(require('../../src/electron/renderer/edgeDock/shapes').toSvgPath(native.shape.commands), frame.shape.d);
    assert.equal(native.tintOpacity, 0, 'the native cap is the only attached tint');
  }
  f.preferences.notchShape = 'pill'; f.controller.sync();
  assert.equal(material.filter(value => value.shape).at(-1).hardwareShade, undefined);
});

// Exercise the production renderer's coordinate conversion: CSS zoom also
// scales translateX, while AppKit/shape coordinates are physical DIPs.
test('header outer margins stay equal through motion at each summary zoom', () => {
  const code = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const source = code.slice(code.indexOf('function applyNotchMotion('), code.indexOf('function renderNotch('));
  const css = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/notch.css'), 'utf8');
  assert.match(css, /\.notch-left\s*\{[^}]*justify-content:\s*flex-start/);
  assert.match(css, /\.notch-right\s*\{[^}]*justify-content:\s*flex-end/);
  for (const [appZoom, summaryZoom] of [[1, 1], [1.25, 1.2], [0.8, 0.8]]) {
    const widthLeft = 17 * summaryZoom, widthRight = 37 * summaryZoom;
    const geometry = { ...notchGeometry(display, native), summaryZoom };
    const slots = { left: Math.ceil(widthLeft), right: Math.ceil(widthRight) };
    const closed = notchBounds(display, geometry, false, 263, slots, appZoom);
    const open = notchBounds(display, geometry, true, 263, slots, appZoom);
    const header = { ...geometry, headerX: closed.x - open.x, headerWidth: closed.width,
      gapOffset: geometry.centerX - geometry.gapWidth / 2 - closed.x, shoulder: 4,
      expandedInset: 42 * appZoom, expandedShoulder: 28 * appZoom };
    const left = { style: {}, getBoundingClientRect: () => ({ width: widthLeft }) };
    const right = { style: {}, getBoundingClientRect: () => ({ width: widthRight }) };
    const body = {};
    const properties = {};
    const head = { dataset: {}, style: {}, querySelector: (selector) => selector.includes('notch-left') ? left : right };
    let styleReads = 0;
    const apply = vm.runInNewContext(`${source}; applyNotchMotion`, {
      contentLayer: { querySelector: (selector) => selector === '.notch-summary' ? head : body },
      shapeLayer: { firstChild: true, dataset: {}, setAttribute() {}, querySelector: () => ({ setAttribute() {} }) },
      root: { style: { setProperty(key, value) { properties[key] = value; } } }, state: { payload: { geometry: header } },
      paintHardwareShade() {},
      getComputedStyle: () => { styleReads++; return { zoom: summaryZoom }; }
    });
    // Production CSS anchors outer edges, so the different content widths
    // cannot change their distance to the corresponding silhouette edge.
    const restingLeft = header.headerX + 4 + 8;
    const restingRight = header.headerX + closed.width - 4 - 8;
    for (const progress of [0, 0.1, 0.5, 0.9, 1]) {
      apply({ shape: { key: 'test', width: open.width, height: open.height, d: '' }, progress, bodyHeight: 263, headerHeight: 32, summaryEdges: { left: restingLeft + (header.expandedInset - restingLeft) * progress, right: restingRight + (open.width - header.expandedInset - restingRight) * progress } });
      assert.ok(Math.abs(properties['--notch-summary-opacity'] + properties['--notch-content-progress'] - 1) < 1e-9, 'summary and list crossfade without an empty or overlaid full-opacity phase');
      assert.equal(properties['--notch-summary-opacity'], 1 - progress, 'summary remains visible throughout the shell transition');
      assert.equal(styleReads, 0, 'motion uses the already measured summary zoom without a style read after frame writes');
      const shift = (node) => Number(node.style.transform.match(/translateX\(([-\d.]+)px\)/)[1]) * summaryZoom;
      const leftEdge = restingLeft + shift(left);
      const rightEdge = restingRight + shift(right);
      const silhouetteLeft = header.headerX * (1 - progress);
      const silhouetteRight = open.width - silhouetteLeft;
      assert.ok(Math.abs((leftEdge - silhouetteLeft) - (silhouetteRight - rightEdge)) < 1e-6,
        'icon left margin must equal reading right margin, regardless of their widths');
      const expectedInset = 12 * (1 - progress) + header.expandedInset * progress;
      assert.ok(Math.abs(leftEdge - silhouetteLeft - expectedInset) < 1e-6);
      assert.ok(Math.abs(shift(left) + shift(right)) < 1e-6, 'outer edges follow mirrored trajectories');
      assert.equal(body.inert, progress < 1);
    }
  }
});


test('forecast opt-in restores the cached value immediately after disabling and re-enabling', async () => {
  const settings = { codexResetForecastEnabled: true, edgeDockItems: [{ type: 'limit', provider: 'codex' }] };
  const forecast = { status: 'scheduled', scheduledFor: '2026-10-08T20:00:00Z' };
  let calls = 0, updates = 0;
  const refresh = vm.runInNewContext(`${dockForecastSource}; ({ refresh: refreshEdgeDockForecast, value: () => edgeDockForecast })`, {
    settings, Date, Promise, console, latestStats: {}, electronPresentationStats: (s) => s,
    repaintDockSurfaces: () => { updates++; },
    codexResetForecastClient: { getForecast: () => { calls++; return Promise.resolve(forecast); } }
  });
  refresh.refresh(); await new Promise(setImmediate);
  assert.equal(refresh.value(), forecast);
  settings.codexResetForecastEnabled = false; refresh.refresh();
  assert.equal(refresh.value(), null);
  settings.codexResetForecastEnabled = true; refresh.refresh(); await new Promise(setImmediate);
  assert.equal(refresh.value(), forecast, 'opt-in must not show unavailable for five minutes');
  assert.equal(calls, 2, 'reuse the shared cached client without forcing a network fetch');
  assert.equal(updates, 2);
});

test('a pending forecast cannot repopulate a disabled projection', async () => {
  const settings = { codexResetForecastEnabled: true };
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const refresh = vm.runInNewContext(`${dockForecastSource}; ({ refresh: refreshEdgeDockForecast, value: () => edgeDockForecast })`, {
    settings, Date, Promise, console, latestStats: {}, electronPresentationStats: (s) => s,
    repaintDockSurfaces: () => assert.fail('disabled forecast must not repaint'),
    codexResetForecastClient: { getForecast: () => pending }
  });
  refresh.refresh(); settings.codexResetForecastEnabled = false; refresh.refresh();
  resolve({ status: 'scheduled' }); await new Promise(setImmediate);
  assert.equal(refresh.value(), null);
});


test('notch preserves every composed EdgeDock item and each session preference', () => {
  const itemsApi = require('../../src/electron/renderer/edgeDock/items');
  const input = stats();
  const items = itemsApi.normalizeEdgeDockItems([
    { type: 'limit', provider: 'codex', showSessions: false },
    ...itemsApi.STAT_METRICS.map((metric) => ({ type: 'stat', metric, runningOnly: true, groupBy: 'client', cellDetail: 'rate' }))
  ]);
  const cells = buildEdgeDockCells(input, { items, liveRate: { speed: 15, burn: 900 }, tokenRateMode: 'burn' });
  const data = buildNotchData(input, cells, { trayContent: 'tokens' });
  assert.deepEqual(data.cells, cells, 'periods, rate, sessions and provider preferences must reach the panel projection unchanged');
  const sessions = data.cells.find((cell) => cell.metric === 'sessions');
  assert.equal(sessions.runningOnly, true);
  assert.equal(sessions.groupBy, 'client');
  assert.equal(sessions.cellDetail, 'rate');
  assert.equal(sessions.rate, 900);
  assert.equal(data.cells.find((cell) => cell.metric === 'liveRate').rate, 900);
});

test('top rate toggle accepts only its own shell and removes its listener on disposal', (t) => {
  let toggles = 0;
  const { controller, windows, ipcMain } = fixture(t, {}, { onToggleRateMode: () => { toggles += 1; } });
  ipcMain.emit('topNotch:toggleRateMode', { sender: {} });
  assert.equal(toggles, 0);
  for (const win of windows) ipcMain.emit('topNotch:toggleRateMode', { sender: win.webContents });
  assert.equal(toggles, 1);
  assert.equal(ipcMain.listenerCount('topNotch:toggleRateMode'), 1);
  controller.dispose();
  assert.equal(ipcMain.listenerCount('topNotch:toggleRateMode'), 0);
});


test('disabling only the side dock preserves the shared rate expiry timer for the top dock', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const code = source.slice(source.indexOf('function syncDockSurfaces('), source.indexOf('function refreshLimitStatsPresentation('));
  const cleared = [];
  let topRunning = true;
  const context = { settings: {}, syncNotch() {}, canUseEdgeDock: () => false,
    edgeDockController: { stop() {} }, notchController: { isRunning: () => topRunning },
    edgeDockRateTimer: 42, clearTimeout: (timer) => cleared.push(timer) };
  vm.runInNewContext(`${code}; syncDockSurfaces({});`, context);
  assert.deepEqual(cleared, [], 'top-only live rate must still go idle without another data push');
  assert.equal(context.edgeDockRateTimer, 42);
  topRunning = false;
  context.syncDockSurfaces({});
  assert.deepEqual(cleared, [42]);
  assert.equal(context.edgeDockRateTimer, null);
});


test('panel height caps use current work area without stretching or double scaling content', () => {
  for (const usableHeight of [600, 820, 923, 1100, 1600]) {
    const d = { ...display, bounds: { x: -1470, y: -200, width: 1470, height: usableHeight + 93 },
      workArea: { x: -1470, y: -167, width: 1470, height: usableHeight } };
    const g = { notched: true, centerX: -734.5, gapWidth: 179, height: 32, y: -200 };
    const mainCap = Math.min(480, Math.round(usableHeight * 0.382));
    assert.equal(notchMaxHeight(d, g), mainCap);
    for (const zoom of [0.85, 1, 1.25, 1.5]) {
      assert.equal(notchBounds(d, g, true, 4000, null, zoom).height, Math.round(Math.min(mainCap, NOTCH_METRICS.openHeight * zoom)),
        'long lists scroll inside the panel, which the usable height can only shorten');
      assert.equal(notchBounds(d, g, true, 100, null, zoom).height, 132,
        'short physical content retains natural height at every zoom');
    }
  }
  const noArea = { bounds: { x: 0, y: 0, width: 1000, height: 300 } };
  const g = notchGeometry(noArea);
  assert.equal(notchMaxHeight(noArea, g), 115);
});


test('top and side reuse projection with independent ordered selections', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const fn = source.slice(source.indexOf('function edgeDockCellsFor('), source.indexOf('function updateEdgeDockCells('));
  const settings = { edgeDockItems: [{ type: 'stat', metric: 'today' }], notchItems: [{ type: 'stat', metric: 'sessions', groupBy: 'client' }] };
  const context = { settings, buildEdgeDockCells, refreshEdgeDockDerivedPeriods() {}, refreshEdgeDockForecast() {}, syncCodexPresentationActiveAccount() {}, edgeDockDerivedPeriods: {}, edgeDockForecastWanted: () => false, edgeDockForecast: null, syncProvenanceActive: () => false, codexAccountsForRenderer: () => [], codexPresentationPendingAccountId: null, codexPresentationActiveAccountId: null, edgeDockLiveRateSample: () => null };
  vm.createContext(context);vm.runInContext(fn, context);
  assert.equal(context.edgeDockCellsFor(stats())[0].id, 'stat:today');
  assert.equal(context.edgeDockCellsFor(stats(), settings.notchItems)[0].id, 'stat:sessions');
  settings.notchItems = [];assert.equal(context.edgeDockCellsFor(stats(), settings.notchItems).length, 0);
  assert.equal(context.edgeDockCellsFor(stats())[0].id, 'stat:today');
  const failure = { limits: { providers: [{ provider: 'codex', status: 'unauthorized', accountKey: 'failed', windows: [] }] } };
  const items = [{ type: 'limit', provider: 'codex' }];
  assert.equal(context.edgeDockCellsFor(failure, items)[0].accounts.length, 0);
  assert.equal(context.edgeDockCellsFor(failure, items, { includeUnavailableAccounts: true })[0].accounts.length, 1);
});


test('top-only independent session item schedules a main-process re-projection at expiry', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const source = main.slice(main.indexOf('function edgeDockNextSessionExpiry('), main.indexOf('function ensureEdgeDockController('));
  const input = stats();
  const cells = buildEdgeDockCells(input, { items: [{ type: 'stat', metric: 'sessions' }] });
  let wake, delay;
  const context = { Date, edgeDockSessionExpiryTimer: null, EDGE_DOCK_EXPIRY_FLOOR_MS: 1000, edgeDockLastCells: [], notchLastCells: cells, edgeDockController: null, notchController: { isRunning: () => true }, setTimeout: (callback, ms) => { wake = callback;delay = ms;return 1; }, clearTimeout() {}, latestStats: input, electronPresentationStats: (s) => s, repaintDockSurfaces: () => assert.equal(input.periods.today.totalTokens, 100) };
  vm.runInNewContext(`${source}; scheduleSessionExpiry();`, context);
  assert.ok(delay > 590000 && delay <= 601000);
  wake();
});


test('summary icon reuses the provider headline and sessions independently of selected top items', () => {
  const input = stats();
  input.periods.today.clients = { codex: 100 };
  const data = buildNotchData(input, [], { trayContent: 'tokens', limitsEnabled: true });
  const icon = data.summary.items.find((item) => item.type === 'icon');
  assert.equal(icon.provider, 'codex');
  assert.equal(icon.providerCell.remainingPercent, 67);
  assert.equal(icon.providerCell.sessions[0].client, 'codex');
  assert.deepEqual(data.cells, [], 'a ring must not add a visible provider row');
  const chosen = { kind: 'provider', provider: 'codex', remainingPercent: 42, sessions: [] };
  assert.equal(buildNotchData(input, [chosen], { trayContent: 'tokens' }).summary.items[0].providerCell, chosen);
  assert.equal(buildNotchData(input, [], { trayContent: 'icon' }).summary.items[0].providerCell, undefined);
  assert.equal(buildNotchData(input, [chosen], { trayContent: 'tokens', limitsEnabled: false }).summary.items[0].providerCell, undefined);
  input.limits.providers = [];
  assert.equal(buildNotchData(input, [], { trayContent: 'tokens' }).summary.items[0].providerCell, undefined);
});

test('a mapped usage tool borrows its limits provider ring and keeps its own icon identity', () => {
  const input = stats();
  input.periods.today.clients = { droid: 100 };
  input.periods.today.sessions.a.client = 'droid';
  input.limits.providers = [{ provider: 'factory', status: 'ok', windows: [{ kind: 'session', remainingPercent: 30 }] }];
  const icon = buildNotchData(input, [], { trayContent: 'tokens' }).summary.items[0];
  assert.equal(icon.provider, 'droid');
  assert.equal(icon.providerCell.provider, 'factory');
  assert.equal(icon.providerCell.remainingPercent, 30);
  assert.equal(icon.providerCell.sessions[0].client, 'droid');
});

test('Notch running indicator preference is independent of the side dock', (t) => {
  const f = fixture(t, { notchRunningIndicatorEnabled: true, edgeDockRunningIndicatorEnabled: false });
  f.controller.setAppearance({ edgeDockRunningIndicatorEnabled: false });
  assert.equal(last(f.windows[0]).appearance.edgeDockRunningIndicatorEnabled, true);
  f.preferences.notchRunningIndicatorEnabled = false;
  f.controller.sync();
  assert.equal(last(f.windows[0]).appearance.edgeDockRunningIndicatorEnabled, false);
});

test('Notch warning colours default off and independently reach the shared renderer', (t) => {
  const f = fixture(t, { edgeDockWarnColors: true });
  f.controller.setAppearance({ edgeDockWarnColors: true });
  assert.equal(last(f.windows[0]).appearance.notchWarnColors, false);
  assert.equal(last(f.windows[0]).appearance.edgeDockWarnColors, false);
  for (const enabled of [true, false]) {
    f.preferences.notchWarnColors = enabled;
    f.controller.sync();
    assert.equal(last(f.windows[0]).appearance.notchWarnColors, enabled);
    assert.equal(last(f.windows[0]).appearance.edgeDockWarnColors, enabled);
    assert.equal(f.preferences.edgeDockWarnColors, true, 'the side-dock preference is never rewritten');
  }
});

test('auxiliary geometry outside the physical top band safely falls back to the capsule', () => {
  for (const candidate of [
    { ...native, left: { ...native.left, origin: { x: 0, y: 700 } } },
    { ...native, right: { ...native.right, size: { width: 645, height: 0 } } },
    { ...native, frame: { ...native.frame, size: { width: 956, height: 1470 } } }
  ]) assert.equal(notchGeometry(display, candidate).notched, false);
});


test('short-to-long summary resizes through the existing frame driver without a global position jump', (t) => {
  const { controller, windows, ipcMain } = fixture(t, {}, { reducedMotion: false });
  const primary = windows[0];
  const animation = () => primary.messages.filter(m => m.channel === 'topNotch:animate').at(-1)?.payload;
  const frame = () => primary.messages.filter(m => m.channel === 'topNotch:motion').at(-1).payload;
  const tick = (a, elapsed) => ipcMain.emit('topNotch:frame', { sender: primary.webContents }, { id: a.id, elapsed });
  const finish = () => { const a = animation(); if (a) tick(a, a.duration); };
  controller.setData({ cells: [], sessions: Object.values(stats().periods.today.sessions), summary: { items: [] } });
  finish();
  ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots: { left: 17, right: 20 } });
  finish();
  const old = frame(), oldCanvas = primary.getBounds(), previousId = animation()?.id;
  ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots: { left: 17, right: 95 } });
  const resize = animation();
  assert.ok(resize && resize.id !== previousId, 'new measured width must start an animated resize');
  const canvas = primary.getBounds();
  tick(resize, 0);
  const start = frame();
  assert.equal(start.summaryEdges.left + canvas.x, old.summaryEdges.left + oldCanvas.x);
  assert.equal(start.summaryEdges.right + canvas.x, old.summaryEdges.right + oldCanvas.x);
  tick(resize, resize.duration / 2);
  const half = frame();
  assert.ok(half.summaryEdges.left < start.summaryEdges.left);
  assert.equal(half.summaryEdges.left + half.summaryEdges.right, canvas.width, 'both ends move together');
  tick(resize, resize.duration);
  const end = frame();
  assert.ok(end.summaryEdges.left < half.summaryEdges.left);
  assert.equal(end.progress, 0, 'width motion does not expand the provider list');
  const beforeShrink = primary.getBounds(), before = end;
  ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots: { left: 17, right: 20 } });
  const shrink = animation();
  assert.ok(primary.getBounds().width >= beforeShrink.width, 'the old visible shell cannot be clipped during shrinking');
  tick(shrink, 0);
  assert.equal(frame().summaryEdges.left + primary.getBounds().x, before.summaryEdges.left + beforeShrink.x);
  tick(shrink, shrink.duration);
  assert.ok(frame().summaryEdges.right - frame().summaryEdges.left < before.summaryEdges.right - before.summaryEdges.left, 'the visible shell shrinks inside the reserved canvas');
});

test('Notch reuses independent EdgeDock size presets and preview without stretching the hardware band', (t) => {
  const f = fixture(t, { notchSize: 'small', edgeDockSize: 'large' });
  f.controller.setAppearance({ zoomFactor: 1.6 });
  assert.equal(last(f.windows[0]).appearance.zoomFactor, 0.85);
  assert.equal(last(f.windows[0]).geometry.height, 32);
  assert.equal(last(f.windows[0]).appearance.edgeDockRunningIndicatorEnabled, false);
  f.preferences.notchSize = 'custom';f.preferences.notchCustomScale = 1.15;f.controller.sync();
  assert.equal(last(f.windows[0]).appearance.zoomFactor, 1.15);
  f.controller.previewScale(1.33);
  assert.equal(last(f.windows[0]).appearance.zoomFactor, 1.35);
  assert.equal(f.preferences.notchCustomScale, 1.15, 'preview is not saved until the slider is released');
  assert.equal(f.preferences.edgeDockSize, 'large');
});

test('the shared size control sync reads the selected surface rather than the side dock', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const code = source.slice(source.indexOf('function syncDockSizeControls('), source.indexOf('function syncDockControls('));
  const inputs = () => ['small', 'medium', 'large', 'custom'].map(value => ({ value, checked: false }));
  const els = { edgeDockSizeInputs: inputs(), notchSizeInputs: inputs() };
  const context = { els, state: { settings: { notchSize: 'large', edgeDockSize: 'small' } }, syncSliderRow() {}, document: {} };
  vm.createContext(context);vm.runInContext(`${code}; syncDockSizeControls('notch');syncDockSizeControls('edgeDock');`, context);
  assert.equal(els.notchSizeInputs.find(input => input.checked).value, 'large');
  assert.equal(els.edgeDockSizeInputs.find(input => input.checked).value, 'small');
});


test('switching camera shells and capsules lands directly and rejects the previous animation in both directions', (t) => {
  for (const initialNotched of [true, false]) {
    let notched = initialNotched;
    const { controller, windows, screen, ipcMain } = fixture(t, {}, { reducedMotion: false,
      readScreens: () => ({ screens: notched ? [native] : [], mainDisplayId: 1 }) });
    const primary = windows[0];
    const animation = () => primary.messages.filter(m => m.channel === 'topNotch:animate').at(-1).payload;
    const frame = () => primary.messages.filter(m => m.channel === 'topNotch:motion').at(-1).payload;
    const tick = (a, elapsed) => ipcMain.emit('topNotch:frame', { sender: primary.webContents }, { id: a.id, elapsed });
    const bounds = primary.getBounds(), header = last(primary).geometry;
    screen.point = { x: bounds.x + header.headerX + 20, y: bounds.y + 10 };
    controller.poll(100); controller.poll(240);
    const opening = animation(); tick(opening, 120);
    assert.ok(frame().progress > 0 && frame().progress < 1);
    notched = !notched;
    assert.doesNotThrow(() => screen.emit('display-metrics-changed'));
    assert.equal(last(primary).geometry.notched, notched);
    assert.equal(animation().duration, 0);
    assert.equal(frame().progress, 1);
    assert.equal(frame().shape.d.includes('NaN'), false);
    const placed = frame();
    tick(opening, opening.duration);
    assert.deepEqual(frame(), placed, 'late old-display frames cannot repaint the new shape');
    notched = initialNotched;
    assert.doesNotThrow(() => screen.emit('display-metrics-changed'));
    assert.equal(last(primary).geometry.notched, initialNotched);
    assert.equal(animation().duration, 0);
    assert.equal(frame().progress, 1);
    screen.point = { x: 10, y: 900 };
    controller.poll(500); controller.poll(1000);
    assert.ok(animation().duration > 0, 'same-shape closing still animates');
    tick(animation(), animation().duration);
    assert.equal(frame().progress, 0);
  }
});


test('follow-tray quota presets preserve the tray account and canonical window selection', () => {
  const trayText = require('../../src/shared/trayText');
  const record = (provider, windows, extra = {}) => ({ provider, status: 'ok', windows, ...extra });
  const session = (remainingPercent) => ({ kind: 'session', remainingPercent });
  const weekly = (remainingPercent) => ({ kind: 'weekly', remainingPercent });
  const cases = [
    { name: 'one provider uses session and weekly', records: [record('codex', [session(64), weekly(74)])] },
    { name: 'skip unavailable provider and promote weekly', records: [record('codex', [], { status: 'notConfigured' }), record('claude', [weekly(47)])] },
    { name: 'enabled provider order', records: [record('codex', [session(64), weekly(74)]), record('claude', [session(62), weekly(47)])], order: 'claude,codex' },
    { name: 'disabled provider does not occupy a slot', records: [record('codex', [session(64), weekly(74)]), record('claude', [session(62), weekly(47)])], enabled: 'claude' },
    { name: 'used mode and zero are preserved', records: [record('codex', [session(0), weekly(100)])], used: true },
    { name: 'secondary belongs to the chosen account, including legacy keys', records: [record('codex', [session(20), weekly(80)]), record('codex', [session(60), weekly(10)])] },
    { name: 'credits preset remains a percent', records: [record('codex', [{ kind: 'billing', metric: 'credits', remaining: 50, currency: 'USD' }], { balance: { amount: 50, monthSpend: 50 } })] },
    { name: 'stale data is excluded like the tray', records: [record('codex', [session(64)], { stale: true }), record('claude', [weekly(47)])] },
    { name: 'no valid quota produces no invented missing readings', records: [record('codex', [], { status: 'error' })] }
  ];
  for (const entry of cases) {
    const input = { limits: { providers: entry.records } };
    const settings = { trayContent: 'limitsAllSessions', limitProviderOrder: entry.order || 'codex,claude', limitProviders: entry.enabled || 'codex,claude', showLimitUsed: entry.used === true };
    const items = buildNotchData(input, [], settings).summary.items.filter(item => item.type === 'text');
    assert.equal(items.map(item => item.text).join(' · '), trayText.formatTrayText(input, settings.trayContent, 'USD', settings), entry.name);
    assert.ok(items.every(item => item.available && Number.isFinite(item.measure?.value)), entry.name);
  }
});

test('follow-tray bar presets use the original picker and keep the canonical pair', () => {
  const input = { limits: { providers: [
    { provider: 'codex', status: 'ok', accountKey: 'a', windows: [{ kind: 'session', remainingPercent: 64 }, { kind: 'weekly', remainingPercent: 74 }] },
    { provider: 'claude', status: 'ok', accountKey: 'b', windows: [{ kind: 'session', remainingPercent: 62 }, { kind: 'weekly', remainingPercent: 47 }] }
  ] } };
  for (const [mode, expected] of [['bars', [62, 47]], ['barsSession', [62, 47]], ['barsWeekly', [62, 47]], ['barsAllSessions', [64, 62]]]) {
    for (const used of [false, true]) {
      const items = buildNotchData(input, [], { trayContent: mode, limitProviders: 'codex,claude', limitProviderOrder: 'codex,claude', showLimitUsed: used }).summary.items;
      const rows = items.filter(item => item.type === 'bars').flatMap(item => item.rows);
      assert.deepEqual(rows.map(row => row.percent), expected.map(value => used ? 100 - value : value), mode);
    }
  }
  const lone = { limits: { providers: [{ provider: 'claude', status: 'ok', windows: [{ kind: 'weekly', remainingPercent: 47 }] }] } };
  const rows = buildNotchData(lone, [], { trayContent: 'barsAllSessions', limitProviders: 'claude' }).summary.items.find(item => item.type === 'bars').rows;
  assert.deepEqual(rows.map(row => row.percent), [47, null], 'weekly promoted, empty lower track');
});

test('follow-tray bar preset with no valid quota retains the tray token fallback', () => {
  const input = stats();
  input.limits.providers = [{ provider: 'codex', status: 'error', windows: [] }];
  for (const trayContent of ['bars', 'barsSession', 'barsWeekly', 'barsAllSessions']) {
    const items = buildNotchData(input, [], { trayContent, limitProviders: 'codex' }).summary.items;
    assert.deepEqual(items.filter(item => item.type === 'text').map(item => item.measure), [{ metric: 'tokens', value: 100, costFormat: undefined, costDecimals: undefined }], trayContent);
    assert.equal(items.some(item => item.type === 'bars'), false);
  }
});


test('summary minimum follows each screen gap and measured content rather than a fixed ear width', () => {
  for (const gapWidth of [150, 179, 210]) {
    const geometry = { ...notchGeometry(display, native), gapWidth, centerX: 735.5 };
    for (const iconWidth of [17, 20, 28]) {
      const minimum = notchBounds(display, geometry, false, 180, { left: iconWidth, right: 0 });
      for (const right of [0, 8, iconWidth]) {
        assert.deepEqual(notchBounds(display, geometry, false, 180, { left: iconWidth, right }), minimum,
          'readings narrower than the actual icon share its natural minimum');
      }
      const longer = notchBounds(display, geometry, false, 180, { left: iconWidth, right: 60 });
      assert.ok(longer.width > minimum.width);
      const leftEar = (minimum.width - gapWidth) / 2;
      assert.ok(leftEar >= iconWidth + 12 + NOTCH_METRICS.restingFlare, 'the measured icon and existing clearances fit');
      assert.ok(leftEar < iconWidth + 12 + NOTCH_METRICS.restingFlare + 1, 'no extra fixed content reservation is added');
      assert.ok(Math.abs(minimum.x + minimum.width / 2 - geometry.centerX) <= 0.5);
      assert.ok(Math.abs(longer.x + longer.width / 2 - geometry.centerX) <= 0.5);
      assert.equal(notchBounds(display, geometry, false, 180, null).width, gapWidth + 2 * NOTCH_METRICS.restingFlare);
    }
  }
});


test('native geometry refreshes on configuration changes while routine polling retains cached geometry', (t) => {
  const calls = [];
  let mainDisplayId = 1;
  const f = fixture(t, {}, { readScreens: (options) => {
    calls.push(options.refresh);
    return { screens: [native], mainDisplayId };
  } });
  assert.deepEqual(calls, [true]);
  const external = { ...display, id: 2, bounds: { x: 1470, y: 0, width: 1920, height: 1080 } };
  f.screen.getAllDisplays = () => [display, external];
  f.screen.emit('display-added');
  assert.deepEqual(calls, [true, true], 'a newly connected display invalidates geometry');
  mainDisplayId = 2;
  f.controller.poll(Date.now() + 3000);
  assert.deepEqual(calls, [true, true, false], 'focus-driven main display changes do not invalidate geometry');
  assert.equal(last(f.windows[0]).geometry.notched, false);
  assert.equal(f.windows[0].getBounds().x + f.windows[0].getBounds().width / 2, 2430);
  f.controller.sync();
  assert.equal(calls.at(-1), false, 'settings sync reuses native geometry');
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    f.screen.emit(event);
    assert.equal(calls.at(-1), true, event);
  }
  f.controller.setLocked(true);
  f.controller.setLocked(false);
  assert.equal(calls.at(-1), true, 'unlock refreshes geometry after possible sleep changes');
  f.controller.stop();
  f.controller.sync();
  assert.equal(calls.at(-1), false, 'unchanged displays reuse geometry after re-enabling');
});


test('hover grows the entry by default and opens on click; open mode waits for the hover duration', (t) => {
  const f = fixture(t, { notchHoverAction: 'peek' });
  const top = f.windows[0];
  const shape = () => {
    const message = top.messages.filter((m) => m.channel === 'topNotch:motion' || m.payload?.motion?.shape).at(-1);
    return (message.channel === 'topNotch:motion' ? message.payload : message.payload.motion).shape.d;
  };
  const resting = shape();
  f.screen.point = { x: 735, y: 10 };
  f.controller.poll(1000);
  const grown = shape();
  assert.notEqual(grown, resting, 'hovering the entry grows it');
  f.controller.poll(5000);
  assert.equal(last(top).expanded, false, 'growing never opens the panel by itself');
  f.screen.point = { x: 20, y: 400 }; f.controller.poll(5100);
  assert.equal(shape(), resting, 'leaving restores the resting outline');
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(6000);
  press(f);
  assert.equal(last(top).expanded, true, 'a press on the entry opens it');

  const open = fixture(t, { notchHoverAction: 'open', notchHoverDelay: 300 });
  open.screen.point = { x: 735, y: 10 };
  open.controller.poll(1000); open.controller.poll(1299);
  assert.equal(last(open.windows[0]).expanded, false, 'brief passes do not open');
  open.controller.poll(1300);
  assert.equal(last(open.windows[0]).expanded, true);
});

test('transparent resting corners neither hover nor capture menu bar input', (t) => {
  for (const [shape, fullScreen] of [['notch', false], ['pill', false], ['notch', true]]) {
    const f = fixture(t, { notchShape: shape, notchHoverAction: 'open' }, { isFullScreen: () => fullScreen });
    const top = f.windows[0], g = last(top).geometry;
    const left = top.getBounds().x + g.headerX;
    const animations = () => top.messages.filter(m => m.channel === 'topNotch:animate').length;
    const before = animations();
    for (const x of [left + 1, left + g.headerWidth - 1]) {
      f.screen.point = { x, y: g.y + g.height - 1 };
      f.controller.poll(1000);
      assert.equal(animations(), before, `${shape}: transparent lower corner must not hover`);
      assert.equal(top.ignoreMouse, true, `${shape}: transparent lower corner stays click-through`);
      press(f);
      assert.equal(last(top).expanded, false);
    }
    f.screen.point = { x: g.centerX, y: g.y + g.height / 2 };
    f.controller.poll(1100);
    assert.equal(last(top).expanded, true, `${shape}: the visible center remains reachable`);
  }
});

test('hover input follows the painted shell rather than the animation destination', (t) => {
  const f = fixture(t, { notchHoverAction: 'peek' }, { reducedMotion: false });
  const top = f.windows[0], g = last(top).geometry;
  f.screen.point = { x: g.centerX, y: g.y + 10 }; f.controller.poll(1000);
  assert.equal(top.ignoreMouse, false);
  // No animation frame has arrived: this is inside the future grown shell only.
  f.screen.point = { x: g.centerX, y: g.y + g.height + 2 }; f.controller.poll(1010);
  assert.equal(top.ignoreMouse, true, 'unpainted hover growth cannot take input');
  press(f);
  assert.equal(last(top).expanded, false);
});

test('the open panel leaves its transparent lower corners click-through', (t) => {
  for (const shape of ['notch', 'pill']) {
    const f = fixture(t, { notchShape: shape });
    const top = f.windows[0], g = last(top).geometry;
    f.screen.point = { x: g.centerX, y: g.y + 10 }; f.controller.poll(1000);
    assert.equal(last(top).expanded, true);
    const open = notchBounds(display, notchGeometry(display, native, shape), true);
    for (const x of [open.x + 1, open.x + open.width - 1]) {
      f.screen.point = { x, y: open.y + open.height - 1 }; f.controller.poll(1010);
      assert.equal(top.ignoreMouse, true, `${shape}: the open corner stays click-through`);
    }
    f.screen.point = { x: g.centerX, y: open.y + open.height - 2 }; f.controller.poll(1020);
    assert.equal(top.ignoreMouse, false, `${shape}: the visible bottom edge still takes input`);
  }
});

test('hover growth scales both ears with the shell and keeps the camera gap fixed', (t) => {
  for (const shape of ['auto', 'pill']) {
    const f = fixture(t, { notchShape: shape, notchHoverAction: 'peek' }, { reducedMotion: false });
    f.controller.setData({ cells: [], summary: { items: [{ type: 'text', text: '123.45M' }] } });
    const win = f.windows[0], geometry = last(win).geometry;
    const frame = () => win.messages.filter(message => message.channel === 'topNotch:motion').at(-1).payload;
    const animation = () => win.messages.filter(message => message.channel === 'topNotch:animate').at(-1).payload;
    const rest = frame();
    f.screen.point = { x: geometry.centerX, y: geometry.y + 10 };
    f.controller.poll(1000);
    const grow = animation();
    f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: grow.id, elapsed: 80 });
    const middle = frame();
    assert.ok(middle.summaryScale > 1 && middle.summaryScale < 1.2);
    assert.ok(middle.summaryEdges.left < rest.summaryEdges.left);
    assert.ok(middle.summaryEdges.right > rest.summaryEdges.right);
    f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: grow.id, elapsed: grow.duration });
    const grown = frame();
    assert.equal(grown.summaryScale, (geometry.height + NOTCH_METRICS.peekDrop) / geometry.height);
    assert.equal(grown.summaryHeight, geometry.height + NOTCH_METRICS.peekDrop);
    assert.equal(grown.progress, 0, 'growing keeps the panel hidden');
    assert.equal(last(win).geometry.gapWidth, geometry.gapWidth, 'the physical camera never scales');
    assert.equal(grown.summaryEdges.left + grown.summaryEdges.right, rest.summaryEdges.left + rest.summaryEdges.right);
    f.screen.point = { x: 20, y: 400 }; f.controller.poll(1100);
    const shrink = animation();
    f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: shrink.id, elapsed: shrink.duration });
    assert.equal(frame().summaryScale, 1);
    assert.deepEqual(frame().summaryEdges, rest.summaryEdges);
    assert.equal(frame().shape.d, rest.shape.d);
  }
});

test('compact attached summaries keep full-size content with eight-point outer margins and four-point camera clearance', (t) => {
  const f = fixture(t);
  f.controller.setData({ cells: [], summary: { items: [{ type: 'activity', running: 1 }] } });
  const win = f.windows[0];
  for (const [left, right] of [[17, 16], [16, 17], [28, 28]]) {
    f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots: { left, right } });
    const g = last(win).geometry;
    const m = win.messages.filter(message => message.channel === 'topNotch:motion').at(-1).payload;
    assert.equal(m.summaryScale, 1, 'narrowing the shell must not shrink its content');
    const closedX = win.bounds.x + g.headerX;
    const leftStart = win.bounds.x + m.summaryEdges.left;
    const rightEnd = win.bounds.x + m.summaryEdges.right;
    assert.equal(leftStart - closedX - g.shoulder, 8);
    assert.equal(closedX + g.headerWidth - g.shoulder - rightEnd, 8);
    const clearance = left >= right ? g.centerX - g.gapWidth / 2 - leftStart - left
      : rightEnd - right - g.centerX - g.gapWidth / 2;
    assert.equal(clearance, 4, 'the wider side retains its camera clearance');
    assert.equal(g.headerWidth, g.gapWidth + 2 * (Math.max(left, right) + 20));
  }
});

test('wide hover summaries stay outside the camera through overshoot, reversal and opening at every zoom', (t) => {
  for (const zoom of [0.8, 1, 1.2]) for (const widths of [[160, 160], [17, 240], [240, 42], [0, 160], [160, 0]]) {
    let down = false;
    const f = fixture(t, { notchHoverAction: 'peek', notchSize: 'custom', notchCustomScale: zoom },
      { reducedMotion: false, primaryButtonDown: () => down });
    f.controller.setData({ cells: [], summary: { items: [{ type: 'text', text: 'Long summary' }] } });
    const win = f.windows[0];
    f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots: { left: widths[0], right: widths[1] } });
    const frame = () => win.messages.filter(message => message.channel === 'topNotch:motion').at(-1).payload;
    const animation = () => win.messages.filter(message => message.channel === 'topNotch:animate').at(-1).payload;
    const check = () => {
      const g = last(win).geometry, m = frame();
      const leftEnd = win.bounds.x + m.summaryEdges.left + widths[0] * m.summaryScale;
      const rightStart = win.bounds.x + m.summaryEdges.right - widths[1] * m.summaryScale;
      assert.ok(leftEnd <= g.centerX - g.gapWidth / 2 - 4 + 1e-8, `left clearance at zoom ${zoom}, widths ${widths}`);
      assert.ok(rightStart >= g.centerX + g.gapWidth / 2 + 4 - 1e-8, `right clearance at zoom ${zoom}, widths ${widths}`);
    };
    const tick = elapsed => { f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: animation().id, elapsed }); check(); };
    tick(animation().duration);
    f.screen.point = { x: last(win).geometry.centerX, y: 10 }; f.controller.poll(1000);
    for (let elapsed = 0; elapsed < animation().duration; elapsed += 16) tick(elapsed);
    tick(animation().duration);
    assert.ok(frame().summaryScale > 1 && frame().summaryScale < 37 / 32, 'wide summaries still grow within their available clearance');
    f.screen.point = { x: 20, y: 400 }; f.controller.poll(1100); tick(30);
    f.screen.point = { x: last(win).geometry.centerX, y: 10 }; f.controller.poll(1200); tick(60);
    down = true; f.controller.poll(1300);
    for (let elapsed = 0; elapsed < animation().duration; elapsed += 16) tick(elapsed);
    tick(animation().duration);
  }
});

test('live summary width changes preserve camera clearance while the hover shell resizes', (t) => {
  const f = fixture(t, { notchHoverAction: 'peek' }, { reducedMotion: false });
  f.controller.setData({ cells: [], summary: { items: [{ type: 'text', text: 'Live summary' }] } });
  const win = f.windows[0];
  const frame = () => win.messages.filter(message => message.channel === 'topNotch:motion').at(-1).payload;
  const animation = () => win.messages.filter(message => message.channel === 'topNotch:animate').at(-1).payload;
  const tick = elapsed => f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: animation().id, elapsed });
  tick(animation().duration);
  f.screen.point = { x: last(win).geometry.centerX, y: 10 }; f.controller.poll(1000);
  tick(animation().duration);
  for (const [left, right, iconInset] of [[160, 17, 12.5], [42, 240, 0], [0, 0, 0], [17, 42, 0]]) {
    f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots: { left, right, iconInset } });
    for (let elapsed = 0; elapsed <= animation().duration + 16; elapsed += 16) {
      tick(Math.min(elapsed, animation().duration));
      const g = last(win).geometry, m = frame();
      const leftEnd = win.bounds.x + m.summaryEdges.left + m.summaryIconInset - iconInset + left * m.summaryScale;
      const rightStart = win.bounds.x + m.summaryEdges.right - right * m.summaryScale;
      if (left) assert.ok(leftEnd <= g.centerX - g.gapWidth / 2 - 4 + 1e-8, 'resizing left content clears the camera');
      if (right) assert.ok(rightStart >= g.centerX + g.gapWidth / 2 + 4 - 1e-8, 'resizing right content clears the camera');
      assert.ok(Number.isFinite(m.summaryScale), 'empty slots do not produce invalid transforms');
    }
  }
});

test('hover reversal and clicking through to the panel preserve the in-flight content scale', (t) => {
  const f = fixture(t, { notchHoverAction: 'peek' }, { reducedMotion: false });
  const win = f.windows[0], geometry = last(win).geometry;
  const frame = () => win.messages.filter(message => message.channel === 'topNotch:motion').at(-1).payload;
  const animation = () => win.messages.filter(message => message.channel === 'topNotch:animate').at(-1).payload;
  const tick = elapsed => f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: animation().id, elapsed });
  f.screen.point = { x: geometry.centerX, y: 10 }; f.controller.poll(1000); tick(90);
  const before = frame();
  f.screen.point = { x: 20, y: 400 }; f.controller.poll(1100); tick(0);
  assert.equal(frame().summaryScale, before.summaryScale);
  assert.deepEqual(frame().summaryEdges, before.summaryEdges);
  tick(30);
  const reversing = frame();
  f.screen.point = { x: geometry.centerX, y: 10 }; f.controller.poll(1200); press(f); tick(0);
  assert.equal(frame().summaryScale, reversing.summaryScale);
  assert.deepEqual(frame().summaryEdges, reversing.summaryEdges);
  tick(animation().duration);
  assert.equal(frame().summaryScale, 1);
  assert.equal(frame().progress, 1);
});

test('hover outline scales its shoulders and lower corners together', () => {
  const rest = notchCommands(300, 32, true, false, 32);
  const scale = 37 / 32;
  const grown = notchCommands(320, 37, true, false, 32);
  assert.equal(grown[1][5], rest[1][5] * scale, 'shoulder height');
  assert.equal(grown[2][2], rest[2][2] * scale, 'lower corner starts at the matching proportion');
  assert.equal(grown[3][5], rest[3][5] * scale, 'lower corner radius');
});

test('the renderer scales each ear around its outer edge without scaling the camera gap', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function applyNotchMotion('), source.indexOf('function renderNotchPanel('));
  const css = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/notch.css'), 'utf8');
  assert.match(css, /\.notch-left \.notch-slot-content\s*\{[^}]*transform-origin:\s*left center/);
  assert.match(css, /\.notch-right \.notch-slot-content\s*\{[^}]*transform-origin:\s*right center/);
  for (const summaryZoom of [0.8, 1, 1.2]) {
    const left = { style: {} }, right = { style: {} }, gap = { style: { width: '179px' } };
    const head = { dataset: {}, style: {}, querySelector: selector => selector.includes('notch-left') ? left : selector.includes('notch-right') ? right : gap };
    const apply = vm.runInNewContext(`${code}; applyNotchMotion`, {
      state: { payload: { geometry: { headerX: 0, headerWidth: 300, shoulder: 8, summaryZoom } } },
      shapeLayer: { firstChild: true, dataset: {}, setAttribute() {}, querySelector: () => ({ setAttribute() {} }) },
      contentLayer: { querySelector: selector => selector === '.notch-summary' ? head : null },
      root: { style: { setProperty() {} } }, paintHardwareShade() {}
    });
    apply({ shape: { d: '', width: 400, height: 100 }, progress: 0, summaryHeight: 37, summaryScale: 37 / 32, summaryEdges: { left: 10, right: 290 } });
    for (const [node, expected] of [[left, -6], [right, 6]]) {
      assert.equal(Number(node.style.transform.match(/translateX\(([-\d.]+)px\)/)[1]) * summaryZoom, expected);
      assert.equal(Number(node.style.transform.match(/scale\(([-\d.]+)\)/)[1]), 37 / 32);
    }
    assert.equal(head.style.height, '37px');
    assert.equal(gap.style.width, '179px');
  }
});

test('full-screen approach suppresses held drags and keeps unknown buttons reachable', (t) => {
  for (const held of [true, null]) {
    const f = fixture(t, {}, { primaryButtonDown: () => held, isFullScreen: () => true });
    const geometry = last(f.windows[0]).geometry;
    const now = Date.now();
    f.screen.point = { x: geometry.centerX, y: geometry.y + geometry.height + 1 };
    f.controller.poll(now); f.controller.poll(now + EDGE_DOCK_TIMING.revealDelayMs);
    assert.equal(last(f.windows[0]).expanded, held === null, 'only a known held button suppresses approach');
    f.screen.point.y = geometry.y + geometry.height - 1;
    f.controller.poll(now + 500); f.controller.poll(now + 500 + EDGE_DOCK_TIMING.revealDelayMs);
    assert.equal(last(f.windows[0]).expanded, true, 'direct entry contact retains its existing behavior');
  }
});


test('embedded summary icons use the tray preferred row and retain provider status', () => {
  const input = stats();
  input.limits.providers.push({ provider: 'claude', status: 'ok', windows: [{ kind: 'session', remainingPercent: 80 }] });
  for (const style of ['doubleBar', 'doubleInfo']) {
    for (const [icon, expected] of [['first', 'codex'], ['second', 'claude'], ['app', 'app'], ['none', undefined]]) {
      const item = trayLayout.createTrayLayoutItem(style);
      item.icon = icon;
      item.rows = [{ provider: 'codex', window: 'primary', metric: 'percent' }, { provider: 'claude', window: 'primary', metric: 'percent' }];
      const data = buildNotchData(input, [], { notchSummaryMode: 'custom', notchCustomLayout: { version: trayLayout.VERSION, items: [item] } });
      const output = data.summary.items[0];
      assert.equal(output.iconProvider, expected);
      if (expected && expected !== 'app') assert.equal(output.providerCell.provider, expected);
    }
  }
});

test('summary clock preserves shared percent-reset headlines and updates without a new collection', () => {
  const input = stats(), now = Date.parse('2026-10-09T00:00:00Z');
  input.limits.providers[0].windows[0].resetsAt = new Date(now + 54 * 60_000).toISOString();
  const item = trayLayout.createTrayLayoutItem('percentReset');item.source.provider = 'codex';
  const summary = buildNotchData(input, [], { notchSummaryMode: 'custom', notchCustomLayout: { version: trayLayout.VERSION, items: [item] } }, { nowMs: now }).summary;
  assert.equal(summary.needsClock, true);
  const row = summary.items[0];
  assert.equal(row.clock.headline, '67%');
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function notchDisplayRow('), source.indexOf('function fitNotchTypeface('));
  const context = { trayLayoutApi: trayLayout, Date: { now: () => now + 60_000 }, appearance: () => ({ maskLimitAccountEmails: true }), accountIdentityApi: require('../../src/electron/renderer/accountIdentity') };
  const renderRow = vm.runInNewContext(`${code};notchDisplayRow`, context);
  assert.equal(renderRow(row).text, '67% · 53m');
  assert.equal(renderRow({ metric: 'account', text: 'review@example.test' }).text, context.accountIdentityApi.maskEmailAddress('review@example.test'));
  const dock = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const cadence = dock.slice(dock.indexOf('function selfRepaintDelayMs('), dock.indexOf('function repaintSelf('));
  context.surface = 'notch';context.state = { payload: { expanded: false, summary } };context.sessionsExpiryDelayMs = () => 0;context.BUBBLE_REPAINT_MS = 30_000;
  context.notchRenderer = { needsClock: () => Boolean(context.state.payload.expanded || context.state.payload.summary?.needsClock) };
  const delay = vm.runInNewContext(`${cadence};selfRepaintDelayMs`, context);
  assert.equal(delay(), 30_000);
  context.state.payload.summary = null;assert.equal(delay(), 0);
});

test('a single custom label preserves shared formatting', (t) => {
  const f = fixture(t);
  const item = trayLayout.createTrayLayoutItem('customText');item.text = 'Long label '.repeat(4);
  const data = buildNotchData(stats(), [], { notchSummaryMode: 'custom', notchCustomLayout: { version: trayLayout.VERSION, items: [item] } });
  assert.equal(data.summary.items[0].text, trayLayout.resolveTrayLayout(summaryLayout({ notchSummaryMode: 'custom', notchCustomLayout: { version: trayLayout.VERSION, items: [item] } }), stats()).items[0].text);
  f.controller.setData(data);
  assert.equal(last(f.windows[0]).summary.items[0].text, data.summary.items[0].text);
});

test('full-screen quiet mode retracts ears, retains configuration and restores it on hover and exit', (t) => {
  let full = false, reads = 0;
  const f = fixture(t, {}, {
    isFullScreen: d => {
      assert.equal(d.id, 1);
      reads += 1;
      return full;
    }
  });
  const data = buildNotchData(stats(), [], { trayContent: 'tokens' });
  f.controller.setData(data);
  assert.ok(last(f.windows[0]).summary);
  const now = Date.now() + 1000;
  full = true;
  f.controller.poll(now);
  const primary = f.windows[0];
  assert.equal(last(primary).quietFullScreen, true);
  assert.equal(last(primary).summary, null);
  assert.equal(last(primary).geometry.headerWidth, 179 + 2 * NOTCH_METRICS.restingFlare);
  assert.equal(primary.opacity, 1);
  const count = reads;
  f.controller.poll(now + 100);
  assert.equal(reads, count, 'same slow cadence as EdgeDock');
  f.screen.point = { x: native.right.origin.x - 90, y: display.bounds.y + native.safeTop + 11 };
  f.controller.poll(now + 150);
  f.controller.poll(now + 150 + EDGE_DOCK_TIMING.revealDelayMs);
  assert.equal(last(primary).expanded, true);
  assert.equal(last(primary).summary, data.summary);
  f.screen.point = { x: 20, y: 500 };
  f.controller.poll(now + 500);
  f.controller.poll(now + 500 + EDGE_DOCK_TIMING.hideDelayMs);
  assert.equal(last(primary).expanded, false);
  assert.equal(last(primary).summary, null);
  assert.equal(last(primary).geometry.headerWidth, 179 + 2 * NOTCH_METRICS.restingFlare);
  full = false;
  f.controller.poll(now + 2000);
  assert.equal(last(primary).summary, data.summary);
  assert.ok(last(primary).geometry.headerWidth > 179);
});

test('full-screen ordinary screen is invisible at rest but approach still opens provider content', (t) => {
  const f = fixture(t, {}, {
    readScreens: () => ({ screens: [], mainDisplayId: 1 }),
    isFullScreen: () => true
  });
  const data = buildNotchData(stats(), [{ id: 'codex', kind: 'limit', provider: 'codex' }], { trayContent: 'tokens' });
  f.controller.setData(data);
  const primary = f.windows[0], payload = last(primary);
  assert.equal(payload.geometry.notched, false);
  assert.equal(primary.opacity, 0);
  assert.equal(primary.ignoreMouse, true);
  f.screen.point = { x: 735, y: payload.geometry.y + payload.geometry.height + 11 };
  const now = Date.now() + 1000;
  f.controller.poll(now);
  f.controller.poll(now + EDGE_DOCK_TIMING.revealDelayMs);
  assert.equal(last(primary).expanded, true);
  assert.equal(primary.opacity, 1);
  assert.equal(last(primary).cells[0].id, 'codex');
  f.screen.point = { x: 20, y: 500 };
  f.controller.poll(now + 500);
  f.controller.poll(now + 500 + EDGE_DOCK_TIMING.hideDelayMs);
  assert.equal(last(primary).expanded, false);
  assert.equal(primary.opacity, 0);
});

test('quiet mode respects its switch, pointer drag guard, focused own full-screen window and probe failure', (t) => {
  let full = true, fail = false, held = true;
  const f = fixture(t, {}, {
    isFullScreen: () => {
      if (fail) throw new Error('probe failed');
      return full;
    },
    primaryButtonDown: () => held
  });
  const data = buildNotchData(stats(), [], { trayContent: 'tokens' });
  f.controller.setData(data);
  const primary = f.windows[0];
  f.screen.point = { x: 735, y: 44 };
  const now = Date.now() + 1000;
  f.controller.poll(now);
  f.controller.poll(now + EDGE_DOCK_TIMING.revealDelayMs);
  assert.equal(last(primary).expanded, false);
  f.preferences.notchHideSummaryInFullScreen = false;
  f.controller.poll(now + 1000);
  assert.equal(last(primary).quietFullScreen, false);
  assert.ok(last(primary).summary);
  f.preferences.notchHideSummaryInFullScreen = true;
  f.deps.BrowserWindow.getFocusedWindow = () => ({ isFullScreen: () => true, getBounds: () => display.bounds });
  f.screen.getDisplayMatching = () => display;
  f.controller.poll(now + 2000);
  assert.equal(last(primary).quietFullScreen, false, 'our own focused full-screen widget is excluded');
  f.deps.BrowserWindow.getFocusedWindow = () => null;
  fail = true;
  f.controller.poll(now + 3000);
  assert.equal(last(primary).quietFullScreen, false);
  assert.ok(last(primary).summary, 'probe failures retain ordinary behavior');
});

test('Notch visibility and refresh settings preserve defaults and explicit switches', () => {
  const start = mainSource.indexOf('    notchEnabled:', mainSource.indexOf('function defaultSettings('));
  const defaultsSource = mainSource.slice(start, mainSource.indexOf('    edgeDockEnabled:', start));
  const defaults = vm.runInNewContext(`({${defaultsSource}})`, { createDefaultTrayLayout: trayLayout.createDefaultTrayLayout });
  assert.equal(defaults.notchStyle, 'inherit');
  assert.equal(defaults.notchHideSummaryInFullScreen, true);
  assert.equal('notchAvoidMenuBar' in defaults, false);
  assert.equal(defaults.notchRefreshEnabled, false);
  const loadedSource = mainSource.slice(mainSource.indexOf('    merged.notchHaptic ='), mainSource.indexOf('    merged.notchSummaryMode ='));
  const patchStart = mainSource.indexOf('      notchHaptic: parseBoolean(');
  const patchSource = mainSource.slice(patchStart, mainSource.indexOf('      notchSummaryMode:', patchStart));
  for (const [hide, refresh] of [[undefined, undefined], [false, true], [true, false]]) {
    const merged = { notchHideSummaryInFullScreen: hide, notchRefreshEnabled: refresh };
    const context = { merged, patch: { ...merged }, settings: defaults, parseBoolean };
    vm.runInNewContext(loadedSource, context);
    const patched = vm.runInNewContext(`({${patchSource}})`, context);
    for (const result of [merged, patched]) {
      assert.equal(result.notchHideSummaryInFullScreen, hide ?? true);
      assert.equal('notchAvoidMenuBar' in result, false);
      assert.equal(result.notchRefreshEnabled, refresh ?? false);
    }
  }
});

test('the full-screen setting saves both checkbox states through its change event', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const source = app.slice(app.indexOf("els.notchHideSummaryInFullScreenInput?.addEventListener("), app.indexOf("for (const input of els.notchHoverActionInputs) {"));
  let change;
  const patches = [];
  const input = { checked: false, addEventListener: (_event, callback) => { change = callback; } };
  vm.runInNewContext(source, { els: { notchHideSummaryInFullScreenInput: input }, saveSettings: patch => patches.push({ ...patch }) });
  change();
  input.checked = true;
  change();
  assert.deepEqual(patches, [{ notchHideSummaryInFullScreen: false }, { notchHideSummaryInFullScreen: true }]);
});


test('full-screen visibility follows screen geometry and rechecks immediately when the selected display changes', (t) => {
  let noNotch = false;
  const checked = [];
  const f = fixture(t, {}, {
    readScreens: () => ({ screens: noNotch ? [] : [native], mainDisplayId: 1 }),
    isFullScreen: d => {
      checked.push(d.id);
      return d.id === 1;
    }
  });
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  const primary = f.windows[0];
  assert.equal(primary.opacity, 1);
  noNotch = true;
  f.screen.emit('display-metrics-changed');
  assert.equal(last(primary).geometry.notched, false);
  assert.equal(primary.opacity, 0);
  noNotch = false;
  f.screen.emit('display-metrics-changed');
  assert.equal(last(primary).geometry.notched, true);
  assert.equal(primary.opacity, 1);
  const external = { ...display, id: 2, bounds: { ...display.bounds, x: 1470 }, workArea: { ...display.workArea, x: 1470 } };
  f.screen.getAllDisplays = () => [display, external];
  f.screen.emit('display-added');
  f.preferences.notchDisplayId = 2;
  f.controller.poll(Date.now() + 50);
  assert.equal(checked.at(-1), 2);
  assert.equal(last(primary).quietFullScreen, false);
  assert.equal(primary.opacity, 1);
});

test('revealing a full-screen summary reserves the wider native canvas before animating', (t) => {
  const f = fixture(t, {}, { isFullScreen: () => true, reducedMotion: false });
  const primary = f.windows[0];
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots: { left: 17, right: 180, minimumLeft: 17, minimumRight: 180 } });
  f.screen.point = { x: 735, y: 43 };
  const now = Date.now() + 1000;
  f.controller.poll(now);
  f.controller.poll(now + EDGE_DOCK_TIMING.revealDelayMs);
  const measurement = last(primary).summaryMeasurement;
  if (measurement) {
    f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots: { left: 17, right: 180, minimumLeft: 17, minimumRight: 180 }, summaryMeasurement: { id: measurement.id } });
    f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { summaryMeasurement: { id: measurement.id, ready: true } });
  }
  assert.equal(last(primary).expanded, true);
  assert.ok(primary.getBounds().width >= last(primary).geometry.headerWidth, 'no header is drawn outside the animation canvas');
  const config = primary.messages.filter(m => m.channel === 'topNotch:animate').at(-1).payload;
  f.ipcMain.emit('topNotch:frame', { sender: primary.webContents }, { id: config.id, elapsed: config.duration });
  assert.equal(primary.opacity, 1);
});


test('Notch haptics tick once per expansion and stay quiet during content updates', (t) => {
  const ticks = [];
  const f = fixture(t, { notchHaptic: true }, { performHaptic: (...args) => ticks.push(args) });
  const { controller, screen, windows: [primary], ipcMain, preferences } = f;
  const data = { sessions: [], summary: null, cells: [{ id: 'codex', accounts: [] }] };
  controller.setData(data);
  screen.point = { x: 735, y: 10 };
  controller.poll(100); controller.poll(240); controller.poll(260);
  assert.deepEqual(ticks, [['generic', 'default']]);
  screen.point = { x: 735, y: 70 }; controller.poll(300); controller.poll(370);
  controller.setData(data);
  ipcMain.emit('topNotch:size', { sender: primary.webContents }, { height: 180 });
  controller.previewScale(1.1); controller.previewScale(1);
  assert.equal(ticks.length, 1, 'content hover, repaints, resizing and zoom previews do not tick');
  screen.point = { x: 20, y: 500 }; controller.poll(500); controller.poll(820);
  preferences.notchHaptic = false;
  screen.point = { x: 735, y: 10 }; controller.poll(900); controller.poll(1040);
  assert.equal(last(primary).expanded, true);
  assert.equal(ticks.length, 1, 'the independent switch disables feedback');
  preferences.notchHaptic = true; controller.setData(data);
  assert.equal(ticks.length, 1, 'enabling midway does not replay the visit');
  controller.setLocked(true); controller.setLocked(false);
  screen.point = { x: 735, y: 10 }; controller.poll(1300); controller.poll(1440);
  assert.equal(ticks.length, 2, 'a later expansion ticks once');
  const nativeCalls = [];
  const options = wiredNotchOptions({ performMacHaptic: value => nativeCalls.push({ ...value }) });
  options.performHaptic('generic', 'default');
  assert.deepEqual(nativeCalls, [{ pattern: 'generic', performanceTime: 'default' }]);
});

test('a failing native haptic leaves Notch expansion usable', (t) => {
  const f = fixture(t, { notchHaptic: true }, { performHaptic: () => { throw new Error('no hardware'); } });
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(100); f.controller.poll(240);
  assert.equal(last(f.windows[0]).expanded, true);
});


test('Notch refresh validates its own action and shares one request with retry and visit guards', async (t) => {
  let resolve, reject, calls = 0, available = true;
  const ticks = [];
  const f = fixture(t, { notchRefreshEnabled: true, notchHaptic: true }, {
    performHaptic: (...args) => ticks.push(args), canRefreshLimits: () => available,
    onRefreshLimits: () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); }
  });
  const { controller, screen, windows, ipcMain, preferences } = f;
  const [primary] = windows;
  const invoke = (sender = primary.webContents) => ipcMain.handlers.get('topNotch:refreshLimits')({ sender });
  assert.equal(invoke().ok, false, 'collapsed entry cannot refresh');
  screen.point = { x: 735, y: 10 }; controller.poll(100); controller.poll(240);
  assert.equal(last(primary).refreshable, true);
  assert.equal(invoke({}).ok, false);
  const first = invoke(), duplicate = invoke();
  assert.equal(first, duplicate);
  await Promise.resolve(); assert.equal(calls, 1);
  resolve({ ok: true }); assert.deepEqual(await first, { ok: true });
  assert.equal(ticks.length, 2, 'one expansion and one successful request, not duplicate success ticks');
  const failed = invoke(); await Promise.resolve(); reject(new Error('offline'));
  assert.deepEqual(await failed, { ok: false, error: 'offline' });
  assert.equal(ticks.length, 2);
  const late = invoke(); await Promise.resolve();
  screen.point = { x: 20, y: 500 }; controller.poll(300); controller.poll(620);
  screen.point = { x: 735, y: 10 }; controller.poll(700); controller.poll(840);
  const before = ticks.length; resolve({ ok: true }); await late;
  assert.equal(ticks.length, before, 'a late result from the previous visit cannot tick a new visit');
  available = false; assert.equal(invoke().ok, false); available = true;
  preferences.notchRefreshEnabled = false; controller.sync(); assert.equal(invoke().ok, false);
  preferences.notchRefreshEnabled = true; controller.sync();
  const pending = invoke(); await Promise.resolve();
  controller.stop(); controller.sync();
  for (const win of windows.slice(1)) ipcMain.emit('topNotch:ready', { sender: win.webContents });
  const quiet = ticks.length; resolve({ ok: true }); await pending;
  assert.equal(ticks.length, quiet, 'obsolete windows do not emit success feedback');
  controller.dispose(); assert.equal(ipcMain.handlers.has('topNotch:refreshLimits'), false);
});

test('Notch subscriptions isolate channels, unsubscribe and preserve callback errors', () => {
  let api;
  const ipcRenderer = new EventEmitter();
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/notch/preload.js'), 'utf8');
  vm.runInNewContext(source, { require: () => ({ ipcRenderer,
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }
  }) });
  const sent = [];
  ipcRenderer.send = (channel, payload) => sent.push({ channel, payload });
  api.reportNotchSize(180, { left: 17, right: 42 }, { id: 7, ready: true });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ channel: 'topNotch:size', payload: {
    height: 180, slots: { left: 17, right: 42 }, summaryMeasurement: { id: 7, ready: true }
  } }]);
  assert.equal(api.reportBubbleSize, undefined);
  assert.equal(api.openResetForecastSource, undefined);
  for (const [method, channel] of [['onAnimate', 'animate'], ['onMotion', 'motion'], ['onRender', 'render']]) {
    const received = [], payload = { id: 1 };
    const name = `topNotch:${channel}`;
    const unsubscribe = api[method](value => received.push(value));
    ipcRenderer.emit('edgeDock:render', {}, payload);
    assert.equal(received.length, 0);
    ipcRenderer.emit(name, {}, payload);
    assert.equal(received[0], payload);
    unsubscribe();
    assert.equal(ipcRenderer.listenerCount(name), 0);
    ipcRenderer.emit(name, {}, payload);
    assert.equal(received.length, 1);
    const error = new Error('Callback failed');
    const stop = api[method](() => { throw error; });
    assert.throws(() => ipcRenderer.emit(name, {}, payload), value => value === error);
    stop();
  }
});

test('Notch and the side dock share refresh feedback rendering and retain independent settings', async () => {
  const result = { ok: true };
  let refreshes = 0;
  const options = wiredNotchOptions({ refreshStatsFromEdgeDock: () => { refreshes++; return result; } });
  assert.equal(await options.onRefreshLimits(), result);
  assert.equal(refreshes, 1);
  let api;
  const channels = [];
  const preload = fs.readFileSync(path.join(__dirname, '../../src/electron/notch/preload.js'), 'utf8');
  vm.runInNewContext(preload, { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { invoke: channel => { channels.push(channel); return Promise.resolve(result); } }
  }) });
  assert.equal(await api.refreshLimits(), result);
  assert.deepEqual(channels, ['topNotch:refreshLimits']);
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const part = source.slice(source.indexOf('let refreshButton = null;'), source.indexOf('function renderPeek('));
  let finish, calls = 0;
  const button = { dataset: {}, setAttribute() {}, append() {}, addEventListener() {} };
  const context = {
    surface: 'notch', state: { payload: { expanded: true, refreshEnabled: true, refreshable: true } },
    t: key => key, el: () => button, clearTimeout() {}, setTimeout: () => 1,
    bridge: { refreshLimits: () => { calls++; return new Promise(resolve => { finish = resolve; }); } }
  };
  vm.createContext(context);
  vm.runInContext(part + '; ensureRefreshButton();', context);
  const first = vm.runInContext('refreshDockLimits()', context);
  assert.equal(button.dataset.state, 'busy'); assert.equal(button.disabled, true);
  await vm.runInContext('refreshDockLimits()', context); assert.equal(calls, 1);
  finish({ ok: true }); await first;
  assert.equal(button.dataset.state, 'success'); assert.equal(button.disabled, false);
  const failed = vm.runInContext('refreshDockLimits()', context); finish({ ok: false }); await failed;
  assert.equal(button.dataset.state, 'error');
  const late = vm.runInContext('refreshDockLimits()', context); const finishLate = finish;
  vm.runInContext("refreshVisit++; refreshBusy = false; refreshResult = ''; paintRefreshButton();", context);
  const next = vm.runInContext('refreshDockLimits()', context); const finishNext = finish;
  finishLate({ ok: false }); await late;
  assert.equal(button.dataset.state, 'busy', 'old cleanup cannot clear a new request');
  finishNext({ ok: true }); await next;
  assert.equal(button.dataset.state, 'success');
});


test('compact entries widen around the same center and reserve the complete list', () => {
  for (const shape of ['auto', 'notch', 'pill']) {
    const geometry = notchGeometry(display, null, shape);
    assert.equal(geometry.gapWidth, 0);
    assert.equal(geometry.notched, shape === 'notch');
    for (const zoom of [0.85, 1, 1.25, 1.5]) {
      const closed = notchBounds(display, geometry, false, 180, { left: 17, right: 42 }, zoom);
      const open = notchBounds(display, geometry, true, 180, { left: 17, right: 42 }, zoom);
      assert.ok(closed.width < open.width);
      assert.ok(Math.abs(closed.x + closed.width / 2 - geometry.centerX) <= 0.5);
      assert.ok(Math.abs(open.x + open.width / 2 - geometry.centerX) <= 0.5);
      assert.equal(open.height, Math.round(Math.min(180, NOTCH_METRICS.openHeight * zoom)), 'no permanent summary row without hardware');
      assert.ok(open.width >= Math.ceil((NOTCH_METRICS.openWidth + (geometry.notched ? 2 * NOTCH_METRICS.openFlare : 0)) * zoom));
    }
  }
  const physicalPill = notchGeometry(display, native, 'pill');
  assert.equal(physicalPill.y, 38);
  assert.equal(physicalPill.gapWidth, 0);
  assert.equal(physicalPill.notched, false);
  for (const expanded of [false, true]) {
    const b = notchBounds(display, physicalPill, expanded);
    assert.equal(b.x + b.width / 2, physicalPill.centerX, 'capsule matches the same half-point center at both endpoints');
  }
});

test('compact summary stays together through expansion and restores on reversal', (t) => {
  const f = fixture(t, {notchShape:'pill'}, { reducedMotion:false });
  const win=f.windows[0];
  f.controller.setData({cells:[],sessions:Object.values(stats().periods.today.sessions),summary:{items:[]}});
  const frame=()=>win.messages.filter(m=>m.channel==='topNotch:motion').at(-1).payload;
  const closed=frame();
  f.screen.point={x:display.bounds.width/2,y:42};
  f.controller.poll(10000); f.controller.poll(10200);
  const animation=win.messages.filter(m=>m.channel==='topNotch:animate').at(-1).payload;
  // Early in the spring, before it reaches (and overshoots) the open shape.
  f.ipcMain.emit('topNotch:frame',{sender:win.webContents},{id:animation.id,elapsed:60});
  const halfway=frame();
  assert.ok(halfway.progress>0&&halfway.progress<1);
  assert.deepEqual(halfway.summaryEdges,closed.summaryEdges);
  assert.ok(halfway.headerHeight>0&&halfway.headerHeight<32);
  f.ipcMain.emit('topNotch:frame',{sender:win.webContents},{id:animation.id,elapsed:animation.duration});
  assert.equal(frame().headerHeight,0);
  assert.deepEqual(frame().summaryEdges,closed.summaryEdges);
});


test('camera-free renderer fits the display limit while reserving a complete primary readout before extra icons', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function notchLogicalPoint('), source.indexOf('function reportNotchContentSize('));
  const left = { style: {}, minimum: 17, width: 300, children: [] }, right = { style: {}, minimum: 40, width: 500 };
  let reported;
  const report = vm.runInNewContext(`${code}; reportNotchSlots`, {
    state: { payload: { summary: {}, geometry: { gapWidth: 0, shoulder: 4, summaryBudget: 76 }, appearance: { zoomFactor: 1 } } },
    fitNotchSlot: (slot, budget) => ({ minimum: slot.minimum, width: Math.max(slot.minimum, Math.min(slot.width, budget ?? Infinity)) }),
    lastNotchSlots: '', bridge: { reportNotchSize: (_height, slots) => { reported = slots; } }
  });
  report({ dataset: {}, querySelector: selector => selector.includes('notch-left') ? left : right });
  assert.ok(reported.left + reported.right + 12 <= 76, 'display limit applies to the complete compact group');
  assert.ok(reported.right >= 40, 'extra icons cannot truncate the primary readout');
  left.children = [{
    classList: { contains: () => true },
    firstElementChild: { querySelector: () => null },
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 20 }) })
  }];
  left.getBoundingClientRect = () => ({ left: 0 });
  report({ dataset: {}, querySelector: selector => selector.includes('notch-left') ? left : right });
  assert.equal(reported.iconInset, 0, 'an app mark must not borrow the second provider mark inset');
});

test('live summary measurement ignores hover enlargement and restores both visual transforms', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function notchLogicalPoint('), source.indexOf('function reportNotchContentSize('));
  const left = { style: { transform: 'translateX(-6px) scale(1.15625)' }, width: 17, children: [] };
  const right = { style: { transform: 'translateX(6px) scale(1.15625)' }, width: 42 };
  const reports = [];
  const report = vm.runInNewContext(`${code}; reportNotchSlots`, {
    state: { payload: { summary: {}, geometry: { gapWidth: 179, summaryBudget: 200 }, appearance: { zoomFactor: 1 } } },
    fitNotchSlot: slot => ({ width: slot.width * (slot.style.transform === 'none' ? 1 : 1.15625), minimum: slot.width }),
    lastNotchSlots: '', bridge: { reportNotchSize: (_height, slots) => reports.push(slots) }
  });
  const head = { dataset: {}, querySelector: selector => selector.includes('notch-left') ? left : right };
  report(head);
  assert.equal(reports[0].left, 17);
  assert.equal(reports[0].right, 42);
  assert.equal(left.style.transform, 'translateX(-6px) scale(1.15625)');
  assert.equal(right.style.transform, 'translateX(6px) scale(1.15625)');
  left.style.transform = right.style.transform = 'none';
  report(head);
  assert.equal(reports.length, 1, 'hover exit cannot cause another native resize');
});

test('rings preserve summary icon scale and grow only hardware-free entries', (t) => {
  for (const shape of ['notch', 'pill']) for (const size of ['small', 'medium', 'large']) {
    const f = fixture(t, { notchShape: shape, notchSize: size, notchRunningIndicatorEnabled: true }, { readScreens: () => ({ screens: [], mainDisplayId: 1 }) });
    f.controller.setData({ cells: [], sessions: Object.values(stats().periods.today.sessions), summary: { items: [{ type: 'icon', provider: 'codex', providerCell: {} }] } });
    const g = last(f.windows[0]).geometry;
    const scale = Math.min({ small: 0.85, medium: 1, large: 1.25 }[size], 1.2);
    assert.equal(g.summaryZoom, scale);
    assert.equal(g.summaryRingSize, 42);
    assert.equal(g.height, Math.ceil(42 * scale + 8));
  }
  const f = fixture(t, { notchRunningIndicatorEnabled: true, notchSize: 'large' });
  f.controller.setData({ cells: [], sessions: Object.values(stats().periods.today.sessions), summary: { items: [{ type: 'icon', provider: 'codex', providerCell: {} }] } });
  const g = last(f.windows[0]).geometry;
  assert.equal(g.height, native.safeTop);
  assert.equal(g.summaryZoom, 1.2);
  assert.equal(g.summaryRingSize, 0, 'the camera band never squeezes the mark into a ring');
  f.preferences.notchShape = 'pill';
  f.controller.sync();
  assert.equal(last(f.windows[0]).geometry.summaryRingSize, 42);
  f.preferences.notchShape = 'auto';
  f.controller.sync();
  assert.equal(last(f.windows[0]).geometry.summaryRingSize, 0);
  assert.equal(f.preferences.notchRunningIndicatorEnabled, true, 'shape changes retain the ring preference');
});

test('summary ring resize interpolates height and preserves the existing icon center', (t) => {
  const f = fixture(t, { notchShape: 'pill' }, { reducedMotion: false });
  const win = f.windows[0];
  f.controller.setData({ cells: [], sessions: Object.values(stats().periods.today.sessions), summary: { items: [{ type: 'icon', provider: 'codex', providerCell: {} }] } });
  const frame = () => win.messages.filter(m => m.channel === 'topNotch:motion').at(-1).payload;
  const before = frame();
  f.preferences.notchRunningIndicatorEnabled = true;
  f.controller.sync();
  f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots: { left: 42, right: 42, minimumLeft: 42, minimumRight: 42, iconInset: 12.5 } });
  const animation = win.messages.filter(m => m.channel === 'topNotch:animate').at(-1).payload;
  const started = frame();
  assert.equal(started.summaryHeight, before.summaryHeight);
  assert.equal(started.summaryEdges.left + started.summaryIconInset, before.summaryEdges.left);
  f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: animation.id, elapsed: animation.duration / 2 });
  assert.ok(frame().summaryHeight > 32 && frame().summaryHeight < 50);
  f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: animation.id, elapsed: animation.duration });
  assert.equal(frame().summaryHeight, 50);
});

test('camera-free quiet entries hide the empty shell and remain hoverable', (t) => {
  for (const shape of ['notch', 'pill']) for (const active of [false, true]) {
    const f = fixture(t, { notchShape: shape }, { readScreens: () => ({ screens: [], mainDisplayId: 1 }) });
    const primary = f.windows[0];
    const input = stats();
    if (!active) for (const session of Object.values(input.periods.today.sessions)) session.turnEnded = true;
    f.controller.setData(buildNotchData(input, [{ id: 'codex', provider: 'codex', accounts: [] }], {
      notchSummaryEnabled: !active, notchSummaryMode: 'custom', notchCustomLayout: { version: 3, items: [] }
    }));
    assert.equal(primary.opacity, 0, 'empty custom content or summary off leaves no empty shell');
    const g = last(primary).geometry;
    f.screen.point = { x: g.centerX, y: g.y + 16 };
    f.controller.poll(10000); f.controller.poll(10200);
    assert.equal(primary.opacity, 1);
    assert.equal(last(primary).expanded, true);
    assert.equal(last(primary).cells[0].id, 'codex');
    f.screen.point = { x: 20, y: 500 };
    f.controller.poll(11000); f.controller.poll(11000 + EDGE_DOCK_TIMING.hideDelayMs);
    assert.equal(primary.opacity, 0);
  }
});


test('Notch haptics default on and stay independent of side dock settings', (t) => {
  for (const edgeDockHaptic of [false, true]) for (const notchHaptic of [undefined, false, true]) {
    let ticks = 0;
    const f = fixture(t, { edgeDockHaptic, notchHaptic }, { performHaptic: () => ticks++ });
    f.controller.setData({ cells: [], summary: null, sessions: [] });
    f.screen.point = { x: 735, y: 10 };
    f.controller.poll(100); f.controller.poll(100 + EDGE_DOCK_TIMING.revealDelayMs);
    assert.equal(last(f.windows[0]).expanded, true);
    assert.equal(ticks, notchHaptic === false ? 0 : 1);
  }
});


test('ordinary cost summaries preserve tray automatic precision, including zero', () => {
  const { formatTrayText } = require('../../src/shared/trayText');
  for (const costUsd of [0, 0.004, 1]) {
    const input = { periods: { today: { totalTokens: 100, costUsd }, allTime: { totalTokens: 100, costUsd } } };
    for (const trayContent of ['cost', 'costAll', 'both', 'bothAll']) {
      const output = buildNotchData(input, [], { trayContent }).summary.items.find(item => item.measure?.metric === 'cost');
      const expected = formatTrayText(input, trayContent, 'USD').split(' · ').at(-1);
      assert.equal(output.text, expected, `${trayContent}: ${costUsd}`);
      assert.equal(output.measure.costDecimals, 'auto');
    }
  }
  const custom = trayLayout.createTrayLayoutItem('cost');
  custom.costDecimals = 3;
  assert.equal(summaryLayout({ trayContent: 'custom', trayCustomLayout: { version: trayLayout.VERSION, items: [custom] } }).items[0].costDecimals, 3);
});

test('Liquid Glass follows both theme directions without recreating windows', (t) => {
  let dark = true;
  const updates = [];
  const f = fixture(t, { notchStyle: 'liquid-glass', notchShape: 'pill' }, {
    nativeGlass: () => true, liquidGlass: () => ({ dark }),
    createGlass: () => ({ update(value) { updates.push(value.dark); }, dispose() {} })
  });
  assert.equal(updates.at(-1), true);
  for (const next of [false, true]) {
    dark = next;
    if (next) f.controller.setAppearance({ theme: 'dark' });
    else f.controller.sync();
    assert.equal(updates.at(-1), next);
    assert.equal(f.windows.length, 1);
  }
});

test('notch inherits Clear from the widget and switches its own style without recreating windows', (t) => {
  const updates = new Map();
  const f = fixture(t, { notchStyle: 'inherit', macBackdrop: 'liquid-glass-clear', edgeDockMacBackdrop: 'liquid-glass', macGlassTint: 12, macClearGlassTint: 64 }, {
    nativeGlass: () => true, liquidGlass: () => ({ dark: true }),
    createGlass: win => ({ update(value) { updates.set(win, [value.style, value.tintOpacity]); }, dispose() {} })
  });
  assert.deepEqual(updates.get(f.windows[0]), ['clear', 0]);
  for (const [style, expected] of [['liquid-glass', 'regular'], ['liquid-glass-clear', 'clear'], ['inherit', 'clear']]) {
    f.preferences.notchStyle = style;
    f.controller.sync();
    assert.deepEqual(updates.get(f.windows[0]), [expected, 0]);
    assert.equal(f.windows.length, 1);
  }
  f.preferences.macClearGlassTint = 23;
  f.controller.setAppearance({});
  assert.deepEqual(updates.get(f.windows[0]), ['clear', 0]);
});

test('Notch glass previews preserve currency and subscriptions across hidden reveal and retain its independent native style', (t) => {
  const updates = [];
  const f = fixture(t, { notchStyle: 'liquid-glass-clear', macBackdrop: 'liquid-glass', macClearGlassTint: 64 }, {
    nativeGlass: () => true, liquidGlass: () => ({ dark: true }),
    createGlass: () => ({ update(value) { updates.push(value); }, dispose() {} })
  });
  const original = { language: 'zh-TW', currency: 'HKD', currencyRatesEffective: { HKD: 7.8 },
    subscriptions: [{ id: 'subscription', amount: 20 }], themeColors: { bg: '#123456' }, glassOpacity: 68, glassBlur: 32 };
  f.controller.setAppearance(original);
  for (const win of f.windows) win.shown = false;
  assert.equal(f.controller.isRunning(), true);
  for (const glassOpacity of [17, 0, 84]) {
    f.controller.setAppearance({ glassOpacity, glassBlur: 75, currency: 'USD', subscriptions: [],
      themeColors: {}, notchStyle: 'liquid-glass' }, { preview: true });
    const appearance = last(f.windows[0]).appearance;
    for (const key of Object.keys(original)) assert.deepEqual(appearance[key], key === 'glassOpacity' ? glassOpacity : key === 'glassBlur' ? 75 : original[key]);
    assert.equal(updates.at(-1).style, 'clear');
    assert.equal(updates.at(-1).tintOpacity, 0, 'attached glass uses only its camera scrim tint');
  }
  assert.equal(original.glassOpacity, 68);
  f.windows[0].showInactive(); f.controller.sync();
  assert.equal(last(f.windows[0]).appearance.glassOpacity, 84);
  assert.equal(last(f.windows[0]).appearance.currency, 'HKD');
  assert.equal(f.windows.length, 1);
  const next = { ...original, currency: 'TWD', currencyRatesEffective: { TWD: 32 }, subscriptions: [{ id: 'updated' }] };
  f.controller.setAppearance(next);
  f.controller.setAppearance({ glassOpacity: 25 }, { preview: true });
  assert.deepEqual(last(f.windows[0]).appearance.subscriptions, next.subscriptions);
  assert.deepEqual(last(f.windows[0]).appearance.currencyRatesEffective, next.currencyRatesEffective);
  assert.equal(last(f.windows[0]).appearance.currency, 'TWD');
});

test('renderer load rejection is logged for each window and can be stopped', async (t) => {
  const messages = [];
  const f = fixture(t, {}, { loadFile: () => Promise.reject(new Error('fixture load failure')), logger: text => messages.push(text) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.filter(text => text.includes('load failed: fixture load failure')).length, 1);
  assert.doesNotThrow(() => f.controller.stop());
  assert.ok(f.windows.every(win => win.isDestroyed()));
});

test('throwing native cleanup does not prevent window and IPC disposal', (t) => {
  const messages = [];
  const f = fixture(t, { notchStyle: 'liquid-glass' }, {
    nativeGlass: () => true, liquidGlass: () => ({ dark: true }), logger: text => messages.push(text),
    createGlass: () => ({ update() {}, dispose() { throw new Error('fixture cleanup failure'); } })
  });
  assert.doesNotThrow(() => f.controller.dispose());
  assert.equal(f.controller.isRunning(), false);
  assert.ok(f.windows.every(win => win.isDestroyed()));
  assert.equal(f.screen.listenerCount('display-metrics-changed'), 0);
  assert.equal(f.ipcMain.handlers.size, 0);
  assert.equal(f.ipcMain.eventNames().filter(name => name.startsWith('topNotch:')).length, 0);
  assert.equal(messages.filter(text => text.includes('fixture cleanup failure')).length, 1);
});

test('material failure still falls back when native cleanup also throws', (t) => {
  const messages = [];
  const f = fixture(t, { notchStyle: 'liquid-glass' }, {
    nativeGlass: () => true, liquidGlass: () => ({ dark: true }), logger: text => messages.push(text),
    createGlass: () => ({ update() { throw new Error('fixture material failure'); }, dispose() { throw new Error('fixture cleanup failure'); } })
  });
  assert.equal(last(f.windows[0]).liquidGlass, false);
  assert.equal(last(f.windows[0]).glass, false);
  assert.ok(messages.some(text => text.includes('fixture material failure')));
  assert.doesNotThrow(() => f.controller.stop());
});

test('a mid-animation material failure restores fallback state on the failing frame', (t) => {
  for (const cleanupThrows of [false, true]) {
    let fail = false, updates = 0, disposals = 0;
    const f = fixture(t, { notchStyle: 'liquid-glass-clear' }, {
      reducedMotion: false, nativeGlass: () => true, liquidGlass: () => ({ dark: true }),
      createGlass: () => ({ hardwareShade: true,
        update() { updates++; if (fail) throw new Error('injected animation material failure'); },
        dispose() { disposals++; if (cleanupThrows) throw new Error('injected cleanup failure'); }
      })
    });
    const win = f.windows[0], geometry = last(win).geometry;
    f.screen.point = { x: geometry.centerX, y: 10 }; f.controller.poll(1000);
    const animation = win.messages.filter(message => message.channel === 'topNotch:animate').at(-1).payload;
    const tick = elapsed => f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: animation.id, elapsed });
    tick(80);
    assert.equal(last(win).nativeHardwareShade, true, 'glass initialized and painted successfully');
    fail = true;
    const start = win.messages.length;
    tick(120);
    const messages = win.messages.slice(start);
    const fallback = messages.find(message => message.channel === 'topNotch:render')?.payload;
    assert.ok(fallback, 'failure must notify the renderer before the animation completes');
    assert.equal(fallback.glass, false);
    assert.equal(fallback.liquidGlass, false);
    assert.equal(fallback.nativeHardwareShade, false);
    assert.ok(fallback.motion.progress > 0 && fallback.motion.progress < 1);
    assert.equal(fallback.motion.motionId, animation.id);
    assert.deepEqual(fallback.motion, messages.find(message => message.channel === 'topNotch:motion').payload);
    assert.ok(fallback.motion.shape.d, 'the fallback receives the current outline');
    assert.equal(disposals, 1);
    const stopped = updates, renderCount = win.messages.filter(message => message.channel === 'topNotch:render').length;
    tick(160);
    assert.equal(updates, stopped, 'the failed native material is not retried');
    assert.equal(win.messages.filter(message => message.channel === 'topNotch:render').length, renderCount, 'ordinary frames stay shape-only');
    tick(animation.duration);
    assert.equal(last(win).nativeHardwareShade, false);
    assert.equal(last(win).motion.progress, 1);
  }
});

test('unexpectedly closed windows cannot be polled or receive stale IPC', (t) => {
  const f = fixture(t);
  const win = f.windows[0];
  win.destroy();
  win.setIgnoreMouseEvents = () => { throw new Error('Object has been destroyed'); };
  assert.equal(f.controller.owns(win), false);
  assert.doesNotThrow(() => f.controller.poll(Date.now() + 3000));
  assert.doesNotThrow(() => f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { height: 200 }));
  f.controller.sync();
  assert.equal(f.windows.length, 2, 'existing synchronization recreates the shell');
  assert.ok(f.windows[0].isDestroyed());
});

test('native read failure preserves only matching display geometry and retries at the existing cadence', (t) => {
  let result = { screens: [native], mainDisplayId: 1 }, current = structuredClone(display);
  const reads = [];
  const f = fixture(t, {}, { readScreens: options => { reads.push(options.refresh); if (result instanceof Error) throw result; return result; } });
  f.screen.getAllDisplays = () => [current]; f.screen.getPrimaryDisplay = () => current;
  const top = f.windows[0], now = Date.now() + 3000;
  result = { screens: [], mainDisplayId: null, failed: true };
  f.controller.poll(now);
  assert.equal(last(top).geometry.gapWidth, 179, 'read failure is not evidence of missing hardware');
  const count = reads.length;
  f.controller.poll(now + 1999); assert.equal(reads.length, count);
  f.controller.poll(now + 2000); assert.equal(reads.at(-1), true, 'failed refresh remains dirty for the next retry');
  current.workArea.y = 40; current.workArea.height = 916;
  result = new Error('temporary AppKit failure');
  assert.doesNotThrow(() => f.controller.poll(now + 4000));
  assert.equal(last(top).geometry.gapWidth, 179, 'menu work area does not invalidate camera geometry');
  current.rotation = 90;
  f.controller.poll(now + 6000);
  assert.equal(last(top).geometry.gapWidth, 0, 'a changed display must not inherit old hardware geometry');
  result = { screens: [native], mainDisplayId: 1 }; current.rotation = 0;
  f.controller.poll(now + 8000); assert.equal(last(top).geometry.gapWidth, 179);
  result = { screens: [], mainDisplayId: 1 };
  f.controller.poll(now + 10000); assert.equal(last(top).geometry.gapWidth, 0, 'a successful no-notch result replaces the cache');
});

test('geometry cache survives enable cycles but refreshes display configuration changes while stopped', (t) => {
  const reads = [];
  const f = fixture(t, {}, { readScreens: options => { reads.push(options.refresh); return { screens: [native], mainDisplayId: 1 }; } });
  for (let i = 0; i < 12; i++) { f.controller.stop(); f.controller.sync(); }
  assert.equal(reads.filter(Boolean).length, 1, 'enable cycles do not rescan unchanged native geometry');
  for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(f.screen.listenerCount(name), 1);
  f.controller.stop();
  const current = { ...display, scaleFactor: 1 };
  f.screen.getAllDisplays = () => [current]; f.screen.getPrimaryDisplay = () => current;
  f.controller.sync(); assert.equal(reads.at(-1), true, 'configuration changes while disabled invalidate the cache');
  f.controller.stop(); const count = reads.length;
  f.controller.poll(Date.now() + 5000); assert.equal(reads.length, count);
  for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(f.screen.listenerCount(name), 0);
});

test('idle polling does not repeat unchanged mouse passthrough or renderer updates', (t) => {
  const reads = [];
  const f = fixture(t, {}, { readScreens: options => { reads.push(options.refresh); return { screens: [native], mainDisplayId: 1 }; } });
  const top = f.windows[0]; let mouseCalls = 0;
  const original = top.setIgnoreMouseEvents;
  top.setIgnoreMouseEvents = function (value) { mouseCalls++; original.call(this, value); };
  const messages = top.messages.length, now = Date.now() + 3000;
  let displayReads = 0; f.screen.getAllDisplays = () => { displayReads++; return [display]; };
  for (let i = 0; i < 200; i++) f.controller.poll(now + i * 50);
  assert.equal(mouseCalls, 0, 'static click-through state needs no repeated native setter');
  assert.equal(top.messages.length, messages, 'unchanged native focus/geometry does not repaint');
  assert.ok(reads.length <= 6, 'no high-frequency geometry reads');
  assert.ok(displayReads <= 5, 'display metadata is not queried on mouse ticks');
  f.controller.setLocked(true); f.controller.setLocked(false);
  assert.equal(top.ignoreMouse, true);
});

test('unlock lands on the closed shell without replaying an expanded path', (t) => {
  for (const elapsed of [120, 360]) {
    const f = fixture(t, {}, { reducedMotion: false });
    const primary = f.windows[0], bounds = primary.getBounds(), header = last(primary).geometry;
    const frame = () => primary.messages.filter(m => m.channel === 'topNotch:motion').at(-1).payload;
    f.screen.point = { x: bounds.x + header.headerX + 20, y: bounds.y + 10 };
    f.controller.poll(100); f.controller.poll(240);
    const opening = primary.messages.filter(m => m.channel === 'topNotch:animate').at(-1).payload;
    f.ipcMain.emit('topNotch:frame', { sender: primary.webContents }, { id: opening.id, elapsed });
    assert.ok(frame().bodyHeight > 0);
    f.controller.setLocked(true);
    assert.equal(primary.getOpacity(), 0);
    f.screen.point = { x: 20, y: 900 };
    f.controller.setLocked(false);
    assert.equal(last(primary).expanded, false);
    assert.equal(frame().progress, 0);
    assert.equal(frame().bodyHeight, 0, 'the first unlocked frame contains no expanded body');
    const closed = frame();
    f.ipcMain.emit('topNotch:frame', { sender: primary.webContents }, { id: opening.id, elapsed: 360 });
    assert.deepEqual(frame(), closed, 'late pre-lock frames cannot revive the open shell');
  }
});

test('same-shape display transfers land on the destination without a spanning canvas', (t) => {
  for (const expanded of [false, true]) {
    let activeDisplay = 1;
    const f = fixture(t, { notchShape: 'pill' }, { reducedMotion: false,
      readScreens: () => ({ screens: [], mainDisplayId: activeDisplay }) });
    const primary = f.windows[0];
    const other = { ...display, id: 2, bounds: { ...display.bounds, x: 1470 }, workArea: { ...display.workArea, x: 1470 } };
    f.screen.getAllDisplays = () => [display, other];
    const before = primary.getBounds(), header = last(primary).geometry;
    if (expanded) {
      f.screen.point = { x: before.x + header.headerX + 20, y: before.y + 10 };
      f.controller.poll(100); f.controller.poll(240);
    }
    const opening = primary.messages.filter(m => m.channel === 'topNotch:animate').at(-1)?.payload;
    const frame = () => primary.messages.filter(m => m.channel === 'topNotch:motion').at(-1).payload;
    for (const target of [other, display]) {
      activeDisplay = target.id;
      f.screen.emit('display-metrics-changed');
      assert.equal(primary.getBounds().width, before.width, 'no canvas joins the old and new screens');
      assert.equal(primary.getBounds().x, before.x + target.bounds.x);
      assert.equal(primary.messages.filter(m => m.channel === 'topNotch:animate').at(-1).payload.duration, 0);
      assert.equal(frame().progress, expanded ? 1 : 0);
      const placed = frame();
      if (opening) f.ipcMain.emit('topNotch:frame', { sender: primary.webContents }, { id: opening.id, elapsed: opening.duration });
      assert.deepEqual(frame(), placed, 'late old-display frames cannot repaint the destination');
    }
  }
});

test('unlock during a pre-lock hover dwell starts collapsed with a fresh dwell', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  const f = fixture(t, { notchHoverDelay: 300 });
  const win = f.windows[0], geometry = last(win).geometry;
  f.screen.point = { x: win.bounds.x + geometry.headerX + 20, y: win.bounds.y + 10 };
  f.controller.poll(Date.now());
  f.controller.setLocked(true);
  t.mock.timers.tick(60000);
  f.controller.setLocked(false);
  assert.equal(last(win).expanded, false, 'the pre-lock dwell does not expand on unlock');
  const resumed = Date.now();
  f.controller.poll(resumed);
  f.controller.poll(resumed + 299);
  assert.equal(last(win).expanded, false);
  f.controller.poll(resumed + 300);
  assert.equal(last(win).expanded, true);
});

test('locking pauses polling and unlock or repeated sync keeps one timer', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  const f = fixture(t); let cursorReads = 0;
  f.screen.getCursorScreenPoint = () => { cursorReads++; return f.screen.point; };
  t.mock.timers.tick(90); t.mock.timers.tick(90); assert.equal(cursorReads, 2);
  f.controller.setLocked(true);
  t.mock.timers.tick(5000); assert.equal(cursorReads, 2, 'locked entry has no mouse wakeups');
  f.controller.sync(); t.mock.timers.tick(5000); assert.equal(cursorReads, 2, 'settings sync while locked does not restart polling');
  f.controller.setLocked(false); const resumed = cursorReads;
  t.mock.timers.tick(90); t.mock.timers.tick(90); assert.equal(cursorReads - resumed, 2);
  f.controller.sync(); f.controller.sync(); const synced = cursorReads;
  t.mock.timers.tick(90); t.mock.timers.tick(90); assert.equal(cursorReads - synced, 2, 'sync never duplicates the timer');
  f.controller.stop(); const stopped = cursorReads;
  f.controller.setLocked(false); t.mock.timers.tick(5000);
  assert.equal(cursorReads, stopped, 'unlock never starts a disabled entry');
});

test('Notch polls at display rate near the menu bar and at the dock idle cadence elsewhere', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  const f = fixture(t);
  const reads = [];
  f.screen.getCursorScreenPoint = () => { reads.push(Date.now()); return f.screen.point; };
  t.mock.timers.tick(89); assert.equal(reads.length, 0);
  t.mock.timers.tick(1); assert.deepEqual(reads, [10090]);
  const top = f.windows[0], payload = last(top);
  f.screen.point = { x: top.bounds.x + payload.geometry.headerX + 10, y: top.bounds.y + 10 };
  t.mock.timers.tick(90); assert.equal(reads.at(-1), 10180);
  assert.equal(last(top).expanded, true);
  // Hover feedback follows the pointer frame by frame near the entry.
  t.mock.timers.tick(15); assert.equal(reads.length, 2);
  t.mock.timers.tick(1); assert.equal(reads.at(-1), 10196);
  f.screen.point = { x: 20, y: 400 };
  for (let i = 0; i < 20; i++) t.mock.timers.tick(40);
  assert.equal(last(top).expanded, false);
  const idle = reads.length;
  while (reads.length === idle) t.mock.timers.tick(1);
  const start = reads.at(-1);
  t.mock.timers.tick(89); assert.equal(reads.at(-1), start);
  t.mock.timers.tick(1); assert.equal(reads.at(-1), start + 90);
});

test('disable and re-enable recreates renderer windows and rejects their old senders', (t) => {
  const f = fixture(t), old = [...f.windows];
  old[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(f.windows.length, 1, 'a crash is not automatically recovered');
  f.preferences.notchEnabled = false; f.controller.sync();
  assert.ok(old.every(win => win.isDestroyed()));
  f.preferences.notchEnabled = true; f.controller.sync();
  const fresh = f.windows.slice(1);
  assert.equal(fresh.length, 1);
  for (const win of fresh) f.ipcMain.emit('topNotch:ready', { sender: win.webContents });
  assert.ok(fresh.every(win => last(win)), 'each fresh renderer receives its initial payload');
  const messages = fresh[0].messages.length;
  f.ipcMain.emit('topNotch:size', { sender: old[0].webContents }, { height: 999 });
  assert.equal(fresh[0].messages.length, messages, 'old renderer cannot mutate the new windows');
});


test('identical data and size reports do not repeat native visibility or panel placement', (t) => {
  const f = fixture(t);
  const [primary] = f.windows;
  const input = { cells: [{ id: 'codex', kind: 'limit', provider: 'codex' }], sessions: [], summary: null };
  f.controller.setData(input);
  f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { height: 150 });
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(100); f.controller.poll(240);
  const calls = { showInactive: 0, setOpacity: 0, setBounds: 0 };
  for (const name of Object.keys(calls)) {
    const original = primary[name];
    primary[name] = function (...args) { calls[name]++; return original.apply(this, args); };
  }
  for (let i = 0; i < 20; i++) {
    f.controller.setData(input);
    f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { height: 150 });
  }
  assert.deepEqual(calls, { showInactive: 0, setOpacity: 0, setBounds: 0 });
  f.controller.setLocked(true); assert.equal(primary.getOpacity(), 0);
  f.controller.setLocked(false); assert.equal(primary.getOpacity(), 1);
});


test('summary icons reuse configured provider projections and only build missing providers', (t) => {
  const presentation = require('../../src/electron/renderer/edgeDock/presentation');
  const original = presentation.buildEdgeDockCells;
  const requests = [];
  presentation.buildEdgeDockCells = (input, options) => { requests.push(options.items); return original(input, options); };
  t.after(() => { presentation.buildEdgeDockCells = original; });
  const input = stats();
  const cell = buildEdgeDockCells(input)[0];
  assert.equal(cell.provider, 'codex');
  const icon = trayLayout.createTrayLayoutItem('providerIcon');
  icon.source.provider = 'codex';
  const settings = { trayContent: 'custom', trayCustomLayout: { version: trayLayout.VERSION, items: [icon] } };
  const configured = buildNotchData(input, [cell], settings);
  assert.equal(configured.summary.items[0].providerCell, cell);
  assert.deepEqual(requests, [], 'existing projection avoids another scan of provider and session facts');
  const missing = buildNotchData(input, [], settings);
  assert.deepEqual(requests, [[{ type: 'limit', provider: 'codex' }]]);
  assert.equal(missing.summary.items[0].providerCell.provider, 'codex');
});


test('data and settings pushes while locked keep the latest facts without waking native layout or polling', (t) => {
  const timeout = global.setTimeout;
  let timeouts = 0;
  global.setTimeout = (...args) => { timeouts++; return timeout(...args); };
  t.after(() => { global.setTimeout = timeout; });
  const f = fixture(t);
  f.controller.setLocked(true);
  const primary = f.windows[0];
  const sent = primary.messages.length;
  const input = { cells: [{ id: 'new', provider: 'claude' }], sessions: [{ client: 'claude', lastUsedAt: new Date().toISOString() }], summary: null };
  const before = timeouts;
  f.controller.setData(input);
  f.controller.sync();
  assert.equal(timeouts, before, 'locked pushes never rearm the cursor timer');
  assert.equal(primary.messages.length, sent, 'locked data stays in memory instead of repainting');
  f.controller.setLocked(false);
  assert.equal(last(primary).cells[0].id, 'new', 'unlock presents the newest facts');
  assert.ok(timeouts > before, 'cursor polling resumes after unlock');
});

test('disabled summary skips layout resolution while retaining provider data', () => {
  const cells = [{ id: 'codex', provider: 'codex' }];
  const stats = { periods: { today: { sessions: {
    live: { sessionId: 'live', client: 'codex', lastUsedAt: new Date().toISOString(), totalTokens: 50 }
  } } } };
  const settings = { notchSummaryEnabled: false, notchSummaryMode: 'custom',
    get notchCustomLayout() { throw new Error('disabled layout must not be read'); } };
  const data = buildNotchData(stats, cells, settings);
  assert.equal(data.summary, null);
  assert.equal(data.cells, cells);
});

test('disabled summary clears its rate timer and trackers without sampling or formatting', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const code = source.slice(source.indexOf('function notchDataFor('), source.indexOf('function toggleDockRateMode('));
  const cleared = [];
  const trackers = new Map([['local', { stale: true }]]);
  const cells = [{ id: 'codex' }], stats = { id: 'latest' };
  const context = {
    settings: { notchSummaryEnabled: false }, notchRateTimer: 123, notchRateTrackers: trackers,
    clearTimeout: timer => cleared.push(timer),
    buildNotchData: (value, items, preferences) => {
      assert.equal(value, stats); assert.equal(items, cells); assert.equal(preferences.notchSummaryEnabled, false);
      return { summary: null, cells: items };
    }
  };
  vm.runInNewContext(code, context);
  assert.equal(context.notchDataFor(stats, cells).summary, null);
  assert.deepEqual(cleared, [123]);
  assert.equal(context.notchRateTimer, null);
  assert.equal(trackers.size, 0);
});


test('summary resize batches fit text before reporting slots', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('const notchSummaryObserver'), source.indexOf('function notchText('));
  const events = [];
  let callback;
  const head = {};
  vm.runInNewContext(code, {
    ResizeObserver: class { constructor(fn) { callback = fn; } },
    contentLayer: { querySelector: () => head },
    fitNotchTypeface: target => events.push(target.id),
    reportNotchSlots: target => { assert.equal(target, head); events.push('report'); },
    animateNotchNumbers: () => events.push('animate')
  });
  const target = (id, text) => ({ id, classList: { contains: name => text && name === 'notch-text-run' } });
  callback([{ target: target('slot', false) }, { target: target('text-one', true) }, { target: target('text-two', true) }]);
  assert.deepEqual(events, ['text-one', 'text-two', 'report', 'animate']);
});

test('summary readings and standalone rings follow the same pending or active Codex account as dock rows', () => {
  const input = stats();
  const records = [
    { provider: 'codex', status: 'ok', accountKey: 'old', sourceDetail: 'live', windows: [{ kind: 'session', remainingPercent: 20 }] },
    { provider: 'codex', status: 'ok', accountKey: 'next', sourceDetail: 'managed', windows: [{ kind: 'session', remainingPercent: 77 }] }
  ];
  input.limits.providers = records;
  input.devices = [{ deviceId: 'here', limits: { providers: [records[0]] } }];
  const accounts = [{ id: 'old-login', accountKey: 'old' }, { id: 'next-login', accountKey: 'next' }];
  const icon = trayLayout.createTrayLayoutItem('providerIcon');
  icon.source.provider = 'codex';
  const reading = trayLayout.createTrayLayoutItem('percent');
  reading.source.provider = 'codex';
  reading.source.accountMode = 'active';
  const preferences = { deviceId: 'here', currency: 'USD', notchSummaryMode: 'custom',
    notchCustomLayout: { version: trayLayout.VERSION, items: [icon, reading] } };
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const code = main.slice(main.indexOf('function notchDataFor('), main.indexOf('function toggleDockRateMode('));
  for (const pending of ['next-login', null]) {
    const activeId = pending || 'old-login';
    const projection = { codexManagedAccounts: accounts, activeCodexAccountId: activeId, localDeviceId: 'here', syncActive: true };
    const expected = buildEdgeDockCells(input, { ...projection, items: [{ type: 'limit', provider: 'codex' }] })[0];
    const context = {
      settings: preferences, notchRateTimer: null, notchRateTrackers: new Map(), clearTimeout() {},
      notchSummaryMode, notchSummaryLayout: summaryLayout, trayLayoutApi: trayLayout, buildNotchData,
      compactTokenDisplayOptions: () => ({}), normalizeCurrency: value => value,
      codexAccountsForRenderer: () => accounts, codexPresentationPendingAccountId: pending,
      codexPresentationActiveAccountId: 'old-login', syncProvenanceActive: () => true
    };
    vm.runInNewContext(code, context);
    for (const cells of [[], [expected]]) {
      const data = context.notchDataFor(input, cells);
      const ring = data.summary.items.find(item => item.type === 'icon').providerCell;
      const value = data.summary.items.find(item => item.type === 'text');
      assert.equal(ring.remainingPercent, expected.remainingPercent);
      assert.equal(ring.headlineAccount, expected.headlineAccount);
      assert.equal(ring.provenanceContext.localDeviceId, 'here');
      assert.equal(ring.provenanceContext.syncActive, true);
      assert.equal(value.measure.value, expected.remainingPercent);
      assert.equal(data.cells, cells, 'standalone ring must not add a quota row');
    }
  }
});


test('unsupported platforms keep Notch disabled without reads, windows or polling', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  for (const platform of ['win32', 'linux']) {
    const f = fixture(t, {}, { platform, readScreens: () => assert.fail('unsupported platform must not read hardware') });
    f.screen.getCursorScreenPoint = () => assert.fail('unsupported platform must not poll');
    f.controller.sync(); f.controller.poll(); t.mock.timers.tick(5000);
    assert.equal(f.controller.isRunning(), false);
    assert.equal(f.windows.length, 0);
    assert.equal(f.preferences.notchEnabled, true, 'platform gates do not rewrite persisted preferences');
  }
});

test('unsupported Notch selections do not activate shared dock work', () => {
  const settings = { edgeDockItems: [{ type: 'stat', metric: 'today' }], notchEnabled: true,
    notchItems: [{ type: 'stat', metric: 'last7days' }, { type: 'stat', metric: 'liveRate' }] };
  for (const platform of ['darwin', 'win32', 'linux']) {
    const lists = vm.runInNewContext(`${configuredDockItemsSource}; configuredDockItemLists()`, { settings, notchLimitItems, NOTCH_PANEL_STAT_ITEMS, process: { platform } });
    assert.equal(lists[0], settings.edgeDockItems, 'the existing EdgeDock selection stays intact');
    assert.equal(lists.length, platform === 'darwin' ? 3 : 1);
    if (platform === 'darwin') { assert.equal(lists[1].length, 0); assert.equal(lists[2], NOTCH_PANEL_STAT_ITEMS); }
    assert.equal(settings.notchEnabled, true);
  }
});


test('summary fitting uses a hard budget, whole graphics and one ellipsis source', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function fitNotchSummaryItems('), source.indexOf('function fitNotchSlot('));
  const fit = vm.runInNewContext(`${code}; fitNotchSummaryItems`);
  const items = [{ width: 17, minimum: 17 }, { width: 98, minimum: 12 }, { width: 30, minimum: 12 }];
  for (const budget of [0, 11, 12, 30, 65, 150, 200]) {
    const result = fit(items, { budget, gap: 6, overflowWidth: 12, primary: 1 });
    const width = result.visible.reduce((sum, i) => sum + result.widths[i], 0)
      + Math.max(0, result.visible.length - 1) * 6 + (result.overflow ? 12 + (result.visible.length ? 6 : 0) : 0);
    assert.ok(width <= budget);
    assert.deepEqual(Array.from(result.visible), Array.from(result.visible).sort((a, b) => a - b));
    if (result.visible.includes(0)) assert.equal(result.widths[0], 17, 'icons remain whole');
    if (result.widths[1] < 98 && result.visible.includes(1)) assert.equal(result.overflow, false, 'text ellipsis replaces the group marker');
  }
  const narrow = fit(items, { budget: 65, gap: 6, overflowWidth: 12, primary: 1 });
  assert.deepEqual(Array.from(narrow.visible), [1]);
  assert.equal(narrow.widths[1], 65);
  const roomy = fit(items, { budget: 150, gap: 6, overflowWidth: 12, primary: 1 });
  assert.deepEqual(Array.from(roomy.visible), [0, 1]);
  assert.equal(roomy.overflow, true);
  const spacers = fit([{ width: 8, minimum: 8, spacer: true }], { budget: 20, gap: 6, overflowWidth: 12 });
  assert.deepEqual(Array.from(spacers.visible), []);
  assert.equal(spacers.overflow, false);
});

test('wide summaries are bounded only by the screen capacity, menu bar items included', (t) => {
  const f = fixture(t);
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  const primary = f.windows[0];
  f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots: { left: 1000, right: 2000 } });
  const geometry = last(primary).geometry;
  assert.equal(geometry.summaryBudget, 633 - NOTCH_METRICS.restingFlare);
  assert.equal(geometry.headerWidth, 1469);
  assert.equal((geometry.headerWidth - geometry.gapWidth) / 2 - 12 - NOTCH_METRICS.restingFlare, geometry.summaryBudget);
});

test('both physical ears use the same finite budget', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function notchLogicalPoint('), source.indexOf('function reportNotchContentSize('));
  const left = { style: {}, minimum: 50, width: 67, children: [] }, right = { style: {}, minimum: 0, width: 89 };
  let reported;
  const report = vm.runInNewContext(`${code}; reportNotchSlots`, {
    state: { payload: { summary: {}, geometry: { gapWidth: 179, summaryBudget: 50 }, appearance: { zoomFactor: 1 } } },
    fitNotchSlot: (slot, budget) => ({ minimum: slot.minimum, width: Math.max(slot.minimum, Math.min(slot.width, budget)) }),
    lastNotchSlots: '', bridge: { reportNotchSize: (_height, slots) => { reported = slots; } }
  });
  report({ dataset: {}, querySelector: selector => selector.includes('notch-left') ? left : right });
  assert.equal(reported.left, 50);
  assert.equal(reported.right, 50);
});


test('independent notch rate preview joins shared sampling only on enabled macOS surfaces', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const code = app.slice(app.indexOf('function displayLiveTokenRateItems('), app.indexOf('function effectiveDisplayLiveTokenRateScope('));
  const rate = trayLayout.createTrayLayoutItem('liveTokenRate');
  const state = { appInfo: { platform: 'darwin' }, settings: {
    trayContent: 'tokens', floatingBubbleEnabled: false, notchEnabled: true,
    notchSummaryMode: 'custom', notchCustomLayout: { version: trayLayout.VERSION, items: [rate] }
  } };
  const items = vm.runInNewContext(`${code}; displayLiveTokenRateItems`, { state, trayLayoutApi: trayLayout });
  assert.equal(items().length, 1);
  assert.equal(items()[0].id, rate.id);
  state.settings.notchSummaryMode = 'tray';
  assert.equal(items().length, 0);
  state.settings.notchSummaryMode = 'custom';
  state.settings.notchEnabled = false;
  assert.equal(items().length, 0);
  state.settings.notchEnabled = true;
  for (const platform of ['win32', 'linux']) {
    state.appInfo.platform = platform;
    assert.equal(items().length, 0);
  }
});

test('following the live rate tray preset preserves its app icon and reading', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const code = app.slice(app.indexOf('function liveTokenRateTrayLayout('), app.indexOf('function trayDataUrlForMode('));
  const original = vm.runInNewContext(`${code}; liveTokenRateTrayLayout()`, { trayLayoutApi: trayLayout });
  const followed = summaryLayout({ trayContent: 'liveTokenRate' });
  const resolve = layout => trayLayout.resolveTrayLayout(layout, stats(), { liveTokenRates: {
    all: { speed: 200, burn: 12000, idle: false }
  } }).items;
  const trayItems = resolve(original), notchItems = resolve(followed);
  assert.equal(notchItems[0].provider, trayItems[0].provider);
  assert.equal(notchItems[0].provider, 'app');
  assert.equal(notchItems[1].text, trayItems[1].text);
  assert.equal(notchItems[1].text, '200 tok/s');
  assert.equal(notchItems[1].available, true);
});


test('entering full-screen collapses an open entry even when no summary changes its bounds', (t) => {
  for (const shape of ['notch', 'pill']) {
    for (const summaryEnabled of [true, false]) {
      let fullScreen = false;
      const f = fixture(t, { notchShape: shape, notchSummaryEnabled: summaryEnabled }, {
        reducedMotion: false, isFullScreen: () => fullScreen
      });
      f.controller.setData(buildNotchData({ periods: { today: { sessions: {} } } }, [], f.preferences));
      const win = f.windows[0];
      const now = Date.now() + 1000;
      const geometry = last(win).geometry;
      f.screen.point = { x: geometry.centerX, y: geometry.y + 1 };
      f.controller.poll(now);
      f.controller.poll(now + EDGE_DOCK_TIMING.revealDelayMs);
      const opened = win.messages.filter(message => message.channel === 'topNotch:animate').at(-1).payload;
      ipcFrame(opened);
      assert.equal(last(win).motion.progress, 1);
      f.screen.point = { x: 20, y: 500 };
      fullScreen = true;
      f.controller.poll(now + 1000);
      const collapsed = win.messages.filter(message => message.channel === 'topNotch:animate').at(-1).payload;
      assert.notEqual(collapsed.id, opened.id, 'full-screen transition starts the existing collapse animation');
      ipcFrame(collapsed);
      assert.equal(last(win).expanded, false);
      assert.equal(last(win).motion.progress, 0);
      assert.equal(last(win).motion.bodyHeight, 0);
      assert.equal(win.opacity, shape === 'pill' ? 0 : 1);
      f.controller.poll(now + 1500);
      assert.equal(last(win).motion.progress, 0);
      function ipcFrame(animation) {
        f.ipcMain.emit('topNotch:frame', { sender: win.webContents }, { id: animation.id, elapsed: animation.duration });
      }
    }
  }
});


test('restoring a rate summary starts a new baseline instead of reporting usage while it was disabled', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const code = source.slice(source.indexOf('function notchDataFor('), source.indexOf('function toggleDockRateMode('));
  const tokenRateApi = require('../../src/electron/renderer/tokenRatePresentation');
  const rate = trayLayout.createTrayLayoutItem('liveTokenRate');
  const tokens = trayLayout.createTrayLayoutItem('tokens');
  const preferences = { notchSummaryMode: 'custom', deviceId: 'here',
    notchCustomLayout: { version: trayLayout.VERSION, items: [rate] } };
  let now = 0;
  const context = {
    settings: preferences, mode: 'local', Date: { now: () => now },
    notchRateTimer: null, notchRateTrackers: new Map(), notchController: { isRunning: () => false },
    clearTimeout() {}, notchSummaryMode, notchSummaryLayout: summaryLayout, trayLayoutApi: trayLayout, tokenRateApi,
    buildNotchData, compactTokenDisplayOptions: () => ({}), normalizeCurrency: value => value,
    codexAccountsForRenderer: () => [], codexPresentationPendingAccountId: null,
    codexPresentationActiveAccountId: null, syncProvenanceActive: () => false
  };
  const project = vm.runInNewContext(`${code}; notchDataFor`, context);
  const input = (tokens, duration) => ({ periods: { today: {
    totalTokens: tokens, timedTokens: tokens, timedOutputTokens: tokens, timedDurationMs: duration, sessions: {}
  } } });
  project(input(0, 0), []);
  now = 1000;
  assert.equal(project(input(50, 1000), []).summary.items[0].measure.value, 50);
  preferences.notchCustomLayout.items = [tokens];
  project(input(50, 1000), []);
  now = 181000;
  preferences.notchCustomLayout.items = [rate];
  const restored = project(input(500, 2000), []).summary.items[0];
  assert.equal(restored.available, false, 'usage accumulated while disabled is not a fresh rate sample');
  assert.equal(restored.measure, null);
  now = 182000;
  assert.equal(project(input(700, 3000), []).summary.items[0].measure.value, 200);
  preferences.notchCustomLayout.items = [tokens];
  project(input(700, 3000), []);
  assert.equal(context.notchRateTrackers.size, 0);
});


test('Notch renderer owns its observers, motion hooks and visible session clock', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const observations = [], hooks = [];
  const context = { module: { exports: {} }, ResizeObserver: class {
    constructor(callback) { observations.push(callback); }
    observe() {} disconnect() {}
  } };
  vm.runInNewContext(source, context);
  const cell = { id: 'selected', kind: 'stat', metric: 'today' }, iconCell = { id: 'summary-icon' };
  const state = { payload: { expanded: true, cells: [cell], summary: { items: [{ providerCell: iconCell }] } } };
  const classes = new Map();
  const deps = { state, document: { documentElement: { classList: { toggle: (name, value) => classes.set(name, value) } } },
    window: { addEventListener() {}, TokenMonitorNotchPanel: { createNotchPanel: () => ({}) }, TokenMonitorUsageCharts: { clientColors: {} }, TokenMonitorPressActivation: {}, TokenMonitorEdgeDockPresentation: { runningSessionSummary() {} } }, root: { classList: { toggle: (name, value) => classes.set(name, value) }, addEventListener() {} },
    bridge: { onAnimate: handler => hooks.push(handler), onMotion: handler => hooks.push(handler) }, shared: {} };
  const create = context.module.exports.createNotchRenderer;
  const renderer = create({ ...deps, surface: 'notch' });
  const primaryObservers = observations.length, primaryHooks = hooks.length;
  assert.ok(primaryObservers > 0, 'the top entry observes its layout');
  assert.ok(primaryHooks > 0, 'the top entry receives motion updates');
  assert.equal(renderer.sessionCells()[0], cell);
  assert.equal(renderer.sessionCells()[1], iconCell);
  assert.equal(renderer.needsClock(), true, 'relative activity times update while the panel is open');
  state.payload.expanded = false;
  assert.equal(renderer.sessionCells().length, 1, 'hidden primary rows do not keep expiry timers alive');
  state.payload.summary.needsClock = true;
  assert.equal(renderer.needsClock(), true);
  renderer.applyAppearance({ style: 'black' });
  assert.equal(classes.get('notch-black'), true);
});


test('transformed summary measurements ignore subpixel noise before rounding logical widths', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const start = source.includes('function notchLogicalPoint(') ? 'function notchLogicalPoint(' : 'function reportNotchSlots(';
  const code = source.slice(source.indexOf(start), source.indexOf('function reportNotchContentSize('));
  const left = { style: {}, width: 28, minimum: 28, children: [] }, right = { style: {}, width: 27, minimum: 27 };
  const reports = [];
  const context = { state: { payload: { summary: {}, geometry: { gapWidth: 179 }, appearance: { zoomFactor: 1 } } },
    fitNotchSlot: slot => slot, lastNotchSlots: '', bridge: { reportNotchSize: (_height, slots) => reports.push(slots) } };
  const report = vm.runInNewContext(`${code};reportNotchSlots`, context);
  const head = { dataset: {}, querySelector: name => name.includes('notch-left') ? left : right };
  report(head);
  left.width = left.minimum = 28.0000038;
  report(head);
  left.width = left.minimum = 27.9999962;
  report(head);
  assert.equal(reports.length, 1, 'transform noise must not alternate 28/29pt and keep restarting the shell');
  left.width = left.minimum = 28.125;
  report(head);
  assert.equal(reports.length, 2, 'a real width change still reaches native layout');
  assert.equal(reports[1].left, 29);
});

test('summary resizing during reveal continues from the visible frame', (t) => {
  const f = fixture(t, { notchShape: 'pill' }, { reducedMotion: false });
  const top = f.windows[0];
  f.controller.setData({ cells: [], sessions: Object.values(stats().periods.today.sessions), summary: { items: [{ type: 'text', text: '51.7M' }] } });
  const b = top.getBounds(), g = last(top).geometry;
  f.screen.point = { x: b.x + g.headerX + 10, y: b.y + 10 };
  f.controller.poll(1000); f.controller.poll(1140);
  const first = top.messages.filter(message => message.channel === 'topNotch:animate').at(-1).payload;
  f.ipcMain.emit('topNotch:frame', { sender: top.webContents }, { id: first.id, elapsed: 200 });
  f.ipcMain.emit('topNotch:size', { sender: top.webContents }, { slots: { left: 17, right: 65, minimumLeft: 17, minimumRight: 65 } });
  const resized = top.messages.filter(message => message.channel === 'topNotch:animate').at(-1).payload;
  assert.notEqual(resized.id, first.id);
  const motions = top.messages.filter(message => message.channel === 'topNotch:motion').map(message => message.payload);
  const before = motions.findLast(frame => frame.motionId === first.id);
  assert.equal(motions.at(-1).progress, before.progress, 'measurement continues from the visible frame instead of restarting the reveal');
  f.ipcMain.emit('topNotch:frame', { sender: top.webContents }, { id: resized.id, elapsed: resized.duration });
  const frame = top.messages.filter(message => message.channel === 'topNotch:motion').at(-1).payload;
  assert.equal(frame.progress, 1);
  assert.equal(frame.done, true);
});


test('Notch summary rolls fitted numbers, retargets glyphs and settles hidden or changed modes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function stopNotchNumber('), source.indexOf('function notchIcon('));
  const frames = new Map(), timers = new Map(), calls = [], used = new Set();
  let id = 0, reduced = false, hidden = false, mode = 'roll';
  const run = { scrollWidth: 30, clientWidth: 30, style: { maxWidth: 'none' } };
  const context = {
    notchNumbers: new Map(), notchStatRolls: new Map(), state: { payload: { expanded: false }, locale: 'en' },
    appearance: () => ({ tokenNumberAnimation: mode }), prefersReducedMotion: () => reduced,
    notchMeasureText: (_measure, value) => String(Math.round(value)), performance: { now: () => 0 },
    el: (_tag, className, textContent) => ({ className, textContent, isConnected: true, closest: selector => selector === '[hidden]' ? hidden ? {} : null : run }),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: key => frames.delete(key),
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: key => timers.delete(key),
    numberAnimation: { normalize: value => value, duration: 800,
      capture: node => node.rolling ? ['visible glyphs'] : null,
      beginRoll(node, from, to, increasing, _prepare, glyphs) {
        calls.push({ from, to, increasing, glyphs }); node.rolling = true;
        if (node.dataset) node.dataset.tokenNumberAnimation = 'roll';
        return () => { node.rolling = false; if (node.dataset) delete node.dataset.tokenNumberAnimation; node.textContent = to; };
      } }
  };
  vm.runInNewContext(code, context);
  const render = value => context.notchNumber('tokens', { measure: { metric: 'tokens', value } }, used);
  const node = render(10);
  assert.equal(calls.length, 0, 'first presentation is immediate');
  assert.equal(render(20), node, 'summary keeps its numeric node');
  assert.equal(calls.length, 0, 'glyph measurement waits for layout fitting');
  context.animateNotchNumbers();
  assert.deepEqual(calls[0], { from: '10', to: '20', increasing: true, glyphs: null });
  assert.equal(timers.size, 1);
  render(30); context.animateNotchNumbers();
  assert.deepEqual(calls[1].glyphs, ['visible glyphs'], 'a retarget captures the current shared effect before settling');
  assert.equal(timers.size, 1, 'old completion timer is cancelled');
  run.clientWidth = 8; run.style.maxWidth = '8px'; context.animateNotchNumbers();
  assert.equal(node.rolling, false, 'an existing roll stops when a menu update clips it');
  assert.equal(timers.size, 0);
  render(40); context.animateNotchNumbers();
  assert.equal(calls.length, 2, 'a clipped field retains native ellipsis without glyph layers');
  assert.equal(node.textContent, '40');
  assert.equal(timers.size, 0);
  run.clientWidth = 30; run.style.maxWidth = 'none'; mode = 'count'; render(50);
  assert.equal(node.textContent, '50', 'switching animation style settles immediately');
  render(60); assert.equal(frames.size, 1);
  hidden = true; context.animateNotchNumbers();
  assert.equal(frames.size, 0, 'omitted fields also release count frames');
  assert.equal(node.textContent, '60');
  hidden = false; render(65); assert.equal(frames.size, 1);
  context.state.payload.expanded = true; context.settleNotchNumbers(); render(70);
  assert.equal(frames.size, 0, 'hidden summary releases its count frame');
  assert.equal(node.textContent, '70');
  context.state.payload.expanded = false; mode = 'roll'; render(70); render(80); context.animateNotchNumbers();
  reduced = true; render(80);
  assert.equal(timers.size, 0);
  assert.equal(node.rolling, false, 'reduced motion releases shared effects');
});


test('Notch visibility transitions settle summary motion without rebuilding its header', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function renderNotch('), source.indexOf('    let notchAnimation ='));
  let settles = 0;
  const payload = { expanded: false, summary: null, cells: [], appearance: {}, geometry: { gapWidth: 179, notched: true } };
  const context = { state: { appearanceKey: 'same' }, notchExpanded: false, notchClock: 0,
    notchHeaderKey: '', panel: { suspend() {} }, settleNotchNumbers: () => settles++, settleNotchStatNumbers() {},
    resetRefreshVisit() {}, paintRefreshButton() {}, root: { classList: { toggle() {} }, style: { setProperty() {} } },
    runningSessionSummary() {}, contentLayer: { querySelector: () => null, prepend() {} },
    captureRingResetMotion() {}, notchSummary: () => ({ style: {} }), animateRingResets() {},
    notchSummaryObserver: { disconnect() {}, observe() {} }, renderNotchPanel() {}, applyNotchMotion() {}, reportNotchContentSize() {} };
  vm.runInNewContext(code, context);
  context.renderNotch(payload);
  const key = context.notchHeaderKey;
  context.renderNotch({ ...payload, expanded: true });
  assert.equal(context.notchHeaderKey, key, 'unchanged data retains its header');
  assert.equal(settles, 1, 'expanding settles summary effects independently of header reconstruction');
  context.renderNotch({ ...payload, summaryMeasurement: { id: 1, measuring: true } });
  assert.equal(settles, 2, 'hidden measurement also settles summary effects');
});


test('Notch refreshes an expired waiting indicator without rebuilding an unchanged summary', () => {
  const presentation = require('../../src/electron/renderer/edgeDock/presentation');
  const { LIVE_ACTIVITY_TTL_MS } = require('../../src/shared/sessionLive');
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function renderNotch('), source.indexOf('    let notchAnimation ='));
  let now = Date.parse('2026-10-13T00:00:00Z'), head = null;
  const sessions = [{ client: 'codex', turnEnded: true,
    lastUsedAt: new Date(now - RUNNING_WINDOW_MS - 1000).toISOString(),
    liveActivity: { state: 'waiting', observedAt: new Date(now).toISOString() } }];
  const waiting = () => presentation.waitingSessionSummary(sessions, now).count;
  const payload = { expanded: false, summary: { needsClock: false,
    items: [{ type: 'icon', providerCell: { sessions } }, { type: 'text', text: '51.7M' }] },
  cells: [], appearance: {}, geometry: { gapWidth: 0, summaryRingSize: 42, notched: false } };
  const context = { state: { appearanceKey: 'same' }, notchExpanded: false, notchClock: 0, notchHeaderKey: '',
    runningSessionSummary: rows => presentation.runningSessionSummary(rows, now),
    presentation: { waitingSessionSummary: rows => presentation.waitingSessionSummary(rows, now) },
    settleNotchNumbers() {}, panel: { suspend() {} }, settleNotchStatNumbers() {}, resetRefreshVisit() {}, paintRefreshButton() {},
    root: { classList: { toggle() {} }, style: { setProperty() {} } },
    contentLayer: { querySelector: () => head, prepend: node => { head = node; } },
    captureRingResetMotion() {}, animateRingResets() {},
    notchSummary: () => ({ style: {}, waiting: waiting(), text: payload.summary.items[1].text,
      remove() {}, querySelectorAll: () => [] }),
    notchSummaryObserver: { disconnect() {}, observe() {} }, positionNotchSummary() {}, reportNotchSlots() {},
    animateNotchNumbers() {}, renderNotchPanel() {}, applyNotchMotion() {}, reportNotchContentSize() {} };
  const render = vm.runInNewContext(`${code};renderNotch`, context);
  render(payload);
  const original = head;
  assert.equal(original.waiting, 1);
  now += LIVE_ACTIVITY_TTL_MS - 1;
  render(payload);
  assert.equal(head, original, 'unchanged activity keeps the summary node');
  now++;
  assert.equal(presentation.runningSessionSummary(sessions, now).count, 0);
  assert.equal(waiting(), 0);
  render(payload);
  assert.notEqual(head, original, 'waiting expiry refreshes the indicator without a new payload');
  assert.equal(head.waiting, 0);
  assert.equal(head.text, '51.7M');
  const expired = head;
  render(payload);
  assert.equal(head, expired, 'quiet activity resumes node reuse');
});

test('a camera-free notch hides an empty resting shell but keeps its hover target', (t) => {
  const f = fixture(t, { notchShape: 'notch' }, { readScreens: () => ({ screens: [], mainDisplayId: 1 }) });
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  const win = f.windows[0];
  f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots: { left: 0, right: 0 } });
  assert.equal(win.opacity, 0, 'no fitted content leaves no visible empty outline');
  const g = last(win).geometry;
  f.screen.point = { x: g.centerX, y: g.y + 1 };
  const now = Date.now() + 1000;
  f.controller.poll(now);
  f.controller.poll(now + EDGE_DOCK_TIMING.revealDelayMs);
  assert.equal(last(win).expanded, true, 'the original hover target remains usable');
  assert.equal(win.opacity, 1);
});

test('a width limit bounds the resting outline before minimum size and parity', () => {
  for (const center of [735, 735.5]) for (const ringHeight of [32, 50]) {
    const g = { notched: true, centerX: center, y: 0, gapWidth: 0, height: ringHeight };
    const limit = 2 * (30 - EDGE_DOCK_METRICS.screenMargin);
    const b = notchBounds(display, g, false, 180, { left: 0, right: 8 }, 1, limit);
    assert.ok(b.x + b.width <= center + 30 - EDGE_DOCK_METRICS.screenMargin);
    assert.ok(b.width <= limit);
    assert.equal(b.x + b.width / 2, center);
    assert.ok(notchBounds(display, g, true, 180, { left: 0, right: 8 }, 1, limit).width > limit,
      'the expanded list has its own width');
  }
});

test('Notch option availability follows the current shape without repeated notifications', (t) => {
  const updates = [];
  const f = fixture(t, { notchRunningIndicatorEnabled: true }, { onCapabilitiesChanged: value => updates.push(value) });
  assert.deepEqual(f.controller.getCapabilities(), { rings: false });
  f.controller.sync();
  f.controller.poll(Date.now() + 1000);
  assert.equal(updates.length, 1, 'unchanged geometry does not repeat the settings notification');
  f.preferences.notchShape = 'pill';
  f.controller.sync();
  assert.deepEqual(f.controller.getCapabilities(), { rings: true });
  assert.equal(updates.length, 2);
  assert.equal(f.preferences.notchRunningIndicatorEnabled, true);
});

test('the Notch shell keeps clicks from activating the app, including rebuilt windows', (t) => {
  const installed = [];
  const f = fixture(t, {}, { installNonActivatingInput: (win) => installed.push(win) });
  assert.deepEqual(installed, f.windows);
  assert.equal(installed.length, 1);
  f.preferences.notchEnabled = false; f.controller.sync();
  f.preferences.notchEnabled = true; f.controller.sync();
  assert.deepEqual(installed, f.windows);
  assert.equal(installed.filter((win) => !win.destroyed).length, 1);
});

test('progressive blur fades in under the open panel once its mask lands and tears down with the setting or lock', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  let accept = false;
  const masks = [];
  const f = fixture(t, {}, { blurAvailable: () => true, applyBlurMask: (_win, mask) => { masks.push(mask); return accept; } });
  // The blur window is the only one that never loads a renderer.
  const blur = () => f.windows.find((win) => !win.query && !win.destroyed);
  assert.equal(blur(), undefined, 'nothing is created while the entry rests');
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(Date.now());
  assert.equal(last(f.windows[0]).expanded, true);
  const win = blur();
  assert.equal(win.shown, true); assert.equal(win.ignoreMouse, true);
  assert.equal(win.opacity, 0, 'an unmasked material would be a tinted rectangle');
  assert.equal(f.windows[0].above, win.getMediaSourceId(), 'the entry stays above its blur');
  accept = true; t.mock.timers.tick(16);
  assert.equal(win.opacity, 1, 'a panel that opened in one step still retries its mask');
  const mask = masks.at(-1);
  assert.deepEqual([mask.panel.y, mask.panel.width, mask.radius], [0, Math.round(last(f.windows[0]).motion.bodyBox.width - 2 * NOTCH_METRICS.openFlare), NOTCH_METRICS.openRadius], 'the blur follows the panel body, not its flares');
  assert.ok(mask.panel.x > 0 && mask.width > mask.panel.width && mask.height > mask.panel.height);
  f.screen.point = { x: 20, y: 500 }; f.controller.poll(Date.now()); t.mock.timers.tick(100); f.controller.poll(Date.now());
  assert.equal(last(f.windows[0]).expanded, false);
  assert.equal(win.opacity, 0); assert.equal(win.shown, false);
  f.preferences.notchProgressiveBlur = false; f.controller.sync();
  assert.equal(win.destroyed, true, 'turning the setting off releases the window');
  f.preferences.notchProgressiveBlur = true; f.controller.sync();
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(Date.now());
  assert.ok(blur());
  f.controller.setLocked(true);
  assert.equal(blur(), undefined, 'locking releases the window');
});

test('progressive blur gives up quietly when its mask never lands or the system asks for less transparency', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  const logs = [];
  const f = fixture(t, {}, { blurAvailable: () => true, applyBlurMask: () => false, logger: (line) => logs.push(line) });
  const blur = () => f.windows.find((win) => !win.query && !win.destroyed);
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(Date.now());
  for (let i = 0; i < 40; i++) t.mock.timers.tick(16);
  assert.equal(blur(), undefined);
  assert.ok(logs.some((line) => line.includes('progressive blur unavailable')));
  assert.equal(last(f.windows[0]).expanded, true, 'the panel itself is unaffected');
  const reduced = fixture(t, {}, { blurAvailable: () => false, applyBlurMask: () => true });
  reduced.screen.point = { x: 735, y: 10 }; reduced.controller.poll(Date.now());
  assert.equal(reduced.windows.find((win) => !win.query), undefined);
});

test('the canvas reserves the shadow and spring overshoot, and a half-point camera centre stays exact', () => {
  const halfPoint = { ...native, left: { origin: { x: 0, y: 924 }, size: { width: 645.5, height: 32 } },
    right: { origin: { x: 824.5, y: 924 }, size: { width: 645.5, height: 32 } } };
  const geometry = notchGeometry(display, halfPoint);
  assert.equal(geometry.centerX, 735);
  const closed = notchBounds(display, geometry, false, 180, null);
  const open = notchBounds(display, geometry, true, 800, null);
  assert.equal(closed.x, 645.5 - NOTCH_METRICS.restingFlare, 'the resting shell hugs the hardware gap');
  assert.equal(open.x + open.width / 2, 735, 'an odd width starts on a half point instead of rounding off centre');
  const canvas = notchCanvasBounds(open, closed);
  for (const value of Object.values(canvas)) assert.ok(Number.isInteger(value), 'only the native canvas is integral');
  const reach = NOTCH_METRICS.shadowBlur * 3;
  assert.ok(open.x - canvas.x >= reach && canvas.x + canvas.width - open.x - open.width >= reach);
  assert.ok(canvas.y + canvas.height - open.y - open.height >= reach + NOTCH_METRICS.shadowDrop);
  const css = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/notch.css'), 'utf8');
  assert.match(css, new RegExp(`drop-shadow\\(0 calc\\(${NOTCH_METRICS.shadowDrop}px.*?\\) calc\\(${NOTCH_METRICS.shadowBlur}px`), 'the stylesheet draws the shadow the canvas reserves');
});

test('notch springs settle on target, overshoot only when opening and carry velocity', () => {
  for (const [name, spec] of Object.entries(NOTCH_SPRINGS)) {
    const end = springState(springDuration(spec) / 1000, spec);
    assert.ok(Math.abs(end.value - 1) < 0.01, `${name} settles within its duration`);
  }
  const peak = (spec) => Math.max(...Array.from({ length: 200 }, (_, i) => springState(i / 200, spec).value));
  assert.ok(peak(NOTCH_SPRINGS.open) > 1 && peak(NOTCH_SPRINGS.open) < 1.1, 'opening overshoots slightly');
  assert.ok(peak(NOTCH_SPRINGS.close) <= 1 + 1e-9, 'closing never overshoots');
  assert.ok(springState(0.02, NOTCH_SPRINGS.open, 5).value > springState(0.02, NOTCH_SPRINGS.open, 0).value, 'an interrupted motion keeps its speed');
});

test('Notch hover, haptic and blur settings default and normalize in both settings paths', () => {
  const start = mainSource.indexOf('    notchEnabled:', mainSource.indexOf('function defaultSettings('));
  const defaults = vm.runInNewContext(`({${mainSource.slice(start, mainSource.indexOf('    edgeDockEnabled:', start))}})`, { createDefaultTrayLayout: trayLayout.createDefaultTrayLayout });
  assert.deepEqual([defaults.notchHoverAction, defaults.notchHoverDelay, defaults.notchHaptic, defaults.notchProgressiveBlur, defaults.notchSwipeGestures], ['peek', 0, true, true, true]);
  assert.equal('notchExpandOnApproach' in defaults, false);
  const loadedStart = mainSource.indexOf('    merged.notchHoverAction =');
  const loadedSource = mainSource.slice(loadedStart, mainSource.indexOf('    merged.notchSummaryMode =', loadedStart));
  const patchStart = mainSource.indexOf('      notchHoverAction: normalizeNotchHoverAction(');
  const patchSource = mainSource.slice(patchStart, mainSource.indexOf('      notchSummaryMode:', patchStart));
  const helpers = { parseBoolean, normalizeNotchHoverAction, normalizeNotchHoverDelay };
  for (const [input, expected] of [
    [{}, ['peek', 0, true, true, true]],
    [{ notchHoverAction: 'open', notchHoverDelay: 340, notchHaptic: false, notchProgressiveBlur: false, notchSwipeGestures: false }, ['open', 300, false, false, false]],
    [{ notchHoverAction: 'hover', notchHoverDelay: 5000, notchHaptic: 'maybe', notchProgressiveBlur: 'maybe' }, ['peek', 0, true, true, true]]
  ]) {
    const merged = { ...input };
    const context = { merged, patch: { ...input }, settings: defaults, ...helpers };
    vm.runInNewContext(loadedSource, context);
    const patched = vm.runInNewContext(`({${patchSource}})`, context);
    for (const result of [merged, patched]) {
      assert.deepEqual([result.notchHoverAction, result.notchHoverDelay, result.notchHaptic, result.notchProgressiveBlur, result.notchSwipeGestures], expected);
    }
  }
});

test('the swipe switch stays visible and follows its saved value in both hover modes', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const source = app.slice(app.indexOf('function syncNotchHoverControls()'), app.indexOf('function syncNotchSummaryMode()'));
  const row = { hidden: false, classList: { toggle(_name, value) { row.hidden = value; } } };
  const input = { closest: () => row };
  const state = { appInfo: { platform: 'darwin' }, settings: { notchEnabled: true } };
  const context = vm.createContext({
    state, els: { edgeDockInput: {}, notchShapeInputs: [], notchHoverActionInputs: [], notchSwipeGesturesInput: input },
    NOTCH_HOVER_DELAY_DEFAULT_MS: 0, edgeDockAvailable: () => false,
    syncDockSizeControls() {}, syncNotchSummaryMode() {}, notchItemsComposer: null
  });
  for (const mode of ['peek', 'open']) {
    for (const enabled of [true, false]) {
      Object.assign(state.settings, { notchHoverAction: mode, notchSwipeGestures: enabled });
      vm.runInContext(`${source}; syncDockControls()`, context);
      assert.equal(row.hidden, false, `${mode} keeps the gesture switch available`);
      assert.equal(input.checked, enabled);
    }
  }
});

test('the hover duration reset restores the instant default', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const constant = app.slice(app.indexOf('const NOTCH_HOVER_DELAY_DEFAULT_MS'), app.indexOf(';', app.indexOf('const NOTCH_HOVER_DELAY_DEFAULT_MS')) + 1);
  const start = app.indexOf('els.resetNotchHoverDelayButton?.addEventListener(');
  const source = app.slice(start, app.indexOf('\n});', start) + 4);
  let click;
  const patches = [];
  const input = { value: '400' };
  vm.runInNewContext(`${constant.replace('const ', 'var ')}\n${source}`, {
    els: { notchHoverDelayInput: input, resetNotchHoverDelayButton: { addEventListener: (_event, callback) => { click = callback; } } },
    saveSettings: (patch) => patches.push({ ...patch }), syncNotchHoverDelayValue() {}
  });
  click();
  assert.equal(input.value, '0');
  assert.deepEqual(patches, [{ notchHoverDelay: 0 }]);
});

test('a pending blur retry repaints the current layout, not the one it was scheduled for', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  let accept = false;
  const f = fixture(t, {}, { blurAvailable: () => true, applyBlurMask: () => accept });
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(Date.now());
  const win = f.windows.find((w) => !w.query && !w.destroyed);
  const first = { ...win.getBounds() };
  // The first mask misses and a retry is queued; a shorter list then lands a mask.
  accept = true;
  f.ipcMain.emit('topNotch:size', { sender: f.windows[0].webContents }, { height: 40 });
  const resized = { ...win.getBounds() };
  assert.ok(resized.height < first.height);
  t.mock.timers.tick(16); t.mock.timers.tick(1600);
  assert.deepEqual(win.getBounds(), resized, 'the queued retry cannot restore the stale bounds');
  assert.equal(win.opacity, 1);
});

test('a blur given up on stays off across settings saves until it is switched off and on', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  let calls = 0;
  const f = fixture(t, {}, { blurAvailable: () => true, applyBlurMask: () => { calls++; return false; }, logger: () => {} });
  const blur = () => f.windows.find((w) => !w.query && !w.destroyed);
  const reopen = () => {
    f.screen.point = { x: 20, y: 500 }; f.controller.poll(Date.now()); t.mock.timers.tick(100); f.controller.poll(Date.now());
    f.screen.point = { x: 735, y: 10 }; f.controller.poll(Date.now());
    for (let i = 0; i < 40; i++) t.mock.timers.tick(16);
  };
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(Date.now());
  for (let i = 0; i < 40; i++) t.mock.timers.tick(16);
  assert.equal(calls, 31); assert.equal(blur(), undefined);
  f.controller.sync(); reopen();
  assert.equal(calls, 31, 'an ordinary settings save does not start another round');
  f.preferences.notchProgressiveBlur = false; f.controller.sync();
  f.preferences.notchProgressiveBlur = true; f.controller.sync(); reopen();
  assert.ok(calls > 31, 'switching the blur off and on tries again');
});

test('a pointer on a display above the notch keeps the idle poll cadence', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  const f = fixture(t);
  const reads = [];
  f.screen.getCursorScreenPoint = () => { reads.push(Date.now()); return f.screen.point; };
  // Directly above the notch, on a screen arranged over the built-in one.
  f.screen.point = { x: 735, y: -500 };
  t.mock.timers.tick(90); assert.deepEqual(reads, [10090]);
  t.mock.timers.tick(89); assert.equal(reads.length, 1, 'no display-rate polling off this display');
  t.mock.timers.tick(1); assert.deepEqual(reads, [10090, 10180]);
});

test('in full screen the default Grow mode grows from the approach band and opens on click', (t) => {
  const f = fixture(t, { notchHoverAction: 'peek' }, { isFullScreen: () => true });
  const top = f.windows[0];
  const shape = () => {
    const message = top.messages.filter((m) => m.channel === 'topNotch:motion' || m.payload?.motion?.shape).at(-1);
    return (message.channel === 'topNotch:motion' ? message.payload : message.payload.motion).shape.d;
  };
  f.controller.poll(1000);
  const geometry = last(top).geometry, resting = shape();
  f.screen.point = { x: geometry.centerX, y: geometry.y + geometry.height + 1 };
  f.controller.poll(2000); f.controller.poll(7000);
  assert.notEqual(shape(), resting, 'approaching grows the entry');
  assert.equal(last(top).expanded, false, 'Grow mode never opens on approach alone');
  press(f);
  assert.equal(last(top).expanded, true, 'a press on the grown entry opens it');
});

test('the resting window takes input only while the pointer is on the visible entry', (t) => {
  let held = false;
  const f = fixture(t, { notchHoverAction: 'peek' }, { primaryButtonDown: () => held });
  const top = f.windows[0];
  assert.equal(top.ignoreMouse, true, 'the resting canvas passes the pointer through');
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(1000);
  assert.equal(top.ignoreMouse, false, 'the entry takes presses and wheel events itself');
  f.screen.point = { x: 735, y: 120 }; f.controller.poll(1100);
  assert.equal(top.ignoreMouse, true, 'transparent canvas below the entry stays click-through');
  held = true; f.screen.point = { x: 735, y: 10 }; f.controller.poll(1200);
  assert.equal(top.ignoreMouse, true, 'a drag arriving held from elsewhere is not taken');
  held = false; f.controller.poll(1300);
  assert.equal(top.ignoreMouse, false);
  held = true; f.controller.poll(1400);
  assert.equal(top.ignoreMouse, false, 'a press that started on the entry keeps its input');
  held = false; press(f);
  assert.equal(last(top).expanded, true);
  f.screen.point = { x: 735, y: 150 }; f.controller.poll(1500);
  assert.equal(top.ignoreMouse, false, 'the open panel takes input across its whole outline');
});

test('a held drag stays click-through when motion or data would refresh input', (t) => {
  let held = true;
  const f = fixture(t, { notchHoverAction: 'peek' }, { reducedMotion: false, primaryButtonDown: () => held });
  const top = f.windows[0];
  const animation = () => top.messages.filter(m => m.channel === 'topNotch:animate').at(-1).payload;
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(1000);
  assert.equal(top.ignoreMouse, true);
  f.ipcMain.emit('topNotch:frame', { sender: top.webContents }, { id: animation().id, elapsed: animation().duration });
  assert.equal(top.ignoreMouse, true, 'finishing the hover motion does not take a held drag');
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  assert.equal(top.ignoreMouse, true, 'a data push does not take a held drag');
  held = false; f.controller.poll(1100);
  assert.equal(top.ignoreMouse, false, 'releasing the button over the entry takes input');
});

test('forwarded pointer moves reach the entry before the next cursor poll', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  const f = fixture(t, { notchHoverAction: 'peek' });
  const top = f.windows[0];
  f.screen.point = { x: 735, y: 10 };
  assert.equal(top.ignoreMouse, true);
  f.ipcMain.emit('topNotch:pointer', { sender: top.webContents });
  assert.equal(top.ignoreMouse, false, 'the report takes the pointer at once');
  f.screen.point = { x: 20, y: 400 };
  f.ipcMain.emit('topNotch:pointer', { sender: { send() {} } });
  assert.equal(top.ignoreMouse, false, 'other senders cannot move the pointer state');
});

test('presses open only on the entry, never on the transparent canvas', (t) => {
  const f = fixture(t, { notchHoverAction: 'peek' });
  const top = f.windows[0];
  f.screen.point = { x: 20, y: 400 }; press(f);
  assert.equal(last(top).expanded, false, 'a press elsewhere on the canvas does not open');
  f.screen.point = { x: 735, y: 10 };
  f.ipcMain.emit('topNotch:press', { sender: { send() {} } });
  assert.equal(last(top).expanded, false, 'only the notch page reports presses');
  press(f);
  assert.equal(last(top).expanded, true);
});

test('lock and disable release input and ignore late presses', (t) => {
  const f = fixture(t, { notchHoverAction: 'peek' });
  const top = f.windows[0];
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(1000);
  assert.equal(top.ignoreMouse, false);
  f.controller.setLocked(true);
  assert.equal(top.ignoreMouse, true, 'a locked screen never leaves the entry taking input');
  press(f);
  assert.equal(last(top).expanded, false);
  f.controller.setLocked(false); f.controller.poll(2000);
  press(f);
  assert.equal(last(top).expanded, true);
  f.preferences.notchEnabled = false; f.controller.sync();
  assert.doesNotThrow(() => f.ipcMain.emit('topNotch:press', { sender: top.webContents }));
});

test('a failed remask hides visible blur and restores it after a successful retry', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  let accept = true, failed = 0;
  const f = fixture(t, {}, { blurAvailable: () => true, applyBlurMask: () => { if (!accept) failed++; return accept; } });
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(Date.now());
  const win = f.windows.find(w => !w.query && !w.destroyed), first = { ...win.getBounds() };
  assert.equal(win.opacity, 1);
  accept = false;
  f.ipcMain.emit('topNotch:size', { sender: f.windows[0].webContents }, { height: 40 });
  assert.notDeepEqual(win.getBounds(), first);
  assert.ok(failed > 0);
  assert.equal(win.opacity, 0, 'a resized window cannot expose the old mask');
  const failures = failed;
  f.ipcMain.emit('topNotch:size', { sender: f.windows[0].webContents }, { height: 180 });
  assert.ok(failed > failures, 'returning to the old layout still needs a remask after failed resize');
  assert.deepEqual(win.getBounds(), first);
  assert.equal(win.opacity, 0);
  accept = true; t.mock.timers.tick(16);
  assert.equal(win.opacity, 1, 'the opacity cache must restore a previously fully visible blur');
});

test('a held drag cannot wake the full-screen approach band', (t) => {
  let held = true;
  const f = fixture(t, { notchHoverAction: 'peek' }, { isFullScreen: () => true, primaryButtonDown: () => held });
  const top = f.windows[0], geometry = last(top).geometry;
  const animations = () => top.messages.filter(m => m.channel === 'topNotch:animate').length;
  f.screen.point = { x: geometry.centerX, y: geometry.y + geometry.height + 1 };
  const before = animations();
  f.controller.poll(1000);
  assert.equal(animations(), before, 'a known drag does not grow the entry');
  assert.equal(top.ignoreMouse, true);
  held = false; f.controller.poll(2000);
  assert.ok(animations() > before);
});

test('main reads natural scrolling from the global default, on when unset', () => {
  for (const [stored, natural] of [['', true], ['1', true], ['0', false]]) {
    const options = wiredNotchOptions({ systemPreferences: { getUserDefault: (key, type) => {
      assert.deepEqual([key, type], ['com.apple.swipescrolldirection', 'string']);
      return stored;
    } } });
    assert.equal(options.naturalScrolling(), natural);
  }
});

function scrollFixture(t, settings = {}, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  // Swipe gestures are on by default.
  const f = fixture(t, { notchHoverAction: 'peek', ...settings }, options);
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  f.screen.point = { x: 735, y: 10 }; f.controller.poll(Date.now());
  // Each call is its own gesture unless `same` keeps it inside the pause.
  // `down` is hand travel; under natural scrolling the page delta is its negative.
  const scroll = (down, extra = {}, { same = false } = {}) => {
    if (!same) t.mock.timers.tick(SCROLL_GESTURE_GAP_MS + 1);
    wheel(f, -down, extra.deltaX);
  };
  return { ...f, top: f.windows[0], scroll };
}
test('scroll gestures step between the hidden summary, the summary and the open panel', (t) => {
  const f = scrollFixture(t);
  assert.ok(last(f.top).summary);
  f.scroll(30);
  assert.equal(last(f.top).expanded, true, 'scrolling down on the entry opens the panel');
  f.scroll(-30);
  assert.equal(last(f.top).expanded, false, 'scrolling up on the open band closes it');
  assert.ok(last(f.top).summary, 'closing keeps the summary');
  f.scroll(-30);
  assert.equal(last(f.top).summary, null, 'scrolling up again hides the summary');
  f.scroll(-30);
  assert.equal(last(f.top).summary, null);
  assert.equal(last(f.top).expanded, false);
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  assert.equal(last(f.top).summary, null, 'new data cannot bring a dismissed summary back');
  f.scroll(30);
  assert.ok(last(f.top).summary, 'scrolling down restores the summary before opening');
  assert.equal(last(f.top).expanded, false);
  f.scroll(30);
  assert.equal(last(f.top).expanded, true);
});

test('opening the panel any way clears a dismissed summary', (t) => {
  const f = scrollFixture(t);
  f.scroll(-30);
  assert.equal(last(f.top).summary, null);
  press(f);
  assert.equal(last(f.top).expanded, true);
  f.scroll(-30);
  assert.equal(last(f.top).expanded, false);
  assert.ok(last(f.top).summary, 'the summary returns once the panel closes');
});

test('one scroll gesture acts once and ignores trailing motion and sideways swipes', (t) => {
  const f = scrollFixture(t);
  f.scroll(10); f.scroll(10, {}, { same: true });
  assert.equal(last(f.top).expanded, false, 'travel below the threshold does nothing');
  f.scroll(10, {}, { same: true });
  assert.equal(last(f.top).expanded, true, 'small trackpad deltas accumulate');
  for (const delta of [-2, 3, -1]) f.scroll(delta, {}, { same: true });
  assert.equal(last(f.top).expanded, true, 'jitter below the reversal size is not a new swipe');
  f.scroll(-40, { deltaX: 80 });
  assert.equal(last(f.top).expanded, true, 'horizontal swipes belong to the limits strip');
  for (const payload of [null, { deltaX: 0, deltaY: NaN }]) f.ipcMain.emit('topNotch:wheel', { sender: f.top.webContents }, payload);
  t.mock.timers.tick(SCROLL_GESTURE_GAP_MS + 1);
  f.ipcMain.emit('topNotch:wheel', { sender: { send() {} } }, { deltaX: 0, deltaY: 80 });
  assert.equal(last(f.top).expanded, true, 'only the notch page reports wheel events');
});

test('back-to-back swipes act without a pause while momentum never acts twice', (t) => {
  const f = scrollFixture(t);
  const swipe = (sign, deltas) => { for (const delta of deltas) f.scroll(sign * delta, {}, { same: true }); };
  const momentum = sign => swipe(sign, [30, 24, 19, 15, 12, 9, 7, 5, 4, 3, 2]);
  f.scroll(30); momentum(1);
  assert.equal(last(f.top).expanded, true);
  swipe(1, [6, 12, 20]);
  assert.equal(last(f.top).expanded, true, 'a second pull while open changes nothing');
  swipe(-1, [5, 10, 14]);
  assert.equal(last(f.top).expanded, false, 'a reversal inside the stream is a new swipe');
  momentum(-1);
  assert.ok(last(f.top).summary, 'decaying momentum alone never acts again');
  swipe(-1, [4, 9, 14, 18]);
  assert.equal(last(f.top).summary, null, 'a rise after the decay is the next swipe up');

  f.scroll(30); swipe(1, [40, 60, 90, 120]);
  assert.ok(last(f.top).summary, 'restored once');
  assert.equal(last(f.top).expanded, false, 'one accelerating swipe never acts twice');
  swipe(1, [100, 50, 40, 80]);
  assert.equal(last(f.top).expanded, false, 'a coalesced spike in decaying momentum is not a new swipe');
});

test('scroll gestures act only on the entry or the open band', (t) => {
  const f = scrollFixture(t);
  f.screen.point = { x: 20, y: 10 };
  f.scroll(40);
  assert.equal(last(f.top).expanded, false, 'wheel events off the entry are ignored');
  f.screen.point = { x: 735, y: 10 };
  f.scroll(40);
  assert.equal(last(f.top).expanded, true);
  const geometry = last(f.top).geometry;
  f.screen.point = { x: 735, y: geometry.y + 60 };
  f.scroll(-40);
  assert.equal(last(f.top).expanded, true, 'lists below the band keep their own scrolling');
  f.screen.point = { x: 735, y: 10 };
  f.scroll(-40);
  assert.equal(last(f.top).expanded, false);
});

test('swipes close only on the rendered top row, at any size and shape', async (t) => {
  // The renderer draws an attached row as the camera band and a capsule's as
  // 34 CSS pixels at its zoom; a swipe just below must reach the page instead.
  for (const [settings, below] of [
    [{ notchSize: 'custom', notchCustomScale: 1.5 }, 42],
    [{ notchSize: 'custom', notchCustomScale: 0.75, notchShape: 'pill' }, 38 + 29]
  ]) await t.test(JSON.stringify(settings), (t) => {
    const f = scrollFixture(t, settings);
    const geometry = last(f.top).geometry;
    f.screen.point = { x: geometry.centerX, y: geometry.y + 4 };
    f.controller.poll(Date.now()); press(f);
    assert.equal(last(f.top).expanded, true);
    f.screen.point = { x: geometry.centerX, y: below };
    f.scroll(-40);
    assert.equal(last(f.top).expanded, true, `content below the row keeps its scrolling (${JSON.stringify(settings)})`);
    f.screen.point = { x: geometry.centerX, y: geometry.y + 4 };
    f.scroll(-40);
    assert.equal(last(f.top).expanded, false);
  });
});

test('scroll direction follows the hand when natural scrolling is off', (t) => {
  const f = scrollFixture(t, {}, { naturalScrolling: () => false });
  f.scroll(-40);
  assert.equal(last(f.top).expanded, true, 'a positive page delta is a pull down without natural scrolling');
});

test('swipe gestures follow their switch and click-to-open mode', (t) => {
  const f = scrollFixture(t, { notchSwipeGestures: false });
  f.scroll(40);
  assert.equal(last(f.top).expanded, false, 'switched off');
  f.scroll(-40);
  assert.ok(last(f.top).summary);
  f.preferences.notchSwipeGestures = true;
  f.preferences.notchHoverAction = 'open'; f.preferences.notchHoverDelay = 600;
  f.scroll(40);
  assert.equal(last(f.top).expanded, false, 'hover-to-open mode would reopen what a swipe closed');
  f.preferences.notchHoverAction = 'peek';
  f.scroll(40);
  assert.equal(last(f.top).expanded, true);
});

test('turning swipes off brings a hidden summary back', (t) => {
  const f = scrollFixture(t);
  f.scroll(-40);
  assert.equal(last(f.top).summary, null);
  f.preferences.notchSwipeGestures = false; f.controller.sync();
  assert.ok(last(f.top).summary);
  f.preferences.notchSwipeGestures = true; f.scroll(-40);
  assert.equal(last(f.top).summary, null);
  f.preferences.notchHoverAction = 'open'; f.controller.sync();
  assert.ok(last(f.top).summary, 'leaving click-to-open restores it too');
});

test('attached glass stays dark with a light widget while capsules retain their appearance', (t) => {
  const updates = new Map();
  const f = fixture(t, { notchStyle: 'inherit', macBackdrop: 'liquid-glass-clear', macClearGlassTint: 64 }, {
    nativeGlass: () => true, liquidGlass: () => ({ dark: false }),
    createGlass: win => ({ update: options => updates.set(win, options), dispose() {} })
  });
  assert.equal(updates.get(f.windows[0]).dark, true);
  assert.equal(updates.get(f.windows[0]).tintOpacity, 0, 'the camera fade is the attached surface tint');
  f.preferences.notchShape = 'pill'; f.controller.sync();
  assert.equal(updates.get(f.windows[0]).dark, false, 'detaching restores the widget appearance');
  assert.equal(updates.get(f.windows[0]).tintOpacity, 0.64, 'camera-free capsules retain the configured tint');
  f.preferences.notchShape = 'auto'; f.controller.sync();
  assert.equal(updates.get(f.windows[0]).tintOpacity, 0, 'reattaching removes the duplicate native tint');
  assert.equal(f.preferences.macClearGlassTint, 64, 'the saved preference is never rewritten');
});


test('horizontal input belongs to the live open window and follows its lifecycle', t => {
  const bindings = [];
  let removed = 0, cancelled = 0;
  const f = fixture(t, {}, {
    installNonActivatingInput(win) { win.getNativeWindowHandle = () => { const b = Buffer.alloc(8); b.writeBigUInt64LE(123n); return b; }; },
    monitorScrollGesture(onEvent, options) {
      bindings.push({ onEvent, options });
      return { dispose() { removed++; }, cancel() { cancelled++; } };
    }
  });
  const win = notchWindow(f), binding = bindings[0];
  assert.equal(binding.options.view, 123n);
  assert.equal(binding.options.shouldTrack(), false);
  f.screen.point = { x: 735, y: 10 };
  f.controller.poll(Date.now());
  assert.equal(binding.options.shouldTrack(), true);
  binding.onEvent({ id: 1, phase: 'began', amount: 0.1, complete: false, x: 735, y: 10 });
  const sent = win.messages.filter(message => message.channel === 'topNotch:scroll');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.x, 735 - win.getBounds().x);
  f.preferences.notchSwipeGestures = false;
  assert.equal(binding.options.shouldTrack(), false);
  f.preferences.notchSwipeGestures = true;
  f.ipcMain.emit('topNotch:dismiss', { sender: win.webContents });
  assert.equal(cancelled, 1);
  f.controller.setLocked(true);
  assert.equal(removed, 1);
  f.controller.setLocked(false);
  assert.equal(bindings.length, 2);
  const prior = win.messages.length;
  binding.onEvent({ id: 1, phase: 'none', amount: 1, complete: true, x: 735, y: 10 });
  assert.equal(win.messages.length, prior);
  f.preferences.notchEnabled = false; f.controller.sync();
  assert.equal(removed, 2);
});
