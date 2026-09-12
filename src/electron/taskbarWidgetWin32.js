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

// GetWindow command retrieves the window directly above the given window in
// z-order; NULL means the window is the very top of the stack.
const GW_HWNDPREV = 3;

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
// Never SetWindowPos while the primary button is down — reordering between
// mousedown and mouseup eats the click-to-cycle even when the widget already
// received the down event.
const VK_LBUTTON = 0x01;
const MOUSE_DEFER_RETRY_MS = 50;
const MOUSE_DEFER_MAX_MS = 2000;

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
    let shell32 = null;
    try {
      shell32 = koffi.load('shell32.dll');
    } catch (_) {}
    const WinEventProc = koffi.proto(
      'void WinEventProc(void *hWinEventHook, uint event, uintptr_t hwnd, long idObject, long idChild, uint idEventThread, uint dwmsEventTime)'
    );
    win32Api = {
      koffi,
      WinEventProc,
      FindWindowW: user32.func('uintptr_t FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)'),
      GetAncestor: user32.func('uintptr_t GetAncestor(uintptr_t hWnd, uint gaFlags)'),
      GetWindow: user32.func('uintptr_t GetWindow(uintptr_t hWnd, uint uCmd)'),
      GetWindowRect: user32.func('bool GetWindowRect(uintptr_t hWnd, void *rect)'),
      GetForegroundWindow: user32.func('uintptr_t GetForegroundWindow()'),
      GetClassNameW: user32.func('int GetClassNameW(uintptr_t hWnd, _Out_ char16_t *lpClassName, int nMaxCount)'),
      GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *lpdwProcessId)'),
      IsIconic: user32.func('bool IsIconic(uintptr_t hWnd)'),
      IsWindowVisible: user32.func('bool IsWindowVisible(uintptr_t hWnd)'),
      SetWindowPos: user32.func(
        'bool SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'
      ),
      GetAsyncKeyState: user32.func('int16 GetAsyncKeyState(int vKey)'),
      SetWinEventHook: user32.func(
        'uintptr_t SetWinEventHook(uint eventMin, uint eventMax, uintptr_t hmodWinEventProc, WinEventProc *pfnWinEventProc, uint idProcess, uint idThread, uint dwFlags)'
      ),
      UnhookWinEvent: user32.func('bool UnhookWinEvent(uintptr_t hWinEventHook)'),
      SHQueryUserNotificationState: shell32 ? shell32.func('int SHQueryUserNotificationState(_Out_ int *pquns)') : null
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

function isPrimaryMouseButtonDown() {
  const api = loadWin32Api();
  if (!api) return false;
  try {
    return Boolean(api.GetAsyncKeyState(VK_LBUTTON) & 0x8000);
  } catch {
    return false;
  }
}

// Defer SetWindowPos until the primary button is up so a re-assert never
// lands between mousedown and mouseup (which would swallow the click event).
const raiseDeferTimers = new WeakMap();

function raiseTaskbarWidgetWindowSafe(win, startedAt = Date.now()) {
  if (!win) return false;
  if (isPrimaryMouseButtonDown()) {
    if (Date.now() - startedAt > MOUSE_DEFER_MAX_MS) return false;
    let timer = raiseDeferTimers.get(win);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => raiseTaskbarWidgetWindowSafe(win, startedAt), MOUSE_DEFER_RETRY_MS);
    if (timer.unref) timer.unref();
    raiseDeferTimers.set(win, timer);
    return false;
  }
  const pending = raiseDeferTimers.get(win);
  if (pending) {
    clearTimeout(pending);
    raiseDeferTimers.delete(win);
  }
  return raiseTaskbarWidgetWindow(win);
}

// True when no visible, real-size window sits above the overlay. Re-asserting
// topmost while the widget is covered is what keeps it above the taskbar, but
// doing it between a click's mousedown and mouseup eats the click (the down is
// delivered, then the window is reordered, and no click event ever fires). So
// callers must only raise when this returns false.
//
// Windows keeps degenerate 1x1 helper windows (class ThumbnailDeviceHelperWnd)
// permanently near the top of the z-order, so "nothing at all above" is too
// strict. Walk upward skipping invisible and tiny windows: anything else above
// the overlay means it is buried.
const SKIP_WINDOW_MIN_SIZE = 8;

function windowSize(api, hwnd) {
  const rect = Buffer.alloc(16);
  if (!api.GetWindowRect(hwnd, rect)) return null;
  const width = rect.readInt32LE(8) - rect.readInt32LE(0);
  const height = rect.readInt32LE(12) - rect.readInt32LE(4);
  return { width, height };
}

function isEffectiveTopmost(api, hwnd) {
  let above = api.GetWindow(hwnd, GW_HWNDPREV);
  let guard = 0;
  while (above && guard++ < 64) {
    if (api.IsWindowVisible(above)) {
      const size = windowSize(api, above);
      if (!size || (size.width >= SKIP_WINDOW_MIN_SIZE && size.height >= SKIP_WINDOW_MIN_SIZE)) {
        return false;
      }
    }
    above = api.GetWindow(above, GW_HWNDPREV);
  }
  return true;
}

function isTaskbarWidgetTopmost(win) {
  const api = loadWin32Api();
  const hwnd = hwndOf(win);
  if (!api || !hwnd) return false;
  try {
    return isEffectiveTopmost(api, hwnd);
  } catch {
    return false;
  }
}

