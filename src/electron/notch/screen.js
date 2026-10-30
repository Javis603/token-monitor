'use strict';

// Public AppKit screen geometry, read in Electron's main thread. The same
// struct-return ABI as macLiquidGlass: Intel uses stret; arm64 does not.
let api, cachedScreens;
function readMacNotchScreens({ refresh = false } = {}) {
  if (process.platform !== 'darwin') return { screens: [], mainDisplayId: null };
  try {
    if (!api) {
      const koffi = require('koffi');
      const objc = koffi.load('/usr/lib/libobjc.A.dylib');
      koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
      const cls = objc.func('objc_getClass', 'uintptr_t', ['str']);
      const sel = objc.func('sel_registerName', 'uintptr_t', ['str']);
      const get = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
      const index = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uint64_t']);
      const responds = objc.func('objc_msgSend', 'bool', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
      const point = koffi.struct('TMNotchPoint', { x: 'double', y: 'double' });
      const size = koffi.struct('TMNotchSize', { width: 'double', height: 'double' });
      const rect = koffi.struct('TMNotchRect', { origin: point, size });
      const insets = koffi.struct('TMNotchInsets', { top: 'double', left: 'double', bottom: 'double', right: 'double' });
      function structReader(type) {
        if (process.arch !== 'x64') {
          const send = objc.func('objc_msgSend', type, ['uintptr_t', 'uintptr_t']);
          return (target, name) => send(target, sel(name));
        }
        const send = objc.func('objc_msgSend_stret', 'void', [koffi.out(koffi.pointer(type)), 'uintptr_t', 'uintptr_t']);
        return (target, name) => { const result = {}; send(result, target, sel(name)); return result; };
      }
      const string = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'str']);
      const object = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
      // Cached across autorelease pools; retain the lookup key for this API's lifetime.
      const key = get(string(cls('NSString'), sel('stringWithUTF8String:'), 'NSScreenNumber'), sel('retain'));
      const displayId = (s) => s ? Number(get(object(get(s, sel('deviceDescription')), sel('objectForKey:'), key), sel('unsignedIntValue'))) : null;
      api = { cls, sel, get, index, responds, displayId, rect: structReader(rect), insets: structReader(insets) };
    }
    const { cls, sel, get, index, responds, displayId, rect, insets } = api;
    // Native camera geometry is stable between display configuration changes.
    // Main-screen selection can change with focus, so only that lookup repeats.
    if (refresh || !cachedScreens) {
      const list = get(cls('NSScreen'), sel('screens'));
      const count = Number(get(list, sel('count')));
      const screens = [];
      for (let i = 0; i < count; i += 1) {
        const s = index(list, sel('objectAtIndex:'), i);
        const supported = responds(s, sel('respondsToSelector:'), sel('safeAreaInsets'))
          && responds(s, sel('respondsToSelector:'), sel('auxiliaryTopLeftArea'))
          && responds(s, sel('respondsToSelector:'), sel('auxiliaryTopRightArea'));
        screens.push({
          displayId: displayId(s), frame: rect(s, 'frame'),
          safeTop: supported ? insets(s, 'safeAreaInsets').top : 0,
          left: supported ? rect(s, 'auxiliaryTopLeftArea') : null,
          right: supported ? rect(s, 'auxiliaryTopRightArea') : null
        });
      }
      cachedScreens = screens;
    }
    return { screens: cachedScreens, mainDisplayId: displayId(get(cls('NSScreen'), sel('mainScreen'))) };
  } catch {
    // A failed probe is not a successful report of a camera-free screen.
    return { screens: [], mainDisplayId: null, failed: true };
  }
}
module.exports = { readMacNotchScreens };
