'use strict';

// Answers "is another app full screen on this display?" for the edge dock's
// `alwaysExceptFullScreen` mode. Neither platform has a public event for it,
// so the controller polls this at a slow cadence while that mode is selected.
//
// macOS: a full-screen app gets a Space of its own, and the dock's windows
// join every Space, so the question is the type of each display's current
// Space. Window geometry cannot answer it: on a display with a camera housing
// a full-screen window stops below the menu bar, exactly where a zoomed window
// stops when the Dock is hidden or at the side. The Accessibility attribute
// AXFullScreen can, but needs a permission grant and blocks on unresponsive
// apps. WindowServer's CGSCopyManagedDisplaySpaces reports the current Space
// per display with its type (4 = full screen) and needs neither; it is private
// SPI, the same call Hammerspoon's hs.spaces and yabai rely on. If it is ever
// missing the probe reports "not full screen".
//
// Windows: a display is full screen when the topmost app window on its monitor
// has exactly the monitor's rect. The foreground window cannot answer it: with
// a full-screen app on one display and focus on a window on another, only the
// focused one is foreground. A maximized window overhangs the monitor by its
// resize border, so it does not match; the desktop and taskbar do, and are
// excluded by class.
//
// Everything is best-effort: koffi or a library failing to load, or any call
// throwing, returns a probe that reports "not full screen", which leaves the
// dock always visible - the mode's desktop behaviour.

const CF_STRING_ENCODING_UTF8 = 0x08000100;
const CF_NUMBER_DOUBLE_TYPE = 13;
const CGS_SPACE_TYPE_FULL_SCREEN = 4;
// The primary display may be listed under this name instead of its UUID.
const CGS_MAIN_DISPLAY_IDENTIFIER = 'Main';
const MONITOR_DEFAULTTONEAREST = 2;
const WINDOWS_SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);
const RECT_TOLERANCE = 1;
const GW_HWNDNEXT = 2;
const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_TOOLWINDOW = 0x00000080;
const DWMWA_CLOAKED = 14;
// Guards the Z-order walk against a window list that changes under it.
const WINDOWS_MAX_WALK = 4096;

function rectMatches(rect, bounds, tolerance = RECT_TOLERANCE) {
  if (!rect || !bounds) return false;
  return ['x', 'y', 'width', 'height'].every((key) => (
    Number.isFinite(Number(rect[key]))
    && Math.abs(Number(rect[key]) - Number(bounds[key])) <= tolerance
  ));
}

// The pure half of the macOS probe. `spaces` is one `{ display, type }` per
// managed display: its UUID (the reader has already resolved 'Main' to the
// primary display's) and the type of its current Space. A single entry is the
// "Displays have separate Spaces" off layout, where it covers every display.
function macCurrentSpaceIsFullScreen(spaces, displayUuid) {
  const list = spaces || [];
  const entry = (displayUuid && list.find((space) => space.display === displayUuid))
    || (list.length === 1 ? list[0] : null);
  return entry?.type === CGS_SPACE_TYPE_FULL_SCREEN;
}

// Resolves a function from the first library exporting any of its names.
function privateFunc(libraries, names, returns, args) {
  for (const lib of libraries) {
    for (const name of names) {
      try { return lib.func(name, returns, args); } catch { /* try the next export */ }
    }
  }
  throw new Error(`${names[0]} is not exported`);
}

