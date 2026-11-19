'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createMacScrollGestureMonitor, monitorMacScrollGesture } = require('../../src/electron/notch/macScrollGesture');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function fixture(enabled = true) {
  const callbacks = new Map(), memory = new Map(), events = new Map(), tracks = [];
  let seq = 100, monitor, eventMask = 0n;
  const koffi = {
    callbacks, tracks,
    struct: fields => fields, sizeof: type => Object.keys(type).length === 5 ? 32 : 16,
    proto: (result, args) => ({ result, args }), pointer: type => type,
    encode: (ptr, _type, value) => memory.set(ptr, value),
    register: fn => { const id = ++seq; callbacks.set(id, fn); return id; },
    unregister: id => assert.ok(callbacks.delete(id), 'callback released once'),
    load: () => ({ symbol: () => 42n, func(name) {
      if (name === 'sel_registerName') return name => name;
      if (name === 'objc_getClass') return () => 101n;
      if (name === 'CGEventGetLocation') return () => ({ x: 400, y: 50 });
      return (target, method, ...args) => {
        const e = events.get(target) || {};
        if (method === 'instancesRespondToSelector:') return true;
        if (method === 'isSwipeTrackingFromScrollEventsEnabled') return enabled;
        if (method === 'window') return e.window ?? 900n;
        if (method === 'CGEvent') return target;
        if (method === 'addLocalMonitorForEventsMatchingMask:handler:') { eventMask = args[0]; monitor = memory.get(args[1]).invoke; return 500n; }
        if (method === 'removeMonitor:') { monitor = null; return; }
        if (method === 'trackSwipeEventWithOptions:dampenAmountThresholdMin:max:usingHandler:') {
          tracks.push(memory.get(args[3]).invoke); return;
        }
        if (['phase', 'momentumPhase', 'scrollingDeltaX', 'scrollingDeltaY', 'modifierFlags',
          'hasPreciseScrollingDeltas', 'isDirectionInvertedFromDevice'].includes(method)) return e[method] ?? 0;
        throw new Error(`Unexpected AppKit selector: ${method}`);
      };
    } })
  };
  const api = createMacScrollGestureMonitor(koffi), seen = [];
  let allowed = true;
  const binding = api.subscribe(value => seen.push(value), { view: 123n, shouldTrack: () => allowed });
  const wheel = (extra = {}) => {
    const event = BigInt(++seq);
    events.set(event, { phase: 1, scrollingDeltaX: 10, hasPreciseScrollingDeltas: true, isDirectionInvertedFromDevice: true, ...extra });
    if (monitor == null || !(eventMask & (1n << 22n))) return event;
    return callbacks.get(monitor)(0n, event);
  };
  const frame = (track, amount, phase, complete = false) => {
    const stop = {};
    callbacks.get(tracks[track])(0n, amount, phase, complete, stop);
    return memory.get(stop) === true;
  };
  return { koffi, api, seen, binding, wheel, frame, get monitoring() { return monitor != null; }, allow: value => { allowed = value; }, enable: value => { enabled = value; } };
}

test('only precise horizontal events in this window enter native tracking', async () => {
  const f = fixture();
  for (const extra of [{ window: 800n }, { scrollingDeltaY: 20 }, { modifierFlags: 1 << 18 }, { momentumPhase: 1 }, { phase: 0 }, { hasPreciseScrollingDeltas: false }]) {
    assert.notEqual(f.wheel(extra), 0n);
  }
  f.allow(false);
  assert.notEqual(f.wheel(), 0n);
  assert.equal(f.koffi.tracks.length, 0);
  f.binding.dispose();
  assert.equal(f.monitoring, false);
  assert.notEqual(f.wheel(), 0n);
  await nextTurn();
  assert.equal(f.koffi.callbacks.size, 0);
});

