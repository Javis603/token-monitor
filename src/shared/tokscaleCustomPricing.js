'use strict';

const { readJson, writeJsonAtomic } = require('./config');

const INVALID_UNIT_PRICE = Symbol('invalid custom pricing value');

// '' / null / undefined => unset (undefined). Finite numbers >= 0 are accepted
// (0 = explicit free). Other provided values are invalid, not unset.
function toUnitPrice(value) {
  if (value === '' || value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID_UNIT_PRICE;
  return value;
}

// Array<{modelId,inputPerM,outputPerM,cacheReadPerM}> -> cleaned array.
// Mirrors tokscale's rule: at least one of input/output must be present.
// A present zero is an explicit free price; undefined means unset.
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
    if ([inputPerM, outputPerM, cacheReadPerM].includes(INVALID_UNIT_PRICE)) continue;
    if (inputPerM === undefined && outputPerM === undefined) continue;
    byId.set(modelId, { modelId, inputPerM, outputPerM, cacheReadPerM });
  }
  return [...byId.values()];
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
  buildTokscaleModels,
  mergeManaged,
  applyCustomPricing
};
