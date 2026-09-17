'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  boundsOnDisplay,
  expandedBoundsForCollapse,
  isWindowMaximized,
  normalWindowBounds,
  persistWindowState,
  rebuildWindowBounds,
  restoreWindowMaximized,
  restoreWindowMaximizedForReveal,
  setWindowMaximizable,
  shouldPersistWindowBounds,
  shouldRestoreWindowMaximized,
  shouldTrackWindowMaximized,
  suspendWindowMaximized
} = require('../../src/electron/windowState');
const { floatingBubbleCollapsePlan } = require('../../src/electron/floatingBubble');

function fakeWindow(state = {}) {
  const bounds = state.bounds || { x: 20, y: 30, width: 340, height: 650 };
  const normalBounds = state.normalBounds || { x: 40, y: 50, width: 360, height: 700 };
  return {
    getBounds: () => bounds,
    getNormalBounds: () => normalBounds,
    isDestroyed: () => state.destroyed === true,
    isFullScreen: () => state.fullScreen === true,
    isFocused: () => state.focused === true,
    isMaximized: () => state.maximized === true,
    isMinimized: () => state.minimized === true,
    focus: () => { state.focused = true; },
    maximize: () => { state.maximized = true; },
    setMaximizable: (value) => { state.maximizable = value; },
    unmaximize: () => { state.maximized = false; }
  };
}

test('detects the native maximized state without assuming a platform', () => {
  assert.equal(isWindowMaximized(fakeWindow({ maximized: true })), true);
  assert.equal(isWindowMaximized(fakeWindow()), false);
  assert.equal(isWindowMaximized({}), false);
});

test('uses normal bounds while maximized and current bounds otherwise', () => {
  const normalBounds = { x: 40, y: 50, width: 360, height: 700 };
  const currentBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(normalWindowBounds(fakeWindow({ maximized: true, bounds: currentBounds, normalBounds })), normalBounds);
  assert.deepEqual(normalWindowBounds(fakeWindow({ bounds: currentBounds })), currentBounds);
  assert.equal(normalWindowBounds(fakeWindow({ minimized: true })), null);
  assert.equal(normalWindowBounds(fakeWindow({ fullScreen: true })), null);
});

test('does not persist bounds for minimized, fullscreen, or maximized windows', () => {
  assert.equal(shouldPersistWindowBounds(fakeWindow()), true);
  assert.equal(shouldPersistWindowBounds(fakeWindow({ minimized: true })), false);
  assert.equal(shouldPersistWindowBounds(fakeWindow({ fullScreen: true })), false);
  assert.equal(shouldPersistWindowBounds(fakeWindow({ maximized: true })), false);
});

test('restores persisted maximization except for collapsed floating bubbles', () => {
  assert.equal(shouldRestoreWindowMaximized({ windowMaximized: true }), true);
  assert.equal(shouldRestoreWindowMaximized({ windowMaximized: true, trayMode: true }), false);
  assert.equal(shouldRestoreWindowMaximized({ windowMaximized: true }, { collapsedFloatingBubble: true }), false);
  assert.equal(shouldRestoreWindowMaximized({ windowMaximized: false }), false);
});

test('restores maximization outside tray and collapsed modes', () => {
  const state = {};
  const window = fakeWindow(state);
  assert.equal(restoreWindowMaximized(window, { windowMaximized: true }), true);
  assert.equal(state.maximized, true);
  assert.equal(restoreWindowMaximized(window, { windowMaximized: true }), false);
  assert.equal(restoreWindowMaximized(fakeWindow(), { windowMaximized: true, trayMode: true }), false);
  assert.equal(restoreWindowMaximized(fakeWindow(), { windowMaximized: true }, { collapsedFloatingBubble: true }), false);
});

test('restores maximization and focuses a normal cold-start window', () => {
  const state = {};
  const window = fakeWindow(state);
  assert.equal(restoreWindowMaximizedForReveal(window, { windowMaximized: true }, { restoreMaximized: true }), true);
  assert.equal(state.maximized, true);
  assert.equal(state.focused, true);
});

test('does not focus an inactive maximized replacement window', () => {
  const state = {};
  const window = fakeWindow(state);
  assert.equal(restoreWindowMaximizedForReveal(window, { windowMaximized: true }, { restoreMaximized: true, inactive: true }), true);
  assert.equal(state.maximized, true);
  assert.equal(state.focused, undefined);
});

test('persists changed bounds and maximization state in one save', () => {
  const bounds = { x: 40, y: 50, width: 360, height: 700 };
  const settings = { windowBounds: null, windowMaximized: false };
  let saves = 0;
  const saveSettings = () => { saves += 1; };

  assert.equal(persistWindowState(settings, saveSettings, bounds, true), true);
  assert.deepEqual(settings.windowBounds, bounds);
  assert.equal(settings.windowMaximized, true);
  assert.equal(saves, 1);
  assert.equal(persistWindowState(settings, saveSettings, bounds, true), false);
  assert.equal(saves, 1);
  assert.equal(persistWindowState(settings, saveSettings, bounds, false), true);
  assert.equal(settings.windowMaximized, false);
  assert.equal(saves, 2);
});

