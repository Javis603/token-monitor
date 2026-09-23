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
  showInactive() { this.visible = true; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  setAlwaysOnTop() {}
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
  const settings = {
    edgeDockEnabled: true,
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
    prefersReducedMotion: () => true,
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
  return { controller, hapticCalls, haptics, ipcMain, maskWindows, placements, screen, settings, windowFor };
}

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
