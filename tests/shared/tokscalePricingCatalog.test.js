'use strict';

// Proma costs may fall back to tokscale's on-disk pricing datasets when the
// bounded `tokscale pricing` command cannot finish. The fallback deliberately
// resolves less than tokscale: exact matches are safe, while ambiguous
// provider-stripped matches fail closed instead of guessing a price.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  normalizePromaPricing,
  readTokscalePricingCatalog,
  resetPromaPricingCache,
  resetTokscaleCatalogCache,
  resolvePromaPricing,
  tokscalePricingCatalog
} = require('../../src/shared/collector');
const { buildPromaPeriods } = require('../../src/shared/promaUsage');

function catalogDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokscale-pricing-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeCatalog(dir, fileName, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data));
}

function writeRawCatalog(dir, fileName, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), data);
}

function resetPricingCaches(t) {
  resetPromaPricingCache();
  resetTokscaleCatalogCache();
  t.after(() => {
    resetPromaPricingCache();
    resetTokscaleCatalogCache();
  });
}

test('catalog parsing preserves full keys and keeps null rates unavailable', (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      'opencode-go/deepseek-v4-pro': {
        input_cost_per_token: 4.35e-7,
        output_cost_per_token: 8.7e-7,
        cache_read_input_token_cost: 3.625e-9,
        cache_creation_input_token_cost: null
      }
    }
  });

  const catalog = tokscalePricingCatalog({ configDir: dir });
  assert.deepEqual(catalog.exact.get('opencode-go/deepseek-v4-pro'), {
    inputCostPerToken: 4.35e-7,
    outputCostPerToken: 8.7e-7,
    cacheReadInputTokenCost: 3.625e-9,
    cacheCreationInputTokenCost: undefined
  });
});

test('catalog parsing rejects a source with coercive rate values', (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      boolean: { input_cost_per_token: true, output_cost_per_token: false },
      whitespace: { input_cost_per_token: '   ', output_cost_per_token: [] },
      object: { input_cost_per_token: {}, output_cost_per_token: [2] },
      numericString: { input_cost_per_token: '1.5e-7', output_cost_per_token: 2e-7 }
    }
  });

  const catalog = tokscalePricingCatalog({ configDir: dir });
  assert.equal(catalog.exact.size, 0);
});

test('bare exact key wins over earlier reseller terminal collisions', (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      'libertai/deepseek-v4-flash': { input_cost_per_token: 2.5e-7, output_cost_per_token: 1.75e-6 },
      'deepseek-v4-flash': { input_cost_per_token: 1.4e-7, output_cost_per_token: 2.8e-7 },
      'deepseek/deepseek-v4-flash': { input_cost_per_token: 1.4e-7, output_cost_per_token: 2.8e-7 }
    }
  });

  assert.equal(readTokscalePricingCatalog('deepseek-v4-flash', { configDir: dir }).outputCostPerToken, 2.8e-7);
});

test('ambiguous terminal matches with different rates fail closed', (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      'provider-a/model-x': { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 },
      'provider-b/model-x': { input_cost_per_token: 3e-7, output_cost_per_token: 4e-7 }
    }
  });

  assert.equal(readTokscalePricingCatalog('model-x', { configDir: dir }), null);
});

test('terminal matches with identical rates remain safe without a bare key', (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      'provider-a/model-x': { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 },
      'provider-b/model-x': { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 }
    }
  });

  assert.equal(readTokscalePricingCatalog('model-x', { configDir: dir }).inputCostPerToken, 1e-7);
});

test('provider-scoped ids require their own full exact key', (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      'deepseek/deepseek-v4-flash': { input_cost_per_token: 1.4e-7, output_cost_per_token: 2.8e-7 }
    }
  });

  assert.equal(
    readTokscalePricingCatalog('deepseek/deepseek-v4-flash', { configDir: dir }).inputCostPerToken,
    1.4e-7
  );
  assert.equal(readTokscalePricingCatalog('reseller/deepseek-v4-flash', { configDir: dir }), null);
});

