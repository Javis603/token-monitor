'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isWindowMaximized,
  normalWindowBounds,
  persistWindowState,
  rebuildWindowBounds,
  restoreWindowMaximized,
  restoreWindowMaximizedForReveal,
  shouldPersistWindowBounds,
  shouldRestoreWindowMaximized
} = require('../../src/electron/windowState');

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
    maximize: () => { state.maximized = true; }
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
