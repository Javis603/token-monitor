'use strict';

// Reads whether the primary mouse button is held, system-wide. The edge dock
// moves its own window under the pointer while dragging, and the renderer can
// lose the pointer capture (and with it the pointerup) when that happens, so
// the drag's end is taken from the OS button state instead of a DOM event.
// Lazy and best-effort: null means "unknown", and callers keep their own
// fallback.

let reader = null;

function createMacReader(koffi) {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const sel = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const getClass = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const send = objc.func('objc_msgSend', 'uint64_t', ['uintptr_t', 'uintptr_t']);
  const eventClass = getClass('NSEvent');
  const pressedMouseButtons = sel('pressedMouseButtons');
  return () => (BigInt(send(eventClass, pressedMouseButtons)) & 1n) === 1n;
}

function createWindowsReader(koffi) {
  const user32 = koffi.load('user32.dll');
  const getAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
  const VK_LBUTTON = 0x01;
  return () => (getAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
}

function loadReader(platform) {
  if (reader !== null) return reader;
  try {
    const koffi = require('koffi');
    if (platform === 'darwin') reader = createMacReader(koffi);
    else if (platform === 'win32') reader = createWindowsReader(koffi);
    else reader = false;
  } catch {
    reader = false;
  }
  return reader;
}

function primaryButtonDown(platform = process.platform) {
  const read = loadReader(platform);
  if (!read) return null;
  try {
    return read();
  } catch {
    return null;
  }
}

module.exports = { primaryButtonDown };
