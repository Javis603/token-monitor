'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { collectUsageOnce } = require('../../src/shared/collector');

const MIMO_ROW = {
  client: 'micode',
  sessionId: 'session-1',
  model: 'mimo-v2.5-pro',
  provider: 'mimo',
  input: 1000,
  output: 500,
  cacheRead: 100,
  cacheWrite: 10,
  reasoning: 50,
  messageCount: 1,
  cost: 0.05
};

test('GUI custom pricing overrides provider-reported cost across every usage rollup', async () => {
  const summary = await collectUsageOnce({
    clients: 'micode',
    allTimeSince: '2024-01-01',
    deviceId: 'pricing-test',
    historyEnabled: false,
    projectsEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => ({ entries: [MIMO_ROW] }),
    customModelPricing: [{
      modelId: 'mimo-v2.5-pro',
      inputPerM: 0.4,
      outputPerM: 0.8,
      cacheReadPerM: 0.003
    }]
  });

  // Mirrors tokscale's pricing buckets:
  // input + (output + reasoning) + cache read; cache write is free when unset.
  const expected = (1000 * 0.4 + (500 + 50) * 0.8 + 100 * 0.003) / 1_000_000;

  for (const period of [summary.today, summary.month, summary.allTime]) {
    assert.ok(Math.abs(period.costUsd - expected) < 1e-12);
    assert.ok(Math.abs(period.clientCosts.micode - expected) < 1e-12);
    assert.ok(Math.abs(period.modelCosts['mimo-v2.5-pro'] - expected) < 1e-12);
    assert.ok(Math.abs(period.clientModelCosts.micode['mimo-v2.5-pro'] - expected) < 1e-12);
    assert.ok(Math.abs(period.sessions['micode:session-1'].costUsd - expected) < 1e-12);
    assert.ok(Math.abs(period.sessions['micode:session-1'].modelCosts['mimo-v2.5-pro'] - expected) < 1e-12);
  }
});