test('system swipe changes take effect without rebuilding the subscription', async () => {
  const f = fixture(false);
  assert.ok(f.binding, 'a disabled preference must still allow later changes');
  assert.notEqual(f.wheel(), 0n);
  assert.equal(f.koffi.tracks.length, 0);
  f.enable(true);
  assert.equal(f.wheel(), 0n);
  f.frame(0, 0, 1); f.frame(0, 0.3, 8); f.frame(0, 1, 0, true);
  f.enable(false);
  assert.notEqual(f.wheel(), 0n);
  assert.equal(f.koffi.tracks.length, 1);
  f.binding.dispose(); await nextTurn();
  assert.equal(f.koffi.callbacks.size, 0);
});

test('native completion without momentum releases the tracker after returning', async () => {
  const f = fixture();
  assert.equal(f.wheel(), 0n);
  f.frame(0, 0, 1); f.frame(0, 0.2, 4); f.frame(0, 0.2, 8); f.frame(0, 1, 0, true);
  assert.deepEqual(f.seen.map(e => [e.phase, e.complete]), [['began', false], ['changed', false], ['ended', false], ['none', true]]);
  assert.equal(f.koffi.callbacks.size, 2, 'native callback is still returning');
  await nextTurn(); assert.equal(f.koffi.callbacks.size, 1);
  f.binding.dispose(); await nextTurn(); assert.equal(f.koffi.callbacks.size, 0);
});

test('a new finger gesture interrupts animation, while one held gesture never restarts', async () => {
  const f = fixture();
  f.wheel(); f.frame(0, 0.1, 1);
  f.wheel({ phase: 4 }); assert.equal(f.koffi.tracks.length, 1);
  f.frame(0, 0.3, 8);
  f.wheel(); assert.equal(f.koffi.tracks.length, 2);
  const before = f.seen.length;
  assert.equal(f.frame(0, 0.4, 0), true);
  assert.equal(f.seen.length, before, 'superseded animation cannot paint over new input');
  f.frame(1, 0, 1); f.frame(1, 0, 16); f.frame(1, 0, 0, true);
  await nextTurn(); assert.equal(f.koffi.callbacks.size, 1);
  f.binding.dispose(); await nextTurn(); assert.equal(f.koffi.callbacks.size, 0);
});

test('disposal stops active tracking, and unsupported platforms stay inert', async () => {
  const f = fixture();
  f.wheel(); f.frame(0, 0.2, 1);
  f.binding.dispose();
  assert.equal(f.frame(0, 0.3, 4), true);
  await nextTurn(); assert.equal(f.koffi.callbacks.size, 0);
  assert.equal(monitorMacScrollGesture(() => {}, { platform: 'win32' }), null);
  assert.equal(monitorMacScrollGesture(() => {}, { platform: 'linux' }), null);
});


test('turning gestures off cancels the preview instead of leaving it halfway', async () => {
  const f = fixture();
  f.wheel(); f.frame(0, 0.4, 1);
  f.allow(false);
  assert.equal(f.frame(0, 0.5, 4), true);
  assert.deepEqual(f.seen.at(-1), { id: 1, amount: 0, phase: 'cancelled', complete: true, x: 400, y: 50 });
  await nextTurn();
  f.binding.dispose(); await nextTurn();
  assert.equal(f.koffi.callbacks.size, 0);
});


test('a rightward hand moves Home to Limits under either scroll preference', async () => {
  const { swipeDestination } = require('../../src/electron/renderer/notch/scrollGesture');
  for (const natural of [true, false]) {
    const f = fixture();
    f.wheel({ isDirectionInvertedFromDevice: natural });
    // Rightward AppKit progress is negative under natural scrolling.
    const amount = natural ? -0.2 : 0.2;
    f.frame(0, amount, 1); f.frame(0, amount, 8);
    assert.equal(f.seen.at(-1).amount, 0.2);
    const result = swipeDestination(0, 4, null, f.seen.at(-1).amount);
    assert.equal(result.target, 1);
    f.frame(0, natural ? -1 : 1, 0, true);
    f.binding.dispose(); await nextTurn();
    assert.equal(f.koffi.callbacks.size, 0);
  }
});
