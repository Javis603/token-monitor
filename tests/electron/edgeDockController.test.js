'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createEdgeDockController } = require('../../src/electron/edgeDock/controller');
const { EDGE_DOCK_METRICS, edgeDockBubbleBounds } = require('../../src/electron/edgeDock/geometry');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
  }

  send(channel, payload) {
    this.messages.push({ channel, payload });
  }

  setWindowOpenHandler() {}
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  static zOrder = [];

  static atPoint(point) {
    return this.zOrder.findLast((win) => !win.destroyed && win.visible && !win.ignoreMouse
      && point.x >= win.bounds.x && point.x < win.bounds.x + win.bounds.width
      && point.y >= win.bounds.y && point.y < win.bounds.y + win.bounds.height);
  }

  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
    this.opacity = 1;
    this.visible = false;
    this.destroyed = false;
    this.shapeCalls = [];
    this.backgroundMaterials = [];
    this.vibrancyCalls = [];
    this.hasShadowCalls = [];
    this.zOrderCalls = [];
    FakeBrowserWindow.instances.push(this);
  }

  loadFile(_file, options) {
    this.surface = options.query.surface;
    return Promise.resolve();
  }

  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  getOpacity() { return this.opacity; }
  getBounds() { return { ...this.bounds }; }
  setOpacity(value) { this.opacity = value; }
  setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
  showInactive() { this.visible = true; this.zOrderCalls.push('showInactive'); this.orderFront(); }
  moveTop() { this.zOrderCalls.push('moveTop'); this.orderFront(); }
  orderFront() {
    FakeBrowserWindow.zOrder = FakeBrowserWindow.zOrder.filter((win) => win !== this);
    FakeBrowserWindow.zOrder.push(this);
  }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  setAlwaysOnTop(flag, level) { this.zOrderCalls.push(['setAlwaysOnTop', flag, level]); }
  setVisibleOnAllWorkspaces() {}
  setHiddenInMissionControl() {}
  setShape(rects) { this.shapeCalls.push(rects); }
  setBackgroundMaterial(material) { this.backgroundMaterials.push(material); }
  setVibrancy(value) { this.vibrancyCalls.push(value); }
  setHasShadow(value) { this.hasShadowCalls.push(value); }
  destroy() { this.destroyed = true; }
}

class FakeIpcMain extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
  }

  handle(channel, handler) { this.handlers.set(channel, handler); }
  removeHandler(channel) { this.handlers.delete(channel); }
}

class FakeScreen extends EventEmitter {
  constructor(displays) {
    super();
    this.displays = displays;
    this.point = { x: displays[0].workArea.x, y: displays[0].workArea.y };
  }

  getPrimaryDisplay() { return this.displays[0]; }
  getAllDisplays() { return this.displays; }
  getCursorScreenPoint() { return this.point; }
  getDisplayNearestPoint(point) {
    return this.displays.find((display) => (
      point.x >= display.bounds.x
      && point.x < display.bounds.x + display.bounds.width
      && point.y >= display.bounds.y
      && point.y < display.bounds.y + display.bounds.height
    )) || this.displays[0];
  }
}

function sentPayload(win, surface) {
  return win.webContents.messages.filter((message) => (
    message.channel === 'edgeDock:render' && message.payload.surface === surface
  )).at(-1)?.payload;
}

function createFixture(options = {}) {
  FakeBrowserWindow.instances = [];
  FakeBrowserWindow.zOrder = [];
  const settings = {
    edgeDockEnabled: true,
    edgeDockRefreshEnabled: true,
    edgeDockMode: 'always',
    edgeDockSide: 'right',
    edgeDockOffset: 0.3,
    edgeDockDisplayId: '1',
    windowsBackdrop: 'acrylic',
    ...(options.settings || {})
  };
  const displays = options.displays || [{
    id: 1,
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1200, height: 900 },
    workArea: { x: 0, y: 0, width: 1200, height: 860 }
  }];
  const screen = new FakeScreen(displays);
  const ipcMain = new FakeIpcMain();
  const placements = [];
  const maskWindows = [];
  const haptics = [];
  const hapticCalls = [];
  const controller = createEdgeDockController({
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    screen,
    platform: options.platform || 'win32',
    rendererDir: '/renderer',
    preloadPath: '/preload.js',
    getSettings: () => settings,
    nativeGlass: () => options.nativeGlass === true,
    liquidGlass: () => (typeof options.liquidGlass === 'function' ? options.liquidGlass() : options.liquidGlass || null),
    createGlass: options.createGlass,
    canRefreshLimits: options.canRefreshLimits,
    onRefreshLimits: options.onRefreshLimits,
    prefersReducedMotion: () => true,
    isFullScreen: options.isFullScreen,
    applyShapeMask: (win) => {
      maskWindows.push(win);
      return options.maskAvailable !== false;
    },
    performHaptic: (pattern, performanceTime) => {
      haptics.push(pattern);
      hapticCalls.push({ pattern, performanceTime });
    },
    onPlacementChange: (placement) => {
      placements.push(placement);
      settings.edgeDockSide = placement.side;
      settings.edgeDockOffset = placement.offset;
      settings.edgeDockDisplayId = placement.displayId;
    }
  });
  controller.setCells([
    { id: 'claude', kind: 'provider', label: 'Claude' },
    { id: 'codex', kind: 'provider', label: 'Codex', remainingPercent: 70 },
    { id: 'cursor', kind: 'provider', label: 'Cursor' }
  ]);
  controller.sync();
  for (const win of FakeBrowserWindow.instances) win.webContents.emit('did-finish-load');
  const windowFor = (surface) => FakeBrowserWindow.instances.filter((win) => !win.destroyed && win.surface === surface).at(-1);
  const paintPeek = () => {
    const win = windowFor('peek');
    const payload = sentPayload(win, 'peek');
    ipcMain.emit('edgeDock:peekPainted', { sender: win.webContents }, { mode: payload.peekMode, shapeKey: payload.shape?.key });
  };
  return { controller, hapticCalls, haptics, ipcMain, maskWindows, placements, screen, settings, windowFor, paintPeek };
}

