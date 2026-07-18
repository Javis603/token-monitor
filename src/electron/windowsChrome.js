'use strict';

// Windows-only cosmetic chrome fixes for the frameless widget — things macOS
// gets natively but Electron can't express on win32, so we reach for the
// documented DWM APIs through koffi:
//
//   1. DWMWA_WINDOW_CORNER_PREFERENCE = ROUND — round the corners with the OS's
//      anti-aliased mask. This is load-bearing for the transparent (glass-off)
//      window: Electron's default roundedCorners does NOT cleanly round a
//      transparent frameless window, and neither CSS clip-path nor border-radius
//      anti-aliases its corners on Windows (the bottom looks truncated and the
//      top-right looks malformed). The acrylic (glass-on, non-transparent)
//      window rounds fine on its own, but applying ROUND to it too is harmless.
//   2. DWMWA_BORDER_COLOR = NONE — clear the 1px system border DWM draws around
//      every frameless window; on a dark widget it reads as a pale hairline.
//
// macOS / Linux: every entry point no-ops. koffi and dwmapi.dll are loaded
// lazily and guarded, so a missing binary or any DWM failure never breaks
// window creation — this is purely cosmetic.

const DWMWA_WINDOW_CORNER_PREFERENCE = 33; // dwmapi.h, Windows 11 Build 22000+
const DWMWCP_ROUND = 2; // round the corners natively (anti-aliased by the OS)
const DWMWA_BORDER_COLOR = 34; // dwmapi.h, Windows 11 Build 22000+
const DWMWA_COLOR_NONE = 0xfffffffe; // "no visible border"

// null = not yet probed, false = unavailable, object = ready
let dwm = null;

function loadDwm() {
  if (dwm !== null) return dwm;
  try {
    const koffi = require('koffi');
    const dwmapi = koffi.load('dwmapi.dll');
    dwm = {
      DwmSetWindowAttribute: dwmapi.func(
        'int DwmSetWindowAttribute(uintptr_t hwnd, uint dwAttribute, void *pvAttribute, uint cbAttribute)'
      )
    };
  } catch {
    dwm = false;
  }
  return dwm;
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle(); // pointer-sized little-endian Buffer
  return buf.length >= 8 ? buf.readBigUInt64LE() : BigInt(buf.readUInt32LE());
}

function setUintAttribute(api, hwnd, attribute, value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  api.DwmSetWindowAttribute(hwnd, attribute, buf, 4);
}

// The collapsed floating bubble can be dragged anywhere, so it keeps the same
// anti-aliased DWM rounding as the expanded widget.
function applyWindowsChrome(win, { round = false } = {}) {
  if (process.platform !== 'win32') return;
  if (!win || win.isDestroyed?.()) return;
  const api = loadDwm();
  if (!api) return;
  try {
    const hwnd = hwndOf(win);
    if (round) setUintAttribute(api, hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND);
    setUintAttribute(api, hwnd, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE);
  } catch {
    // Best-effort cosmetic tweak; never break window creation.
  }
}

module.exports = { applyWindowsChrome };
