'use strict';

// Windows-only cheap window translation for the top-edge hide animation.
// Electron setBounds/setPosition on a frameless (often acrylic) window is
// heavy: DWM may interpolate every jump, Chromium may treat it as a resize,
// and our own `moved` handler used to re-assert taskbar z-order on each frame.
// Intermediate frames therefore go through SetWindowPos (size/z-order/activation
// unchanged). Electron's DIP bounds are synced once at the end.
//
// Absolute SetWindowPos(x, y) from a DIP conversion is unsafe here: the HWND
// origin includes an invisible resize frame that Electron's setPosition
// compensates for, and dipToScreenRect of a mostly off-screen window can shift
// x as y changes (per-monitor DPI). Animation frames only nudge the current
// GetWindowRect by the physical Y delta, so x cannot drift.
//
// DWMWA_TRANSITIONS_FORCEDISABLED stops DWM from sliding between those jumps.
// macOS / Linux: every entry point no-ops.

const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const DWMWA_TRANSITIONS_FORCEDISABLED = 3;

// null = not yet probed, false = unavailable, object = ready
let native = null;

function loadNative() {
  if (native !== null) return native;
  if (process.platform !== 'win32') {
    native = false;
    return native;
  }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    native = {
      SetWindowPos: user32.func(
        'int SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'
      ),
      GetWindowRect: user32.func('int GetWindowRect(uintptr_t hWnd, void *lpRect)'),
      DwmSetWindowAttribute: dwmapi.func(
        'int DwmSetWindowAttribute(uintptr_t hwnd, uint dwAttribute, void *pvAttribute, uint cbAttribute)'
      )
    };
  } catch {
    native = false;
  }
  return native;
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE() : BigInt(buf.readUInt32LE());
}

function dipToPhysicalRect(win, rect, screenApi) {
  if (screenApi && typeof screenApi.dipToScreenRect === 'function') {
    try {
      const physical = screenApi.dipToScreenRect(win, rect);
      if (physical && Number.isFinite(physical.x) && Number.isFinite(physical.y)) {
        return physical;
      }
    } catch (_) { /* fall through */ }
  }
  return null;
}

function dipToPhysicalPoint(win, x, y, screenApi) {
  const physical = dipToPhysicalRect(win, { x, y, width: 1, height: 1 }, screenApi);
  if (physical) return { x: Math.round(physical.x), y: Math.round(physical.y) };
  if (screenApi && typeof screenApi.dipToScreenPoint === 'function') {
    try {
      const point = screenApi.dipToScreenPoint({ x, y });
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        return { x: Math.round(point.x), y: Math.round(point.y) };
      }
    } catch (_) { /* fall through */ }
  }
  return { x: Math.round(Number(x)), y: Math.round(Number(y)) };
}

function physicalYDelta(fromRect, toRect, win, screenApi) {
  const from = dipToPhysicalRect(win, fromRect, screenApi) || fromRect;
  const to = dipToPhysicalRect(win, toRect, screenApi) || toRect;
  const fromY = Number(from?.y);
  const toY = Number(to?.y);
  if (!Number.isFinite(fromY) || !Number.isFinite(toY)) return 0;
  return Math.round(toY) - Math.round(fromY);
}

function setWindowsDwmTransitionsEnabled(win, enabled) {
  if (process.platform !== 'win32') return false;
  const api = loadNative();
  if (!api || !win || win.isDestroyed?.()) return false;
  try {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(enabled ? 0 : 1);
    api.DwmSetWindowAttribute(hwndOf(win), DWMWA_TRANSITIONS_FORCEDISABLED, buf, 4);
    return true;
  } catch {
    return false;
  }
}

function readWindowRect(api, hwnd) {
  const buf = Buffer.alloc(16);
  if (!api.GetWindowRect(hwnd, buf)) return null;
  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12)
  };
}

function nudgeWindowsWindowByY(win, fromRect, toRect, screenApi) {
  if (process.platform !== 'win32') return false;
  const dy = physicalYDelta(fromRect, toRect, win, screenApi);
  if (dy === 0) return true;
  const api = loadNative();
  if (!api || !win || win.isDestroyed?.()) return false;
  try {
    const hwnd = hwndOf(win);
    const rect = readWindowRect(api, hwnd);
    if (!rect) return false;
    api.SetWindowPos(hwnd, 0, rect.left, rect.top + dy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DWMWA_TRANSITIONS_FORCEDISABLED,
  SWP_NOACTIVATE,
  SWP_NOSIZE,
  SWP_NOZORDER,
  dipToPhysicalPoint,
  nudgeWindowsWindowByY,
  physicalYDelta,
  setWindowsDwmTransitionsEnabled
};
