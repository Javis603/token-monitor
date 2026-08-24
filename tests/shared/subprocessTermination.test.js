'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createSubprocessTermination } = require('../../src/shared/subprocessTermination');

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

test('subprocess termination waits for close and escalates after the grace period', () => {
  const clock = fakeTimers();
  const signals = [];
  const child = { kill: (signal) => { signals.push(signal); return true; } };
  const termination = createSubprocessTermination(child, {
    graceMs: 250,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });

  assert.equal(termination.request(), true);
  assert.equal(termination.request(), false, 'repeated aborts must not send duplicate signals');
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(clock.timers[0].ms, 250);
  assert.equal(clock.timers[0].unrefCalled, true);

  clock.timers[0].fn();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  termination.confirmClosed();
});

test('confirmed close disarms forced termination', () => {
  const clock = fakeTimers();
  const signals = [];
  const termination = createSubprocessTermination(
    { kill: (signal) => { signals.push(signal); return true; } },
    { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }
  );

  termination.request();
  termination.confirmClosed();
  assert.equal(clock.timers[0].cleared, true);
  clock.timers[0].fn();
  assert.deepEqual(signals, ['SIGTERM']);
});
