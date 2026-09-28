'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createFullScreenProbe,
  macCurrentSpaceIsFullScreen,
  windowsForegroundCoversDisplay
} = require('../../src/electron/edgeDock/fullScreenProbe');

const display = { x: 0, y: 0, width: 1512, height: 982 };
const external = { x: 1512, y: -200, width: 2560, height: 1440 };

const BUILT_IN = '37D8832A-2D66-02CA-B9F7-8F30A301B230';
const EXTERNAL = '9A0B1C2D-3E4F-5061-7283-94A5B6C7D8E9';

test('macOS: the display counts as full screen when its current Space is a full-screen Space', () => {
  const spaces = [{ display: BUILT_IN, type: 4 }, { display: EXTERNAL, type: 0 }];
  assert.equal(macCurrentSpaceIsFullScreen(spaces, BUILT_IN), true);
  // Only the display the dock is on counts.
  assert.equal(macCurrentSpaceIsFullScreen(spaces, EXTERNAL), false);
  // A desktop Space is not full screen whatever its windows look like.
  assert.equal(macCurrentSpaceIsFullScreen([{ display: BUILT_IN, type: 0 }], BUILT_IN), false);
});

test('macOS: displays sharing Spaces report one entry, and an unknown layout is not full screen', () => {
  assert.equal(macCurrentSpaceIsFullScreen([{ display: BUILT_IN, type: 4 }], EXTERNAL), true);
  assert.equal(macCurrentSpaceIsFullScreen([{ display: BUILT_IN, type: 4 }], null), true);
  assert.equal(macCurrentSpaceIsFullScreen([{ display: BUILT_IN, type: 4 }, { display: EXTERNAL, type: 0 }], null), false);
  assert.equal(macCurrentSpaceIsFullScreen([], BUILT_IN), false);
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

test('macOS reader reads each display\'s current Space type and releases what it copies', () => {
  const released = [];
  // CFDictionaryGetValue hands back CFNumber pointers, never bare numbers.
  const n = (value) => ({ value });
  const spaces = [
    // The primary display can be listed as 'Main' next to UUID entries.
    { 'Display Identifier': 'Main', 'Current Space': { type: n(4) } },
    { 'Display Identifier': EXTERNAL, 'Current Space': { type: n(0) } }
  ];
  const uuids = { 1: `uuid:${BUILT_IN}`, 2: `uuid:${EXTERNAL}` };
  const exported = {
    // Only the CGS names exist, so the reader has to fall back from SLS.
    CGSMainConnectionID: () => 7,
    CGMainDisplayID: () => 1,
    CGSCopyManagedDisplaySpaces: (connection) => (connection === 7 ? spaces : null),
    CGDisplayCreateUUIDFromDisplayID: (id) => uuids[id] || null,
    CFUUIDCreateString: (_alloc, uuid) => uuid.slice('uuid:'.length),
    CFStringCreateWithCString: (_alloc, value) => value,
    CFStringGetCString: (value, buffer) => { buffer.write(`${value}\0`); return true; },
    CFArrayGetCount: (list) => list.length,
    CFArrayGetValueAtIndex: (list, index) => list[index],
    CFDictionaryGetValue: (dict, key) => dict[key] ?? null,
    CFNumberGetValue: (number, _type, out) => { out[0] = number.value; return true; },
    CFRelease: (ref) => released.push(ref)
  };
  const fakeKoffi = {
    load() {
      return {
        func(signature, ...rest) {
          const name = rest.length ? signature : signature.match(/(\w+)\(/)[1];
          if (!exported[name]) throw new Error(`Cannot find function '${name}'`);
          return exported[name];
        }
      };
    }
  };
  const probe = createFullScreenProbe({ platform: 'darwin', koffi: fakeKoffi });
  assert.equal(probe({ id: 1, bounds: display }), true, "'Main' is the primary display");
  // A full-screen app on the primary must not hide a dock on the other display.
  assert.equal(probe({ id: 2, bounds: external }), false);
  assert.equal(released.filter((ref) => ref === spaces).length, 2, 'every copied Space list is released');
});
