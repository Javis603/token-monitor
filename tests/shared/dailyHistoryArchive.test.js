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
    tokens: 100, cost: 4, messages: 5, tokenComponentsAvailable: true, reasoningTokens: 7
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
    tokens: 100, cost: 4, messages: 5, unclassifiedTokens: 0
  });
  assert.deepEqual(restored.daily[0].perClient.codex, {
    tokens: 60, cost: 2.5, messages: 4, unclassifiedTokens: 0
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
    tokenComponentsAvailable: true
  });
});

test('archive preserves exact graph token components and marks legacy totals unavailable', () => {
  const exact = captureDailyHistoryArchive({}, graph('2026-07-17', [{
    client: 'claude',
    modelId: 'opus',
    tokens: { input: 10, output: 20, cacheRead: 60, cacheWrite: 10, reasoning: 0 },
    cost: 1,
    messages: 1
  }]), { todayKey: '2026-07-18' });
  const restoredExact = historyFrom(graphFromDailyHistoryArchive([], exact, {
    todayKey: '2026-07-18'
  }));
  assert.equal(restoredExact.daily[0].tokenComponentsAvailable, true);
  assert.equal(restoredExact.daily[0].cacheReadTokens, 60);
  assert.equal(restoredExact.daily[0].cacheWriteTokens, 10);
  assert.equal(restoredExact.daily[0].outputTokens, 20);
  assert.equal(restoredExact.daily[0].perClient.claude.cacheReadTokens, 60);
  assert.equal(restoredExact.daily[0].perModel.opus.outputTokens, 20);

  const legacy = normalizeDailyHistoryArchive({
    version: 1,
    days: {
      '2026-07-17': {
        date: '2026-07-17',
        observations: [{ client: 'claude', modelId: 'opus', tokens: 100, cost: 1, messages: 1 }]
      }
    }
  });
  const restoredLegacy = historyFrom(graphFromDailyHistoryArchive([], legacy, {
    todayKey: '2026-07-18'
  }));
  assert.equal(restoredLegacy.daily[0].tokens, 100);
  assert.equal(restoredLegacy.daily[0].tokenComponentsAvailable, false);
  assert.equal(restoredLegacy.daily[0].unclassifiedTokens, 100);
  assert.equal(restoredLegacy.daily[0].perClient.claude.unclassifiedTokens, 100);
  assert.equal(restoredLegacy.daily[0].perModel.opus.unclassifiedTokens, 100);
});

test('legacy zero-token synthetic observations have an exact empty component breakdown', () => {
  const archive = normalizeDailyHistoryArchive({
    version: 1,
    days: {
      '2026-07-17': {
        date: '2026-07-17',
        observations: [{
          client: 'claude',
          modelId: '<synthetic>',
          tokens: 0,
          cost: 0,
          messages: 1
        }]
      }
    }
  });
  const restored = historyFrom(graphFromDailyHistoryArchive([], archive, {
    todayKey: '2026-07-18'
  }));

  assert.equal(restored.daily[0].tokens, 0);
  assert.equal(restored.daily[0].tokenComponentsAvailable, true);
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

  const lowerLive = captureLiveDailyHistory(archive, livePeriod(507_800_000, 40), {
    todayKey: '2026-08-05'
  });
  assert.equal(dayObservation(lowerLive, '2026-08-05').tokens, 645_957_554);
});

test('live rollover keeps graph components and classifies only the later delta as unknown', () => {
  const exactGraph = graph('2026-08-05', [{
    client: 'claude',
    modelId: 'opus',
    tokens: { input: 10, output: 20, cacheRead: 60, cacheWrite: 10, reasoning: 0 },
    cost: 1,
    messages: 1
  }]);
  let archive = captureDailyHistoryArchive({}, exactGraph, { todayKey: '2026-08-05' });
  archive = captureLiveDailyHistory(archive, livePeriod(120, 1.2), {
    todayKey: '2026-08-05'
  });

  const restored = historyFrom(graphFromDailyHistoryArchive([], archive, {
    todayKey: '2026-08-06'
  }), '2026-08-06');
  const day = restored.daily[0];

  assert.equal(day.tokens, 120);
  assert.equal(day.cacheReadTokens, 60);
  assert.equal(day.cacheWriteTokens, 10);
  assert.equal(day.outputTokens, 20);
  assert.equal(day.unclassifiedTokens, 20);
  assert.equal(day.tokenComponentsAvailable, false);
  assert.equal(day.perClient.claude.cacheReadTokens, 60);
  assert.equal(day.perClient.claude.unclassifiedTokens, 20);
  assert.equal(day.perModel.opus.outputTokens, 20);
  assert.equal(day.perModel.opus.unclassifiedTokens, 20);
});

