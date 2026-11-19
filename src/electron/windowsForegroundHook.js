'use strict';

// Windows-only: tell us when any window in the system takes the foreground.
//
// windowsTaskbarZOrder.js needs this because the taskbar is raised over an
// always-on-top widget exactly when it takes activation, and a window is never
// notified when another window overtakes it. The widget's own blur covers the
// one transition that starts at the widget; every other one — switching apps
// from the taskbar without touching the widget, which is what the widget is
// parked there for — has no observable event short of a system-wide hook.
//
// EVENT_SYSTEM_FOREGROUND with WINEVENT_OUTOFCONTEXT injects nothing into other
// processes: the OS queues the event and delivers it on this thread the next
// time it pumps messages, which Electron's main thread does anyway.
//
// The callback runs from that message pump, so it does nothing but hand off to
// the next tick. Calling into Electron from inside a native callback is the
// failure mode this whole file has to avoid. Everything else — koffi missing,
// user32 refusing to load, the hook failing to install — returns null, and the
// caller keeps its polling fallback.

const EVENT_SYSTEM_FOREGROUND = 0x0003;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const WINEVENT_SKIPOWNPROCESS = 0x0002;

// null = not yet probed, false = unavailable, object = ready
let user32 = null;

function loadUser32() {
  if (user32 !== null) return user32;
  try {
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    user32 = {
      koffi,
      WinEventProc: koffi.proto(
        'void __stdcall WinEventProc(void *hook, uint32_t event, void *hwnd, int32_t idObject, int32_t idChild, uint32_t idEventThread, uint32_t eventTime)'
      ),
      SetWinEventHook: lib.func(
        'void * __stdcall SetWinEventHook(uint32_t eventMin, uint32_t eventMax, void *hmodWinEventProc, void *pfnWinEventProc, uint32_t idProcess, uint32_t idThread, uint32_t dwFlags)'
      ),
      UnhookWinEvent: lib.func('bool __stdcall UnhookWinEvent(void *hWinEventHook)')
    };
  } catch {
    user32 = false;
  }
  return user32;
}

// Returns an unsubscribe function, or null when no hook could be installed.
function subscribeForegroundChange(handler, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32' || typeof handler !== 'function') return null;
  const lib = loadUser32();
  if (!lib) return null;

  let callback = null;
  let hook = null;
  try {
    callback = lib.koffi.register(() => {
      try {
        setImmediate(handler);
      } catch {
        // A hand-off that cannot be scheduled is one missed re-assert, and the
        // interval still covers it. Never let it escape into the message pump.
      }
    }, lib.koffi.pointer(lib.WinEventProc));
    hook = lib.SetWinEventHook(
      EVENT_SYSTEM_FOREGROUND,
      EVENT_SYSTEM_FOREGROUND,
      null,
      callback,
      0,
      0,
      WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
    );
    if (!hook) throw new Error('SetWinEventHook returned NULL');
  } catch {
    if (callback) {
      try { lib.koffi.unregister(callback); } catch { /* nothing left to release */ }
    }
    return null;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { lib.UnhookWinEvent(hook); } catch { /* the hook dies with the process anyway */ }
    try { lib.koffi.unregister(callback); } catch { /* same */ }
  };
}

module.exports = {
  subscribeForegroundChange
};
