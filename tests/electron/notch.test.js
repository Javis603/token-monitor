'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createNotchController } = require('../../src/electron/notch/controller');
const { notchGeometry, notchMaxHeight, notchBounds, notchSummaryMaxWidth, notchCommands, translateCommands, interpolateCommands } = require('../../src/electron/notch/geometry');
const { buildNotchData, summaryLayout } = require('../../src/electron/notch/data');
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
  const preferences = { notchEnabled: true, edgeDockEnabled: false, ...settings };
  const deps = { BrowserWindow: RecordingWindow, ipcMain, screen, rendererDir: '/renderer', preloadPath: '/preload', getSettings: () => preferences, nativeGlass: options.nativeGlass || (() => false), liquidGlass: options.liquidGlass, createGlass: options.createGlass, prefersReducedMotion: () => options.reducedMotion !== false, platform: options.platform || 'darwin' };
  const controller = createNotchController({ ...deps, readScreens: options.readScreens || (() => ({ screens: [native], mainDisplayId: 1 })), onSwitchCodexAccount: (id) => ({ ok: true, id }), onToggleRateMode: options.onToggleRateMode, onCapabilitiesChanged: options.onCapabilitiesChanged, readMenuWindows: options.readMenuWindows || (() => null), primaryButtonDown: options.primaryButtonDown || (() => false), isFullScreen: options.isFullScreen || (() => false), logger: options.logger, performHaptic: options.performHaptic, canRefreshLimits: options.canRefreshLimits, onRefreshLimits: options.onRefreshLimits });
  t.after(() => controller.dispose());
  const setData = controller.setData;
  controller.setData = (value) => {
    setData(value);
    // Most controller cases model a renderer that completes initial sizing.
    // Startup-specific cases opt out and exercise the handshake explicitly.
    if (options.measureSummary === false) return;
    const win = windows.at(-2), measurement = last(win)?.summaryMeasurement;
    if (!measurement?.measuring) return;
    ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots: { left: 17, right: 42, minimumLeft: 17, minimumRight: 42 }, summaryMeasurement: { id: measurement.id } });
    ipcMain.emit('topNotch:size', { sender: win.webContents }, { summaryMeasurement: { id: last(win)?.summaryMeasurement?.id, ready: true } });
  };
  controller.sync();
  for (const win of windows) ipcMain.emit('topNotch:ready', { sender: win.webContents });
  return { controller, windows, deps, ipcMain, screen, preferences };
}
function last(win) { return win.messages.filter((message) => message.channel === 'topNotch:render').at(-1)?.payload; }
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
    assert.equal(measured.motion.summaryEdges.left + win.bounds.x, expected.x + (notched ? 4 : 0) + 8);
    assert.equal(measured.motion.summaryEdges.right + win.bounds.x, expected.x + expected.width - (notched ? 4 : 0) - 8);
    assert.equal(win.messages.filter(m => m.channel === 'topNotch:animate').at(-1).payload.duration, 0);
    f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { summaryMeasurement: { id: request.id, ready: true } });
    assert.equal(last(win).summaryMeasurement, null);
    f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { slots: { ...slots, right: 90, minimumRight: 90 } });
    if (notched) assert.equal(win.messages.filter(m => m.channel === 'topNotch:animate').at(-1).payload.duration, 360, 'later width changes retain motion');
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