test('bare routing labels never resolve through terminal matches', (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      'morph/auto': { input_cost_per_token: 8.5e-7, output_cost_per_token: 1.55e-6 },
      'someone/agent_review': { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 }
    }
  });

  assert.equal(readTokscalePricingCatalog('auto', { configDir: dir }), null);
  assert.equal(readTokscalePricingCatalog('agent_review', { configDir: dir }), null);
  assert.equal(readTokscalePricingCatalog('morph/auto', { configDir: dir }).inputCostPerToken, 8.5e-7);
});

test('generic bare ids do not borrow provider terminal matches', (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      default: { input_cost_per_token: 3e-7, output_cost_per_token: 4e-7 },
      'vendor/default': { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 },
      'vendor/router': { input_cost_per_token: 5e-7, output_cost_per_token: 6e-7 }
    }
  });

  assert.equal(readTokscalePricingCatalog('default', { configDir: dir }).inputCostPerToken, 3e-7);
  assert.equal(readTokscalePricingCatalog('router', { configDir: dir }), null);
  assert.equal(readTokscalePricingCatalog('vendor/router', { configDir: dir }).inputCostPerToken, 5e-7);
});

test('catalog parsing skips malformed and future-dated sources', (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeRawCatalog(dir, 'pricing-litellm.json', 'not json {');
  writeCatalog(dir, 'pricing-openrouter.json', {
    timestamp: 2,
    data: { 'openai/future': { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 } }
  });
  writeCatalog(dir, 'pricing-models-dev.json', {
    timestamp: 0,
    data: { 'openai/known': { input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 } }
  });

  const catalog = tokscalePricingCatalog({ configDir: dir, nowMs: 1000 });
  assert.equal(catalog.exact.has('openai/future'), false);
  assert.equal(catalog.exact.get('openai/known').inputCostPerToken, 2.5e-6);
});

test('future-dated catalog becomes eligible without a file revision change', async (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 2,
    data: { model: { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 } }
  });
  let lookupCalls = 0;
  const lookupModelPricing = async () => {
    lookupCalls += 1;
    throw new Error('offline');
  };

  const before = await resolvePromaPricing(
    [{ model: 'model' }],
    { lookupModelPricing, pricingRevision: 1, nowMs: 1000, configDir: dir }
  );
  const after = await resolvePromaPricing(
    [{ model: 'model' }],
    { lookupModelPricing, pricingRevision: 1, nowMs: 2000, configDir: dir }
  );

  assert.deepEqual(before, {});
  assert.equal(after.model.inputCostPerToken, 1e-7);
  assert.equal(lookupCalls, 2);
});

test('catalog discovery uses a legacy root only when the canonical file is missing', (t) => {
  resetPricingCaches(t);
  const canonical = catalogDir(t);
  const legacy = catalogDir(t);
  writeCatalog(legacy, 'pricing-litellm.json', {
    timestamp: 0,
    data: { 'openai/legacy': { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 } }
  });

  assert.equal(
    readTokscalePricingCatalog('legacy', { catalogDirs: [canonical, legacy] }).inputCostPerToken,
    1e-7
  );

  writeRawCatalog(canonical, 'pricing-litellm.json', 'not json {');
  resetTokscaleCatalogCache();
  assert.equal(readTokscalePricingCatalog('legacy', { catalogDirs: [canonical, legacy] }), null);
});

test('catalog discovery skips a malformed legacy source and tracks every candidate revision', (t) => {
  resetPricingCaches(t);
  const canonical = catalogDir(t);
  const firstLegacy = catalogDir(t);
  const secondLegacy = catalogDir(t);
  writeRawCatalog(firstLegacy, 'pricing-litellm.json', 'not json {');
  writeCatalog(secondLegacy, 'pricing-litellm.json', {
    timestamp: 0,
    data: { model: { input_cost_per_token: 2, output_cost_per_token: 2 } }
  });
  const options = { catalogDirs: [canonical, firstLegacy, secondLegacy] };

  assert.equal(readTokscalePricingCatalog('model', options).inputCostPerToken, 2);

  writeCatalog(firstLegacy, 'pricing-litellm.json', {
    timestamp: 0,
    data: { model: { input_cost_per_token: 111, output_cost_per_token: 111 } }
  });
  assert.equal(readTokscalePricingCatalog('model', options).inputCostPerToken, 111);
});

