'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCursorUsageSource } = require('../../src/shared/providers/cursor/usageSource');
const { createCursorSelfSync } = require('../../src/shared/providers/cursor/selfSync');
const cursorAuth = require('../../src/shared/providers/cursor/auth');
const { createSelfSyncThrottle } = require('../../src/shared/selfSyncThrottle');
const { withCursorLifecycle, cursorLifecycleBusy } = require('../../src/shared/providers/cursor/lifecycle');
const { createCursorUsageEventIndex } = require('../../src/shared/providers/cursor/usageEvents');

const context = { day: '2026-11-01', pricing: 'prices-v1' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function snapshot(value = 1) {
  return { today: { totalTokens: value }, month: { totalTokens: value }, allTime: { totalTokens: value }, graph: { contributions: [] } };
}

test('snapshot initialization never reads during an account lifecycle mutation', async () => {
  const account = deferred();
  const accountOperation = withCursorLifecycle(() => account.promise);
  const controller = new AbortController();
  let reads = 0;
  const source = createCursorUsageSource({ context, signal: controller.signal,
    sync: async () => false,
    read: async () => { reads++; assert.equal(cursorLifecycleBusy(), true); return snapshot(); }
  });
  const ready = source.refresh({ readOnly: true });
  await flush();
  assert.equal(reads, 0);
  assert.equal(source.getSnapshot().revision, 0);
  account.resolve();
  await accountOperation;
  await ready;
  assert.equal(reads, 1);
  assert.equal(source.getSnapshot().revision, 1);
});

test('new day/pricing waits for old sync close and resolves the offline barrier before the next import', async () => {
  const controller = new AbortController();
  const firstSync = deferred(), nextSync = deferred();
  const signals = [];
  const reads = [];
  const source = createCursorUsageSource({ context, signal: controller.signal,
    sync: async options => {
      signals.push(options.signal);
      await (signals.length === 1 ? firstSync : nextSync).promise;
      return true;
    },
    read: async current => { reads.push(current); return snapshot(current.day.endsWith('02') ? 2 : 1); }
  });
  const initial = source.refresh();
  await flush();
  assert.equal(signals.length, 1);
  const nextContext = { day: '2026-11-02', pricing: 'prices-v2' };
  let ready = false;
  const changed = source.ensureContext(nextContext).then(() => { ready = true; });
  assert.equal(signals[0].aborted, true);
  await flush();
  assert.equal(ready, false);
  assert.equal(reads.length, 1, 'offline read must wait for the old subprocess close');
  firstSync.resolve();
  await changed;
  assert.equal(source.getSnapshot().context, nextContext);
  assert.equal(source.getSnapshot().today.totalTokens, 2);
  assert.equal(source.isActive(), true, 'network-idle and offline-ready barriers are independent');
  nextSync.resolve();
  await initial;
});

test('failed imports retain complete cached data and honor backoff; forced retry can replace removed account data', async t => {
  const controller = new AbortController();
  const throttle = createSelfSyncThrottle({ now: () => 2000000 });
  const selfSync = createCursorSelfSync({ selfSyncThrottle: throttle });
  let calls = 0;
  let cachedTokens = 7;
  t.mock.method(cursorAuth, 'runCursorSync', async () => { calls++; throw new Error('offline'); });
  const source = createCursorUsageSource({ context, signal: controller.signal,
    sync: options => selfSync.maybeSyncCursor('cursor', null, options),
    read: async () => snapshot(cachedTokens)
  });
  await source.refresh();
  assert.equal(calls, 1);
  assert.equal(source.getSnapshot().allTime.totalTokens, 7);
  const revision = source.getSnapshot().revision;
  await source.refresh();
  assert.equal(calls, 1);
  assert.equal(source.getSnapshot().revision, revision);
  cachedTokens = 0;
  await source.refresh({ force: true });
  assert.equal(calls, 2);
  assert.equal(source.getSnapshot().allTime.totalTokens, 0);
});

test('source/force failure restoration follows the attempts that consumed the events', async () => {
  const controller = new AbortController();
  const gate = deferred();
  const restored = [];
  let calls = 0;
  const source = createCursorUsageSource({ context, signal: controller.signal,
    sync: async options => {
      calls++;
      if (calls === 1) await gate.promise;
      options.onFailure('cursor');
      return true;
    },
    read: async () => snapshot()
  });
  const operation = source.refresh();
  await flush();
  void source.refresh({ onFailure: kind => restored.push(`source:${kind}`) });
  void source.refresh({ force: true, onFailure: kind => restored.push(`force:${kind}`) });
  gate.resolve();
  await operation;
  assert.equal(calls, 2);
  assert.deepEqual(restored, ['source:cursor', 'force:cursor']);
});

test('an incomplete cache read never publishes a partial replacement', async () => {
  const controller = new AbortController();
  let fail = false;
  const errors = [];
  const source = createCursorUsageSource({ context, signal: controller.signal,
    sync: async () => true,
    read: async () => { if (fail) throw new Error('month read failed'); return snapshot(10); },
    onError: error => errors.push(error.message)
  });
  await source.refresh();
  const previous = source.getSnapshot();
  fail = true;
  await source.refresh({ force: true });
  assert.equal(source.getSnapshot(), previous);
  assert.deepEqual(errors, ['month read failed']);
});

for (const [label, nextContext] of [
  ['day rollover', { ...context, day: '2026-11-02' }],
  ['pricing change', { ...context, pricing: 'prices-v2' }]
]) {
  test(`a failed ${label} cache read keeps the previous snapshot and can retry`, async t => {
    const errors = [];
    const publications = [];
    let reads = 0;
    const source = createCursorUsageSource({ context, signal: new AbortController().signal,
      sync: async () => assert.fail('an offline context retry must not require a cloud import'),
      read: async current => {
        reads++;
        if (reads === 2) throw new Error('month read failed');
        return snapshot(current === context ? 10 : 20);
      },
      onChange: () => publications.push(source.getSnapshot()),
      onError: error => errors.push(error.message)
    });
    t.after(() => source.stop());
    await source.refresh({ readOnly: true });
    const previous = source.getSnapshot();

    await assert.rejects(source.ensureContext(nextContext), /month read failed/);
    await source.whenIdle();
    assert.equal(source.getSnapshot(), previous, 'a failed read cannot relabel old usage with a new date or price revision');
    assert.equal(publications.length, 1);

    // Observe settlement after the source becomes idle instead of awaiting the
    // request directly: the regression left this promise pending forever even
    // though no source operation remained to resolve it.
    let retryState = 'pending';
    const retry = source.ensureContext(nextContext).then(
      () => { retryState = 'ready'; },
      error => { retryState = error.message; }
    );
    await source.whenIdle();
    await flush();
    assert.equal(retryState, 'ready');
    await retry;
    assert.equal(reads, 3);
    assert.equal(source.getSnapshot().context, nextContext);
    assert.equal(source.getSnapshot().revision, previous.revision + 1);
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(source.getSnapshot()[period].totalTokens, 20);
    }
    assert.equal(publications.length, 2);
    assert.deepEqual(errors, ['month read failed']);
  });
}

