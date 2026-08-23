'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLatestWinsReconciler } = require('../../src/electron/latestWinsReconciler');

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false, unrefCalled: false, unref() { timer.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; }
  };
}

test('rapid changes apply only the latest configuration', () => {
  const clock = fakeTimers();
  const applied = [];
  const reconciler = createLatestWinsReconciler({
    delayMs: 750,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    apply: (key) => { applied.push(key); return true; }
  });
  reconciler.setActiveKey('a');

  reconciler.schedule('b');
  reconciler.schedule('c');
  reconciler.schedule('d');

  assert.equal(clock.timers.length, 3);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(clock.timers[1].cleared, true);
  assert.equal(clock.timers[2].unrefCalled, true);
  clock.timers[2].fn();
  assert.deepEqual(applied, ['d']);
  assert.equal(reconciler.state().activeKey, 'd');
});

test('thirty A-B toggles ending at the active configuration do no work', () => {
  const clock = fakeTimers();
  const applied = [];
  const reconciler = createLatestWinsReconciler({
    delayMs: 750,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    apply: (key) => applied.push(key)
  });
  reconciler.setActiveKey('a');

  for (let index = 1; index <= 30; index += 1) {
    reconciler.schedule(index % 2 === 0 ? 'a' : 'b');
  }

  assert.equal(clock.timers.length, 15);
  assert.ok(clock.timers.every((timer) => timer.cleared));
  assert.deepEqual(applied, []);
  assert.deepEqual(reconciler.state(), { activeKey: 'a', pendingKey: null, scheduled: false });
});

test('failed or cancelled reconciliation does not advance the active key', () => {
  const clock = fakeTimers();
  const reconciler = createLatestWinsReconciler({
    delayMs: 1,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    apply: () => false
  });
  reconciler.setActiveKey('a');
  reconciler.schedule('b');
  clock.timers[0].fn();
  assert.equal(reconciler.state().activeKey, 'a');

  reconciler.schedule('c');
  reconciler.cancel();
  assert.equal(clock.timers[1].cleared, true);
  assert.equal(reconciler.flush(), false);
  assert.equal(reconciler.state().activeKey, 'a');
});

test('apply errors are reported without escaping the timer callback', () => {
  const clock = fakeTimers();
  const seen = [];
  const reconciler = createLatestWinsReconciler({
    delayMs: 1,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    apply: () => { throw new Error('boom'); },
    onError: (error) => seen.push(error.message)
  });
  reconciler.setActiveKey('a');
  reconciler.schedule('b');

  assert.doesNotThrow(() => clock.timers[0].fn());
  assert.deepEqual(seen, ['boom']);
  assert.equal(reconciler.state().activeKey, 'a');
});
