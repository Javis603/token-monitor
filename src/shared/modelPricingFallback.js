'use strict';

// Bundled list rates for first-party models that ship before the pricing
// catalogs tokscale reads (LiteLLM, OpenRouter, models.dev) carry them.
//
// tokscale keeps every usage row it cannot price and reports it at `cost: 0`,
// so a model in its first days shows tokens but no money everywhere in Token
// Monitor — Claude Fable 5.1 landed with a bare `claude-fable-5-1` key in none
// of the three catalogs. This module fills exactly that hole: a row is
// re-costed from the rates below only when tokscale returned $0 for it, so the
// table is inert the moment a catalog prices the model, and it never competes
// with tokscale's own resolution or with a price the user set.
//
// Keep the table honest rather than complete:
// - only first-party ids billed at the vendor's published list price; the
//   `provider` tokscale attaches to a row is inferred from the model name, so
//   a row is not proof the tokens went through that vendor's API, and a
//   reseller or subscription id would be priced wrong here;
// - one rate per model regardless of context length — a model with a
//   long-context premium tier does not belong here, because a row does not say
//   which tier it was billed at;
// - rates are USD per million tokens, cross-checked against the catalog rows
//   for the same model on other providers when they exist. `cacheWritePerM` is
//   the 5-minute cache-write rate, which is the only one the catalogs carry
//   and therefore the one tokscale itself applies (a 1-hour write bills 2× and
//   is under-costed by both alike);
// - bump FALLBACK_PRICING_REVISION with every edit (see below);
// - a row can be dropped once LiteLLM carries the bare key (it no longer does
//   anything by then), but leaving it costs nothing.
const FALLBACK_MODEL_PRICING = Object.freeze({
  anthropic: Object.freeze({
    // Claude Fable 5.1 (2026-08): OpenRouter spells it `anthropic/claude-fable-5.1`
    // and models.dev `anthropic/claude-fable-5-1`, both at these rates; LiteLLM
    // has no key at all. Cache reads are $0.25/M, not the 10% ($1.00/M) of Fable 5.
    'claude-fable-5-1': Object.freeze({ inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5 })
  })
});

// Folded into the collector's anchor fingerprint: a persisted month/allTime
// anchor was costed under the table of the build that wrote it, and a warm
// tick derives from it by delta, so an edit here has to force one full scan
// or the broader periods keep the old $0 until the hourly rescan. The guard
// test pins the table to this number so an edit cannot forget the bump.
const FALLBACK_PRICING_REVISION = 1;

const RATE_FIELDS = ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'];

function canonicalFallbackProvider(value) {
  return String(value || '').trim().toLowerCase();
}

// Claude Code decorates the wire id in two ways that name the same price:
// `[1m]` for a 1M-context session and a `-YYYYMMDD` dated snapshot suffix
// (`claude-haiku-4-5-20251001` is how it records Haiku 4.5).
function canonicalFallbackModelId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');
}

function fallbackModelPricing(provider, model) {
  const rates = FALLBACK_MODEL_PRICING[canonicalFallbackProvider(provider)];
  if (!rates) return null;
  return rates[canonicalFallbackModelId(model)] || null;
}

