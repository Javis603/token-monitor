'use strict';

// Turns a window's native material into a progressive blur. An
// NSVisualEffectView is a backdrop layer (the blur) plus tint layers that wash
// a dark desktop toward grey. Hiding the tint and swapping the backdrop's
// filters for Core Animation's variable blur leaves only blur whose radius
// follows a mask; the view's public mask image then fades the whole effect
// out before the window edge, so no rectangle shows where the window ends.
// CABackdropLayer and CAFilter are private; anything missing returns false and
// the caller drops the blur rather than showing a tinted rectangle.

let api = null;

function createProgressiveBlurApi(koffi) {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  koffi.load('/System/Library/Frameworks/QuartzCore.framework/QuartzCore');
  const sel = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const getClass = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const className = objc.func('object_getClassName', 'str', ['uintptr_t']);
  const send = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const sendPointer = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const sendPair = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t']);
  const sendIndex = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uint64_t']);
  const sendBool = objc.func('objc_msgSend', 'bool', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const sendSetBool = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'bool']);
  const sendDouble = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'double']);
  const sendBoolArg = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'bool']);
  const sendString = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'str']);
  const sendBytes = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'void *', 'uint64_t']);
  const sendImageRect = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t']);
  const sendSize = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'double', 'double']);
  const sendVoid = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t']);
  const classes = {
    effectView: getClass('NSVisualEffectView'), data: getClass('NSData'), image: getClass('NSImage'),
    string: getClass('NSString'), number: getClass('NSNumber'), array: getClass('NSArray'), filter: getClass('CAFilter')
  };
  const supports = (target, ...selectors) => target && selectors.every(name => sendBool(target, sel('respondsToSelector:'), sel(name)));
  const list = (array) => {
    const count = array ? Number(send(array, sel('count'))) : 0;
    return Array.from({ length: count }, (_, index) => sendIndex(array, sel('objectAtIndex:'), index));
  };
  const string = (value) => sendString(classes.string, sel('stringWithUTF8String:'), value);
  function findEffectView(view) {
    if (sendBool(view, sel('isKindOfClass:'), classes.effectView)) return view;
    for (const child of list(send(view, sel('subviews')))) {
      const found = findEffectView(child);
      if (found) return found;
    }
    return 0;
  }
  function image(png, width, height) {
    const data = sendBytes(classes.data, sel('dataWithBytes:length:'), png, png.length);
    const result = sendPointer(send(classes.image, sel('alloc')), sel('initWithData:'), data);
    if (result) sendSize(result, sel('setSize:'), width, height);
    return result;
  }

  return {
    apply(viewHandle, { alphaPng, blurPng, width, height, radius }) {
      if (!supports(classes.filter, 'filterWithType:')) return false;
      const nsWindow = send(viewHandle, sel('window'));
      if (!nsWindow) return false;
      const effectView = findEffectView(send(send(nsWindow, sel('contentView')), sel('superview')));
      if (!effectView) return false;
      const container = list(send(send(effectView, sel('layer')), sel('sublayers')))[0];
      const layers = list(container && send(container, sel('sublayers')));
      const backdrop = layers.find((layer) => className(layer) === 'CABackdropLayer');
      if (!supports(backdrop, 'setScale:', 'setFilters:') || !supports(effectView, 'setMaskImage:')) return false;
      const mask = image(blurPng, width, height);
      const alpha = image(alphaPng, width, height);
      if (!mask || !alpha) {
        if (mask) sendVoid(mask, sel('release'));
        if (alpha) sendVoid(alpha, sel('release'));
        return false;
      }
      const cgMask = sendImageRect(mask, sel('CGImageForProposedRect:context:hints:'), 0, 0, 0);
      const filter = sendPointer(classes.filter, sel('filterWithType:'), string('variableBlur'));
      if (!cgMask || !supports(filter, 'setValue:forKey:')) { sendVoid(mask, sel('release')); sendVoid(alpha, sel('release')); return false; }
      sendPair(filter, sel('setValue:forKey:'), sendDouble(classes.number, sel('numberWithDouble:'), radius), string('inputRadius'));
      sendPair(filter, sel('setValue:forKey:'), cgMask, string('inputMaskImage'));
      sendPair(filter, sel('setValue:forKey:'), sendBoolArg(classes.number, sel('numberWithBool:'), true), string('inputNormalizeEdges'));
      // The material samples the desktop at an eighth of its resolution, which
      // softens text even where the mask asks for no blur; full-resolution
      // sampling keeps the edge of the fade crisp.
      sendDouble(backdrop, sel('setScale:'), 1);
      sendPointer(backdrop, sel('setFilters:'), sendPointer(classes.array, sel('arrayWithObject:'), filter));
      for (const layer of layers) if (layer !== backdrop) sendSetBool(layer, sel('setHidden:'), true);
      sendPointer(effectView, sel('setMaskImage:'), alpha);
      sendVoid(mask, sel('release'));
      sendVoid(alpha, sel('release'));
      return true;
    }
  };
}

function loadApi() {
  if (api !== null) return api;
  try {
    api = createProgressiveBlurApi(require('koffi'));
  } catch {
    api = false;
  }
  return api;
}

function applyProgressiveBlur(win, masks, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win || win.isDestroyed?.() || !masks?.alphaPng?.length || !masks?.blurPng?.length) return false;
  const bridge = options.api || loadApi();
  if (!bridge) return false;
  try {
    const handle = win.getNativeWindowHandle();
    const view = handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
    return bridge.apply(Number(view), masks) === true;
  } catch {
    return false;
  }
}

module.exports = { createProgressiveBlurApi, applyProgressiveBlur };
