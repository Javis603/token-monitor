'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createFullScreenProbe,
  macCurrentSpaceIsFullScreen,
  windowsDisplayIsFullScreen
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

test('Windows: the topmost app window on the display counts only when it exactly fills its monitor', () => {
  const monitor = { x: 0, y: 0, width: 3024, height: 1964 };
  const toDip = (rect) => ({ x: rect.x / 2, y: rect.y / 2, width: rect.width / 2, height: rect.height / 2 });
  const fullScreen = { pid: 42, className: 'Chrome_WidgetWin_1', topmost: false, window: { ...monitor }, monitor };
  const desktop = { pid: 4, className: 'Progman', topmost: false, window: { ...monitor }, monitor };
  const check = (windows, bounds = display) => windowsDisplayIsFullScreen(windows, bounds, 1, toDip);
  assert.equal(check([fullScreen, desktop]), true);
  // A maximized window overhangs the monitor by its resize border.
  assert.equal(check([{ ...fullScreen, window: { x: -8, y: -8, width: 3040, height: 1980 } }, desktop]), false);
  // The desktop fills the monitor when nothing covers it.
  assert.equal(check([desktop]), false);
  assert.equal(check([{ ...fullScreen, className: 'WorkerW' }]), false);
  // The dock's own windows never count.
  assert.equal(check([{ ...fullScreen, pid: 1 }]), false);
  // A normal window stacked above the full-screen app on the same display wins.
  const note = { ...fullScreen, pid: 43, window: { x: 100, y: 100, width: 600, height: 400 } };
  assert.equal(check([note, fullScreen]), false);
  // A small always-on-top window does not.
  assert.equal(check([{ ...note, topmost: true }, fullScreen]), true);
  assert.equal(check([fullScreen], external), false);
  assert.equal(check(null), false);
});

test('Windows: a full-screen app on one display keeps it full screen while another display has focus', () => {
  // Two displays at 100%: A (primary, dock target 1) and B to its right.
  const monitorA = { x: 0, y: 0, width: 1920, height: 1080 };
  const monitorB = { x: 1920, y: 0, width: 2560, height: 1440 };
  const r = ({ x, y, width, height }) => ({ left: x, top: y, right: x + width, bottom: y + height });
  // Z-order, top first. The user has just clicked the editor on A, so it is
  // the foreground window and sits above B's full-screen video.
  const windows = [
    { hwnd: 'editor', pid: 50, className: 'Notepad', rect: { x: 200, y: 100, width: 1000, height: 700 }, monitor: 'A' },
    { hwnd: 'video', pid: 60, className: 'Chrome_WidgetWin_1', rect: { ...monitorB }, monitor: 'B' },
    { hwnd: 'uwp', pid: 70, className: 'ApplicationFrameWindow', rect: { ...monitorA }, monitor: 'A', cloaked: true },
    { hwnd: 'overlay', pid: 80, className: 'Overlay', rect: { ...monitorA }, monitor: 'A', exStyle: 0x28 },
    { hwnd: 'desktop', pid: 4, className: 'Progman', rect: { ...monitorA }, monitor: 'A' }
  ];
  const byHandle = new Map(windows.map((window) => [window.hwnd, window]));
  const monitors = { A: monitorA, B: monitorB };
  const exported = {
    GetForegroundWindow: () => 'editor',
    GetTopWindow: (hwnd) => (hwnd === null ? windows[0].hwnd : null),
    GetWindow: (hwnd, cmd) => {
      assert.equal(cmd, 2, 'walks with GW_HWNDNEXT');
      const index = windows.findIndex((window) => window.hwnd === hwnd);
      return windows[index + 1]?.hwnd ?? null;
    },
    IsWindowVisible: () => true,
    IsIconic: () => false,
    GetWindowLongPtrW: (hwnd, index) => (index === -20 ? byHandle.get(hwnd).exStyle ?? 0 : 0),
    DwmGetWindowAttribute: (hwnd, attribute, out) => {
      out[0] = attribute === 14 && byHandle.get(hwnd).cloaked ? 1 : 0;
      return 0;
    },
    GetWindowThreadProcessId: (hwnd, pid) => { pid[0] = byHandle.get(hwnd).pid; return 1; },
    GetClassNameW: (hwnd, buffer) => buffer.write(byHandle.get(hwnd).className, 'utf16le') / 2,
    GetWindowRect: (hwnd, out) => { Object.assign(out, r(byHandle.get(hwnd).rect)); return true; },
    MonitorFromWindow: (hwnd) => byHandle.get(hwnd).monitor,
    GetMonitorInfoW: (monitor, info) => { info.rcMonitor = r(monitors[monitor]); return true; }
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
    },
    struct: (name) => name,
    sizeof: () => 40
  };
  const probe = createFullScreenProbe({ platform: 'win32', pid: 1, koffi: fakeKoffi });
  assert.equal(probe({ id: 2, bounds: monitorB }), true, 'B stays full screen after focus moves to A');
  assert.equal(probe({ id: 1, bounds: monitorA }), false, 'A only has a normal window, a cloaked frame and an overlay');
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