test('Windows Edge Dock reasserts topmost after each surface is first shown and rebuilt', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.controller.stop());
  const surfaces = ['peek', 'rail', 'bubble'];
  const expected = ['showInactive', ['setAlwaysOnTop', true, 'pop-up-menu']];

  for (const surface of surfaces) {
    const win = fixture.windowFor(surface);
    assert.equal(win.options.alwaysOnTop, true);
    assert.deepEqual(win.zOrderCalls, expected, `${surface} reasserts topmost after showing`);
  }

  fixture.controller.sync();
  for (const surface of surfaces) {
    assert.deepEqual(fixture.windowFor(surface).zOrderCalls, expected, `${surface} is not repeatedly raised`);
  }

  fixture.controller.stop();
  fixture.controller.sync();
  for (const win of FakeBrowserWindow.instances.filter((win) => !win.destroyed)) {
    win.webContents.emit('did-finish-load');
  }
  for (const surface of surfaces) {
    assert.deepEqual(fixture.windowFor(surface).zOrderCalls, expected, `${surface} reasserts topmost after rebuild`);
  }
});

test('auto-hide haptics distinguish the handle reveal from the first hovered item', async (t) => {
  const fixture = createFixture({ platform: 'darwin', settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const rail = fixture.windowFor('rail');

  fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
  fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
  assert.deepEqual(fixture.haptics, ['generic']);

  fixture.screen.point = {
    x: rail.bounds.x + rail.bounds.width / 2,
    y: rail.bounds.y + 40
  };
  await new Promise((resolve) => setTimeout(resolve, 105));
  assert.deepEqual(fixture.haptics, ['generic', 'alignment']);
  assert.deepEqual(fixture.hapticCalls, [
    { pattern: 'generic', performanceTime: 'default' },
    { pattern: 'alignment', performanceTime: 'now' }
  ]);

  const disabled = createFixture({
    platform: 'darwin',
    settings: { edgeDockMode: 'autoHide', edgeDockHaptic: false }
  });
  t.after(() => disabled.controller.stop());
  disabled.ipcMain.emit('edgeDock:click', { sender: disabled.windowFor('peek').webContents });
  assert.deepEqual(disabled.haptics, []);
});

test('rail haptics once whenever the pointer enters an item', async (t) => {
  const fixture = createFixture({ platform: 'darwin' });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const centerX = rail.bounds.x + rail.bounds.width / 2;

  fixture.screen.point = { x: centerX, y: rail.bounds.y + 40 };
  await new Promise((resolve) => setTimeout(resolve, 105));
  assert.deepEqual(fixture.haptics, ['alignment']);
  assert.deepEqual(fixture.hapticCalls, [{ pattern: 'alignment', performanceTime: 'now' }]);

  fixture.screen.point = { x: centerX, y: rail.bounds.y + 112 };
  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.deepEqual(fixture.haptics, ['alignment', 'alignment']);

  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.deepEqual(fixture.haptics, ['alignment', 'alignment']);

  fixture.screen.point = { x: rail.bounds.x - 20, y: rail.bounds.y + 40 };
  await new Promise((resolve) => setTimeout(resolve, 55));
  fixture.screen.point = { x: centerX, y: rail.bounds.y + 40 };
  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.deepEqual(fixture.haptics, ['alignment', 'alignment', 'alignment']);
});

test('structural updates only haptic when the item under the pointer changes', async (t) => {
  const fixture = createFixture({ platform: 'darwin' });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  fixture.screen.point = {
    x: rail.bounds.x + rail.bounds.width / 2,
    y: rail.bounds.y + 40
  };

  await new Promise((resolve) => setTimeout(resolve, 105));
  assert.deepEqual(fixture.haptics, ['alignment']);

  fixture.controller.setCells([
    { id: 'claude', kind: 'provider', label: 'Claude' },
    { id: 'codex', kind: 'provider', label: 'Codex', remainingPercent: 70 },
    { id: 'windsurf', kind: 'provider', label: 'Windsurf' }
  ]);
  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.deepEqual(fixture.haptics, ['alignment']);

  fixture.controller.setCells([
    { id: 'gemini', kind: 'provider', label: 'Gemini' },
    { id: 'codex', kind: 'provider', label: 'Codex', remainingPercent: 70 },
    { id: 'windsurf', kind: 'provider', label: 'Windsurf' }
  ]);
  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.deepEqual(fixture.haptics, ['alignment', 'alignment']);
});

test('an open card follows its cell id across removal and reorder', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const bubble = fixture.windowFor('bubble');

  fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 1 });
  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 180 });
  fixture.controller.setCells([
    { id: 'codex', kind: 'provider', label: 'Codex', remainingPercent: 70 },
    { id: 'cursor', kind: 'provider', label: 'Cursor' }
  ]);

  assert.equal(sentPayload(bubble, 'bubble').cell.id, 'codex');
  assert.equal(sentPayload(rail, 'rail').focusCellId, 'codex');
  const reordered = edgeDockBubbleBounds({
    railBounds: rail.bounds,
    cellIndex: 0,
    height: 180,
    workArea: fixture.screen.displays[0].workArea,
    side: 'right'
  });
  assert.equal(bubble.bounds.y, reordered.y);

  fixture.settings.edgeDockSide = 'left';
  fixture.controller.sync();
  const moved = edgeDockBubbleBounds({
    railBounds: rail.bounds,
    cellIndex: 0,
    height: 180,
    workArea: fixture.screen.displays[0].workArea,
    side: 'left'
  });
  assert.equal(bubble.bounds.x, moved.x);
  assert.ok(bubble.bounds.x > rail.bounds.x);

  fixture.controller.setCells([{ id: 'cursor', kind: 'provider', label: 'Cursor' }]);
  assert.equal(sentPayload(rail, 'rail').focusCellId, null);
  assert.equal(bubble.opacity, 0);
  assert.equal(bubble.ignoreMouse, true);
});

