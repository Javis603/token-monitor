'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  captureDailyHistoryArchive,
  captureLiveDailyHistory,
  clearDailyHistoryArchive,
  graphFromDailyHistoryArchive,
  normalizeDailyHistoryArchive,
  retainDailyHistory,
  retainLiveDailyHistory
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

function livePeriod(totalTokens, costUsd = 0) {
  return {
    totalTokens,
    costUsd,
    clients: { claude: totalTokens },
    clientCosts: { claude: costUsd },
    models: { opus: totalTokens },
    modelCosts: { opus: costUsd },
    clientModels: { claude: { opus: totalTokens } },
    clientModelCosts: { claude: { opus: costUsd } }
  };
}

test('normalizeDailyHistoryArchive rejects malformed days and observations', () => {
  assert.deepEqual(normalizeDailyHistoryArchive({ days: { nope: {}, '2026-07-18': { observations: [{}] } } }), {
    version: 2,
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
    tokens: 100, cost: 4, messages: 5,
    tokenComponents: true, inputTokens: 100, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 7
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
  assert.deepEqual(restored.daily[0].perClient.claude, {
    tokens: 100, cost: 4, messages: 5,
    cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unclassifiedTokens: 0
  });
  assert.deepEqual(restored.daily[0].perClient.codex, {
    tokens: 60, cost: 2.5, messages: 4,
    cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unclassifiedTokens: 0
  });
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
  assert.deepEqual(stored, {
    client: 'claude', modelId: 'opus', tokens: 120, cost: 5.2, messages: 6,
    tokenComponents: true, inputTokens: 120, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0
  });
});

test('capture keeps a larger legacy total while adopting the fresh component subset', () => {
  const legacy = normalizeDailyHistoryArchive({
    version: 1,
    days: {
      '2026-07-17': {
        date: '2026-07-17',
        observations: [{ client: 'claude', modelId: 'opus', tokens: 100, cost: 4, messages: 5 }]
      }
    }
  });
  const next = captureDailyHistoryArchive(legacy, graph('2026-07-17', [{
    client: 'claude', modelId: 'opus',
    tokens: { input: 10, output: 20, cacheRead: 50, cacheWrite: 10 },
    cost: 3.5, messages: 5
  }]), { todayKey: '2026-07-18' });
  const [stored] = Object.values(next.days['2026-07-17'].observations);
  const history = historyFrom(graphFromDailyHistoryArchive([], next, { todayKey: '2026-07-18' }));

  assert.equal(stored.tokens, 100);
  assert.equal(stored.cost, 4);
  assert.equal(stored.cacheReadTokens, 50);
  assert.equal(stored.outputTokens, 20);
  assert.equal(stored.unclassifiedTokens, 10);
  assert.equal(history.daily[0].tokens, 100);
  assert.equal(history.daily[0].cacheReadTokens, 50);
  assert.equal(history.daily[0].unclassifiedTokens, 10);
  assert.equal(history.daily[0].capabilities.tokenComponents, false);
});

test('Reasonix v1 enrichment counts additive reasoning exactly once', () => {
  const legacy = normalizeDailyHistoryArchive({
    version: 1,
    days: {
      '2026-07-17': {
        date: '2026-07-17',
        observations: [{
          client: 'reasonix', modelId: 'reasonix-model', tokens: 130,
          cost: 1, messages: 0, reasoningTokens: 30
        }]
      }
    }
  });
  const next = captureDailyHistoryArchive(legacy, graph('2026-07-17', [{
    client: 'reasonix', modelId: 'reasonix-model',
    tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 30 },
    cost: 1, messages: 0
  }]), { todayKey: '2026-07-18' });
  const [stored] = Object.values(next.days['2026-07-17'].observations);
  const history = historyFrom(graphFromDailyHistoryArchive([], next, { todayKey: '2026-07-18' }));

  assert.equal(stored.tokens, 130);
  assert.equal(stored.reasoningTokens, 30);
  assert.equal(stored.unclassifiedTokens, undefined);
  assert.equal(history.daily[0].tokens, 130);
  assert.equal(history.daily[0].unclassifiedTokens, 0);
});

test('archive v2 preserves token components while legacy rows stay explicitly incomplete', () => {
  const exact = captureDailyHistoryArchive({}, graph('2026-07-17', [{
    client: 'claude', modelId: 'opus',
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5 },
    cost: 1, messages: 2
  }]), { todayKey: '2026-07-18' });
  const exactGraph = graphFromDailyHistoryArchive([], exact, { todayKey: '2026-07-18' });
  const exactHistory = historyFrom(exactGraph);
  assert.equal(exactGraph.capabilities.tokenComponents, true);
  assert.equal(exactHistory.daily[0].cacheReadTokens, 30);
  assert.equal(exactHistory.daily[0].cacheWriteTokens, 40);
  assert.equal(exactHistory.daily[0].outputTokens, 20);

  const legacy = normalizeDailyHistoryArchive({
    version: 1,
    days: {
      '2026-07-16': {
        date: '2026-07-16',
        observations: [{ client: 'codex', modelId: 'gpt', tokens: 50, cost: 2, messages: 1 }]
      }
    }
  });
  const legacyGraph = graphFromDailyHistoryArchive([], legacy, { todayKey: '2026-07-18' });
  const legacyHistory = historyFrom(legacyGraph);
  assert.equal(legacy.version, 2);
  assert.equal(legacyGraph.capabilities.tokenComponents, false);
  assert.equal(legacyHistory.capabilities.tokenComponents, false);
  assert.equal(legacyHistory.daily[0].tokens, 50);
});

