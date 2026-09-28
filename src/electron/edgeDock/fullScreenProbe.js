'use strict';

// Answers "is another app full screen on this display?" for the edge dock's
// `alwaysExceptFullScreen` mode. Neither platform has a public event for it,
// so the controller polls this at a slow cadence while that mode is selected.
//
// macOS: a full-screen app lives on its own Space, and the dock's windows join
// every Space. CGWindowListCopyWindowInfo lists the windows on screen right
// now; a normal-level window of another process covering the whole display is
// a full-screen app. The keys read here (layer, bounds, owner PID, alpha) need
// no Screen Recording permission - only window titles do. A zoomed window
// normally stops at the menu bar, so it does not match; with both the menu bar
// and the Dock set to auto-hide a zoomed window can fill the display and reads
// as full screen, which is also what it looks like.
//
// Windows: the foreground window counts when its rect is exactly its
// monitor's. A maximized window overhangs the monitor by its resize border,
// so it does not match; the desktop and taskbar do, and are excluded by class.
//
// Everything is best-effort: koffi or a library failing to load, or any call
// throwing, returns a probe that reports "not full screen", which leaves the
// dock always visible - the mode's desktop behaviour.

const CF_STRING_ENCODING_UTF8 = 0x08000100;
const CF_NUMBER_DOUBLE_TYPE = 13;
const CG_WINDOW_LIST_ON_SCREEN_ONLY = 1;
const CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS = 16;
const MONITOR_DEFAULTTONEAREST = 2;
const WINDOWS_SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);
const RECT_TOLERANCE = 1;

function rectMatches(rect, bounds, tolerance = RECT_TOLERANCE) {
  if (!rect || !bounds) return false;
  return ['x', 'y', 'width', 'height'].every((key) => (
    Number.isFinite(Number(rect[key]))
    && Math.abs(Number(rect[key]) - Number(bounds[key])) <= tolerance
  ));
}

// The pure half of the macOS probe: `windows` are CGWindowList entries already
// read into plain objects.
function macWindowsCoverDisplay(windows, displayBounds, ownPid) {
  return (windows || []).some((win) => (
    win.layer === 0
    && win.pid !== ownPid
    && !(win.alpha <= 0)
    && rectMatches(win.bounds, displayBounds)
  ));
}

function createMacWindowReader(koffi) {
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const CFStringCreateWithCString = cf.func('void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32_t encoding)');
  const CFArrayGetCount = cf.func('intptr_t CFArrayGetCount(void *array)');
  const CFArrayGetValueAtIndex = cf.func('void *CFArrayGetValueAtIndex(void *array, intptr_t index)');
  const CFDictionaryGetValue = cf.func('void *CFDictionaryGetValue(void *dict, void *key)');
  const CFNumberGetValue = cf.func('bool CFNumberGetValue(void *number, int type, _Out_ double *value)');
  const CFRelease = cf.func('void CFRelease(void *ref)');
  const CGWindowListCopyWindowInfo = cg.func('void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)');

  // The kCGWindow* key constants are CFStrings whose value is their own name.
  // Created once and kept for the life of the process.
  const key = (name) => CFStringCreateWithCString(null, name, CF_STRING_ENCODING_UTF8);
  const keys = {
    layer: key('kCGWindowLayer'),
    bounds: key('kCGWindowBounds'),
    pid: key('kCGWindowOwnerPID'),
    alpha: key('kCGWindowAlpha'),
    x: key('X'),
    y: key('Y'),
    width: key('Width'),
    height: key('Height')
  };

  function number(dict, name) {
    const value = CFDictionaryGetValue(dict, keys[name]);
    if (!value) return null;
    const out = [0];
    return CFNumberGetValue(value, CF_NUMBER_DOUBLE_TYPE, out) ? out[0] : null;
  }

  return function readWindows() {
    const list = CGWindowListCopyWindowInfo(
      CG_WINDOW_LIST_ON_SCREEN_ONLY | CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
      0
    );
    if (!list) return [];
    try {
      const windows = [];
      const count = Number(CFArrayGetCount(list));
      for (let index = 0; index < count; index += 1) {
        const entry = CFArrayGetValueAtIndex(list, index);
        const bounds = entry ? CFDictionaryGetValue(entry, keys.bounds) : null;
        if (!bounds) continue;
        windows.push({
          layer: number(entry, 'layer'),
          pid: number(entry, 'pid'),
          alpha: number(entry, 'alpha') ?? 1,
          bounds: {
            x: number(bounds, 'x'),
            y: number(bounds, 'y'),
            width: number(bounds, 'width'),
            height: number(bounds, 'height')
          }
        });
      }
      return windows;
    } finally {
      CFRelease(list);
    }
  };
}

function createWindowsForegroundReader(koffi) {
  const user32 = koffi.load('user32.dll');
  const RECT = koffi.struct('TM_EDGE_DOCK_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const MONITORINFO = koffi.struct('TM_EDGE_DOCK_MONITORINFO', {
    cbSize: 'uint32_t',
    rcMonitor: RECT,
    rcWork: RECT,
    dwFlags: 'uint32_t'
  });
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ TM_EDGE_DOCK_RECT *rect)');
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, void *name, int maxCount)');
  const MonitorFromWindow = user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32_t flags)');
  const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(void *monitor, _Inout_ TM_EDGE_DOCK_MONITORINFO *info)');

  const toRect = (rect) => ({ x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top });

  // Returns the foreground window's rect and its monitor's rect, both in
  // physical pixels, or null when there is nothing to judge.
  return function readForeground() {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return null;
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
    return { pid: pid[0], className, window: toRect(windowRect), monitor: toRect(info.rcMonitor) };
  };
}

// The pure half of the Windows probe. `toDip` converts a physical-pixel rect to
// the DIP coordinates the dock's display bounds are in.
function windowsForegroundCoversDisplay(foreground, displayBounds, ownPid, toDip = (rect) => rect) {
  if (!foreground || foreground.pid === ownPid) return false;
  if (WINDOWS_SHELL_CLASSES.has(foreground.className)) return false;
  if (!rectMatches(foreground.window, foreground.monitor, 0)) return false;
  return rectMatches(toDip(foreground.monitor), displayBounds);
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
      if (platform === 'darwin') reader = createMacWindowReader(koffi);
      else if (platform === 'win32') reader = createWindowsForegroundReader(koffi);
      else reader = false;
    } catch (error) {
      logger(`[edge-dock] full-screen detection unavailable: ${error.message}`);
      reader = false;
    }
    return reader;
  }

  return function isFullScreen(displayBounds) {
    if (!displayBounds) return false;
    const read = load();
    if (!read) return false;
    try {
      if (platform === 'darwin') return macWindowsCoverDisplay(read(), displayBounds, ownPid);
      const toDip = (rect) => options.screen?.screenToDipRect?.(null, rect) || rect;
      return windowsForegroundCoversDisplay(read(), displayBounds, ownPid, toDip);
    } catch (error) {
      logger(`[edge-dock] full-screen detection failed: ${error.message}`);
      return false;
    }
  };
}

module.exports = {
  createFullScreenProbe,
  macWindowsCoverDisplay,
  rectMatches,
  windowsForegroundCoversDisplay
};
