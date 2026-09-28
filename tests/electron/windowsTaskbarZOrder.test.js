'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const path = require('node:path');

const {
  createTaskbarZOrderKeeper,
  overlapsReservedArea,
  taskbarZOrderEnabled
} = require('../../src/electron/windowsTaskbarZOrder');

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
}

const DISPLAY = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 } // 48px taskbar at the bottom
};

function fakeWindow(overrides = {}) {
  return {
    bounds: { x: 100, y: 1040, width: 320, height: 40 },
    moveTopCalls: 0,
    destroyed: false,
    visible: true,
    minimized: false,
    onTop: true,
    ...overrides,
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    isAlwaysOnTop() { return this.onTop; },
    getBounds() { return this.bounds; },
    moveTop() { this.moveTopCalls += 1; }
  };
}

function fakeTimers() {
  const state = { tick: null, cleared: 0, id: 0, timeouts: new Map(), intervalMs: null };
  return {
    state,
    setInterval(fn, delay) { state.tick = fn; state.intervalMs = delay; state.id += 1; return state.id; },
    clearInterval() { state.cleared += 1; state.tick = null; },
    setTimeout(fn, delay) { state.id += 1; state.timeouts.set(state.id, { fn, delay }); return state.id; },
    clearTimeout(handle) { state.timeouts.delete(handle); },
    runTimeouts() {
      for (const [handle, entry] of [...state.timeouts]) {
        state.timeouts.delete(handle);
        entry.fn();
      }
    }
  };
}

function fakeForegroundHook() {
  const state = { handler: null, subscribed: 0, released: 0 };
  return {
    state,
    subscribe(handler) {
      state.handler = handler;
      state.subscribed += 1;
      return () => { state.released += 1; state.handler = null; };
    }
  };
}

function keeperFor(window, overrides = {}) {
  const timers = fakeTimers();
  const keeper = createTaskbarZOrderKeeper({
    platform: 'win32',
    screen: { getDisplayMatching: () => DISPLAY },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...overrides
  });
  return { keeper, timers };
}

test('a window inside the work area is never covered by the taskbar', () => {
  assert.equal(overlapsReservedArea({ x: 100, y: 100, width: 320, height: 200 }, DISPLAY), false);
  assert.equal(overlapsReservedArea({ x: 0, y: 832, width: 320, height: 200 }, DISPLAY), false);
});

test('a window hanging into the reserved strip overlaps it on any edge', () => {
  assert.equal(overlapsReservedArea({ x: 100, y: 1040, width: 320, height: 40 }, DISPLAY), true);
  assert.equal(overlapsReservedArea({ x: 100, y: 1000, width: 320, height: 60 }, DISPLAY), true);
  const leftBar = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 72, y: 0, width: 1848, height: 1080 }
  };
  assert.equal(overlapsReservedArea({ x: 0, y: 400, width: 320, height: 40 }, leftBar), true);
});

test('a window on another display does not count as overlapping', () => {
  assert.equal(overlapsReservedArea({ x: 2200, y: 1040, width: 320, height: 40 }, DISPLAY), false);
});

test('bad bounds or a missing display never start the keeper', () => {
  assert.equal(overlapsReservedArea(null, DISPLAY), false);
  assert.equal(overlapsReservedArea({ x: 0, y: 0, width: 0, height: 0 }, DISPLAY), false);
  assert.equal(overlapsReservedArea({ x: 100, y: 1040, width: 320, height: 40 }, null), false);
});

test('the keeper re-asserts z-order while the widget overlaps the taskbar', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win);

  assert.equal(keeper.sync(win), true);
  assert.equal(keeper.isRunning(), true);
  // sync() re-asserts immediately so a drag onto the taskbar does not wait a tick.
  assert.equal(win.moveTopCalls, 1);

  timers.state.tick();
  timers.state.tick();
  assert.equal(win.moveTopCalls, 3);
});

test('the keeper stays off on every platform but Windows', () => {
  for (const platform of ['darwin', 'linux']) {
    const win = fakeWindow();
    const { keeper } = keeperFor(win, { platform });
    assert.equal(keeper.sync(win), false);
    assert.equal(keeper.isRunning(), false);
    assert.equal(win.moveTopCalls, 0);
  }
});

test('the keeper stays off for a widget that does not overlap the taskbar', () => {
  const win = fakeWindow({ bounds: { x: 100, y: 100, width: 320, height: 200 } });
  const { keeper } = keeperFor(win);
  assert.equal(keeper.sync(win), false);
  assert.equal(keeper.isRunning(), false);
  assert.equal(win.moveTopCalls, 0);
});

test('the keeper stops when the widget is no longer pinned on top', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win);
  keeper.sync(win);

  win.onTop = false;
  timers.state.tick();
  assert.equal(keeper.isRunning(), false);
  assert.equal(win.moveTopCalls, 1);
});