// Fullscreen video, gaming, or presentation detection.
// The widget hides only when the primary taskbar is actually invisible: when
// an exclusive Direct3D game is running (the taskbar disappears), when the
// taskbar window is hidden, or when the foreground window physically covers
// the taskbar strip (fullscreen video / borderless game). Foreground and
// taskbar rects both come from GetWindowRect in the same native-pixel space,
// so DPI scaling never skews the decision: a maximized window that leaves the
// taskbar visible (e.g. a maximized editor) keeps the widget shown.
function isForegroundFullscreen(_display, widgetWin, customApi = null) {
  const api = customApi || loadWin32Api();
  if (!api) return false;
  try {
    // 1. Direct3D exclusive fullscreen query (games)
    if (typeof api.SHQueryUserNotificationState === 'function') {
      const quns = [0];
      const hr = api.SHQueryUserNotificationState(quns);
      // QUNS_RUNNING_D_D (3): exclusive Direct3D game running full screen
      if (hr === 0 && quns[0] === 3) {
        return true;
      }
    }

    // 2. Foreground window check
    if (typeof api.GetForegroundWindow !== 'function') return false;
    const fg = api.GetForegroundWindow();
    if (!fg) return false;

    // Ignore if foreground is our own widget window
    const widgetHwnd = widgetWin ? hwndOf(widgetWin) : 0n;
    if (widgetHwnd && fg === widgetHwnd) return false;

    if (typeof api.IsWindowVisible === 'function' && !api.IsWindowVisible(fg)) return false;
    if (typeof api.IsIconic === 'function' && api.IsIconic(fg)) return false;

    // Ignore if foreground window belongs to our own app process
    if (typeof api.GetWindowThreadProcessId === 'function') {
      const pidBuf = [0];
      api.GetWindowThreadProcessId(fg, pidBuf);
      if (pidBuf[0] === process.pid) return false;
    }

    // Ignore Windows Desktop and Taskbars
    if (typeof api.GetClassNameW === 'function') {
      const classBuf = Buffer.alloc(512);
      const len = api.GetClassNameW(fg, classBuf, 256);
      if (len > 0) {
        const cls = Buffer.from(classBuf.buffer, 0, len * 2).toString('utf16le').replace(/\0.*$/, '');
        if (
          cls === 'Progman' ||
          cls === 'WorkerW' ||
          cls === 'Shell_TrayWnd' ||
          cls === 'Shell_SecondaryTrayWnd'
        ) {
          return false;
        }
      }
    }

    // 3. The taskbar is the widget's anchor: hide only when it is actually
    // invisible. Locate the primary taskbar and compare rects natively.
    if (typeof api.GetWindowRect !== 'function') return false;
    if (typeof api.FindWindowW !== 'function') return false;
    const trayName = Buffer.from('Shell_TrayWnd\0', 'utf16le');
    const tray = api.FindWindowW(trayName, null);
    if (!tray) return false; // no taskbar found; leave the widget as-is
    if (typeof api.IsWindowVisible === 'function' && !api.IsWindowVisible(tray)) {
      return true; // taskbar hidden (auto-hide or exclusive fullscreen)
    }
    const trayRect = Buffer.alloc(16);
    if (!api.GetWindowRect(tray, trayRect)) return false;
    const fgRect = Buffer.alloc(16);
    if (!api.GetWindowRect(fg, fgRect)) return false;

    const tLeft = trayRect.readInt32LE(0);
    const tTop = trayRect.readInt32LE(4);
    const tRight = trayRect.readInt32LE(8);
    const tBottom = trayRect.readInt32LE(12);
    const fLeft = fgRect.readInt32LE(0);
    const fTop = fgRect.readInt32LE(4);
    const fRight = fgRect.readInt32LE(8);
    const fBottom = fgRect.readInt32LE(12);

    // Foreground window completely covers the taskbar strip.
    return fLeft <= tLeft && fTop <= tTop && fRight >= tRight && fBottom >= tBottom;
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
    pendingDelayedRaise = null;
    lastRaiseAt = 0; // bypass the throttle for the final re-assert
    onZOrderChange();
  };

  const scheduleDelayedRaise = () => {
    if (pendingDelayedRaise) return;
    pendingDelayedRaise = setTimeout(fire, REASSERT_DELAY_MS);
    if (pendingDelayedRaise.unref) pendingDelayedRaise.unref();
  };

  // WinEventProc(hHook, event, hwnd, idObject, idChild, idEventThread, dwmsEventTime)
  const handleEvent = (_hHook, event, hwnd) => {
    const taskbar = isTaskbarRelated(hwnd);
    const foregroundSwitch =
      event === EVENT_SYSTEM_FOREGROUND || event === EVENT_SYSTEM_MINIMIZEEND;
    if (!taskbar && !foregroundSwitch) return;

    if (taskbar) {
      const now = Date.now();
      if (now - lastRaiseAt >= REASSERT_THROTTLE_MS) {
        lastRaiseAt = now;
        onZOrderChange();
      }
    }
    // Taskbar re-raises and foreground switches (Alt+Tab, clicking a browser
    // window) can both bury the overlay. Always schedule a delayed re-assert
    // so recovery happens after the gesture settles; never re-assert
    // immediately on a non-taskbar foreground event — that would SetWindowPos
    // between mousedown and mouseup when the user clicks the widget.
    scheduleDelayedRaise();
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
  GW_HWNDPREV,
  HWND_TOPMOST,
  MOUSE_DEFER_MAX_MS,
  MOUSE_DEFER_RETRY_MS,
  REASSERT_DELAY_MS,
  REASSERT_THROTTLE_MS,
  VK_LBUTTON,
  isEffectiveTopmost,
  isForegroundFullscreen,
  isPrimaryMouseButtonDown,
  isTaskbarWidgetTopmost,
  raiseTaskbarWidgetWindow,
  raiseTaskbarWidgetWindowSafe,
  watchTaskbarWidgetZOrder
};
