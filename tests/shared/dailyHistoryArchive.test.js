'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  captureDailyHistoryArchive,
  clearDailyHistoryArchive,
  graphFromDailyHistoryArchive,
  normalizeDailyHistoryArchive,
  retainDailyHistory
} = require('../../src/shared/dailyHistoryArchive');
const { normalizeHistory, parseGraphResult } = require('../../src/shared/history');

function graph(date, clients, extra = {}) {
  return {
    contributions: [{ date, activeTimeMs: extra.activeTimeMs || 0, clients }],
    ...(extra.timeMetrics ? { timeMetrics: extra.timeMetrics } : {})
  };
}

function client(clientId, modelId, tokens, cost, messages, extra = {}) {
  return {
    client: clientId,
    modelId,
    ...(extra.providerId ? { providerId: extra.providerId } : {}),
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: extra.reasoning || 0 },
    cost,
    messages
  };
}

function historyFrom(graphValue, todayKey = '2026-07-18') {
  return normalizeHistory(parseGraphResult(graphValue), { todayKey, capDays: 370 });
}

test('normalizeDailyHistoryArchive rejects malformed days and observations', () => {
  assert.deepEqual(normalizeDailyHistoryArchive({ days: { nope: {}, '2026-07-18': { observations: [{}] } } }), {
    version: 1,
    days: {}
  });
});

test('capture preserves a larger prior observation as one coherent record', () => {
  const first = captureDailyHistoryArchive({}, graph('2026-07-17', [
    client('claude', 'opus', 100, 4, 5, { providerId: 'anthropic', reasoning: 7 })
  ]), { todayKey: '2026-07-18' });
  const next = captureDailyHistoryArchive(first, graph('2026-07-17', [
    client('claude', 'opus', 40, 99, 2, { providerId: 'wrong', reasoning: 1 })
  ]), { todayKey: '2026-07-18' });
  const [stored] = Object.values(next.days['2026-07-17'].observations);
  assert.deepEqual(stored, {
    client: 'claude', modelId: 'opus', providerId: 'anthropic',
    tokens: 100, cost: 4, messages: 5, reasoningTokens: 7
  });
});

test('capture updates identities independently without synthesizing token and cost fields', () => {
  const first = captureDailyHistoryArchive({}, graph('2026-07-17', [
    client('claude', 'opus', 100, 4, 5),
    client('codex', 'gpt', 50, 2, 3)
  ]), { todayKey: '2026-07-18' });
  const next = captureDailyHistoryArchive(first, graph('2026-07-17', [
    client('codex', 'gpt', 60, 2.5, 4)
  ]), { todayKey: '2026-07-18' });
  const restored = historyFrom(graphFromDailyHistoryArchive([], next, { todayKey: '2026-07-18' }));
  assert.equal(restored.daily[0].tokens, 160);
  assert.deepEqual(restored.daily[0].perClient.claude, { tokens: 100, cost: 4, messages: 5 });
  assert.deepEqual(restored.daily[0].perClient.codex, { tokens: 60, cost: 2.5, messages: 4 });
});

test('capture replaces the whole observation when usage grows and refreshes equal-usage pricing', () => {
  const first = captureDailyHistoryArchive({}, graph('2026-07-17', [
    client('claude', 'opus', 100, 4, 5)
  ]), { todayKey: '2026-07-18' });
  const grown = captureDailyHistoryArchive(first, graph('2026-07-17', [
    client('claude', 'opus', 120, 4.8, 6)
  ]), { todayKey: '2026-07-18' });
  const repriced = captureDailyHistoryArchive(grown, graph('2026-07-17', [
    client('claude', 'opus', 120, 5.2, 6)
  ]), { todayKey: '2026-07-18' });
  const [stored] = Object.values(repriced.days['2026-07-17'].observations);
  assert.deepEqual(stored, { client: 'claude', modelId: 'opus', tokens: 120, cost: 5.2, messages: 6 });
});

test('capture keeps all observed past days beyond the presentation window', () => {
  const archive = captureDailyHistoryArchive({}, [
    graph('2024-01-01', [client('claude', 'opus', 10, 1, 1)]),
    graph('2026-07-17', [client('claude', 'opus', 20, 2, 2)]),
    graph('2026-07-18', [client('claude', 'opus', 30, 3, 3)]),
    graph('2026-07-19', [client('claude', 'opus', 40, 4, 4)])
  ], { todayKey: '2026-07-18', capDays: 2 });
  assert.deepEqual(Object.keys(archive.days).sort(), ['2024-01-01', '2026-07-17', '2026-07-18']);
});

