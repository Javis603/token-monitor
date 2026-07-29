'use strict';

const { readJson, writeJsonAtomic } = require('./config');

const TOKENS_PER_MILLION = 1_000_000;

// '' / null / undefined => unset (undefined). Numbers >= 0 accepted (0 = explicit free).
// Negative / NaN => unset.
function toUnitPrice(value) {
  if (value === '' || value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function isPositive(n) {
  return typeof n === 'number' && n > 0;
}

// Array<{modelId,inputPerM,outputPerM,cacheReadPerM}> -> cleaned array.
// Mirrors tokscale's rule: at least one of input/output must be present and positive.
function normalizeCustomPricingSetting(value) {
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
    if (!modelId) continue;
    const inputPerM = toUnitPrice(raw.inputPerM);
    const outputPerM = toUnitPrice(raw.outputPerM);
    const cacheReadPerM = toUnitPrice(raw.cacheReadPerM);
    if (!(isPositive(inputPerM) || isPositive(outputPerM))) continue;
    byId.set(modelId, { modelId, inputPerM, outputPerM, cacheReadPerM });
  }
  return [...byId.values()];
}

// Build an App-side row cost resolver from the GUI setting. Tokscale treats
// provider-reported costs as authoritative for some clients, so writing its
// custom-pricing.json alone cannot guarantee an override. This resolver mirrors
// tokscale's pricing buckets and is applied before Token Monitor aggregates the
// row into periods, models, clients, and sessions.
function createCustomPricingCostResolver(settingValue) {
  const byModel = new Map();
  for (const entry of normalizeCustomPricingSetting(settingValue)) {
    byModel.set(entry.modelId.toLowerCase(), entry);
  }
  if (byModel.size === 0) return null;

  return ({ model, input = 0, output = 0, cacheRead = 0, reasoning = 0 } = {}) => {
    const modelId = String(model || '').trim().toLowerCase();
    const pricing = byModel.get(modelId);
    if (!pricing) return undefined;
    const inputTokens = Math.max(0, Number(input) || 0);
    const outputTokens = Math.max(0, Number(output) || 0);
    const cacheReadTokens = Math.max(0, Number(cacheRead) || 0);
    const reasoningTokens = Math.max(0, Number(reasoning) || 0);
    return (
      inputTokens * (pricing.inputPerM ?? 0)
      + (outputTokens + reasoningTokens) * (pricing.outputPerM ?? 0)
      + cacheReadTokens * (pricing.cacheReadPerM ?? 0)
    ) / TOKENS_PER_MILLION;
  };
}

// Cleaned entries -> tokscale `models` map (per-million keys), omitting unset fields.
function buildTokscaleModels(entries) {
  const models = {};
  for (const e of entries) {
    const m = {};
    if (e.inputPerM !== undefined) m.input_cost_per_million_tokens = e.inputPerM;
    if (e.outputPerM !== undefined) m.output_cost_per_million_tokens = e.outputPerM;
    if (e.cacheReadPerM !== undefined) m.cache_read_input_token_cost_per_million_tokens = e.cacheReadPerM;
    models[e.modelId] = m;
  }
  return models;
}

// Merge our managed models into the existing file's models, preserving entries
// the user hand-added and dropping managed ids we no longer own.
function mergeManaged(existingModels, managedModels, previousManagedIds) {
  const result = { ...(existingModels || {}) };
  for (const id of previousManagedIds || []) {
    if (!Object.prototype.hasOwnProperty.call(managedModels, id)) delete result[id];
  }
  Object.assign(result, managedModels);
  return { models: result, managedIds: Object.keys(managedModels) };
}

// Orchestrate: read existing file + sidecar, merge, write both atomically.
// No-op (creates nothing) when there are no overrides and no prior state, so a
// fresh install with no overrides never litters tokscale's config dir.
function applyCustomPricing(settingValue, { pricingPath, sidecarPath }) {
  const managedModels = buildTokscaleModels(normalizeCustomPricingSetting(settingValue));

  const existing = readJson(pricingPath, null);
  const existingModels = (existing && typeof existing === 'object' && existing.models && typeof existing.models === 'object')
    ? existing.models
    : {};

  const sidecar = readJson(sidecarPath, null);
  const previousManagedIds = (sidecar && Array.isArray(sidecar.managedIds)) ? sidecar.managedIds : [];

  if (Object.keys(managedModels).length === 0 && previousManagedIds.length === 0 && existing === null) {
    return { models: {}, managedIds: [] };
  }

  const { models, managedIds } = mergeManaged(existingModels, managedModels, previousManagedIds);

  writeJsonAtomic(pricingPath, { models });
  writeJsonAtomic(sidecarPath, { version: 1, managedIds });
  return { models, managedIds };
}

module.exports = {
  normalizeCustomPricingSetting,
  createCustomPricingCostResolver,
  buildTokscaleModels,
  mergeManaged,
  applyCustomPricing
};
