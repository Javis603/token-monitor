'use strict';

// tokscale keeps a usage row it cannot price and reports it at `cost: 0`,
// which is what a first-party model looks like in the days between its
// release and the pricing catalogs carrying it. The bundled table re-costs
// exactly those rows and must stay inert everywhere else.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FALLBACK_MODEL_PRICING,
  FALLBACK_PRICING_REVISION,
  RATE_FIELDS,
  applyGraphPricingFallback,
  applyScanPricingFallback,
  canonicalFallbackModelId,
  fallbackCostForTokens,
  fallbackModelPricing,
  fallbackPricedRow
} = require('../../src/shared/modelPricingFallback');

const FABLE = { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5 };

function fableRow(overrides = {}) {
  return {
    client: 'claude',
    sessionId: 's1',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 1091,
    output: 10877,
    cacheRead: 1596926,
    cacheWrite: 134570,
    reasoning: 0,
    messageCount: 13,
    cost: 0,
    ...overrides
  };
}

test('every bundled row names a canonical id with four finite non-negative per-million rates', () => {
  const providers = Object.keys(FALLBACK_MODEL_PRICING);
  assert.ok(providers.length > 0);
  for (const provider of providers) {
    assert.equal(provider, provider.trim().toLowerCase());
    for (const [model, rates] of Object.entries(FALLBACK_MODEL_PRICING[provider])) {
      assert.equal(model, canonicalFallbackModelId(model), `${model} must be stored in canonical form`);
      assert.deepEqual(Object.keys(rates).sort(), [...RATE_FIELDS].sort(), `${model} must carry exactly the rate fields`);
      for (const field of RATE_FIELDS) {
        assert.ok(Number.isFinite(rates[field]) && rates[field] >= 0, `${model}.${field} must be a finite non-negative rate`);
      }
      assert.ok(rates.inputPerM > 0 || rates.outputPerM > 0, `${model} must not be a free model`);
    }
  }
});

test('the Claude Fable 5.1 rates match its published list price', () => {
  assert.deepEqual(fallbackModelPricing('anthropic', 'claude-fable-5-1'), FABLE);
});

// A persisted month/allTime anchor was costed under the table of the build
// that wrote it, and the collector folds this revision into the anchor
// fingerprint to force one full scan after an edit. Pinning the table here
// means an edit that forgets the bump fails the suite instead of shipping.
test('editing the bundled table requires bumping FALLBACK_PRICING_REVISION', () => {
  assert.equal(FALLBACK_PRICING_REVISION, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(FALLBACK_MODEL_PRICING)), {
    anthropic: {
      'claude-fable-5-1': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5 }
    }
  }, 'the bundled table changed: bump FALLBACK_PRICING_REVISION and update this snapshot');
});

test('canonical id folds case, whitespace, the [1m] context marker and a dated snapshot suffix', () => {
  assert.equal(canonicalFallbackModelId('  Claude-Fable-5-1 '), 'claude-fable-5-1');
  assert.equal(canonicalFallbackModelId('claude-fable-5-1[1m]'), 'claude-fable-5-1');
  assert.equal(canonicalFallbackModelId('claude-fable-5-1-20260901'), 'claude-fable-5-1');
  assert.equal(canonicalFallbackModelId('claude-fable-5-1-20260901[1m]'), 'claude-fable-5-1');
  assert.equal(canonicalFallbackModelId(''), '');
  assert.equal(canonicalFallbackModelId(null), '');
  // A shorter numeric suffix is part of the id, not a snapshot date.
  assert.equal(canonicalFallbackModelId('claude-fable-5-1-2026'), 'claude-fable-5-1-2026');
});

test('lookup is scoped by provider and exact model, never by family', () => {
  assert.equal(fallbackModelPricing('openai', 'claude-fable-5-1'), null);
  assert.equal(fallbackModelPricing('', 'claude-fable-5-1'), null);
  assert.equal(fallbackModelPricing('anthropic', 'claude-fable-5'), null);
  assert.equal(fallbackModelPricing('anthropic', 'anthropic/claude-fable-5-1'), null);
  assert.equal(fallbackModelPricing('anthropic', 'claude-fable-5-1-beta'), null);
  assert.deepEqual(fallbackModelPricing('Anthropic', 'Claude-Fable-5-1[1m]'), FABLE);
});

test('cost is the per-million sum over input, output, cache read and cache write', () => {
  const cost = fallbackCostForTokens(FABLE, { input: 1091, output: 10877, cacheRead: 1596926, cacheWrite: 134570 });
  // The same row priced by tokscale 4.15.0 once its catalogs carried the model.
  assert.ok(Math.abs(cost - 2.6361165) < 1e-9);
  assert.equal(fallbackCostForTokens(FABLE, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), 0);
});

test('an unpriced first-party row is re-costed and the source row is left untouched', () => {
  const row = fableRow();
  const priced = fallbackPricedRow(row);
  assert.ok(Math.abs(priced.cost - 2.6361165) < 1e-9);
  assert.equal(row.cost, 0);
  assert.equal(priced.model, 'claude-fable-5-1');
  assert.equal(priced.messageCount, 13);
});

test('rows tokscale already priced are never touched, even at a different rate', () => {
  assert.equal(fallbackPricedRow(fableRow({ cost: 0.01 })), null);
  assert.equal(fallbackPricedRow(fableRow({ cost: 99 })), null);
});

test('rows outside the table stay unpriced instead of borrowing a neighbour', () => {
  assert.equal(fallbackPricedRow(fableRow({ model: 'claude-fable-5' })), null);
  assert.equal(fallbackPricedRow(fableRow({ model: 'claude-mythos-5-1' })), null);
  assert.equal(fallbackPricedRow(fableRow({ provider: 'openai' })), null);
  assert.equal(fallbackPricedRow(fableRow({ provider: undefined })), null);
  assert.equal(fallbackPricedRow(fableRow({ model: undefined })), null);
});

