'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createEdgeDockController } = require('../../src/electron/edgeDock/controller');
const { EDGE_DOCK_METRICS, EDGE_DOCK_TIMING, edgeDockBubbleBounds, edgeDockCellLayout, edgeDockPlacementForDrop, scaledEdgeDockMetrics } = require('../../src/electron/edgeDock/geometry');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
  }

  send(channel, payload) {
    this.messages.push({ channel, payload });
  }

  setWindowOpenHandler() {}
  getZoomFactor() { return this.zoomFactor ?? 1; }
  setZoomFactor(value) { this.zoomFactor = value; }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  static zOrder = [];
  static shapeFails = false;

  // A window region, once set, is all of the window that takes input.
  static atPoint(point) {
    return this.zOrder.findLast((win) => !win.destroyed && win.visible && !win.ignoreMouse
      && point.x >= win.bounds.x && point.x < win.bounds.x + win.bounds.width
      && point.y >= win.bounds.y && point.y < win.bounds.y + win.bounds.height
      && (!win.region || win.region.some((rect) => (
        point.x >= win.bounds.x + rect.x && point.x < win.bounds.x + rect.x + rect.width
        && point.y >= win.bounds.y + rect.y && point.y < win.bounds.y + rect.y + rect.height
      ))));
  }

  constructor(options) {
    super();
    this.options = options;
    this.alwaysOnTop = options.alwaysOnTop === true;
    this.webContents = new FakeWebContents();
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
    this.opacity = 1;
    this.opacityChanges = [];
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
  setOpacity(value) { this.opacity = value; this.opacityChanges.push(value); }
  setIgnoreMouseEvents(value, options) { this.ignoreMouse = value; this.forwardMouse = value === true && options?.forward === true; }
  showInactive() { this.visible = true; this.zOrderCalls.push('showInactive'); this.orderFront(); }
  moveTop() { this.zOrderCalls.push('moveTop'); this.orderFront(); }
  orderFront() {
    FakeBrowserWindow.zOrder = FakeBrowserWindow.zOrder.filter((win) => win !== this);
    FakeBrowserWindow.zOrder.push(this);
  }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  setSkipTaskbar(flag) { this.zOrderCalls.push(['setSkipTaskbar', flag]); }
  setAlwaysOnTop(flag, level) {
    this.alwaysOnTop = flag;
    this.zOrderCalls.push(['setAlwaysOnTop', flag, level]);
    if (flag) this.orderFront();
  }
  setVisibleOnAllWorkspaces() {}
  setHiddenInMissionControl() {}
  setShape(rects) {
    this.shapeCalls.push(rects);
    if (FakeBrowserWindow.shapeFails) throw new Error('region unavailable');
    this.region = rects;
  }
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

function paintedCardBounds(win) {
  const shape = win.webContents.messages.filter(message => message.payload?.shape?.contentBounds).at(-1)?.payload.shape;
  const frame = shape?.contentBounds;
  const bounds = win.getBounds();
  return frame ? { ...bounds, y: bounds.y + frame.y, height: frame.height } : bounds;
}

// Drive the controller's polling, intent grace and animation frames on one clock.
function mockDockClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  return (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 16) t.mock.timers.tick(Math.min(16, ms - elapsed));
  };
}

function createFixture(options = {}) {
  FakeBrowserWindow.instances = [];
  FakeBrowserWindow.zOrder = [];
  FakeBrowserWindow.shapeFails = options.shapeFails === true;
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
  const powerMonitor = new EventEmitter();
  const placements = [];
  const maskWindows = [];
  const haptics = [];
  const hapticCalls = [];
  const controller = createEdgeDockController({
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    powerMonitor,
    screen,
    platform: options.platform || 'win32',
    osRelease: options.osRelease ?? '24.6.0',
    rendererDir: '/renderer',
    preloadPath: '/preload.js',
    getSettings: () => settings,
    nativeGlass: () => options.nativeGlass === true,
    liquidGlass: () => (typeof options.liquidGlass === 'function' ? options.liquidGlass() : options.liquidGlass || null),
    createGlass: options.createGlass,
    windowsBackdrop: options.windowsBackdrop,
    canRefreshLimits: options.canRefreshLimits,
    onRefreshLimits: options.onRefreshLimits,
    onWebSurfaceChanged: options.onWebSurfaceChanged,
    prefersReducedMotion: options.prefersReducedMotion || (() => true),
    cardSpring: options.cardSpring,
    isFullScreen: options.isFullScreen,
    primaryButtonDown: options.primaryButtonDown,
    installNonActivatingInput: options.installNonActivatingInput,
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
      settings.edgeDockFloatingX = placement.floatingX;
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
  if (options.load !== false) for (const win of FakeBrowserWindow.instances) win.webContents.emit('did-finish-load');
  const windowFor = (surface) => FakeBrowserWindow.instances.filter((win) => !win.destroyed && win.surface === surface).at(-1);
  const paintPeek = () => {
    const win = windowFor('peek');
    const payload = sentPayload(win, 'peek');
    ipcMain.emit('edgeDock:peekPainted', { sender: win.webContents }, { mode: payload.peekMode, shapeKey: payload.shape?.key });
  };
  return { controller, hapticCalls, haptics, ipcMain, powerMonitor, maskWindows, placements, screen, settings, windowFor, paintPeek };
}

test('Windows Edge Dock installs non-activating input on every surface, including rebuilt windows', (t) => {
  const installed = [];
  const fixture = createFixture({ installNonActivatingInput: (win) => installed.push(win) });
  t.after(() => fixture.controller.stop());
  assert.deepEqual(installed, FakeBrowserWindow.instances);
  assert.ok(installed.every((win) => win.options.focusable === false));
  fixture.controller.sync();
  assert.equal(installed.length, 3, 'ordinary sync does not reinstall native callbacks');
  fixture.settings.edgeDockEnabled = false;
  fixture.controller.sync();
  fixture.settings.edgeDockEnabled = true;
  fixture.controller.sync();
  assert.deepEqual(installed, FakeBrowserWindow.instances);
  assert.equal(installed.filter((win) => !win.destroyed).length, 3);
});

test('macOS Edge Dock keeps clicks from activating the app on every surface', (t) => {
  const installed = [];
  const fixture = createFixture({ platform: 'darwin', installNonActivatingInput: (win) => installed.push(win) });
  t.after(() => fixture.controller.stop());
  assert.deepEqual(installed, FakeBrowserWindow.instances);
  assert.equal(installed.length, 3);
});

test('Windows Edge Dock creates toolbar windows and reasserts taskbar exclusion and topmost after showing', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.controller.stop());
  const surfaces = ['peek', 'rail', 'bubble'];
  const expected = ['showInactive', ['setSkipTaskbar', true], ['setAlwaysOnTop', true, 'pop-up-menu']];

  for (const surface of surfaces) {
    const win = fixture.windowFor(surface);
    assert.equal(win.options.type, 'toolbar');
    assert.equal(win.options.skipTaskbar, true);
    assert.equal(win.options.thickFrame, false);
    assert.equal(win.options.alwaysOnTop, true);
    assert.deepEqual(win.zOrderCalls, expected, `${surface} reasserts taskbar exclusion and topmost after showing`);
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
    const win = fixture.windowFor(surface);
    assert.equal(win.options.type, 'toolbar');
    assert.deepEqual(win.zOrderCalls, expected, `${surface} reasserts taskbar exclusion and topmost after rebuild`);
  }
});

for (const event of ['resume', 'unlock-screen']) {
  for (const mode of ['always', 'autoHide', 'alwaysExceptFullScreen']) {
    test(`Windows ${event} restores all Dock surfaces without changing ${mode} visibility`, (t) => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
      const fixture = createFixture({
        settings: { edgeDockMode: mode, edgeDockRefreshEnabled: false },
        isFullScreen: () => mode === 'alwaysExceptFullScreen'
      });
      t.after(() => fixture.controller.stop());
      if (mode === 'always') {
        const rail = fixture.windowFor('rail');
        const bubble = fixture.windowFor('bubble');
        fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 1 });
        fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 180 });
        fixture.screen.point = { x: paintedCardBounds(bubble).x + 30, y: paintedCardBounds(bubble).y + 30 };
      } else {
        fixture.paintPeek();
        fixture.screen.point = { x: 600, y: 400 };
      }
      const surfaces = ['peek', 'rail', 'bubble'].map(fixture.windowFor);
      const state = () => surfaces.map((win) => ({
        bounds: win.getBounds(), opacity: win.opacity, ignoreMouse: win.ignoreMouse,
        messages: win.webContents.messages.length
      }));
      const before = state();
      const counts = surfaces.map((win) => win.zOrderCalls.length);
      // Windows can retain WS_EX_TOPMOST while restoring the actual stacking
      // behind an ordinary window. Recovery must not trust that flag alone.
      const ordinary = new FakeBrowserWindow({ width: 1200, height: 900 });
      ordinary.showInactive();
      fixture.powerMonitor.emit(event);
      assert.deepEqual(state(), before, 'an open card stays open and hidden surfaces stay transparent');
      for (const win of surfaces) {
        assert.equal(win.alwaysOnTop, true);
        assert.ok(FakeBrowserWindow.zOrder.indexOf(win) > FakeBrowserWindow.zOrder.indexOf(ordinary));
      }
      // A later shell restore can overtake the immediate repair.
      for (const win of surfaces) win.alwaysOnTop = false;
      ordinary.moveTop();
      t.mock.timers.tick(500);
      for (const win of surfaces) {
        assert.equal(win.alwaysOnTop, true);
        assert.ok(FakeBrowserWindow.zOrder.indexOf(win) > FakeBrowserWindow.zOrder.indexOf(ordinary));
      }
      assert.deepEqual(surfaces.map((win) => win.zOrderCalls.length), counts.map((count) => count + 2));
      t.mock.timers.tick(5000);
      assert.deepEqual(surfaces.map((win) => win.zOrderCalls.length), counts.map((count) => count + 2), 'recovery ends after one follow-up');
    });
  }
}

test('Windows resume and unlock coalesce follow-ups and clean up when the Dock stops or restarts', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  const fixture = createFixture();
  t.after(() => fixture.controller.stop());
  fixture.controller.sync();
  assert.equal(fixture.powerMonitor.listenerCount('resume'), 1);
  assert.equal(fixture.powerMonitor.listenerCount('unlock-screen'), 1);
  const rail = fixture.windowFor('rail');
  const count = rail.zOrderCalls.length;
  fixture.powerMonitor.emit('resume');
  t.mock.timers.tick(200);
  fixture.powerMonitor.emit('unlock-screen');
  t.mock.timers.tick(300);
  assert.equal(rail.zOrderCalls.length, count + 2, 'the old follow-up was cancelled');
  t.mock.timers.tick(200);
  assert.equal(rail.zOrderCalls.length, count + 3);
  fixture.powerMonitor.emit('resume');
  fixture.settings.edgeDockEnabled = false;
  fixture.controller.sync();
  assert.equal(fixture.powerMonitor.listenerCount('resume'), 0);
  assert.equal(fixture.powerMonitor.listenerCount('unlock-screen'), 0);
  const stoppedCount = rail.zOrderCalls.length;
  fixture.powerMonitor.emit('resume');
  fixture.settings.edgeDockEnabled = true;
  fixture.controller.sync();
  for (const win of FakeBrowserWindow.instances.filter((win) => !win.destroyed)) win.webContents.emit('did-finish-load');
  const newRail = fixture.windowFor('rail');
  const newCount = newRail.zOrderCalls.length;
  t.mock.timers.tick(1000);
  assert.equal(rail.zOrderCalls.length, stoppedCount);
  assert.equal(newRail.zOrderCalls.length, newCount, 'stale callbacks do not raise rebuilt windows');
  assert.equal(fixture.powerMonitor.listenerCount('resume'), 1);
  assert.equal(fixture.powerMonitor.listenerCount('unlock-screen'), 1);
  fixture.powerMonitor.emit('resume');
  assert.equal(newRail.zOrderCalls.length, newCount + 1);
});

test('Windows resume leaves the painted refresh button above the rail shoulder', (t) => {
  const fixture = createFixture({ settings: { edgeDockMode: 'autoHide' }, canRefreshLimits: () => true });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
  fixture.paintPeek();
  fixture.powerMonitor.emit('resume');
  assert.equal(FakeBrowserWindow.zOrder.at(-1), peek);
  assert.equal(FakeBrowserWindow.atPoint({ x: peek.bounds.x + peek.bounds.width / 2, y: peek.bounds.y + peek.bounds.height / 2 }), peek);
});