test('resolvePromaPricing falls back to the local catalog when the lookup fails offline', async (t) => {
  resetPricingCaches(t);
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
});

test('catalog changes invalidate the outer Proma pricing cache', async (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  const writePrice = (value) => writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: { model: { input_cost_per_token: value, output_cost_per_token: value } }
  });
  let lookupCalls = 0;
  const lookupModelPricing = async () => {
    lookupCalls += 1;
    throw new Error('offline');
  };

  writePrice(1);
  const first = await resolvePromaPricing(
    [{ model: 'model' }],
    { lookupModelPricing, pricingRevision: 1, nowMs: 1000, configDir: dir }
  );
  writePrice(22);
  const second = await resolvePromaPricing(
    [{ model: 'model' }],
    { lookupModelPricing, pricingRevision: 1, nowMs: 2000, configDir: dir }
  );

  assert.equal(first.model.inputCostPerToken, 1);
  assert.equal(second.model.inputCostPerToken, 22);
  assert.equal(lookupCalls, 2);
});

test('missing cache-write rate keeps a partially priced Proma row unavailable', (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: {
      'provider/model-x': {
        input_cost_per_token: 1,
        output_cost_per_token: 2,
        cache_creation_input_token_cost: null
      }
    }
  });
  const pricing = readTokscalePricingCatalog('model-x', { configDir: dir });
  const periods = buildPromaPeriods({
    now: new Date(),
    rows: [{
      sessionId: 'session',
      model: 'model-x',
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 10,
      messages: 1,
      createdAt: Date.now()
    }],
    pricingByModel: { 'model-x': pricing }
  });

  assert.equal(pricing.cacheCreationInputTokenCost, undefined);
  assert.equal(periods.today.entries[0].cost, 0);
});

test('normalizePromaPricing keeps null command rates unavailable', () => {
  assert.deepEqual(
    normalizePromaPricing({ pricing: { inputCostPerToken: 1e-7, outputCostPerToken: 2e-7, cacheReadInputTokenCost: null } }),
    {
      inputCostPerToken: 1e-7,
      outputCostPerToken: 2e-7,
      cacheReadInputTokenCost: undefined,
      cacheCreationInputTokenCost: undefined
    }
  );
});

test('normalizePromaPricing rejects coercive command rates', () => {
  assert.equal(normalizePromaPricing({ pricing: {
    inputCostPerToken: true,
    outputCostPerToken: [],
    cacheReadInputTokenCost: ' ',
    cacheCreationInputTokenCost: {}
  } }), null);
});

test('normalizePromaPricing rejects numeric-string command rates', () => {
  assert.equal(normalizePromaPricing({ pricing: {
    inputCostPerToken: '1.5e-7',
    outputCostPerToken: '2e-7'
  } }), null);
});

test('resolvePromaPricing keeps the command result when the lookup succeeds', async (t) => {
  resetPricingCaches(t);
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
  assert.equal(pricing['deepseek-v4-flash'].inputCostPerToken, 9e-7);
});

test('resolvePromaPricing stays cost-unavailable when neither lookup nor catalog know the model', async (t) => {
  resetPricingCaches(t);
  const dir = catalogDir(t);
  writeCatalog(dir, 'pricing-litellm.json', {
    timestamp: 0,
    data: { 'x/known': { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 } }
  });

  const lookupModelPricing = async () => { throw new Error('offline'); };
  const pricing = await resolvePromaPricing(
    [{ model: 'private-channel-alias' }],
    { lookupModelPricing, pricingRevision: 1, nowMs: 1000, configDir: dir }
  );
  assert.deepEqual(pricing, {});
});
