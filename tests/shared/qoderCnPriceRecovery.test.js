'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  graphFromDailyHistoryArchive,
  normalizeDailyHistoryArchive
} = require('../../src/shared/dailyHistoryArchive');

const date = '2026-09-19';
function graph(client, cost, unpricedTokens) {
  return { contributions: [{ date, clients: [{
    client, modelId: 'model', tokens: { input: 15, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost, messages: 1,
    ...(unpricedTokens > 0 ? { unpricedTokens } : {})
  }] }] };
}

function liveArchive(client, cost, unpricedTokens) {
  return normalizeDailyHistoryArchive({ liveDays: { [date]: {
    date, activeTimeMs: 0, observations: [{
      client, modelId: 'model', tokens: 15, cost, messages: 1, tokenComponentsAvailable: true,
      ...(unpricedTokens > 0 ? { unpricedTokens } : {})
    }]
  } } });
}

function archived(client, dayCost, dayUnpriced, liveCost, liveUnpriced) {
  const observation = (cost, unpricedTokens) => ({
    client, modelId: 'model', tokens: 15, cost, messages: 1, tokenComponentsAvailable: true,
    ...(unpricedTokens > 0 ? { unpricedTokens } : {})
  });
  return normalizeDailyHistoryArchive({
    days: { [date]: { date, activeTimeMs: 0, observations: [observation(dayCost, dayUnpriced)] } },
    liveDays: { [date]: { date, activeTimeMs: 0, observations: [observation(liveCost, liveUnpriced)] } }
  });
}

function restored(client, graphCost, graphUnpriced, liveCost, liveUnpriced) {
  const result = graphFromDailyHistoryArchive(
    graph(client, graphCost, graphUnpriced),
    liveArchive(client, liveCost, liveUnpriced),
    { todayKey: date }
  );
  return result.contributions[0].clients[0];
}

test('fresh Qoder graph clears an old missing-price marker for a real zero price', () => {
  const row = restored('qodercn', 0, 0, 0, 15);
  assert.equal(row.cost, 0);
  assert.equal(row.unpricedTokens, undefined);
});

test('fresh Qoder graph replaces an old missing-price marker with a positive price', () => {
  const row = restored('qodercn', 1.25, 0, 0, 15);
  assert.equal(row.cost, 1.25);
  assert.equal(row.unpricedTokens, undefined);
});

test('legacy records without missing-price metadata remain compatible', () => {
  assert.deepEqual(restored('qodercn', 0, 0, 0, 0), {
    client: 'qodercn', modelId: 'model', tokens: {
      input: 15, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0
    }, tokenComponentsAvailable: true, cost: 0, messages: 1
  });
});

test('non-Qoder live history keeps the existing bidirectional priority rule', () => {
  const row = restored('claude', 0, 0, 0, 15);
  assert.equal(row.unpricedTokens, 15);
});

test('fresh Qoder pricing wins even when an older durable day shadows the graph map', () => {
  const result = graphFromDailyHistoryArchive(
    graph('qodercn', 0, 0),
    archived('qodercn', 0, 15, 0, 15),
    { todayKey: date }
  );
  assert.equal(result.contributions[0].clients[0].unpricedTokens, undefined);
});

test('without a fresh graph Qoder keeps the existing archive versus live priority', () => {
  const result = graphFromDailyHistoryArchive(
    [],
    archived('qodercn', 0, 0, 2, 0),
    { todayKey: date }
  );
  assert.equal(result.contributions[0].clients[0].cost, 2);
});

test('fresh Qoder pricing can resolve a live day newer than its durable snapshot', () => {
  const archive = archived('qodercn', 0, 12, 0, 15);
  Object.values(archive.days[date].observations)[0].tokens = 12;
  const result = graphFromDailyHistoryArchive(graph('qodercn', 0, 0), archive, { todayKey: date });
  assert.equal(result.contributions[0].clients[0].tokens.input, 15);
  assert.equal(result.contributions[0].clients[0].unpricedTokens, undefined);
});

test('ordinary priced Qoder records do not opt into missing-price reconciliation', () => {
  const result = graphFromDailyHistoryArchive(
    graph('qodercn', 1, 0),
    archived('qodercn', 0, 0, 2, 0),
    { todayKey: date }
  );
  assert.equal(result.contributions[0].clients[0].cost, 2);
});
