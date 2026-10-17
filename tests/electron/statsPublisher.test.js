'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createRendererSnapshots,
  createStatsPresentationCache,
  createStatsPublicationBatcher,
  rendererStats
} = require('../../src/electron/statsPublisher');

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

test('the presentation of one snapshot is projected once for every reader', () => {
  const cache = createStatsPresentationCache();
  const stats = { periods: {} };
  let projections = 0;
  const project = () => { projections += 1; return { projected: projections }; };

  const first = cache.get(stats, 'key', project);
  assert.equal(cache.get(stats, 'key', project), first);
  assert.equal(projections, 1);
});

test('a new snapshot or a new settings key projects again', () => {
  const cache = createStatsPresentationCache();
  const stats = { periods: {} };
  let projections = 0;
  const project = () => { projections += 1; return { projected: projections }; };

  const first = cache.get(stats, 'aliases-a', project);
  const second = cache.get(stats, 'aliases-b', project);
  assert.notEqual(second, first);
  assert.notEqual(cache.get({ periods: {} }, 'aliases-b', project), second);
  assert.equal(projections, 3);
  // Only the latest key is kept per snapshot; going back is a fresh projection.
  cache.get(stats, 'aliases-a', project);
  assert.equal(projections, 4);
});

test('non-object stats pass straight through the projection', () => {
  const cache = createStatsPresentationCache();
  assert.equal(cache.get(null, 'key', (stats) => stats), null);
});

test('requests inside one window publish once, at the window close', () => {
  const clock = fakeTimers();
  const published = [];
  const batcher = createStatsPublicationBatcher({
    windowMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: (entry) => published.push(entry)
  });

  batcher.request({ reason: 'local', at: 'a' });
  batcher.request({ reason: 'local', at: 'b' });
  assert.equal(clock.timers.length, 1, 'a later request joins the open window rather than extending it');
  assert.equal(clock.timers[0].ms, 1000);
  assert.equal(clock.timers[0].unrefCalled, true);
  assert.deepEqual(published, []);

  clock.timers[0].fn();
  assert.deepEqual(published, [{ reason: 'local', at: 'b' }]);

  batcher.request({ reason: 'local', at: 'c' });
  assert.equal(clock.timers.length, 2, 'the next request opens a new window');
});

test('a Hub event in the batch outranks a later local tick', () => {
  const clock = fakeTimers();
  const published = [];
  const batcher = createStatsPublicationBatcher({
    windowMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: (entry) => published.push(entry)
  });

  batcher.request({ reason: 'ingest', at: 'hub' });
  batcher.request({ reason: 'local', at: 'tick' });
  clock.timers[0].fn();
  assert.deepEqual(published, [{ reason: 'ingest', at: 'hub' }]);

  // A Hub event without a reason is still a Hub event.
  batcher.request({ reason: 'local', at: 'tick' });
  batcher.request({ reason: undefined, at: 'snapshot' });
  clock.timers[1].fn();
  assert.deepEqual(published[1], { reason: undefined, at: 'snapshot' });
});

test('flush publishes the pending batch now and closes the window', () => {
  const clock = fakeTimers();
  const published = [];
  const batcher = createStatsPublicationBatcher({
    windowMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: (entry) => published.push(entry)
  });

  batcher.flush();
  assert.deepEqual(published, [], 'nothing pending publishes nothing');

  batcher.request({ reason: 'ingest', at: 'hub' });
  batcher.flush();
  assert.deepEqual(published, [{ reason: 'ingest', at: 'hub' }]);
  assert.equal(clock.timers[0].cleared, true);
});

test('cancel drops the pending batch', () => {
  const clock = fakeTimers();
  const published = [];
  const batcher = createStatsPublicationBatcher({
    windowMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: (entry) => published.push(entry)
  });

  batcher.request({ reason: 'ingest', at: 'hub' });
  batcher.cancel();
  assert.equal(clock.timers[0].cleared, true);
  batcher.flush();
  assert.deepEqual(published, []);
});