test('macOS does not install Windows resume recovery', (t) => {
  const fixture = createFixture({ platform: 'darwin' });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const count = rail.zOrderCalls.length;
  fixture.powerMonitor.emit('resume');
  assert.equal(fixture.powerMonitor.listenerCount('resume'), 0);
  assert.equal(fixture.powerMonitor.listenerCount('unlock-screen'), 0);
  assert.equal(rail.zOrderCalls.length, count);
});

for (const platform of ['win32', 'darwin']) {
  test(`${platform} card reveal repairs Windows stacking after wake recovery has ended`, (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    const fixture = createFixture({ platform, settings: { edgeDockRefreshEnabled: false } });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    const bubble = fixture.windowFor('bubble');
    const open = () => {
      fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 1 });
      fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 180 });
      fixture.screen.point = { x: paintedCardBounds(bubble).x + 30, y: paintedCardBounds(bubble).y + 30 };
    };
    open();
    fixture.powerMonitor.emit('resume');
    t.mock.timers.tick(5000);
    fixture.ipcMain.emit('edgeDock:dismiss', { sender: bubble.webContents });
    const ordinary = new FakeBrowserWindow({ width: 1200, height: 900 });
    ordinary.showInactive();
    const count = bubble.zOrderCalls.length;
    assert.equal(bubble.alwaysOnTop, true, 'the flag can stay set while native ordering is wrong');
    open();
    assert.equal(bubble.zOrderCalls.length, count + (platform === 'win32' ? 1 : 0));
    if (platform === 'win32') assert.equal(FakeBrowserWindow.zOrder.at(-1), bubble);
    assert.equal(bubble.opacity, 1);
    assert.equal(bubble.ignoreMouse, false);
    const revealedCount = bubble.zOrderCalls.length;
    fixture.controller.sync();
    t.mock.timers.tick(5000);
    assert.equal(bubble.zOrderCalls.length, revealedCount, 'steady visibility does not keep raising the card');
    fixture.ipcMain.emit('edgeDock:dismiss', { sender: bubble.webContents });
    ordinary.moveTop();
    open();
    assert.equal(bubble.zOrderCalls.length, revealedCount + (platform === 'win32' ? 1 : 0));
    if (platform === 'win32') assert.equal(FakeBrowserWindow.zOrder.at(-1), bubble);
  });
}

for (const mode of ['always', 'alwaysExceptFullScreen']) {
  test(`Windows card reveal restores the already-visible ${mode} rail as well`, (t) => {
    const fixture = createFixture({ settings: { edgeDockMode: mode, edgeDockRefreshEnabled: false } });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    const bubble = fixture.windowFor('bubble');
    const peek = fixture.windowFor('peek');
    const ordinary = new FakeBrowserWindow({ width: 1200, height: 900 });
    ordinary.showInactive();
    const peekCount = peek.zOrderCalls.length;
    assert.equal(rail.opacity, 1);
    assert.equal(rail.alwaysOnTop, true);

    fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 1 });
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 180 });

    assert.equal(bubble.opacity, 1);
    assert.ok(FakeBrowserWindow.zOrder.indexOf(bubble) > FakeBrowserWindow.zOrder.indexOf(ordinary));
    assert.ok(FakeBrowserWindow.zOrder.indexOf(rail) > FakeBrowserWindow.zOrder.indexOf(ordinary), 'opening a card also restores its rail');
    assert.ok(FakeBrowserWindow.zOrder.indexOf(bubble) > FakeBrowserWindow.zOrder.indexOf(rail), 'the card stays above the rail');
    assert.equal(peek.zOrderCalls.length, peekCount, 'the concealed handle is not raised');
    assert.equal(peek.opacity, 0);
  });
}

test('Windows group recovery keeps the painted refresh action above the rail and card', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  const fixture = createFixture({ canRefreshLimits: () => true });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const bubble = fixture.windowFor('bubble');
  const peek = fixture.windowFor('peek');
  fixture.screen.point = { x: rail.bounds.x + 30, y: rail.bounds.y + 45 };
  t.mock.timers.tick(100);
  fixture.paintPeek();
  const ordinary = new FakeBrowserWindow({ width: 1200, height: 900 });
  ordinary.showInactive();
  fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 0 });
  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'claude', height: 180 });
  const above = (front, back) => FakeBrowserWindow.zOrder.indexOf(front) > FakeBrowserWindow.zOrder.indexOf(back);
  assert.ok(above(rail, ordinary));
  assert.ok(above(bubble, rail));
  assert.ok(above(peek, bubble));
  assert.equal(FakeBrowserWindow.atPoint({ x: peek.bounds.x + 16, y: peek.bounds.y + 3 }), peek);
});

for (const platform of ['win32', 'darwin']) {
  test(`${platform} entering a visible rail recovers ordering once without a power event`, (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    const fixture = createFixture({ platform, settings: { edgeDockMode: 'alwaysExceptFullScreen', edgeDockRefreshEnabled: false } });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    const bubble = fixture.windowFor('bubble');
    const ordinary = new FakeBrowserWindow({ width: 1200, height: 900 });
    const point = { x: rail.bounds.x + 30, y: rail.bounds.y + 45 };
    const open = () => {
      fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 0 });
      fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'claude', height: 180 });
    };
    open();
    fixture.screen.point = { x: 600, y: 400 };
    t.mock.timers.tick(100);
    ordinary.showInactive();
    bubble.moveTop();
    const counts = [rail, bubble].map((win) => win.zOrderCalls.length);
    fixture.screen.point = point;
    t.mock.timers.tick(100);
    if (platform === 'win32') {
      assert.ok(FakeBrowserWindow.zOrder.indexOf(rail) > FakeBrowserWindow.zOrder.indexOf(ordinary));
      assert.ok(FakeBrowserWindow.zOrder.indexOf(bubble) > FakeBrowserWindow.zOrder.indexOf(rail));
    }
    const after = [rail, bubble].map((win) => win.zOrderCalls.length);
    assert.deepEqual(after, counts.map((count) => count + (platform === 'win32' ? 1 : 0)));
    t.mock.timers.tick(1000);
    assert.deepEqual([rail, bubble].map((win) => win.zOrderCalls.length), after, 'steady hover does not keep raising windows');

    fixture.screen.point = { x: paintedCardBounds(bubble).x + 30, y: paintedCardBounds(bubble).y + 30 };
    t.mock.timers.tick(100);
    ordinary.moveTop();
    bubble.moveTop();
    const beforeReturn = rail.zOrderCalls.length;
    fixture.screen.point = point;
    t.mock.timers.tick(100);
    assert.equal(rail.zOrderCalls.length, beforeReturn + (platform === 'win32' ? 1 : 0), 'returning from the card repairs the rail again');
  });
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
  assert.equal(paintedCardBounds(bubble).y, reordered.y);

  fixture.settings.edgeDockSide = 'left';
  fixture.controller.sync();
  const moved = edgeDockBubbleBounds({
    railBounds: rail.bounds,
    cellIndex: 0,
    height: 180,
    workArea: fixture.screen.displays[0].workArea,
    side: 'left'
  });
  assert.equal(paintedCardBounds(bubble).x, moved.x);
  assert.ok(paintedCardBounds(bubble).x > rail.bounds.x);

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
  assert.equal(paintedCardBounds(bubble).height, 220);
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

  assert.equal(rail.bounds.x, 1700 - 32);
  assert.notEqual(fixture.placements.at(-1).floatingX, null);
  assert.equal(fixture.placements.at(-1).displayId, '2');
  assert.equal(fixture.placements.at(-1).side, 'right');
});

test('the dock size scales its windows and zooms their pages to match', (t) => {
  const fixture = createFixture({ settings: { edgeDockSize: 'large' } });
  t.after(() => fixture.controller.stop());
  const large = scaledEdgeDockMetrics(1.25);
  const rail = fixture.windowFor('rail');
  const bubble = fixture.windowFor('bubble');
  const workArea = fixture.screen.displays[0].workArea;

  assert.equal(rail.bounds.width, large.railWidth);
  for (const surface of ['rail', 'bubble', 'peek']) {
    assert.equal(fixture.windowFor(surface).options.webPreferences.zoomFactor, 1.25, `${surface} page zoom`);
  }
  // The page lays its cells out in its own, unzoomed units.
  const windowLayout = edgeDockCellLayout(workArea, ['provider', 'provider', 'provider'], large);
  const payload = sentPayload(rail, 'rail');
  assert.equal(payload.zoom, 1.25);
  assert.deepEqual(payload.cellLayout.tops, windowLayout.tops.map((top) => top / 1.25));

  // A card measured by its page in page units opens a window that many times larger.
  fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 1 });
  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 180 });
  const { tailY: _tailY, ...expected } = edgeDockBubbleBounds({ railBounds: rail.bounds, cellIndex: 1, height: 225, workArea, side: 'right', metrics: large });
  assert.deepEqual(paintedCardBounds(bubble), expected);
  assert.equal(sentPayload(bubble, 'bubble').placed.height, 180, 'the page keeps its own measurement');
  assert.equal(sentPayload(bubble, 'bubble').maxCardHeight, Math.floor((workArea.height - EDGE_DOCK_METRICS.screenMargin * 2) / 1.25));

  fixture.settings.edgeDockSize = 'medium';
  fixture.controller.sync();
  assert.equal(rail.bounds.width, EDGE_DOCK_METRICS.railWidth);
  assert.equal(rail.webContents.getZoomFactor(), 1);
  assert.equal(sentPayload(rail, 'rail').zoom, 1);
});

test('a larger dock that would not fit the display zooms to the size it is drawn at', (t) => {
  const fixture = createFixture({
    settings: { edgeDockSize: 'large' },
    displays: [{ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1200, height: 520 }, workArea: { x: 0, y: 0, width: 1200, height: 480 } }]
  });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  fixture.controller.setCells(['claude', 'codex', 'cursor', 'gemini', 'kiro'].map((id) => ({ id, kind: 'provider', label: id, remainingPercent: 50 })));
  const zoom = sentPayload(rail, 'rail').zoom;
  assert.ok(zoom > 1 && zoom < 1.25, `zoom ${zoom}`);
  assert.equal(rail.webContents.getZoomFactor(), zoom);
  assert.equal(rail.bounds.width, scaledEdgeDockMetrics(zoom).railWidth);
  assert.equal(sentPayload(rail, 'rail').cellLayout.compact, false, 'at full density');
  const workArea = fixture.screen.displays[0].workArea;
  const kinds = Array(5).fill('provider');
  assert.equal(edgeDockCellLayout(workArea, kinds, scaledEdgeDockMetrics(zoom + 0.01)).compact, true, 'and the largest size that is');

  // Fewer cells fit at the size asked for.
  fixture.controller.setCells([{ id: 'codex', kind: 'provider', label: 'Codex', remainingPercent: 70 }]);
  assert.equal(rail.webContents.getZoomFactor(), 1.25);
  assert.equal(rail.bounds.width, scaledEdgeDockMetrics(1.25).railWidth);
});

test('a drag onto a display that fits a different size keeps the grab point under the pointer', async (t) => {
  const displays = [
    { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1000, height: 520 }, workArea: { x: 0, y: 0, width: 1000, height: 480 } },
    { id: 2, scaleFactor: 1, bounds: { x: 1000, y: 0, width: 800, height: 1200 }, workArea: { x: 1000, y: 0, width: 800, height: 1160 } }
  ];
  const fixture = createFixture({ displays, settings: { edgeDockSize: 'custom', edgeDockCustomScale: 1.5 } });
  t.after(() => fixture.controller.stop());
  fixture.controller.setCells(['claude', 'codex', 'cursor', 'gemini', 'kiro'].map((id) => ({ id, kind: 'provider', label: id, remainingPercent: 50 })));
  const rail = fixture.windowFor('rail');
  assert.ok(rail.webContents.getZoomFactor() < 1.5, 'the short display fits less than asked');

  fixture.screen.point = { x: 1700, y: 600 };
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetY: 100 });
  await new Promise((resolve) => setTimeout(resolve, 35));
  fixture.ipcMain.emit('edgeDock:dragEnd', { sender: rail.webContents });

  assert.equal(rail.webContents.getZoomFactor(), 1.5, 'the tall one fits it all');
  // 100 page units into the rail is 150 window pixels at the new size.
  assert.equal(rail.bounds.y, 600 - 150);
});