test('legacy days do not erase exact capabilities from unrelated v2 days', () => {
  const archive = normalizeDailyHistoryArchive({
    version: 1,
    days: {
      '2026-07-16': {
        date: '2026-07-16',
        observations: [{ client: 'codex', modelId: 'gpt', tokens: 50, cost: 2, messages: 1 }]
      }
    }
  });
  const mixed = captureDailyHistoryArchive(archive, graph('2026-07-17', [{
    client: 'claude', modelId: 'opus',
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    cost: 1, messages: 2
  }]), { todayKey: '2026-07-18' });
  const mixedGraph = graphFromDailyHistoryArchive([], mixed, { todayKey: '2026-07-18' });
  const history = historyFrom(mixedGraph);

  assert.equal(mixedGraph.capabilities.tokenComponents, false);
  assert.equal(history.daily.find((day) => day.date === '2026-07-16').capabilities.tokenComponents, false);
  assert.equal(history.daily.find((day) => day.date === '2026-07-17').capabilities.tokenComponents, true);
});

test('legacy message-only observations do not make token components unavailable', () => {
  const archive = normalizeDailyHistoryArchive({
    version: 1,
    days: {
      '2026-07-17': {
        date: '2026-07-17',
        observations: [{ client: 'claude', modelId: '<synthetic>', tokens: 0, cost: 0, messages: 2 }]
      }
    }
  });
  const retained = graphFromDailyHistoryArchive([], archive, { todayKey: '2026-07-18' });
  const history = historyFrom(retained);

  assert.equal(retained.capabilities.tokenComponents, true);
  assert.equal(history.daily[0].capabilities.tokenComponents, true);
});

test('live today snapshot wins over a smaller graph value after date rollover', () => {
  const archive = captureLiveDailyHistory({}, livePeriod(645_957_554, 62.42), {
    todayKey: '2026-08-05'
  });
  const lowerGraph = graph('2026-08-05', [client('claude', 'opus', 507_800_000, 40, 5)]);
  const restored = historyFrom(graphFromDailyHistoryArchive(lowerGraph, archive, {
    todayKey: '2026-08-06'
  }), '2026-08-06');

  assert.equal(restored.daily[0].date, '2026-08-05');
  assert.equal(restored.daily[0].tokens, 645_957_554);
  assert.equal(restored.daily[0].perClient.claude.tokens, 645_957_554);
  assert.equal(restored.daily[0].unclassifiedTokens, 138_157_554);
  assert.equal(restored.daily[0].perClient.claude.unclassifiedTokens, 138_157_554);

  const lowerLive = captureLiveDailyHistory(archive, livePeriod(507_800_000, 40), {
    todayKey: '2026-08-05'
  });
  assert.equal(dayObservation(lowerLive, '2026-08-05').tokens, 645_957_554);
});

