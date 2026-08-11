'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_MIN_INTERVAL_MS,
  macWidgetHistorySourceKey,
  resetMacWidgetHistoryCache,
  resolveMacWidgetHistory
} = require('../../src/electron/macWidgetHistory');

function history(label) {
  return { daily: [{ date: '2026-08-09', totalTokens: 1, label }], monthly: [], summary: { label } };
}

test.beforeEach(() => resetMacWidgetHistoryCache());
test.after(() => resetMacWidgetHistoryCache());

test('the source key ignores the revision so a moving hash cannot invalidate the cache', () => {
  const config = { mode: 'client', hubMode: 'client', historyEnabled: true, hubUrl: 'http://hub' };
  assert.equal(macWidgetHistorySourceKey(config), macWidgetHistorySourceKey({ ...config }));
  assert.equal(
    macWidgetHistorySourceKey(config),
    macWidgetHistorySourceKey({ ...config, hubUrl: 'http://hub/' })
  );
  assert.notEqual(
    macWidgetHistorySourceKey(config),
    macWidgetHistorySourceKey({ ...config, hubUrl: 'http://other' })
  );
  assert.notEqual(
    macWidgetHistorySourceKey(config),
    macWidgetHistorySourceKey({ ...config, historyEnabled: false })
  );
});

test('the source key identifies the Hub data store, not its bearer secret', () => {
  const config = { mode: 'client', hubMode: 'client', historyEnabled: true, hubUrl: 'http://hub' };
  assert.equal(
    macWidgetHistorySourceKey({ ...config, secret: 'old-secret' }),
    macWidgetHistorySourceKey({ ...config, secret: 'rotated-secret' })
  );
});

test('an unchanged revision is served from cache without refetching', async () => {
  let calls = 0;
  const fetchHistory = () => { calls += 1; return history('a'); };

  const first = await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory, now: 0 });
  const second = await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory, now: 1_000 });

  assert.equal(calls, 1);
  assert.deepEqual(second, first);
});

test('a moving revision is throttled by the time floor', async () => {
  let calls = 0;
  const fetchHistory = () => { calls += 1; return history(`call-${calls}`); };
  const minIntervalMs = 60_000;

  await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory, now: 0, minIntervalMs });
  // Every ingest from any device moves the revision; without a floor each of
  // these would be a full history request.
  for (let index = 0; index < 5; index += 1) {
    const result = await resolveMacWidgetHistory({
      sourceKey: 's', revision: `r${index + 2}`, fetchHistory, now: 1_000 * (index + 1), minIntervalMs
    });
    assert.equal(result.summary.label, 'call-1');
  }
  assert.equal(calls, 1);

  const afterFloor = await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r9', fetchHistory, now: minIntervalMs, minIntervalMs
  });
  assert.equal(calls, 2);
  assert.equal(afterFloor.summary.label, 'call-2');
});

test('a backwards clock step expires the warm-cache freshness floor', async () => {
  let calls = 0;
  const fetchHistory = () => { calls += 1; return history(`call-${calls}`); };
  const minIntervalMs = 60_000;

  await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory, now: 600_000, minIntervalMs });
  const afterRollback = await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r2', fetchHistory, now: 300_000, minIntervalMs
  });

  assert.equal(calls, 2);
  assert.equal(afterRollback.summary.label, 'call-2');
});

test('a failed fetch keeps the last good history instead of blanking the heatmap', async () => {
  let calls = 0;
  const fetchHistory = () => {
    calls += 1;
    if (calls === 1) return history('good');
    throw new Error('hub unreachable');
  };
  const warnings = [];
  const minIntervalMs = 10;

  await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory, now: 0, minIntervalMs });
  const afterFailure = await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r2', fetchHistory, now: 100, minIntervalMs, logger: (m) => warnings.push(m)
  });

  assert.equal(calls, 2);
  assert.equal(afterFailure.summary.label, 'good');
  assert.equal(afterFailure.daily.length, 1);
  assert.match(warnings[0], /complete history unavailable/);
});

