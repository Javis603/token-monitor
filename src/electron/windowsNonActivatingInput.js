'use strict';

// Chromium's HWNDMessageHandler::OnMouseActivate returns MA_NOACTIVATEANDEAT
// for a non-activatable widget with a non-client view. After Win+L, Windows
// starts asking our focusable:false dock windows to activate on mouse-down;
// that answer eats the press, leaving the renderer only a pointerup. Merely
// reapplying focusable:false, click-through or topmost cannot change the answer.
// A non-activating interactive window must instead return MA_NOACTIVATE.
// https://learn.microsoft.com/windows/win32/inputdev/wm-mouseactivate
// Electron's hookWindowMessage observes messages but cannot override LRESULT.
// Keep that subclass chain entirely native: DefSubclassProc can synchronously
// emit Electron events. Calling it through Koffi's alternate stack lets those
// events re-enter V8 on the wrong stack and crash during garbage collection.

const path = require('node:path');

function windowsInputLibraryPath(app, resourcesPath = process.resourcesPath) {
  return app.isPackaged
    ? path.join(resourcesPath, 'windows-dock', 'TokenMonitor.WindowInput.dll')
    : path.resolve(__dirname, '../../build/windows-dock/TokenMonitor.WindowInput.dll');
}

function createWindowsNonActivatingInput(koffi, libraryPath) {
  const lib = koffi.load(libraryPath);
  const setSubclass = lib.func('int32_t __stdcall TokenMonitorInstallNonActivatingInput(uintptr_t hwnd)');
  const installed = new WeakSet();

  return (win) => {
    if (!win || win.isDestroyed()) return false;
    if (installed.has(win)) return true;
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
    if (setSubclass(hwnd) === 0) throw new Error('SetWindowSubclass returned FALSE');
    installed.add(win);
    return true;
  };
}

let install = null;

function installWindowsNonActivatingInput(win, { platform = process.platform, logger = () => {} } = {}) {
  if (platform !== 'win32') return false;
  try {
    install ||= createWindowsNonActivatingInput(require('koffi'), windowsInputLibraryPath(require('electron').app));
    return install(win);
  } catch (error) {
    logger(`[edge-dock] non-activating input unavailable: ${error.message}`);
    return false;
  }
}

module.exports = { createWindowsNonActivatingInput, installWindowsNonActivatingInput, windowsInputLibraryPath };