test('an open card stays within the work area when the dock grows', (t) => {
  const fixture = createFixture({ settings: { edgeDockSize: 'custom', edgeDockCustomScale: 1 } });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const bubble = fixture.windowFor('bubble');
  const workArea = fixture.screen.displays[0].workArea;
  fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 1 });
  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 800 });
  fixture.controller.previewScale(1.5);
  assert.ok(paintedCardBounds(bubble).height <= workArea.height - EDGE_DOCK_METRICS.screenMargin * 2, `card ${paintedCardBounds(bubble).height}px tall`);
});

test('a custom size previews while its slider is dragged and the saved size replaces it', (t) => {
  const fixture = createFixture({ settings: { edgeDockSize: 'custom', edgeDockCustomScale: 1 } });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');

  fixture.controller.previewScale(1.4);
  assert.equal(rail.webContents.getZoomFactor(), 1.4);
  assert.equal(rail.bounds.width, scaledEdgeDockMetrics(1.4).railWidth);
  assert.equal(fixture.settings.edgeDockCustomScale, 1, 'nothing is saved yet');

  fixture.settings.edgeDockCustomScale = 1.2;
  fixture.controller.sync();
  assert.equal(rail.webContents.getZoomFactor(), 1.2);
  assert.equal(rail.bounds.width, scaledEdgeDockMetrics(1.2).railWidth);
});

test('a drag on a larger dock keeps the grab point under the pointer', async (t) => {
  const fixture = createFixture({ settings: { edgeDockSize: 'custom', edgeDockCustomScale: 1.5 } });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const workArea = fixture.screen.displays[0].workArea;
  fixture.screen.point = { x: 1100, y: 420 };
  // Reported in page units: 30 there is 45 on screen.
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetY: 30 });
  await new Promise((resolve) => setTimeout(resolve, 35));
  fixture.ipcMain.emit('edgeDock:dragEnd', { sender: rail.webContents });
  const expected = edgeDockPlacementForDrop({
    workArea,
    pointer: { x: 1100, y: 420 },
    grabOffsetY: 45,
    cellKinds: ['provider', 'provider', 'provider'],
    metrics: scaledEdgeDockMetrics(1.5)
  });
  assert.equal(fixture.placements.at(-1).offset, expected.offset);
});