test('stopping an offline context read rejects its waiter but keeps the close barrier and previous snapshot', async t => {
  const gate = deferred();
  let currentSignal;
  const source = createCursorUsageSource({ context, signal: new AbortController().signal,
    sync: async () => false,
    read: async (current, signal) => {
      if (current !== context) {
        currentSignal = signal;
        await gate.promise;
      }
      return snapshot(current === context ? 10 : 20);
    }
  });
  t.after(async () => {
    source.stop();
    gate.resolve();
    await source.whenIdle();
  });
  await source.refresh({ readOnly: true });
  const previous = source.getSnapshot();
  const changed = source.ensureContext({ ...context, day: '2026-11-02' });
  const rejected = assert.rejects(changed, /stopped/);
  await flush();
  source.stop();
  await rejected;
  assert.equal(currentSignal.aborted, true);
  let idle = false;
  const stopped = source.whenIdle().then(() => { idle = true; });
  await flush();
  assert.equal(idle, false, 'abort requests do not prove that the cache reader exited');
  gate.resolve();
  await stopped;
  assert.equal(source.getSnapshot(), previous, 'late completion after stop cannot publish');
});

test('a sync requested immediately after the offline-ready barrier is not swallowed by the finishing read', async t => {
  const syncs = [];
  const source = createCursorUsageSource({ context, signal: new AbortController().signal,
    sync: async options => { syncs.push(options); return true; },
    read: async () => snapshot()
  });
  t.after(() => source.stop());
  await source.refresh({ readOnly: true });
  const nextContext = { ...context, day: '2026-11-02' };
  await source.ensureContext(nextContext);
  // This is runTick's ordering: the ready waiter can resume while the source's
  // read-only operation has not yet cleared its active promise.
  await source.refresh({ minIntervalMs: 10000 });
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].minIntervalMs, 10000);
  assert.equal(source.getSnapshot().context, nextContext);
});

