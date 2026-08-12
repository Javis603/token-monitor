'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  localTodayKey, collectHistoryOnce, collectUsageOnce, shouldIncludeHistory, startCollector
} = require('../../src/shared/collector');

function waitForCondition(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for collector update'));
      }
    }, 5);
  });
}

test('localTodayKey returns a YYYY-MM-DD string for the given date', () => {
  const key = localTodayKey(new Date(2026, 5, 7, 15, 30)); // local June 7 2026
  assert.equal(key, '2026-06-07');
  assert.match(localTodayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

const SAMPLE_GRAPH = {
  contributions: [
    { date: '2026-06-07', clients: [
      { client: 'claude', modelId: 'opus', tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 1, messages: 2 }
    ] }
  ]
};

function usageSnapshot(totalTokens) {
  return {
    entries: [{
      client: 'claude',
      modelId: 'opus',
      input: totalTokens,
      cost: 0,
      messages: 1
    }]
  };
}

test('collectHistoryOnce normalizes injected graph JSON into a History', async () => {
  const statuses = [];
  const history = await collectHistoryOnce({
    clients: 'claude', todayKey: '2026-06-07', onHistoryStatus: (status) => statuses.push(status),
    runGraph: async () => SAMPLE_GRAPH
  });
  assert.equal(history.daily.length, 1);
  assert.equal(history.daily[0].tokens, 30);
  assert.equal(history.summary.totalTokens, 30);
  assert.equal(statuses.length, 1);
  assert.ok(statuses[0].attemptedAt);
  assert.ok(statuses[0].successAt);
  assert.equal(statuses[0].failureCode, null);
  assert.ok(statuses[0].durationMs >= 0);
});

test('collectHistoryOnce returns null when the graph run throws', async () => {
  const statuses = [];
  const history = await collectHistoryOnce({
    clients: 'claude', todayKey: '2026-06-07',
    onHistoryStatus: (status) => statuses.push(status),
    runGraph: async () => { throw new Error('boom'); }
  });
  assert.equal(history, null);
  assert.deepEqual(statuses.map(({ failureCode, successAt }) => ({ failureCode, successAt })), [
    { failureCode: 'history-graph-failed', successAt: null }
  ]);
});

test('collector preserves the last successful history timestamp after a failed refresh', async () => {
  let graphCalls = 0;
  const updates = [];
  const runtime = startCollector({
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'history-diagnostics',
    intervalMs: 60 * 60 * 1000,
    watchEnabled: false,
    watchTriggersCollection: false,
    historyEnabled: true,
    dailyHistoryArchiveEnabled: false,
    anchorPersistenceEnabled: false,
    runTokscale: async () => ({ entries: [] }),
    runGraph: async () => {
      graphCalls += 1;
      if (graphCalls === 1) return SAMPLE_GRAPH;
      throw new Error('history unavailable');
    },
    onUpdate: (summary, reason) => updates.push({ summary, reason })
  });

  try {
    await waitForCondition(() => updates.length >= 1);
    const firstDiagnostics = runtime.getDiagnostics();
    assert.ok(firstDiagnostics.lastHistorySuccessAt);
    const previousSuccessAt = firstDiagnostics.lastHistorySuccessAt;

    await runtime.tick('manual', { forceHistory: true });

    const afterFailure = runtime.getDiagnostics();
    assert.equal(afterFailure.lastHistorySuccessAt, previousSuccessAt);
    assert.equal(afterFailure.lastHistoryFailureCode, 'history-graph-failed');
  } finally {
    runtime.stop();
  }
});

test('startCollector finalizes history on local day rollover before the interval is due', async () => {
  let nowMs = new Date(2026, 7, 11, 23, 45).getTime();
  const initialDay = localTodayKey(new Date(nowMs));
  const graphDays = [];
  const updates = [];
  const runtime = startCollector({
    clients: 'claude',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'history-rollover',
    intervalMs: 60 * 60 * 1000,
    historyIntervalMs: 60 * 60 * 1000,
    watchEnabled: false,
    watchTriggersCollection: false,
    historyEnabled: true,
    dailyHistoryArchiveEnabled: false,
    anchorPersistenceEnabled: false,
    wslScanEnabled: false,
    now: () => nowMs,
    runTokscale: async () => usageSnapshot(100),
    runGraph: async () => {
      const day = localTodayKey(new Date(nowMs));
      graphDays.push(day);
      return { contributions: [{ date: day, clients: [
        { client: 'claude', modelId: 'opus', tokens: { input: 100 }, cost: 0, messages: 1 }
      ] }] };
    },
    onUpdate: (summary, reason) => updates.push({ summary, reason })
  });

  try {
    await waitForCondition(() => updates.length >= 1);
    nowMs += 16 * 60 * 1000;
    const nextDay = localTodayKey(new Date(nowMs));
    assert.notEqual(nextDay, initialDay);

    await runtime.tick('interval');

    assert.deepEqual(graphDays, [initialDay, nextDay]);
  } finally {
    runtime.stop();
  }
});

test('startCollector retries a failed rollover History scan once', async () => {
  let nowMs = new Date(2026, 7, 11, 23, 45).getTime();
  let graphCalls = 0;
  const updates = [];
  const runtime = startCollector({
    clients: 'claude',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'history-rollover-retry',
    intervalMs: 60 * 60 * 1000,
    historyIntervalMs: 60 * 60 * 1000,
    historyRetryMs: 10,
    watchEnabled: false,
    watchTriggersCollection: false,
    historyEnabled: true,
    dailyHistoryArchiveEnabled: false,
    anchorPersistenceEnabled: false,
    wslScanEnabled: false,
    now: () => nowMs,
    runTokscale: async () => usageSnapshot(100),
    runGraph: async () => {
      graphCalls += 1;
      if (graphCalls === 2) throw new Error('temporary rollover failure');
      const date = localTodayKey(new Date(nowMs));
      return { contributions: [{ date, clients: [
        { client: 'claude', modelId: 'opus', tokens: { input: 100 }, cost: 0, messages: 1 }
      ] }] };
    },
    onUpdate: (summary, reason) => updates.push({ summary, reason })
  });

  try {
    await waitForCondition(() => updates.length >= 1);
    nowMs += 16 * 60 * 1000;

    await runtime.tick('interval');
    assert.equal(graphCalls, 2);
    assert.equal(runtime.getDiagnostics().lastHistoryFailureCode, 'history-graph-failed');

    await waitForCondition(() => graphCalls >= 3);
    await waitForCondition(() => updates.at(-1)?.reason === 'history-rollover-retry');
    assert.equal(runtime.getDiagnostics().lastHistoryFailureCode, null);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(graphCalls, 3);
  } finally {
    runtime.stop();
  }
});

test('a coalesced rollover retry keeps its one-attempt marker', async () => {
  let nowMs = new Date(2026, 7, 11, 23, 45).getTime();
  let graphCalls = 0;
  let blockNextTokscale = false;
  let tokscaleBlocked = false;
  let releaseBlockedTokscale = null;
  const updates = [];
  const runtime = startCollector({
    clients: 'claude',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'history-rollover-coalesced-retry',
    intervalMs: 60 * 60 * 1000,
    historyIntervalMs: 60 * 60 * 1000,
    historyRetryMs: 10,
    watchEnabled: false,
    watchTriggersCollection: false,
    historyEnabled: true,
    dailyHistoryArchiveEnabled: false,
    anchorPersistenceEnabled: false,
    wslScanEnabled: false,
    now: () => nowMs,
    runTokscale: async () => {
      if (blockNextTokscale) {
        blockNextTokscale = false;
        tokscaleBlocked = true;
        await new Promise((resolve) => { releaseBlockedTokscale = resolve; });
      }
      return usageSnapshot(100);
    },
    runGraph: async () => {
      graphCalls += 1;
      if (graphCalls >= 2) throw new Error('rollover History remains unavailable');
      const date = localTodayKey(new Date(nowMs));
      return { contributions: [{ date, clients: [
        { client: 'claude', modelId: 'opus', tokens: { input: 100 }, cost: 0, messages: 1 }
      ] }] };
    },
    onUpdate: (summary, reason) => updates.push({ summary, reason })
  });

  try {
    await waitForCondition(() => updates.length >= 1);
    nowMs += 16 * 60 * 1000;

    await runtime.tick('interval');
    assert.equal(graphCalls, 2);

    blockNextTokscale = true;
    const inFlight = runtime.tick('manual');
    await waitForCondition(() => tokscaleBlocked);
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseBlockedTokscale();
    releaseBlockedTokscale = null;
    await inFlight;
    await waitForCondition(() => graphCalls >= 3);

    assert.equal(graphCalls, 3);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(graphCalls, 3);
  } finally {
    if (releaseBlockedTokscale) releaseBlockedTokscale();
    runtime.stop();
  }
});

test('collectHistoryOnce returns null when there are no clients', async () => {
  let called = false;
  const history = await collectHistoryOnce({ clients: '', runGraph: async () => { called = true; return SAMPLE_GRAPH; } });
  assert.equal(history, null);
  assert.equal(called, false);
});

test('collectHistoryOnce retains a prior client observation when a later graph loses it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-daily-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archivePath = path.join(dir, 'daily-history.json');
  const options = {
    clients: 'claude,codex',
    todayKey: '2026-06-07',
    dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveOptions: { path: archivePath }
  };
  await collectHistoryOnce({
    ...options,
    runGraph: async () => ({ contributions: [{ date: '2026-06-06', clients: [
      { client: 'claude', modelId: 'opus', tokens: { input: 100 }, cost: 4, messages: 5 },
      { client: 'codex', modelId: 'gpt', tokens: { input: 50 }, cost: 2, messages: 3 }
    ] }] })
  });
  const restored = await collectHistoryOnce({
    ...options,
    runGraph: async () => ({ contributions: [{ date: '2026-06-06', clients: [
      { client: 'codex', modelId: 'gpt', tokens: { input: 60 }, cost: 2.5, messages: 4 }
    ] }] })
  });
  assert.equal(restored.daily[0].tokens, 160);
  assert.equal(restored.daily[0].perClient.claude.tokens, 100);
  assert.equal(restored.daily[0].perClient.codex.tokens, 60);
});

test('collectHistoryOnce stores older days locally while capping daily output', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-full-daily-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archivePath = path.join(dir, 'daily-history.json');
  const history = await collectHistoryOnce({
    clients: 'claude',
    todayKey: '2026-07-18',
    capDays: 370,
    dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveOptions: { path: archivePath },
    runGraph: async () => ({ contributions: [
      { date: '2025-06-01', clients: [
        { client: 'claude', modelId: 'opus', tokens: { input: 25 }, cost: 1, messages: 2 }
      ] },
      { date: '2026-07-17', clients: [
        { client: 'claude', modelId: 'opus', tokens: { input: 100 }, cost: 4, messages: 5 }
      ] }
    ] })
  });
  const stored = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  assert.deepEqual(Object.keys(stored.days).sort(), ['2025-06-01', '2026-07-17']);
  assert.deepEqual(history.daily.map((day) => day.date), ['2026-07-17']);
  assert.deepEqual(history.monthly.map((month) => month.month), ['2025-06', '2026-07']);
  assert.equal(history.summary.totalTokens, 125);
});

test('collectUsageOnce hands the live day total to history across local rollover', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-live-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archivePath = path.join(dir, 'daily-history.json');
  const common = {
    clients: 'claude',
    allTimeSince: '2026-01-01',
    deviceId: 'live-handoff',
    includeHistory: true,
    historyEnabled: true,
    dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveWriteEnabled: true,
    dailyHistoryArchiveOptions: { path: archivePath },
    projectsEnabled: false,
    limitsEnabled: false,
    wslScanEnabled: false,
    runGraph: async () => ({ contributions: [{ date: '2026-08-05', clients: [
      { client: 'claude', modelId: 'opus', tokens: { input: 507_800_000 }, cost: 0, messages: 1 }
    ] }] })
  };
  const collect = (now, todayTotal) => collectUsageOnce({
    ...common,
    now,
    runTokscale: async () => usageSnapshot(todayTotal)
  });

  const beforeRollover = await collect(new Date(2026, 7, 5, 23, 55), 645_957_554);
  assert.equal(beforeRollover.today.totalTokens, 645_957_554);
  assert.equal(beforeRollover.history.daily[0].tokens, 645_957_554);

  const afterRollover = await collect(new Date(2026, 7, 6, 0, 5), 11_751_310);
  const previousDay = afterRollover.history.daily.find((day) => day.date === '2026-08-05');
  const currentDay = afterRollover.history.daily.find((day) => day.date === '2026-08-06');
  assert.equal(previousDay.tokens, 645_957_554);
  assert.equal(currentDay.tokens, 11_751_310);
});

