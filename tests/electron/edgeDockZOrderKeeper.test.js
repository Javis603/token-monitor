'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createEdgeDockZOrderKeeper,
  isImeClass,
  nativeHandleOf
} = require('../../src/electron/edgeDock/zOrderKeeper');

function fakeWindow(handle, overrides = {}) {
  const calls = { moveTop: 0 };
  const win = {
    calls,
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isAlwaysOnTop: () => true,
    getNativeWindowHandle: () => {
      const buffer = Buffer.alloc(8);
      buffer.writeBigUInt64LE(BigInt(handle));
      return buffer;
    },
    moveTop: () => { calls.moveTop += 1; }
  };
  return Object.assign(win, overrides);
}

// Top of the stack first, exactly like the real walk: the keeper's rule reads
// "what is standing above the dock", so a list in any other order would not
// exercise the same branch.
function stack(...entries) {
  return entries;
}

function entry(handle, flags = {}) {
  return { handle, visible: true, topmost: true, ime: false, ...flags };
}

function makeKeeper(options = {}) {
  const state = { ticks: 0, probes: 0, intervals: 0, cleared: 0, foregroundHandlers: [] };
  const keeper = createEdgeDockZOrderKeeper({
    platform: 'win32',
    setInterval: () => { state.intervals += 1; return 1; },
    clearInterval: () => { state.cleared += 1; },
    // The keeper reads this key by that name; getting it wrong here would leave
    // isHooked() false forever and quietly drop two of these assertions.
    subscribeForeground: options.hook
      ? (handler) => { state.foregroundHandlers.push(handler); return () => { state.foregroundHandlers = []; }; }
      : undefined,
    ...options
  });
  return { keeper, state };
}

test('a topmost window standing above the dock is re-raised over it', async () => {
  const dock = fakeWindow(100);
  let stackNow = stack(entry(50), entry(100));
  const { keeper } = makeKeeper({ probe: async () => stackNow });

  keeper.sync([dock]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dock.calls.moveTop, 1,
    'the whole point: an overtake has to be undone, not merely noticed');

  // And it stops re-asserting once nothing is in the way.
  stackNow = stack(entry(100), entry(50));
  keeper.sync([dock]);
  keeper.sync([dock]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dock.calls.moveTop, 1,
    'a dock already at the top of the band must be left alone');
});

test('an IME window above the dock yields the round instead of covering it', async () => {
  const dock = fakeWindow(100);
  const { keeper } = makeKeeper({
    probe: async () => stack(entry(50, { ime: true }), entry(100))
  });

  keeper.sync([dock]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dock.calls.moveTop, 0,
    'raising the dock over a candidate window would hide the text being typed');
});

test('an ordinary window above the dock needs no raise, because topmost already wins', async () => {
  const dock = fakeWindow(100);
  const { keeper } = makeKeeper({
    probe: async () => stack(entry(50, { topmost: false }), entry(100))
  });

  keeper.sync([dock]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dock.calls.moveTop, 0,
    'a non-topmost window cannot cover a topmost one; moving would be churn');
});

test('an IME window sitting below the dock does not veto the raise', async () => {
  const dock = fakeWindow(100);
  // Topmost tray window above the dock (the overtake), then the dock, then an
  // IME window that is behind both. The veto is about what covers the dock, so
  // an IME window lower in the stack must not disarm the fix.
  const { keeper } = makeKeeper({
    probe: async () => stack(entry(50), entry(100), entry(20, { ime: true }))
  });

  keeper.sync([dock]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dock.calls.moveTop, 1);
});

test('a hidden, destroyed or non-topmost dock is not watched at all', async () => {
  const cases = {
    hidden: fakeWindow(100, { isVisible: () => false }),
    destroyed: fakeWindow(100, { isDestroyed: () => true }),
    minimized: fakeWindow(100, { isMinimized: () => true }),
    notTopmost: fakeWindow(100, { isAlwaysOnTop: () => false })
  };
  for (const [name, win] of Object.entries(cases)) {
    const { keeper, state } = makeKeeper({ probe: async () => stack(entry(50), entry(100)) });
    assert.equal(keeper.sync([win]), false, `${name} dock must not be claimed`);
    assert.equal(state.intervals, 0, `${name} dock must not start a timer`);
    assert.equal(win.calls.moveTop, 0, `${name} dock must never be raised`);
  }
});

