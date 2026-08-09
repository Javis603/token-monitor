'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  inUseModelIds,
  perMillionFromPricing,
  upsertOverride,
  removeOverride,
  hasUsableBasePrice
} = require('../../src/electron/renderer/customPricingForm');

test('inUseModelIds unions models across periods, sorted + deduped', () => {
  const stats = {
    periods: {
      today: { models: { 'mimo-v2.5-pro': 10, 'claude-opus-4-8': 5 } },
      month: { models: { 'mimo-v2.5-pro': 99, 'gpt-5.3': 1 } },
      allTime: { models: { 'gpt-5.3': 2 } }
    }
  };
  assert.deepEqual(inUseModelIds(stats), ['claude-opus-4-8', 'gpt-5.3', 'mimo-v2.5-pro']);
});

test('inUseModelIds returns [] for missing/partial stats', () => {
  assert.deepEqual(inUseModelIds(null), []);
  assert.deepEqual(inUseModelIds({}), []);
  assert.deepEqual(inUseModelIds({ periods: { today: {} } }), []);
});

test('perMillionFromPricing converts per-token to per-million, rounded, omitting missing', () => {
  const result = { pricing: { inputCostPerToken: 4.0000000000000003e-7, outputCostPerToken: 8.000000000000001e-7, cacheReadInputTokenCost: 3e-9 } };
  assert.deepEqual(perMillionFromPricing(result), { inputPerM: 0.4, outputPerM: 0.8, cacheReadPerM: 0.003 });
});

test('perMillionFromPricing tolerates missing fields and bad input', () => {
  assert.deepEqual(perMillionFromPricing({ pricing: { outputCostPerToken: 1e-6 } }), { inputPerM: undefined, outputPerM: 1, cacheReadPerM: undefined });
  assert.deepEqual(perMillionFromPricing(null), { inputPerM: undefined, outputPerM: undefined, cacheReadPerM: undefined });
  assert.deepEqual(perMillionFromPricing({}), { inputPerM: undefined, outputPerM: undefined, cacheReadPerM: undefined });
});

test('hasUsableBasePrice accepts explicit free input/output and rejects invalid values', () => {
  assert.equal(hasUsableBasePrice({ inputPerM: 0, outputPerM: 0 }), true);
  assert.equal(hasUsableBasePrice({ outputPerM: 0 }), true);
  assert.equal(hasUsableBasePrice({ inputPerM: -1, outputPerM: undefined }), false);
  assert.equal(hasUsableBasePrice({ inputPerM: -1, outputPerM: 0 }), false);
  assert.equal(hasUsableBasePrice({ inputPerM: Number.NaN, outputPerM: undefined }), false);
  assert.equal(hasUsableBasePrice({ inputPerM: 1, outputPerM: 0, cacheReadPerM: -1 }), false);
  assert.equal(hasUsableBasePrice({ inputPerM: false, outputPerM: 0 }), false);
  assert.equal(hasUsableBasePrice({ inputPerM: '   ', outputPerM: 0 }), false);
  assert.equal(hasUsableBasePrice({ inputPerM: [], outputPerM: 0 }), false);
  assert.equal(hasUsableBasePrice({}), false);
});

test('upsertOverride replaces by modelId or appends, without mutating input', () => {
  const list = [{ modelId: 'a', inputPerM: 1 }];
  const appended = upsertOverride(list, { modelId: 'b', outputPerM: 2 });
  assert.deepEqual(appended, [{ modelId: 'a', inputPerM: 1 }, { modelId: 'b', outputPerM: 2 }]);
  const replaced = upsertOverride(list, { modelId: 'a', inputPerM: 9 });
  assert.deepEqual(replaced, [{ modelId: 'a', inputPerM: 9 }]);
  assert.deepEqual(list, [{ modelId: 'a', inputPerM: 1 }]); // original untouched
});

test('removeOverride drops the matching modelId only', () => {
  const list = [{ modelId: 'a' }, { modelId: 'b' }];
  assert.deepEqual(removeOverride(list, 'a'), [{ modelId: 'b' }]);
  assert.deepEqual(removeOverride(null, 'a'), []);
});