test('collectUsageOnce uses the live history snapshot while archive ownership is read-only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-read-only-live-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archivePath = path.join(dir, 'daily-history.json');
  const result = await collectUsageOnce({
    clients: 'claude',
    allTimeSince: '2026-01-01',
    deviceId: 'read-only-live-history',
    now: new Date(2026, 7, 5, 12),
    includeHistory: true,
    historyEnabled: true,
    dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveWriteEnabled: false,
    dailyHistoryArchiveOptions: { path: archivePath },
    projectsEnabled: false,
    limitsEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => usageSnapshot(645_957_554),
    runGraph: async () => ({ contributions: [{ date: '2026-08-05', clients: [
      { client: 'claude', modelId: 'opus', tokens: { input: 507_800_000 }, cost: 0, messages: 1 }
    ] }] })
  });

  assert.equal(result.history.daily[0].tokens, 645_957_554);
  assert.equal(fs.existsSync(archivePath), false);
});

test('startCollector retains a transformed watch total until the next history tick', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-live-history-ticks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archivePath = path.join(dir, 'daily-history.json');
  const todayKey = localTodayKey();
  const updates = [];
  const runtime = startCollector({
    clients: 'claude',
    allTimeSince: '2026-01-01',
    deviceId: 'live-history-ticks',
    intervalMs: 60 * 60 * 1000,
    historyIntervalMs: 15 * 60 * 1000,
    watchEnabled: false,
    watchTriggersCollection: false,
    historyEnabled: true,
    dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveWriteEnabled: true,
    dailyHistoryArchiveOptions: { path: archivePath },
    projectsEnabled: false,
    limitsEnabled: false,
    wslScanEnabled: false,
    anchorPersistenceEnabled: false,
    runTokscale: async () => usageSnapshot(100),
    runGraph: async () => ({ contributions: [{ date: todayKey, clients: [
      { client: 'claude', modelId: 'opus', tokens: { input: 90 }, cost: 0, messages: 1 }
    ] }] }),
    onUpdate: (summary, reason) => {
      const visibleTotal = reason === 'watch' ? 300 : 200;
      const visible = {
        ...summary,
        today: { ...summary.today, totalTokens: visibleTotal }
      };
      updates.push({ reason, summary: visible });
      return visible;
    }
  });

  try {
    await waitForCondition(() => updates.length >= 1);
    await runtime.tick('watch', { todayOnly: true });
    await runtime.tick('manual', { forceHistory: true });

    const latest = updates.at(-1).summary;
    assert.equal(latest.history.daily.find((day) => day.date === todayKey).tokens, 300);
    const stored = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    assert.equal(
      Object.values(stored.liveDays[todayKey].observations).reduce((sum, item) => sum + item.tokens, 0),
      300
    );
  } finally {
    runtime.stop();
  }
});

