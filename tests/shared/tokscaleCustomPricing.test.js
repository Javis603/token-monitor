'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeCustomPricingSetting,
  createCustomPricingCostResolver,
  buildTokscaleModels,
  mergeManaged,
  applyCustomPricing
} = require('../../src/shared/tokscaleCustomPricing');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'custompricing-'));
}

test('normalize trims modelId, drops blanks and rows with no positive input/output', () => {
  const out = normalizeCustomPricingSetting([
    { modelId: '  mimo-v2.5-pro ', inputPerM: 0.4, outputPerM: 0.8, cacheReadPerM: 0.003 },
    { modelId: '', inputPerM: 1 },                       // no id
    { modelId: 'x', inputPerM: '', outputPerM: '' },     // neither input nor output
    { modelId: 'y', inputPerM: -1, outputPerM: 0 },      // negative + zero => dropped
    { modelId: 'z', outputPerM: 0.5 }                    // output-only is valid
  ]);
  assert.deepEqual(out, [
    { modelId: 'mimo-v2.5-pro', inputPerM: 0.4, outputPerM: 0.8, cacheReadPerM: 0.003 },
    { modelId: 'z', inputPerM: undefined, outputPerM: 0.5, cacheReadPerM: undefined }
  ]);
});

test('normalize dedupes by modelId, last wins; empty string is "unset" not 0', () => {
  const out = normalizeCustomPricingSetting([
    { modelId: 'm', inputPerM: 1, outputPerM: 2, cacheReadPerM: 9 },
    { modelId: 'm', inputPerM: 0.4, outputPerM: 0.8, cacheReadPerM: '' }
  ]);
  assert.deepEqual(out, [
    { modelId: 'm', inputPerM: 0.4, outputPerM: 0.8, cacheReadPerM: undefined }
  ]);
});

test('normalize accepts explicit 0 cache-read (free) but omits unset fields', () => {
  const out = normalizeCustomPricingSetting([{ modelId: 'm', outputPerM: 0.8, cacheReadPerM: 0 }]);
  assert.deepEqual(out, [{ modelId: 'm', inputPerM: undefined, outputPerM: 0.8, cacheReadPerM: 0 }]);
});

test('App-side resolver overrides a model case-insensitively with tokscale pricing buckets', () => {
  const resolveCost = createCustomPricingCostResolver([{
    modelId: 'MiMo-V2.5-Pro',
    inputPerM: 0.4,
    outputPerM: 0.8,
    cacheReadPerM: 0.003
  }]);

  assert.equal(resolveCost({
    model: 'mimo-v2.5-pro',
    input: 1000,
    output: 500,
    cacheRead: 100,
    cacheWrite: 10,
    reasoning: 50
  }), (1000 * 0.4 + (500 + 50) * 0.8 + 100 * 0.003) / 1_000_000);
  assert.equal(resolveCost({ model: 'other', input: 1000 }), undefined);
});

test('App-side resolver is absent when the setting has no valid overrides', () => {
  assert.equal(createCustomPricingCostResolver([]), null);
  assert.equal(createCustomPricingCostResolver([{ modelId: 'm', inputPerM: 0, outputPerM: 0 }]), null);
});

test('buildTokscaleModels emits per-million keys, omitting undefined fields', () => {
  const models = buildTokscaleModels([
    { modelId: 'mimo-v2.5-pro', inputPerM: 0.4, outputPerM: 0.8, cacheReadPerM: 0.003 },
    { modelId: 'z', inputPerM: undefined, outputPerM: 0.5, cacheReadPerM: undefined }
  ]);
  assert.deepEqual(models, {
    'mimo-v2.5-pro': {
      input_cost_per_million_tokens: 0.4,
      output_cost_per_million_tokens: 0.8,
      cache_read_input_token_cost_per_million_tokens: 0.003
    },
    z: { output_cost_per_million_tokens: 0.5 }
  });
});

test('mergeManaged preserves manual entries, overlays managed, drops removed managed', () => {
  const existing = { manual: { input_cost_per_million_tokens: 1 }, old: { output_cost_per_million_tokens: 2 } };
  const managed = { mimo: { input_cost_per_million_tokens: 0.4 } };
  const { models, managedIds } = mergeManaged(existing, managed, ['old']); // 'old' was ours, now gone
  assert.deepEqual(models, {
    manual: { input_cost_per_million_tokens: 1 },
    mimo: { input_cost_per_million_tokens: 0.4 }
  });
  assert.deepEqual(managedIds, ['mimo']);
});

test('applyCustomPricing writes tokscale file + sidecar and round-trips through fs', () => {
  const dir = tmpDir();
  try {
    const pricingPath = path.join(dir, 'custom-pricing.json');
    const sidecarPath = path.join(dir, 'sidecar.json');

    applyCustomPricing(
      [{ modelId: 'mimo-v2.5-pro', inputPerM: 0.4, outputPerM: 0.8, cacheReadPerM: 0.003 }],
      { pricingPath, sidecarPath }
    );

    assert.deepEqual(JSON.parse(fs.readFileSync(pricingPath, 'utf8')), {
      models: {
        'mimo-v2.5-pro': {
          input_cost_per_million_tokens: 0.4,
          output_cost_per_million_tokens: 0.8,
          cache_read_input_token_cost_per_million_tokens: 0.003
        }
      }
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(sidecarPath, 'utf8')), { version: 1, managedIds: ['mimo-v2.5-pro'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyCustomPricing keeps a manual entry and clears our removed one', () => {
  const dir = tmpDir();
  try {
    const pricingPath = path.join(dir, 'custom-pricing.json');
    const sidecarPath = path.join(dir, 'sidecar.json');
    // user hand-added "manual"; we previously managed "mimo"
    fs.writeFileSync(pricingPath, JSON.stringify({
      models: { manual: { input_cost_per_million_tokens: 5 }, 'mimo-v2.5-pro': { input_cost_per_million_tokens: 0.4 } }
    }));
    fs.writeFileSync(sidecarPath, JSON.stringify({ version: 1, managedIds: ['mimo-v2.5-pro'] }));

    applyCustomPricing([], { pricingPath, sidecarPath }); // user removed all overrides

    assert.deepEqual(JSON.parse(fs.readFileSync(pricingPath, 'utf8')), {
      models: { manual: { input_cost_per_million_tokens: 5 } }
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(sidecarPath, 'utf8')), { version: 1, managedIds: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyCustomPricing is a no-op when no overrides and no prior state (no files created)', () => {
  const dir = tmpDir();
  try {
    const pricingPath = path.join(dir, 'custom-pricing.json');
    const sidecarPath = path.join(dir, 'sidecar.json');

    const result = applyCustomPricing([], { pricingPath, sidecarPath });

    assert.equal(fs.existsSync(pricingPath), false);
    assert.equal(fs.existsSync(sidecarPath), false);
    assert.deepEqual(result, { models: {}, managedIds: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
