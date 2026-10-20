'use strict';

// Keep Electron's content view and Chromium hierarchy
// intact: reparenting them from a Koffi call can synchronously re-enter V8 on
// Koffi's alternate native stack and terminate the process (not a JS exception).
let cachedApi;

function loadApi() {
  if (cachedApi !== undefined) return cachedApi;
  cachedApi = null;
  const koffi = require('koffi');
  const appkit = koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const quartz = koffi.load('/System/Library/Frameworks/QuartzCore.framework/QuartzCore');
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
  const setPoint = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', point]);
  const doubleObject = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'double']);
  const string = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'str']);
  const object = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const color = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'double', 'double', 'double', 'double']);
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
    appkit, quartz, objc, glassClass, getBounds,
    // AppKit exposes only a corner radius publicly. The shape setter is the one
    // the system's own glass uses for arbitrary outlines; probe it rather than
    // assume it, so a macOS that drops it falls back instead of crashing.
    supportsPath: responds(glassClass, sel('instancesRespondToSelector:'), sel('_setPath:')),
    supportsSubdued: responds(glassClass, sel('instancesRespondToSelector:'), sel('set_subduedState:')),
    supportsForceMainAppearance: responds(cls('NSWindow'), sel('instancesRespondToSelector:'), sel('_setForceMainAppearance:'))
      && responds(cls('NSWindow'), sel('instancesRespondToSelector:'), sel('_forceMainAppearance')),
    setPath(target, commands, height, mask = 0, refreshShadow = true) {
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
        if (mask) put(mask, sel('setPath:'), path);
      } finally {
        cg.release(path); // the view retains its own reference
      }
      // The window shadow is computed from content alpha and cached. A window
      // without one has nothing to invalidate.
      const window = get(target, sel('window'));
      if (window && refreshShadow) release(window, sel('invalidateShadow'));
    },
    get: (target, name) => get(target, sel(name)),
    flag: (target, name) => boolean(target, sel(name)),
    call: (target, name) => release(target, sel(name)),
    addBelow: (parent, child) => addSubview(parent, sel('addSubview:positioned:relativeTo:'), child, -1, 0),
    put: (target, name, value) => put(target, sel(name), value),
    number: (target, name, value) => number(target, sel(name), value),
    setFrame: (target, value) => setRect(target, sel('setFrame:'), value),
    tintColor: (opacity) => color(cls('NSColor'), sel('colorWithSRGBRed:green:blue:alpha:'), 0, 0, 0, opacity),
    layer: (name) => get(cls(name), sel('layer')),
    setPoint: (target, name, value) => setPoint(target, sel(name), value),
    array(values) {
      const array = get(cls('NSMutableArray'), sel('array'));
      for (const value of values) put(array, sel('addObject:'), value);
      return array;
    },
    scalar: (value) => doubleObject(cls('NSNumber'), sel('numberWithDouble:'), value),
    withoutAnimation(callback) {
      const transaction = cls('CATransaction');
      release(transaction, sel('begin'));
      try { put(transaction, sel('setDisableActions:'), 1); callback(); }
      finally { release(transaction, sel('commit')); }
    },
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
  let shade = 0, shadeMask = 0, lastShade, shadeActive = false;
  let disposed = false;
  const originalForceMainAppearance = api.supportsForceMainAppearance && api.flag(window, '_forceMainAppearance');
  let forcedMainAppearance = false;

  function syncGlassAppearance(forceMain) {
    if (!api.supportsForceMainAppearance || originalForceMainAppearance) return;
    if (forceMain === forcedMainAppearance) return;
    api.put(window, '_setForceMainAppearance:', forceMain ? 1 : 0);
    forcedMainAppearance = forceMain;
  }

  function dispose({ windowClosed = false } = {}) {
    if (disposed) return;
    disposed = true;
    // We own only the background view, never Electron's root view. After close
    // its native parent is already torn down; just release our retained object.
    if (glass) {
      try {
        if (!windowClosed && !win.isDestroyed()) {
          try { syncGlassAppearance(false); if (shade) api.call(shade, 'removeFromSuperlayer'); }
          finally { api.call(glass, 'removeFromSuperview'); }
        }
      }
      finally {
        try { if (shade) api.call(shade, 'release'); }
        finally { api.call(glass, 'release'); }
      }
    }
  }

  try {
    glass = api.get(api.get(api.glassClass, 'alloc'), 'init');
    if (!glass) throw new Error('NSGlassEffectView initialization failed');
    if (shaped) api.put(glass, 'setWantsLayer:', 1);
    api.setFrame(glass, bounds);
    api.put(glass, 'setAutoresizingMask:', 2 | 16); // width + height
    api.put(glass, 'setStyle:', 0); // NSGlassEffectViewStyleRegular
    // In a key window the glass blurs far more heavily and adds a brightening
    // layer, which washes the whole surface out behind dense figures. The
    // subdued state drops that layer and most of the blur while the window
    // keeps its active shadow; unfocused, it matches the default glass.
    // Private, so probed: without it the glass keeps the system behaviour.
    if (api.supportsSubdued) api.put(glass, 'set_subduedState:', 1);
    api.addBelow(original, glass);
    let lastStyle = 'regular';
    let lastTint = 0;
    let lastDark;
    let lastRadius;
    let lastShape;
    let lastVisible;
    return {
      hardwareShade: shaped,
      update({ dark, radius, shape, hardwareShade, visible = true, style = 'regular', tintOpacity }) {
        if (disposed) return;
        const nextStyle = style === 'clear' ? 'clear' : 'regular';
        if (nextStyle !== lastStyle) {
          api.put(glass, 'setStyle:', nextStyle === 'clear' ? 1 : 0); // NSGlassEffectViewStyle
          // Subduing Regular removes its focused-window wash, but subduing
          // Clear replaces its sharp backdrop with a heavily blurred one.
          // Restore each style's state when switching the retained view.
          if (api.supportsSubdued) api.put(glass, 'set_subduedState:', nextStyle === 'clear' ? 0 : 1);
          lastStyle = nextStyle;
        }
        // Tint changes must reach the retained view even without a style change.
        // Zero restores the system tint; blur and refraction remain native.
        const parsedTint = tintOpacity == null ? NaN : Number(tintOpacity);
        const tint = Number.isFinite(parsedTint) ? Math.max(0, Math.min(1, parsedTint)) : nextStyle === 'clear' ? 0.35 : 0;
        // Inactive Regular glass fades even an opaque tint, so the same value
        // looks pale on the Dock and dark on a focused main window. Keep tinted
        // Regular on the same appearance policy as Clear, preserving Regular's
        // untinted default. This changes appearance, never actual input focus.
        // The private override is probed and restored when no longer needed.
        syncGlassAppearance(nextStyle === 'clear' || tint > 0);
        if (tint !== lastTint) {
          api.put(glass, 'setTintColor:', tint > 0 ? api.tintColor(tint) : 0);
          lastTint = tint;
        }
        if (visible !== lastVisible) {
          api.put(glass, 'setHidden:', visible ? 0 : 1);
          if (shade) api.put(shade, 'setHidden:', visible && shadeActive ? 0 : 1);
          lastVisible = visible;
        }
        if (dark !== lastDark) {
          api.put(glass, 'setAppearance:', api.appearance(dark));
          lastDark = dark;
        }
        if (shape) {
          const key = JSON.stringify(shape);
          const shadeKey = JSON.stringify([hardwareShade ?? null, shape.height]);
          api.withoutAnimation(() => {
            if (hardwareShade && !shade) {
              // A layer of the glass, below Chromium: never reparent or mask
              // Electron's content view. The native path and camera scrim then
              // commit together instead of straddling two compositor frames.
              const backing = api.get(glass, 'layer');
              if (!backing) throw new Error('Native camera shade backing unavailable');
              shade = api.layer('CAGradientLayer');
              api.get(shade, 'retain');
              shadeMask = api.layer('CAShapeLayer');
              if (!shade || !shadeMask) throw new Error('Native camera shade unavailable');
              api.put(shade, 'setMask:', shadeMask);
              api.setPoint(shade, 'setStartPoint:', { x: 0, y: 1 });
              api.setPoint(shade, 'setEndPoint:', { x: 0, y: 0 });
              api.put(backing, 'addSublayer:', shade);
              // AppKit owns the material's backing layers; the camera cap sits
              // above those layers and the whole glass view stays below text.
              api.number(shade, 'setZPosition:', 1);
              lastShape = undefined;
            }
            if (shade) {
              api.put(shade, 'setHidden:', hardwareShade && visible ? 0 : 1);
              api.setFrame(shade, { origin: { x: 0, y: 0 }, size: { width: shape.width, height: shape.height } });
              if (hardwareShade && shadeKey !== lastShade) {
                const { capEnd: cap, fadeEnd: fade, progress } = hardwareShade;
                const p = Math.max(0, Math.min(1, progress));
                api.put(shade, 'setColors:', api.array([1, 1 - p * 0.36, 1 - p * 0.68, 1 - p * 0.77]
                  .map(alpha => api.get(api.tintColor(alpha), 'CGColor'))));
                api.put(shade, 'setLocations:', api.array([0, 0.35, 0.72, 1]
                  .map(stop => api.scalar(Math.max(0, Math.min(1, (cap + (fade - cap) * stop) / shape.height))))));
              }
            }
            if (key !== lastShape) {
              // A window can change its shadow flag after creation, so read the
              // current value when a new path is actually committed.
              const refreshShadow = typeof win.hasShadow === 'function' ? win.hasShadow() !== false : true;
              api.setPath(glass, shape.commands, shape.height, shadeMask, refreshShadow);
            }
          });
          lastShape = key; lastShade = shadeKey; shadeActive = Boolean(hardwareShade);
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