function createMacSpaceReader(koffi) {
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const colorSync = koffi.load('/System/Library/Frameworks/ColorSync.framework/ColorSync');
  // SkyLight owns the WindowServer SPI; CoreGraphics re-exports the CGS names.
  const spaceLibraries = [];
  for (const file of [
    '/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight',
    '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'
  ]) {
    try { spaceLibraries.push(koffi.load(file)); } catch { /* try the next library */ }
  }
  const MainConnectionID = privateFunc(spaceLibraries, ['SLSMainConnectionID', 'CGSMainConnectionID'], 'int', []);
  const CopyManagedDisplaySpaces = privateFunc(
    spaceLibraries,
    ['SLSCopyManagedDisplaySpaces', 'CGSCopyManagedDisplaySpaces'],
    'void *',
    ['int']
  );
  const CGDisplayCreateUUIDFromDisplayID = colorSync.func('void *CGDisplayCreateUUIDFromDisplayID(uint32_t display)');
  const CGMainDisplayID = koffi
    .load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    .func('uint32_t CGMainDisplayID()');
  const CFUUIDCreateString = cf.func('void *CFUUIDCreateString(void *alloc, void *uuid)');
  const CFStringCreateWithCString = cf.func('void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32_t encoding)');
  const CFStringGetCString = cf.func('bool CFStringGetCString(void *str, void *buffer, intptr_t size, uint32_t encoding)');
  const CFArrayGetCount = cf.func('intptr_t CFArrayGetCount(void *array)');
  const CFArrayGetValueAtIndex = cf.func('void *CFArrayGetValueAtIndex(void *array, intptr_t index)');
  const CFDictionaryGetValue = cf.func('void *CFDictionaryGetValue(void *dict, void *key)');
  const CFNumberGetValue = cf.func('bool CFNumberGetValue(void *number, int type, _Out_ double *value)');
  const CFRelease = cf.func('void CFRelease(void *ref)');

  // Created once and kept for the life of the process.
  const key = (name) => CFStringCreateWithCString(null, name, CF_STRING_ENCODING_UTF8);
  const keys = {
    display: key('Display Identifier'),
    currentSpace: key('Current Space'),
    type: key('type')
  };
  const connection = MainConnectionID();
  const uuids = new Map();

  function string(ref) {
    if (!ref) return null;
    const buffer = Buffer.alloc(256);
    if (!CFStringGetCString(ref, buffer, buffer.length, CF_STRING_ENCODING_UTF8)) return null;
    const end = buffer.indexOf(0);
    return buffer.toString('utf8', 0, end < 0 ? buffer.length : end);
  }

  function number(dict, name) {
    const value = dict ? CFDictionaryGetValue(dict, keys[name]) : null;
    if (!value) return null;
    const out = [0];
    return CFNumberGetValue(value, CF_NUMBER_DOUBLE_TYPE, out) ? out[0] : null;
  }

  // Electron's display id is the CGDirectDisplayID.
  function displayUuid(displayId) {
    const id = Number(displayId);
    if (!Number.isInteger(id) || id < 0) return null;
    if (uuids.has(id)) return uuids.get(id);
    let value = null;
    const uuid = CGDisplayCreateUUIDFromDisplayID(id >>> 0);
    if (uuid) {
      const text = CFUUIDCreateString(null, uuid);
      try { value = string(text); } finally {
        if (text) CFRelease(text);
        CFRelease(uuid);
      }
    }
    uuids.set(id, value);
    return value;
  }

  function currentSpaces() {
    const list = CopyManagedDisplaySpaces(connection);
    if (!list) return [];
    try {
      const spaces = [];
      const count = Number(CFArrayGetCount(list));
      for (let index = 0; index < count; index += 1) {
        const entry = CFArrayGetValueAtIndex(list, index);
        if (!entry) continue;
        const display = string(CFDictionaryGetValue(entry, keys.display));
        spaces.push({
          // The primary display is re-read each time: it changes when the
          // user moves the menu bar to another display.
          display: display === CGS_MAIN_DISPLAY_IDENTIFIER ? displayUuid(CGMainDisplayID()) : display,
          type: number(CFDictionaryGetValue(entry, keys.currentSpace), 'type')
        });
      }
      return spaces;
    } finally {
      CFRelease(list);
    }
  }

  return { currentSpaces, displayUuid };
}