test('new notch configurations use black and preserve saved style selections', (t) => {
  for (const style of [undefined, 'black', 'vibrancy', 'liquid-glass', 'inherit']) {
    const f = fixture(t, style === undefined ? {} : { notchStyle: style });
    assert.equal(last(f.windows[0]).style, style || 'black');
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
  for (const win of f.windows.slice(-2)) f.ipcMain.emit('topNotch:ready', { sender: win.webContents });
  assert.equal(last(f.windows.at(-2)).liquidGlass, true);
  available = false; f.controller.sync();
  assert.equal(f.windows.at(-2).options.vibrancy, 'hud');
  available = true;
  f.preferences.notchStyle = 'vibrancy'; f.controller.sync();
  assert.equal(f.windows.at(-2).options.vibrancy, 'hud');
  f.preferences.notchStyle = 'inherit'; enabled = false; f.controller.sync();
  assert.equal(f.windows.at(-2).options.vibrancy, undefined);
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

test('shoulder uses the EdgeDock curve within the physical notch height at every list size and zoom', () => {
  const { railCommands } = require('../../src/electron/renderer/edgeDock/shapes');
  for (const zoom of [0.8, 1, 1.5]) {
    const short = notchCommands(336 * zoom, 220, true, true, 32, zoom);
    const tall = notchCommands(336 * zoom, 800, true, true, 32, zoom);
    assert.deepEqual(short[1], tall[1]);
    assert.ok(tall[1][6] <= 32, 'shoulder must end before the provider content starts');
    const cap = Math.min(64 * zoom, 32 / 0.53);
    const rail = railCommands({ width: cap, height: 336 * zoom, shoulder: 28 * zoom, radius: 20 * zoom });
    const curve = rail[1];
    assert.deepEqual(short[1], ['C', curve[2], cap - curve[1], curve[4], cap - curve[3], curve[6], cap - curve[5]]);
  }
});

test('equal ears reserve the wider content and preserve the physical notch center', () => {
  const geometry = notchGeometry(display, native);
  const closed = notchBounds(display, geometry, false, 180, { left: 17, right: 36 });
  assert.equal(closed.width, 291);
  assert.equal(closed.x + 56, 646);
  assert.equal(closed.x + closed.width - 56, 825);
  assert.equal(notchBounds(display, geometry, false, 180, null).width, 179);
  const open = notchBounds(display, geometry, true, 800, { left: 17, right: 36 }, 1.5);
  assert.ok(Math.abs(open.x + open.width / 2 - geometry.centerX) <= 0.5, 'expanded shell remains centered on the physical notch');
  assert.equal(open.width, 505, 'provider card and shoulder follow the app zoom');
  assert.equal(open.height, 353, 'main cap follows usable logical height, independent of text zoom');
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
  const settings = { notchFollowTray: false, notchCustomLayout: { version: trayLayout.VERSION, items: [icon, percent] } };
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
  const { controller, screen, windows } = fixture(t);
  const primary = windows[0], bubble = windows[1];
  const canvas = primary.getBounds();
  const head = last(primary).geometry;
  screen.point = { x: canvas.x + head.headerX + 20, y: canvas.y + 10 };
  controller.poll(100); controller.poll(239);
  assert.equal(last(primary).expanded, false);
  controller.poll(240);
  assert.equal(last(primary).expanded, true);
  assert.equal(primary.opacity, 1);
  assert.deepEqual(primary.getBounds(), canvas);
  assert.equal(primary.ignoreMouse, false);
  assert.equal(bubble.opacity, 0);
  assert.equal(primary.messages.filter((m) => m.channel === 'topNotch:motion').at(-1).payload.progress, 1);
  screen.point = { x: 10, y: 900 };
  controller.poll(300); controller.poll(619);
  assert.equal(last(primary).expanded, true);
  controller.poll(620);
  assert.equal(last(primary).expanded, false);
  assert.equal(primary.opacity, 1, 'closing never fades the summary');
  assert.deepEqual(primary.getBounds(), canvas);
  controller.setLocked(true);
  assert.equal(primary.opacity, 0); assert.equal(bubble.ignoreMouse, true);
  controller.setLocked(false); assert.equal(primary.opacity, 1);
});

test('provider hover uses the original EdgeDock bubble without altering primary height', (t) => {
  const { controller, screen, windows, ipcMain } = fixture(t);
  const primary = windows[0], bubble = windows[1];
  const cell = { id: 'codex', provider: 'codex', accounts: [], usage: { today: { tokens: 10 }, month: { tokens: 20 } } };
  controller.setData({ sessions: [], summary: null, cells: [cell] });
  ipcMain.emit('topNotch:size', { sender: primary.webContents }, { height: 100,
    rows: [{ id: 'codex', x: 28, y: 32, width: 280, height: 90 }] });
  const canvas = primary.getBounds(), head = last(primary).geometry;
  screen.point = { x: canvas.x + head.headerX + 20, y: 10 };
  controller.poll(100); controller.poll(240);
  screen.point = { x: canvas.x + 40, y: 50 };
  controller.poll(300); controller.poll(370);
  assert.equal(last(bubble).surface, 'bubble');
  assert.equal(bubble.query.surface, 'bubble', 'exact same renderer, not a new secondary card');
  assert.deepEqual(last(bubble).cell, cell);
  assert.equal(last(bubble).visible, true);
  assert.equal(last(bubble).omitQuotaBars, true, 'secondary retains original details and omits only overview quotas');
  ipcMain.emit('topNotch:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 250 });
  assert.equal(bubble.opacity, 1);
  assert.ok(bubble.getBounds().x > primary.getBounds().x + primary.getBounds().width - 28);
  assert.deepEqual(primary.getBounds(), canvas);
  screen.point = { x: bubble.getBounds().x + 20, y: bubble.getBounds().y + 20 };
  controller.poll(1000);
  assert.equal(last(primary).expanded, true, 'moving into the right window keeps the shell open');
  ipcMain.emit('topNotch:bubbleSize', { sender: primary.webContents }, { cellId: 'codex', height: 800 });
  assert.equal(bubble.getBounds().height, 250, 'wrong sender cannot resize the bubble');
  screen.point = { x: 20, y: 900 };
  controller.poll(1000); controller.poll(1400);
  assert.equal(last(bubble).visible, false);
  assert.equal(last(bubble).cell, null);
  assert.equal(bubble.opacity, 0);
  assert.equal(bubble.isDestroyed(), false, 'hiding retains the loaded renderer');
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
    { notchFollowTray: false, notchCustomLayout: { version: 3, items: [] } },
    { notchFollowTray: true, trayContent: 'custom', trayCustomLayout: { version: 3, items: [] } }
  ]) {
    const data = buildNotchData(input, cells, settings);
    assert.equal(data.summary, null);
    assert.equal(data.cells, cells);
    const f = fixture(t, settings);
    f.controller.setData(data);
    const top = f.windows[0];
    assert.equal(last(top).geometry.headerWidth, 179);
    assert.equal(last(top).geometry.shoulder, 0);
    assert.equal(last(top).summary, null);
    f.screen.point = { x: 735, y: 10 };
    f.controller.poll(100); f.controller.poll(240);
    assert.equal(last(top).expanded, true);
    assert.equal(last(top).cells, cells);
    f.screen.point = { x: 10, y: 500 };
    f.controller.poll(300); f.controller.poll(620);
    assert.equal(last(top).expanded, false);
    assert.equal(last(top).geometry.headerWidth, 179);
  }
  assert.ok(buildNotchData(input, cells, { trayContent: 'tokens', showTrayIcon: false }).summary,
    'hiding the actual tray never hides an independently configured notch summary');
});

test('notch summary switch preserves custom configuration, provider data and tray independence', () => {
  const input = stats();
  const cells = buildEdgeDockCells(input);
  const layout = trayLayout.createDefaultTrayLayout();
  for (const followTray of [true, false]) {
    const settings = { notchFollowTray: followTray, notchCustomLayout: layout, trayContent: 'tokens', showTrayIcon: false };
    const before = JSON.stringify(settings);
    assert.ok(buildNotchData(input, cells, settings).summary, 'older preferences default to showing summary');
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
  const data = buildNotchData(input, [], { notchFollowTray: false, notchCustomLayout: layout, trayContent: 'icon' });
  assert.deepEqual(summaryLayout({ notchFollowTray: false, notchCustomLayout: layout }), trayLayout.normalizeTrayLayout(layout));
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
    assert.deepEqual(interpolateCommands(a, b, 0), a);
    assert.deepEqual(interpolateCommands(a, b, 1), b);
    for (let i = 0; i < a.length; i++) for (let j = 1; j < a[i].length; j++) assert.equal(half[i][j], (a[i][j] + b[i][j]) / 2);
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
  assert.equal(first.duration, 360);
  tick(first.id, 120);
  const middle = frame();
  assert.ok(middle.progress > 0 && middle.progress < 1);
  tick(first.id, 80);
  assert.deepEqual(frame(), middle, 'out-of-order frame cannot rewind the visible shape');
  ipcMain.emit('topNotch:size', { sender: primary.webContents }, { height: 250 });
  const resumed = animation();
  assert.ok(resumed.id > first.id);
  const resized = frame();
  tick(first.id, first.duration);
  assert.deepEqual(frame(), resized, 'old transition cannot finish the resized shell');
  tick(resumed.id, resumed.duration);
  assert.equal(frame().progress, 1);
  assert.equal(primary.opacity, 1);
  assert.equal(primary.getBounds().height, 282);
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


test('quota/detail partition keeps credit quotas without meters and leaves spending and reset notes in details', () => {
  const code = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const source = code.slice(code.indexOf('function notchQuotaRows('), code.indexOf('function omitNotchQuotaRows('));
  const rows = [
    { id: 'normal-session', note: false, meter: true },
    { id: 'credits-amount-without-meter', usageItem: 'credits', note: true, meter: false },
    { id: 'unlimited', usageItem: '["billing","Quota","",false]', note: true, meter: false },
    { id: 'spend-note', usageItem: 'spend', note: true, meter: false },
    { id: 'budget-spend-with-meter', note: true, meter: true },
    { id: 'reset-credit-note', usageItem: 'resets', note: true, meter: false }
  ].map((row) => ({ ...row, dataset: { usageItem: row.usageItem }, classList: { contains: () => row.note }, querySelector: () => row.meter ? {} : null }));
  const pick = vm.runInNewContext(`${source}; notchQuotaRows`);
  assert.deepEqual(Array.from(pick({ querySelectorAll: () => rows }), (row) => row.id),
    ['normal-session', 'credits-amount-without-meter', 'unlimited', 'budget-spend-with-meter']);
});


test('notch tooltip viewport accommodation clamps both axes and leaves ordinary EdgeDock alone', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function fitNotchTooltip('), source.indexOf("root.addEventListener('toggle'"));
  const context = { surface: 'bubble', state: { payload: { omitQuotaBars: true } }, innerWidth: 292, innerHeight: 163 };
  const fit = vm.runInNewContext(`${code};fitNotchTooltip`, context);
  const tooltip = { style: {}, matches: () => true, offsetWidth: 226,
    getBoundingClientRect: () => ({ left: 67, top: 77, width: 226, height: 89.1875 }) };
  fit(tooltip);
  assert.equal(tooltip.style.translate, '-9px -11.1875px');
  context.state.payload.omitQuotaBars = false;
  tooltip.style.translate = 'unchanged';
  fit(tooltip);
  assert.equal(tooltip.style.translate, 'unchanged');
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
  assert.deepEqual(data.cells, cells, 'periods, rate, sessions and provider preferences must reach the original detail card unchanged');
  const sessions = data.cells.find((cell) => cell.metric === 'sessions');
  assert.equal(sessions.runningOnly, true);
  assert.equal(sessions.groupBy, 'client');
  assert.equal(sessions.cellDetail, 'rate');
  assert.equal(sessions.rate, 900);
  assert.equal(data.cells.find((cell) => cell.metric === 'liveRate').rate, 900);
});

test('top rate toggle accepts only its own surfaces and removes its listener on disposal', (t) => {
  let toggles = 0;
  const { controller, windows, ipcMain } = fixture(t, {}, { onToggleRateMode: () => { toggles += 1; } });
  ipcMain.emit('topNotch:toggleRateMode', { sender: {} });
  assert.equal(toggles, 0);
  for (const win of windows) ipcMain.emit('topNotch:toggleRateMode', { sender: win.webContents });
  assert.equal(toggles, 2);
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


test('layered height caps use current work area without stretching or double scaling content', () => {
  for (const usableHeight of [600, 820, 923, 1100, 1600]) {
    const d = { ...display, bounds: { x: -1470, y: -200, width: 1470, height: usableHeight + 93 },
      workArea: { x: -1470, y: -167, width: 1470, height: usableHeight } };
    const g = { notched: true, centerX: -734.5, gapWidth: 179, height: 32, y: -200 };
    const mainCap = Math.min(480, Math.round(usableHeight * 0.382));
    const detailCap = Math.min(640, Math.round(usableHeight * 0.618));
    assert.equal(notchMaxHeight(d, g), mainCap);
    assert.equal(notchMaxHeight(d, g, true), detailCap);
    for (const zoom of [0.85, 1, 1.25, 1.5]) {
      assert.equal(notchBounds(d, g, true, 4000, null, zoom).height, mainCap);
      assert.equal(notchBounds(d, g, true, 100, null, zoom).height, 132,
        'short physical content retains natural height at every zoom');
    }
  }
  const noArea = { bounds: { x: 0, y: 0, width: 1000, height: 300 } };
  const g = notchGeometry(noArea);
  assert.equal(notchMaxHeight(noArea, g), 115);
  assert.equal(notchMaxHeight(noArea, g, true), 185);
});

test('notch detail side mirrors placement and clamps both placed and measured height', (t) => {
  const f = fixture(t, { notchDetailSide: 'left', notchStyle: 'black' });
  f.controller.setData(buildNotchData(stats(), buildEdgeDockCells(stats()), {}, {}));
  const top = f.windows[0];
  f.ipcMain.emit('topNotch:size', { sender: top.webContents }, { height: 100, rows: [{ id: 'codex', x: 28, y: 32, width: 280, height: 80 }] });
  f.screen.point = { x: top.bounds.x + 40, y: 15 };f.controller.poll(1000);f.controller.poll(1200);
  f.screen.point = { x: top.bounds.x + 60, y: 60 };f.controller.poll(1300);f.controller.poll(1400);
  const detail = f.windows[1];
  f.ipcMain.emit('topNotch:bubbleSize', { sender: detail.webContents }, { cellId: 'codex', height: 4000 });
  assert.equal(last(detail).side, 'right', 'tail faces the top list when detail is on its left');
  assert.ok(detail.bounds.x + detail.bounds.width <= top.bounds.x + 28, 'detail belongs on the left');
  assert.equal(detail.bounds.height, 570);
  assert.equal(last(detail).placed.height, last(detail).maxCardHeight);
  assert.equal(last(detail).style, 'black');
  f.preferences.notchDetailSide = 'right';f.controller.sync();
  assert.equal(last(detail).side, 'left');
  assert.ok(detail.bounds.x >= top.bounds.x + top.bounds.width - 28);
  const small = { ...display, bounds: { x: -1470, y: -200, width: 1470, height: 750 },
    workArea: { x: -1470, y: -167, width: 1470, height: 600 } };
  f.screen.getAllDisplays = () => [small]; f.screen.getPrimaryDisplay = () => small;
  f.screen.emit('display-metrics-changed');
  assert.equal(last(detail).maxCardHeight, 371);
  assert.equal(detail.bounds.height, 371);
  assert.ok(detail.bounds.y >= small.workArea.y);
  assert.ok(detail.bounds.y + detail.bounds.height <= small.workArea.y + small.workArea.height - EDGE_DOCK_METRICS.screenMargin);
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


test('notch tool marks fit their available width and restore on a wider row', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const helper = source.slice(source.indexOf('function fitNotchMarks('), source.indexOf('function fitNotchStatReadouts('));
  const more = { hidden: false, textContent: '+3', getBoundingClientRect() { return { width: this.textContent.length * 6 * row.scale }; } };
  const icons = Array.from({ length: 3 }, () => ({ hidden: false }));
  const row = { dataset: { clientCount: 6 }, clientWidth: 80, clientHeight: 20, scale: 1, getBoundingClientRect() { return { width: this.clientWidth * this.scale, height: 20 * this.scale }; }, querySelectorAll: () => icons, querySelector: () => more };
  const fit = vm.runInNewContext(`${helper}; fitNotchMarks`, { getComputedStyle: (node) => node === row ? { columnGap: '5px' } : { width: '20px' } });
  fit(row);
  assert.equal(icons.filter(n => !n.hidden).length, 2);
  assert.equal(more.textContent, '+4');
  row.clientWidth = 30;fit(row);
  assert.equal(icons.filter(n => !n.hidden).length, 0);
  assert.equal(more.textContent, '+6');
  row.clientWidth = 100;fit(row);
  assert.equal(icons.filter(n => !n.hidden).length, 3);
  assert.equal(more.textContent, '+3');
  row.scale = 1.6;row.clientWidth = 80;fit(row);
  assert.equal(icons.filter(n => !n.hidden).length, 2, 'zoom scales both available width and marks');
  assert.equal(more.textContent, '+4');
  row.clientWidth = 100;row.dataset.clientCount = 3;fit(row);
  assert.equal(more.hidden, true);
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
  assert.ok(primary.getBounds().width < beforeShrink.width);
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

for (const [size, zoom] of [['small', 0.85], ['medium', 1], ['large', 1.25]]) for (const side of ['left', 'right']) {
  test(`hover crossing the ${side} ${size} detail gap keeps EdgeDock intent until the pointer leaves`, (t) => {
    const { controller, windows: [primary, bubble], ipcMain, screen } = fixture(t, { notchDetailSide: side, notchSize: size });
    const cell = { id: 'codex', type: 'limit', provider: 'codex', providers: stats().limits.providers };
    controller.setData({ cells: [cell], sessions: [], summary: null });
    ipcMain.emit('topNotch:size', { sender: primary.webContents }, { height: 100 * zoom, rows: [{ id: 'codex', x: 28 * zoom, y: 32, width: 280 * zoom, height: 90 * zoom }] });
    screen.point = { x: primary.bounds.x + last(primary).geometry.headerX + 20, y: 16 };
    controller.poll(100); controller.poll(240);
    screen.point = { x: primary.bounds.x + 60, y: 70 };
    controller.poll(300); controller.poll(370);
    ipcMain.emit('topNotch:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 100 });
    const edge = side === 'left' ? primary.bounds.x + 28 * zoom : primary.bounds.x + primary.bounds.width - 28 * zoom;
    const detailEdge = side === 'left' ? bubble.bounds.x + bubble.bounds.width : bubble.bounds.x;
    screen.point = { x: (edge + detailEdge) / 2, y: 80 };
    controller.poll(400); controller.poll(721);
    assert.equal(bubble.opacity, 1, 'the connecting gap is part of the existing hover intent');
    assert.equal(last(primary).expanded, true);
    screen.point = { x: bubble.bounds.x + bubble.bounds.width / 2, y: bubble.bounds.y + 20 };
    controller.poll(800);
    assert.equal(bubble.opacity, 1, 'arriving at the detail keeps it open');
    screen.point = { x: 20, y: 500 };
    controller.poll(900); controller.poll(1221);
    assert.equal(bubble.opacity, 0, 'leaving both surfaces still hides the detail');
    assert.equal(last(primary).expanded, false);
  });
}


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
      assert.ok(leftEar >= iconWidth + 16 + 4, 'the measured icon and existing clearances fit');
      assert.ok(leftEar < iconWidth + 16 + 4 + 1, 'no extra fixed content reservation is added');
      assert.ok(Math.abs(minimum.x + minimum.width / 2 - geometry.centerX) <= 0.5);
      assert.ok(Math.abs(longer.x + longer.width / 2 - geometry.centerX) <= 0.5);
      assert.equal(notchBounds(display, geometry, false, 180, null).width, gapWidth);
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


test('approach expansion defaults on, stays local and narrows EdgeDock distance while retaining dwell', (t) => {
  for (const size of ['small', 'large']) {
    for (const enabled of [undefined, false, true]) {
      const f = fixture(t, { notchExpandOnApproach: enabled, notchSize: size });
      const geometry = last(f.windows[0]).geometry;
      const y = geometry.y + geometry.height + EDGE_DOCK_METRICS.wakeDepth / 2 - 1;
      const enter = (point, at) => {
        f.screen.point = point;
        f.controller.poll(at);
        f.controller.poll(at + EDGE_DOCK_TIMING.revealDelayMs - 1);
        assert.equal(last(f.windows[0]).expanded, false, 'brief passes do not expand');
        f.controller.poll(at + EDGE_DOCK_TIMING.revealDelayMs);
      };
      let at = Date.now();
      enter({ x: geometry.centerX, y: y + 2 }, at);
      assert.equal(last(f.windows[0]).expanded, false, 'outside the wake distance');
      f.screen.point = { x: 20, y: 400 }; f.controller.poll(at += 500);
      enter({ x: geometry.centerX + geometry.headerWidth / 2 + 1, y }, at += 500);
      assert.equal(last(f.windows[0]).expanded, false, 'nearby menu items do not trigger');
      f.screen.point = { x: 20, y: 400 }; f.controller.poll(at += 500);
      enter({ x: geometry.centerX, y }, at += 500);
      assert.equal(last(f.windows[0]).expanded, enabled !== false, 'the setting controls the additional physical range');
      f.screen.point = { x: 20, y: 400 }; f.controller.poll(at += 500);
      f.controller.poll(at += EDGE_DOCK_TIMING.hideDelayMs);
      assert.equal(last(f.windows[0]).expanded, false);
      enter({ x: geometry.centerX, y: geometry.y + geometry.height - 1 }, at + 500);
      assert.equal(last(f.windows[0]).expanded, true, 'direct contact still opens in either mode');
    }
  }
});


test('approach expansion follows EdgeDock drag suppression without changing direct contact', (t) => {
  for (const held of [true, null]) {
    const f = fixture(t, { notchExpandOnApproach: true }, { primaryButtonDown: () => held });
    const geometry = last(f.windows[0]).geometry;
    const now = Date.now();
    f.screen.point = { x: geometry.centerX, y: geometry.y + geometry.height + 1 };
    f.controller.poll(now); f.controller.poll(now + EDGE_DOCK_TIMING.revealDelayMs);
    assert.equal(last(f.windows[0]).expanded, false, 'held or unknown button state does not wake the entry');
    f.screen.point.y = geometry.y + geometry.height - 1;
    f.controller.poll(now + 500); f.controller.poll(now + 500 + EDGE_DOCK_TIMING.revealDelayMs);
    assert.equal(last(f.windows[0]).expanded, true, 'direct entry contact retains its existing behavior');
  }
});


test('menu clearance bounds physical ears and ignores off-screen or tall status panels', () => {
  const geometry = notchGeometry(display, native);
  const icon = { id: 1, x: 894, y: 0, width: 24, height: 33 };
  assert.equal(notchSummaryMaxWidth(display, geometry, [icon]), 301);
  assert.equal(notchSummaryMaxWidth(display, geometry, [{ ...icon, x: 830 }]), 173, 'the budget cannot exceed measured clearance');
  for (const ignored of [{ ...icon, x: 780, height: 117 }, { ...icon, y: 32 }, { ...icon, x: 1480 },
    { ...icon, y: -40 }, { ...icon, x: 100 }, { ...icon, width: NaN }]) {
    assert.equal(notchSummaryMaxWidth(display, geometry, [icon, ignored]), 301);
  }
  assert.equal(notchSummaryMaxWidth(display, geometry, [{ ...icon, x: 850 }, icon], [1]), 1453, 'exclude the owned surface without excluding its tray icons by PID');
  assert.equal(notchSummaryMaxWidth(display, geometry, null), null, 'failed sampling is not a measured empty menu');
  assert.equal(notchSummaryMaxWidth(display, notchGeometry(display, null, 'pill'), [icon]), null);
  const offset = { ...display, bounds: { ...display.bounds, x: -1470, y: -956 } };
  const shifted = { ...geometry, centerX: geometry.centerX - 1470, y: -956 };
  assert.equal(notchSummaryMaxWidth(offset, shifted, [{ ...icon, x: icon.x - 1470, y: -956 }]), 301);
});

test('menu window reader uses status level and numeric metadata and releases copied lists on success and failure', () => {
  const { createMacMenuWindowReader } = require('../../src/electron/notch/menuBar');
  const n = value => ({ value });
  const menu = { kCGWindowNumber: n(31), kCGWindowLayer: n(25), kCGWindowBounds: { X: n(894), Y: n(0), Width: n(24), Height: n(33) } };
  const list = [menu, { ...menu, kCGWindowLayer: n(101) }];
  const released = [];
  let fail = false, result = list;
  const functions = {
    CFStringCreateWithCString: (_alloc, key) => key,
    CFRelease: ref => released.push(ref),
    CFArrayGetCount: ref => ref.length,
    CFArrayGetValueAtIndex: (ref, i) => { if (fail) throw new Error('sample failed'); return ref[i]; },
    CFDictionaryGetValue: (dict, key) => dict[key],
    CFNumberGetValue: (ref, _type, output) => { output[0] = ref.value; return true; },
    CGWindowLevelForKey: key => { assert.equal(key, 9); return 25; },
    CGWindowListCopyWindowInfo: (flags, relative) => { assert.equal(flags, 17); assert.equal(relative, 0); return result; }
  };
  const read = createMacMenuWindowReader({ load: () => ({ func: name => {
    assert.ok(functions[name], `unexpected native function ${name}`); return functions[name];
  } }), out: value => value, pointer: value => value });
  assert.deepEqual(read(), [{ id: 31, x: 894, y: 0, width: 24, height: 33 }]);
  assert.deepEqual(released, [list]);
  fail = true;
  assert.throws(read, /sample failed/);
  assert.deepEqual(released, [list, list]);
  result = null;
  assert.equal(read(), null);
  assert.equal(released.length, 2);
});


test('menu avoidance bounds all active summary fields and keeps the camera centered', (t) => {
  let reads = 0, windows = [{ id: 7, x: 894, y: 0, width: 24, height: 33 }];
  const f = fixture(t, {}, { readMenuWindows: () => { reads += 1; return windows; } });
  const data = buildNotchData(stats(), [], { trayContent: 'tokens' });
  f.controller.setData(data);
  assert.equal(reads, 1, 'even a single primary field respects menu clearance');
  data.summary.items.push({ type: 'text', id: 'extra', text: '$10' });
  f.controller.setData(data);
  assert.equal(reads, 1);
  const primary = f.windows[0];
  f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots: { left: 17, right: 600, minimumLeft: 17, minimumRight: 37 } });
  let geometry = last(primary).geometry;
  assert.equal(geometry.summaryBudget, 41);
  assert.equal(geometry.headerWidth, 301, 'raw widths above 220pt are budgeted, not silently mismeasured');
  assert.equal(geometry.gapOffset, (geometry.headerWidth - geometry.gapWidth) / 2);
  f.controller.poll(Date.now() + 1000);
  assert.equal(reads, 1, 'ordinary pointer polls reuse the menu sample');
  windows = [{ id: 7, x: 850, y: 0, width: 24, height: 33 }];
  f.screen.emit('display-metrics-changed');
  assert.equal(reads, 2);
  geometry = last(primary).geometry;
  assert.equal(geometry.summaryBudget, 0, 'known occupied clearance also constrains the primary');
  assert.equal(geometry.headerWidth, 213);
  windows = null;
  f.screen.emit('display-metrics-changed');
  assert.equal(last(primary).geometry.summaryBudget, 625, 'unknown menu clearance falls back to the screen capacity');
});


test('disabled menu avoidance retains full summary widths and stops menu sampling', (t) => {
  let reads = 0;
  const f = fixture(t, { notchAvoidMenuBar: false }, {
    readMenuWindows: () => { reads += 1; return [{ id: 7, x: 850, y: 0, width: 24, height: 33 }]; }
  });
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  const primary = f.windows[0];
  f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots: { left: 17, right: 300, minimumLeft: 17, minimumRight: 300 } });
  assert.equal(reads, 0);
  assert.equal(last(primary).geometry.summaryBudget, 625);
  assert.equal(last(primary).geometry.headerWidth, 819);
  f.preferences.notchAvoidMenuBar = true;
  f.controller.poll(Date.now() + 2500);
  assert.equal(reads, 1);
  assert.equal(last(primary).geometry.summaryBudget, 0);
  f.preferences.notchAvoidMenuBar = false;
  f.controller.sync();
  f.controller.poll(Date.now() + 5000);
  assert.equal(reads, 1, 'disabled avoidance performs no native menu reads');
  assert.equal(last(primary).geometry.summaryBudget, 625);
});

test('capsules keep their complete summary and skip menu reads regardless of avoidance', (t) => {
  for (const [shape, hardware] of [['pill', true], ['pill', false], ['auto', false]]) {
    let reads = 0;
    const f = fixture(t, { notchShape: shape }, {
      readScreens: () => ({ screens: hardware ? [native] : [], mainDisplayId: 1 }),
      readMenuWindows: () => { reads++; return [{ id: 7, x: 750, y: 0, width: 300, height: 32 }]; }
    });
    f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
    const primary = f.windows[0];
    const slots = { left: 17, right: 300, minimumLeft: 17, minimumRight: 300 };
    f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots });
    const width = last(primary).geometry.headerWidth;
    for (const enabled of [false, true]) {
      f.preferences.notchAvoidMenuBar = enabled;
      f.controller.sync();
      f.controller.poll(Date.now() + 2500);
      const geometry = last(primary).geometry;
      assert.equal(geometry.gapWidth, 0);
      assert.ok(geometry.summaryBudget > 1400, 'compact entries use the screen capacity');
      assert.equal(geometry.headerWidth, width, `${shape}: avoidance cannot change compact width`);
    }
    assert.equal(reads, 0);
  }
});

test('switching entry shapes releases a hardware menu constraint and restores it on return', (t) => {
  let reads = 0;
  const f = fixture(t, {}, { readMenuWindows: () => { reads++; return [{ id: 7, x: 850, y: 0, width: 300, height: 32 }]; } });
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  assert.equal(last(f.windows[0]).geometry.summaryBudget, 0);
  f.preferences.notchShape = 'pill';
  f.controller.sync();
  f.controller.poll(Date.now() + 2500);
  assert.ok(last(f.windows[0]).geometry.summaryBudget > 1400);
  assert.equal(reads, 1);
  f.preferences.notchShape = 'auto';
  f.controller.sync();
  f.controller.poll(Date.now() + 5000);
  assert.equal(last(f.windows[0]).geometry.summaryBudget, 0);
  assert.equal(reads, 2);
});

test('embedded summary icons use the tray preferred row and retain provider status', () => {
  const input = stats();
  input.limits.providers.push({ provider: 'claude', status: 'ok', windows: [{ kind: 'session', remainingPercent: 80 }] });
  for (const style of ['doubleBar', 'doubleInfo']) {
    for (const [icon, expected] of [['first', 'codex'], ['second', 'claude'], ['app', 'app'], ['none', undefined]]) {
      const item = trayLayout.createTrayLayoutItem(style);
      item.icon = icon;
      item.rows = [{ provider: 'codex', window: 'primary', metric: 'percent' }, { provider: 'claude', window: 'primary', metric: 'percent' }];
      const data = buildNotchData(input, [], { notchFollowTray: false, notchCustomLayout: { version: trayLayout.VERSION, items: [item] } });
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
  const summary = buildNotchData(input, [], { notchFollowTray: false, notchCustomLayout: { version: trayLayout.VERSION, items: [item] } }, { nowMs: now }).summary;
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

test('a single custom label preserves shared formatting and uses the menu budget', (t) => {
  let reads = 0;
  const f = fixture(t, {}, { readMenuWindows: () => { reads += 1; return [{ id: 7, x: 894, y: 0, width: 24, height: 33 }]; } });
  const item = trayLayout.createTrayLayoutItem('customText');item.text = 'Long label '.repeat(4);
  const data = buildNotchData(stats(), [], { notchFollowTray: false, notchCustomLayout: { version: trayLayout.VERSION, items: [item] } });
  assert.equal(data.summary.items[0].text, trayLayout.resolveTrayLayout(summaryLayout({ notchFollowTray: false, notchCustomLayout: { version: trayLayout.VERSION, items: [item] } }), stats()).items[0].text);
  f.controller.setData(data);assert.equal(reads, 1);
  const primary = f.windows[0];
  f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots: { left: 0, right: 41, minimumLeft: 0, minimumRight: 0 } });
  assert.equal(last(primary).geometry.summaryBudget, 41);
  assert.equal(last(primary).geometry.headerWidth, 301);
});


test('full-screen quiet mode retracts ears, retains configuration and restores it on hover and exit', (t) => {
  let full = false, reads = 0;
  const f = fixture(t, { notchExpandOnApproach: false }, {
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
  assert.equal(last(primary).geometry.headerWidth, 179);
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
  assert.equal(last(primary).geometry.headerWidth, 179);
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
  assert.equal(defaults.notchHideSummaryInFullScreen, true);
  assert.equal(defaults.notchAvoidMenuBar, true);
  assert.equal(defaults.notchRefreshEnabled, false);
  const loadedSource = mainSource.slice(mainSource.indexOf('    merged.notchAvoidMenuBar ='), mainSource.indexOf('    merged.notchFollowTray ='));
  const patchStart = mainSource.indexOf('      notchAvoidMenuBar: parseBoolean(');
  const patchSource = mainSource.slice(patchStart, mainSource.indexOf('      notchFollowTray:', patchStart));
  for (const [hide, refresh, avoid] of [[undefined, undefined, undefined], [false, true, false], [true, false, true]]) {
    const merged = { notchHideSummaryInFullScreen: hide, notchRefreshEnabled: refresh, notchAvoidMenuBar: avoid };
    const context = { merged, patch: { ...merged }, settings: defaults, parseBoolean };
    vm.runInNewContext(loadedSource, context);
    const patched = vm.runInNewContext(`({${patchSource}})`, context);
    for (const result of [merged, patched]) {
      assert.equal(result.notchHideSummaryInFullScreen, hide ?? true);
      assert.equal(result.notchAvoidMenuBar, avoid ?? true);
      assert.equal(result.notchRefreshEnabled, refresh ?? false);
    }
  }
});

test('the full-screen setting saves both checkbox states through its change event', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const source = app.slice(app.indexOf("els.notchHideSummaryInFullScreenInput?.addEventListener("), app.indexOf("els.notchExpandOnApproachInput?.addEventListener("));
  let change;
  const patches = [];
  const input = { checked: false, addEventListener: (_event, callback) => { change = callback; } };
  vm.runInNewContext(source, { els: { notchHideSummaryInFullScreenInput: input }, saveSettings: patch => patches.push({ ...patch }) });
  change();
  input.checked = true;
  change();
  assert.deepEqual(patches, [{ notchHideSummaryInFullScreen: false }, { notchHideSummaryInFullScreen: true }]);
});


test('menu avoidance saves both states independently of summary visibility', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf("els.notchAvoidMenuBarInput?.addEventListener(");
  const source = app.slice(start, app.indexOf("els.notchRunningIndicatorInput?.addEventListener(", start));
  let change;
  const patches = [];
  const input = { checked: false, addEventListener: (_event, callback) => { change = callback; } };
  vm.runInNewContext(source, { els: { notchAvoidMenuBarInput: input }, saveSettings: patch => patches.push({ ...patch }) });
  change();
  input.checked = true;
  change();
  assert.deepEqual(patches, [{ notchAvoidMenuBar: false }, { notchAvoidMenuBar: true }]);
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


test('Notch reuses EdgeDock haptics once per expansion and visible detail visit', (t) => {
  const ticks = [];
  const f = fixture(t, { notchHaptic: true }, { performHaptic: (...args) => ticks.push(args) });
  const { controller, screen, windows, ipcMain, preferences } = f;
  const [primary, bubble] = windows;
  const cells = [{ id: 'codex', accounts: [] }, { id: 'claude', accounts: [] }];
  const data = { sessions: [], summary: null, cells };
  const size = { height: 180, rows: [
    { id: 'codex', x: 28, y: 32, width: 280, height: 70 },
    { id: 'claude', x: 28, y: 102, width: 280, height: 70 }
  ] };
  controller.setData(data);
  ipcMain.emit('topNotch:size', { sender: primary.webContents }, size);
  screen.point = { x: 735, y: 10 };
  controller.poll(100); controller.poll(240); controller.poll(260);
  assert.deepEqual(ticks, [['generic', 'default']]);
  screen.point = { x: primary.bounds.x + 40, y: 50 };
  controller.poll(300); controller.poll(370);
  assert.equal(ticks.length, 1, 'waiting for detail measurement does not tick');
  const measure = (id, height = 250) => ipcMain.emit('topNotch:bubbleSize',
    { sender: bubble.webContents }, { cellId: id, height });
  measure('wrong'); assert.equal(ticks.length, 1);
  measure('codex'); assert.equal(bubble.opacity, 1); assert.equal(ticks.length, 2);
  measure('codex', 260); controller.setData(data);
  ipcMain.emit('topNotch:size', { sender: primary.webContents }, size);
  controller.previewScale(1.1); controller.previewScale(1);
  assert.equal(ticks.length, 2, 'repaints, resizing and zoom previews do not tick');
  screen.point = { x: primary.bounds.x + 40, y: 130 };
  controller.poll(400); controller.poll(410); measure('claude');
  assert.equal(last(bubble).cell.id, 'claude');
  assert.equal(ticks.length, 2, 'provider switching inside a visible detail is quiet');
  screen.point = { x: bubble.bounds.x + 20, y: bubble.bounds.y + 20 };
  controller.poll(450); assert.equal(ticks.length, 2, 'cross-window hover is quiet');
  screen.point = { x: 20, y: 500 };
  controller.poll(500); controller.poll(820);
  assert.equal(last(primary).expanded, false); assert.equal(ticks.length, 2);
  preferences.notchHaptic = false;
  screen.point = { x: 735, y: 10 }; controller.poll(900); controller.poll(1040);
  screen.point = { x: primary.bounds.x + 40, y: 50 };
  controller.poll(1100); controller.poll(1170); measure('codex');
  assert.equal(ticks.length, 2, 'the independent switch disables both Notch triggers');
  preferences.notchHaptic = true; measure('codex'); controller.setData(data);
  assert.equal(ticks.length, 2, 'enabling midway does not replay a visible visit');
  controller.setLocked(true); controller.setLocked(false);
  screen.point = { x: 735, y: 10 }; controller.poll(1300); controller.poll(1440);
  screen.point = { x: primary.bounds.x + 40, y: 50 };
  controller.poll(1500); controller.poll(1570); measure('codex');
  assert.equal(ticks.length, 4, 'a later expansion and new detail visit each tick once');
  const nativeCalls = [];
  const options = wiredNotchOptions({ performMacHaptic: value => nativeCalls.push({ ...value }) });
  options.performHaptic('generic', 'default');
  assert.deepEqual(nativeCalls, [{ pattern: 'generic', performanceTime: 'default' }]);
});

test('a failing native haptic leaves Notch expansion and detail visibility usable', (t) => {
  const f = fixture(t, { notchHaptic: true }, { performHaptic: () => { throw new Error('no hardware'); } });
  const { controller, screen, windows, ipcMain } = f;
  const [primary, bubble] = windows;
  controller.setData({ cells: [{ id: 'codex', accounts: [] }], sessions: [], summary: null });
  ipcMain.emit('topNotch:size', { sender: primary.webContents },
    { height: 100, rows: [{ id: 'codex', x: 28, y: 32, width: 280, height: 90 }] });
  screen.point = { x: 735, y: 10 }; controller.poll(100); controller.poll(240);
  assert.equal(last(primary).expanded, true);
  screen.point = { x: primary.bounds.x + 40, y: 50 }; controller.poll(300); controller.poll(370);
  ipcMain.emit('topNotch:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 250 });
  assert.equal(bubble.opacity, 1);
});


test('Notch refresh validates its own action and shares one request with retry and visit guards', async (t) => {
  let resolve, reject, calls = 0, available = true;
  const ticks = [];
  const f = fixture(t, { notchRefreshEnabled: true, notchHaptic: true }, {
    performHaptic: (...args) => ticks.push(args), canRefreshLimits: () => available,
    onRefreshLimits: () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); }
  });
  const { controller, screen, windows, ipcMain, preferences } = f;
  const [primary, bubble] = windows;
  const invoke = (sender = primary.webContents) => ipcMain.handlers.get('topNotch:refreshLimits')({ sender });
  assert.equal(invoke().ok, false, 'collapsed entry cannot refresh');
  screen.point = { x: 735, y: 10 }; controller.poll(100); controller.poll(240);
  assert.equal(last(primary).refreshable, true);
  assert.equal(invoke(bubble.webContents).ok, false);
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
  for (const win of windows.slice(2)) ipcMain.emit('topNotch:ready', { sender: win.webContents });
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
      assert.equal(open.height, 180, 'no permanent summary row without hardware');
      assert.ok(open.width >= Math.ceil((EDGE_DOCK_METRICS.bubbleWidth + (geometry.notched ? 2 * EDGE_DOCK_METRICS.shoulder : 0)) * zoom));
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
  f.ipcMain.emit('topNotch:frame',{sender:win.webContents},{id:animation.id,elapsed:animation.duration/2});
  const halfway=frame();
  assert.deepEqual(halfway.summaryEdges,closed.summaryEdges);
  assert.ok(halfway.headerHeight>0&&halfway.headerHeight<32);
  f.ipcMain.emit('topNotch:frame',{sender:win.webContents},{id:animation.id,elapsed:animation.duration});
  assert.equal(frame().headerHeight,0);
  assert.deepEqual(frame().summaryEdges,closed.summaryEdges);
});

test('capsule details meet the visible edge on either side without a phantom header', (t) => {
  for (const side of ['left','right']) {
    for (const size of ['small','medium','large']) {
      const f=fixture(t,{notchShape:'pill',notchDetailSide:side,notchSize:size});
      const top=f.windows[0],bubble=f.windows[1];
      f.controller.setData({cells:[{id:'codex',provider:'codex',accounts:[]}],sessions:[],summary:null});
      const y=last(top).geometry.y;
      f.screen.point={x:display.bounds.width/2,y:y+10};f.controller.poll(1000);f.controller.poll(1200);
      const b=top.getBounds();
      f.ipcMain.emit('topNotch:size',{sender:top.webContents},{height:100,rows:[{id:'codex',x:30,y:0,width:b.width-60,height:80}]});
      f.screen.point={x:b.x+40,y:y+20};f.controller.poll(1300);f.controller.poll(1400);
      f.ipcMain.emit('topNotch:bubbleSize',{sender:bubble.webContents},{cellId:'codex',height:220});
      const detail=bubble.getBounds();
      assert.equal(detail.y,y,'capsule details can align with the first provider');
      assert.equal(side==='left'?b.x-detail.x-detail.width:detail.x-b.x-b.width,EDGE_DOCK_METRICS.bubbleGap);
      assert.equal(bubble.opacity,1);
      // Cross the real visible-body gap and remain expanded, on both sides.
      f.screen.point={x:side==='left'?b.x-2:b.x+b.width+2,y:detail.y+60};
      f.controller.poll(1500);f.controller.poll(1900);
      assert.equal(last(top).expanded,true);
    }
  }
});

test('menu budgets apply to notch shapes with or without a physical gap', () => {
  const menu = { id: 91, x: 950, y: 0, width: 300, height: 32 };
  for (const shape of ['auto', 'pill']) {
    const compact = notchGeometry(display, null, shape);
    assert.equal(notchSummaryMaxWidth(display, compact, [menu]), null);
  }
  assert.equal(notchSummaryMaxWidth(display, notchGeometry(display, native, 'pill'), [menu]), null);
  const hardware = notchGeometry(display, native);
  assert.ok(notchSummaryMaxWidth(display, hardware, [menu]) > 0);
  assert.equal(notchSummaryMaxWidth(display, notchGeometry(display, null, 'notch'), [menu]), 414);
});

test('camera-free renderer fits the display limit while reserving a complete primary readout before extra icons', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function notchLogicalPoint('), source.indexOf('const notchProviderObserver'));
  const left = { minimum: 17, width: 300, children: [] }, right = { minimum: 40, width: 500 };
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
      notchSummaryEnabled: !active, notchFollowTray: false, notchCustomLayout: { version: 3, items: [] }
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


test('Notch haptics default off and stay independent of side dock settings', (t) => {
  for (const edgeDockHaptic of [false, true]) for (const notchHaptic of [undefined, false, true]) {
    let ticks = 0;
    const f = fixture(t, { edgeDockHaptic, notchHaptic }, { performHaptic: () => ticks++ });
    f.controller.setData({ cells: [], summary: null, sessions: [] });
    f.screen.point = { x: 735, y: 10 };
    f.controller.poll(100); f.controller.poll(100 + EDGE_DOCK_TIMING.revealDelayMs);
    assert.equal(last(f.windows[0]).expanded, true);
    assert.equal(ticks, notchHaptic === true ? 1 : 0);
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
  const f = fixture(t, { notchStyle: 'liquid-glass' }, {
    nativeGlass: () => true, liquidGlass: () => ({ dark }),
    createGlass: () => ({ update(value) { updates.push(value.dark); }, dispose() {} })
  });
  assert.equal(updates.at(-1), true);
  for (const next of [false, true]) {
    dark = next;
    if (next) f.controller.setAppearance({ theme: 'dark' });
    else f.controller.sync();
    assert.equal(updates.at(-1), next);
    assert.equal(f.windows.length, 2);
  }
});

test('notch inherits Clear from the widget and switches its own style without recreating windows', (t) => {
  const updates = [];
  const f = fixture(t, { notchStyle: 'inherit', macBackdrop: 'liquid-glass-clear', edgeDockMacBackdrop: 'liquid-glass', macGlassTint: 12, macClearGlassTint: 64 }, {
    nativeGlass: () => true, liquidGlass: () => ({ dark: true }),
    createGlass: () => ({ update(value) { updates.push([value.style, value.tintOpacity]); }, dispose() {} })
  });
  assert.deepEqual(updates.at(-1), ['clear', 0.64]);
  for (const [style, expected] of [['liquid-glass', 'regular'], ['liquid-glass-clear', 'clear'], ['inherit', 'clear']]) {
    f.preferences.notchStyle = style;
    f.controller.sync();
    assert.deepEqual(updates.at(-1), [expected, expected === 'clear' ? 0.64 : 0.12]);
    assert.equal(f.windows.length, 2);
  }
  f.preferences.macClearGlassTint = 23;
  f.controller.setAppearance({});
  assert.deepEqual(updates.at(-1), ['clear', 0.23]);
});

test('renderer load rejection is logged for each window and can be stopped', async (t) => {
  const messages = [];
  const f = fixture(t, {}, { loadFile: () => Promise.reject(new Error('fixture load failure')), logger: text => messages.push(text) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.filter(text => text.includes('load failed: fixture load failure')).length, 2);
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
  assert.equal(messages.filter(text => text.includes('fixture cleanup failure')).length, 2);
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

test('unexpectedly closed windows cannot be polled or receive stale IPC', (t) => {
  const f = fixture(t);
  const win = f.windows[0];
  win.destroy();
  win.setIgnoreMouseEvents = () => { throw new Error('Object has been destroyed'); };
  assert.equal(f.controller.owns(win), false);
  assert.doesNotThrow(() => f.controller.poll(Date.now() + 3000));
  assert.doesNotThrow(() => f.ipcMain.emit('topNotch:size', { sender: win.webContents }, { height: 200 }));
  f.controller.sync();
  assert.equal(f.windows.length, 4, 'existing synchronization recreates the window pair');
  assert.ok(f.windows[1].isDestroyed());
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
  const f = fixture(t);
  const win = f.windows[0], geometry = last(win).geometry;
  f.screen.point = { x: win.bounds.x + geometry.headerX + 20, y: win.bounds.y + 10 };
  f.controller.poll(Date.now());
  f.controller.setLocked(true);
  t.mock.timers.tick(60000);
  f.controller.setLocked(false);
  assert.equal(last(win).expanded, false, 'the pre-lock dwell does not expand on unlock');
  const resumed = Date.now();
  f.controller.poll(resumed);
  f.controller.poll(resumed + EDGE_DOCK_TIMING.revealDelayMs - 1);
  assert.equal(last(win).expanded, false);
  f.controller.poll(resumed + EDGE_DOCK_TIMING.revealDelayMs);
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

test('Notch shares the dock idle and approach polling cadence', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  const f = fixture(t);
  const reads = [];
  f.screen.getCursorScreenPoint = () => { reads.push(Date.now()); return f.screen.point; };
  t.mock.timers.tick(89); assert.equal(reads.length, 0);
  t.mock.timers.tick(1); assert.deepEqual(reads, [10090]);
  const top = f.windows[0], payload = last(top);
  f.screen.point = { x: top.bounds.x + payload.geometry.headerX + 10, y: top.bounds.y + 10 };
  t.mock.timers.tick(90); assert.equal(reads.at(-1), 10180);
  t.mock.timers.tick(39); assert.equal(reads.length, 2);
  t.mock.timers.tick(1); assert.equal(reads.at(-1), 10220);
  for (let i = 0; i < 3; i++) t.mock.timers.tick(40);
  assert.equal(last(top).expanded, true);
  f.screen.point = { x: 20, y: 400 };
  for (let i = 0; i < 9; i++) t.mock.timers.tick(40);
  assert.equal(last(top).expanded, false);
  const idle = reads.length;
  t.mock.timers.tick(89); assert.equal(reads.length, idle);
  t.mock.timers.tick(1); assert.equal(reads.length, idle + 1);
});

test('disable and re-enable recreates renderer windows and rejects their old senders', (t) => {
  const f = fixture(t), old = [...f.windows];
  old[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(f.windows.length, 2, 'a crash is not automatically recovered');
  f.preferences.notchEnabled = false; f.controller.sync();
  assert.ok(old.every(win => win.isDestroyed()));
  f.preferences.notchEnabled = true; f.controller.sync();
  const fresh = f.windows.slice(2);
  assert.equal(fresh.length, 2);
  for (const win of fresh) f.ipcMain.emit('topNotch:ready', { sender: win.webContents });
  assert.ok(fresh.every(win => last(win)), 'each fresh renderer receives its initial payload');
  const messages = fresh[0].messages.length;
  f.ipcMain.emit('topNotch:size', { sender: old[0].webContents }, { height: 999 });
  assert.equal(fresh[0].messages.length, messages, 'old renderer cannot mutate the new windows');
});


test('identical data and size reports do not repeat native visibility or detail placement', (t) => {
  const f = fixture(t);
  const [primary, bubble] = f.windows;
  const input = { cells: [{ id: 'codex', kind: 'limit', provider: 'codex' }], sessions: [], summary: null };
  f.controller.setData(input);
  const calls = { showInactive: 0, setOpacity: 0, setBounds: 0 };
  for (const win of f.windows) for (const name of Object.keys(calls)) {
    const original = win[name];
    win[name] = function (...args) { calls[name]++; return original.apply(this, args); };
  }
  for (let i = 0; i < 20; i++) f.controller.setData(input);
  assert.deepEqual(calls, { showInactive: 0, setOpacity: 0, setBounds: 0 });
  f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, {
    height: 150, rows: [{ id: 'codex', x: 28, y: 32, width: 200, height: 80 }]
  });
  f.screen.point = { x: 735, y: 10 };
  f.controller.poll(100); f.controller.poll(240);
  f.screen.point = { x: primary.getBounds().x + 40, y: 50 };
  f.controller.poll(300); f.controller.poll(370);
  const report = { cellId: 'codex', height: 250 };
  f.ipcMain.emit('topNotch:bubbleSize', { sender: bubble.webContents }, report);
  assert.equal(bubble.getOpacity(), 1);
  for (const name of Object.keys(calls)) calls[name] = 0;
  for (let i = 0; i < 20; i++) {
    f.controller.setData(input);
    f.ipcMain.emit('topNotch:bubbleSize', { sender: bubble.webContents }, report);
  }
  assert.deepEqual(calls, { showInactive: 0, setOpacity: 0, setBounds: 0 });
  f.controller.setLocked(true);
  assert.equal(primary.getOpacity(), 0); assert.equal(bubble.getOpacity(), 0);
  f.controller.setLocked(false);
  assert.equal(primary.getOpacity(), 1);
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
  const settings = { notchSummaryEnabled: false, notchFollowTray: false,
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


test('summary resize batches fit text before reporting slots and leave the side rail untouched', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('const notchSummaryObserver'), source.indexOf('function notchText('));
  for (const surface of ['notch', 'edgeDock']) {
    const events = [];
    let callback;
    const head = {};
    vm.runInNewContext(code, {
      surface,
      ResizeObserver: class { constructor(fn) { callback = fn; } },
      contentLayer: { querySelector: () => head },
      fitNotchTypeface: target => events.push(target.id),
      reportNotchSlots: target => { assert.equal(target, head); events.push('report'); },
      animateNotchNumbers: () => events.push('animate')
    });
    if (surface === 'edgeDock') { assert.equal(callback, undefined); continue; }
    const target = (id, text) => ({ id, classList: { contains: name => text && name === 'notch-text-run' } });
    callback([{ target: target('slot', false) }, { target: target('text-one', true) }, { target: target('text-two', true) }]);
    assert.deepEqual(events, ['text-one', 'text-two', 'report', 'animate']);
  }
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
  const preferences = { deviceId: 'here', currency: 'USD', notchFollowTray: false,
    notchCustomLayout: { version: trayLayout.VERSION, items: [icon, reading] } };
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const code = main.slice(main.indexOf('function notchDataFor('), main.indexOf('function toggleDockRateMode('));
  for (const pending of ['next-login', null]) {
    const activeId = pending || 'old-login';
    const projection = { codexManagedAccounts: accounts, activeCodexAccountId: activeId, localDeviceId: 'here', syncActive: true };
    const expected = buildEdgeDockCells(input, { ...projection, items: [{ type: 'limit', provider: 'codex' }] })[0];
    const context = {
      settings: preferences, notchRateTimer: null, notchRateTrackers: new Map(), clearTimeout() {},
      notchSummaryLayout: summaryLayout, trayLayoutApi: trayLayout, buildNotchData,
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
    const lists = vm.runInNewContext(`${configuredDockItemsSource}; configuredDockItemLists()`, { settings, process: { platform } });
    assert.equal(lists[0], settings.edgeDockItems, 'the existing EdgeDock selection stays intact');
    assert.equal(lists.length, platform === 'darwin' ? 2 : 1);
    if (platform === 'darwin') assert.equal(lists[1], settings.notchItems);
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

test('disabling menu avoidance still bounds both ears to the screen capacity', (t) => {
  const f = fixture(t, { notchAvoidMenuBar: false });
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  const primary = f.windows[0];
  f.ipcMain.emit('topNotch:size', { sender: primary.webContents }, { slots: { left: 1000, right: 2000 } });
  const geometry = last(primary).geometry;
  assert.equal(geometry.summaryBudget, 625);
  assert.equal(geometry.headerWidth, 1469);
  assert.equal((geometry.headerWidth - geometry.gapWidth) / 2 - 20, geometry.summaryBudget);
});

test('both physical ears use the same finite budget', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function notchLogicalPoint('), source.indexOf('const notchProviderObserver'));
  const left = { minimum: 50, width: 67, children: [] }, right = { minimum: 0, width: 89 };
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
    notchFollowTray: false, notchCustomLayout: { version: trayLayout.VERSION, items: [rate] }
  } };
  const items = vm.runInNewContext(`${code}; displayLiveTokenRateItems`, { state, trayLayoutApi: trayLayout });
  assert.equal(items().length, 1);
  assert.equal(items()[0].id, rate.id);
  state.settings.notchFollowTray = true;
  assert.equal(items().length, 0);
  state.settings.notchFollowTray = false;
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
  const preferences = { notchFollowTray: false, deviceId: 'here',
    notchCustomLayout: { version: trayLayout.VERSION, items: [rate] } };
  let now = 0;
  const context = {
    settings: preferences, mode: 'local', Date: { now: () => now },
    notchRateTimer: null, notchRateTrackers: new Map(), notchController: { isRunning: () => false },
    clearTimeout() {}, notchSummaryLayout: summaryLayout, trayLayoutApi: trayLayout, tokenRateApi,
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


test('Notch renderer owns its observers and motion hooks while details reuse the shared host', () => {
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
    window: { addEventListener() {}, TokenMonitorPressActivation: {}, TokenMonitorEdgeDockPresentation: { runningSessionSummary() {} } }, root: { classList: { toggle: (name, value) => classes.set(name, value) }, addEventListener() {} },
    bridge: { onAnimate: handler => hooks.push(handler), onMotion: handler => hooks.push(handler) }, shared: {} };
  const create = context.module.exports.createNotchRenderer;
  const renderer = create({ ...deps, surface: 'notch' });
  const primaryObservers = observations.length, primaryHooks = hooks.length;
  assert.ok(primaryObservers > 0, 'the top entry observes its layout');
  assert.ok(primaryHooks > 0, 'the top entry receives motion updates');
  assert.equal(renderer.sessionCells()[0], cell);
  assert.equal(renderer.sessionCells()[1], iconCell);
  assert.equal(renderer.needsClock(), false);
  state.payload.expanded = false;
  assert.equal(renderer.sessionCells().length, 1, 'hidden primary rows do not keep expiry timers alive');
  state.payload.summary.needsClock = true;
  assert.equal(renderer.needsClock(), true);
  renderer.applyAppearance({ style: 'black' });
  assert.equal(classes.get('notch-black'), true);
  assert.equal(classes.get('is-notch-detail'), false);
  const detail = create({ ...deps, surface: 'bubble' });
  assert.equal(observations.length, primaryObservers, 'details do not create another summary observer');
  assert.equal(hooks.length, primaryHooks, 'details do not subscribe to shell motion');
  detail.applyAppearance({ style: 'inherit' });
  assert.equal(classes.get('notch-black'), false);
  assert.equal(classes.get('is-notch-detail'), true);
});

test('hidden Notch details stop their clock while ordinary EdgeDock keeps its cadence', () => {
  const dock = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const code = dock.slice(dock.indexOf('function selfRepaintDelayMs('), dock.indexOf('function repaintSelf('));
  const context = { surface: 'bubble', notchRenderer: {}, state: { payload: { visible: false } },
    BUBBLE_REPAINT_MS: 30000, sessionsExpiryDelayMs: () => assert.fail('hidden detail must not schedule an expiry') };
  const delay = vm.runInNewContext(`${code};selfRepaintDelayMs`, context);
  assert.equal(delay(), 0);
  context.sessionsExpiryDelayMs = () => 0;
  context.state.payload.visible = true;
  assert.equal(delay(), 30000);
  context.notchRenderer = null; context.state.payload.visible = false;
  assert.equal(delay(), 30000, 'ordinary EdgeDock behavior stays unchanged');
});

test('Notch retains static rows, refreshes time-dependent rows and defers hidden payloads until reveal', () => {
  class Node {
    constructor(className) { this.className = className; this.children = []; this.dataset = {}; this.scrollTop = 0; }
    get firstChild() { return this.children[0]; }
    querySelector(selector) {
      for (const node of this.children) {
        if (node.className.split(' ').includes(selector.slice(1))) return node;
        const found = node.querySelector(selector); if (found) return found;
      }
      return null;
    }
    insertBefore(node, reference) {
      node.remove(); node.parent = this;
      this.children.splice(reference ? this.children.indexOf(reference) : this.children.length, 0, node);
    }
    append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    addEventListener() {} focus() {}
  }
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function notchRowKey('), source.indexOf('function renderNotch(payload)'));
  const content = new Node('content'), created = [];
  let running = 1;
  const build = cell => { const node = new Node('edge-dock-card'); node.text = cell.totalTokens; created.push(cell.id); return node; };
  const context = { contentLayer: content, document: {}, state: { appearanceKey: 'theme' },
    presentation: { SESSIONS_METRIC: 'sessions' }, runningSessionSummary: () => ({ count: running, clients: running ? ['codex'] : [] }),
    notchRowsKey: '', notchRowNodes: new Map(), notchClock: 0, notchRowsPending: false,
    el: (_tag, classes, text) => Object.assign(new Node(classes), { textContent: text }), t: key => key, createCardWindowsView: () => ({}),
    notchStatOverviewCard: build, notchOverviewCard: build, prefersReducedMotion: () => false, appearance: () => ({}),
    numberAnimation: { normalize: () => 'roll' }, captureNotchStatNumbers: () => new Map(),
    settleNotchStatNumbers() {}, animateNotchStatNumbers() {},
    cardResetAnimator: { capture() {}, animate() {} }, notchProviderObserver: { observe() {} },
    reportNotchContentSize() {}, fitNotchStatReadouts() {}, overflowText: { refresh() {}, preserveReading() {} } };
  const render = vm.runInNewContext(`${code};renderNotchRows`, context);
  const input = { expanded: true, cells: [{ id: 'today', kind: 'stat', metric: 'today', totalTokens: 10 },
    { id: 'codex', kind: 'limit', accounts: [] }, { id: 'sessions', kind: 'stat', metric: 'sessions' }] };
  render(input, false);
  const list = content.querySelector('.notch-providers'), rows = content.querySelector('.notch-provider-list');
  const original = [...rows.children]; list.scrollTop = 25;
  context.notchClock++;
  render(input, false);
  assert.equal(content.querySelector('.notch-providers'), list);
  assert.equal(rows.children[0], original[0], 'clock keeps static usage DOM');
  assert.notEqual(rows.children[1], original[1], 'shared quota builder refreshes its boundary text');
  assert.equal(rows.children[2], original[2], 'unchanged session state keeps its DOM');
  running = 0; render(input, false);
  assert.notEqual(rows.children[2], original[2], 'session expiry updates without another collection');
  const hidden = { ...input, expanded: false, cells: [{ ...input.cells[0], totalTokens: 99 }] };
  const count = created.length; render(hidden, false);
  assert.equal(created.length, count);
  render({ ...hidden, expanded: true, motion: { progress: 0.1 } }, true);
  assert.equal(rows.children[0].text, 99, 'fresh reveal installs the latest data before the fade');
  assert.equal(rows.children.length, 1);
  assert.equal(context.notchRowNodes.size, 1, 'removed rows do not remain cached');
  assert.equal(list.scrollTop, 25);
  render({ expanded: true, cells: [], motion: { progress: 1 } }, false);
  assert.equal(context.notchRowNodes.size, 0);
  assert.ok(rows.querySelector('.notch-empty'));
  context.state.appearanceKey = 'new-locale'; context.t = () => 'Localized empty list';
  render({ expanded: true, cells: [], motion: { progress: 1 } }, false);
  assert.equal(rows.querySelector('.notch-empty').firstChild.textContent, 'Localized empty list');
});

test('Notch details mount fresh content before acknowledging a reveal size', () => {
  const dock = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const code = dock.slice(dock.indexOf('function renderBubble('), dock.indexOf('const notchRenderer ='));
  const order = [], card = { dataset: {}, style: {}, getBoundingClientRect: () => ({ height: 120 }) };
  const context = { root: { dataset: {} }, notchRenderer: {}, statCard: () => card,
    stagingLayer: { replaceChildren() {} }, fitCardTotal() {}, clampBreakdownList() {},
    commitCard: () => order.push('commit'), bridge: { reportBubbleSize: () => order.push('size') } };
  const render = vm.runInNewContext(`${code};renderBubble`, context);
  const payload = { cell: { id: 'stat:today', kind: 'stat' }, visible: true, maxCardHeight: 400 };
  render(payload);
  assert.deepEqual(order, ['commit', 'size'], 'fresh content is installed before main may make the retained window visible');
  order.length = 0; context.notchRenderer = null; render(payload);
  assert.deepEqual(order, ['size'], 'the ordinary EdgeDock placement handshake is unchanged');
});

test('transformed summary measurements ignore subpixel noise before rounding logical widths', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const start = source.includes('function notchLogicalPoint(') ? 'function notchLogicalPoint(' : 'function reportNotchSlots(';
  const code = source.slice(source.indexOf(start), source.indexOf('const notchProviderObserver'));
  const left = { width: 28, minimum: 28, children: [] }, right = { width: 27, minimum: 27 };
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

test('summary resizing during reveal preserves the existing motion deadline', (t) => {
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
  assert.equal(resized.duration, first.duration - 200, 'measurement must not restart a full 360ms reveal');
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

test('Notch stat rolls use matching identities and release replaced readings', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function settleNotchStatNumbers('), source.indexOf('function notchIcon('));
  const timers = new Map(), calls = [];
  let id = 0;
  const reading = (key, text, value) => ({ textContent: text, dataset: { rollKey: key, rollText: text, rollValue: String(value) }, scrollWidth: 30, clientWidth: 30 });
  const card = (...nodes) => ({ querySelectorAll: () => nodes, contains: node => nodes.includes(node) });
  const context = { notchStatRolls: new Map(),
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: key => timers.delete(key),
    numberAnimation: { duration: 800, capture: node => node.rolling ? ['live'] : null,
      beginRoll(node, from, to, increasing, _prepare, glyphs) {
        calls.push({ from, to, increasing, glyphs }); node.rolling = true;
        if (node.dataset) node.dataset.tokenNumberAnimation = 'roll';
        return () => { node.rolling = false; if (node.dataset) delete node.dataset.tokenNumberAnimation; node.textContent = to; };
      } }
  };
  vm.runInNewContext(code, context);
  const oldNode = reading('today:value', '100', 100);
  oldNode.dataset.rollText = '100,000';
  const old = card(oldNode);
  const nextNode = reading('today:value', '200', 200), next = card(nextNode);
  context.animateNotchStatNumbers(next, context.captureNotchStatNumbers(old));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, '100', 'static capture uses the fitted reading, not stale full-text metadata');
  const snapshot = context.captureNotchStatNumbers(next);
  assert.equal(nextNode.rolling, false);
  assert.equal(timers.size, 0, 'replacing a card cancels its timer and effect');
  context.animateNotchStatNumbers(card(reading('today:value', '150', 150)), snapshot);
  assert.equal(calls[1].increasing, false);
  assert.deepEqual(calls[1].glyphs, ['live']);
  context.animateNotchStatNumbers(card(reading('month:value', '150', 150), reading('today:value', '—', 0)), snapshot);
  assert.equal(calls.length, 2, 'unmatched identities and missing values do not roll');
  context.settleNotchStatNumbers();
  assert.equal(timers.size, 0);
  assert.equal(context.notchStatRolls.size, 0);
});


test('Notch visibility transitions settle summary motion without rebuilding its header', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function renderNotch('), source.indexOf('    let notchAnimation ='));
  let settles = 0;
  const payload = { expanded: false, summary: null, cells: [], appearance: {}, geometry: { gapWidth: 179, notched: true } };
  const context = { state: { appearanceKey: 'same' }, notchExpanded: false, notchClock: 0,
    notchHeaderKey: '', settleNotchNumbers: () => settles++, settleNotchStatNumbers() {},
    resetRefreshVisit() {}, paintRefreshButton() {}, root: { classList: { toggle() {} }, style: { setProperty() {} } },
    runningSessionSummary() {}, contentLayer: { querySelector: () => null, prepend() {} },
    captureRingResetMotion() {}, notchSummary: () => ({ style: {} }), animateRingResets() {},
    notchSummaryObserver: { disconnect() {}, observe() {} }, renderNotchRows() {}, applyNotchMotion() {}, reportNotchContentSize() {} };
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
    settleNotchNumbers() {}, settleNotchStatNumbers() {}, resetRefreshVisit() {}, paintRefreshButton() {},
    root: { classList: { toggle() {} }, style: { setProperty() {} } },
    contentLayer: { querySelector: () => head, prepend: node => { head = node; } },
    captureRingResetMotion() {}, animateRingResets() {},
    notchSummary: () => ({ style: {}, waiting: waiting(), text: payload.summary.items[1].text,
      remove() {}, querySelectorAll: () => [] }),
    notchSummaryObserver: { disconnect() {}, observe() {} }, positionNotchSummary() {}, reportNotchSlots() {},
    animateNotchNumbers() {}, renderNotchRows() {}, applyNotchMotion() {}, reportNotchContentSize() {} };
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

test('camera-free notch avoidance uses one centered budget and hides an empty resting shell', (t) => {
  let reads = 0, menuX = 900;
  const f = fixture(t, { notchShape: 'notch' }, {
    readScreens: () => ({ screens: [], mainDisplayId: 1 }),
    readMenuWindows: () => { reads++; return [{ id: 7, x: menuX, y: 0, width: 40, height: 32 }]; }
  });
  f.controller.setData(buildNotchData(stats(), [], { trayContent: 'tokens' }));
  const win = f.windows[0];
  assert.equal(last(win).geometry.summaryBudget, 290);
  assert.equal(reads, 1);
  f.preferences.notchAvoidMenuBar = false;
  f.controller.sync();
  assert.ok(last(win).geometry.summaryBudget > 1400);
  assert.equal(reads, 1, 'turning avoidance off stops native sampling');
  f.preferences.notchAvoidMenuBar = true;
  f.controller.sync();
  menuX = display.bounds.width / 2;
  f.screen.emit('display-metrics-changed');
  assert.equal(last(win).geometry.headerWidth, 0);
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


test('menu width limits the resting outline before minimum size and parity', () => {
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
  assert.deepEqual(f.controller.getCapabilities(), { rings: false, menuAvoidance: true });
  f.controller.sync();
  f.controller.poll(Date.now() + 1000);
  assert.equal(updates.length, 1, 'unchanged geometry does not repeat the settings notification');
  f.preferences.notchShape = 'pill';
  f.controller.sync();
  assert.deepEqual(f.controller.getCapabilities(), { rings: true, menuAvoidance: false });
  assert.equal(updates.length, 2);
  assert.equal(f.preferences.notchRunningIndicatorEnabled, true);
});
