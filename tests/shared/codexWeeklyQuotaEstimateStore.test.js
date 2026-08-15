'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCodexWeeklyQuotaEstimateStore } = require('../../src/shared/codexWeeklyQuotaEstimateStore');

function stats(usedPercent, costUsd, tokens) {
  return {
    updatedAt: new Date(Date.UTC(2026, 7, 12, usedPercent)).toISOString(),
    periods: { allTime: { sessions: {
      one: { client: 'codex', costUsd, providers: { openai: tokens } }
    } } },
    limits: { providers: [{
      provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'account-a',
      windows: [{ kind: 'weekly', usedPercent, resetsAt: '2026-08-17T00:00:00Z' }]
    }] }
  };
}

test('store persists samples, skips duplicates, and exposes a snapshot', () => {
  const writes = [];
  const store = createCodexWeeklyQuotaEstimateStore({
    filePath: 'samples.json',
    readJson: (_path, fallback) => fallback,
    writeJsonAtomic: (filePath, value) => writes.push({ filePath, value: structuredClone(value) })
  });
  store.observe(stats(30, 10, 1_000_000), { minSampleCount: 1 });
  assert.equal(store.observe(stats(30, 10, 1_000_000), { minSampleCount: 1 }).changed, false);
  store.observe(stats(31, 10.1, 1_100_000), { minSampleCount: 1 });
  const result = store.observe(stats(32, 11.3, 2_300_000), { minSampleCount: 1 });
  assert.equal(result.estimate.status, 'ready');
  assert.ok(Math.abs(result.estimate.estimatedUsd - 120) < 0.000001);
  assert.equal(Object.hasOwn(result.estimate, 'deviceObservedCostUsd'), false);
  assert.equal(writes[0].filePath, 'samples.json');
  assert.equal(store.snapshot().accounts['account-a'].cycles[0].samples.length, 2);
});