test('keeps normal bounds across a maximized rebuild and unmaximize', () => {
  const normalBounds = { x: 40, y: 50, width: 360, height: 700 };
  const screenBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const oldWindow = fakeWindow({ maximized: true, bounds: screenBounds, normalBounds });
  const rebuiltBounds = rebuildWindowBounds(oldWindow);
  assert.deepEqual(rebuiltBounds, normalBounds);

  const rebuiltState = { bounds: rebuiltBounds, normalBounds: rebuiltBounds };
  const rebuiltWindow = fakeWindow(rebuiltState);
  const settings = { windowBounds: screenBounds, windowMaximized: true };
  let saves = 0;
  const saveSettings = () => { saves += 1; };

  assert.equal(restoreWindowMaximized(rebuiltWindow, settings), true);
  persistWindowState(settings, saveSettings, normalWindowBounds(rebuiltWindow), true);
  assert.deepEqual(settings.windowBounds, normalBounds);

  rebuiltState.maximized = false;
  persistWindowState(settings, saveSettings, normalWindowBounds(rebuiltWindow), false);
  assert.deepEqual(settings.windowBounds, normalBounds);
  assert.equal(settings.windowMaximized, false);
  assert.equal(saves, 2);
});

test('collapsing a maximized window remembers its normal bounds, not the screen', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const normalBounds = { x: 300, y: 200, width: 360, height: 700 };
  const screenBounds = { x: 0, y: 0, width: 1920, height: 1040 };
  const window = fakeWindow({ maximized: true, bounds: screenBounds, normalBounds });
  const settings = { floatingBubbleEnabled: true };

  // Mirrors maybeCollapseFloatingBubble(): the display still comes from the
  // window's current bounds, the remembered expanded bounds do not.
  const plan = floatingBubbleCollapsePlan(
    expandedBoundsForCollapse(window, screenBounds),
    workArea,
    settings,
    { collapsedArea: workArea }
  );

  assert.deepEqual(plan.expandedBounds, normalBounds);
  assert.notDeepEqual(plan.expandedBounds, screenBounds);
  assert.equal(expandedBoundsForCollapse(fakeWindow({ bounds: normalBounds }), screenBounds), normalBounds);
});

test('entering tray mode drops native maximization but keeps the saved flag', () => {
  const settings = { trayMode: true, windowMaximized: true, windowBounds: { x: 40, y: 50, width: 360, height: 700 } };
  const state = { maximized: true };
  const window = fakeWindow(state);

  assert.equal(suspendWindowMaximized(window), true);
  assert.equal(state.maximized, false);
  assert.equal(setWindowMaximizable(window, false), true);
  assert.equal(state.maximizable, false);
  // The unmaximize this fires is ignored, so the flag still describes the
  // window the user gets back when they leave tray mode.
  assert.equal(shouldTrackWindowMaximized(settings, {}), false);
  assert.equal(settings.windowMaximized, true);

  settings.trayMode = false;
  assert.equal(setWindowMaximizable(window, true), true);
  assert.equal(restoreWindowMaximized(window, settings), true);
  assert.equal(state.maximized, true);
});

test('tray and collapsed windows never rewrite the normal window state', () => {
  assert.equal(shouldTrackWindowMaximized({}, {}), true);
  assert.equal(shouldTrackWindowMaximized({ trayMode: true }, {}), false);
  assert.equal(shouldTrackWindowMaximized({}, { collapsed: true }), false);

  const windowBounds = { x: 40, y: 50, width: 360, height: 700 };
  const settings = { trayMode: true, windowMaximized: false, windowBounds };
  let saves = 0;
  const saveSettings = () => { saves += 1; };
  const state = { maximized: true, bounds: { x: 0, y: 0, width: 1920, height: 1040 } };
  const window = fakeWindow(state);

  // Mirrors the native handlers in createWindow().
  const onMaximize = () => {
    if (!shouldTrackWindowMaximized(settings, {})) {
      if (settings.trayMode) suspendWindowMaximized(window);
      return;
    }
    persistWindowState(settings, saveSettings, normalWindowBounds(window), true);
  };
  const onUnmaximize = () => {
    if (!shouldTrackWindowMaximized(settings, {})) return;
    persistWindowState(settings, saveSettings, normalWindowBounds(window), false);
  };

  onMaximize();
  onUnmaximize();
  assert.equal(state.maximized, false);
  assert.equal(saves, 0);
  assert.equal(settings.windowMaximized, false);
  assert.deepEqual(settings.windowBounds, windowBounds);
});

