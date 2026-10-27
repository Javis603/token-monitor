'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { hookModelSelection, mergeModelEvidence, turnModelEvidence, selectedModelPricing } = require('../../src/shared/providers/cursor/localModels');

const selected = (model = 'grok-4.6', params = [{ id: 'fast', value: 'false' }]) =>
  hookModelSelection({ model_id: model, model_params: params });

test('local selection requires a structured explicit model and never converts router modes', () => {
  assert.deepEqual(selected(), { model: 'grok-4.6', priceable: true });
  for (const id of ['', 'auto', 'default', 'cursor-auto', 'router', 'balance', 'intelligence', 'unknown', 'constructor']) {
    assert.equal(selected(id), null);
  }
  assert.equal(hookModelSelection({ model: 'cursor-grok-4.6-high' }), null);
  assert.deepEqual(hookModelSelection({ model_id: 'grok-4.6' }), { model: 'grok-4.6', priceable: false });
});

test('Fast and context selections cannot silently borrow base rates', () => {
  assert.deepEqual(selected('grok-4.6', [{ id: 'fast', value: 'true' }]), { model: 'grok-4.6-fast', priceable: true });
  assert.deepEqual(selected('claude-opus-4.7', [{ id: 'context', value: '1m' }]), { model: 'claude-opus-4.7-1m', priceable: true });
  for (const params of [[{ id: 'fast', value: 'maybe' }], [{ id: 'unrecognized', value: 'true' }],
    [{ id: 'fast', value: 'false' }, { id: 'fast', value: 'true' }]]) {
    assert.equal(selected('grok-4.6', params).priceable, false);
  }
});

test('different selections invalidate only model attribution and cannot recover from a conflict', () => {
  assert.deepEqual(turnModelEvidence({ start: { modelSelection: selected() }, stop: { modelSelection: selected() } }), selected());
  assert.deepEqual(turnModelEvidence({ stop: { modelSelection: selected() } }), { model: 'unknown' });
  const conflict = mergeModelEvidence(selected(), selected('grok-4.7'));
  assert.deepEqual(conflict, { model: 'unknown', priceable: false, modelConflict: true });
  assert.deepEqual(mergeModelEvidence(conflict, selected()), conflict);
  assert.deepEqual(mergeModelEvidence({ model: 'unknown' }, selected()), selected());
});

test('local pricing rejects fuzzy, ambiguous and context-tier results', async () => {
  const valid = { resolution: { exactModelIdentity: true, stripped: false, priceConsensus: true },
    pricing: { inputCostPerToken: 2e-6 }, allRates: { input_cost_per_token_above_200k_tokens: null } };
  assert.deepEqual(await selectedModelPricing('grok-4.6', 100, async () => valid), valid);
  for (const result of [{ pricing: valid.pricing }, { ...valid, resolution: { ...valid.resolution, stripped: true } },
    { ...valid, resolution: { ...valid.resolution, priceConsensus: false } },
    { ...valid, allRates: { input_cost_per_token_above_200k_tokens: 4e-6 } }]) {
    assert.equal(await selectedModelPricing('grok-4.6', 100, async () => result), null);
  }
});