function syncModeStats() {
  const localToday = { totalTokens: 10, clients: { claude: 10 }, sessions: { 'claude:a': { totalTokens: 10 } }, projects: { p: { totalTokens: 10 } } };
  const localAllTime = { totalTokens: 90, clients: { claude: 90 }, sessions: { 'claude:a': { totalTokens: 90 } }, projects: { p: { totalTokens: 90 } } };
  return {
    periods: {
      today: { totalTokens: 10, sessions: { 'claude:a': { totalTokens: 10 } } },
      allTime: { totalTokens: 90, sessions: { 'claude:month-only': { totalTokens: 5 } } }
    },
    devices: [
      { deviceId: 'local', history: { daily: [] }, periods: { today: localToday, allTime: localAllTime } },
      { deviceId: 'legacy', today: { totalTokens: 1 } }
    ],
    limits: { providers: [] }
  };
}

test('the renderer copy drops device sessions and projects but keeps their totals', () => {
  const stats = syncModeStats();
  const snapshot = structuredClone(stats);
  const result = rendererStats(stats);

  const local = result.devices[0];
  assert.deepEqual(local.periods.today, { totalTokens: 10, clients: { claude: 10 } });
  assert.deepEqual(local.periods.allTime, { totalTokens: 90, clients: { claude: 90 } });
  assert.equal(local.history, stats.devices[0].history);
  assert.equal(result.devices[1], stats.devices[1], 'a record without periods passes through');
  assert.equal(result.limits, stats.limits);
  assert.deepEqual(stats, snapshot, 'the published snapshot main keeps is not mutated');
});

test('the all-time session list stays out of the renderer copy in every mode', () => {
  const stats = syncModeStats();
  const result = rendererStats(stats);

  assert.equal(Object.hasOwn(result.periods.allTime, 'sessions'), false);
  assert.equal(result.periods.allTime.totalTokens, 90);
  assert.equal(result.periods.today, stats.periods.today, 'today and month keep their sessions');
  // The exporter reads main's copy, which keeps the lossless aggregate.
  assert.deepEqual(stats.periods.allTime.sessions, { 'claude:month-only': { totalTokens: 5 } });

  const withoutList = { periods: { allTime: { totalTokens: 1 } }, devices: [] };
  assert.equal(rendererStats(withoutList).periods, withoutList.periods);
  assert.equal(rendererStats(null), null);
});

test('every stats payload sent to the renderer goes through rendererStats and names its snapshot', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  assert.equal(
    (main.match(/stats: rendererSnapshots\.stamp\(latestStats, rendererStats\(visibleStats\)\)/g) || []).length,
    2,
    'stats push and presentation refresh'
  );
  assert.match(main, /ipcMain\.handle\('stats:get'[\s\S]*?return rendererSnapshots\.stamp\(stats, rendererStats\(electronPresentationStats\(stats\)\)\);/);
  assert.doesNotMatch(main, /stats: visibleStats\b/);
  assert.match(
    main,
    /ipcMain\.handle\('stats:allTimeSessions', \(_event, snapshotId\) => rendererAllTimeSessions\(rendererSnapshots\.get\(snapshotId\)\)\)/
  );
  assert.match(main, /createRendererSnapshots\(\{ source: \(\) => hubModeGeneration \}\)/);
});

test('the pulled list completes its snapshot with the local record that snapshot was built with', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const pull = main.match(/function rendererAllTimeSessions\(stats\) \{([\s\S]*?)\n\}\n/);
  assert.ok(pull, 'rendererAllTimeSessions exists');
  // The live record moves on between publishes; reading it here would show a
  // newer local list under the older snapshot's totals.
  assert.doesNotMatch(pull[1], /lastCollectedDevice/);
  assert.match(pull[1], /snapshotLocalDevices\.get\(stats\)/);
  const inject = main.match(/function injectLocalDeviceStatus\(stats\) \{([\s\S]*?)\n\}\n/);
  assert.match(inject[1], /if \(mode !== 'local'\) snapshotLocalDevices\.set\(stats, \{ localDevice: lastCollectedDevice \}\);\s*return stats;\s*$/);
});

