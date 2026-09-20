'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildQoderCnHistoryGraph, buildQoderCnPeriods } = require('../../src/shared/providers/qodercn/usage');
const { parseGraphResult, normalizeHistory } = require('../../src/shared/history');
const { applyPeriodDelta, emptyPeriod, extractUsageFromTokscale } = require('../../src/shared/usage');
const { captureLiveDailyHistory, graphFromDailyHistoryArchive, normalizeDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { applyArchivedClientUsage, captureArchivedClientUsage } = require('../../src/shared/clientUsageArchive');
const { applySessionUsageArchive, captureSessionUsageArchive } = require('../../src/shared/sessionUsageArchive');
const { localDate, localMs } = require('../helpers/localTime');

function row(model, messageId, input = 10, output = 2) {
  return { sessionId: 's', messageId, model, input, output, cacheRead: 3, cacheWrite: 0,
    createdAt: localMs(2026, 9, 19, 8), messages: 1 };
}

const fixtureNow = () => localDate(2026, 9, 19, 12);

test('Qoder missing pricing preserves known cost subtotal and unpriced token provenance', () => {
  const rows = [row('priced', 'p'), row('missing', 'u', 20, 4)];
  const pricingByModel = { priced: { inputCostPerToken: 1, outputCostPerToken: 2, cacheReadInputTokenCost: 3 } };
  const raw = buildQoderCnPeriods({ now: fixtureNow(), rows, pricingByModel }).today;
  const period = extractUsageFromTokscale(raw);
  assert.equal(period.costUsd, 23);
  assert.equal(period.unpricedTokens, 27);
  assert.equal(period.clientUnpricedTokens.qodercn, 27);
  assert.equal(period.modelUnpricedTokens.missing, 27);
  assert.equal(period.clientModelUnpricedTokens.qodercn.missing, 27);
  assert.equal(period.sessions['qodercn:s'].unpricedTokens, 27);
  assert.deepEqual(period.sessions['qodercn:s'].modelUnpricedTokens, { missing: 27 });
});

test('Qoder explicit zero prices remain free while an absent required rate remains unavailable', () => {
  const period = extractUsageFromTokscale(buildQoderCnPeriods({
    now: fixtureNow(), rows: [row('free', 'f'), row('incomplete', 'i')],
    pricingByModel: {
      free: { inputCostPerToken: 0, outputCostPerToken: 0, cacheReadInputTokenCost: 0 },
      incomplete: { inputCostPerToken: 1, outputCostPerToken: 1 }
    }
  }).today);
  assert.equal(period.totalTokens, 30);
  assert.equal(period.costUsd, 0);
  assert.equal(period.unpricedTokens, 15);
  assert.deepEqual(period.modelUnpricedTokens, { incomplete: 15 });
});

test('client and multi-model session archives retain missing-price attribution without marking free usage', () => {
  const now = fixtureNow();
  const period = extractUsageFromTokscale(buildQoderCnPeriods({
    now, rows: [row('priced', 'p'), row('missing', 'u', 20, 4), row('free', 'f')],
    pricingByModel: {
      priced: { inputCostPerToken: 1, outputCostPerToken: 2, cacheReadInputTokenCost: 3 },
      free: { inputCostPerToken: 0, outputCostPerToken: 0, cacheReadInputTokenCost: 0 }
    }
  }).today);
  const summary = { today: period, month: period, allTime: period };
  const empty = () => ({ today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() });
  const persisted = value => JSON.parse(JSON.stringify(value));
  const restored = [
    applyArchivedClientUsage(empty(), persisted(captureArchivedClientUsage({}, summary, ['qodercn'], now)), { activeClients: [], now }),
    applySessionUsageArchive(empty(), persisted(captureSessionUsageArchive({}, summary, now)), { now })
  ];
  for (const result of restored) {
    assert.equal(result.allTime.totalTokens, 57);
    assert.equal(result.allTime.costUsd, 23);
    assert.equal(result.allTime.unpricedTokens, 27);
    assert.deepEqual(result.allTime.modelUnpricedTokens, { missing: 27 });
    assert.deepEqual(result.allTime.clientModelUnpricedTokens, { qodercn: { missing: 27 } });
    assert.deepEqual(result.allTime.sessions['qodercn:s'].modelUnpricedTokens, { missing: 27 });
  }
});

test('Qoder history and live archive round-trip unpriced tokens', () => {
  const graph = buildQoderCnHistoryGraph({ rows: [row('missing', 'u')], pricingByModel: {} });
  const history = normalizeHistory(parseGraphResult(graph), { todayKey: '2026-09-19' });
  assert.equal(history.daily[0].unpricedTokens, 15);
  assert.equal(history.daily[0].perClient.qodercn.unpricedTokens, 15);
  assert.equal(history.daily[0].perModel.missing.unpricedTokens, 15);
  assert.equal(history.monthly[0].unpricedTokens, 15);
  assert.equal(history.summary.unpricedTokens, 15);

  const period = extractUsageFromTokscale(buildQoderCnPeriods({ now: fixtureNow(), rows: [row('missing', 'u')], pricingByModel: {} }).today);
  const archive = captureLiveDailyHistory({}, period, { todayKey: '2026-09-19' });
  const restored = graphFromDailyHistoryArchive([], normalizeDailyHistoryArchive(archive), { todayKey: '2026-09-19' });
  assert.equal(restored.contributions[0].clients[0].unpricedTokens, 15);
});

test('period delta clears stale unpriced provenance after pricing becomes available', () => {
  const missing = extractUsageFromTokscale(buildQoderCnPeriods({ now: fixtureNow(), rows: [row('m', 'u')], pricingByModel: {} }).today);
  const priced = extractUsageFromTokscale(buildQoderCnPeriods({ now: fixtureNow(), rows: [row('m', 'u')], pricingByModel: { m: {
    inputCostPerToken: 1, outputCostPerToken: 1, cacheReadInputTokenCost: 1
  } } }).today);
  const result = applyPeriodDelta(missing, priced, missing);
  assert.equal(result.unpricedTokens, 0);
  assert.equal(result.clientUnpricedTokens.qodercn, 0);
  assert.equal(result.modelUnpricedTokens.m, 0);
  assert.equal(result.clientModelUnpricedTokens.qodercn.m, 0);
  assert.equal(result.costUsd, 15);
});
