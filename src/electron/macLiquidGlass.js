'use strict';

// Public AppKit API only. Keep Electron's content view and Chromium hierarchy
// intact: reparenting them from a Koffi call can synchronously re-enter V8 on
// Koffi's alternate native stack and terminate the process (not a JS exception).
let cachedApi;

function loadApi() {
  if (cachedApi !== undefined) return cachedApi;
  cachedApi = null;
  const koffi = require('koffi');
  const appkit = koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const cls = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const sel = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const point = koffi.struct('TokenMonitorGlassPoint', { x: 'double', y: 'double' });
  const size = koffi.struct('TokenMonitorGlassSize', { width: 'double', height: 'double' });
  const rect = koffi.struct('TokenMonitorGlassRect', { origin: point, size });
  const get = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const release = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t']);
  const boolean = objc.func('objc_msgSend', 'bool', ['uintptr_t', 'uintptr_t']);
  const put = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const number = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'double']);
  const addSubview = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t', 'intptr_t', 'uintptr_t']);
  const setRect = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', rect]);
  const string = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'str']);
  const object = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  // NSRect is a 32-byte return: Intel uses the explicit stret entry point,
  // whereas arm64 uses objc_msgSend with the ordinary structure-return ABI.
  const frame = process.arch === 'x64'
    ? objc.func('objc_msgSend_stret', 'void', [koffi.out(koffi.pointer(rect)), 'uintptr_t', 'uintptr_t'])
    : objc.func('objc_msgSend', rect, ['uintptr_t', 'uintptr_t']);
  function getBounds(view) {
    if (process.arch !== 'x64') return frame(view, sel('bounds'));
    const result = {};
    frame(result, view, sel('bounds'));
    return result;
  }
  const glassClass = cls('NSGlassEffectView');
  if (!glassClass) return (cachedApi = null);
  cachedApi = {
    appkit, objc, glassClass, getBounds,
    get: (target, name) => get(target, sel(name)),
    call: (target, name) => release(target, sel(name)),
    addBelow: (parent, child) => addSubview(parent, sel('addSubview:positioned:relativeTo:'), child, -1, 0),
    put: (target, name, value) => put(target, sel(name), value),
    number: (target, name, value) => number(target, sel(name), value),
    setFrame: (target, value) => setRect(target, sel('setFrame:'), value),
    appearance(dark) {
      const name = string(cls('NSString'), sel('stringWithUTF8String:'), dark ? 'NSAppearanceNameDarkAqua' : 'NSAppearanceNameAqua');
      return object(cls('NSAppearance'), sel('appearanceNamed:'), name);
    },
    isMainThread: () => boolean(cls('NSThread'), sel('isMainThread'))
  };
  return cachedApi;
}

function createMacLiquidGlass(win) {
  const api = loadApi();
  if (!api) throw new Error('NSGlassEffectView unavailable');
  if (!api.isMainThread()) throw new Error('AppKit requires the main thread');
  const handle = win.getNativeWindowHandle();
  const view = handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  const window = api.get(view, 'window');
  const original = window && api.get(window, 'contentView');
  if (!original) throw new Error('Window content view unavailable');
  const bounds = api.getBounds(original);
  let glass = 0;
  let disposed = false;

  function dispose({ windowClosed = false } = {}) {
    if (disposed) return;
    disposed = true;
    // We own only the background view, never Electron's root view. After close
    // its native parent is already torn down; just release our retained object.
    if (glass) {
      if (!windowClosed && !win.isDestroyed()) api.call(glass, 'removeFromSuperview');
      api.call(glass, 'release');
    }
  }

  try {
    glass = api.get(api.get(api.glassClass, 'alloc'), 'init');
    if (!glass) throw new Error('NSGlassEffectView initialization failed');
    api.setFrame(glass, bounds);
    api.put(glass, 'setAutoresizingMask:', 2 | 16); // width + height
    api.put(glass, 'setStyle:', 0); // NSGlassEffectViewStyleRegular
    api.addBelow(original, glass);
    let lastDark;
    let lastRadius;
    return {
      update({ dark, radius }) {
        if (disposed) return;
        if (dark !== lastDark) {
          api.put(glass, 'setAppearance:', api.appearance(dark));
          lastDark = dark;
        }
        if (radius !== lastRadius) {
          api.number(glass, 'setCornerRadius:', radius);
          lastRadius = radius;
        }
        // NSWindow hiding/minimizing suspends presentation of this whole tree.
        // Do not hide the content container itself: Chromium must still paint
        // its first frame while show:false so renderer-ready can reveal it.
        // AppKit autoresizes the background with the unchanged Electron root.
      },
      dispose
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

module.exports = { createMacLiquidGlass };