test('a snapshot stays addressable after newer ones are published', () => {
  let source = 3;
  const snapshots = createRendererSnapshots({ source: () => source, limit: 2 });
  const first = { periods: {} };
  const copy = { periods: {}, limits: {} };
  const stamped = snapshots.stamp(first, copy);
  assert.deepEqual(stamped.snapshot, { id: 1, source: 3 });
  assert.equal(stamped.limits, copy.limits);
  assert.equal(Object.hasOwn(copy, 'snapshot'), false, 'the copy passed in is not mutated');
  assert.deepEqual(snapshots.stamp(first, {}).snapshot, { id: 1, source: 3 }, 'one id per snapshot object');

  // The renderer adopted `first` through stats:get; a later push must not
  // redirect a pull for it to the newer snapshot.
  source = 4;
  const second = { periods: {} };
  assert.deepEqual(snapshots.stamp(second, {}).snapshot, { id: 2, source: 4 });
  assert.equal(snapshots.get(1), first);
  assert.equal(snapshots.get(2), second);

  snapshots.stamp({ periods: {} }, {});
  assert.equal(snapshots.get(1), null, 'only the most recent snapshots stay addressable');
  assert.equal(snapshots.get(undefined), null);
  assert.equal(snapshots.stamp(null, null), null);

  // A presentation refresh re-sends an evicted `latestStats`: the id it hands
  // out must resolve, and keep the source the snapshot was built under.
  source = 5;
  assert.deepEqual(snapshots.stamp(first, {}).snapshot, { id: 1, source: 3 });
  assert.equal(snapshots.get(1), first);
  assert.equal(snapshots.get(2), null, 'the re-stamped snapshot counts as recent');
});

test('bounded derived projections evict independently of eight addressable snapshot inputs', () => {
  const cache = createStatsPresentationCache({ limit: 2 });
  const snapshots = createRendererSnapshots({ source: () => 'hub-a' });
  const inputs = Array.from({ length: 8 }, (_, n) => ({ total: n, history: { clock: n, streak: n + 1 } }));
  let projections = 0;
  const project = stats => { projections += 1; return structuredClone(stats); };
  const tags = inputs.map(stats => snapshots.stamp(stats, stats).snapshot);
  const first = cache.get(inputs[0], 'aliases', () => project(inputs[0]));
  cache.get(inputs[1], 'aliases', () => project(inputs[1]));
  assert.equal(cache.get(inputs[0], 'aliases', () => project(inputs[0])), first, 'a read promotes the hot entry');
  cache.get(inputs[2], 'aliases', () => project(inputs[2]));
  assert.equal(cache.get(inputs[0], 'aliases', () => project(inputs[0])), first);
  for (const stats of inputs.slice(3)) cache.get(stats, 'aliases', () => project(stats));
  assert.equal(projections, 8);
  for (let n = 0; n < 8; n += 1) {
    const original = snapshots.get(tags[n].id);
    assert.equal(original, inputs[n]);
    assert.deepEqual(cache.get(original, 'aliases', () => project(original)), original, 'rebuild from captured inputs, including historical clock');
  }
  assert.equal(projections, 16, 'old derived results were evicted, while source IDs survived');
});

test('cache policy switches and activity updates cannot resurrect an evicted projection', () => {
  let maximum = Infinity;
  const cache = createStatsPresentationCache({ limit: () => maximum });
  const a = {}, b = {}, c = {};
  const old = cache.get(a, 'key', () => ({ counter: 1 }));
  maximum = 2;
  const current = cache.get(a, 'key', () => ({ counter: 2 }));
  assert.notEqual(current, old, 'entering bounded mode drops untracked old entries');
  cache.updateActivity(a, b, value => ({ counter: value.counter + 1 }));
  assert.equal(cache.get(b, 'key', () => assert.fail('activity hit')), cache.get(b, 'key', () => null));
  cache.get(c, 'key', () => ({}));
  let patched = false;
  cache.updateActivity(a, {}, () => { patched = true; });
  assert.equal(patched, false, 'evicted activity inputs rebuild on demand');
  cache.clear();
  assert.equal(cache.get(b, 'key', () => ({ counter: 4 })).counter, 4);
  maximum = Infinity;
  assert.equal(cache.get(b, 'key', () => ({ counter: 5 })).counter, 5);
});

test('destroying the only snapshot consumer retires IDs; recreated consumers get fresh monotonic IDs', () => {
  const snapshots = createRendererSnapshots({ source: () => 'hub-a' });
  const stats = { total: 10 };
  const old = snapshots.stamp(stats, {}).snapshot;
  snapshots.clear();
  assert.equal(snapshots.get(old.id), null);
  const next = snapshots.stamp(stats, {}).snapshot;
  assert.ok(next.id > old.id);
  assert.equal(snapshots.get(next.id), stats);
});