test('collectHistoryOnce falls back to the current graph when archive persistence fails', async () => {
  const messages = [];
  const history = await collectHistoryOnce({
    clients: 'claude',
    todayKey: '2026-06-07',
    dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveOptions: {
      readJson: () => ({}),
      writeJsonAtomic: () => { throw new Error('disk full'); }
    },
    logger: (message) => messages.push(message),
    runGraph: async () => SAMPLE_GRAPH
  });
  assert.equal(history.daily[0].tokens, 30);
  assert.match(messages.at(-1), /daily history archive failed: disk full/);
});

test('collectHistoryOnce preserves a lazy archive ownership guard until write time', async () => {
  let canWrite = true;
  let writes = 0;
  const history = await collectHistoryOnce({
    clients: 'claude',
    todayKey: '2026-06-07',
    dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveWriteEnabled: () => canWrite,
    dailyHistoryArchiveOptions: {
      readJson: () => { canWrite = false; return {}; },
      writeJsonAtomic: () => { writes += 1; }
    },
    runGraph: async () => SAMPLE_GRAPH
  });
  assert.equal(writes, 0);
  assert.equal(history.daily[0].tokens, 30);
});

test('collectHistoryOnce merges Proma history with tokscale graph history', async () => {
  const promaGraph = {
    contributions: [{ date: '2026-06-07', clients: [
      { client: 'proma', modelId: 'gpt-5', tokens: { input: 5, output: 5 }, cost: 0, messages: 1 }
    ] }]
  };
  const history = await collectHistoryOnce({
    clients: 'claude', promaGraph, todayKey: '2026-06-07', runGraph: async () => SAMPLE_GRAPH
  });
  assert.equal(history.daily[0].tokens, 40);
  assert.equal(history.daily[0].perClient.proma.tokens, 10);
  assert.equal(history.daily[0].perModel['gpt-5'].tokens, 10);
});