// A tick must re-check everything, because hiding, minimizing, moving or
// destroying the window all happen on paths that know nothing about the keeper.
test('a tick stops the keeper once the widget is hidden, minimized or gone', () => {
  for (const teardown of [(w) => { w.visible = false; }, (w) => { w.minimized = true; }, (w) => { w.destroyed = true; }]) {
    const win = fakeWindow();
    const { keeper, timers } = keeperFor(win);
    keeper.sync(win);
    teardown(win);
    timers.state.tick();
    assert.equal(keeper.isRunning(), false);
    assert.equal(win.moveTopCalls, 1);
  }
});

test('a tick stops the keeper once the widget is dragged off the taskbar', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win);
  keeper.sync(win);

  win.bounds = { x: 100, y: 100, width: 320, height: 200 };
  timers.state.tick();
  assert.equal(keeper.isRunning(), false);
  assert.equal(win.moveTopCalls, 1);
});

test('stop() clears the timer and syncing again restarts it', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win);
  keeper.sync(win);
  keeper.stop();
  assert.equal(keeper.isRunning(), false);
  assert.equal(timers.state.cleared, 1);

  keeper.sync(win);
  assert.equal(keeper.isRunning(), true);
});

// Losing activation to the taskbar is what raises it back over the widget, and
// the shell does that a moment after our blur — one immediate call is overtaken.
test('nudge re-asserts immediately and again while the shell settles', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win);

  assert.equal(keeper.nudge(win), true);
  assert.equal(win.moveTopCalls, 1);
  assert.deepEqual([...timers.state.timeouts.values()].map((entry) => entry.delay), [60, 200, 400, 800]);

  timers.runTimeouts();
  assert.equal(win.moveTopCalls, 5);
});

test('nudge coalesces trailing follow-ups to the latest foreground change', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win);

  keeper.nudge(win, 'foreground');
  const firstBatch = new Set(timers.state.timeouts.keys());
  assert.equal(firstBatch.size, 4);

  keeper.nudge(win, 'foreground');
  assert.equal(win.moveTopCalls, 2);
  assert.equal(timers.state.timeouts.size, 4);
  assert.deepEqual([...timers.state.timeouts.values()].map((entry) => entry.delay), [60, 200, 400, 800]);
  for (const handle of firstBatch) assert.equal(timers.state.timeouts.has(handle), false);

  timers.runTimeouts();
  assert.equal(win.moveTopCalls, 6);
});

test('nudge keeps the safety interval running alongside the follow-ups', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win);
  keeper.nudge(win);
  assert.equal(keeper.isRunning(), true);

  timers.state.tick();
  assert.equal(win.moveTopCalls, 2);
});

test('nudge does nothing for a widget that is not over the taskbar', () => {
  const win = fakeWindow({ bounds: { x: 100, y: 100, width: 320, height: 200 } });
  const { keeper, timers } = keeperFor(win);

  assert.equal(keeper.nudge(win), false);
  assert.equal(win.moveTopCalls, 0);
  assert.equal(timers.state.timeouts.size, 0);
});

// hidePopover() runs on the same blur in tray mode, so the follow-ups have to
// survive the window disappearing underneath them.
test('a pending follow-up stops instead of touching a hidden window', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win);
  keeper.nudge(win);

  win.visible = false;
  timers.runTimeouts();
  assert.equal(win.moveTopCalls, 1);
  assert.equal(keeper.isRunning(), false);
});

test('stop() cancels pending follow-ups', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win);
  keeper.nudge(win);
  keeper.stop();

  assert.equal(timers.state.timeouts.size, 0);
  assert.equal(win.moveTopCalls, 1);
});

// Re-asserting costs a timer and can still flicker on some app switches, so it
// only runs for someone who asked for it on the platform that needs it.
test('re-asserting is opt-in and Windows-only', () => {
  assert.equal(taskbarZOrderEnabled({ windowBehavior: 'floating', keepAboveTaskbar: true }, 'win32'), true);
  assert.equal(taskbarZOrderEnabled({ windowBehavior: 'floating', keepAboveTaskbar: false }, 'win32'), false);
  assert.equal(taskbarZOrderEnabled({}, 'win32'), false);
  assert.equal(taskbarZOrderEnabled(null, 'win32'), false);
  assert.equal(taskbarZOrderEnabled({ windowBehavior: 'floating', keepAboveTaskbar: true }, 'darwin'), false);
  assert.equal(taskbarZOrderEnabled({ windowBehavior: 'floating', keepAboveTaskbar: true }, 'linux'), false);
});

test('re-asserting is disabled outside floating mode even when the opt-in persists', () => {
  assert.equal(taskbarZOrderEnabled({ windowBehavior: 'normal', keepAboveTaskbar: true }, 'win32'), false);
  assert.equal(taskbarZOrderEnabled({ windowBehavior: 'desktop', keepAboveTaskbar: true }, 'win32'), false);
  assert.equal(taskbarZOrderEnabled({ keepAboveTaskbar: true }, 'win32'), false);
});

test('the setting only takes a literal true, never a truthy leftover', () => {
  for (const value of ['true', 1, 'yes', {}]) {
    assert.equal(taskbarZOrderEnabled({ windowBehavior: 'floating', keepAboveTaskbar: value }, 'win32'), false);
  }
});

