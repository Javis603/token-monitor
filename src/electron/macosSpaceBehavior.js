'use strict';

// Electron exposes the native NSView handle on macOS, but not AppKit's window
// collectionBehavior. Use the Objective-C runtime for the one missing flag we
// need, and keep the bridge lazy/best-effort so other platforms never load it.

const NS_WINDOW_COLLECTION_BEHAVIOR_MOVE_TO_ACTIVE_SPACE = 1n << 1n;

let macSpaceApi = null;

function nativeHandleValue(win) {
  const handle = win.getNativeWindowHandle();
  return handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
}

function createMacSpaceApi(koffi) {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const selRegisterName = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const sendUintptr = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const sendVoidWithUint64 = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uint64_t']);
  const windowSelector = selRegisterName('window');
  const collectionBehaviorSelector = selRegisterName('collectionBehavior');
  const setCollectionBehaviorSelector = selRegisterName('setCollectionBehavior:');

  return {
    setMoveToActiveSpace(viewHandle, enabled) {
      const nativeWindow = sendUintptr(viewHandle, windowSelector);
      if (!nativeWindow) return false;
      const current = BigInt(sendUintptr(nativeWindow, collectionBehaviorSelector));
      const next = enabled
        ? current | NS_WINDOW_COLLECTION_BEHAVIOR_MOVE_TO_ACTIVE_SPACE
        : current & ~NS_WINDOW_COLLECTION_BEHAVIOR_MOVE_TO_ACTIVE_SPACE;
      if (next !== current) {
        sendVoidWithUint64(nativeWindow, setCollectionBehaviorSelector, next);
      }
      return true;
    }
  };
}

function loadMacSpaceApi() {
  if (macSpaceApi !== null) return macSpaceApi;
  try {
    macSpaceApi = createMacSpaceApi(require('koffi'));
  } catch {
    macSpaceApi = false;
  }
  return macSpaceApi;
}

function setMoveToActiveSpace(win, enabled, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win || win.isDestroyed?.()) return false;
  const api = options.api || loadMacSpaceApi();
  if (!api) return false;
  try {
    return api.setMoveToActiveSpace(nativeHandleValue(win), enabled) === true;
  } catch {
    return false;
  }
}

module.exports = {
  NS_WINDOW_COLLECTION_BEHAVIOR_MOVE_TO_ACTIVE_SPACE,
  createMacSpaceApi,
  setMoveToActiveSpace
};
