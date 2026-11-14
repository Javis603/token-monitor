'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createIdleHeapCollector, MIN_HEAP_TOTAL_BYTES } = require('../../src/electron/idleHeap');

const MiB = 1024 * 1024;

function collectorFor(initial, options = {}) {
  let heap = initial;
  let collections = 0;
  const collector = createIdleHeapCollector({
    isIdle: () => true,
    getHeap: () => heap,
    collect: async () => {
      collections += 1;
      heap = options.afterCollect ? options.afterCollect(heap) : { heapTotal: 48 * MiB, heapUsed: 40 * MiB };
    },
    ...options.overrides
  });
  return { collector, collections: () => collections, setHeap: (next) => { heap = next; } };
}

test('an idle collector leaves a small committed heap alone', async () => {
  const harness = collectorFor({ heapTotal: MIN_HEAP_TOTAL_BYTES - 1, heapUsed: 20 * MiB });
  assert.equal(await harness.collector.run(), false);
  assert.equal(harness.collections(), 0);
});

test('a large committed heap is collected and raises the next threshold', async () => {
  const harness = collectorFor({ heapTotal: 120 * MiB, heapUsed: 56 * MiB });
  assert.equal(await harness.collector.run(), true);
  assert.equal(harness.collections(), 1);

  // The retained set after collection sets a 72 MiB threshold (40 + 32).
  harness.setHeap({ heapTotal: 70 * MiB, heapUsed: 60 * MiB });
  assert.equal(await harness.collector.run(), false, 'a heap near the retained set is not collected again');
  harness.setHeap({ heapTotal: 80 * MiB, heapUsed: 70 * MiB });
  assert.equal(await harness.collector.run(), true, 'growth past the retained headroom is collected');
});

test('a focused window defers collection', async () => {
  const harness = collectorFor({ heapTotal: 120 * MiB, heapUsed: 56 * MiB }, {
    overrides: { isIdle: () => false }
  });
  assert.equal(await harness.collector.run(), false);
  assert.equal(harness.collections(), 0);
});

test('renderers are collected on an idle pass even when main has little committed', async () => {
  let rendererRuns = 0;
  const collector = createIdleHeapCollector({
    isIdle: () => true,
    getHeap: () => ({ heapTotal: 1, heapUsed: 1 }),
    collect: async () => { throw new Error('main must stay untouched'); },
    collectRenderers: async () => { rendererRuns += 1; }
  });
  assert.equal(await collector.run(), false);
  assert.equal(rendererRuns, 1);
});

test('renderers wait for the same idle gate as main', async () => {
  let rendererRuns = 0;
  const collector = createIdleHeapCollector({
    isIdle: () => false,
    getHeap: () => ({ heapTotal: 0, heapUsed: 0 }),
    collectRenderers: async () => { rendererRuns += 1; }
  });
  assert.equal(await collector.run(), false);
  assert.equal(rendererRuns, 0);
});

test('a renderer failure does not block the next pass', async () => {
  let attempts = 0;
  const collector = createIdleHeapCollector({
    isIdle: () => true,
    getHeap: () => ({ heapTotal: 0, heapUsed: 0 }),
    collectRenderers: async () => { attempts += 1; throw new Error('renderer gone'); }
  });
  assert.equal(await collector.run(), false);
  assert.equal(await collector.run(), false);
  assert.equal(attempts, 2);
});

test('a failed collection is retried on the next pass', async () => {
  let fail = true;
  const harness = collectorFor({ heapTotal: 120 * MiB, heapUsed: 56 * MiB }, {
    overrides: {
      collect: async () => {
        if (fail) throw new Error('inspector unavailable');
      }
    }
  });
  assert.equal(await harness.collector.run(), false);
  fail = false;
  assert.equal(await harness.collector.run(), true);
});

test('start installs an early check and the steady interval, and stop clears both', async () => {
  const intervalTimer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const initialTimer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  let installedInterval = null;
  let installedInitial = null;
  let clearedInterval = null;
  let rendererRuns = 0;
  const collector = createIdleHeapCollector({
    isIdle: () => true,
    getHeap: () => ({ heapTotal: 0, heapUsed: 0 }),
    collectRenderers: async () => { rendererRuns += 1; },
    setInterval: (fn, ms) => { installedInterval = { fn, ms }; return intervalTimer; },
    clearInterval: (value) => { clearedInterval = value; },
    setTimeout: (fn, ms) => { installedInitial = { fn, ms }; return initialTimer; },
    clearTimeout: () => {}
  });
  collector.start();
  collector.start();
  assert.equal(installedInitial.ms, 60 * 1000);
  assert.equal(installedInterval.ms, 5 * 60 * 1000);
  assert.equal(initialTimer.unrefCalled, true);
  assert.equal(intervalTimer.unrefCalled, true);
  installedInitial.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rendererRuns, 1, 'the first check does not wait for the interval');
  collector.stop();
  assert.equal(clearedInterval, intervalTimer);
  assert.equal(await collector.run(), false, 'a stopped collector does not run');
  assert.equal(rendererRuns, 1);

  const pendingInitial = { unref() {} };
  let clearedPendingInitial = null;
  const beforeFire = createIdleHeapCollector({
    isIdle: () => true,
    getHeap: () => ({ heapTotal: 0, heapUsed: 0 }),
    setTimeout: () => pendingInitial,
    clearTimeout: (value) => { clearedPendingInitial = value; },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {}
  });
  beforeFire.start();
  beforeFire.stop();
  assert.equal(clearedPendingInitial, pendingInitial, 'stop clears a still-pending first check');
});
