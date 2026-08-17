'use strict';

// Windows-only native z-order enforcement for the taskbar widget.
//
// The taskbar (Shell_TrayWnd) is itself an always-on-top window, so whenever
// the user clicks a taskbar button Explorer re-raises the taskbar to the top
// of the topmost band, silently covering the widget overlay. Electron's own
// setAlwaysOnTop(true) is a no-op on a window that is already flagged topmost,
// and setBounds does not touch z-order, so the periodic re-assert in main.js
// can never win that race — the widget stays buried.
//
// This module re-asserts the overlay's topmost position through the Win32 API
// directly (SetWindowPos with HWND_TOPMOST always reorders, unlike Electron's
// flag check) and reacts immediately to system-wide foreground switches,
// Alt+Tab, minimize animations, and window reorders via SetWinEventHook, so
// the widget pops back above the taskbar within milliseconds of any
// re-shuffle instead of waiting for the next periodic pass.
//
// Every entry point is guarded: on non-Windows platforms, when koffi cannot be
// loaded, or when the window handle is unavailable, calls are harmless no-ops
// and watchTaskbarWidgetZOrder() returns null.

const EVENT_SYSTEM_FOREGROUND = 0x0003;
const EVENT_SYSTEM_MINIMIZEEND = 0x0017;
const EVENT_OBJECT_SHOW = 0x8002;
const EVENT_OBJECT_REORDER = 0x8004;

const WINEVENT_OUTOFCONTEXT = 0x0000;
const WINEVENT_SKIPOWNPROCESS = 0x0002;

const HWND_TOPMOST = -1n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_NOOWNERZORDER = 0x0200;
const REASSERT_IMMEDIATE_FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER;

// Re-assert at most this often; Explorer fires a burst of events while
// re-shuffling the taskbar, and a couple of SetWindowPos calls per second is
// plenty to stay on top. There is no benefit to raising on every event in a
// burst: the extra SetWindowPos calls land mid-gesture and can break the
// click-to-cycle (the mousedown gets captured by the taskbar while the
// mouseup re-hits the raised overlay, so no click is ever delivered).
const REASSERT_THROTTLE_MS = 100;
// Re-assert again shortly after the event burst settles so we always end up
// above the taskbar, regardless of whether Explorer re-raises it before or
// after our event callback runs.
const REASSERT_DELAY_MS = 150;

// null = not probed, false = unavailable, object = ready
let win32Api = null;

function loadWin32Api() {
  if (win32Api !== null) return win32Api;
  if (process.platform !== 'win32') {
    win32Api = false;
    return win32Api;
  }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const WinEventProc = koffi.proto(
      'void WinEventProc(void *hWinEventHook, uint event, uintptr_t hwnd, long idObject, long idChild, uint idEventThread, uint dwmsEventTime)'
    );
    win32Api = {
      koffi,
      WinEventProc,
      FindWindowW: user32.func('uintptr_t FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)'),
      GetAncestor: user32.func('uintptr_t GetAncestor(uintptr_t hWnd, uint gaFlags)'),
      SetWindowPos: user32.func(
        'bool SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'
      ),
      SetWinEventHook: user32.func(
        'uintptr_t SetWinEventHook(uint eventMin, uint eventMax, uintptr_t hmodWinEventProc, WinEventProc *pfnWinEventProc, uint idProcess, uint idThread, uint dwFlags)'
      ),
      UnhookWinEvent: user32.func('bool UnhookWinEvent(uintptr_t hWinEventHook)')
    };
  } catch {
    win32Api = false;
  }
  return win32Api;
}

function hwndOf(win) {
  if (!win || typeof win.getNativeWindowHandle !== 'function') return 0n;
  try {
    const buffer = win.getNativeWindowHandle();
    if (!buffer) return 0n;
    return buffer.length >= 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());
  } catch {
    return 0n;
  }
}

// Force the overlay to the top of the always-on-top band. Unlike
// BrowserWindow#setAlwaysOnTop — which Electron makes a no-op when the window
// is already flagged topmost — the native call always reorders, which is what
// actually wins the race against the taskbar.
function raiseTaskbarWidgetWindow(win) {
  const api = loadWin32Api();
  const hwnd = hwndOf(win);
  if (!api || !hwnd) return false;
  try {
    return Boolean(api.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, REASSERT_IMMEDIATE_FLAGS));
  } catch {
    return false;
  }
}

