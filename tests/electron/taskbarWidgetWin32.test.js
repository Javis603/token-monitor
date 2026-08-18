'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EVENT_OBJECT_REORDER,
  EVENT_OBJECT_SHOW,
  EVENT_SYSTEM_FOREGROUND,
  EVENT_SYSTEM_MINIMIZEEND,
  HWND_TOPMOST,
  isForegroundFullscreen,
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

test('isForegroundFullscreen hides only when the taskbar is actually covered', () => {
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const trayHwnd = 0x100n;
  const fgHwnd = 0x200n;
  const rect = (l, t, r, b) => {
    const buf = Buffer.alloc(16);
    buf.writeInt32LE(l, 0);
    buf.writeInt32LE(t, 4);
    buf.writeInt32LE(r, 8);
    buf.writeInt32LE(b, 12);
    return buf;
  };

  const trayVisible = { value: true };
  const fgRects = { value: null };
  const mockApi = {
    GetForegroundWindow: () => fgHwnd,
    FindWindowW: (clsName) =>
      clsName.includes(Buffer.from('Shell_TrayWnd', 'utf16le')) ? trayHwnd : 0n,
    IsWindowVisible: (hwnd) => (hwnd === trayHwnd ? trayVisible.value : hwnd === fgHwnd),
    IsIconic: () => false,
    GetWindowThreadProcessId: (_hwnd, outPid) => { outPid[0] = process.pid + 1; return 1; },
    GetClassNameW: (_hwnd, buf) => {
      Buffer.from('Chrome_WidgetWin_1\0', 'utf16le').copy(buf);
      return 18;
    },
    GetWindowRect: (hwnd, buf) => {
      if (hwnd === trayHwnd) { rect(0, 1032, 1920, 1080).copy(buf); return true; }
      if (hwnd === fgHwnd && fgRects.value) { fgRects.value.copy(buf); return true; }
      return false;
    }
  };

  // Fullscreen video: foreground covers the taskbar strip -> hide
  fgRects.value = rect(0, 0, 1920, 1080);
  assert.equal(isForegroundFullscreen(display, null, mockApi), true, 'fullscreen video covering the taskbar hides the widget');

  // Maximized editor: covers the work area but leaves the taskbar visible -> keep shown
  fgRects.value = rect(0, 0, 1920, 1032);
  assert.equal(isForegroundFullscreen(display, null, mockApi), false, 'maximized window leaving the taskbar visible keeps the widget');

  // Borderless window covering the display but not the whole taskbar strip -> keep shown
  fgRects.value = rect(0, 0, 1920, 1079);
  assert.equal(isForegroundFullscreen(display, null, mockApi), false, 'window not covering the full taskbar strip keeps the widget');

  // Taskbar hidden (auto-hide / exclusive fullscreen) -> hide
  trayVisible.value = false;
  assert.equal(isForegroundFullscreen(display, null, mockApi), true, 'hidden taskbar hides the widget');
  trayVisible.value = true;

  // Desktop window (Progman/WorkerW) in foreground: returns false
  mockApi.GetClassNameW = (_hwnd, buf) => {
    Buffer.from('Progman\0', 'utf16le').copy(buf);
    return 7;
  };
  assert.equal(isForegroundFullscreen(display, null, mockApi), false, 'desktop foreground returns false');

  // Taskbar window (Shell_TrayWnd) in foreground: returns false
  mockApi.GetClassNameW = (_hwnd, buf) => {
    Buffer.from('Shell_TrayWnd\0', 'utf16le').copy(buf);
    return 13;
  };
  assert.equal(isForegroundFullscreen(display, null, mockApi), false, 'taskbar foreground returns false');

  // Our own app window: returns false
  mockApi.GetClassNameW = (_hwnd, buf) => {
    Buffer.from('Chrome_WidgetWin_1\0', 'utf16le').copy(buf);
    return 18;
  };
  mockApi.GetWindowThreadProcessId = (_hwnd, outPid) => { outPid[0] = process.pid; return 1; };
  assert.equal(isForegroundFullscreen(display, null, mockApi), false, 'own process window returns false');

  // Direct3D exclusive fullscreen query (QUNS_RUNNING_D_D = 3)
  const d3dApi = {
    SHQueryUserNotificationState: (out) => { out[0] = 3; return 0; }
  };
  assert.equal(isForegroundFullscreen(display, null, d3dApi), true, 'Direct3D game mode returns true');
});

test('isForegroundFullscreen is a safe no-op on null inputs', () => {
  assert.equal(isForegroundFullscreen(null, null, {}), false);
  assert.equal(isForegroundFullscreen(undefined, undefined, null), false);
});

test('watchTaskbarWidgetZOrder installs and detaches hooks on Windows', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const unwatch = watchTaskbarWidgetZOrder(() => {});
  if (!unwatch) return t.skip('SetWinEventHook unavailable in this environment');
  assert.equal(typeof unwatch, 'function');
  unwatch();
  unwatch(); // detaching twice is harmless
});