test('Windows Edge Dock falls back to the shaped renderer when native hosting is unavailable', (t) => {
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

test('Windows HostBackdrop follows shape, fade, resume and cleanup without using HWND-wide materials', (t) => {
  const adapters = [];
  const options = { nativeGlass: true, windowsBackdrop: {
    attach(win, onMaterial) {
      const adapter = { win, onMaterial, shapes: [], opacities: [], raises: 0,
        update(shape) { this.shapes.push(shape); },
        setOpacity(value) { this.opacities.push(value); },
        reorder() { this.raises++; },
        dispose() { this.disposed = true; }
      };
      adapters.push(adapter); return adapter;
    }
  } };
  const fixture = createFixture(options);
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const native = adapters.find((entry) => entry.win === rail);
  assert.equal(adapters.length, 3);
  assert.ok(native.shapes.at(-1).commands.some(([op]) => op === 'C'));
  assert.equal(sentPayload(rail, 'rail').glass, false);
  native.onMaterial(true);
  assert.equal(sentPayload(rail, 'rail').glass, true);
  assert.equal(sentPayload(rail, 'rail').liquidGlass, false);
  assert.equal(native.opacities.at(-1), rail.opacity);
  const before = native.shapes.at(-1).key;
  fixture.settings.edgeDockSide = 'left'; fixture.controller.sync();
  assert.notEqual(native.shapes.at(-1).key, before);
  const raises = native.raises;
  fixture.powerMonitor.emit('resume');
  assert.ok(native.raises > raises);
  fixture.settings.windowsBackdrop = 'accent'; fixture.controller.sync();
  assert.equal(adapters.length, 3, 'main-window material choice does not rebuild HostBackdrop');
  native.onMaterial(false);
  assert.equal(sentPayload(rail, 'rail').glass, false);
  assert.equal(rail.backgroundMaterials.length, 0);
  options.nativeGlass = false; fixture.controller.sync();
  assert.ok(adapters.every((entry) => entry.disposed));
  fixture.windowFor('rail').webContents.emit('did-finish-load');
  native.onMaterial(true);
  assert.equal(sentPayload(fixture.windowFor('rail'), 'rail').glass, false, 'ignore obsolete helper callbacks');
});

test('Windows dock material switches independently and rebuilds native underlays only when needed', (t) => {
  const adapters = [];
  const options = { nativeGlass: true, windowsBackdrop: {
    attach(win, onMaterial) {
      const adapter = { win, onMaterial, update() {}, setOpacity() {}, reorder() {},
        dispose() { this.disposed = true; } };
      adapters.push(adapter);
      return adapter;
    }
  } };
  const fixture = createFixture(options);
  t.after(() => fixture.controller.stop());
  assert.equal(adapters.length, 3, 'existing settings keep native glass');
  const inheritedRail = fixture.windowFor('rail');
  fixture.settings.edgeDockWindowsBackdrop = 'inherit';
  fixture.controller.sync();
  assert.equal(fixture.windowFor('rail'), inheritedRail, 'explicit inherit preserves the default material');
  fixture.settings.edgeDockWindowsBackdrop = 'transparent';
  fixture.controller.sync();
  assert.ok(adapters.every((adapter) => adapter.disposed));
  const plain = fixture.windowFor('rail');
  plain.webContents.emit('did-finish-load');
  assert.equal(sentPayload(plain, 'rail').glass, false);
  assert.ok(plain.shapeCalls.at(-1).length > 0, 'transparent mode keeps curved hit regions');
  fixture.controller.sync();
  assert.equal(fixture.windowFor('rail'), plain, 'unchanged settings keep the same window');
  assert.equal(fixture.settings.windowsBackdrop, 'acrylic', 'main-window choice is independent');
  fixture.settings.edgeDockWindowsBackdrop = 'host-backdrop';
  fixture.controller.sync();
  assert.equal(adapters.length, 6, 'native glass can be restored without restarting the app');
  const rail = fixture.windowFor('rail');
  const native = adapters.find((adapter) => adapter.win === rail);
  rail.webContents.emit('did-finish-load');
  native.onMaterial(true);
  assert.equal(sentPayload(rail, 'rail').glass, true);
  options.nativeGlass = false;
  fixture.controller.sync();
  assert.equal(fixture.windowFor('rail'), rail, 'an explicit dock style overrides System Glass');
  fixture.settings.edgeDockWindowsBackdrop = 'inherit';
  fixture.controller.sync();
  assert.ok(adapters.every((adapter) => adapter.disposed), 'inherit follows System Glass off');
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

test('macOS Liquid Glass shapes the rail and card while the peek keeps its masked HUD handle', (t) => {
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

test('macOS Transparent drops the dock material while the widget keeps its glass', (t) => {
  const factory = fakeGlassFactory();
  const fixture = createFixture({ platform: 'darwin', nativeGlass: true, liquidGlass: { dark: true }, createGlass: factory.create });
  t.after(() => fixture.controller.stop());
  const glassy = fixture.windowFor('rail');
  assert.equal(factory.glasses.length, 2);

  fixture.settings.edgeDockMacBackdrop = 'transparent';
  fixture.controller.sync();
  const plain = fixture.windowFor('rail');
  assert.notEqual(plain, glassy);
  assert.ok(factory.glasses.every((glass) => glass.disposed !== null));
  assert.equal(factory.glasses.length, 2, 'no Liquid Glass is built for a transparent dock');
  assert.ok(['peek', 'rail', 'bubble'].every((surface) => fixture.windowFor(surface).options.vibrancy === undefined));
  plain.webContents.emit('did-finish-load');
  assert.equal(sentPayload(plain, 'rail').glass, false);

  fixture.settings.edgeDockMacBackdrop = 'inherit';
  fixture.controller.sync();
  assert.equal(factory.glasses.length, 4, 'glass returns without restarting the app');
});

test('macOS dock styles override System Glass while inherit follows it', (t) => {
  const factory = fakeGlassFactory();
  const options = { platform: 'darwin', nativeGlass: false, liquidGlass: { dark: true }, createGlass: factory.create };
  const fixture = createFixture(options);
  t.after(() => fixture.controller.stop());
  assert.equal(factory.glasses.length, 0, 'inherit follows System Glass off');

  fixture.settings.edgeDockMacBackdrop = 'liquid-glass';
  fixture.controller.sync();
  assert.equal(factory.glasses.length, 2, 'an explicit style brings its own glass');
  const rail = fixture.windowFor('rail');
  rail.webContents.emit('did-finish-load');
  assert.equal(sentPayload(rail, 'rail').glass, true);

  fixture.settings.edgeDockMacBackdrop = 'inherit';
  fixture.controller.sync();
  assert.ok(factory.glasses.every((glass) => glass.disposed !== null));
});

test('Regular and Clear update the retained dock glass without rebuilding windows', (t) => {
  const factory = fakeGlassFactory();
  let wanted = { dark: true, style: 'regular' };
  const fixture = createFixture({ platform: 'darwin', nativeGlass: true, liquidGlass: () => wanted, createGlass: factory.create });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  for (const [style, tintOpacity] of [['clear', 0.35], ['clear', 0.7], ['regular', 0.12]]) {
    wanted = { dark: false, style, tintOpacity };
    fixture.controller.sync();
    fixture.controller.setAppearance({});
    assert.equal(fixture.windowFor('rail'), rail);
    for (const glass of factory.glasses) {
      assert.equal(glass.updates.at(-1).style, style);
      assert.equal(glass.updates.at(-1).tintOpacity, tintOpacity);
    }
  }
  assert.equal(factory.glasses.length, 2);
});

for (const style of ['frosted', 'regular', 'clear']) {
  test(`${style}: glass previews preserve canonical appearance while hidden, on reveal and after a full settings update`, (t) => {
    const factory = fakeGlassFactory();
    const wanted = style === 'frosted' ? null : { dark: true, style, tintOpacity: 0.64 };
    const fixture = createFixture({ platform: 'darwin', nativeGlass: true, liquidGlass: () => wanted, createGlass: factory.create });
    t.after(() => fixture.controller.stop());
    const original = { language: 'zh-TW', currency: 'HKD', currencyRatesEffective: { HKD: 7.8 },
      subscriptions: [{ id: 'subscription', amount: 20 }], themeColors: { bg: '#123456' },
      glassOpacity: 68, glassBlur: 32 };
    fixture.controller.setAppearance(original);
    const rail = fixture.windowFor('rail'), card = fixture.windowFor('bubble');
    const windowCount = FakeBrowserWindow.instances.length;
    rail.visible = card.visible = false;
    assert.equal(fixture.controller.isRunning(), true);
    for (const glassOpacity of [17, 0, 84]) {
      fixture.controller.setAppearance({ glassOpacity, glassBlur: 75, currency: 'USD',
        subscriptions: [], themeColors: {}, style: 'other', macClearGlassTint: 99 }, { preview: true });
      for (const [win, surface] of [[rail, 'rail'], [card, 'bubble']]) {
        assert.deepEqual(sentPayload(win, surface).appearance, { ...original, glassOpacity, glassBlur: 75 });
      }
      if (wanted) for (const glass of factory.glasses) {
        assert.equal(glass.updates.at(-1).style, style);
        assert.equal(glass.updates.at(-1).tintOpacity, 0.64);
      }
    }
    assert.equal(original.glassOpacity, 68, 'preview must not mutate the canonical snapshot');
    rail.showInactive(); card.showInactive(); fixture.controller.sync();
    assert.equal(sentPayload(rail, 'rail').appearance.glassOpacity, 84);
    assert.equal(sentPayload(card, 'bubble').appearance.currency, 'HKD');
    assert.equal(FakeBrowserWindow.instances.length, windowCount);
    const next = { ...original, currency: 'TWD', currencyRatesEffective: { TWD: 32 }, subscriptions: [{ id: 'updated' }] };
    fixture.controller.setAppearance(next);
    fixture.controller.setAppearance({ glassOpacity: 25 }, { preview: true });
    assert.deepEqual(sentPayload(rail, 'rail').appearance, { ...next, glassOpacity: 25 });
  });
}

// The rail's entrance is keyed to the reveal rather than to the push, so the page
// has to be able to tell which payload is the reveal: without that it has neither
// a transition to fire on nor a way to keep a stats update from replaying the
// slide. It is a count rather than a flag because only the reveal renders - the
// retract fades the window out with no payload at all, so a page told the state
// alone keeps believing the rail is up and reads the next reveal as no change,
// which is what left the entrance playing once per page load.
test('the handle grows on approach and reveals from its wake zone unless a button is held', async (t) => {
  let buttonDown = false;
  const fixture = createFixture({ platform: 'darwin', nativeGlass: true, settings: { edgeDockMode: 'autoHide' }, primaryButtonDown: () => buttonDown });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const rail = fixture.windowFor('rail');
  const edge = peek.bounds.x + peek.bounds.width;
  const y = peek.bounds.y + peek.bounds.height / 2;
  const settle = () => new Promise((resolve) => setTimeout(resolve, EDGE_DOCK_TIMING.revealDelayMs + 200));

  const restShape = sentPayload(peek, 'peek').shape;
  const masks = fixture.maskWindows.filter((win) => win === peek).length;
  fixture.screen.point = { x: edge - EDGE_DOCK_METRICS.approachDepth + 4, y };
  await settle();
  const nearShape = sentPayload(peek, 'peek').shape;
  assert.notEqual(nearShape.d, restShape.d, 'the approach zone grows the handle');
  assert.equal(sentPayload(peek, 'peek').glass, true, 'on the rail\'s material');
  assert.equal(fixture.maskWindows.filter((win) => win === peek).length, masks + 1, 'the mask follows the larger silhouette');
  assert.equal(rail.opacity, 0, 'but does not reveal the rail');

  // Inside the wake zone yet clear of the handle window and the edge strip.
  fixture.screen.point = { x: edge - EDGE_DOCK_METRICS.wakeDepth + 4, y };
  buttonDown = true;
  await settle();
  assert.equal(rail.opacity, 0, 'a drag past the handle does not open the dock');

  buttonDown = null;
  await settle();
  assert.equal(rail.opacity, 0, 'nor does one whose button state cannot be read');

  buttonDown = false;
  await settle();
  assert.equal(rail.opacity, 1, 'resting in the wake zone does');
  assert.equal(sentPayload(peek, 'peek').shape.d, restShape.d, 'the handle is not left grown behind the rail');
});

test('the macOS handle window lets the pointer through except over the handle itself', async (t) => {
  const fixture = createFixture({ platform: 'darwin', settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const rail = fixture.windowFor('rail');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(peek.ignoreMouse, true, 'the margin passes clicks to the app beneath');
  assert.equal(peek.forwardMouse, true, 'with the pointer\'s moves still reaching the page');

  // Inside the window but beside the handle: still passed through, and not the
  // handle's fast reveal.
  fixture.screen.point = { x: peek.bounds.x + 1, y: peek.bounds.y + peek.bounds.height / 2 };
  await tick();
  assert.equal(peek.ignoreMouse, true);
  assert.equal(rail.opacity, 0);

  // Resting there reveals the rail soon after, which hides the handle again, so
  // watch for the window taking the pointer rather than sampling one moment.
  fixture.screen.point = { x: peek.bounds.x + peek.bounds.width - 1, y: peek.bounds.y + peek.bounds.height / 2 };
  let took = false;
  for (let waited = 0; waited < 300 && !took; waited += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    took = peek.ignoreMouse === false;
  }
  assert.equal(took, true, 'the handle takes the pointer');
});

test('a pointer report from the page takes the pointer without waiting for the cursor poll', async (t) => {
  const fixture = createFixture({ platform: 'darwin', settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const y = peek.bounds.y + peek.bounds.height / 2;
  // Let the first poll see the pointer far away, then report it at once.
  await new Promise((resolve) => setTimeout(resolve, 5));
  fixture.screen.point = { x: peek.bounds.x + peek.bounds.width - 1, y };
  fixture.ipcMain.emit('edgeDock:pointer', { sender: peek.webContents });
  assert.equal(peek.ignoreMouse, false, 'on the handle');

  fixture.screen.point = { x: peek.bounds.x, y: peek.bounds.y + 1 };
  fixture.ipcMain.emit('edgeDock:pointer', { sender: peek.webContents });
  assert.equal(peek.ignoreMouse, true, 'and lets it through again in the margin');
  assert.equal(peek.forwardMouse, true);

  // Only the handle's own page speaks for it.
  fixture.screen.point = { x: peek.bounds.x + peek.bounds.width - 1, y };
  fixture.ipcMain.emit('edgeDock:pointer', { sender: fixture.windowFor('rail').webContents });
  assert.equal(peek.ignoreMouse, true);
});

test('the Windows handle window takes the pointer and leaves the margin to its region', async (t) => {
  const fixture = createFixture({ platform: 'win32', settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const y = peek.bounds.y + peek.bounds.height / 2;
  const margin = { x: peek.bounds.x, y: peek.bounds.y + 1 };
  assert.equal(peek.ignoreMouse, false);
  assert.equal(peek.forwardMouse, false, 'no system-wide mouse hook');
  assert.equal(FakeBrowserWindow.atPoint({ x: peek.bounds.x + peek.bounds.width - 1, y }), peek, 'the handle takes clicks');
  assert.equal(FakeBrowserWindow.atPoint(margin), undefined, 'the margin leaves them to the app beneath');

  fixture.screen.point = margin;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(peek.ignoreMouse, false, 'leaving the handle does not turn pass-through back on');
});

test('a Windows handle without its region falls back to passing the pointer through', async (t) => {
  const fixture = createFixture({ platform: 'win32', settings: { edgeDockMode: 'autoHide' }, shapeFails: true });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const margin = { x: peek.bounds.x, y: peek.bounds.y + 1 };
  assert.equal(peek.ignoreMouse, true);
  assert.equal(peek.forwardMouse, false, 'still without the mouse hook');
  assert.equal(FakeBrowserWindow.atPoint(margin), undefined);

  fixture.screen.point = { x: peek.bounds.x + peek.bounds.width - 1, y: peek.bounds.y + peek.bounds.height / 2 };
  let took = false;
  for (let waited = 0; waited < 300 && !took; waited += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    took = peek.ignoreMouse === false;
  }
  assert.equal(took, true, 'the cursor poll still hands it the pointer on the handle');
});

test('the cursor poll speeds up in the approach zone so the handle takes the pointer sooner', async (t) => {
  const fixture = createFixture({ settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const read = fixture.screen.getCursorScreenPoint;
  let polls = 0;
  fixture.screen.getCursorScreenPoint = function () { polls += 1; return read.call(this); };
  const pollsOver = async (ms) => {
    polls = 0;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return polls;
  };

  const far = await pollsOver(450);
  fixture.screen.point = { x: peek.bounds.x + peek.bounds.width - EDGE_DOCK_METRICS.approachDepth + 4, y: peek.bounds.y + peek.bounds.height / 2 };
  await new Promise((resolve) => setTimeout(resolve, 100));
  const near = await pollsOver(450);
  assert.ok(near >= far + 3, `polls in 450ms: ${far} away from the edge, ${near} in the approach zone`);
});

test('the grown handle takes the pointer but only the resting handle reveals fast', async (t) => {
  // No readable button state, so the wake zone stays out of it.
  const fixture = createFixture({ settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const rail = fixture.windowFor('rail');
  const edge = peek.bounds.x + peek.bounds.width;
  // Beside the resting handle, inside the one grown on approach.
  fixture.screen.point = { x: edge - EDGE_DOCK_METRICS.handleWidth - 1, y: peek.bounds.y + peek.bounds.height / 2 };
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(peek.ignoreMouse, false, 'the grown handle takes the pointer');
  assert.equal(rail.opacity, 0, 'without turning a wake-zone dwell into the fast reveal');
});

test('the handle grows through intermediate silhouettes unless motion is reduced', async (t) => {
  const fixture = createFixture({ platform: 'darwin', nativeGlass: true, settings: { edgeDockMode: 'autoHide' }, prefersReducedMotion: () => false });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const masks = () => fixture.maskWindows.filter((win) => win === peek).length;
  const before = masks();
  fixture.screen.point = { x: peek.bounds.x + peek.bounds.width - EDGE_DOCK_METRICS.approachDepth + 4, y: peek.bounds.y + peek.bounds.height / 2 };
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(masks() - before > 2, `the mask follows the growth in steps (${masks() - before})`);
  const grown = sentPayload(peek, 'peek').shape;
  assert.equal(grown.key.endsWith(`:${EDGE_DOCK_METRICS.handleNearWidth}x${EDGE_DOCK_METRICS.handleNearLength}`), true);
});

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
  const fixture = createFixture({ platform: 'darwin', settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');

  assert.equal(sentPayload(peek, 'peek').peeking, true);
  // Shown, but passing the pointer through until it is on the handle itself.
  assert.equal(peek.ignoreMouse, true);

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
  assert.equal(paintedCardBounds(bubble).height, 300 - EDGE_DOCK_METRICS.screenMargin * 2);
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
  // The hidden rail started parked off-screen; the reveal docks it at the edge
  // with its size and height unchanged.
  assert.deepEqual({ ...rail.bounds, x: 0 }, { ...originalRail, x: 0 });
  assert.equal(rail.bounds.x + rail.bounds.width, 1200);
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
    assert.equal(peek.bounds.x + peek.bounds.width / 2, rail.bounds.x + rail.bounds.width / 2,
      'the button stays in the original rail column even for a full-height rail');
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
  { platform: 'darwin', enabled: true, expected: [{ pattern: 'alignment', performanceTime: 'now' }] },
  { platform: 'darwin', enabled: false, expected: [] },
  { platform: 'win32', enabled: true, expected: [] }
]) {
  test(`${platform} refresh hover haptics ${enabled ? 'enabled' : 'disabled'} match readouts without click feedback`, async (t) => {
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
    fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
    fixture.hapticCalls.length = 0; // Exclude the existing rail-reveal feedback.
    fixture.screen.point = { x: peek.bounds.x + 16, y: peek.bounds.y + 16 };
    await new Promise((resolve) => setTimeout(resolve, 105));
    assert.deepEqual(fixture.hapticCalls, [], 'the unpainted action does not trigger hover feedback');
    assert.equal((await handler({ sender: peek.webContents })).ok, false);
    fixture.paintPeek();
    await new Promise((resolve) => setTimeout(resolve, 105));
    assert.deepEqual(fixture.hapticCalls, expected, 'entering a painted action triggers alignment feedback');
    await new Promise((resolve) => setTimeout(resolve, 105));
    assert.deepEqual(fixture.hapticCalls, expected, 'staying over the action does not repeat feedback');
    assert.equal((await handler({ sender: rail.webContents })).ok, false);
    const first = handler({ sender: peek.webContents });
    const duplicate = handler({ sender: peek.webContents });
    assert.deepEqual(fixture.hapticCalls, expected, 'clicks do not overlap the trackpad click feedback');
    await Promise.resolve();
    assert.equal(calls, 1);
    finish({ ok: false });
    assert.equal((await first).ok, false);
    assert.equal((await duplicate).ok, false);
    assert.deepEqual(fixture.hapticCalls, expected, 'failure does not trigger more feedback');
    fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 40 };
    await new Promise((resolve) => setTimeout(resolve, 105));
    assert.deepEqual(fixture.hapticCalls, [...expected, ...expected], 'returning to a readout gets its own hover feedback');
    fixture.screen.point = { x: peek.bounds.x + 16, y: peek.bounds.y + 16 };
    await new Promise((resolve) => setTimeout(resolve, 105));
    assert.deepEqual(fixture.hapticCalls, [...expected, ...expected, ...expected], 're-entering the action triggers one more tick');
    const next = handler({ sender: peek.webContents });
    const nextDuplicate = handler({ sender: peek.webContents });
    await Promise.resolve();
    assert.equal(calls, 2);
    finish({ ok: true });
    assert.equal((await next).ok, true);
    assert.equal((await nextDuplicate).ok, true);
    const successFeedback = platform === 'darwin' && enabled
      ? [{ pattern: 'generic', performanceTime: 'default' }] : [];
    assert.deepEqual(fixture.hapticCalls, [...expected, ...expected, ...expected, ...successFeedback],
      'success adds one completion tick shared by duplicate requests');
  });
}

for (const change of ['stop', 'restart', 'remove', 'disable haptics']) {
  test(`a refresh that completes after ${change} does not emit completion haptics`, async (t) => {
    let finish;
    const fixture = createFixture({
      platform: 'darwin', settings: { edgeDockMode: 'autoHide' },
      canRefreshLimits: () => true,
      onRefreshLimits: () => new Promise((resolve) => { finish = resolve; })
    });
    t.after(() => fixture.controller.stop());
    const peek = fixture.windowFor('peek');
    fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
    fixture.paintPeek();
    fixture.hapticCalls.length = 0;
    const request = fixture.ipcMain.handlers.get('edgeDock:refreshLimits')({ sender: peek.webContents });
    await Promise.resolve();
    assert.deepEqual(fixture.hapticCalls, [], 'clicking does not emit feedback');
    if (change === 'stop' || change === 'restart') fixture.controller.stop();
    if (change === 'restart') fixture.controller.sync();
    if (change === 'remove') fixture.settings.edgeDockRefreshEnabled = false;
    if (change === 'disable haptics') fixture.settings.edgeDockHaptic = false;
    finish({ ok: true });
    assert.deepEqual(await request, { ok: true }, 'feedback gating does not change the refresh result');
    assert.deepEqual(fixture.hapticCalls, []);
  });
}

for (const mode of ['always', 'alwaysExceptFullScreen']) {
  for (const outcome of ['success', 'failure', 'throw']) {
    test(`${mode} refresh stays visible after pointer leave until ${outcome}`, async (t) => {
      const advance = mockDockClock(t);
      let finish;
      let fail;
      const animated = mode === 'always' && outcome === 'success';
      const fixture = createFixture({
        prefersReducedMotion: () => !animated,
        settings: { edgeDockMode: mode }, isFullScreen: () => false,
        canRefreshLimits: () => true,
        onRefreshLimits: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; })
      });
      t.after(() => fixture.controller.stop());
      const peek = fixture.windowFor('peek');
      const rail = fixture.windowFor('rail');
      fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 40 };
      advance(105);
      fixture.paintPeek();
      const request = fixture.ipcMain.handlers.get('edgeDock:refreshLimits')({ sender: peek.webContents });
      await Promise.resolve();
      fixture.screen.point = { x: 100, y: 100 };
      advance(450);
      assert.equal(peek.ignoreMouse, false, 'the busy button remains visible after the normal leave grace');
      assert.equal(peek.opacity, 1);
      assert.equal(rail.ignoreMouse, false);
      assert.equal(sentPayload(peek, 'peek').peekMode, 'refresh');
      if (outcome === 'throw') fail(new Error('Probe failed'));
      else finish({ ok: outcome === 'success' });
      assert.equal((await request).ok, outcome === 'success');
      peek.opacityChanges.length = 0;
      advance(450);
      assert.equal(peek.ignoreMouse, false, 'the result remains visible long enough to read');
      assert.equal(peek.opacity, 1);
      advance(800);
      assert.equal(peek.ignoreMouse, true, 'the unhovered button hides after the result hold');
      assert.equal(peek.opacity, 0);
      if (animated) assert.ok(peek.opacityChanges.some((opacity) => opacity > 0 && opacity < 1),
        'the button fades through intermediate opacity rather than disappearing');
      assert.equal(rail.ignoreMouse, false);
    });
  }
}

test('busy visibility yields to dragging and removing the action', async (t) => {
  const advance = mockDockClock(t);
  let finish;
  const fixture = createFixture({
    canRefreshLimits: () => true,
    onRefreshLimits: () => new Promise((resolve) => { finish = resolve; })
  });
  t.after(() => fixture.controller.stop());
  const peek = fixture.windowFor('peek');
  const rail = fixture.windowFor('rail');
  fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 40 };
  advance(105);
  fixture.paintPeek();
  const request = fixture.ipcMain.handlers.get('edgeDock:refreshLimits')({ sender: peek.webContents });
  await Promise.resolve();
  fixture.screen.point = { x: 100, y: 100 };
  advance(105);
  assert.equal(peek.ignoreMouse, false);
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetY: 20 });
  assert.equal(peek.ignoreMouse, true);
  fixture.ipcMain.emit('edgeDock:dragEnd', { sender: rail.webContents });
  assert.equal(peek.ignoreMouse, false, 'the busy button returns after dragging');
  fixture.settings.edgeDockRefreshEnabled = false;
  fixture.controller.sync();
  assert.equal(peek.ignoreMouse, true, 'removing the action takes effect during refresh');
  finish({ ok: true });
  assert.deepEqual(await request, { ok: true });
  assert.equal(peek.ignoreMouse, true);
});

for (const rebuild of ['material', 'restart']) {
  test(`refresh joined after ${rebuild} rebuild keeps the new window busy and holds its result`, async (t) => {
    const advance = mockDockClock(t);
    let finish;
    let calls = 0;
    let glass = null;
    const fixture = createFixture({
      platform: 'darwin', nativeGlass: true,
      liquidGlass: () => glass,
      createGlass: () => ({ update() {}, setShape() { return true; }, dispose() {} }),
      canRefreshLimits: () => true,
      onRefreshLimits: () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); }
    });
    t.after(() => fixture.controller.stop());
    let peek = fixture.windowFor('peek');
    let rail = fixture.windowFor('rail');
    fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 40 };
    advance(105);
    fixture.paintPeek();
    const handler = fixture.ipcMain.handlers.get('edgeDock:refreshLimits');
    const original = handler({ sender: peek.webContents });
    await Promise.resolve();
    const oldPeek = peek;
    if (rebuild === 'material') glass = { dark: true };
    else fixture.controller.stop();
    fixture.controller.sync();
    for (const win of FakeBrowserWindow.instances.filter((win) => !win.destroyed)) win.webContents.emit('did-finish-load');
    peek = fixture.windowFor('peek');
    rail = fixture.windowFor('rail');
    assert.notEqual(peek, oldPeek);
    fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 40 };
    advance(105);
    fixture.paintPeek();
    const joined = handler({ sender: peek.webContents });
    await Promise.resolve();
    assert.equal(calls, 1, 'rejoining does not dispatch another refresh');
    fixture.screen.point = { x: 100, y: 100 };
    advance(450);
    assert.equal(peek.ignoreMouse, false, 'new busy window remains visible after pointer leave');
    fixture.hapticCalls.length = 0;
    finish({ ok: true });
    assert.deepEqual(await original, { ok: true });
    assert.deepEqual(await joined, { ok: true });
    assert.deepEqual(fixture.hapticCalls, [{ pattern: 'generic', performanceTime: 'default' }]);
    advance(450);
    assert.equal(peek.ignoreMouse, false, 'the new window holds its result');
    advance(800);
    assert.equal(peek.ignoreMouse, true, 'the new window hides after the hold');
  });
}

for (const mode of ['autoHide', 'alwaysExceptFullScreen']) {
  test(`${mode} keeps auto-hide behaviour during refresh in its auto-hide state`, async (t) => {
    const advance = mockDockClock(t);
    let finish;
    const fixture = createFixture({
      settings: { edgeDockMode: mode }, isFullScreen: () => true,
      canRefreshLimits: () => true,
      onRefreshLimits: () => new Promise((resolve) => { finish = resolve; })
    });
    t.after(() => fixture.controller.stop());
    const peek = fixture.windowFor('peek');
    const rail = fixture.windowFor('rail');
    fixture.ipcMain.emit('edgeDock:click', { sender: peek.webContents });
    fixture.paintPeek();
    const request = fixture.ipcMain.handlers.get('edgeDock:refreshLimits')({ sender: peek.webContents });
    await Promise.resolve();
    fixture.screen.point = { x: 100, y: 100 };
    advance(90); // Let the cursor poll observe departure before the hide grace.
    advance(EDGE_DOCK_TIMING.hideDelayMs - 1);
    assert.equal(rail.ignoreMouse, false, 'refresh does not bypass the normal leave grace');
    advance(41);
    assert.equal(rail.ignoreMouse, true, 'leaving still retracts the auto-hide rail while refreshing');
    assert.equal(sentPayload(peek, 'peek').peekMode, 'handle');
    finish({ ok: true });
    assert.deepEqual(await request, { ok: true });
  });
}


test('web surface callbacks skip unready and unchanged renders but preserve lifecycle changes', (t) => {
  let changes = 0;
  const fixture = createFixture({ load: false, onWebSurfaceChanged: () => { changes += 1; } });
  t.after(() => fixture.controller.stop());
  changes = 0;
  fixture.controller.setAppearance({ dark: true });
  assert.equal(changes, 0, 'unready renders do not reconcile web surfaces');
  for (const win of FakeBrowserWindow.instances) win.webContents.emit('did-finish-load');
  assert.ok(changes > 0, 'loading reconciles surfaces');
  changes = 0;
  fixture.controller.setAppearance({ dark: true });
  assert.equal(changes, 0, 'identical payload does not reconcile');
  fixture.controller.setAppearance({ dark: false });
  assert.ok(changes > 0, 'changed payload reconciles');
  changes = 0;
  fixture.settings.edgeDockMode = 'hover';
  fixture.controller.sync();
  assert.ok(changes > 0, 'hiding reconciles even without a changed payload');
  changes = 0;
  fixture.controller.stop();
  assert.ok(changes > 0, 'teardown reconciles detached hosts');
});

function onAnyDisplay(win, displays) {
  const { x, y, width, height } = win.bounds;
  return displays.some(({ bounds: d }) => x < d.x + d.width && x + width > d.x && y < d.y + d.height && y + height > d.y);
}

test('a hidden macOS rail is parked off every display so a Space switch cannot flash it', (t) => {
  const fixture = createFixture({
    platform: 'darwin',
    settings: { edgeDockMode: 'autoHide' },
    displays: [
      { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1200, height: 900 }, workArea: { x: 0, y: 0, width: 1200, height: 860 } },
      { id: 2, scaleFactor: 2, bounds: { x: 1200, y: -200, width: 1600, height: 1000 }, workArea: { x: 1200, y: -200, width: 1600, height: 960 } }
    ]
  });
  t.after(() => fixture.controller.stop());
  const displays = fixture.screen.getAllDisplays();
  const rail = fixture.windowFor('rail');
  assert.equal(rail.opacity, 0);
  assert.equal(onAnyDisplay(rail, displays), false, 'parked from the first load');

  fixture.screen.emit('display-metrics-changed');
  assert.equal(onAnyDisplay(rail, displays), false, 'a layout pass while hidden keeps it parked');

  // The rail is back in place before it becomes visible at all.
  const boundsAtFirstOpacity = [];
  const setOpacity = rail.setOpacity.bind(rail);
  rail.setOpacity = (value) => {
    if (value > 0 && boundsAtFirstOpacity.length === 0) boundsAtFirstOpacity.push({ ...rail.bounds });
    setOpacity(value);
  };
  fixture.settings.edgeDockMode = 'always';
  fixture.controller.sync();
  assert.equal(rail.opacity, 1);
  assert.equal(boundsAtFirstOpacity.length, 1);
  assert.equal(onAnyDisplay({ bounds: boundsAtFirstOpacity[0] }, displays), true);
  assert.equal(rail.bounds.x + rail.bounds.width, 1200, 'docked to the right edge of its display');

  fixture.settings.edgeDockMode = 'autoHide';
  fixture.controller.sync();
  assert.equal(rail.opacity, 0);
  assert.equal(onAnyDisplay(rail, displays), false, 'parked again once it retracts');
});

for (const [version, osRelease] of [['12', '21.6.0'], ['13', '22.6.0'], ['14', '23.6.0'], ['15.6.1', '24.6.0'], ['26', '25.0.0'], ['27', '26.0.0']]) {
  test(`macOS ${version} only parks hidden surfaces when older than macOS 26`, (t) => {
    const fixture = createFixture({ platform: 'darwin', osRelease, settings: { edgeDockMode: 'autoHide' } });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    const bubble = fixture.windowFor('bubble');
    const shouldPark = Number.parseInt(version, 10) < 26;
    const assertHidden = () => {
      for (const win of [rail, bubble]) {
        assert.equal(win.opacity, 0);
        assert.equal(onAnyDisplay(win, fixture.screen.getAllDisplays()), !shouldPark, `${win.surface} placement`);
      }
    };
    assertHidden();

    fixture.settings.edgeDockMode = 'always';
    fixture.controller.sync();
    assert.equal(rail.opacity, 1);
    assert.equal(onAnyDisplay(rail, fixture.screen.getAllDisplays()), true);
    fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 1 });
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 180 });
    assert.equal(bubble.opacity, 1);
    assert.equal(onAnyDisplay(bubble, fixture.screen.getAllDisplays()), true);
    fixture.ipcMain.emit('edgeDock:dismiss', { sender: bubble.webContents });
    fixture.settings.edgeDockMode = 'autoHide';
    fixture.controller.sync();
    assertHidden();

    fixture.screen.displays.push({ id: 2, scaleFactor: 2, bounds: { x: 1200, y: 0, width: 3000, height: 900 }, workArea: { x: 1200, y: 0, width: 3000, height: 860 } });
    fixture.screen.emit('display-added');
    assertHidden();
    fixture.settings.edgeDockSide = 'left';
    fixture.screen.emit('display-metrics-changed');
    assertHidden();
  });
}

