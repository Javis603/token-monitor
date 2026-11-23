'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { collectWithTimeout, createIdleHeapCollector, MIN_HEAP_TOTAL_BYTES } = require('../../src/electron/idleHeap');

const MiB = 1024 * 1024;

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const gateStart = main.indexOf('function appIsIdleForHeapCollection(');
const gateEnd = main.indexOf('\n}', gateStart) + 2;
const gateSource = main.slice(gateStart, gateEnd);

function appIsIdle(overrides = {}) {
  return vm.runInNewContext(`${gateSource}\nappIsIdleForHeapCollection();`, {
    quitRequested: false,
    focusedAppWindow: () => null,
    powerMonitor: { getSystemIdleTime: () => 0 },
    ...overrides
  });
}

test('the app defers heap collection when quitting', () => {
  assert.equal(appIsIdle({ quitRequested: true }), false);
});

test('the app defers heap collection while a window is focused', () => {
  assert.equal(appIsIdle({ focusedAppWindow: () => ({}) }), false);
});

test('the unfocused app allows heap collection after recent system input', () => {
  assert.equal(appIsIdle(), true);
});

test('the unfocused app allows heap collection when powerMonitor is missing', () => {
  assert.equal(appIsIdle({ powerMonitor: undefined }), true);
});

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
  let mainRuns = 0;
  const collector = createIdleHeapCollector({
    isIdle: () => true,
    getHeap: () => ({ heapTotal: 1, heapUsed: 1 }),
    collect: async () => { mainRuns += 1; throw new Error('main must stay untouched'); },
    collectRenderers: async () => { rendererRuns += 1; }
  });
  assert.equal(await collector.run(), false);
  assert.equal(mainRuns, 0, 'a small committed heap is not collected');
  assert.equal(rendererRuns, 1);
});

test('stopping during an in-flight main collection skips the renderer pass', async () => {
  let finishMain;
  let rendererRuns = 0;
  const collector = createIdleHeapCollector({
    isIdle: () => true,
    getHeap: () => ({ heapTotal: 120 * MiB, heapUsed: 56 * MiB }),
    collect: () => new Promise((resolve) => { finishMain = resolve; }),
    collectRenderers: async () => { rendererRuns += 1; }
  });
  const running = collector.run();
  collector.stop();
  finishMain();
  assert.equal(await running, true);
  assert.equal(rendererRuns, 0, 'a stopped collector does not start the renderer pass');
  assert.equal(await collector.run(), false);
  assert.equal(rendererRuns, 0);
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

test('start installs the one-shot check and recurring interval, and stop clears both', async () => {
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
  assert.equal(installedInterval.ms, 30 * 1000);
  assert.equal(initialTimer.unrefCalled, true);
  assert.equal(intervalTimer.unrefCalled, true);
  installedInitial.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rendererRuns, 1, 'the one-shot timer runs a check');
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
  assert.equal(clearedPendingInitial, pendingInitial, 'stop clears a still-pending one-shot check');
});


test('a hung inspector collection times out', async () => {
  const session = { post: () => new Promise(() => {}) };
  await assert.rejects(collectWithTimeout(session, 10), /timed out after 10ms/);
});

test('a normal inspector collection resolves', async () => {
  const session = { post: () => Promise.resolve() };
  await collectWithTimeout(session, 50);
});

test('a synchronous inspector error rejects without starting a timeout promise', async () => {
  const session = { post: () => { throw new Error('not connected'); } };
  await assert.rejects(collectWithTimeout(session, 50), /not connected/);
});

test('three consecutive main failures disable the main pass but keep renderer collection', async () => {
  let mainRuns = 0;
  let rendererRuns = 0;
  const logs = [];
  const collector = createIdleHeapCollector({
    isIdle: () => true,
    getHeap: () => ({ heapTotal: 120 * MiB, heapUsed: 56 * MiB }),
    collect: async () => { mainRuns += 1; throw new Error('inspector hung'); },
    collectRenderers: async () => { rendererRuns += 1; },
    log: (message) => logs.push(message)
  });
  for (let i = 0; i < 3; i++) assert.equal(await collector.run(), false);
  assert.equal(mainRuns, 3);
  assert.equal(rendererRuns, 3);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /disabled after 3 consecutive failures: inspector hung/);
  assert.equal(await collector.run(), false);
  assert.equal(mainRuns, 3, 'the broken main pass is not retried');
  assert.equal(rendererRuns, 4, 'renderer collection is independent');
});

test('a successful main collection resets the consecutive failure count', async () => {
  let mainRuns = 0;
  const logs = [];
  const collector = createIdleHeapCollector({
    isIdle: () => true,
    getHeap: () => ({ heapTotal: 120 * MiB, heapUsed: 56 * MiB }),
    collect: async () => { mainRuns += 1; if (mainRuns < 3) throw new Error('transient'); },
    log: (message) => logs.push(message)
  });
  assert.equal(await collector.run(), false);
  assert.equal(await collector.run(), false);
  assert.equal(await collector.run(), true);
  assert.equal(await collector.run(), true);
  assert.equal(mainRuns, 4);
  assert.equal(logs.length, 0);
});

test('a window gaining focus during main collection prevents renderer collection', async () => {
  let idle = true;
  let rendererRuns = 0;
  const collector = createIdleHeapCollector({
    isIdle: () => idle,
    getHeap: () => ({ heapTotal: 256 * 1024 * 1024, heapUsed: 32 * 1024 * 1024 }),
    collect: async () => { idle = false; },
    collectRenderers: async () => { rendererRuns += 1; }
  });
  assert.equal(await collector.run(), true);
  assert.equal(rendererRuns, 0);
});