test('a cold start failure is bounded by the retry floor instead of refetching per push', async () => {
  let calls = 0;
  const fetchHistory = () => { calls += 1; throw new Error('hub unreachable'); };
  const minIntervalMs = 5 * 60_000;
  const retryIntervalMs = 30_000;

  const first = await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r1', fetchHistory, now: 0, minIntervalMs, retryIntervalMs
  });
  assert.deepEqual(first.daily, []);
  assert.equal(calls, 1);

  // Without the floor each of these would open another request, and the remote
  // read carries a 15s timeout, so they would stack up behind a dead hub.
  for (let index = 0; index < 10; index += 1) {
    await resolveMacWidgetHistory({
      sourceKey: 's', revision: `r${index + 2}`, fetchHistory, now: 1_000 * (index + 1), minIntervalMs, retryIntervalMs
    });
  }
  assert.equal(calls, 1, 'pushes inside the retry floor must not refetch');

  await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r99', fetchHistory, now: retryIntervalMs, minIntervalMs, retryIntervalMs
  });
  assert.equal(calls, 2, 'the retry floor expires on its own, without needing a new revision');
});

test('a backwards clock step expires the cold-failure retry floor', async () => {
  let calls = 0;
  const fetchHistory = () => {
    calls += 1;
    if (calls === 1) throw new Error('hub unreachable');
    return history('recovered');
  };
  const retryIntervalMs = 30_000;

  await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r1', fetchHistory, now: 600_000, retryIntervalMs
  });
  const afterRollback = await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r2', fetchHistory, now: 300_000, retryIntervalMs
  });

  assert.equal(calls, 2);
  assert.equal(afterRollback.summary.label, 'recovered');
});

test('recovery after a cold failure needs only the retry floor, not the freshness floor', async () => {
  let calls = 0;
  const fetchHistory = () => {
    calls += 1;
    if (calls === 1) throw new Error('hub unreachable');
    return history('recovered');
  };
  const minIntervalMs = 5 * 60_000;
  const retryIntervalMs = 30_000;

  await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory, now: 0, minIntervalMs, retryIntervalMs });
  const recovered = await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r2', fetchHistory, now: retryIntervalMs, minIntervalMs, retryIntervalMs
  });

  assert.equal(recovered.summary.label, 'recovered');
  // And once there is something to serve, the long freshness floor takes over.
  await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r3', fetchHistory, now: retryIntervalMs + 1_000, minIntervalMs, retryIntervalMs
  });
  assert.equal(calls, 2);
});

test('a warm-cache failure uses the retry floor even when freshness is immediate', async () => {
  let calls = 0;
  const fetchHistory = () => {
    calls += 1;
    if (calls === 1) return history('good');
    throw new Error('aggregation failed');
  };
  const retryIntervalMs = 30_000;

  await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r1', fetchHistory, now: 0, minIntervalMs: 0, retryIntervalMs
  });
  const afterFailure = await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r2', fetchHistory, now: 10, minIntervalMs: 0, retryIntervalMs
  });
  const insideRetryFloor = await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r3', fetchHistory, now: 11, minIntervalMs: 0, retryIntervalMs
  });

  assert.equal(calls, 2, 'a last-good cache must not make a failing source retry per push');
  assert.equal(afterFailure.summary.label, 'good');
  assert.equal(insideRetryFloor.summary.label, 'good');

  await resolveMacWidgetHistory({
    sourceKey: 's', revision: 'r4', fetchHistory, now: 10 + retryIntervalMs, minIntervalMs: 0, retryIntervalMs
  });
  assert.equal(calls, 3, 'the bounded retry becomes due without discarding last-good history');
});

test('a cold start can serve source-keyed persisted history while the remote fetch fails', async () => {
  let loads = 0;
  let fetches = 0;
  const persisted = history('persisted');
  const result = await resolveMacWidgetHistory({
    generation: 1,
    sourceKey: 'hub-a',
    revision: 'r1',
    loadCachedHistory: () => {
      loads += 1;
      return persisted;
    },
    fetchHistory: () => {
      fetches += 1;
      throw new Error('hub unreachable');
    },
    now: 0,
    logger: () => {}
  });

  assert.equal(loads, 1);
  assert.equal(fetches, 1);
  assert.equal(result.summary.label, 'persisted');
  assert.equal(result.daily.length, 1);
});

test('successful history refreshes persist the new last-good value', async () => {
  let saved = null;
  const refreshed = history('refreshed');
  const result = await resolveMacWidgetHistory({
    sourceKey: 'hub-a',
    revision: 'r1',
    fetchHistory: () => refreshed,
    saveCachedHistory: (value) => { saved = value; },
    now: 0
  });

  assert.deepEqual(saved, refreshed);
  assert.deepEqual(result, refreshed);
});