test('a hidden Windows rail stays in place', (t) => {
  const fixture = createFixture({ platform: 'win32', settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  assert.equal(rail.opacity, 0);
  assert.equal(onAnyDisplay(rail, fixture.screen.getAllDisplays()), true);
});

test('a display added past the parked surfaces moves them beyond it', (t) => {
  const fixture = createFixture({ platform: 'darwin', settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const bubble = fixture.windowFor('bubble');
  assert.equal(bubble.opacity, 0);
  fixture.screen.displays.push({ id: 2, scaleFactor: 1, bounds: { x: 1200, y: 0, width: 3000, height: 900 }, workArea: { x: 1200, y: 0, width: 3000, height: 860 } });
  fixture.screen.emit('display-added');
  const displays = fixture.screen.getAllDisplays();
  assert.equal(onAnyDisplay(rail, displays), false);
  assert.equal(onAnyDisplay(bubble, displays), false, 'the hidden card has no cell to place, yet it moves too');
});

test('a free drop persists both axes, remains visible in auto-hide, and can snap back', (t) => {
  const advance = mockDockClock(t);
  const fixture = createFixture({ settings: { edgeDockMode: 'autoHide' } });
  t.after(() => fixture.controller.stop());
  fixture.ipcMain.emit('edgeDock:click', { sender: fixture.windowFor('peek').webContents });
  const rail = fixture.windowFor('rail');
  fixture.screen.point = { x: 600, y: 300 };
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetX: 20, grabOffsetY: 30 });
  // Release before the next poll: the final cursor location is still saved.
  fixture.ipcMain.emit('edgeDock:dragEnd', { sender: rail.webContents });
  assert.equal(rail.bounds.x, 580);
  assert.equal(rail.bounds.y, 270);
  assert.ok(fixture.settings.edgeDockFloatingX > 0);
  const floatingShape = sentPayload(rail, 'rail').shape.d;
  fixture.screen.point = { x: 0, y: 0 };
  advance(1000);
  assert.equal(rail.opacity, 1);
  assert.equal(sentPayload(rail, 'rail').always, true);
  fixture.controller.stop();
  fixture.controller.sync();
  for (const win of FakeBrowserWindow.instances.filter(win => !win.destroyed)) win.webContents.emit('did-finish-load');
  const restored = fixture.windowFor('rail');
  assert.equal(restored.bounds.x, 580);
  assert.equal(restored.bounds.y, 270);
  fixture.screen.point = { x: 1190, y: 400 };
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: restored.webContents }, { grabOffsetX: 20, grabOffsetY: 30 });
  fixture.ipcMain.emit('edgeDock:dragEnd', { sender: restored.webContents });
  assert.equal(fixture.settings.edgeDockFloatingX, null);
  assert.equal(restored.bounds.x, 1136);
  assert.notEqual(sentPayload(restored, 'rail').shape.d, floatingShape);
  assert.equal(sentPayload(restored, 'rail').always, false);
  fixture.screen.point = { x: 600, y: 0 };
  advance(1000);
  assert.equal(restored.opacity, 0);
});