test('main.js keeps tray and collapsed windows off the normal window state path', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const collapse = main.match(/function maybeCollapseFloatingBubble[\s\S]*?\n}\n/)[0];
  const maximize = main.match(/win\.on\('maximize'[\s\S]*?\n {2}\}\);/)[0];
  const unmaximize = main.match(/win\.on\('unmaximize'[\s\S]*?\n {2}\}\);/)[0];
  const enterTray = main.match(/function enterTrayMode[\s\S]*?\n}\n/)[0];
  const exitTray = main.match(/function exitTrayMode[\s\S]*?\n}\n/)[0];

  assert.match(collapse, /floatingBubbleCollapsePlan\(expandedBoundsForCollapse\(mainWindow, bounds\)/);
  assert.match(maximize, /^[\s\S]*?if \(!shouldTrackWindowMaximized\(settings, floatingBubbleState\)\)[\s\S]*suspendWindowMaximized\(win\)[\s\S]*persistWindowState/);
  assert.match(unmaximize, /^[\s\S]*?if \(!shouldTrackWindowMaximized\(settings, floatingBubbleState\)\) return;[\s\S]*persistWindowState/);
  assert.match(enterTray, /suspendWindowMaximized\(mainWindow\)[\s\S]*setWindowMaximizable\(mainWindow, false\)/);
  assert.match(exitTray, /setWindowMaximizable\(mainWindow, true\)[\s\S]*restoreWindowMaximized\(mainWindow, settings\)/);
});

// The reporter's arrangement: a Retina laptop panel at the origin and a 1080p
// display above and to its left, so the second display's origin is negative on
// both axes.
const MAIN_DISPLAY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1470, height: 956 },
  workArea: { x: 0, y: 25, width: 1470, height: 906 }
};
const EXTERNAL_DISPLAY = {
  id: 2,
  bounds: { x: -220, y: -1080, width: 1920, height: 1080 },
  workArea: { x: -220, y: -1055, width: 1920, height: 1030 }
};

test('boundsOnDisplay keeps the window where it sat on the target display', () => {
  const moved = boundsOnDisplay(
    { x: 1072, y: 37, width: 349, height: 671 },
    MAIN_DISPLAY,
    EXTERNAL_DISPLAY
  );
  // Translated by the offset between the two origins (0,0) -> (-220,-1080), so a
  // window near the right edge of the laptop panel stays near the right edge of
  // the external one instead of being re-centred.
  assert.deepEqual(moved, { x: 852, y: -1043, width: 349, height: 671 });
});

test('boundsOnDisplay clamps a window that would land outside the work area', () => {
  const moved = boundsOnDisplay(
    { x: 1400, y: 900, width: 349, height: 671 },
    MAIN_DISPLAY,
    MAIN_DISPLAY
  );
  assert.deepEqual(moved, { x: 1121, y: 260, width: 349, height: 671 });
  assert.equal(moved.x + moved.width, MAIN_DISPLAY.workArea.width);
  assert.equal(moved.y + moved.height, MAIN_DISPLAY.workArea.y + MAIN_DISPLAY.workArea.height);
});

test('boundsOnDisplay shrinks a window larger than the target work area', () => {
  const moved = boundsOnDisplay(
    { x: 0, y: 0, width: 1920, height: 1080 },
    EXTERNAL_DISPLAY,
    MAIN_DISPLAY
  );
  assert.deepEqual(moved, { x: 0, y: 25, width: 1470, height: 906 });
});

test('boundsOnDisplay pins to the work area when the source display is unknown', () => {
  const moved = boundsOnDisplay(
    { x: 1072, y: 37, width: 349, height: 671 },
    null,
    EXTERNAL_DISPLAY
  );
  // No offset is knowable, so the window is parked at the target's work-area
  // origin rather than moved by a guess.
  assert.deepEqual(moved, { x: -220, y: -1055, width: 349, height: 671 });
});

test('boundsOnDisplay returns null instead of guessing', () => {
  const bounds = { x: 0, y: 0, width: 300, height: 400 };
  assert.equal(boundsOnDisplay(null, MAIN_DISPLAY, EXTERNAL_DISPLAY), null);
  assert.equal(boundsOnDisplay(bounds, MAIN_DISPLAY, null), null);
  assert.equal(boundsOnDisplay(bounds, MAIN_DISPLAY, { id: 9 }), null);
});

test('boundsOnDisplay falls back to workArea when a display has no bounds', () => {
  const bare = { id: 3, workArea: { x: 100, y: 50, width: 800, height: 600 } };
  const moved = boundsOnDisplay({ x: 300, y: 200, width: 200, height: 300 }, null, bare);
  assert.deepEqual(moved, { x: 100, y: 50, width: 200, height: 300 });
});