test('graph reconstruction exposes the rolling daily window but keeps older rollups', () => {
  const archive = captureDailyHistoryArchive({}, [
    graph('2025-06-01', [client('codex', 'gpt', 25, 1, 2)]),
    graph('2026-07-18', [client('claude', 'opus', 100, 4, 5)])
  ], { todayKey: '2026-07-18' });
  const combined = graphFromDailyHistoryArchive([], archive, { todayKey: '2026-07-18' });
  const normalized = historyFrom(combined);
  assert.deepEqual(normalized.daily.map((day) => day.date), ['2026-07-18']);
  assert.deepEqual(normalized.monthly.map((month) => month.month), ['2025-06', '2026-07']);
  assert.equal(normalized.summary.totalTokens, 125);
});

test('retainDailyHistory persists only changes and can serve the archive when a scan is empty', () => {
  let stored = {};
  let writes = 0;
  const options = {
    todayKey: '2026-07-18',
    readJson: () => stored,
    writeJsonAtomic: (_path, value) => { stored = value; writes += 1; }
  };
  retainDailyHistory(graph('2026-07-17', [client('claude', 'opus', 100, 4, 5)]), options);
  retainDailyHistory(graph('2026-07-17', [client('claude', 'opus', 100, 4, 5)]), options);
  const restored = historyFrom(retainDailyHistory([], options));
  assert.equal(writes, 1);
  assert.equal(restored.daily[0].tokens, 100);
});

test('widget stays read-only while a headless agent owns the shared archive', () => {
  let stored = {};
  let writes = 0;
  const storage = {
    todayKey: '2026-07-18',
    readJson: () => stored,
    writeJsonAtomic: (_path, value) => { stored = value; writes += 1; }
  };

  retainDailyHistory(graph('2026-07-17', [
    client('claude', 'opus', 100, 4, 5)
  ]), { ...storage, writeEnabled: true });

  const widgetGraph = retainDailyHistory(graph('2026-07-17', [
    client('codex', 'gpt', 50, 2, 3)
  ]), { ...storage, writeEnabled: () => false });
  const widgetHistory = historyFrom(widgetGraph);

  assert.equal(writes, 1);
  assert.deepEqual(Object.values(stored.days['2026-07-17'].observations).map((item) => item.client), ['claude']);
  assert.equal(widgetHistory.daily[0].tokens, 150);

  retainDailyHistory(graph('2026-07-17', [
    client('claude', 'opus', 100, 4, 5),
    client('codex', 'gpt', 50, 2, 3)
  ]), { ...storage, writeEnabled: true });

  assert.equal(writes, 2);
  assert.deepEqual(
    Object.values(stored.days['2026-07-17'].observations).map((item) => item.client).sort(),
    ['claude', 'codex']
  );
});

test('lazy write ownership is checked after the archive read', () => {
  let canWrite = true;
  let writes = 0;
  retainDailyHistory(graph('2026-07-17', [client('claude', 'opus', 100, 4, 5)]), {
    todayKey: '2026-07-18',
    readJson: () => { canWrite = false; return {}; },
    writeJsonAtomic: () => { writes += 1; },
    writeEnabled: () => canWrite
  });
  assert.equal(writes, 0);
});

test('durable reconstruction never adds reasoning on top of output tokens', () => {
  const archive = captureDailyHistoryArchive({}, graph('2026-07-18', [
    client('codex', 'gpt', 100, 1, 1, { reasoning: 30 })
  ]), { todayKey: '2026-07-18' });
  const restored = historyFrom(graphFromDailyHistoryArchive([], archive, { todayKey: '2026-07-18' }));
  assert.equal(restored.daily[0].tokens, 100);
});

test('clearDailyHistoryArchive removes persisted data and accepts a missing file', () => {
  let calls = 0;
  assert.equal(clearDailyHistoryArchive({ unlinkSync: () => { calls += 1; } }), true);
  assert.equal(calls, 1);
  assert.equal(clearDailyHistoryArchive({ unlinkSync: () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  } }), false);
});