test('floating cards choose the available side and fit a scaled narrow display', (t) => {
  const fixture = createFixture({ settings: { edgeDockFloatingX: 0.5, edgeDockCustomScale: 1.5, edgeDockSize: 'custom' },
    displays: [{ id: 1, bounds: { x: -800, y: 0, width: 800, height: 1200 }, workArea: { x: -800, y: 0, width: 800, height: 1160 } }] });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const bubble = fixture.windowFor('bubble');
  const open = () => {
    fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 1 });
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'codex', height: 180 });
    assert.ok(paintedCardBounds(bubble).x >= -800);
    assert.ok(paintedCardBounds(bubble).x + paintedCardBounds(bubble).width <= 0);
  };
  open();
  assert.ok(sentPayload(bubble, 'bubble').cardWidth < 280);
  fixture.settings.edgeDockFloatingX = 0.1;
  fixture.controller.sync();
  open();
  assert.equal(sentPayload(bubble, 'bubble').side, 'left');
  assert.ok(paintedCardBounds(bubble).x > rail.bounds.x);
  fixture.settings.edgeDockFloatingX = 0.9;
  fixture.controller.sync();
  open();
  assert.equal(sentPayload(bubble, 'bubble').side, 'right');
  assert.ok(paintedCardBounds(bubble).x < rail.bounds.x);
});

test('Windows drag frames follow the native cursor between polls and reject stale or foreign frames', (t) => {
  const advance = mockDockClock(t);
  let down = true;
  const fixture = createFixture({ primaryButtonDown: () => down });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const emitFrame = (win, gestureId) => fixture.ipcMain.emit('edgeDock:dragFrame', { sender: win.webContents }, { gestureId });
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetX: 20, grabOffsetY: 30, gestureId: 7 });
  const saved = rail.getBounds();
  advance(4);
  fixture.screen.point = { x: 700, y: 300 };
  emitFrame(rail, 6);
  emitFrame(fixture.windowFor('peek'), 7);
  assert.deepEqual(rail.getBounds(), saved);
  emitFrame(rail, 7);
  assert.equal(rail.bounds.x, 680, 'a frame moves the rail before the 16ms poll');
  advance(4);
  fixture.screen.point = { x: 500, y: 400 };
  emitFrame(rail, 7);
  assert.equal(rail.bounds.x, 480, 'high refresh displays are not limited to the poll rate');
  advance(100);
  down = false;
  fixture.screen.point = { x: 20, y: 500 };
  emitFrame(rail, 7);
  assert.equal(rail.bounds.x, 0);
  assert.equal(fixture.placements.length, 1, 'native release saves the final position');
  fixture.screen.point = { x: 900, y: 300 };
  emitFrame(rail, 7);
  assert.equal(rail.bounds.x, 0, 'queued frames cannot move a completed gesture');
  assert.equal(fixture.placements.length, 1);
});

test('Windows card switches follow renderer frames and reject stale motion ids', (t) => {
  const advance = mockDockClock(t);
  const fixture = createFixture({ platform: 'win32', prefersReducedMotion: () => false });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail'), card = fixture.windowFor('bubble');
  const open = (cellIndex, cellId, height) => {
    const layout = sentPayload(rail, 'rail').cellLayout;
    fixture.screen.point = { x: rail.bounds.x + rail.bounds.width / 2, y: rail.bounds.y + layout.tops[cellIndex] + layout.heights[cellIndex] / 2 };
    fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex });
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: card.webContents }, { cellId, height });
  };
  const emitFrame = (win, motionId) => fixture.ipcMain.emit('edgeDock:cardFrame', { sender: win.webContents }, { motionId });

  open(0, 'claude', 180);
  advance(160);
  open(2, 'cursor', 300);
  const start = card.webContents.messages.filter(message => message.channel === 'edgeDock:cardMotion').at(-1)?.payload;
  assert.equal(start.active, true);
  assert.equal(typeof start.motionId, 'number');
  const paintedAtStart = paintedCardBounds(card);
  t.mock.timers.tick(8);
  emitFrame(card, start.motionId - 1);
  emitFrame(rail, start.motionId);
  assert.deepEqual(paintedCardBounds(card), paintedAtStart, 'stale or foreign renderer frames do nothing');
  emitFrame(card, start.motionId);
  assert.notDeepEqual(paintedCardBounds(card), paintedAtStart, 'a paint frame advances before the main timer');

  advance(720);
  const stop = card.webContents.messages.filter(message => message.channel === 'edgeDock:cardMotion').at(-1)?.payload;
  assert.deepEqual(stop, { motionId: start.motionId, active: false });
  const settled = paintedCardBounds(card);
  t.mock.timers.tick(8);
  emitFrame(card, start.motionId);
  assert.deepEqual(paintedCardBounds(card), settled, 'frames queued after completion cannot restart the spring');
});

test('native release finishes a held drag at its final location and acknowledges its gesture', (t) => {
  const advance = mockDockClock(t);
  let down = true;
  const fixture = createFixture({ primaryButtonDown: () => down });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  fixture.screen.point = { x: 700, y: 300 };
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetX: 20, grabOffsetY: 30, gestureId: 7 });
  advance(100);
  assert.equal(rail.bounds.x, 680);
  assert.equal(fixture.placements.length, 0);
  fixture.screen.point = { x: 500, y: 400 };
  advance(32);
  assert.equal(rail.bounds.x, 480);
  fixture.screen.point = { x: 20, y: 500 };
  down = false;
  advance(32);
  assert.equal(rail.bounds.x, 0);
  assert.equal(fixture.placements.at(-1).floatingX, null);
  assert.equal(rail.webContents.messages.filter(entry => entry.channel === 'edgeDock:dragEnded').at(-1).payload.gestureId, 7);
});

test('detaching morphs the shared silhouette over several frames without rebuilding rail content', (t) => {
  const advance = mockDockClock(t);
  const fixture = createFixture({ prefersReducedMotion: () => false });
  t.after(() => fixture.controller.stop());
  advance(200);
  const rail = fixture.windowFor('rail');
  const attached = sentPayload(rail, 'rail').shape.d;
  const before = rail.webContents.messages.filter(entry => entry.channel === 'edgeDock:render').length;
  fixture.screen.point = { x: 600, y: 300 };
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetX: 20, grabOffsetY: 30 });
  advance(32);
  const frames = () => rail.webContents.messages.filter(entry => entry.channel === 'edgeDock:shapeFrame');
  assert.ok(frames().length > 0);
  const intermediate = frames().at(-1).payload.shape.d;
  assert.notEqual(intermediate, attached);
  advance(200);
  const final = sentPayload(rail, 'rail').shape.d;
  assert.notEqual(final, intermediate);
  assert.ok(frames().length >= 5);
  const renders = rail.webContents.messages.filter(entry => entry.channel === 'edgeDock:render').length - before;
  assert.ok(renders <= 3, `${renders} content renders for the whole morph`);
  fixture.ipcMain.emit('edgeDock:dragEnd', { sender: rail.webContents });
  fixture.screen.point = { x: 1190, y: 300 };
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetX: 20, grabOffsetY: 30 });
  advance(32);
  assert.ok(rail.bounds.x > 580 && rail.bounds.x < 1136, 'snap moves through intermediate positions');
  advance(200);
  assert.equal(rail.bounds.x, 1136);
  assert.equal(sentPayload(rail, 'rail').shape.d, attached);
});

test('stopping a morph cancels its native window updates', (t) => {
  const advance = mockDockClock(t);
  const fixture = createFixture({ prefersReducedMotion: () => false });
  const rail = fixture.windowFor('rail');
  fixture.screen.point = { x: 600, y: 300 };
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetY: 30 });
  advance(32);
  fixture.controller.stop();
  const messages = rail.webContents.messages.length;
  advance(300);
  assert.equal(rail.webContents.messages.length, messages);
});

for (const initialButtonState of [null, true]) {
  test(`capture loss with unreadable native state cancels an outside-work-area drag (${initialButtonState})`, (t) => {
    const advance = mockDockClock(t);
    let down = initialButtonState;
    const fixture = createFixture({ primaryButtonDown: () => down });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    const savedBounds = { ...rail.bounds };
    fixture.screen.point = { x: 600, y: 300 };
    fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetX: 20, grabOffsetY: 30, gestureId: 9 });
    advance(100);
    assert.equal(rail.bounds.x, 580);
    // A menu-bar release produces no further renderer pointerup/pointermove.
    fixture.screen.point = { x: 600, y: -20 };
    advance(32);
    assert.ok(fixture.screen.point.y < rail.bounds.y, 'work-area clamping leaves the cursor outside the rail');
    fixture.ipcMain.emit('edgeDock:dragCaptureLost', { sender: rail.webContents }, { gestureId: 8 });
    advance(32);
    assert.equal(rail.webContents.messages.filter(entry => entry.channel === 'edgeDock:dragEnded').length, 0, 'stale capture loss cannot cancel a newer drag');
    fixture.ipcMain.emit('edgeDock:dragCaptureLost', { sender: rail.webContents }, { gestureId: 9 });
    if (down === true) {
      advance(32);
      assert.equal(rail.webContents.messages.filter(entry => entry.channel === 'edgeDock:dragEnded').length, 0, 'known held button continues despite capture loss');
      down = null;
    }
    advance(32);
    assert.deepEqual(rail.bounds, savedBounds, 'cancel restores the last saved placement');
    assert.equal(fixture.placements.length, 0, 'unknown release must not commit a new placement');
    assert.deepEqual(rail.webContents.messages.filter(entry => entry.channel === 'edgeDock:dragEnded').at(-1)?.payload, { gestureId: 9, cancelled: true });
    fixture.screen.point = { x: 300, y: 600 };
    advance(1000);
    assert.deepEqual(rail.bounds, savedBounds, 'the rail no longer follows the cursor without renderer events');
  });
}

