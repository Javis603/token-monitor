'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_API_PRICING_SNAPSHOT,
  lookupPrice,
  normalizePricingSnapshot,
  priceTokenComponents
} = require('../../src/shared/quotaEngine');

const snapshot = {
  snapshotId: 'test-v1', sourceId: 'official-test', verifiedAt: '2026-08-25', effectiveFrom: '2026-08-25',
  sources: [{ provider: 'openai', url: 'https://example.test/pricing', version: 'v1' }],
  models: { openai: { 'gpt-test': { aliases: ['gpt-test-alias'], prices: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 2 } } } },
  reference: { provider: 'openai', model: 'gpt-test', category: 'input' }
};

test('API pricing preserves model/category line items and partial coverage', () => {
  const result = priceTokenComponents({
    models: { 'gpt-test': 100, unknown: 20 },
    tokenComponents: {
      'gpt-test': { input: 40, output: 20, cacheRead: 10, cacheWrite: 10, complete: true },
      unknown: { input: 20, complete: true }
    }
  }, { provider: 'openai', snapshot });
  assert.equal(result.pricedTokens, 80);
  assert.equal(result.unpricedTokens, 40);
  assert.equal(result.apiEquivalentCostUsd, 0.000141);
  assert.equal(result.pricingCoverage, 2 / 3);
  assert.equal(result.referenceEquivalentTokens, 141);
  assert.equal(result.lineItems.filter((item) => item.amountUsd !== null).reduce((sum, item) => sum + item.amountUsd, 0), result.apiEquivalentCostUsd);
});

test('API pricing leaves unknown categories and incomplete provenance unpriced', () => {
  const result = priceTokenComponents({
    models: { 'gpt-test': 100 },
    tokenComponents: { 'gpt-test': { output: 10, unclassified: 40, complete: false } }
  }, { provider: 'openai', snapshot });
  assert.equal(result.pricedTokens, 10);
  assert.equal(result.unpricedTokens, 90);
  assert.equal(result.observedUnitCostUsdPerMillion, 4);
  assert.equal(result.lineItems.some((item) => item.reason === 'incomplete-provenance'), true);
});

test('unavailable reference and zero denominator are null, never fake zero', () => {
  const unavailable = { ...snapshot, reference: { provider: 'openai', model: 'missing', category: 'input' } };
  const result = priceTokenComponents({ models: {}, tokenComponents: {} }, { provider: 'openai', snapshot: unavailable });
  assert.equal(result.referenceEquivalentTokens, null);
  assert.equal(result.observedUnitCostUsd, null);
  assert.equal(result.pricingCoverage, null);
});

test('invalid snapshots fail closed', () => {
  assert.equal(normalizePricingSnapshot({ snapshotId: 'x' }), null);
});

test('gpt-5.6 is only an exact alias and unmapped providers stay unpriced', () => {
  const alias = lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-5.6', 'input');
  const canonical = lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-5.6-sol', 'input');
  assert.equal(alias?.model, 'gpt-5.6-sol');
  assert.equal(alias?.unitPriceUsdPerMillion, canonical?.unitPriceUsdPerMillion);
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-5.6-unknown', 'input'), null);
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-5.4-codex', 'input'), null);
  // No unwired provider has a default price mapping: their tokens stay
  // unpriced instead of borrowing an OpenAI rate.
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'anthropic', 'claude-sonnet-4', 'input'), null);
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'xai', 'grok-4.5', 'input'), null);
  const result = priceTokenComponents({
    models: { 'claude-sonnet-4': 20 },
    tokenComponents: { 'claude-sonnet-4': { input: 10, cacheWrite: 10, complete: true } }
  }, { provider: 'claude', snapshot: DEFAULT_API_PRICING_SNAPSHOT });
  assert.equal(result.pricedTokens, 0);
  assert.equal(result.unpricedTokens, 20);
  assert.ok(result.lineItems.every((item) => item.reason === 'model-unpriced'));
});

test('GPT-6 Astra uses the official standard short-context prices without fuzzy aliases', () => {
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-6-astra', 'input')?.unitPriceUsdPerMillion, 10);
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-6-astra', 'cacheRead')?.unitPriceUsdPerMillion, 1);
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-6-astra', 'cacheWrite')?.unitPriceUsdPerMillion, 12.5);
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-6-astra', 'output')?.unitPriceUsdPerMillion, 50);
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-6-astra-preview', 'input'), null);
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-6', 'input'), null);
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'astra', 'input'), null);

  const result = priceTokenComponents({
    totalTokens: 4_000_000,
    models: { 'gpt-6-astra': 4_000_000 },
    tokenComponents: {
      'gpt-6-astra': {
        input: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
        complete: true
      }
    }
  }, { provider: 'codex', snapshot: DEFAULT_API_PRICING_SNAPSHOT });

  assert.equal(result.apiEquivalentCostUsd, 73.5);
  assert.equal(result.pricedTokens, 4_000_000);
  assert.equal(result.unpricedTokens, 0);
  assert.equal(result.pricingCoverage, 1);
  assert.equal(result.snapshotId, 'public-api-2026-09-05-v6');
  assert.match(result.assumption.summary, /short-context/);
  assert.match(result.assumption.summary, /≤272K/);
});

test('malformed component rows fail closed instead of double-counting', () => {
  const result = priceTokenComponents({
    models: { 'gpt-test': 10 },
    tokenComponents: { 'gpt-test': { input: 10, output: 10, cacheRead: 10, complete: false } }
  }, { provider: 'openai', snapshot });
  assert.equal(result.pricedTokens, 0);
  assert.equal(result.unpricedTokens, 10);
  assert.equal(result.pricedTokens + result.unpricedTokens, 10);
  assert.ok(result.lineItems.every((item) => item.reason === 'malformed-row'));
});

test('priced plus unpriced tokens stay consistent with the trusted total', () => {
  const result = priceTokenComponents({
    totalTokens: 50,
    models: { 'gpt-test': 40, unknown: 10 },
    tokenComponents: {
      'gpt-test': { input: 40, complete: true },
      unknown: { input: 10, complete: true }
    }
  }, { provider: 'openai', snapshot });
  assert.equal(result.pricedTokens + result.unpricedTokens, 50);
});
