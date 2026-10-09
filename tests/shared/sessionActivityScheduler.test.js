'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionActivityScheduler } = require('../../src/shared/sessionActivityScheduler');

function clock() {
  let time = 0;
  let serial = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimeout(fn, delay) { const id = ++serial; tasks.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    async advance(ms) {
      const until = time + ms;
      while (true) {
        const entry = [...tasks].sort((a, b) => a[1].at - b[1].at).find(([, task]) => task.at <= until);
        if (!entry) break;
        tasks.delete(entry[0]); time = entry[1].at; entry[1].fn();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        await new Promise(resolve => setImmediate(resolve));
      }
      time = until;
    }
  };
}

test('native events avoid fast idle polling while leases and unavailable watches retain reconciliation', async () => {
  const timer = clock(); const reads = [];
  let ready = true; let lease = false;
  const scheduler = createSessionActivityScheduler({
    refresh: () => reads.push(timer.now()), nativeEventsReady: () => ready, needsRenewal: () => lease
  }, timer);
  scheduler.start();
  await timer.advance(62_999);
  assert.deepEqual(reads, [3000]);
  await timer.advance(1);
  assert.deepEqual(reads, [3000, 63_000]);
  lease = true; scheduler.request(); await timer.advance(500);
  await timer.advance(10_000);
  assert.deepEqual(reads.slice(-2), [63_500, 73_500]);
  ready = false; scheduler.request(); await timer.advance(500); await timer.advance(3000);
  assert.deepEqual(reads.slice(-2), [74_000, 77_000]);
  scheduler.stop(); await timer.advance(100_000);
  assert.equal(reads.length, 6);
});

test('bursts coalesce and a continuous stream cannot postpone state refresh past three seconds', async () => {
  const timer = clock(); const reads = [];
  const scheduler = createSessionActivityScheduler({ refresh: () => reads.push(timer.now()), nativeEventsReady: () => true, needsRenewal: () => false }, timer);
  scheduler.start(); scheduler.request(); scheduler.request();
  await timer.advance(500); assert.deepEqual(reads, [500]);
  for (let i = 0; i < 10; i++) { scheduler.request(); await timer.advance(300); }
  assert.deepEqual(reads, [500, 3500]);
  scheduler.stop();
});

test('events during an in-flight read retry once without overlapping reads and stop severs the retry', async () => {
  const timer = clock(); let release; let calls = 0;
  const scheduler = createSessionActivityScheduler({
    refresh: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    nativeEventsReady: () => true, needsRenewal: () => false
  }, timer);
  scheduler.start(); await timer.advance(3000);
  scheduler.request(); scheduler.request(); await timer.advance(5000);
  assert.equal(calls, 1);
  release(); await scheduler.whenIdle(); await timer.advance(1);
  assert.equal(calls, 2);
  scheduler.request(); scheduler.stop(); release(); await scheduler.whenIdle(); await timer.advance(100_000);
  assert.equal(calls, 2);
});

test('a read deferred behind an accounting tick is retried instead of losing its event', async () => {
  const timer = clock(); let calls = 0;
  const scheduler = createSessionActivityScheduler({ refresh: () => ++calls > 1, nativeEventsReady: () => true, needsRenewal: () => false }, timer);
  scheduler.start(); await timer.advance(6000);
  assert.equal(calls, 2); scheduler.stop();
});

test('an event during a short read takes the debounce path rather than the busy-tick delay', async () => {
  const timer = clock(); let release; const reads = [];
  const scheduler = createSessionActivityScheduler({
    refresh: () => { reads.push(timer.now()); return new Promise(resolve => { release = resolve; }); },
    nativeEventsReady: () => true, needsRenewal: () => false
  }, timer);
  scheduler.start(); await timer.advance(3000);
  scheduler.request(); await timer.advance(100);
  release(); await scheduler.whenIdle();
  await timer.advance(499); assert.deepEqual(reads, [3000]);
  await timer.advance(1); assert.deepEqual(reads, [3000, 3600]);
  scheduler.stop(); release(); await scheduler.whenIdle();
});

test('a busy tick or read error keeps the three-second retry even when another event arrives', async () => {
  for (const failed of [false, new Error('transient read')]) {
    const timer = clock(); let release; let calls = 0; const errors = [];
    const scheduler = createSessionActivityScheduler({
      refresh: () => { calls++; return calls === 1 ? new Promise((resolve, reject) => { release = () => failed instanceof Error ? reject(failed) : resolve(failed); }) : true; },
      nativeEventsReady: () => true, needsRenewal: () => false, onError: error => errors.push(error)
    }, timer);
    scheduler.start(); await timer.advance(3000); scheduler.request();
    release(); await scheduler.whenIdle();
    await timer.advance(2999); assert.equal(calls, 1);
    await timer.advance(1); assert.equal(calls, 2);
    assert.equal(errors.length, failed instanceof Error ? 1 : 0);
    scheduler.stop();
  }
});


test('collector interval mode reconciles idle once per minute and live leases every ten seconds', async t => {
  const schedulerModule = require('../../src/shared/sessionActivityScheduler');
  const registry = require('../../src/shared/sessionActivityRegistry');
  const collectorPath = require.resolve('../../src/shared/collector');
  const saved = require.cache[collectorPath];
  t.after(() => { delete require.cache[collectorPath]; if (saved) require.cache[collectorPath] = saved; });
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-interval-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let timer; let reads; let live;
  t.mock.method(schedulerModule, 'createSessionActivityScheduler', options => createSessionActivityScheduler(options, timer));
  t.mock.method(registry, 'refreshSessionActivity', async summary => {
    reads.push(timer.now());
    return live ? { ...summary, today: { ...summary.today, sessions: {
      'claude:live': { client: 'claude', sessionId: 'live', liveActivity: { state: 'running', observedAt: new Date().toISOString() } }
    } } } : summary;
  });
  delete require.cache[collectorPath];
  const { startCollector } = require(collectorPath);
  for (live of [false, true]) {
    timer = clock(); reads = [];
    let ready;
    const initial = new Promise(resolve => { ready = resolve; });
    const handle = startCollector({
      clients: 'claude', deviceId: 'interval', agentVersion: 'test', homeDir: home, env: {},
      intervalMs: 3600000, watchEnabled: false, anchorPersistenceEnabled: false, wslScanEnabled: false,
      limitsEnabled: false, historyEnabled: false, projectsEnabled: false, codexLocalUsageEnabled: false,
      runTokscale: async () => ({ entries: [] }), onUpdate: () => ready()
    });
    try {
      await initial;
      await new Promise(resolve => setImmediate(resolve));
      const initialReads = reads.length;
      await timer.advance(13000);
      assert.equal(reads.length - initialReads, live ? 2 : 1);
      await timer.advance(live ? 10000 : 50000);
      assert.equal(reads.length - initialReads, live ? 3 : 2);
      handle.stop();
      await timer.advance(60000);
      assert.equal(reads.length - initialReads, live ? 3 : 2);
    } finally { handle.stop(); }
  }
});
