'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { handoffWindow } = require('../../src/electron/windowLifecycle');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
function functionSource(name, next) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, source.indexOf(next, start));
}

class Window extends EventEmitter {
  constructor(state = {}) { super(); Object.assign(this, { visible: true, focused: false, minimized: false, bounds: { x: 20, y: 30, width: 400, height: 600 } }, state); }
  isDestroyed() { return this.destroyed === true; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  isMinimized() { return this.minimized; }
  getBounds() { return this.bounds; }
  focus() { this.focused = true; }
  show() { this.visible = true; this.emit('show'); }
  minimize() { this.minimized = true; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

function fixture(state = {}) {
  const old = new Window(state);
  old.webContents = { draft: 'unfinished input', scroll: 85 };
  const creations = [];
  const context = {
    process: { platform: 'win32' }, mainWindow: old, settings: {}, floatingBubbleState: { collapsed: false }, creations,
    mainWindowChrome: { collapsedFloatingBubble: false }, mainWindowReplacementEpoch: 0,
    mainWindowReplacementTask: Promise.resolve(),
    captureRetainedWindowState: async () => {}, restoreRetainedWindowState: async () => {},
    windowsBackdropFallback: () => false,
    stopFloatingBubbleAutoCollapseTimer() {}, displayForBounds: () => null,
    applyNativeMaterial() {}, persistWindowBounds() {}, WINDOW_LIMITS: {},
    restoreFloatingBubbleWindow(win, bounds) { win.bounds = bounds; },
    applyWindowSettings() {}, setTimeout: () => 0,
    console: { warn() {} },
    handoffWindow, sendFloatingBubbleState() {},
    restoreWindowMaximized(win) { win.maximized = context.settings.windowMaximized === true; },
    revealWindow(win, options) { win.visible = true; if (!options.inactive) win.focus(); },
    createWindow(bounds, options) {
      creations.push({ bounds, options });
      context.mainWindow = new Window({ bounds, visible: false });
      context.mainWindowChrome = { collapsedFloatingBubble: options.collapsedFloatingBubble === true };
      context.mainWindow.webContents = options.previousWindow?.webContents || {};
    }
  };
  vm.createContext(context);
  vm.runInContext(functionSource('replaceMainWindow', 'function discardFailedDashboardWindow('), context);
  vm.runInContext(functionSource('expandFloatingBubble', 'function scheduleFloatingBubbleAutoCollapse('), context);
  return { context, old, creations };
}

test('visible host replacement retains the page and focus, including maximized restore', async () => {
  const { context, old, creations } = fixture({ focused: true });
  context.settings.windowMaximized = true;
  await context.replaceMainWindow(old.bounds, { focus: true });
  assert.equal(creations[0].options.previousWindow, old);
  assert.equal(context.mainWindow.webContents, old.webContents);
  assert.equal(context.mainWindow.maximized, true);
  assert.equal(context.mainWindow.focused, true);
  assert.equal(old.destroyed, true);
});

test('an in-place expansion cancels a collapse awaiting viewport capture', async () => {
  const { context, old, creations } = fixture();
  context.floatingBubbleState = { collapsed: true, expandedBounds: old.bounds };
  let finishCapture;
  context.captureRetainedWindowState = () => new Promise(resolve => { finishCapture = resolve; });
  let restored = 0;
  context.restoreRetainedWindowState = async () => { restored++; };
  const collapse = context.replaceMainWindow({ width: 18, height: 34 }, { collapsedFloatingBubble: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.expandFloatingBubble({ focus: false }), true);
  finishCapture();
  await collapse;
  assert.equal(context.floatingBubbleState.collapsed, false);
  assert.equal(context.mainWindow, old);
  assert.equal(creations.length, 0);
  assert.equal(restored, 1, 'cancelled captures must release the transfer snapshot');
});

test('viewport capture failure does not abandon an already-requested collapse', async () => {
  const { context, creations } = fixture();
  context.floatingBubbleState.collapsed = true;
  context.captureRetainedWindowState = async () => { throw new Error('page navigating'); };
  await context.replaceMainWindow({ width: 18, height: 34 }, { collapsedFloatingBubble: true });
  assert.equal(creations.length, 1);
  assert.equal(context.mainWindowChrome.collapsedFloatingBubble, true);
});

test('hidden and minimized hosts stay hidden or minimized and release obsolete hosts immediately', async () => {
  for (const state of [{ visible: false }, { minimized: true }]) {
    const { context, old } = fixture(state);
    await context.replaceMainWindow(old.bounds);
    assert.equal(context.mainWindow.visible, false);
    assert.equal(context.mainWindow.minimized, state.minimized === true);
    assert.equal(context.mainWindow.focused, false);
    assert.equal(old.destroyed, true);
  }
});

test('replacing a bubble frame preserves its saved expanded bounds and page', async () => {
  const { context, old, creations } = fixture({ bounds: { x: 20, y: 30, width: 18, height: 34 } });
  const bubble = { collapsed: true, side: 'left', expandedBounds: { x: 20, y: 30, width: 400, height: 600 } };
  context.floatingBubbleState = bubble;
  await context.replaceMainWindow(old.bounds, { collapsedFloatingBubble: true });
  assert.equal(context.floatingBubbleState, bubble);
  assert.equal(bubble.collapsed, true);
  assert.equal(bubble.side, 'left');
  assert.equal(creations[0].bounds, old.bounds);
  assert.equal(creations[0].options.collapsedFloatingBubble, true);
  assert.equal(context.mainWindow.webContents, old.webContents);
});

test('rapid requests keep only the latest host and wait for the preceding viewport restore', async () => {
  const { context, creations } = fixture();
  const first = context.replaceMainWindow({ width: 18, height: 34 }, { collapsedFloatingBubble: true });
  const second = context.replaceMainWindow({ width: 400, height: 600 });
  await Promise.all([first, second]);
  assert.equal(creations.length, 1);
  assert.equal(creations[0].bounds.width, 400);

  let finishRestore;
  context.restoreRetainedWindowState = () => new Promise(resolve => { finishRestore = resolve; });
  const third = context.replaceMainWindow({ width: 500, height: 600 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creations.length, 2);
  const fourth = context.replaceMainWindow({ width: 600, height: 600 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creations.length, 2, 'a new capture must wait until the previous viewport is restored');
  context.restoreRetainedWindowState = async () => {};
  finishRestore();
  await Promise.all([third, fourth]);
  assert.equal(creations.length, 3);
  assert.equal(creations[2].bounds.width, 600);
});
