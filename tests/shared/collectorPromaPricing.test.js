'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resetPromaPricingCache, resolvePromaPricing } = require('../../src/shared/collector');

test('Proma model pricing is cached and invalidated when custom pricing changes', async () => {
  resetPromaPricingCache();
  let calls = 0;
  const controller = new AbortController();
  const lookupModelPricing = async (modelId, commandTimeoutMs, signal) => {
    calls += 1;
    assert.equal(modelId, 'claude-sonnet');
    assert.equal(commandTimeoutMs, 321);
    assert.equal(signal, controller.signal);
    return { pricing: { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 } };
  };
  const rows = [{ model: 'Claude-Sonnet' }, { model: 'claude-sonnet' }];
  const options = { lookupModelPricing, pricingRevision: 10, commandTimeoutMs: 321, signal: controller.signal };

  const first = await resolvePromaPricing(rows, { ...options, nowMs: 1000 });
  const second = await resolvePromaPricing(rows, { ...options, nowMs: 2000 });
  const afterPricingEdit = await resolvePromaPricing(rows, { ...options, pricingRevision: 11, nowMs: 2000 });

  assert.deepEqual(first, { 'claude-sonnet': { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015, cacheReadInputTokenCost: undefined, cacheCreationInputTokenCost: undefined } });
  assert.deepEqual(second, first);
  assert.deepEqual(afterPricingEdit, first);
  assert.equal(calls, 2);
  resetPromaPricingCache();
});

test('Proma pricing caches unknown models without substituting another model price', async () => {
  resetPromaPricingCache();
  let calls = 0;
  const lookupModelPricing = async () => {
    calls += 1;
    throw new Error('unknown model');
  };
  const rows = [{ model: 'private-channel-alias' }];

  assert.deepEqual(await resolvePromaPricing(rows, { lookupModelPricing, pricingRevision: 1, nowMs: 1000 }), {});
  assert.deepEqual(await resolvePromaPricing(rows, { lookupModelPricing, pricingRevision: 1, nowMs: 2000 }), {});
  assert.equal(calls, 1);
  resetPromaPricingCache();
});

test('Proma pricing retries immediately after an aborted lookup', async () => {
  resetPromaPricingCache();
  const firstController = new AbortController();
  let calls = 0;
  const lookupModelPricing = async () => {
    calls += 1;
    if (calls === 1) {
      firstController.abort();
      throw new Error('cancelled');
    }
    return { pricing: { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 } };
  };
  const rows = [{ model: 'private-aborted-channel-alias' }];

  assert.deepEqual(await resolvePromaPricing(rows, {
    lookupModelPricing,
    pricingRevision: 1,
    nowMs: 1000,
    signal: firstController.signal
  }), {});
  const retried = await resolvePromaPricing(rows, {
    lookupModelPricing,
    pricingRevision: 1,
    nowMs: 1001,
    signal: new AbortController().signal
  });
  assert.equal(retried['private-aborted-channel-alias'].inputCostPerToken, 0.000003);
  assert.equal(calls, 2);
  resetPromaPricingCache();
});
