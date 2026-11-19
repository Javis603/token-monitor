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
  assert.deepEqual(reconciler.state(), {
    activeKey: 'a',
    desiredKey: null,
    pendingKey: null,
    retryAttempt: 0,
    exhausted: false,
    scheduled: false
  });
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

test('a failed apply keeps the desired key and retries until it converges', () => {
  const clock = fakeTimers();
  const applied = [];
  const seen = [];
  const reconciler = createLatestWinsReconciler({
    delayMs: 750,
    retryDelaysMs: [1000, 3000],
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    apply: (key) => {
      applied.push(key);
      if (applied.length === 1) throw new Error('temporary startup failure');
      return true;
    },
    onError: (error) => seen.push(error.message)
  });
  reconciler.setActiveKey('a');
  reconciler.schedule('b');

  clock.timers[0].fn();
  assert.deepEqual(seen, ['temporary startup failure']);
  assert.deepEqual(reconciler.state(), {
    activeKey: 'a',
    desiredKey: 'b',
    pendingKey: 'b',
    retryAttempt: 1,
    exhausted: false,
    scheduled: true
  });
  assert.equal(clock.timers[1].ms, 1000);

  clock.timers[1].fn();
  assert.deepEqual(applied, ['b', 'b']);
  assert.deepEqual(reconciler.state(), {
    activeKey: 'b',
    desiredKey: null,
    pendingKey: null,
    retryAttempt: 0,
    exhausted: false,
    scheduled: false
  });
});

test('a newer desired key cancels an older retry and owns the settle window', () => {
  const clock = fakeTimers();
  const applied = [];
  const reconciler = createLatestWinsReconciler({
    delayMs: 750,
    retryDelaysMs: [1000],
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    apply: (key) => {
      applied.push(key);
      if (key === 'b') throw new Error('temporary startup failure');
      return true;
    }
  });
  reconciler.setActiveKey('a');
  reconciler.schedule('b');
  clock.timers[0].fn();

  reconciler.schedule('c');
  assert.equal(clock.timers[1].cleared, true, 'the retry for b is cancelled');
  assert.equal(clock.timers[2].ms, 750);
  clock.timers[2].fn();

  assert.deepEqual(applied, ['b', 'c']);
  assert.equal(reconciler.state().activeKey, 'c');
  assert.equal(reconciler.state().desiredKey, null);
});

test('retries are bounded while the unconverged desired key remains observable', () => {
  const clock = fakeTimers();
  let attempts = 0;
  const exhaustedEvents = [];
  const reconciler = createLatestWinsReconciler({
    delayMs: 1,
    retryDelaysMs: [10, 20],
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    apply: () => { attempts += 1; return false; },
    onExhausted: (event) => exhaustedEvents.push(event)
  });
  reconciler.setActiveKey('a');
  reconciler.schedule('b');

  clock.timers[0].fn();
  clock.timers[1].fn();
  clock.timers[2].fn();

  assert.equal(attempts, 3);
  assert.deepEqual(exhaustedEvents, [{ key: 'b', attempts: 3, error: null }]);
  assert.deepEqual(reconciler.state(), {
    activeKey: 'a',
    desiredKey: 'b',
    pendingKey: null,
    retryAttempt: 2,
    exhausted: true,
    scheduled: false
  });

  reconciler.schedule('c');
  assert.equal(reconciler.state().exhausted, false, 'a newer desired key owns a fresh retry budget');
});
