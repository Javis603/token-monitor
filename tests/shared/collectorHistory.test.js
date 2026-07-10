'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  localTodayKey, collectHistoryOnce, collectUsageOnce, shouldIncludeHistory
} = require('../../src/shared/collector');

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

test('collectHistoryOnce normalizes injected graph JSON into a History', async () => {
  const history = await collectHistoryOnce({
    clients: 'claude', todayKey: '2026-06-07',
    runGraph: async () => SAMPLE_GRAPH
  });
  assert.equal(history.daily.length, 1);
  assert.equal(history.daily[0].tokens, 30);
  assert.equal(history.summary.totalTokens, 30);
});

test('collectHistoryOnce returns null when the graph run throws', async () => {
  const history = await collectHistoryOnce({
    clients: 'claude', todayKey: '2026-06-07',
    runGraph: async () => { throw new Error('boom'); }
  });
  assert.equal(history, null);
});

test('collectHistoryOnce returns null when there are no clients', async () => {
  let called = false;
  const history = await collectHistoryOnce({ clients: '', runGraph: async () => { called = true; return SAMPLE_GRAPH; } });
  assert.equal(history, null);
  assert.equal(called, false);
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
  assert.equal(summary.history, null);
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
