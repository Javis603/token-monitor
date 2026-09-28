'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createFullScreenProbe,
  macWindowsCoverDisplay,
  windowsForegroundCoversDisplay
} = require('../../src/electron/edgeDock/fullScreenProbe');

const display = { x: 0, y: 0, width: 1512, height: 982 };
const external = { x: 1512, y: -200, width: 2560, height: 1440 };

test('macOS: a normal-level window of another app covering the display is full screen', () => {
  const fullScreen = { layer: 0, pid: 42, alpha: 1, bounds: { ...display } };
  assert.equal(macWindowsCoverDisplay([fullScreen], display, 1), true);
  assert.equal(macWindowsCoverDisplay([{ ...fullScreen, bounds: { ...external } }], external, 1), true);
  // Only the display the dock is on counts.
  assert.equal(macWindowsCoverDisplay([fullScreen], external, 1), false);
});

test('macOS: zoomed windows, overlays, invisible windows and our own windows are not', () => {
  const zoomed = { layer: 0, pid: 42, alpha: 1, bounds: { x: 0, y: 33, width: 1512, height: 949 } };
  const menuBar = { layer: 24, pid: 7, alpha: 1, bounds: { ...display } };
  const transparent = { layer: 0, pid: 42, alpha: 0, bounds: { ...display } };
  const own = { layer: 0, pid: 1, alpha: 1, bounds: { ...display } };
  assert.equal(macWindowsCoverDisplay([zoomed, menuBar, transparent, own], display, 1), false);
  assert.equal(macWindowsCoverDisplay([], display, 1), false);
});

test('Windows: the foreground window counts only when it exactly fills its monitor', () => {
  const monitor = { x: 0, y: 0, width: 3024, height: 1964 };
  const toDip = (rect) => ({ x: rect.x / 2, y: rect.y / 2, width: rect.width / 2, height: rect.height / 2 });
  const foreground = { pid: 42, className: 'Chrome_WidgetWin_1', window: { ...monitor }, monitor };
  assert.equal(windowsForegroundCoversDisplay(foreground, display, 1, toDip), true);
  // A maximized window overhangs the monitor by its resize border.
  const maximized = { ...foreground, window: { x: -8, y: -8, width: 3040, height: 1980 } };
  assert.equal(windowsForegroundCoversDisplay(maximized, display, 1, toDip), false);
  // The desktop fills the monitor when it has focus.
  assert.equal(windowsForegroundCoversDisplay({ ...foreground, className: 'WorkerW' }, display, 1, toDip), false);
  assert.equal(windowsForegroundCoversDisplay({ ...foreground, pid: 1 }, display, 1, toDip), false);
  assert.equal(windowsForegroundCoversDisplay(foreground, external, 1, toDip), false);
  assert.equal(windowsForegroundCoversDisplay(null, display, 1, toDip), false);
});

test('the probe reports not full screen when native access is unavailable', () => {
  const logs = [];
  const probe = createFullScreenProbe({
    platform: 'darwin',
    koffi: { load() { throw new Error('no koffi'); } },
    logger: (message) => logs.push(message)
  });
  assert.equal(probe(display), false);
  assert.equal(probe(display), false);
  assert.equal(logs.length, 1, 'loading is attempted once');
  assert.equal(createFullScreenProbe({ platform: 'linux' })(display), false);
});

test('macOS reader turns the CGWindowList into window entries and releases it', () => {
  const released = [];
  // CFDictionaryGetValue hands back CFNumber pointers, never bare numbers.
  const n = (value) => ({ value });
  const entries = [
    { kCGWindowLayer: n(0), kCGWindowOwnerPID: n(42), kCGWindowBounds: { X: n(0), Y: n(0), Width: n(1512), Height: n(982) } }
  ];
  const fakeKoffi = {
    load() {
      return {
        func(signature) {
          const name = signature.match(/(\w+)\(/)[1];
          return {
            CFStringCreateWithCString: (_alloc, value) => value,
            CFArrayGetCount: (list) => list.length,
            CFArrayGetValueAtIndex: (list, index) => list[index],
            CFDictionaryGetValue: (dict, key) => dict[key] ?? null,
            CFNumberGetValue: (number, _type, out) => { out[0] = number.value; return true; },
            CFRelease: (ref) => released.push(ref),
            CGWindowListCopyWindowInfo: () => entries
          }[name];
        }
      };
    }
  };
  const probe = createFullScreenProbe({ platform: 'darwin', koffi: fakeKoffi, pid: 1 });
  assert.equal(probe(display), true);
  assert.equal(probe(external), false);
  assert.deepEqual(released, [entries, entries]);
});
