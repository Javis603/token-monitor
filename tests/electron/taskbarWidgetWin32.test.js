'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EVENT_OBJECT_REORDER,
  EVENT_OBJECT_SHOW,
  EVENT_SYSTEM_FOREGROUND,
  EVENT_SYSTEM_MINIMIZEEND,
  HWND_TOPMOST,
  isPrimaryMouseButtonDown,
  raiseTaskbarWidgetWindow,
  raiseTaskbarWidgetWindowSafe,
  watchTaskbarWidgetZOrder
} = require('../../src/electron/taskbarWidgetWin32');

test('taskbar widget win32 constants match WinUser.h', () => {
  assert.equal(HWND_TOPMOST, -1n);
  assert.equal(EVENT_SYSTEM_FOREGROUND, 0x0003);
  assert.equal(EVENT_SYSTEM_MINIMIZEEND, 0x0017);
  assert.equal(EVENT_OBJECT_SHOW, 0x8002);
  assert.equal(EVENT_OBJECT_REORDER, 0x8004);
});

test('raiseTaskbarWidgetWindow is a safe no-op without a real window', () => {
  assert.equal(raiseTaskbarWidgetWindow(null), false);
  assert.equal(raiseTaskbarWidgetWindow(undefined), false);
  assert.equal(raiseTaskbarWidgetWindow({}), false);
  assert.equal(raiseTaskbarWidgetWindow({ getNativeWindowHandle: () => null }), false);
  assert.equal(raiseTaskbarWidgetWindow({ getNativeWindowHandle: () => undefined }), false);
  assert.equal(raiseTaskbarWidgetWindow({ isDestroyed: () => true }), false);
});

test('raiseTaskbarWidgetWindowSafe is a safe no-op without a real window', () => {
  assert.equal(raiseTaskbarWidgetWindowSafe(null), false);
  assert.equal(raiseTaskbarWidgetWindowSafe(undefined), false);
});

test('isPrimaryMouseButtonDown returns a boolean', () => {
  assert.equal(typeof isPrimaryMouseButtonDown(), 'boolean');
});

test('watchTaskbarWidgetZOrder requires a callback', () => {
  assert.equal(watchTaskbarWidgetZOrder(null), null);
  assert.equal(watchTaskbarWidgetZOrder(undefined), null);
  assert.equal(watchTaskbarWidgetZOrder('nope'), null);
});

test('watchTaskbarWidgetZOrder installs and detaches hooks on Windows', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const unwatch = watchTaskbarWidgetZOrder(() => {});
  if (!unwatch) return t.skip('SetWinEventHook unavailable in this environment');
  assert.equal(typeof unwatch, 'function');
  unwatch();
  unwatch(); // detaching twice is harmless
});