test('a persisted cache write failure does not hide a successful remote refresh', async () => {
  const warnings = [];
  const refreshed = history('refreshed');
  const result = await resolveMacWidgetHistory({
    sourceKey: 'hub-a',
    revision: 'r1',
    fetchHistory: () => refreshed,
    saveCachedHistory: () => { throw new Error('cache read-only'); },
    logger: (message) => warnings.push(message),
    now: 0
  });

  assert.deepEqual(result, refreshed);
  assert.ok(warnings.some((message) => /persisted history cache write failed/.test(message)));
});

test('a persisted cache read failure does not hide a successful remote refresh', async () => {
  let fetches = 0;
  const warnings = [];
  const refreshed = history('refreshed');
  const result = await resolveMacWidgetHistory({
    sourceKey: 'hub-a',
    revision: 'r1',
    loadCachedHistory: () => { throw new Error('cache corrupt'); },
    fetchHistory: () => {
      fetches += 1;
      return refreshed;
    },
    logger: (message) => warnings.push(message),
    now: 0
  });

  assert.equal(fetches, 1);
  assert.deepEqual(result, refreshed);
  assert.ok(warnings.some((message) => /persisted history cache read failed/.test(message)));
});

test('a stale source failure cannot return the active source cache', async () => {
  let rejectSourceA;
  let markSourceAStarted;
  const sourceAStarted = new Promise((resolve) => { markSourceAStarted = resolve; });
  const sourceAResult = resolveMacWidgetHistory({
    sourceKey: 'hub-a',
    revision: 'a1',
    now: 0,
    logger: () => {},
    fetchHistory: () => {
      markSourceAStarted();
      return new Promise((resolve, reject) => { rejectSourceA = reject; });
    }
  });
  await sourceAStarted;

  const sourceBResult = await resolveMacWidgetHistory({
    sourceKey: 'hub-b', revision: 'b1', now: 1, fetchHistory: () => history('hub-b')
  });
  rejectSourceA(new Error('hub-a failed after the source changed'));
  const staleResult = await sourceAResult;

  assert.equal(sourceBResult.summary.label, 'hub-b');
  assert.deepEqual(staleResult, { daily: [], monthly: [], summary: {} });
});

test('a stale source success is discarded instead of reaching its caller', async () => {
  let releaseSourceA;
  let markSourceAStarted;
  const sourceAStarted = new Promise((resolve) => { markSourceAStarted = resolve; });
  const sourceAResult = resolveMacWidgetHistory({
    sourceKey: 'hub-a',
    revision: 'a1',
    now: 0,
    fetchHistory: () => {
      markSourceAStarted();
      return new Promise((resolve) => { releaseSourceA = resolve; });
    }
  });
  await sourceAStarted;

  await resolveMacWidgetHistory({
    sourceKey: 'hub-b', revision: 'b1', now: 1, fetchHistory: () => history('hub-b')
  });
  releaseSourceA(history('hub-a'));

  assert.deepEqual(await sourceAResult, { daily: [], monthly: [], summary: {} });
});

test('a new generation does not join an old in-flight request for the same source', async () => {
  let calls = 0;
  let releaseGenerationOne;
  let markGenerationOneStarted;
  const generationOneStarted = new Promise((resolve) => { markGenerationOneStarted = resolve; });
  const generationOneResult = resolveMacWidgetHistory({
    generation: 1,
    sourceKey: 'hub-a',
    revision: 'a1',
    now: 0,
    fetchHistory: () => {
      calls += 1;
      markGenerationOneStarted();
      return new Promise((resolve) => { releaseGenerationOne = resolve; });
    }
  });
  await generationOneStarted;

  const generationThreeResult = resolveMacWidgetHistory({
    generation: 3,
    sourceKey: 'hub-a',
    revision: 'a3',
    now: 1,
    fetchHistory: () => {
      calls += 1;
      return history('hub-a-generation-3');
    }
  });
  await Promise.resolve();
  const callsBeforeRelease = calls;
  releaseGenerationOne(history('hub-a-generation-1'));

  assert.equal(callsBeforeRelease, 2, 'the generation-three request must not join generation one');
  assert.equal((await generationThreeResult).summary.label, 'hub-a-generation-3');
  assert.deepEqual(await generationOneResult, { daily: [], monthly: [], summary: {} });
});