test('live-only archive preserves native day, client, and model components', () => {
  const archive = captureLiveDailyHistory({}, {
    capabilities: { tokenComponents: true },
    totalTokens: 100,
    costUsd: 1,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    outputTokens: 20,
    clients: { claude: 100 },
    clientCosts: { claude: 1 },
    clientCacheReads: { claude: 60 },
    clientCacheWrites: { claude: 10 },
    clientOutputs: { claude: 20 },
    models: { opus: 100 },
    modelCosts: { opus: 1 },
    modelCacheReads: { opus: 60 },
    modelCacheWrites: { opus: 10 },
    modelOutputs: { opus: 20 },
    clientModels: { claude: { opus: 100 } },
    clientModelCosts: { claude: { opus: 1 } }
  }, { todayKey: '2026-08-05' });
  const restored = historyFrom(graphFromDailyHistoryArchive([], archive, {
    todayKey: '2026-08-05'
  }), '2026-08-05');
  const day = restored.daily[0];

  assert.equal(day.tokens, 100);
  assert.equal(day.cacheReadTokens, 60);
  assert.equal(day.cacheWriteTokens, 10);
  assert.equal(day.outputTokens, 20);
  assert.equal(day.unclassifiedTokens, 0);
  assert.equal(day.tokenComponentsAvailable, true);
  assert.equal(day.perClient.claude.cacheReadTokens, 60);
  assert.equal(day.perModel.opus.outputTokens, 20);
});

test('live archive round-trip preserves known components in a partial native period', () => {
  const archive = captureLiveDailyHistory({}, {
    capabilities: { tokenComponents: false },
    totalTokens: 200,
    costUsd: 2,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    outputTokens: 20,
    unclassifiedTokens: 110,
    clients: { codex: 100, wsl: 100 },
    clientCosts: { codex: 1, wsl: 1 },
    clientCacheReads: { codex: 60 },
    clientCacheWrites: { codex: 10 },
    clientOutputs: { codex: 20 },
    clientUnclassifiedTokens: { codex: 10, wsl: 100 },
    models: { gpt: 100, unknown: 100 },
    modelCosts: { gpt: 1, unknown: 1 },
    modelCacheReads: { gpt: 60 },
    modelCacheWrites: { gpt: 10 },
    modelOutputs: { gpt: 20 },
    modelUnclassifiedTokens: { gpt: 10, unknown: 100 },
    clientModels: { codex: { gpt: 100 }, wsl: { unknown: 100 } },
    clientModelCosts: { codex: { gpt: 1 }, wsl: { unknown: 1 } }
  }, { todayKey: '2026-08-05' });
  const restored = historyFrom(graphFromDailyHistoryArchive([], archive, {
    todayKey: '2026-08-05'
  }), '2026-08-05');
  const day = restored.daily[0];

  assert.equal(day.tokens, 200);
  assert.equal(day.cacheReadTokens, 60);
  assert.equal(day.cacheWriteTokens, 10);
  assert.equal(day.outputTokens, 20);
  assert.equal(day.unclassifiedTokens, 110);
  assert.equal(day.tokenComponentsAvailable, false);
  assert.equal(day.perClient.codex.cacheReadTokens, 60);
  assert.equal(day.perClient.codex.unclassifiedTokens, 10);
  assert.equal(day.perClient.wsl.unclassifiedTokens, 100);
  assert.equal(day.perModel.gpt.outputTokens, 20);
  assert.equal(day.perModel.unknown.unclassifiedTokens, 100);
});

test('equal-token live capture upgrades an earlier aggregate-only snapshot', () => {
  let archive = captureLiveDailyHistory({}, {
    ...livePeriod(100, 1),
    capabilities: { tokenComponents: false }
  }, { todayKey: '2026-08-05' });
  archive = captureLiveDailyHistory(archive, {
    ...livePeriod(100, 1),
    capabilities: { tokenComponents: true },
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    outputTokens: 20,
    clientCacheReads: { claude: 60 },
    clientCacheWrites: { claude: 10 },
    clientOutputs: { claude: 20 },
    modelCacheReads: { opus: 60 },
    modelCacheWrites: { opus: 10 },
    modelOutputs: { opus: 20 }
  }, { todayKey: '2026-08-05' });

  const restored = historyFrom(graphFromDailyHistoryArchive([], archive, {
    todayKey: '2026-08-05'
  }), '2026-08-05');
  assert.equal(restored.daily[0].tokenComponentsAvailable, true);
  assert.equal(restored.daily[0].cacheReadTokens, 60);
});

test('live rollover never inflates a shrinking attribution bucket', () => {
  const exactGraph = graph('2026-08-05', [{
    client: 'claude',
    modelId: 'opus',
    tokens: { input: 10, output: 20, cacheRead: 60, cacheWrite: 10, reasoning: 0 },
    cost: 1,
    messages: 1
  }]);
  let archive = captureDailyHistoryArchive({}, exactGraph, { todayKey: '2026-08-05' });
  archive = captureLiveDailyHistory(archive, {
    totalTokens: 150,
    costUsd: 1.5,
    clients: { claude: 50, codex: 100 },
    clientCosts: { claude: 0.5, codex: 1 },
    models: { opus: 50, gpt: 100 },
    modelCosts: { opus: 0.5, gpt: 1 },
    clientModels: { claude: { opus: 50 }, codex: { gpt: 100 } },
    clientModelCosts: { claude: { opus: 0.5 }, codex: { gpt: 1 } },
    capabilities: { tokenComponents: false }
  }, { todayKey: '2026-08-05' });

  const restored = historyFrom(graphFromDailyHistoryArchive([], archive, {
    todayKey: '2026-08-06'
  }), '2026-08-06');
  const day = restored.daily[0];

  assert.equal(day.tokens, 150);
  assert.equal(day.perClient.claude.tokens, 50);
  assert.equal(day.perClient.codex.tokens, 100);
  assert.equal(day.unclassifiedTokens, 150);
  assert.equal(day.cacheReadTokens, 0);
  assert.equal(day.outputTokens, 0);
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