test('collectHistoryOnce builds Proma-only history without starting tokscale graph', async () => {
  let graphCalled = false;
  const history = await collectHistoryOnce({
    clients: '',
    promaGraph: { contributions: [{ date: '2026-06-07', clients: [
      { client: 'proma', modelId: 'gpt-5', tokens: { input: 8 }, cost: 0, messages: 1 }
    ] }] },
    todayKey: '2026-06-07',
    runGraph: async () => { graphCalled = true; return SAMPLE_GRAPH; }
  });
  assert.equal(graphCalled, false);
  assert.equal(history.summary.totalTokens, 8);
  assert.equal(history.daily[0].perClient.proma.messages, 1);
});

test('collectHistoryOnce skips graph collection when history is disabled', async () => {
  let graphCalled = false;
  const history = await collectHistoryOnce({
    clients: 'claude',
    historyEnabled: false,
    runGraph: async () => { graphCalled = true; return SAMPLE_GRAPH; }
  });
  assert.equal(graphCalled, false);
  assert.equal(history, null);
});

test('collectUsageOnce sends explicit null history when history collection is disabled', async () => {
  const summary = await collectUsageOnce({
    clients: '',
    deviceId: 'device-a',
    historyEnabled: false,
    limitsEnabled: false
  });
  assert.equal(summary.historyAvailable, false);
  assert.equal(summary.history, null);
});