test('equal-token live snapshot keeps corrected cost and graph component metadata', () => {
  const archive = captureLiveDailyHistory({}, livePeriod(150, 20), {
    todayKey: '2026-08-05'
  });
  const archivedGraph = graph('2026-08-05', [client('claude', 'opus', 150, 10, 5)]);
  const restored = historyFrom(graphFromDailyHistoryArchive(archivedGraph, archive, {
    todayKey: '2026-08-06'
  }), '2026-08-06');

  assert.equal(restored.daily[0].tokens, 150);
  assert.equal(restored.daily[0].cost, 20);
  assert.equal(restored.daily[0].perClient.claude.cost, 20);
  assert.equal(restored.daily[0].capabilities.tokenComponents, true);
  assert.equal(restored.daily[0].unclassifiedTokens, 0);
});

test('live snapshot keeps model-less remainder under its original client', () => {
  const archive = captureLiveDailyHistory({}, {
    totalTokens: 150,
    costUsd: 15,
    clients: { claude: 150 },
    clientCosts: { claude: 15 },
    clientModels: { claude: { opus: 100 } },
    clientModelCosts: { claude: { opus: 10 } }
  }, { todayKey: '2026-08-05' });
  const restored = historyFrom(graphFromDailyHistoryArchive([], archive, {
    todayKey: '2026-08-05'
  }), '2026-08-05');

  assert.equal(restored.daily[0].tokens, 150);
  assert.equal(restored.daily[0].perClient.claude.tokens, 150);
  assert.equal(restored.daily[0].perModel.opus.tokens, 100);
  assert.equal(restored.daily[0].perModel.unknown.tokens, 50);
  assert.equal(dayObservation(archive, '2026-08-05').tokens, 100);
  assert.equal(
    Object.values(archive.liveDays['2026-08-05'].observations)
      .find((observation) => observation.modelId === 'unknown').tokens,
    50
  );
});

function dayObservation(archive, date) {
  return Object.values(archive.liveDays[date].observations)[0];
}

test('retainLiveDailyHistory persists only a higher live snapshot', () => {
  let stored = {};
  let writes = 0;
  const options = {
    todayKey: '2026-08-05',
    readJson: () => stored,
    writeJsonAtomic: (_path, value) => { stored = value; writes += 1; }
  };

  retainLiveDailyHistory(livePeriod(645_957_554), options);
  retainLiveDailyHistory(livePeriod(507_800_000), options);

  assert.equal(writes, 1);
  assert.equal(dayObservation(stored, '2026-08-05').tokens, 645_957_554);
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

test('retainDailyHistory rebases on archive changes made during the graph scan', () => {
  const initial = captureDailyHistoryArchive({}, graph('2026-07-17', [
    client('claude', 'opus', 100, 4, 5)
  ]), { todayKey: '2026-07-18' });
  const handedOff = captureDailyHistoryArchive(initial, graph('2026-07-17', [
    client('codex', 'gpt', 50, 2, 3)
  ]), { todayKey: '2026-07-18' });
  let reads = 0;
  let stored;
  const retained = retainDailyHistory(graph('2026-07-17', [
    client('claude', 'opus', 120, 4.8, 6)
  ]), {
    todayKey: '2026-07-18',
    readJson: () => (++reads === 1 ? initial : handedOff),
    writeJsonAtomic: (_path, value) => { stored = value; }
  });

  assert.equal(reads, 2);
  assert.deepEqual(
    Object.values(stored.days['2026-07-17'].observations).map((item) => item.client).sort(),
    ['claude', 'codex']
  );
  assert.equal(historyFrom(retained).daily[0].tokens, 170);
});

test('captureLiveDailyHistory prunes future snapshots even when today has no usage', () => {
  const future = captureLiveDailyHistory({}, livePeriod(100), { todayKey: '2026-08-06' });
  const pruned = captureLiveDailyHistory(future, { totalTokens: 0 }, { todayKey: '2026-08-05' });
  assert.equal(pruned.liveDays?.['2026-08-06'], undefined);
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
