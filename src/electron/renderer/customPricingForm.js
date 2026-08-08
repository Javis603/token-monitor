'use strict';

(function exposeCustomPricingForm(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCustomPricingForm = api;
})(typeof window !== 'undefined' ? window : null, function createCustomPricingFormApi() {
  function inUseModelIds(stats) {
    const periods = (stats && stats.periods) || {};
    const ids = new Set();
    for (const key of ['today', 'month', 'allTime']) {
      const models = periods[key] && periods[key].models;
      if (models && typeof models === 'object') {
        for (const id of Object.keys(models)) ids.add(id);
      }
    }
    return [...ids].sort();
  }

  function toPerMillion(value) {
    if (value === null || value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    return Number((n * 1e6).toFixed(6));
  }

  function perMillionFromPricing(result) {
    const p = (result && result.pricing) || {};
    return {
      inputPerM: toPerMillion(p.inputCostPerToken),
      outputPerM: toPerMillion(p.outputCostPerToken),
      cacheReadPerM: toPerMillion(p.cacheReadInputTokenCost)
    };
  }

  function upsertOverride(list, entry) {
    const arr = Array.isArray(list) ? list.slice() : [];
    const i = arr.findIndex((e) => e && e.modelId === entry.modelId);
    if (i >= 0) arr[i] = entry;
    else arr.push(entry);
    return arr;
  }

  function removeOverride(list, modelId) {
    return (Array.isArray(list) ? list : []).filter((e) => e && e.modelId !== modelId);
  }

  function hasUsableBasePrice(entry) {
    const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    return valid(entry?.inputPerM) || valid(entry?.outputPerM);
  }

  return { inUseModelIds, perMillionFromPricing, upsertOverride, removeOverride, hasUsableBasePrice };
});