test('re-syncing the same window set does not re-probe', async () => {
  const dock = fakeWindow(100);
  let probes = 0;
  const { keeper } = makeKeeper({
    probe: async () => { probes += 1; return stack(entry(100), entry(50)); }
  });

  keeper.sync([dock]);
  await new Promise((resolve) => setImmediate(resolve));
  const after = probes;
  keeper.sync([dock]);
  keeper.sync([dock]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, after,
    'setVisible calls sync on every reveal; an unchanged set must not cost a stack walk');
});

test('a different window set is a change worth one immediate check', async () => {
  const first = fakeWindow(100);
  const second = fakeWindow(200);
  const { keeper } = makeKeeper({
    probe: async () => stack(entry(50), entry(100), entry(200))
  });

  keeper.sync([first]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.calls.moveTop, 1);

  keeper.sync([first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.calls.moveTop, 1,
    'a rebuilt dock has fresh HWNDs and must not wait out an interval');
});

test('stop releases the timer and the system-wide hook', async () => {
  const dock = fakeWindow(100);
  const { keeper, state } = makeKeeper({
    hook: true,
    probe: async () => stack(entry(100))
  });

  keeper.sync([dock]);
  assert.equal(keeper.isRunning(), true);
  assert.equal(keeper.isHooked(), true);
  assert.equal(state.foregroundHandlers.length, 1, 'the hook is what makes an overtake an event');

  keeper.stop();
  assert.equal(keeper.isRunning(), false);
  assert.equal(keeper.isHooked(), false);
  assert.equal(state.cleared, 1);
  assert.equal(state.foregroundHandlers.length, 0, 'the hook must not outlive the dock');
});

test('a foreground change re-checks without waiting for the interval', async () => {
  const dock = fakeWindow(100);
  let stackNow = stack(entry(100), entry(50));
  const { keeper, state } = makeKeeper({
    hook: true,
    probe: async () => stackNow
  });

  keeper.sync([dock]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dock.calls.moveTop, 0, 'nothing above the dock to begin with');

  stackNow = stack(entry(50), entry(100));
  state.foregroundHandlers[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dock.calls.moveTop, 1,
    'the app that overtook the dock just took the foreground, so this is the cheapest moment to notice');
});

test('nothing runs off Windows', async () => {
  const dock = fakeWindow(100);
  let probes = 0;
  const { keeper, state } = makeKeeper({
    platform: 'darwin',
    probe: async () => { probes += 1; return stack(entry(50), entry(100)); }
  });

  keeper.sync([dock]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 0);
  assert.equal(state.intervals, 0);
});

test('a probe that fails or answers nothing leaves the dock alone', async () => {
  for (const probe of [async () => { throw new Error('user32 missing'); }, async () => null, async () => []]) {
    const dock = fakeWindow(100);
    const { keeper } = makeKeeper({ probe });
    keeper.sync([dock]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dock.calls.moveTop, 0,
      'an unreadable stack is not evidence of an overtake');
  }
});

test('a dock missing from the stack is raised, because the stack cannot vouch for it', async () => {
  const dock = fakeWindow(999);
  const { keeper } = makeKeeper({ probe: async () => stack(entry(50)) });

  keeper.sync([dock]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dock.calls.moveTop, 1);
});

test('nativeHandleOf normalises Electron\'s handle buffer to the number koffi returns', () => {
  const wide = Buffer.alloc(8);
  wide.writeBigUInt64LE(1234n);
  assert.equal(nativeHandleOf({ getNativeWindowHandle: () => wide }), 1234,
    'a BigInt here would never equal the plain number the stack walk produces');

  const narrow = Buffer.alloc(4);
  narrow.writeUInt32LE(5678, 0);
  assert.equal(nativeHandleOf({ getNativeWindowHandle: () => narrow }), 5678);

  assert.equal(nativeHandleOf({ getNativeWindowHandle: () => Buffer.alloc(0) }), null);
  assert.equal(nativeHandleOf({}), null);
  assert.equal(nativeHandleOf(null), null);
});

test('isImeClass covers the class names Windows actually uses for candidate windows', () => {
  for (const name of ['IME', 'Default IME', 'MSCTFIME UI', 'TOOLITIPS2']) {
    assert.equal(isImeClass(name), true, `${name} is an input window`);
  }
  for (const name of ['Chrome_WidgetWin_1', 'Shell_TrayWnd', 'wetype.statusbar.window', '']) {
    assert.equal(isImeClass(name), false, `${name} is not`);
  }
  assert.equal(isImeClass(undefined), false);
});