test('updated content keeps an open card visible while its replacement is measured', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const bubble = fixture.windowFor('bubble');

  fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 1 });
  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 180 });
  fixture.controller.setCells([
    { id: 'claude', kind: 'provider', label: 'Claude' },
    { id: 'codex', kind: 'provider', label: 'Codex', remainingPercent: 35 },
    { id: 'cursor', kind: 'provider', label: 'Cursor' }
  ]);

  assert.deepEqual(sentPayload(bubble, 'bubble').placed, { cellId: 'codex', height: 180 });
  assert.equal(bubble.opacity, 1);
  assert.equal(bubble.ignoreMouse, false);

  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 220 });
  assert.deepEqual(sentPayload(bubble, 'bubble').placed, { cellId: 'codex', height: 220 });
  assert.equal(bubble.bounds.height, 220);
  assert.equal(bubble.opacity, 1);
});

test('dragging onto another display moves the dock there and persists its id', async (t) => {
  const displays = [
    { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1000, height: 900 }, workArea: { x: 0, y: 0, width: 1000, height: 860 } },
    { id: 2, scaleFactor: 1.5, bounds: { x: 1000, y: 0, width: 800, height: 900 }, workArea: { x: 1000, y: 0, width: 800, height: 860 } }
  ];
  const fixture = createFixture({ displays });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  fixture.screen.point = { x: 1700, y: 420 };

  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetY: 30 });
  await new Promise((resolve) => setTimeout(resolve, 35));
  fixture.ipcMain.emit('edgeDock:dragEnd', { sender: rail.webContents });

  assert.equal(rail.bounds.x, 1800 - 64);
  assert.equal(fixture.placements.at(-1).displayId, '2');
  assert.equal(fixture.placements.at(-1).side, 'right');
});

test('Windows Edge Dock keeps every glass setting on the shaped renderer surface', (t) => {
  const fixture = createFixture({ nativeGlass: true });
  t.after(() => fixture.controller.stop());
  const acrylicWindows = FakeBrowserWindow.instances.slice();
  assert.equal(acrylicWindows.length, 3);
  assert.ok(acrylicWindows.every((win) => win.options.transparent === true));
  assert.ok(acrylicWindows.every((win) => win.options.backgroundMaterial === undefined));
  assert.ok(acrylicWindows.filter((win) => win.surface !== 'bubble').every((win) => win.shapeCalls.at(-1)?.length > 0));
  assert.equal(sentPayload(fixture.windowFor('rail'), 'rail').glass, false);

  fixture.settings.windowsBackdrop = 'accent';
  fixture.controller.sync();
  const accentWindows = FakeBrowserWindow.instances.filter((win) => !win.destroyed);
  assert.equal(accentWindows.length, 3);
  assert.deepEqual(accentWindows, acrylicWindows);
  assert.ok(accentWindows.every((win) => win.options.transparent === true));
  assert.ok(accentWindows.every((win) => win.options.backgroundMaterial === undefined));
});

