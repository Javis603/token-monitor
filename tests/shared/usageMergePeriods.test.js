'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mergePeriods, emptyPeriod, addPeriodInto } = require('../../src/shared/usage');

test('mergePeriods sums totals and per-client/per-model maps', () => {
  const a = emptyPeriod();
  a.totalTokens = 100; a.costUsd = 1.5;
  a.clients = { claude: 100 }; a.clientCosts = { claude: 1.5 };
  a.models = { 'claude-3': 100 }; a.modelCosts = { 'claude-3': 1.5 };

  const b = emptyPeriod();
  b.totalTokens = 40; b.costUsd = 0.5;
  b.clients = { claude: 10, codex: 30 }; b.clientCosts = { claude: 0.2, codex: 0.3 };
  b.models = { 'claude-3': 10, 'gpt-5': 30 }; b.modelCosts = { 'claude-3': 0.2, 'gpt-5': 0.3 };

  const out = mergePeriods(a, b);
  assert.equal(out.totalTokens, 140);
  assert.equal(out.costUsd, 2);
  assert.deepEqual(out.clients, { claude: 110, codex: 30 });
  assert.deepEqual(out.clientCosts, { claude: 1.7, codex: 0.3 });
  assert.deepEqual(out.models, { 'claude-3': 110, 'gpt-5': 30 });
  assert.deepEqual(out.modelCosts, { 'claude-3': 1.7, 'gpt-5': 0.3 });
});

test('mergePeriods ignores null/undefined args and does not mutate inputs', () => {
  const a = emptyPeriod(); a.totalTokens = 5; a.clients = { claude: 5 };
  const out = mergePeriods(a, null, undefined);
  assert.equal(out.totalTokens, 5);
  assert.notEqual(out, a);
  assert.equal(a.totalTokens, 5); // unchanged
});

test('addPeriodInto accumulates clientModels nesting', () => {
  const target = emptyPeriod();
  const source = emptyPeriod();
  source.clientModels = { claude: { 'claude-3': 7 } };
  source.clientModelCosts = { claude: { 'claude-3': 0.7 } };
  addPeriodInto(target, source);
  addPeriodInto(target, source);
  assert.deepEqual(target.clientModels, { claude: { 'claude-3': 14 } });
  assert.deepEqual(target.clientModelCosts, { claude: { 'claude-3': 1.4 } });
});

test('mergePeriods propagates token-component provenance fail closed', () => {
  const exact = emptyPeriod();
  exact.totalTokens = 100;
  exact.cacheReadTokens = 60;
  const aggregateOnly = emptyPeriod();
  aggregateOnly.totalTokens = 50;
  aggregateOnly.capabilities.tokenComponents = false;

  const merged = mergePeriods(exact, aggregateOnly);

  assert.equal(merged.totalTokens, 150);
  assert.equal(merged.cacheReadTokens, 60);
  assert.equal(merged.capabilities.tokenComponents, false);
});