// Keep every koffi-registered callback alive for as long as its hook lives;
// if the GC collected the pointer, the hook would fire into freed memory.
const activeHookCallbacks = new Set();

// The overlay is only ever covered by the taskbar itself: clicking a taskbar
// button makes Explorer re-raise Shell_TrayWnd (or its child windows) over
// the overlay. Filtering on the taskbar's window tree matters: clicking the
// overlay itself cannot activate it (WS_EX_NOACTIVATE), so Windows hands the
// activation to whatever window was active before — an EVENT_SYSTEM_FOREGROUND
// whose hwnd is NOT the taskbar. Reacting to that event would SetWindowPos
// the overlay between mousedown and mouseup, eating the click (the
// click-to-cycle handler would never fire). Restricting re-asserts to
// taskbar-tree events keeps the click intact while still covering the
// "taskbar re-raised over the overlay" case.
function isTaskbarRelated(eventHwnd) {
  if (!eventHwnd) return false;
  try {
    const tray = loadWin32Api().FindWindowW(Buffer.from('Shell_TrayWnd\0', 'utf16le'), null);
    if (!tray) return false;
    if (eventHwnd === tray) return true;
    return loadWin32Api().GetAncestor(eventHwnd, 2 /* GA_ROOT */) === tray;
  } catch {
    return false;
  }
}

function installHook(api, eventMin, eventMax, callback) {
  const registration = api.koffi.register(callback, api.koffi.pointer(api.WinEventProc));
  activeHookCallbacks.add(registration);
  const hook = api.SetWinEventHook(
    eventMin, eventMax, 0, registration, 0, 0,
    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
  );
  if (!hook) activeHookCallbacks.delete(registration);
  return { hook, registration };
}

function uninstallHook(api, active) {
  if (!active) return;
  if (active.hook) {
    try { api.UnhookWinEvent(active.hook); } catch (_) { /* best effort */ }
  }
  activeHookCallbacks.delete(active.registration);
}

// React to foreground switches, Alt+Tab, minimize animations, and window
// reorders — Explorer re-raises the taskbar under all of these. Returns a
// function that detaches the hooks, or null when unavailable.
function watchTaskbarWidgetZOrder(onZOrderChange) {
  const api = loadWin32Api();
  if (!api || typeof onZOrderChange !== 'function') return null;

  let lastRaiseAt = 0;
  let pendingDelayedRaise = null;

  const fire = () => {
    lastRaiseAt = 0; // bypass the throttle for the final re-assert
    onZOrderChange();
  };

  // WinEventProc(hHook, event, hwnd, idObject, idChild, idEventThread, dwmsEventTime)
  const handleEvent = (_hHook, _event, hwnd) => {
    if (!isTaskbarRelated(hwnd)) return;
    const now = Date.now();
    if (now - lastRaiseAt >= REASSERT_THROTTLE_MS) {
      lastRaiseAt = now;
      onZOrderChange();
    }
    if (pendingDelayedRaise) return;
    pendingDelayedRaise = setTimeout(fire, REASSERT_DELAY_MS);
    if (pendingDelayedRaise.unref) pendingDelayedRaise.unref();
  };

  const systemRange = installHook(api, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, handleEvent);
  const objectRange = installHook(api, EVENT_OBJECT_SHOW, EVENT_OBJECT_REORDER, handleEvent);
  // The system range above covers foreground switches, Alt+Tab, and minimize
  // animations (0x0003 through 0x0017); the object range covers windows
  // appearing and being reordered in z-order.

  if (!systemRange.hook && !objectRange.hook) {
    uninstallHook(api, systemRange);
    uninstallHook(api, objectRange);
    return null;
  }

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    if (pendingDelayedRaise) {
      clearTimeout(pendingDelayedRaise);
      pendingDelayedRaise = null;
    }
    uninstallHook(api, systemRange);
    uninstallHook(api, objectRange);
  };
}

module.exports = {
  EVENT_OBJECT_REORDER,
  EVENT_OBJECT_SHOW,
  EVENT_SYSTEM_FOREGROUND,
  EVENT_SYSTEM_MINIMIZEEND,
  HWND_TOPMOST,
  REASSERT_DELAY_MS,
  REASSERT_THROTTLE_MS,
  raiseTaskbarWidgetWindow,
  watchTaskbarWidgetZOrder
};