test('Windows keeps shaped click-through regions without native glass', (t) => {
  const plain = createFixture({ nativeGlass: false });
  t.after(() => plain.controller.stop());
  assert.equal(sentPayload(plain.windowFor('rail'), 'rail').glass, false);
  assert.ok(['peek', 'rail'].every((surface) => plain.windowFor(surface).shapeCalls.at(-1)?.length > 0));
});

test('macOS drops rectangular vibrancy when a surface mask cannot be applied', (t) => {
  const fixture = createFixture({ platform: 'darwin', nativeGlass: true, maskAvailable: false });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const attemptedMasks = fixture.maskWindows.length;

  assert.ok(attemptedMasks > 0);
  assert.equal(sentPayload(rail, 'rail').glass, false);
  assert.deepEqual(rail.vibrancyCalls, [null]);
  assert.deepEqual(rail.hasShadowCalls, [false]);

  fixture.controller.sync();
  assert.equal(fixture.maskWindows.length, attemptedMasks, 'the no-material fallback remains stable for this window');
});

function fakeGlassFactory({ failCreate = false, failShape = false } = {}) {
  const glasses = [];
  const create = (win) => {
    if (failCreate) throw new Error('NSGlassEffectView unavailable');
    const glass = { win, updates: [], disposed: null };
    glass.update = (update) => {
      if (update.shape && failShape) throw new Error('shape rejected');
      glass.updates.push(update);
    };
    glass.dispose = (options = {}) => { glass.disposed = options; };
    glasses.push(glass);
    return glass;
  };
  return { create, glasses };
}

test('macOS Liquid Glass shapes the rail and card while the peek keeps its masked HUD grip', (t) => {
  const factory = fakeGlassFactory();
  const fixture = createFixture({ platform: 'darwin', nativeGlass: true, liquidGlass: { dark: true }, createGlass: factory.create });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');

  assert.equal(FakeBrowserWindow.instances.length, 3);
  const peek = fixture.windowFor('peek');
  assert.equal(peek.options.vibrancy, 'hud');
  assert.ok(fixture.maskWindows.includes(peek));
  assert.equal(sentPayload(peek, 'peek').liquidGlass, false);
  assert.ok(['rail', 'bubble'].every((surface) => fixture.windowFor(surface).options.vibrancy === undefined));
  assert.equal(factory.glasses.length, 2);
  assert.equal(fixture.maskWindows.length, 1);
  const shaped = factory.glasses.find((glass) => glass.win === rail).updates.find((update) => update.shape);
  assert.equal(shaped.dark, true);
  assert.equal(shaped.shape.height, rail.bounds.height);
  assert.equal(shaped.shape.commands[0][0], 'M');
  const payload = sentPayload(rail, 'rail');
  assert.equal(payload.glass, true);
  assert.equal(payload.liquidGlass, true);
});

test('macOS falls back to the masked HUD material when Liquid Glass cannot be built or shaped', (t) => {
  for (const failure of [{ failCreate: true }, { failShape: true }]) {
    const factory = fakeGlassFactory(failure);
    const fixture = createFixture({ platform: 'darwin', nativeGlass: true, liquidGlass: { dark: false }, createGlass: factory.create });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');

    assert.deepEqual(rail.vibrancyCalls, ['hud'], JSON.stringify(failure));
    assert.equal(rail.options.visualEffectState, 'active');
    assert.ok(fixture.maskWindows.includes(rail));
    assert.ok(factory.glasses.filter((glass) => glass.win === rail).every((glass) => glass.disposed !== null));
    const payload = sentPayload(rail, 'rail');
    assert.equal(payload.glass, true);
    assert.equal(payload.liquidGlass, false);
  }
});

test('switching the glass style rebuilds the dock and releases its Liquid Glass', (t) => {
  const factory = fakeGlassFactory();
  let wanted = { dark: true };
  const fixture = createFixture({ platform: 'darwin', nativeGlass: true, liquidGlass: () => wanted, createGlass: factory.create });
  t.after(() => fixture.controller.stop());
  const first = fixture.windowFor('rail');

  wanted = null;
  fixture.controller.sync();
  const rebuilt = fixture.windowFor('rail');
  assert.notEqual(rebuilt, first);
  assert.equal(rebuilt.options.vibrancy, 'hud');
  assert.equal(factory.glasses.length, 2);
  assert.ok(factory.glasses.every((glass) => glass.disposed?.windowClosed !== true));
  assert.ok(factory.glasses.every((glass) => glass.disposed !== null));
});