test('collectUsageOnce omits history entirely on a non-history tick', async () => {
  const summary = await collectUsageOnce({
    clients: '',
    deviceId: 'device-a',
    historyEnabled: true,
    includeHistory: false,
    limitsEnabled: false
  });
  assert.equal(summary.historyAvailable, true);
  assert.equal(Object.hasOwn(summary, 'history'), false);
});

test('collectUsageOnce includes Proma history without starting tokscale graph', async () => {
  const promaPath = require.resolve('../../src/shared/promaUsage');
  const collectorPath = require.resolve('../../src/shared/collector');
  const promaUsage = require(promaPath);
  const originalRows = promaUsage.collectPromaRows;
  const originalPeriods = promaUsage.buildPromaPeriods;
  const originalHistory = promaUsage.buildPromaHistoryGraph;
  promaUsage.collectPromaRows = () => [{ model: 'gpt-5', input: 8, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: Date.parse('2026-06-07T12:00:00.000Z') }];
  promaUsage.buildPromaPeriods = () => ({ today: { entries: [] }, month: { entries: [] }, allTime: { entries: [] } });
  promaUsage.buildPromaHistoryGraph = () => ({ contributions: [{ date: '2026-06-07', clients: [
    { client: 'proma', modelId: 'gpt-5', tokens: { input: 8 }, cost: 0, messages: 1 }
  ] }] });
  delete require.cache[collectorPath];
  try {
    const { collectUsageOnce: collectPromaUsageOnce } = require(collectorPath);
    const summary = await collectPromaUsageOnce({
      clients: 'proma', allTimeSince: '2026-01-01', deviceId: 'proma-only',
      includeHistory: true, limitsEnabled: false,
      lookupModelPricing: async () => null,
      runGraph: async () => { throw new Error('tokscale graph must not run for Proma-only tracking'); }
    });
    assert.equal(summary.history.summary.totalTokens, 8);
    assert.equal(summary.history.daily[0].perClient.proma.messages, 1);
  } finally {
    promaUsage.collectPromaRows = originalRows;
    promaUsage.buildPromaPeriods = originalPeriods;
    promaUsage.buildPromaHistoryGraph = originalHistory;
    delete require.cache[collectorPath];
  }
});

test('shouldIncludeHistory: first call, throttle window, and force', () => {
  const INT = 15 * 60 * 1000;
  const NOW = 1_000_000_000_000;                                        // realistic epoch ms
  assert.equal(shouldIncludeHistory(NOW, 0, INT, false), true);          // first call: lastAt 0, huge elapsed
  assert.equal(shouldIncludeHistory(NOW, NOW - 900, INT, false), false); // 900ms ago, within window
  assert.equal(shouldIncludeHistory(NOW, NOW - INT, INT, false), true);  // exactly the window elapsed
  assert.equal(shouldIncludeHistory(NOW, NOW - 900, INT, true), true);   // forced
});

test('shouldIncludeHistory returns false when history collection is disabled', () => {
  assert.equal(shouldIncludeHistory(1_000_000_000_000, 0, 0, true, false), false);
});
