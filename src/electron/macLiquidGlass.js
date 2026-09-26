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
  const responds = objc.func('objc_msgSend', 'bool', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  let pathApi;
  function loadPathApi() {
    if (pathApi !== undefined) return pathApi;
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    pathApi = {
      cg,
      create: cg.func('CGPathCreateMutable', 'uintptr_t', []),
      moveTo: cg.func('CGPathMoveToPoint', 'void', ['uintptr_t', 'uintptr_t', 'double', 'double']),
      lineTo: cg.func('CGPathAddLineToPoint', 'void', ['uintptr_t', 'uintptr_t', 'double', 'double']),
      curveTo: cg.func('CGPathAddCurveToPoint', 'void', ['uintptr_t', 'uintptr_t', 'double', 'double', 'double', 'double', 'double', 'double']),
      close: cg.func('CGPathCloseSubpath', 'void', ['uintptr_t']),
      release: cg.func('CGPathRelease', 'void', ['uintptr_t'])
    };
    return pathApi;
  }
  cachedApi = {
    appkit, objc, glassClass, getBounds,
    // AppKit exposes only a corner radius publicly. The shape setter is the one
    // the system's own glass uses for arbitrary outlines; probe it rather than
    // assume it, so a macOS that drops it falls back instead of crashing.
    supportsPath: responds(glassClass, sel('instancesRespondToSelector:'), sel('_setPath:')),
    setPath(target, commands, height) {
      const cg = loadPathApi();
      const path = cg.create();
      try {
        // Shape commands are top-down points; the view's layer is bottom-up.
        for (const [op, ...p] of commands) {
          if (op === 'M') cg.moveTo(path, 0, p[0], height - p[1]);
          else if (op === 'L') cg.lineTo(path, 0, p[0], height - p[1]);
          else if (op === 'C') cg.curveTo(path, 0, p[0], height - p[1], p[2], height - p[3], p[4], height - p[5]);
          else if (op === 'Z') cg.close(path);
        }
        put(target, sel('_setPath:'), path);
      } finally {
        cg.release(path); // the view retains its own reference
      }
      // The window shadow is computed from content alpha and cached.
      const window = get(target, sel('window'));
      if (window) release(window, sel('invalidateShadow'));
    },
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

function createMacLiquidGlass(win, { shaped = false } = {}) {
  const api = loadApi();
  if (!api) throw new Error('NSGlassEffectView unavailable');
  if (shaped && !api.supportsPath) throw new Error('NSGlassEffectView cannot take a custom shape');
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
    let lastShape;
    return {
      update({ dark, radius, shape }) {
        if (disposed) return;
        if (dark !== lastDark) {
          api.put(glass, 'setAppearance:', api.appearance(dark));
          lastDark = dark;
        }
        if (shape) {
          const key = JSON.stringify(shape);
          if (key !== lastShape) {
            api.setPath(glass, shape.commands, shape.height);
            lastShape = key;
          }
        } else if (radius !== lastRadius) {
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