// The rail's entrance is keyed to the reveal rather than to the push, so the page
// has to be able to tell which payload is the reveal: without that it has neither
// a transition to fire on nor a way to keep a stats update from replaying the
// slide. It is a count rather than a flag because only the reveal renders - the
// retract fades the window out with no payload at all, so a page told the state
// alone keeps believing the rail is up and reads the next reveal as no change,
// which is what left the entrance playing once per page load.
test('a rail payload carries the reveal that keys the entrance', (t) => {
  const fixture = createFixture({ settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const peek = fixture.windowFor('peek');

  assert.equal(sentPayload(rail, 'rail').reveal, 0);
  assert.equal(rail.opacity, 0);

  fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents }, {});
  assert.equal(sentPayload(rail, 'rail').reveal, 1);
  assert.equal(rail.opacity, 1);

  // Every push after it repaints the same surface and keeps saying the same count -
  // the edge is the renderer's to hold, and this is what it must not re-fire on.
  fixture.controller.setCells([{ id: 'cursor', kind: 'provider', label: 'Cursor' }]);
  assert.equal(sentPayload(rail, 'rail').reveal, 1);

  // Leaving always-visible mode retracts the rail, and a retract renders nothing:
  // the window goes dark while the page is still holding the payload that said 1 -
  // as do the pushes the mode flip itself triggers, which repaint the rail without
  // ever reporting that it went away.
  fixture.settings.edgeDockMode = 'always';
  fixture.controller.sync();
  fixture.settings.edgeDockMode = 'autoHide';
  fixture.controller.sync();
  assert.equal(rail.opacity, 0, 'the retract takes the rail away');
  assert.equal(sentPayload(rail, 'rail').reveal, 1, 'nothing tells the page the rail went away');

  // So the count is the only thing that can tell the page this is a new entrance.
  fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents }, {});
  assert.equal(sentPayload(rail, 'rail').reveal, 2);
  assert.equal(rail.opacity, 1);
});

// The handle's exit is played by the page, so the peek payload has to carry the
// handle's own visibility the way the rail's carries its reveal. It is also what
// used to put the handle back on top of an open rail: a settings push ran showPeek
// whatever the rail was doing, and the handle faded in over the cells.
test('a peek payload carries the handle, and an open rail keeps it away', (t) => {
  const fixture = createFixture({ settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');

  assert.equal(sentPayload(peek, 'peek').peeking, true);
  assert.equal(peek.ignoreMouse, false);

  fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents }, {});
  assert.equal(sentPayload(peek, 'peek').peeking, false);
  assert.equal(peek.ignoreMouse, true);

  // Every push after it repaints the same surface and keeps saying the handle is
  // away - the page plays the exit on the transition alone.
  fixture.controller.sync();
  assert.equal(sentPayload(peek, 'peek').peeking, false);
  assert.equal(peek.ignoreMouse, true);

  // Always-visible mode has nothing to hide behind a handle, and leaving it again
  // is what brings the handle back.
  fixture.settings.edgeDockMode = 'always';
  fixture.controller.sync();
  assert.equal(sentPayload(peek, 'peek').peeking, false);

  fixture.settings.edgeDockMode = 'autoHide';
  fixture.controller.sync();
  assert.equal(sentPayload(peek, 'peek').peeking, true);
  assert.equal(peek.ignoreMouse, false);
});

test('always-except-full-screen keeps the rail up on the desktop and auto-hides over a full-screen app', async (t) => {
  let fullScreen = false;
  const probed = [];
  const fixture = createFixture({
    settings: { edgeDockMode: 'alwaysExceptFullScreen' },
    isFullScreen: (display) => {
      probed.push(display);
      return fullScreen;
    }
  });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const peek = fixture.windowFor('peek');
  assert.equal(probed[0], fixture.screen.displays[0], 'the probe is asked about the dock display');
  assert.equal(rail.opacity, 1);
  assert.equal(sentPayload(rail, 'rail').always, true);
  assert.equal(sentPayload(peek, 'peek').peeking, false);

  // The pointer is away from the edge; the poll alone notices the full-screen app.
  fixture.screen.point = { x: 10, y: 10 };
  fullScreen = true;
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(rail.opacity, 0, 'a full-screen app retracts the rail');
  assert.equal(sentPayload(rail, 'rail').always, false);
  assert.equal(sentPayload(peek, 'peek').peeking, true);

  fullScreen = false;
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(rail.opacity, 1, 'back on the desktop the rail returns');
  assert.equal(sentPayload(rail, 'rail').always, true);
  assert.equal(sentPayload(peek, 'peek').peeking, false);
});

