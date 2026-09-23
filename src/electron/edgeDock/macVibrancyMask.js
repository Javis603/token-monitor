'use strict';

// Clips a window's native material (NSVisualEffectView) to an arbitrary shape.
// Electron can only attach vibrancy to a whole rectangular window; AppKit's
// public `maskImage` property on the effect view is what lets the edge dock keep
// real glass in a sculpted silhouette. Lazy and best-effort like the Space
// behaviour bridge: failures are reported so the controller can remove the
// rectangular material before revealing the renderer-backed fallback.

let api = null;

function createApi(koffi) {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const sel = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const getClass = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const send = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const sendPointer = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const sendIndex = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uint64_t']);
  const sendBool = objc.func('objc_msgSend', 'bool', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const sendBytes = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'void *', 'uint64_t']);
  const sendSize = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'double', 'double']);
  const sendVoid = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t']);
  const selectors = Object.fromEntries([
    'window', 'contentView', 'superview', 'subviews', 'count', 'objectAtIndex:', 'isKindOfClass:',
    'dataWithBytes:length:', 'alloc', 'initWithData:', 'setSize:', 'setMaskImage:', 'release', 'invalidateShadow'
  ].map((name) => [name, sel(name)]));
  const effectViewClass = getClass('NSVisualEffectView');

  function effectViews(view, found = []) {
    if (sendBool(view, selectors['isKindOfClass:'], effectViewClass)) found.push(view);
    const subviews = send(view, selectors.subviews);
    const count = Number(send(subviews, selectors.count));
    for (let index = 0; index < count; index += 1) {
      effectViews(sendIndex(subviews, selectors['objectAtIndex:'], index), found);
    }
    return found;
  }

  return {
    apply(viewHandle, png, width, height) {
      const nsWindow = send(viewHandle, selectors.window);
      if (!nsWindow) return false;
      const frameView = send(send(nsWindow, selectors.contentView), selectors.superview);
      const views = effectViews(frameView);
      if (views.length === 0) return false;
      const data = sendBytes(getClass('NSData'), selectors['dataWithBytes:length:'], png, png.length);
      const image = sendPointer(send(getClass('NSImage'), selectors.alloc), selectors['initWithData:'], data);
      if (!image) return false;
      // The PNG is rendered at device scale; the mask is laid out in points.
      sendSize(image, selectors['setSize:'], width, height);
      for (const view of views) sendPointer(view, selectors['setMaskImage:'], image);
      sendVoid(image, selectors.release);
      // The window shadow is computed from content alpha and cached.
      sendVoid(nsWindow, selectors.invalidateShadow);
      return true;
    }
  };
}

function loadApi() {
  if (api !== null) return api;
  try {
    api = createApi(require('koffi'));
  } catch {
    api = false;
  }
  return api;
}

function applyVibrancyMask(win, png, width, height, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win || win.isDestroyed?.() || !png?.length) return false;
  const bridge = options.api || loadApi();
  if (!bridge) return false;
  try {
    const handle = win.getNativeWindowHandle();
    const view = handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
    return bridge.apply(Number(view), png, width, height) === true;
  } catch {
    return false;
  }
}

module.exports = { applyVibrancyMask };
