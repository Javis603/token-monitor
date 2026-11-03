'use strict';

// Electron's documented Windows Acrylic uses DWMWA_SYSTEMBACKDROP_TYPE. The
// alternate Accent mode deliberately uses the AccentBlurBehind recipe:
// DwmEnableBlurBehindWindow plus the undocumented
// SetWindowCompositionAttribute(WCA_ACCENT_POLICY) API. Keep every call lazy
// and best-effort so an unsupported Windows build can fall back to Acrylic.

const DEFAULT_ACCENT_ARGB = 0x3a232323;

const WCA_ACCENT_POLICY = 19;
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
const DWM_BB_ENABLE = 0x1;
const DWM_BB_BLURREGION = 0x2;
const DWM_BB_TRANSITIONONMAXIMIZED = 0x4;

let accentApi = null;
const windowStates = new WeakMap();

function hwndOf(win) {
  const buffer = win.getNativeWindowHandle();
  return buffer.length >= 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());
}

function createAccentApi(koffi) {
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const ACCENT_POLICY = koffi.struct('TOKEN_MONITOR_ACCENT_POLICY', {
    AccentState: 'int32_t',
    AccentFlags: 'int32_t',
    GradientColor: 'uint32_t',
    AnimationId: 'int32_t'
  });
  koffi.struct('TOKEN_MONITOR_WINDOWCOMPOSITIONATTRIBDATA', {
    Attrib: 'uint32_t',
    pvData: 'void *',
    cbData: 'size_t'
  });
  koffi.struct('TOKEN_MONITOR_DWM_BLURBEHIND', {
    dwFlags: 'uint32_t',
    fEnable: 'int32_t',
    hRgnBlur: 'void *',
    fTransitionOnMaximized: 'int32_t'
  });
  koffi.struct('TOKEN_MONITOR_MARGINS', {
    cxLeftWidth: 'int32_t',
    cxRightWidth: 'int32_t',
    cyTopHeight: 'int32_t',
    cyBottomHeight: 'int32_t'
  });

  const SetWindowCompositionAttribute = user32.func(
    'bool SetWindowCompositionAttribute(uintptr_t hwnd, const TOKEN_MONITOR_WINDOWCOMPOSITIONATTRIBDATA *data)'
  );
  const DwmEnableBlurBehindWindow = dwmapi.func(
    'int DwmEnableBlurBehindWindow(uintptr_t hwnd, const TOKEN_MONITOR_DWM_BLURBEHIND *blurBehind)'
  );
  const DwmExtendFrameIntoClientArea = dwmapi.func(
    'int DwmExtendFrameIntoClientArea(uintptr_t hwnd, const TOKEN_MONITOR_MARGINS *margins)'
  );
  const CreateRectRgn = gdi32.func('void *CreateRectRgn(int left, int top, int right, int bottom)');
  const DeleteObject = gdi32.func('bool DeleteObject(void *object)');

  return {
    apply(hwnd, argb) {
      const region = CreateRectRgn(0, 0, -1, -1);
      if (!region) return false;
      try {
        const blurBehind = {
          dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION | DWM_BB_TRANSITIONONMAXIMIZED,
          fEnable: 1,
          hRgnBlur: region,
          fTransitionOnMaximized: 1
        };
        if (DwmEnableBlurBehindWindow(hwnd, blurBehind) < 0) return false;

        if (DwmExtendFrameIntoClientArea(hwnd, {
          cxLeftWidth: -1,
          cxRightWidth: -1,
          cyTopHeight: -1,
          cyBottomHeight: -1
        }) < 0) return false;

        const accent = {
          AccentState: ACCENT_ENABLE_ACRYLICBLURBEHIND,
          AccentFlags: 0,
          GradientColor: argb >>> 0,
          AnimationId: 0
        };
        const data = {
          Attrib: WCA_ACCENT_POLICY,
          pvData: koffi.as(accent, 'TOKEN_MONITOR_ACCENT_POLICY *'),
          cbData: koffi.sizeof(ACCENT_POLICY)
        };
        return Boolean(SetWindowCompositionAttribute(hwnd, data));
      } finally {
        DeleteObject(region);
      }
    },
    clear(hwnd) {
      const accent = { AccentState: 0, AccentFlags: 0, GradientColor: 0, AnimationId: 0 };
      const policy = SetWindowCompositionAttribute(hwnd, {
        Attrib: WCA_ACCENT_POLICY,
        pvData: koffi.as(accent, 'TOKEN_MONITOR_ACCENT_POLICY *'),
        cbData: koffi.sizeof(ACCENT_POLICY)
      });
      const blur = DwmEnableBlurBehindWindow(hwnd, {
        dwFlags: DWM_BB_ENABLE, fEnable: 0, hRgnBlur: null, fTransitionOnMaximized: 0
      });
      const frame = DwmExtendFrameIntoClientArea(hwnd, {
        cxLeftWidth: 0, cxRightWidth: 0, cyTopHeight: 0, cyBottomHeight: 0
      });
      return Boolean(policy) && blur >= 0 && frame >= 0;
    }
  };
}

function loadAccentApi() {
  if (accentApi !== null) return accentApi;
  try {
    accentApi = createAccentApi(require('koffi'));
  } catch (_) {
    accentApi = false;
  }
  return accentApi;
}

function applyWindowsAccentBlur(win, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return false;
  if (!win || win.isDestroyed?.()) return false;
  const api = options.api || loadAccentApi();
  if (!api) return false;
  try {
    return api.apply(hwndOf(win), options.argb ?? DEFAULT_ACCENT_ARGB) === true;
  } catch (_) {
    return false;
  }
}

function syncWindowsBackdrop(win, { enabled = true, mode = 'acrylic' } = {}, options = {}) {
  if ((options.platform || process.platform) !== 'win32' || !win || win.isDestroyed?.()) return;
  const wanted = !enabled ? 'transparent' : mode === 'accent' ? 'accent' : 'acrylic';
  const previous = windowStates.get(win);
  if (previous?.mode === wanted) return previous;
  const api = options.api || (wanted === 'accent' || previous?.mode === 'accent' ? loadAccentApi() : null);
  const clearAccent = () => {
    if (!api) return;
    try { api.clear(hwndOf(win)); } catch (_) {}
  };
  if (previous?.mode === 'accent') clearAccent();
  let fallback = false;
  if (wanted === 'accent') {
    win.setBackgroundMaterial('none');
    // Electron resets the page background to white when removing a material.
    win.setBackgroundColor('#00000000');
    if (!applyWindowsAccentBlur(win, { ...options, api })) {
      clearAccent(); // A failed apply can already have extended the DWM frame.
      win.setBackgroundMaterial('acrylic');
      console.warn('[window] AccentBlurBehind unavailable; falling back to Acrylic');
      fallback = true;
    }
  } else if (wanted === 'acrylic') {
    win.setBackgroundMaterial('acrylic');
  } else {
    win.setBackgroundMaterial('none');
    // Removing a material resets Electron's background. The host is created
    // transparent, so restoring alpha reveals the desktop on the same HWND.
    win.setBackgroundColor('#00000000');
  }
  const state = { mode: wanted, fallback };
  windowStates.set(win, state);
  return state;
}

function windowsBackdropFallback(win) {
  return windowStates.get(win)?.fallback === true;
}

module.exports = {
  DEFAULT_ACCENT_ARGB,
  applyWindowsAccentBlur,
  createAccentApi,
  syncWindowsBackdrop,
  windowsBackdropFallback
};