test('cancelling mid-morph restores the renderer shape even when it matches the cached pre-drag payload', (t) => {
  const advance = mockDockClock(t);
  const fixture = createFixture({ prefersReducedMotion: () => false, primaryButtonDown: () => null });
  t.after(() => fixture.controller.stop());
  advance(200);
  const rail = fixture.windowFor('rail');
  const attached = sentPayload(rail, 'rail').shape.d;
  const paintedShape = () => rail.webContents.messages.filter(entry => ['edgeDock:render', 'edgeDock:shapeFrame'].includes(entry.channel)).at(-1).payload.shape.d;
  fixture.screen.point = { x: 600, y: 300 };
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetX: 20, grabOffsetY: 30, gestureId: 10 });
  advance(64);
  assert.notEqual(paintedShape(), attached, 'the renderer received an intermediate frame');
  fixture.ipcMain.emit('edgeDock:dragCaptureLost', { sender: rail.webContents }, { gestureId: 10 });
  assert.equal(paintedShape(), attached, 'cancellation must deliver the restored shape, not retain the last frame');
  advance(300);
  assert.equal(paintedShape(), attached, 'a stopped morph cannot repaint an intermediate shape later');
});

for (const railX of [350, 800]) {
  test(`floating refresh preserves the bottom-centred design beside an open last-cell card (x=${railX})`, (t) => {
    const advance = mockDockClock(t);
    const fixture = createFixture({
      canRefreshLimits: () => true,
      settings: { edgeDockFloatingX: (railX - 8) / 1120 },
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1200, height: 800 }, workArea: { x: 0, y: 0, width: 1200, height: 800 } }]
    });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    const bubble = fixture.windowFor('bubble');
    const refresh = fixture.windowFor('peek');
    fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 211 };
    advance(100);
    fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 2 });
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: bubble.webContents }, { cellId: 'cursor', height: 180 });
    fixture.paintPeek();
    assert.equal(refresh.ignoreMouse, false, 'refresh is actually shown');
    assert.equal(bubble.opacity, 1, 'the last-cell card is actually shown');
    assert.equal(refresh.bounds.x + refresh.bounds.width / 2, rail.bounds.x + rail.bounds.width / 2);
    assert.equal(refresh.bounds.y, rail.bounds.y + rail.bounds.height - Math.round(EDGE_DOCK_METRICS.shoulder * 0.7) + EDGE_DOCK_METRICS.refreshGap);
    assert.ok(refresh.bounds.x + refresh.bounds.width <= paintedCardBounds(bubble).x || paintedCardBounds(bubble).x + paintedCardBounds(bubble).width <= refresh.bounds.x, 'bottom refresh and the side-opening card cannot overlap');
  });
}

for (const buttonState of [true, false, null]) {
  test(`renderer pointercancel defers placement to native button state (${buttonState})`, (t) => {
    const advance = mockDockClock(t);
    let down = true;
    const fixture = createFixture({ primaryButtonDown: () => down });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    const saved = { ...rail.bounds };
    const handlers = new Map();
    const node = { addEventListener: (name, fn) => handlers.set(name, fn), setPointerCapture() {}, classList: { add() {}, remove() {} } };
    const dock = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
    const source = dock.slice(dock.indexOf('let gesture = null;'), dock.indexOf('function indexFromTarget('));
    const emit = (channel, payload) => fixture.ipcMain.emit(channel, { sender: rail.webContents }, payload);
    let acknowledge;
    Function('bridge', 'railNode', 'indexFromTarget', 'DRAG_THRESHOLD_PX', 'state', `${source}; bindRailGestures(railNode);`)(
      {
        dragStart: (grabOffsetY, grabOffsetX, gestureId) => emit('edgeDock:dragStart', { grabOffsetY, grabOffsetX, gestureId }),
        dragEnd: () => emit('edgeDock:dragEnd'),
        dragCaptureLost: (gestureId) => emit('edgeDock:dragCaptureLost', { gestureId }),
        onDragEnded: (fn) => { acknowledge = fn; }
      }, node, () => 0, 5, { payload: { platform: 'darwin' } });
    const event = { button: 0, buttons: 1, pointerId: 1, screenX: rail.bounds.x + 20, screenY: rail.bounds.y + 30, clientX: 20, clientY: 30 };
    handlers.get('pointerdown')(event);
    fixture.screen.point = { x: 600, y: 300 };
    handlers.get('pointermove')({ ...event, screenX: 600, screenY: 300 });
    advance(100);
    assert.notDeepEqual(rail.bounds, saved);
    down = buttonState;
    handlers.get('pointercancel')({ ...event, type: 'pointercancel' });
    handlers.get('lostpointercapture')({ ...event, type: 'lostpointercapture' });
    assert.equal(fixture.placements.length, 0, 'cancellation itself cannot commit a placement');
    if (down === true) {
      advance(100);
      assert.equal(fixture.placements.length, 0, 'a held native button continues tracking');
      fixture.screen.point = { x: 700, y: 400 };
      down = false;
    }
    advance(100);
    const ended = rail.webContents.messages.filter(entry => entry.channel === 'edgeDock:dragEnded').at(-1)?.payload;
    assert.ok(ended, 'main acknowledges completion without further renderer input');
    acknowledge(ended);
    if (buttonState === null) {
      assert.deepEqual(rail.bounds, saved, 'unreadable native state restores persisted placement');
      assert.equal(fixture.placements.length, 0);
      assert.equal(ended.cancelled, true);
    } else {
      assert.equal(fixture.placements.length, 1, 'only confirmed native release saves once');
      assert.equal(rail.bounds.x, buttonState === true ? 680 : 580);
    }
    handlers.get('pointerup')({ ...event, type: 'pointerup' });
    assert.equal(fixture.placements.length, buttonState === null ? 0 : 1, 'acknowledged gesture cannot save again');
  });
}

for (const direction of ['detach', 'redock']) {
  test(`refresh waits for ${direction} morph completion before returning below the rail`, (t) => {
    const advance = mockDockClock(t);
    const fixture = createFixture({
      canRefreshLimits: () => true,
      prefersReducedMotion: () => false,
      primaryButtonDown: () => true,
      settings: { edgeDockFloatingX: direction === 'redock' ? 0.5 : null }
    });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    const refresh = fixture.windowFor('peek');
    fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 60 };
    advance(120);
    fixture.paintPeek();
    advance(160);
    assert.equal(refresh.ignoreMouse, false);
    assert.equal(refresh.opacity, 1, 'start with a fully painted refresh so its fade-out is exercised');
    fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetX: 32, grabOffsetY: 60, gestureId: 11 });
    fixture.screen.point = { x: direction === 'redock' ? 1190 : 600, y: 300 };
    advance(32);
    fixture.ipcMain.emit('edgeDock:dragEnd', { sender: rail.webContents });
    advance(32);
    fixture.paintPeek();
    assert.equal(refresh.ignoreMouse, true, 'refresh cannot appear at the destination while the rail is still moving');
    assert.equal(refresh.opacity, 0, 'refresh is fully hidden during the morph');
    advance(220);
    fixture.paintPeek();
    advance(160);
    assert.equal(refresh.ignoreMouse, false, 'hovered refresh returns after the morph');
    assert.equal(refresh.opacity, 1);
    assert.equal(refresh.bounds.x + refresh.bounds.width / 2, rail.bounds.x + rail.bounds.width / 2);
    assert.equal(refresh.bounds.y, rail.bounds.y + rail.bounds.height - Math.round(EDGE_DOCK_METRICS.shoulder * 0.7) + EDGE_DOCK_METRICS.refreshGap);
  });
}

for (const scale of [0.85, 1, 1.25]) {
  test(`macOS floating rail only captures its painted capsule at scale ${scale}`, (t) => {
    const advance = mockDockClock(t);
    const fixture = createFixture({ platform: 'darwin', settings: { edgeDockFloatingX: 0.5, edgeDockSize: 'custom', edgeDockCustomScale: scale } });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    const m = scaledEdgeDockMetrics(scale);
    const at = (x, y, sender = rail.webContents) => {
      fixture.screen.point = { x: rail.bounds.x + x, y: rail.bounds.y + y };
      fixture.ipcMain.emit('edgeDock:pointer', { sender });
    };
    assert.equal(rail.ignoreMouse, true, 'a visible floating window initially leaves background input alone');
    assert.equal(rail.forwardMouse, true, 'forward moves so entering the capsule can capture without waiting for a poll');
    const transparent = [
      [rail.bounds.width / 2, m.shoulder / 2],
      [rail.bounds.width / 2, rail.bounds.height - m.shoulder / 2],
      [2, m.shoulder + 2], [rail.bounds.width - 2, m.shoulder + 2],
      [2, rail.bounds.height - m.shoulder - 2], [rail.bounds.width - 2, rail.bounds.height - m.shoulder - 2]
    ];
    for (const [x, y] of transparent) {
      at(rail.bounds.width / 2, rail.bounds.height / 2);
      assert.equal(rail.ignoreMouse, false, 'the visible body takes input');
      at(x, y);
      assert.equal(rail.ignoreMouse, true, `transparent point ${x},${y} passes clicks and wheel through`);
      assert.equal(rail.forwardMouse, true);
    }
    at(rail.bounds.width / 2, rail.bounds.height / 2, fixture.windowFor('bubble').webContents);
    assert.equal(rail.ignoreMouse, true, 'another surface cannot capture the rail');
    advance(100);
    assert.equal(rail.ignoreMouse, false, 'the existing cursor poll also recovers capture');
    fixture.controller.sync();
    assert.equal(rail.ignoreMouse, false, 'ordinary settings/render sync preserves painted input');
    at(rail.bounds.width / 2, m.shoulder / 2);
    fixture.controller.sync();
    assert.equal(rail.ignoreMouse, true, 'ordinary settings/render sync cannot recapture transparent input');
  });
}

test('macOS floating capture stays active through a drag and resumes silhouette hit testing after cancellation', (t) => {
  const advance = mockDockClock(t);
  const fixture = createFixture({ platform: 'darwin', primaryButtonDown: () => null, settings: { edgeDockFloatingX: 0.5 } });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 60 };
  fixture.ipcMain.emit('edgeDock:pointer', { sender: rail.webContents });
  assert.equal(rail.ignoreMouse, false);
  fixture.ipcMain.emit('edgeDock:dragStart', { sender: rail.webContents }, { grabOffsetX: 32, grabOffsetY: 60, gestureId: 31 });
  fixture.screen.point = { x: 650, y: -20 };
  advance(32);
  fixture.ipcMain.emit('edgeDock:pointer', { sender: rail.webContents });
  assert.equal(rail.ignoreMouse, false, 'drag capture survives a pointer outside the painted rail');
  fixture.ipcMain.emit('edgeDock:dragCaptureLost', { sender: rail.webContents }, { gestureId: 31 });
  assert.equal(fixture.placements.length, 0);
  assert.equal(rail.ignoreMouse, true, 'cancelled drag restores click-through at the saved capsule');
  fixture.screen.point = { x: rail.bounds.x + 32, y: rail.bounds.y + 60 };
  fixture.ipcMain.emit('edgeDock:pointer', { sender: rail.webContents });
  assert.equal(rail.ignoreMouse, false, 'the restored capsule can be clicked again');
});

test('macOS floating rail retains a held press before the renderer crosses its drag threshold', (t) => {
  let down = false;
  const fixture = createFixture({ platform: 'darwin', primaryButtonDown: () => down, settings: { edgeDockFloatingX: 0.5 } });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail');
  const report = (x) => {
    fixture.screen.point = { x: rail.bounds.x + x, y: rail.bounds.y + 60 };
    fixture.ipcMain.emit('edgeDock:pointer', { sender: rail.webContents });
  };
  report(2);
  assert.equal(rail.ignoreMouse, false);
  down = true;
  report(-2);
  assert.equal(rail.ignoreMouse, false, 'a 4px move outside the outline must not lose the press before dragStart');
  down = false;
  report(-2);
  assert.equal(rail.ignoreMouse, true, 'release outside returns control to the background');
});


