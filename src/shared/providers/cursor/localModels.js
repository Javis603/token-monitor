'use strict';

// Hooks describe the selected composer configuration, not a per-request bill.
// Keep that distinction in presentation; only structured, matching selections
// can supply an attribution and a catalog-rate estimate for a completed turn.
function explicitModelId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9._/-]{0,159}$/.test(value)
    && !['constructor', 'prototype'].includes(value)
    && !/^(?:(?:cursor-)?(?:auto|default|router|balance|balanced|intelligence|cost)|unknown)(?:$|[-/])/.test(value)
    ? value : '';
}

function hookModelSelection(input) {
  const id = explicitModelId(input.model_id);
  if (!id) return null;
  let priceable = Array.isArray(input.model_params) && input.model_params.length <= 16;
  const params = new Map();
  for (const item of Array.isArray(input.model_params) ? input.model_params.slice(0, 17) : []) {
    if (!item || typeof item.id !== 'string' || typeof item.value !== 'string'
      || params.has(item.id) || !['effort', 'thinking', 'fast', 'context'].includes(item.id)) {
      priceable = false; continue;
    }
    params.set(item.id, item.value);
  }
  const fast = params.get('fast');
  const context = params.get('context');
  if (fast !== undefined && !['true', 'false'].includes(fast)) priceable = false;
  // Grok/Composer defaults can be Fast depending on the subscription. An
  // omitted switch does not prove the standard rate selected for this turn.
  if (/^(?:grok|composer)-/.test(id) && fast === undefined) priceable = false;
  if (context !== undefined && !/^(?:\d+[km]|default)$/.test(context)) priceable = false;
  const model = `${id}${context && context !== 'default' && /^\d+[km]$/.test(context) ? `-${context}` : ''}${fast === 'true' ? '-fast' : ''}`;
  return explicitModelId(model) ? { model, priceable } : null;
}

function mergeModelEvidence(left, right) {
  if (left?.modelConflict || right?.modelConflict
    || (left?.model !== 'unknown' && right?.model !== 'unknown' && left?.model && right?.model && left.model !== right.model)) {
    return { model: 'unknown', priceable: false, modelConflict: true };
  }
  const known = [left, right].filter(row => row?.model && row.model !== 'unknown');
  return known.length ? { model: known[0].model, priceable: known.every(row => row.priceable === true) }
    : { model: 'unknown' };
}

function turnModelEvidence(turn) {
  const start = turn.start?.modelSelection;
  const stop = turn.stop?.modelSelection;
  if (!start || !stop) return { model: 'unknown' };
  return mergeModelEvidence(start, stop);
}

async function selectedModelPricing(model, timeout, lookup) {
  const result = await lookup(model, timeout);
  // A fuzzy fallback can strip '-fast' and return the cheaper base model.
  // Aggregate turn counters also cannot establish per-request context tiers.
  if (result?.resolution?.exactModelIdentity !== true || result.resolution.stripped === true
    || result.resolution.priceConsensus === false
    || Object.entries(result.allRates || {}).some(([key, value]) => /_above_\d/.test(key) && value !== null)) return null;
  return result;
}

module.exports = { explicitModelId, hookModelSelection, mergeModelEvidence, turnModelEvidence, selectedModelPricing };