function nonNegative(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// tokscale's scan rows carry the components flat (`input`, `cacheRead`, …);
// its graph rows nest the same names under `tokens`.
function rowTokenComponents(row) {
  const source = row.tokens && typeof row.tokens === 'object' ? row.tokens : row;
  return {
    input: nonNegative(source.input),
    output: nonNegative(source.output),
    cacheRead: nonNegative(source.cacheRead),
    cacheWrite: nonNegative(source.cacheWrite)
  };
}

function fallbackCostForTokens(rates, tokens) {
  const perMillion = (count, rate) => (count * rate) / 1e6;
  return perMillion(tokens.input, rates.inputPerM)
    + perMillion(tokens.output, rates.outputPerM)
    + perMillion(tokens.cacheRead, rates.cacheReadPerM)
    + perMillion(tokens.cacheWrite, rates.cacheWritePerM);
}

// tokscale 4.15.0 names the vendor `provider` on scan rows and `providerId` on
// graph rows (`tokscale graph` → contributions[].clients[]).
function rowProvider(row) {
  return row.provider ?? row.providerId ?? row.provider_id;
}

function rowModel(row) {
  return row.model ?? row.modelId ?? row.model_id;
}

// tokscale matches custom-pricing.json keys on the lowercased id, exactly, so
// the exclusion mirrors that: a user entry that tokscale would have applied is
// the one that makes a $0 row deliberate. Widening the match (to `[1m]` or a
// dated suffix) would leave a bare row priced by neither side.
function isCustomPriced(model, customModelIds) {
  if (!customModelIds || typeof customModelIds.has !== 'function') return false;
  return customModelIds.has(String(model ?? '').toLowerCase());
}

// Returns the re-costed row, or null when the row is not ours to touch: it is
// already priced, names a model outside the table, has no billable tokens, or
// the user priced that model themselves (custom-pricing.json is tokscale's
// first lookup, so a $0 there is "free", not "unknown").
function fallbackPricedRow(row, options = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (nonNegative(row.cost) > 0) return null;
  const model = rowModel(row);
  const rates = fallbackModelPricing(rowProvider(row), model);
  if (!rates) return null;
  if (isCustomPriced(model, options.customModelIds)) return null;
  const cost = fallbackCostForTokens(rates, rowTokenComponents(row));
  if (!(cost > 0)) return null;
  return { ...row, cost };
}

function bumpCost(target, key, delta) {
  const current = typeof target[key] === 'number' && Number.isFinite(target[key]) ? target[key] : 0;
  return { ...target, [key]: current + delta };
}

function applyRows(rows, options) {
  let delta = 0;
  let changed = false;
  const next = rows.map((row) => {
    const priced = fallbackPricedRow(row, options);
    if (!priced) return row;
    changed = true;
    delta += priced.cost - nonNegative(row.cost);
    if (typeof options.onApplied === 'function') {
      options.onApplied({
        provider: canonicalFallbackProvider(rowProvider(row)),
        model: canonicalFallbackModelId(rowModel(row))
      });
    }
    return priced;
  });
  return { rows: changed ? next : rows, delta, changed };
}

// `tokscale --json` scan output: `{ entries: [...], totalCost }`. Returns the
// input untouched (same reference) when nothing needed pricing.
function applyScanPricingFallback(json, options = {}) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.entries)) return json;
  const { rows, delta, changed } = applyRows(json.entries, options);
  if (!changed) return json;
  return bumpCost({ ...json, entries: rows }, 'totalCost', delta);
}

// `tokscale graph` output: `{ summary, contributions: [{ date, totals, clients }] }`.
// The per-day `totals` and `summary` are kept consistent with the rows; nothing
// downstream reads them, but a caller holding the document should not find two
// answers in it.
function applyGraphPricingFallback(json, options = {}) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.contributions)) return json;
  let changed = false;
  let total = 0;
  const contributions = json.contributions.map((contribution) => {
    if (!contribution || typeof contribution !== 'object' || !Array.isArray(contribution.clients)) return contribution;
    const { rows, delta, changed: rowsChanged } = applyRows(contribution.clients, options);
    if (!rowsChanged) return contribution;
    changed = true;
    total += delta;
    const next = { ...contribution, clients: rows };
    if (contribution.totals && typeof contribution.totals === 'object') next.totals = bumpCost(contribution.totals, 'cost', delta);
    return next;
  });
  if (!changed) return json;
  const next = { ...json, contributions };
  if (json.summary && typeof json.summary === 'object') next.summary = bumpCost(json.summary, 'totalCost', total);
  return next;
}

module.exports = {
  FALLBACK_MODEL_PRICING,
  FALLBACK_PRICING_REVISION,
  RATE_FIELDS,
  applyGraphPricingFallback,
  applyScanPricingFallback,
  canonicalFallbackModelId,
  canonicalFallbackProvider,
  fallbackCostForTokens,
  fallbackModelPricing,
  fallbackPricedRow
};