test('returning to the same source in a new generation does not reuse the old generation cache', async () => {
  let calls = 0;
  let releaseGenerationOne;
  let markGenerationOneStarted;
  const generationOneStarted = new Promise((resolve) => { markGenerationOneStarted = resolve; });
  const generationOneResult = resolveMacWidgetHistory({
    generation: 1,
    sourceKey: 'hub-a',
    revision: 'a1',
    now: 0,
    fetchHistory: () => {
      calls += 1;
      markGenerationOneStarted();
      return new Promise((resolve) => { releaseGenerationOne = resolve; });
    }
  });
  await generationOneStarted;

  // The serial snapshot lane is still waiting for generation one while the mode
  // changes A -> B -> A. Generation three reaches this resolver only after the
  // old request completes, so the semantic source key alone cannot reveal that
  // its cache belongs to a superseded mode lifetime.
  releaseGenerationOne(history('hub-a-generation-1'));
  await generationOneResult;

  const generationThreeResult = await resolveMacWidgetHistory({
    generation: 3,
    sourceKey: 'hub-a',
    revision: 'a3',
    now: 1,
    fetchHistory: () => {
      calls += 1;
      return history('hub-a-generation-3');
    }
  });

  assert.equal(calls, 2, 'a new generation must fetch even when it returns to the same source key');
  assert.equal(generationThreeResult.summary.label, 'hub-a-generation-3');
});

test('an in-process source opts out of the freshness floor but keeps the retry floor', async () => {
  let calls = 0;
  const fetchHistory = () => { calls += 1; return history(`call-${calls}`); };

  // local / embedded-host history is a synchronous aggregation, so throttling it
  // would only make the heatmap lag.
  await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory, now: 0, minIntervalMs: 0 });
  await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r2', fetchHistory, now: 1, minIntervalMs: 0 });
  const third = await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r3', fetchHistory, now: 2, minIntervalMs: 0 });
  assert.equal(calls, 3);
  assert.equal(third.summary.label, 'call-3');

  resetMacWidgetHistoryCache();
  let failures = 0;
  const failing = () => { failures += 1; throw new Error('aggregation failed'); };
  await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory: failing, now: 0, minIntervalMs: 0 });
  await resolveMacWidgetHistory({ sourceKey: 's', revision: 'r2', fetchHistory: failing, now: 1, minIntervalMs: 0 });
  assert.equal(failures, 1, 'a zero freshness floor must not let a failing source spin');
});

test('a changed source drops the cache rather than serving another hub history', async () => {
  let calls = 0;
  const fetchHistory = () => { calls += 1; return history(`call-${calls}`); };
  const minIntervalMs = 60_000;

  await resolveMacWidgetHistory({ sourceKey: 'hub-a', revision: 'r1', fetchHistory, now: 0, minIntervalMs });
  const switched = await resolveMacWidgetHistory({
    sourceKey: 'hub-b', revision: 'r1', fetchHistory, now: 1, minIntervalMs
  });

  assert.equal(calls, 2, 'the time floor must not survive a source change');
  assert.equal(switched.summary.label, 'call-2');
});

test('concurrent pushes for the same revision share one request', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchHistory = async () => { calls += 1; await gate; return history('shared'); };

  const pending = [
    resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory, now: 0 }),
    resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory, now: 1 }),
    resolveMacWidgetHistory({ sourceKey: 's', revision: 'r1', fetchHistory, now: 2 })
  ];
  release();
  const results = await Promise.all(pending);

  assert.equal(calls, 1);
  for (const result of results) assert.equal(result.summary.label, 'shared');
});

test('the default floor is long enough to matter on a busy hub', () => {
  assert.ok(DEFAULT_MIN_INTERVAL_MS >= 60_000);
});

// The widget derives its throttling policy from this classifier, so a drift
// between it and resolveCompleteHistory's branches would silently either
// throttle a free read or hammer a remote one.
test('the history source classifier matches what the resolver actually does', () => {
  const { completeHistorySource } = require('../../src/electron/historySource');
  assert.equal(completeHistorySource({ mode: 'local' }), 'local');
  assert.equal(completeHistorySource({ mode: 'sync', hubMode: 'host', embeddedHub: {} }), 'embedded');
  assert.equal(completeHistorySource({ mode: 'sync', hubMode: 'client', hubUrl: 'http://hub' }), 'remote');
  assert.equal(completeHistorySource({ mode: 'sync', hubMode: 'client' }), 'empty');
  assert.equal(completeHistorySource({ mode: 'local', historyEnabled: false }), 'empty');
  // A host that never managed to start its embedded hub still has to fetch.
  assert.equal(completeHistorySource({ mode: 'sync', hubMode: 'host', hubUrl: 'http://hub' }), 'remote');
});