function createWindowsZOrderReader(koffi) {
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const RECT = koffi.struct('TM_EDGE_DOCK_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const MONITORINFO = koffi.struct('TM_EDGE_DOCK_MONITORINFO', {
    cbSize: 'uint32_t',
    rcMonitor: RECT,
    rcWork: RECT,
    dwFlags: 'uint32_t'
  });
  const GetTopWindow = user32.func('void * __stdcall GetTopWindow(void *hwnd)');
  const GetWindow = user32.func('void * __stdcall GetWindow(void *hwnd, uint32_t cmd)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
  const IsIconic = user32.func('bool __stdcall IsIconic(void *hwnd)');
  // 32-bit user32 only exports the non-Ptr name.
  const GetWindowLong = privateFunc([user32], ['GetWindowLongPtrW', 'GetWindowLongW'], 'intptr_t', ['void *', 'int']);
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ TM_EDGE_DOCK_RECT *rect)');
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, void *name, int maxCount)');
  const MonitorFromWindow = user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32_t flags)');
  const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(void *monitor, _Inout_ TM_EDGE_DOCK_MONITORINFO *info)');
  const DwmGetWindowAttribute = dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attribute, _Out_ uint32_t *value, uint32_t size)');

  const toRect = (rect) => ({ x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top });

  // Suspended UWP frames and windows on other virtual desktops are visible
  // to user32 but cloaked by DWM, and can be monitor-sized.
  function cloaked(hwnd) {
    const value = [0];
    return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, value, 4) === 0 && value[0] !== 0;
  }

  function describe(hwnd, exStyle) {
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    const name = Buffer.alloc(128);
    const length = GetClassNameW(hwnd, name, name.length / 2);
    const className = name.toString('utf16le', 0, Math.max(0, length) * 2);
    const windowRect = {};
    if (!GetWindowRect(hwnd, windowRect)) return null;
    const monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    const emptyRect = { left: 0, top: 0, right: 0, bottom: 0 };
    const info = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: emptyRect, rcWork: emptyRect, dwFlags: 0 };
    if (!monitor || !GetMonitorInfoW(monitor, info)) return null;
    return {
      pid: pid[0],
      className,
      topmost: (exStyle & WS_EX_TOPMOST) !== 0,
      window: toRect(windowRect),
      monitor: toRect(info.rcMonitor)
    };
  }

  // Yields the shown top-level windows from the top of the Z-order down, each
  // with its rect and its monitor's rect in physical pixels. Lazy, so the
  // caller stops walking as soon as a display is decided.
  return function* readWindows() {
    let hwnd = GetTopWindow(null);
    for (let seen = 0; hwnd && seen < WINDOWS_MAX_WALK; seen += 1, hwnd = GetWindow(hwnd, GW_HWNDNEXT)) {
      if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || cloaked(hwnd)) continue;
      const exStyle = Number(GetWindowLong(hwnd, GWL_EXSTYLE));
      // Click-through overlays and tool windows are not the app on screen.
      if (exStyle & (WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW)) continue;
      const entry = describe(hwnd, exStyle);
      if (entry) yield entry;
    }
  };
}

// The pure half of the Windows probe. `windows` runs from the top of the
// Z-order down. The display is full screen when the first app window on its
// monitor exactly fills that monitor; always-on-top windows that do not fill
// it (a floating player, a sticky note) are looked past. Focus plays no part:
// clicking a window on another display leaves this display's stack alone.
// `toDip` converts a physical-pixel rect to the DIP coordinates the dock's
// display bounds are in.
function windowsDisplayIsFullScreen(windows, displayBounds, ownPid, toDip = (rect) => rect) {
  for (const entry of windows || []) {
    if (entry.pid === ownPid || WINDOWS_SHELL_CLASSES.has(entry.className)) continue;
    if (!rectMatches(toDip(entry.monitor), displayBounds)) continue;
    if (rectMatches(entry.window, entry.monitor, 0)) return true;
    if (!entry.topmost) return false;
  }
  return false;
}

function createFullScreenProbe(options = {}) {
  const platform = options.platform || process.platform;
  const ownPid = options.pid ?? process.pid;
  const logger = options.logger || (() => {});
  let reader = null;

  function load() {
    if (reader !== null) return reader;
    try {
      const koffi = options.koffi || require('koffi');
      if (platform === 'darwin') reader = createMacSpaceReader(koffi);
      else if (platform === 'win32') reader = createWindowsZOrderReader(koffi);
      else reader = false;
    } catch (error) {
      logger(`[edge-dock] full-screen detection unavailable: ${error.message}`);
      reader = false;
    }
    return reader;
  }

  // `display` is the Electron display the dock sits on.
  return function isFullScreen(display) {
    if (!display) return false;
    const read = load();
    if (!read) return false;
    try {
      if (platform === 'darwin') return macCurrentSpaceIsFullScreen(read.currentSpaces(), read.displayUuid(display.id));
      const toDip = (rect) => options.screen?.screenToDipRect?.(null, rect) || rect;
      return windowsDisplayIsFullScreen(read(), display.bounds, ownPid, toDip);
    } catch (error) {
      logger(`[edge-dock] full-screen detection failed: ${error.message}`);
      return false;
    }
  };
}

module.exports = {
  createFullScreenProbe,
  createMacSpaceReader,
  macCurrentSpaceIsFullScreen,
  rectMatches,
  windowsDisplayIsFullScreen
};