for (const side of ['left', 'right']) {
  test(`detail card switches animate native geometry without delaying content (${side})`, (t) => {
    const advance = mockDockClock(t);
    const fixture = createFixture({ platform: 'darwin', nativeGlass: true, prefersReducedMotion: () => false, settings: { edgeDockSide: side } });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail'), card = fixture.windowFor('bubble');
    const open = (cellIndex, cellId, height) => {
      const layout = sentPayload(rail, 'rail').cellLayout;
      fixture.screen.point = { x: rail.bounds.x + rail.bounds.width / 2, y: rail.bounds.y + layout.tops[cellIndex] + layout.heights[cellIndex] / 2 };
      fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex });
      fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: card.webContents }, { cellId, height });
    };
    open(0, 'claude', 180);
    advance(160);
    const from = paintedCardBounds(card), canvas = card.getBounds();
    const opacity = card.opacity;
    open(2, 'cursor', 300);
    assert.deepEqual(paintedCardBounds(card), from, 'switch starts at the painted position, not the destination');
    assert.equal(sentPayload(card, 'bubble').cell.id, 'cursor', 'new content is acknowledged immediately');
    assert.deepEqual(sentPayload(card, 'bubble').placed, { cellId: 'cursor', height: 300 });
    const renders = card.webContents.messages.filter(m => m.channel === 'edgeDock:render').length;
    advance(48);
    const middle = paintedCardBounds(card);
    const contentTarget = card.webContents.messages.at(-1).payload.shape.contentTarget;
    assert.equal(contentTarget.height, 300, 'the content keeps its natural destination height while the outline resizes');
    assert.notEqual(contentTarget.y, middle.y - canvas.y, 'content is not pinned to the moving top edge');
    advance(16);
    assert.deepEqual(card.webContents.messages.at(-1).payload.shape.contentTarget, contentTarget, 'outline frames do not move the destination layout');
    const retargetFrom = paintedCardBounds(card);
    assert.ok(middle.height > from.height && middle.height < 300);
    assert.notEqual(middle.y, from.y);
    assert.deepEqual(card.getBounds(), canvas, 'the native canvas does not move or resize while its card moves');
    assert.equal(card.opacity, opacity, 'no fade-out or hidden interval');
    assert.equal(card.webContents.messages.filter(m => m.channel === 'edgeDock:render').length, renders, 'animation does not rebuild content');
    assert.ok(card.webContents.messages.some(m => m.channel === 'edgeDock:shapeFrame'));
    const masks = fixture.maskWindows.length;
    open(1, 'codex', 220);
    assert.deepEqual(paintedCardBounds(card), retargetFrom, 'rapid switch retargets from the current frame');
    advance(720);
    const final = paintedCardBounds(card);
    assert.equal(final.height, 220);
    assert.equal(sentPayload(card, 'bubble').cell.id, 'codex');
    assert.ok(fixture.maskWindows.length > masks, 'native material follows the animated silhouette');
    const frames = card.webContents.messages.filter(m => m.channel === 'edgeDock:shapeFrame').length;
    fixture.screen.point = { x: final.x + 20, y: final.y + 20 };
    advance(160);
    assert.equal(card.webContents.messages.filter(m => m.channel === 'edgeDock:shapeFrame').length, frames, 'animation stops at its destination');
  });
}

for (const side of ['left', 'right']) {
  test(`distant short cards and rapid reversals animate continuously (${side})`, (t) => {
    const advance = mockDockClock(t);
    const fixture = createFixture({ prefersReducedMotion: () => false, settings: { edgeDockSide: side } });
    t.after(() => fixture.controller.stop());
    fixture.controller.setCells(Array.from({ length: 8 }, (_, index) => ({ id: `short-${index}`, kind: 'provider' })));
    const rail = fixture.windowFor('rail'), card = fixture.windowFor('bubble');
    const open = (cellIndex) => {
      const layout = sentPayload(rail, 'rail').cellLayout;
      fixture.screen.point = { x: rail.bounds.x + rail.bounds.width / 2, y: rail.bounds.y + layout.tops[cellIndex] + layout.heights[cellIndex] / 2 };
      fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex });
      fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: card.webContents }, { cellId: `short-${cellIndex}`, height: 160 });
    };
    open(0);
    advance(160);
    const canvas = card.getBounds();
    for (const next of [7, 0, 5, 2, 7]) {
      const previous = paintedCardBounds(card);
      open(next);
      assert.deepEqual(paintedCardBounds(card), previous, 'every selection starts at the current painted position');
      const target = sentPayload(card, 'bubble').shape.contentTarget;
      advance(48);
      assert.notEqual(paintedCardBounds(card).y, previous.y, 'distant cards also move instead of jumping');
      advance(720);
      assert.equal(paintedCardBounds(card).y, canvas.y + target.y);
    }
    open(0);advance(32);
    const moving = paintedCardBounds(card);
    open(7);
    assert.deepEqual(paintedCardBounds(card), moving, 'rapid reversal retains position continuity');
    advance(720);
    assert.deepEqual(card.getBounds(), canvas, 'the native canvas remains fixed');
  });
}

test('detail card motion stops on dismissal and reduced motion switches directly', (t) => {
  const advance = mockDockClock(t);
  let reduced = false;
  const fixture = createFixture({ prefersReducedMotion: () => reduced });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail'), card = fixture.windowFor('bubble');
  const open = (cellIndex, cellId, height) => {
    const layout = sentPayload(rail, 'rail').cellLayout;
    fixture.screen.point = { x: rail.bounds.x + rail.bounds.width / 2, y: rail.bounds.y + layout.tops[cellIndex] + layout.heights[cellIndex] / 2 };
    fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex });
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: card.webContents }, { cellId, height });
  };
  open(0, 'claude', 180);
  advance(160);
  open(2, 'cursor', 300);
  advance(32);
  fixture.screen.point = { x: 600, y: 800 };
  fixture.ipcMain.emit('edgeDock:dismiss', { sender: card.webContents });
  const dismissed = paintedCardBounds(card);
  advance(160);
  assert.deepEqual(paintedCardBounds(card), dismissed, 'dismissal cancels native movement');
  reduced = true;
  open(0, 'claude', 180);
  advance(160);
  const frames = card.webContents.messages.filter(m => m.channel === 'edgeDock:shapeFrame').length;
  open(2, 'cursor', 300);
  assert.equal(paintedCardBounds(card).height, 300);
  advance(160);
  assert.equal(card.webContents.messages.filter(m => m.channel === 'edgeDock:shapeFrame').length, frames);
});

test('rapid card reversal carries velocity instead of restarting from rest', (t) => {
  const advance = mockDockClock(t);
  const fixture = createFixture({ prefersReducedMotion: () => false });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail'), card = fixture.windowFor('bubble');
  const open = (cellIndex, cellId, height) => {
    const layout = sentPayload(rail, 'rail').cellLayout;
    fixture.screen.point = { x: rail.bounds.x + rail.bounds.width / 2, y: rail.bounds.y + layout.tops[cellIndex] + layout.heights[cellIndex] / 2 };
    fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex });
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: card.webContents }, { cellId, height });
  };
  open(0, 'claude', 180);
  advance(160);
  open(2, 'cursor', 300);
  advance(16);
  assert.equal(paintedCardBounds(card).height, 182, 'the first spring sample uses the initial resting velocity');
  advance(16);
  assert.equal(paintedCardBounds(card).height, 188);
  advance(16);
  const moving = paintedCardBounds(card).height;
  assert.equal(moving, 195);
  open(0, 'claude', 180);
  assert.equal(paintedCardBounds(card).height, moving, 'retargeting has no position discontinuity');
  advance(16);
  assert.equal(paintedCardBounds(card).height, 202, 'the retarget uses the sampled velocity once instead of feeding it back');
  advance(720);
  assert.equal(paintedCardBounds(card).height, 180, 'the spring settles at the latest destination');
});


test('macOS card canvas forwards background clicks outside the painted card and retains held input', (t) => {
  const advance = mockDockClock(t);
  let held = false;
  const fixture = createFixture({ platform: 'darwin', prefersReducedMotion: () => false, primaryButtonDown: () => held });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail'), card = fixture.windowFor('bubble');
  fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 0 });
  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: card.webContents }, { cellId: 'claude', height: 180 });
  const frame = paintedCardBounds(card);
  fixture.screen.point = { x: frame.x + 30, y: frame.y + 30 };
  fixture.ipcMain.emit('edgeDock:pointer', { sender: card.webContents });
  assert.equal(card.ignoreMouse, false, 'the painted card accepts input');
  held = true;
  fixture.screen.point = { x: frame.x + 30, y: card.bounds.y + 2 };
  fixture.ipcMain.emit('edgeDock:pointer', { sender: card.webContents });
  assert.equal(card.ignoreMouse, false, 'selection and scrollbar drags retain capture while held');
  held = false;
  advance(96);
  assert.equal(card.ignoreMouse, true, 'poll restores click-through after release without another pointer move');
  assert.equal(card.forwardMouse, true, 'forwarded moves can restore capture promptly');
  fixture.screen.point = { x: frame.x + 30, y: frame.y + 30 };
  fixture.ipcMain.emit('edgeDock:pointer', { sender: card.webContents });
  assert.equal(card.ignoreMouse, false);
  advance(32);
});

for (const unavailable of [false, true]) {
  test(`Windows shape failure bounds the bubble and disables motion (missing: ${unavailable})`, (t) => {
    const advance = mockDockClock(t);
    const fixture = createFixture({ platform: 'win32', prefersReducedMotion: () => false, shapeFails: !unavailable });
    t.after(() => fixture.controller.stop());
    const rail = fixture.windowFor('rail');
    let card = fixture.windowFor('bubble');
    if (unavailable) card.setShape = undefined;
    fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 0 });
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: card.webContents }, { cellId: 'claude', height: 180 });
    card = fixture.windowFor('bubble');
    card.webContents.emit('did-finish-load');
    assert.equal(card.getBounds().height, 180);
    assert.equal(sentPayload(card, 'bubble').shape.contentBounds.y, 0);
    assert.equal(FakeBrowserWindow.atPoint({ x: card.bounds.x + 20, y: card.bounds.y - 20 }), undefined, 'background above the card remains reachable');
    fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 2 });
    fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: card.webContents }, { cellId: 'cursor', height: 240 });
    assert.equal(card.getBounds().height, 240);
    const bounds = card.getBounds();
    advance(48);
    assert.deepEqual(card.getBounds(), bounds, 'fallback switches directly without a large animation canvas');
  });
}

test('Windows recreates a shaped bubble when both updating and clearing its region fail', t => {
  const advance = mockDockClock(t);
  const fixture = createFixture({ platform: 'win32', prefersReducedMotion: () => false });
  t.after(() => fixture.controller.stop());
  const rail = fixture.windowFor('rail'), old = fixture.windowFor('bubble');
  fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 0 });
  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: old.webContents }, { cellId: 'claude', height: 180 });
  assert.ok(old.region?.length, 'a native region was previously accepted');
  FakeBrowserWindow.shapeFails = true;
  fixture.ipcMain.emit('edgeDock:click', { sender: rail.webContents }, { cellIndex: 2 });
  fixture.ipcMain.emit('edgeDock:bubbleSize', { sender: old.webContents }, { cellId: 'cursor', height: 240 });
  const replacement = fixture.windowFor('bubble');
  assert.notEqual(replacement, old, 'the failed old region must not remain attached');
  assert.equal(old.destroyed, true);
  replacement.webContents.emit('did-finish-load');
  assert.equal(replacement.region, undefined);
  assert.equal(replacement.bounds.height, 240);
  assert.equal(sentPayload(replacement, 'bubble').cell.id, 'cursor');
  assert.equal(FakeBrowserWindow.atPoint({ x: replacement.bounds.x + 20, y: replacement.bounds.y + 20 }), replacement);
  assert.equal(FakeBrowserWindow.atPoint({ x: replacement.bounds.x + 20, y: replacement.bounds.y - 20 }), undefined);
  const bounds = replacement.getBounds();
  advance(48);
  assert.deepEqual(replacement.getBounds(), bounds, 'a motion cancelled during its first frame must not restart a timer');
  advance(720);
  assert.deepEqual(replacement.getBounds(), bounds, 'the rectangular fallback stays fixed after the old spring deadline');
});