test('a display change re-checks full screen for the display the dock lands on', (t) => {
  const primary = {
    id: 1,
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1200, height: 900 },
    workArea: { x: 0, y: 0, width: 1200, height: 860 }
  };
  const secondary = {
    id: 2,
    scaleFactor: 1,
    bounds: { x: 1200, y: 0, width: 1600, height: 1000 },
    workArea: { x: 1200, y: 0, width: 1600, height: 960 }
  };
  const fixture = createFixture({
    displays: [primary, secondary],
    settings: { edgeDockMode: 'alwaysExceptFullScreen', edgeDockDisplayId: '2' },
    // Only the primary display has a full-screen app.
    isFullScreen: (display) => display.id === 1
  });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const peek = fixture.windowFor('peek');
  assert.equal(rail.opacity, 1, 'the dock display is on its desktop');

  // Unplugging the dock's display moves it to the primary, and the primary's
  // full-screen app applies at once rather than on the next poll.
  fixture.screen.displays.splice(1, 1);
  fixture.screen.emit('display-removed');
  assert.equal(rail.opacity, 0);
  assert.equal(sentPayload(rail, 'rail').always, false);
  assert.equal(sentPayload(peek, 'peek').peeking, true);
});

test('only the full-screen mode probes for full-screen apps', async (t) => {
  let probes = 0;
  const fixture = createFixture({
    settings: { edgeDockMode: 'always' },
    isFullScreen: () => {
      probes += 1;
      return true;
    }
  });
  t.after(() => fixture.controller.stop());
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(probes, 0);
  assert.equal(fixture.windowFor('rail').opacity, 1, 'plain always-visible ignores full-screen apps');

  fixture.settings.edgeDockMode = 'alwaysExceptFullScreen';
  fixture.controller.sync();
  assert.equal(probes, 1, 'switching into the mode checks straight away');
  assert.equal(fixture.windowFor('rail').opacity, 0);
});

test('display metric changes hide and remeasure an open card against the new work area', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const bubble = fixture.windowFor('bubble');
  fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 1 });
  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 400 });

  fixture.screen.displays[0].workArea.height = 300;
  fixture.screen.emit('display-metrics-changed');
  assert.equal(bubble.opacity, 0);
  assert.equal(bubble.ignoreMouse, true);
  assert.equal(sentPayload(bubble, 'bubble').placed, null);

  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 400 });
  assert.equal(bubble.bounds.height, 300 - EDGE_DOCK_METRICS.screenMargin * 2);
  assert.equal(bubble.opacity, 1);
});

test('refresh reuses the peek and retains one Liquid Glass view across role changes', async (t) => {
  const factory = fakeGlassFactory();
  let enabled = true;
  let calls = 0;
  let finish;
  const fixture = createFixture({ platform: 'darwin', nativeGlass: true,
    liquidGlass: { dark: true }, createGlass: factory.create,
    settings: { edgeDockMode: 'autoHide' }, canRefreshLimits: () => enabled,
    onRefreshLimits: () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); }
  });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const rail = fixture.windowFor('rail');
  const originalRail = { ...rail.bounds };
  const handler = fixture.ipcMain.handlers.get('edgeDock:refreshLimits');
  assert.equal((await handler({ sender: peek.webContents })).ok, false);
  fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
  assert.equal(sentPayload(peek, 'peek').peekMode, 'refresh');
  assert.equal(peek.ignoreMouse, true, 'old handle frame stays hidden until the new paint');
  assert.equal((await handler({ sender: peek.webContents })).ok, false);
  fixture.paintPeek();
  assert.equal(peek.ignoreMouse, false);
  assert.equal(sentPayload(peek, 'peek').liquidGlass, true);
  assert.equal(peek.bounds.width, EDGE_DOCK_METRICS.refreshSize);
  assert.deepEqual(rail.bounds, originalRail);
  assert.equal(FakeBrowserWindow.instances.length, 3);
  assert.equal((await handler({ sender: rail.webContents })).ok, false);
  const first = handler({ sender: peek.webContents });
  const duplicate = handler({ sender: peek.webContents });
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ ok: true });
  assert.equal((await first).ok, true);
  assert.equal((await duplicate).ok, true);
  const glass = factory.glasses.find((entry) => entry.win === peek);
  fixture.screen.point = { x: peek.bounds.x + 16, y: rail.bounds.y + rail.bounds.height + 2 };
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(sentPayload(peek, 'peek').peekMode, 'refresh', 'crossing the gap keeps the rail open');
  fixture.screen.point = { x: 100, y: 100 };
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(sentPayload(peek, 'peek').peekMode, 'handle');
  assert.equal(sentPayload(peek, 'peek').liquidGlass, false);
  assert.equal(peek.bounds.width, EDGE_DOCK_METRICS.peekWidth);
  assert.equal(glass.updates.at(-1).visible, false);
  fixture.controller.setAppearance({ language: 'zh-TW' });
  assert.equal(glass.updates.at(-1).visible, false);
  fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
  assert.equal(factory.glasses.filter((entry) => entry.win === peek).length, 1);
  enabled = false;
  fixture.controller.sync();
  assert.equal(peek.ignoreMouse, true);
  assert.equal((await handler({ sender: peek.webContents })).ok, false);
});

