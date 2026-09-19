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