test('a row with no billable tokens is left alone', () => {
  assert.equal(fallbackPricedRow(fableRow({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })), null);
  assert.equal(fallbackPricedRow(fableRow({ input: -5, output: 'x', cacheRead: null, cacheWrite: undefined })), null);
});

test('a model the user priced in custom-pricing.json is skipped on the exact lowercased id, as tokscale matches it', () => {
  const customModelIds = new Set(['claude-fable-5-1']);
  assert.equal(fallbackPricedRow(fableRow(), { customModelIds }), null);
  assert.equal(fallbackPricedRow(fableRow({ model: 'Claude-Fable-5-1' }), { customModelIds }), null);
  // tokscale would not apply that entry to a decorated id either, so the row is
  // still unpriced on its side and ours is the only price it can get.
  assert.ok(fallbackPricedRow(fableRow({ model: 'claude-fable-5-1[1m]' }), { customModelIds }));
  assert.ok(fallbackPricedRow(fableRow(), { customModelIds: new Set(['claude-fable-5', 'claude-fable-5-1-20260901']) }));
  assert.ok(fallbackPricedRow(fableRow(), { customModelIds: null }));
});

test('malformed rows are ignored', () => {
  assert.equal(fallbackPricedRow(null), null);
  assert.equal(fallbackPricedRow('claude-fable-5-1'), null);
  assert.equal(fallbackPricedRow([fableRow()]), null);
});

test('scan output: only the unpriced rows change, totalCost follows, and untouched input is returned as-is', () => {
  const json = {
    groupBy: 'client,session,model',
    entries: [
      fableRow(),
      fableRow({ sessionId: 's2', model: 'claude-opus-5', cost: 1.5, input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }),
      fableRow({ sessionId: 's3', client: 'codex', model: 'gpt-5.5', provider: 'openai', cost: 0 })
    ],
    totalCost: 1.5
  };
  const before = JSON.stringify(json);
  const next = applyScanPricingFallback(json);
  assert.notEqual(next, json);
  assert.equal(JSON.stringify(json), before);
  assert.ok(Math.abs(next.entries[0].cost - 2.6361165) < 1e-9);
  assert.equal(next.entries[1], json.entries[1]);
  assert.equal(next.entries[2], json.entries[2]);
  assert.ok(Math.abs(next.totalCost - (1.5 + 2.6361165)) < 1e-9);
  assert.equal(next.groupBy, 'client,session,model');

  const alreadyPriced = { entries: [fableRow({ cost: 2 })], totalCost: 2 };
  assert.equal(applyScanPricingFallback(alreadyPriced), alreadyPriced);
  assert.equal(applyScanPricingFallback({ entries: [] }).entries.length, 0);
  assert.equal(applyScanPricingFallback(null), null);
  assert.deepEqual(applyScanPricingFallback({ contributions: [] }), { contributions: [] });
});

test('scan output: onApplied reports each re-costed row with canonical provider and model', () => {
  const applied = [];
  applyScanPricingFallback(
    { entries: [fableRow(), fableRow({ sessionId: 's2', model: 'Claude-Fable-5-1[1m]' })] },
    { onApplied: (info) => applied.push(info) }
  );
  assert.deepEqual(applied, [
    { provider: 'anthropic', model: 'claude-fable-5-1' },
    { provider: 'anthropic', model: 'claude-fable-5-1' }
  ]);
});

test('graph output: nested token components are priced per day and the day totals follow', () => {
  const json = {
    summary: { totalCost: 6 },
    contributions: [
      {
        date: '2026-09-01',
        totals: { tokens: 1743464, cost: 0, messages: 13 },
        clients: [
          { client: 'claude', modelId: 'claude-fable-5-1', providerId: 'anthropic', tokens: { input: 1091, output: 10877, cacheRead: 1596926, cacheWrite: 134570, reasoning: 0 }, cost: 0, messages: 13 }
        ]
      },
      {
        date: '2026-08-31',
        totals: { tokens: 10, cost: 6, messages: 1 },
        clients: [
          { client: 'claude', modelId: 'claude-opus-5', providerId: 'anthropic', tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 6, messages: 1 }
        ]
      }
    ]
  };
  const before = JSON.stringify(json);
  const next = applyGraphPricingFallback(json);
  assert.equal(JSON.stringify(json), before);
  assert.ok(Math.abs(next.contributions[0].clients[0].cost - 2.6361165) < 1e-9);
  assert.ok(Math.abs(next.contributions[0].totals.cost - 2.6361165) < 1e-9);
  assert.equal(next.contributions[0].totals.tokens, 1743464);
  assert.equal(next.contributions[1], json.contributions[1]);
  assert.ok(Math.abs(next.summary.totalCost - (6 + 2.6361165)) < 1e-9);

  assert.equal(applyGraphPricingFallback(json.contributions[1]), json.contributions[1]);
  const untouched = { contributions: [json.contributions[1]] };
  assert.equal(applyGraphPricingFallback(untouched), untouched);
});

test('graph output: a day without totals, or a document without a summary, gains neither key', () => {
  const bare = {
    contributions: [{ date: '2026-09-01', clients: [{ client: 'claude', modelId: 'claude-fable-5-1', providerId: 'anthropic', tokens: { input: 1000000 }, cost: 0 }] }]
  };
  const next = applyGraphPricingFallback(bare);
  assert.equal(next.contributions[0].clients[0].cost, 10);
  assert.equal(Object.prototype.hasOwnProperty.call(next.contributions[0], 'totals'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(next, 'summary'), false);
});
