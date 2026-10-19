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
    'dataWithBytes:length:', 'alloc', 'initWithData:', 'initWithCGImage:size:', 'setSize:', 'setMaskImage:', 'release', 'invalidateShadow'
  ].map((name) => [name, sel(name)]));
  const effectViewClass = getClass('NSVisualEffectView');
  let bitmapApi;

  // The mask bitmap is already BGRA at device scale. Handing it to CoreGraphics
  // avoids a PNG encode in this process and a PNG decode in AppKit; the image
  // carries the same pixels the encoder would have written losslessly.
  function loadBitmapApi() {
    if (bitmapApi !== undefined) return bitmapApi;
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const size = koffi.struct('TokenMonitorMaskSize', { width: 'double', height: 'double' });
    bitmapApi = {
      dataCreate: cf.func('CFDataCreate', 'uintptr_t', ['uintptr_t', 'void *', 'int64_t']),
      release: cf.func('CFRelease', 'void', ['uintptr_t']),
      provider: cg.func('CGDataProviderCreateWithCFData', 'uintptr_t', ['uintptr_t']),
      colorSpace: cg.func('CGColorSpaceCreateDeviceRGB', 'uintptr_t', []),
      imageCreate: cg.func('CGImageCreate', 'uintptr_t',
        ['uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t', 'uint32_t', 'uintptr_t', 'uintptr_t', 'bool', 'int32_t']),
      initImage: objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uintptr_t', size])
    };
    return bitmapApi;
  }

  function imageFromBitmap(mask, width, height) {
    const api = loadBitmapApi();
    const { buffer, pixelWidth, pixelHeight } = mask;
    const owned = [];
    try {
      const data = api.dataCreate(0, buffer, pixelWidth * pixelHeight * 4);
      if (!data) return 0;
      owned.push(data);
      const provider = api.provider(data);
      if (!provider) return 0;
      owned.push(provider);
      const space = api.colorSpace();
      if (!space) return 0;
      owned.push(space);
      // kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little: the
      // buffer is BGRA, and its RGB stays 0, so premultiplied black is exact.
      const image = api.imageCreate(pixelWidth, pixelHeight, 8, 32, pixelWidth * 4, space, 8194, provider, 0, false, 0);
      if (!image) return 0;
      owned.push(image);
      return api.initImage(send(getClass('NSImage'), selectors.alloc), selectors['initWithCGImage:size:'], image, { width, height });
    } finally {
      // NSImage retains the CGImage, which retains the space, provider and
      // data, so our references can go even when initImage fails or throws.
      for (let index = owned.length - 1; index >= 0; index -= 1) {
        try { api.release(owned[index]); } catch { /* keep releasing */ }
      }
    }
  }

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
    apply(viewHandle, mask, width, height, refreshShadow = true) {
      const nsWindow = send(viewHandle, selectors.window);
      if (!nsWindow) return false;
      const frameView = send(send(nsWindow, selectors.contentView), selectors.superview);
      const views = effectViews(frameView);
      if (views.length === 0) return false;
      let image;
      if (mask && !Buffer.isBuffer(mask) && mask.buffer) {
        image = imageFromBitmap(mask, width, height);
      } else {
        // Legacy PNG path, kept for callers that already hold encoded data.
        const data = sendBytes(getClass('NSData'), selectors['dataWithBytes:length:'], mask, mask.length);
        image = sendPointer(send(getClass('NSImage'), selectors.alloc), selectors['initWithData:'], data);
        if (image) sendSize(image, selectors['setSize:'], width, height);
      }
      if (!image) return false;
      // The mask is laid out in points; the bitmap itself is at device scale.
      try {
        for (const view of views) sendPointer(view, selectors['setMaskImage:'], image);
      } finally {
        try { sendVoid(image, selectors.release); } catch { /* keep the result */ }
      }
      // The window shadow is computed from content alpha and cached. A window
      // without one has nothing to invalidate.
      if (refreshShadow) sendVoid(nsWindow, selectors.invalidateShadow);
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

function applyVibrancyMask(win, mask, width, height, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win || win.isDestroyed?.() || !mask) return false;
  if (Buffer.isBuffer(mask)) {
    if (mask.length === 0) return false;
  } else {
    // The bridge reads exactly pixelWidth * pixelHeight * 4 bytes from the
    // caller's buffer; a mismatch would read past it. length is bytes only for
    // a Buffer, so require one.
    const { buffer, pixelWidth, pixelHeight } = mask;
    if (!Buffer.isBuffer(buffer) || !Number.isInteger(pixelWidth) || !Number.isInteger(pixelHeight)
      || pixelWidth <= 0 || pixelHeight <= 0 || buffer.length < pixelWidth * pixelHeight * 4) return false;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const bridge = options.api || loadApi();
  if (!bridge) return false;
  try {
    const handle = win.getNativeWindowHandle();
    const view = handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
    const shadow = typeof win.hasShadow === 'function' ? win.hasShadow() !== false : true;
    return bridge.apply(Number(view), mask, width, height, shadow) === true;
  } catch {
    return false;
  }
}

module.exports = { applyVibrancyMask };
