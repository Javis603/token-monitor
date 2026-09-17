'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createEdgeDockController } = require('../../src/electron/edgeDock/controller');

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
  const accentWindows = [];
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
    applyWindowsAccentBlur: (win) => {
      accentWindows.push(win);
      return options.accentAvailable !== false;
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
  return { accentWindows, controller, ipcMain, placements, screen, settings, windowFor };
}

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

test('Windows Edge Dock follows Acrylic and Accent backdrop settings', (t) => {
  const fixture = createFixture({ nativeGlass: true });
  t.after(() => fixture.controller.stop());
  const acrylicWindows = FakeBrowserWindow.instances.slice();
  assert.equal(acrylicWindows.length, 3);
  assert.ok(acrylicWindows.every((win) => win.options.transparent === false));
  assert.ok(acrylicWindows.every((win) => win.options.backgroundMaterial === 'acrylic'));
  assert.ok(acrylicWindows.filter((win) => win.surface !== 'bubble').every((win) => win.shapeCalls.at(-1)?.length > 0));

  fixture.settings.windowsBackdrop = 'accent';
  fixture.controller.sync();
  const accentWindows = FakeBrowserWindow.instances.filter((win) => !win.destroyed);
  assert.equal(accentWindows.length, 3);
  assert.ok(accentWindows.every((win) => win.options.backgroundMaterial === undefined));
  assert.equal(fixture.accentWindows.length, 3);
});
