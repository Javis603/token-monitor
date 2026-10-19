'use strict';

// Window geometry only: no titles, images, AX or permission-request APIs.
function createMacMenuWindowReader(koffi) {
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const createKey = cf.func('CFStringCreateWithCString', 'void *', ['void *', 'str', 'uint32_t']);
  const release = cf.func('CFRelease', 'void', ['void *']);
  const count = cf.func('CFArrayGetCount', 'intptr_t', ['void *']);
  const at = cf.func('CFArrayGetValueAtIndex', 'void *', ['void *', 'intptr_t']);
  const value = cf.func('CFDictionaryGetValue', 'void *', ['void *', 'void *']);
  const number = cf.func('CFNumberGetValue', 'bool', ['void *', 'int', koffi.out(koffi.pointer('double'))]);
  const listWindows = cg.func('CGWindowListCopyWindowInfo', 'void *', ['uint32_t', 'uint32_t']);
  const statusLevel = cg.func('CGWindowLevelForKey', 'int32_t', ['int32_t'])(9);
  const keys = {};
  try {
    for (const name of ['kCGWindowNumber', 'kCGWindowLayer', 'kCGWindowBounds', 'X', 'Y', 'Width', 'Height']) {
      keys[name] = createKey(null, name, 0x08000100);
      if (!keys[name]) throw new Error('Cannot create window geometry key');
    }
  } catch (error) {
    for (const key of Object.values(keys)) if (key) release(key);
    throw error;
  }
  // Keys are retained for the reader lifetime, as in the existing native probes.
  const num = (dict, name) => {
    const ref = value(dict, keys[name]);
    if (!ref) return null;
    const result = [0];
    return number(ref, 13, result) && Number.isFinite(result[0]) ? result[0] : null;
  };
  return () => {
    // On-screen windows, excluding desktop elements. Copy ownership is ours.
    const list = listWindows(1 | 16, 0);
    if (!list) return null;
    try {
      const windows = [];
      for (let i = 0, length = Number(count(list)); i < length; i += 1) {
        const window = at(list, i);
        if (num(window, 'kCGWindowLayer') !== statusLevel) continue;
        const bounds = value(window, keys.kCGWindowBounds);
        if (!bounds) continue;
        const rect = { id: num(window, 'kCGWindowNumber'), x: num(bounds, 'X'), y: num(bounds, 'Y'),
          width: num(bounds, 'Width'), height: num(bounds, 'Height') };
        if (['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))) windows.push(rect);
      }
      return windows;
    } finally { release(list); }
  };
}
let reader;
function readMacMenuWindows() {
  if (process.platform !== 'darwin') return null;
  if (reader === undefined) {
    try { reader = createMacMenuWindowReader(require('koffi')); }
    catch { reader = null; }
  }
  try { return reader ? reader() : null; }
  catch { return null; }
}
module.exports = { createMacMenuWindowReader, readMacMenuWindows };