test('source events during an import coalesce into one later sync without overlapping the first', async t => {
  const gate = deferred();
  const controller = new AbortController();
  let now = 2000000;
  const throttle = createSelfSyncThrottle({ now: () => now });
  const selfSync = createCursorSelfSync({ selfSyncThrottle: throttle });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let cachedTokens = 10;
  t.mock.method(cursorAuth, 'runCursorSync', async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (calls === 1) await gate.promise;
      cachedTokens += 10;
      return { synced: true };
    } finally {
      active--;
    }
  });
  const source = createCursorUsageSource({ context, signal: controller.signal,
    sync: options => selfSync.maybeSyncCursor('cursor', null, options),
    read: async () => snapshot(cachedTokens)
  });
  t.after(async () => {
    source.stop();
    gate.resolve();
    await source.whenIdle();
  });
  const importDone = source.refresh();
  await flush();
  const event = { source: true, minIntervalMs: () => throttle.sourceFloorMs('cursor') };
  void source.refresh(event);
  void source.refresh(event);
  void source.refresh(event);
  assert.equal(calls, 1, 'new events cannot start a concurrent cache writer');
  // The import only includes usage known when it began. Once the source floor
  // has elapsed, the queued request must read changes that arrived after it.
  now += 10001;
  gate.resolve();
  await importDone;
  assert.equal(calls, 2, 'all events received during the first import share one follow-up');
  assert.equal(maxActive, 1);
  assert.equal(source.getSnapshot().today.totalTokens, 30);
});

test('synchronous legacy-event index retains last-good state while Cursor owns the cache', async () => {
  let version = 1;
  let reads = 0;
  const reader = createCursorUsageEventIndex({ cacheDir: '/fixture/cursor-cache', fs: {
    readdirSync: folder => folder.endsWith('archive') ? [] : ['usage.account.json'],
    statSync: () => ({ isFile: () => true, size: version, mtimeMs: version }),
    readFileSync: () => { reads++; return JSON.stringify({ usageEventsDisplay: [{ timestamp: 1000, model: 'm', conversationId: `s${version}`, tokenUsage: { inputTokens: 10 } }] }); }
  } });
  const first = reader();
  assert.deepEqual(first.sessionsAt(1000, 10), ['s1']);
  const gate = deferred();
  const writing = withCursorLifecycle(() => gate.promise);
  version = 2;
  assert.equal(reader(), first);
  assert.equal(reads, 1);
  gate.resolve();
  await writing;
  assert.deepEqual(reader().sessionsAt(1000, 10), ['s2']);
});

test('an idle cadence request cannot replace a queued source event and its shorter floor', async () => {
  const controller = new AbortController();
  const floors = [];
  let restored = 0;
  const source = createCursorUsageSource({ context, signal: controller.signal,
    sync: async options => { floors.push(options.minIntervalMs); return false; },
    read: async () => snapshot()
  });
  const ready = source.refresh({ readOnly: true });
  void source.refresh({ source: true, minIntervalMs: 10000, onFailure: () => { restored++; } });
  void source.refresh({ minIntervalMs: 300000 });
  await ready;
  assert.deepEqual(floors, [10000]);
  assert.equal(restored, 1);
});

for (const method of ['ensureContext', 'readCache']) {
  test(`${method} rejects a superseded context instead of accepting another context's snapshot`, async t => {
    const gate = deferred();
    const nextContext = { ...context, day: '2026-11-02' };
    const latestContext = { ...nextContext, pricing: 'prices-v2' };
    const publications = [];
    const source = createCursorUsageSource({ context, signal: new AbortController().signal,
      sync: async () => assert.fail('context reads must remain offline'),
      read: async current => {
        if (current === nextContext) await gate.promise;
        return snapshot(current === context ? 10 : 20);
      },
      onChange: () => publications.push(source.getSnapshot().context)
    });
    t.after(async () => {
      source.stop();
      gate.resolve();
      await source.whenIdle();
    });
    await source.refresh({ readOnly: true });
    const superseded = source[method](nextContext).then(
      () => ({ state: 'ready' }),
      error => ({ state: 'rejected', error })
    );
    await flush();
    const latest = source.ensureContext(latestContext);
    gate.resolve();
    await latest;
    const outcome = await superseded;
    assert.equal(outcome.state, 'rejected');
    assert.match(outcome.error.message, /superseded/);
    assert.equal(source.getSnapshot().context, latestContext);
    assert.deepEqual(publications, [context, latestContext]);
    await source.ensureContext(latestContext);
    await source.whenIdle();
  });
}

