'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { extractUsageFromTokscale, splitCostUsd } = require('../../src/shared/usage');

const PRICING = {
  inputCostPerToken: 0.000003,
  outputCostPerToken: 0.000015,
  cacheReadInputTokenCost: 0.0000003,
  cacheCreationInputTokenCost: 0.00000375
};

test('splitCostUsd fails closed when a non-zero component has no rate', () => {
  assert.deepEqual(splitCostUsd({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheWriteTokens: 0
  }, 1.25, { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 }), {
    inputCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWriteCostUsd: 0,
    outputCostUsd: 0,
    unclassifiedCostUsd: 1.25
  });
});

test('splitCostUsd scales component costs to tokscale\'s total', () => {
  const split = splitCostUsd({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheWriteTokens: 10
  }, 1.0, PRICING);
  const raw = 100 * 0.000003 + 20 * 0.000015 + 50 * 0.0000003 + 10 * 0.00000375;
  assert.equal(split.unclassifiedCostUsd, 0);
  assert.ok(Math.abs(split.inputCostUsd + split.outputCostUsd + split.cacheReadCostUsd + split.cacheWriteCostUsd - 1) < 1e-12);
  assert.ok(Math.abs(split.inputCostUsd - (100 * 0.000003 * 1 / raw)) < 1e-12);
  assert.ok(Math.abs(split.outputCostUsd - (20 * 0.000015 * 1 / raw)) < 1e-12);
});

test('extractUsageFromTokscale splits row cost with collect-time pricing', () => {
  const period = extractUsageFromTokscale({
    entries: [{
      client: 'claude',
      model: 'opus',
      tokens: 180,
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      cost: 1
    }]
  }, { pricingForModel: () => PRICING });
  assert.equal(period.inputTokens, 100);
  assert.equal(period.outputTokens, 20);
  assert.equal(period.cacheReadTokens, 50);
  assert.equal(period.cacheWriteTokens, 10);
  assert.equal(period.costUsd, 1);
  assert.equal(period.unclassifiedCostUsd, 0);
  assert.ok(period.inputCostUsd > 0);
  assert.ok(period.outputCostUsd > 0);
  assert.ok(period.cacheReadCostUsd > 0);
  assert.ok(period.cacheWriteCostUsd > 0);
  assert.ok(Math.abs(
    period.inputCostUsd + period.outputCostUsd + period.cacheReadCostUsd + period.cacheWriteCostUsd - 1
  ) < 1e-12);
});

test('extractUsageFromTokscale keeps the whole cost unclassified without pricing', () => {
  const period = extractUsageFromTokscale({
    entries: [{
      client: 'claude',
      model: 'opus',
      tokens: 180,
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      cost: 1
    }]
  });
  assert.equal(period.unclassifiedCostUsd, 1);
  assert.equal(period.inputCostUsd, 0);
  assert.equal(period.outputCostUsd, 0);
});
