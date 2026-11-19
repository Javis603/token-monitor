'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/shared/usage/usageWorker.js'), 'utf8');
const gcSource = source.slice(source.indexOf('const GC_THRESHOLD_BYTES'), source.indexOf('\nfunction transformed'));
const MB = 1024 * 1024;

function fixture() {
  let now = 100_000;
  let heap = 0;
  let after = 0;
  let failure = false;
  let calls = 0;
  let disconnected = 0;
  const jobs = [];
  class Session {
    connect() {}
    async post(method) {
      assert.equal(method, 'HeapProfiler.collectGarbage');
      calls++;
      if (failure) throw new Error('inspector unavailable');
      heap = after;
    }
    disconnect() { disconnected++; }
  }
  const collect = vm.runInNewContext(`${gcSource}\ncollectDeadHeap;`, {
    Date: { now: () => now }, process: { memoryUsage: () => ({ heapUsed: heap * MB }) },
    require(id) { assert.equal(id, 'node:inspector/promises'); return { Session }; },
    setImmediate: fn => jobs.push(fn)
  });
  return {
    async tick(before, live, advance = 10_000, fail = false) {
      now += advance; heap = before; after = live; failure = fail;
      collect();
      for (const job of jobs.splice(0)) await job();
    },
    get calls() { return calls; }, get disconnected() { return disconnected; }
  };
}

test('worker GC bounds frequency and lowers its threshold after a live-set spike subsides', async () => {
  const f = fixture();
  await f.tick(95, 40);
  assert.equal(f.calls, 0);
  await f.tick(200, 190);
  assert.equal(f.calls, 1);
  await f.tick(300, 40, 1);
  assert.equal(f.calls, 1, 'cooldown suppresses repeated collections');
  await f.tick(210, 40);
  assert.equal(f.calls, 1, 'large live set raises threshold');
  await f.tick(240, 40);
  assert.equal(f.calls, 2);
  await f.tick(100, 40);
  assert.equal(f.calls, 3, 'collection after shrink restores the 96 MiB floor');
  assert.equal(f.disconnected, 3);
});

test('an inspector error releases the session and allows a later publish to retry', async () => {
  const f = fixture();
  await f.tick(120, 40, 10_000, true);
  assert.equal(f.calls, 1);
  assert.equal(f.disconnected, 1);
  await f.tick(120, 40);
  assert.equal(f.calls, 2);
  assert.equal(f.disconnected, 2);
});