test('main.js runs the keeper through the opt-in gate, never around it', () => {
  const main = readSource('src/electron/main.js');
  assert.match(main, /function syncTaskbarZOrder\(\) \{\n {2}if \(!taskbarZOrderEnabled\(settings\)\)/);
  assert.match(main, /function nudgeTaskbarZOrder\(\) \{\n {2}if \(!taskbarZOrderEnabled\(settings\)/);
  assert.match(main, /keepAboveTaskbar: parseBoolean\(patch\.keepAboveTaskbar \?\? settings\.keepAboveTaskbar, false\)/);
  assert.match(main, /keepAboveTaskbar: false/);
});

// The option is meaningless anywhere the widget is not pinned over the taskbar,
// so the row stays hidden off Windows and outside the floating mode.
test('the settings row is gated on Windows and the floating mode', () => {
  const app = readSource('src/electron/renderer/app.js');
  assert.match(app, /state\.appInfo\?\.platform === 'win32' && mode === 'floating'/);
  assert.match(app, /els\.keepAboveTaskbarRow\?\.classList\.toggle\('hidden', !taskbarOptionApplies\)/);
  assert.match(readSource('src/electron/renderer/index.html'), /id="keepAboveTaskbarRow"[^>]*class="[^"]*hidden"/);
});

test('the opt-in is explicitly experimental and discloses the flicker limitation', () => {
  const html = readSource('src/electron/renderer/index.html');
  const i18n = readSource('src/electron/renderer/i18n.js');
  assert.match(html, />Keep above taskbar \(Experimental\)</);
  assert.match(html, /It may briefly flicker during some app switches\./);
  assert.match(i18n, /'settings\.display\.keepAboveTaskbar': 'Keep above taskbar \(Experimental\)'/);
  assert.match(i18n, /'settings\.display\.keepAboveTaskbarNote': 'Re-asserts the widget above the Windows taskbar while they overlap\. It may briefly flicker during some app switches\.'/);
});

// Polling can only cover-then-restore; the hook is what makes a taskbar raise
// reach us before it is visible, so the interval means different things.
// Measured on Windows: the hook fires on every switch, but the shell does not
// always raise the taskbar inside the window the follow-ups cover, and slowing
// the interval turns that case back into a visible flicker. So the hook shortens
// the flicker, it does not license a slower interval.
test('installing the hook does not slow the interval down', () => {
  const win = fakeWindow();
  const hook = fakeForegroundHook();
  const { keeper, timers } = keeperFor(win, { subscribeForeground: hook.subscribe });

  keeper.sync(win);
  assert.equal(keeper.isHooked(), true);
  assert.equal(hook.state.subscribed, 1);
  assert.equal(timers.state.intervalMs, 250);
});

test('without a hook the interval is the whole mechanism', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win, { subscribeForeground: () => null });

  keeper.sync(win);
  assert.equal(keeper.isHooked(), false);
  assert.equal(timers.state.intervalMs, 250);
});

test('a hook that throws on install leaves the polling fallback intact', () => {
  const win = fakeWindow();
  const { keeper, timers } = keeperFor(win, {
    subscribeForeground: () => { throw new Error('user32 unavailable'); }
  });

  assert.equal(keeper.sync(win), true);
  assert.equal(keeper.isHooked(), false);
  assert.equal(timers.state.intervalMs, 250);
});

test('a foreground change re-asserts the same way losing focus does', () => {
  const win = fakeWindow();
  const hook = fakeForegroundHook();
  const { keeper, timers } = keeperFor(win, { subscribeForeground: hook.subscribe });
  keeper.sync(win);
  assert.equal(win.moveTopCalls, 1);

  hook.state.handler();
  assert.equal(win.moveTopCalls, 2);
  timers.runTimeouts();
  assert.equal(win.moveTopCalls, 6);
});

// stop() is also how the setting being turned off arrives, so a disabled
// feature must not leave a system-wide hook installed.
test('stopping releases the hook and syncing again installs a fresh one', () => {
  const win = fakeWindow();
  const hook = fakeForegroundHook();
  const { keeper } = keeperFor(win, { subscribeForeground: hook.subscribe });

  keeper.sync(win);
  keeper.stop();
  assert.equal(hook.state.released, 1);
  assert.equal(keeper.isHooked(), false);

  keeper.sync(win);
  assert.equal(hook.state.subscribed, 2);
  assert.equal(keeper.isHooked(), true);
});

test('a foreground change after the widget moved off the taskbar stops the keeper', () => {
  const win = fakeWindow();
  const hook = fakeForegroundHook();
  const { keeper } = keeperFor(win, { subscribeForeground: hook.subscribe });
  keeper.sync(win);
  const handler = hook.state.handler;

  win.bounds = { x: 100, y: 100, width: 320, height: 200 };
  handler();
  assert.equal(keeper.isRunning(), false);
  assert.equal(hook.state.released, 1);
  assert.equal(win.moveTopCalls, 1);
});
