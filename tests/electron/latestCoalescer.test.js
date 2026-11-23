'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLatestCoalescer } = require('../../src/electron/latestCoalescer');

// A hand-driven clock keeps the coalescing windows exact without real timers.
function harness(intervalMs = 10_000) {
  let now = 0;
  const flushes = [];
  const timers = new Map();
  let nextId = 0;
  const coalescer = createLatestCoalescer({
    intervalMs,
    flush: (value) => flushes.push(value),
    now: () => now,
    setTimer: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimer: (id) => timers.delete(id)
  });
  return {
    coalescer,
    flushes,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    },
    waiting: () => timers.size
  };
}

test('the first value passes straight through and a burst collapses to its newest', () => {
  const h = harness();
  h.coalescer.enqueue('a');
  assert.deepEqual(h.flushes, ['a'], 'nothing waits for a timer on a cold coalescer');
  h.coalescer.enqueue('b');
  h.coalescer.enqueue('c');
  assert.deepEqual(h.flushes, ['a'], 'the window holds the burst');
  h.advance(9_999);
  assert.deepEqual(h.flushes, ['a']);
  h.advance(1);
  assert.deepEqual(h.flushes, ['a', 'c'], 'only the newest value of the burst is painted');
});

test('a value after the window flushes at once instead of arming another timer', () => {
  const h = harness();
  h.coalescer.enqueue('a');
  h.advance(10_000);
  h.coalescer.enqueue('b');
  assert.deepEqual(h.flushes, ['a', 'b']);
  assert.equal(h.waiting(), 0);
});

test('cancel drops the pending value and its timer', () => {
  const h = harness();
  h.coalescer.enqueue('a');
  h.coalescer.enqueue('b');
  h.coalescer.cancel();
  h.advance(30_000);
  assert.deepEqual(h.flushes, ['a']);
  assert.equal(h.waiting(), 0);
});

test('empty values never arm a timer or reach the flush', () => {
  const h = harness();
  h.coalescer.enqueue(null);
  h.coalescer.enqueue(undefined);
  assert.deepEqual(h.flushes, []);
  assert.equal(h.waiting(), 0);
});

test('flushNow paints the newest queued value without waiting for the window', () => {
  const h = harness();
  h.coalescer.enqueue('a');
  h.coalescer.enqueue('b');
  assert.deepEqual(h.flushes, ['a'], 'b waits for the window');
  h.coalescer.flushNow();
  assert.deepEqual(h.flushes, ['a', 'b']);
  assert.equal(h.waiting(), 0, 'the queued timer is gone');
  h.coalescer.enqueue('c');
  assert.deepEqual(h.flushes, ['a', 'b'], 'a new value starts a fresh window');
  h.advance(10_000);
  assert.deepEqual(h.flushes, ['a', 'b', 'c']);
});