test('always-visible refresh appears on hover, stays over the button and hides during a drag', async (t) => {
  const fixture = createFixture({ canRefreshLimits: () => true, onRefreshLimits: async () => ({ ok: true }) });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const peek = fixture.windowFor('peek');
  assert.equal(peek.ignoreMouse, true);
  fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 20 };
  await new Promise((resolve) => setTimeout(resolve, 105));
  fixture.paintPeek();
  assert.equal(peek.ignoreMouse, false);
  fixture.screen.point = { x: peek.bounds.x + 16, y: peek.bounds.y + 16 };
  await new Promise((resolve) => setTimeout(resolve, 105));
  assert.equal(peek.ignoreMouse, false);
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetY: 20 });
  assert.equal(peek.ignoreMouse, true);
  fixture.ipcMain.emit('edgeDock:dragEnd', { sender: rail.webContents });
  fixture.screen.point = { x: 100, y: 100 };
  await new Promise((resolve) => setTimeout(resolve, 105));
  assert.equal(peek.ignoreMouse, true);
  assert.equal(rail.ignoreMouse, false);
});

test('refresh is raised above the rail shoulder after paint and on each hover reveal', async (t) => {
  const fixture = createFixture({ platform: 'darwin', canRefreshLimits: () => true });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const peek = fixture.windowFor('peek');
  const raises = () => peek.zOrderCalls.filter((call) => call === 'moveTop').length;
  assert.equal(raises(), 0);
  fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 20 };
  await new Promise((resolve) => setTimeout(resolve, 105));
  assert.equal(raises(), 0, 'the old handle frame stays hidden');
  fixture.paintPeek();
  assert.equal(raises(), 1);
  assert.ok(peek.bounds.y < rail.bounds.y + rail.bounds.height, 'circle nests into the native rail rectangle');
  const edge = { x: peek.bounds.x + 16, y: peek.bounds.y + 3 };
  assert.equal(FakeBrowserWindow.atPoint(edge), peek, 'the circular edge receives input ahead of the rail');
  await new Promise((resolve) => setTimeout(resolve, 105));
  assert.equal(raises(), 1, 'steady hover does not repeatedly reorder windows');
  fixture.screen.point = { x: 100, y: 100 };
  await new Promise((resolve) => setTimeout(resolve, 105));
  fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 20 };
  await new Promise((resolve) => setTimeout(resolve, 105));
  assert.equal(raises(), 2, 'reused refresh mode is raised again after being hidden');
});

test('a rail that finishes loading last leaves the painted refresh above its shoulder', (t) => {
  const fixture = createFixture({ platform: 'darwin', settings: { edgeDockMode: 'autoHide' }, canRefreshLimits: () => true });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const rail = fixture.windowFor('rail');
  fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
  fixture.paintPeek();
  const before = peek.zOrderCalls.filter((call) => call === 'moveTop').length;
  // Native first-show ordering is reapplied when a newly loaded rail reveals.
  rail.visible = false;
  rail.webContents.emit('did-finish-load');
  assert.equal(peek.zOrderCalls.filter((call) => call === 'moveTop').length, before + 1);
  assert.equal(FakeBrowserWindow.atPoint({ x: peek.bounds.x + 16, y: peek.bounds.y + 3 }), peek);
  assert.equal(peek.ignoreMouse, false);
});

for (const side of ['left', 'right']) {
  test(`${side} full-height rail dismisses its bottom card when the pointer reaches refresh`, async (t) => {
    const fixture = createFixture({
      settings: { edgeDockSide: side },
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1200, height: 700 }, workArea: { x: 0, y: 0, width: 1200, height: 700 } }],
      canRefreshLimits: () => true,
      onRefreshLimits: async () => ({ ok: true })
    });
    t.after(() => fixture.controller.stop());
    fixture.controller.setCells(Array.from({ length: 12 }, (_, index) => ({ id: `provider-${index}`, kind: 'provider', label: `Provider ${index}` })));
    const rail = fixture.windowFor('rail');
    const bubble = fixture.windowFor('bubble');
    const peek = fixture.windowFor('peek');
    fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 20 };
    await new Promise((resolve) => setTimeout(resolve, 105));
    fixture.paintPeek();
    fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 11 });
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'provider-11', height: 180 });
    assert.equal(bubble.ignoreMouse, false);
    assert.ok(peek.bounds.x < bubble.bounds.x + bubble.bounds.width && peek.bounds.x + peek.bounds.width > bubble.bounds.x
      && peek.bounds.y < bubble.bounds.y + bubble.bounds.height && peek.bounds.y + peek.bounds.height > bubble.bounds.y,
    'fixture reproduces the button/card overlap');
    fixture.screen.point = { x: peek.bounds.x + 16, y: peek.bounds.y + 16 };
    await new Promise((resolve) => setTimeout(resolve, 105));
    assert.equal(bubble.ignoreMouse, true);
    assert.equal(bubble.opacity, 0);
    assert.equal(sentPayload(rail, 'rail').focusCellId, null);
    assert.equal(peek.ignoreMouse, false);
    assert.equal(peek.opacity, 1);
    const handler = fixture.ipcMain.handlers.get('edgeDock:refreshLimits');
    assert.deepEqual(await handler({ sender: peek.webContents }), { ok: true });
    // Returning to the same bottom cell must reopen its card through hover.
    fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + rail.bounds.height - 35 };
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(sentPayload(rail, 'rail').focusCellId, 'provider-11');
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'provider-11', height: 180 });
    assert.equal(bubble.ignoreMouse, false);
  });
}

