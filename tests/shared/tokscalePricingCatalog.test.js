'use strict';

// Local clients' (e.g. Proma) costs fall back to tokscale's own pricing catalog cache
// (cache/pricing-{litellm,openrouter,models-dev}.json) when the `tokscale
// pricing` lookup fails — e.g. offline, where the command itself would wait
// 20-30s of network timeouts before using that same cache. These tests pin the
// local-cache parsing and the fallback wiring in resolvePromaPricing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readTokscalePricingCatalog,
  resetPromaPricingCache,
  resetTokscaleCatalogCache,
  resolvePromaPricing,
  tokscalePricingCatalog
} = require('../../src/shared/collector');

function catalogDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokscale-pricing-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeCatalog(dir, fileName, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data));
}

test('tokscalePricingCatalog parses litellm cache and strips provider prefixes', (t) => {
  resetTokscaleCatalogCache();
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      'deepseek/deepseek-v4-flash': {
        input_cost_per_token: 1.4e-7,
        output_cost_per_token: 2.8e-7,
        cache_read_input_token_cost: 2.8e-9,
        cache_creation_input_token_cost: 0
      },
      'opencode-go/deepseek-v4-pro': {
        input_cost_per_token: 4.35e-7,
        output_cost_per_token: 8.7e-7,
        cache_read_input_token_cost: 3.625e-9,
        cache_creation_input_token_cost: null
      }
    }
  });

  const catalog = tokscalePricingCatalog({ configDir: dir });
  assert.deepEqual(catalog.get('deepseek-v4-flash'), {
    inputCostPerToken: 1.4e-7,
    outputCostPerToken: 2.8e-7,
    cacheReadInputTokenCost: 2.8e-9,
    cacheCreationInputTokenCost: 0
  });
  assert.equal(catalog.get('deepseek-v4-pro').outputCostPerToken, 8.7e-7);
  assert.equal(readTokscalePricingCatalog('DeepSeek-V4-Flash', { configDir: dir }).inputCostPerToken, 1.4e-7);
  resetTokscaleCatalogCache();
});

test('tokscalePricingCatalog skips missing or malformed cache files', (t) => {
  resetTokscaleCatalogCache();
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', 'not json {');
  writeCatalog(dir, 'pricing-openrouter.json', { timestamp: 0, data: { 'openai/gpt-4o': { input_cost_per_token: 2.5e-6 } } });
  const catalog = tokscalePricingCatalog({ configDir: dir });
  assert.equal(catalog.get('gpt-4o').inputCostPerToken, 2.5e-6);
  assert.equal(catalog.size, 1);
  resetTokscaleCatalogCache();
});

test('resolvePromaPricing falls back to the local catalog when the lookup fails offline', async (t) => {
  resetPromaPricingCache();
  resetTokscaleCatalogCache();
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      'deepseek/deepseek-v4-flash': {
        input_cost_per_token: 1.4e-7,
        output_cost_per_token: 2.8e-7,
        cache_read_input_token_cost: 2.8e-9,
        cache_creation_input_token_cost: 0
      }
    }
  });

  let lookupCalls = 0;
  const lookupModelPricing = async () => {
    lookupCalls += 1;
    throw new Error('tokscale pricing timed out after 3000ms');
  };
  const pricing = await resolvePromaPricing(
    [{ model: 'deepseek-v4-flash' }],
    { lookupModelPricing, pricingRevision: 1, nowMs: 1000, configDir: dir }
  );
  assert.deepEqual(pricing['deepseek-v4-flash'], {
    inputCostPerToken: 1.4e-7,
    outputCostPerToken: 2.8e-7,
    cacheReadInputTokenCost: 2.8e-9,
    cacheCreationInputTokenCost: 0
  });
  assert.equal(lookupCalls, 1);
  resetPromaPricingCache();
  resetTokscaleCatalogCache();
});

test('resolvePromaPricing keeps the command result when the lookup succeeds', async (t) => {
  resetPromaPricingCache();
  resetTokscaleCatalogCache();
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: { 'deepseek/deepseek-v4-flash': { input_cost_per_token: 1.4e-7, output_cost_per_token: 2.8e-7 } }
  });

  const lookupModelPricing = async () => ({ pricing: { inputCostPerToken: 9e-7, outputCostPerToken: 9e-7 } });
  const pricing = await resolvePromaPricing(
    [{ model: 'deepseek-v4-flash' }],
    { lookupModelPricing, pricingRevision: 1, nowMs: 1000, configDir: dir }
  );
  // The successful (fresher) command result wins over the local catalog.
  assert.equal(pricing['deepseek-v4-flash'].inputCostPerToken, 9e-7);
  resetPromaPricingCache();
  resetTokscaleCatalogCache();
});

test('resolvePromaPricing stays cost-unavailable when neither lookup nor catalog know the model', async (t) => {
  resetPromaPricingCache();
  resetTokscaleCatalogCache();
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', { timestamp: 0, data: { 'x/known': { input_cost_per_token: 1e-7 } } });

  const lookupModelPricing = async () => { throw new Error('offline'); };
  const pricing = await resolvePromaPricing(
    [{ model: 'private-channel-alias' }],
    { lookupModelPricing, pricingRevision: 1, nowMs: 1000, configDir: dir }
  );
  assert.deepEqual(pricing, {});
  resetPromaPricingCache();
  resetTokscaleCatalogCache();
});