for (const reason of ['stopped', 'aborted']) {
  test(`ensureContext rejects after the source is ${reason}, including matching contexts`, async () => {
    const controller = new AbortController();
    let reads = 0;
    const source = createCursorUsageSource({ context, signal: controller.signal,
      sync: async () => false,
      read: async () => { reads++; return snapshot(); }
    });
    await source.refresh({ readOnly: true });
    if (reason === 'stopped') source.stop();
    else controller.abort(new Error('parent aborted'));
    for (const requested of [{ ...context, day: '2026-11-02' }, context]) {
      let outcome = 'pending';
      const ready = source.ensureContext(requested).then(
        () => { outcome = 'ready'; },
        () => { outcome = 'rejected'; }
      );
      await flush();
      assert.equal(outcome, 'rejected');
      await ready;
    }
    assert.equal(reads, 1, 'no cache work can start after shutdown');
  });
}

test('identical complete snapshots retain their revision while completing refresh and cache waiters', async () => {
  const changes = [];
  let reads = 0;
  const source = createCursorUsageSource({ context, signal: new AbortController().signal,
    sync: async () => true,
    read: async () => {
      reads++;
      const value = snapshot(10);
      for (const period of ['today', 'month', 'allTime']) value[period].processingTimeMs = reads;
      value.graph.meta = { generatedAt: new Date(reads).toISOString(), version: 1, dateRange: { start: context.day, end: context.day } };
      return value;
    },
    onChange: change => changes.push(change?.changed)
  });
  assert.equal(await source.refresh(), true);
  const initial = source.getSnapshot();
  assert.equal(initial.revision, 1, 'the identical post-sync read is not a new data revision');
  await source.readCache({ ...context });
  await source.whenIdle();
  assert.equal(await source.refresh({ force: true }), true);
  assert.equal(source.getSnapshot(), initial);
  assert.equal(initial.today.processingTimeMs, 1, 'comparison does not mutate the raw reports');
  assert.equal(initial.graph.meta.generatedAt, new Date(1).toISOString());
  assert.deepEqual(changes, [true, false, false, false], 'completion still publishes current sync health');
});

test('periods, History, graph status and context each invalidate a Cursor snapshot', async () => {
  let value = snapshot(10);
  let requested = context;
  const changes = [];
  const source = createCursorUsageSource({ context, signal: new AbortController().signal,
    sync: async () => false,
    read: async () => structuredClone(value),
    onChange: change => changes.push(change?.changed)
  });
  await source.refresh({ readOnly: true });
  for (const field of ['today', 'month', 'allTime', 'warnings', 'graph', 'graphVersion', 'graphDateRange', 'graphFailed', 'graphRecovered', 'day', 'pricing']) {
    const previous = source.getSnapshot();
    if (['today', 'month', 'allTime'].includes(field)) value[field].totalTokens++;
    else if (field === 'warnings') value.today.warnings = ['unpriced model'];
    else if (field === 'graph') value.graph.contributions.push({ date: '2025-01-01', clients: [] });
    else if (field === 'graphVersion') value.graph.meta = { version: 2 };
    else if (field === 'graphDateRange') value.graph.meta.dateRange = { start: '2025-01-01', end: context.day };
    else if (field === 'graphFailed') value.graphFailed = true;
    else if (field === 'graphRecovered') delete value.graphFailed;
    else if (field === 'day') requested = { ...requested, day: '2026-11-02' };
    else requested = { ...requested, pricing: 'prices-v2' };
    await source.readCache(requested);
    await source.whenIdle();
    assert.equal(source.getSnapshot().revision, previous.revision + 1, field);
    assert.equal(changes.at(-1), true, field);
  }
  assert.equal(changes.length, 12);
});