test('refresh follows the rail fallback when shaped Liquid Glass fails', (t) => {
  const factory = fakeGlassFactory({ failShape: true });
  const fixture = createFixture({ platform: 'darwin', nativeGlass: true,
    liquidGlass: { dark: false }, createGlass: factory.create,
    settings: { edgeDockMode: 'autoHide' }, canRefreshLimits: () => true });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
  assert.equal(sentPayload(peek, 'peek').peekMode, 'refresh');
  assert.equal(sentPayload(peek, 'peek').liquidGlass, false);
  assert.equal(sentPayload(peek, 'peek').glass, true);
  assert.ok(fixture.maskWindows.includes(peek));
  assert.equal(peek.vibrancyCalls.at(-1), 'hud');
});

for (const mode of ['always', 'autoHide']) {
  test(`${mode} refresh is opt-in and removing it rejects stale refresh requests`, async (t) => {
    let calls = 0;
    const fixture = createFixture({
      settings: { edgeDockMode: mode, edgeDockRefreshEnabled: undefined },
      canRefreshLimits: () => true,
      onRefreshLimits: async () => { calls += 1; return { ok: true }; }
    });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    const peek = fixture.windowFor('peek');
    const handler = fixture.ipcMain.handlers.get('edgeDock:refreshLimits');
    if (mode === 'autoHide') fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
    fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 20 };
    await new Promise((resolve) => setTimeout(resolve, 105));
    assert.equal(peek.ignoreMouse, true, 'older settings without the preference keep refresh off');
    assert.equal((await handler({ sender: peek.webContents })).ok, false);
    fixture.settings.edgeDockRefreshEnabled = true;
    fixture.controller.sync();
    fixture.paintPeek();
    assert.equal(peek.ignoreMouse, false);
    assert.deepEqual(await handler({ sender: peek.webContents }), { ok: true });
    fixture.settings.edgeDockRefreshEnabled = false;
    // A settings change invalidates IPC even before the visibility sync.
    assert.equal((await handler({ sender: peek.webContents })).ok, false);
    fixture.controller.sync();
    assert.equal(peek.ignoreMouse, true);
    assert.equal(calls, 1);
    assert.equal(rail.ignoreMouse, false, 'removing refresh leaves the rail available');
  });
}

for (const { platform, enabled, expected } of [
  { platform: 'darwin', enabled: true, expected: [{ pattern: 'generic', performanceTime: 'now' }] },
  { platform: 'darwin', enabled: false, expected: [] },
  { platform: 'win32', enabled: true, expected: [] }
]) {
  test(`${platform} refresh haptics ${enabled ? 'enabled' : 'disabled'} acknowledge one accepted operation`, async (t) => {
    let finish;
    let calls = 0;
    const fixture = createFixture({
      platform, settings: { edgeDockMode: 'autoHide', edgeDockHaptic: enabled },
      canRefreshLimits: () => true,
      onRefreshLimits: () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); }
    });
    t.after(() => fixture.controller.stop());
    const peek = fixture.windowFor('peek');
    const rail = fixture.windowFor('rail');
    const handler = fixture.ipcMain.handlers.get('edgeDock:refreshLimits');
    assert.equal((await handler({ sender: peek.webContents })).ok, false);
    assert.deepEqual(fixture.hapticCalls, []);
    fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
    fixture.hapticCalls.length = 0; // Exclude the existing rail-reveal feedback.
    assert.equal((await handler({ sender: peek.webContents })).ok, false, 'unpainted refresh rejects input');
    fixture.paintPeek();
    assert.equal((await handler({ sender: rail.webContents })).ok, false);
    assert.deepEqual(fixture.hapticCalls, [], 'showing the control does not acknowledge a refresh');
    const first = handler({ sender: peek.webContents });
    const duplicate = handler({ sender: peek.webContents });
    assert.deepEqual(fixture.hapticCalls, expected, 'feedback happens immediately and once');
    await Promise.resolve();
    assert.equal(calls, 1);
    finish({ ok: false });
    assert.equal((await first).ok, false);
    assert.equal((await duplicate).ok, false);
    assert.deepEqual(fixture.hapticCalls, expected, 'failure does not trigger more feedback');
    const next = handler({ sender: peek.webContents });
    await Promise.resolve();
    assert.equal(calls, 2);
    finish({ ok: true });
    assert.equal((await next).ok, true);
    assert.deepEqual(fixture.hapticCalls, [...expected, ...expected], 'the next refresh has its own acknowledgement');
  });
}
