'use strict';

// Chromium's HWNDMessageHandler::OnMouseActivate returns MA_NOACTIVATEANDEAT
// for a non-activatable widget with a non-client view. After Win+L, Windows
// starts asking our focusable:false dock windows to activate on mouse-down;
// that answer eats the press, leaving the renderer only a pointerup. Merely
// reapplying focusable:false, click-through or topmost cannot change the answer.
// A non-activating interactive window must instead return MA_NOACTIVATE.
// https://learn.microsoft.com/windows/win32/inputdev/wm-mouseactivate
// Electron's hookWindowMessage observes messages but cannot override LRESULT.
// Use the documented subclass chain, leaving every other message to Chromium.

const WM_MOUSEACTIVATE = 0x0021;
const WM_NCDESTROY = 0x0082;
const MA_NOACTIVATE = 3;
const SUBCLASS_ID = 1;

function createWindowsNonActivatingInput(koffi) {
  const lib = koffi.load('comctl32.dll');
  const proc = koffi.proto(
    'intptr_t __stdcall TokenMonitorNonActivatingSubclassProc(uintptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam, uintptr_t id, uintptr_t data)'
  );
  const setSubclass = lib.func('int32_t __stdcall SetWindowSubclass(uintptr_t hwnd, void *proc, uintptr_t id, uintptr_t data)');
  const removeSubclass = lib.func('int32_t __stdcall RemoveWindowSubclass(uintptr_t hwnd, void *proc, uintptr_t id)');
  const next = lib.func('intptr_t __stdcall DefSubclassProc(uintptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam)');
  const installed = new WeakSet();

  return (win) => {
    if (!win || win.isDestroyed()) return false;
    if (installed.has(win)) return true;
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
    let callback = null;
    let releasePending = false;
    const release = () => {
      if (releasePending) return;
      releasePending = true;
      // WM_NCDESTROY/closed can run inside this very callback. Unregister only
      // after the native message stack has returned, never from within it.
      setImmediate(() => {
        koffi.unregister(callback);
        installed.delete(win);
      });
    };
    callback = koffi.register((target, message, wParam, lParam, id) => {
      if (message === WM_MOUSEACTIVATE) return MA_NOACTIVATE;
      if (message === WM_NCDESTROY) {
        try { removeSubclass(target, callback, id); } catch { /* HWND destruction also removes its subclasses. */ }
        release();
      }
      return next(target, message, wParam, lParam);
    }, koffi.pointer(proc));
    try {
      if (setSubclass(hwnd, callback, SUBCLASS_ID, 0) === 0) throw new Error('SetWindowSubclass returned FALSE');
    } catch (error) {
      koffi.unregister(callback);
      throw error;
    }
    installed.add(win);
    win.once('closed', release);
    return true;
  };
}

let install = null;

function installWindowsNonActivatingInput(win, { platform = process.platform, logger = () => {} } = {}) {
  if (platform !== 'win32') return false;
  try {
    install ||= createWindowsNonActivatingInput(require('koffi'));
    return install(win);
  } catch (error) {
    logger(`[edge-dock] non-activating input unavailable: ${error.message}`);
    return false;
  }
}

module.exports = { createWindowsNonActivatingInput, installWindowsNonActivatingInput };
