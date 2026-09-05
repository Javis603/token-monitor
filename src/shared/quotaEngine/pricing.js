'use strict';

// API-equivalent pricing is intentionally separate from tokscale's `costUsd`.
// It prices only observed, row-level model/category tokens and is never an
// invoice or a subscription/quota calculation.
const TOKEN_CATEGORIES = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);
const ALL_CATEGORIES = Object.freeze([...TOKEN_CATEGORIES, 'unclassified']);
const PRICING_SNAPSHOT_VERSION = 3;
const INCONSISTENT_COMPONENT_DELTA_REASON = 'inconsistent-component-delta';
const LEGACY_COMPONENT_BASELINE_REASON = 'legacy-component-baseline';
const STANDARD_SHORT_CONTEXT_ASSUMPTION_ID = 'standard-short-context-api-equivalent';
const STANDARD_SHORT_CONTEXT_ASSUMPTION_SUMMARY = [
  'Counterfactual standard, short-context public API equivalent.',
  'Not an invoice, subscription charge, or official billed cost.',
  'Uses the standard (not batch, flex, priority, or fast) list price.',
  'OpenAI short context is ≤272K input tokens.'
].join(' ');

// Official pages checked through 2026-09-05. Sparse on purpose: unknown model ids stay
// unpriced rather than inheriting a family rate through a fuzzy prefix match. Only the
// OpenAI/Codex models this Codex quota feature actually prices are listed; other
// providers stay unpriced until a wired adapter needs them.
const DEFAULT_API_PRICING_SNAPSHOT = Object.freeze({
  version: PRICING_SNAPSHOT_VERSION,
  snapshotId: 'public-api-2026-09-05-v6',
  sourceId: 'openai-public-api-pricing-2026-09-05-v6',
  verifiedAt: '2026-09-05',
  effectiveFrom: '2026-09-05',
  assumption: {
    id: STANDARD_SHORT_CONTEXT_ASSUMPTION_ID,
    summary: STANDARD_SHORT_CONTEXT_ASSUMPTION_SUMMARY
  },
  sources: [
    { provider: 'openai', url: 'https://developers.openai.com/api/docs/pricing', version: 'public pricing checked 2026-08-25' },
    { provider: 'openai', url: 'https://developers.openai.com/api/docs/models/gpt-6-astra', version: 'model page checked 2026-09-05' },
    { provider: 'openai', url: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol', version: 'model alias checked 2026-08-25' },
    { provider: 'openai', url: 'https://developers.openai.com/api/docs/models/gpt-5.3-codex', version: 'model page checked 2026-08-25' },
    { provider: 'openai', url: 'https://developers.openai.com/api/docs/models/gpt-5.4', version: 'model page checked 2026-08-25' }
  ],
  models: {
    openai: {
      // Standard / short-context columns. Cache writes are listed only where
      // the official table has a numeric price rather than "-".
      'gpt-6-astra': { aliases: [], prices: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
      'gpt-5.6-sol': { aliases: ['gpt-5.6'], prices: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } },
      'gpt-5.6-terra': { aliases: [], prices: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 } },
      'gpt-5.6-luna': { aliases: [], prices: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 } },
      'gpt-5.5': { aliases: [], prices: { input: 5, output: 30, cacheRead: 0.5 } },
      'gpt-5.4': { aliases: [], prices: { input: 2.5, output: 15, cacheRead: 0.25 } },
      'gpt-5.4-mini': { aliases: [], prices: { input: 0.75, output: 4.5, cacheRead: 0.075 } },
      'gpt-5.4-nano': { aliases: [], prices: { input: 0.2, output: 1.25, cacheRead: 0.02 } },
      'gpt-5.3-codex': { aliases: [], prices: { input: 1.75, output: 14, cacheRead: 0.175 } },
      'gpt-5': { aliases: ['gpt-5-2025-08-07'], prices: { input: 1.25, output: 10, cacheRead: 0.125 } },
      'gpt-5-mini': { aliases: [], prices: { input: 0.25, output: 2, cacheRead: 0.025 } },
      'gpt-5-nano': { aliases: [], prices: { input: 0.05, output: 0.4, cacheRead: 0.005 } }
    }
  },
  reference: { provider: 'openai', model: 'gpt-5', category: 'input' }
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cleanId(value, max = 160) {
  return String(value || '').trim().toLowerCase().slice(0, max);
}

function normalizeCategory(value) {
  const raw = cleanId(value, 32);
  return ({
    input: 'input',
    output: 'output',
    cacheread: 'cacheRead',
    cachewrite: 'cacheWrite',
    unclassified: 'unclassified'
  })[raw] || '';
}

function validDate(value) {
  if (typeof value !== 'string') return '';
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().slice(0, 500);
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function normalizeAssumption(value) {
  if (!value || typeof value !== 'object') return null;
  const id = cleanId(value.id, 80);
  const summary = String(value.summary || '').trim().slice(0, 500);
  if (!id || !summary) return null;
  return { id, summary };
}

function normalizePricingSnapshot(input) {
  const source = input && typeof input === 'object' ? input : {};
  const snapshotId = String(source.snapshotId || '').trim().slice(0, 120);
  const sourceId = String(source.sourceId || '').trim().slice(0, 160);
  const verifiedAt = validDate(source.verifiedAt);
  const effectiveFrom = validDate(source.effectiveFrom);
  if (!snapshotId || !sourceId || !verifiedAt || !effectiveFrom) return null;
  const models = {};
  for (const [rawProvider, rawModels] of Object.entries(source.models || {})) {
    const provider = cleanId(rawProvider, 48);
    if (!provider || !rawModels || typeof rawModels !== 'object') continue;
    const destination = {};
    for (const [rawModel, rawEntry] of Object.entries(rawModels)) {
      const model = cleanId(rawModel);
      if (!model || !rawEntry || typeof rawEntry !== 'object') continue;
      const prices = {};
      for (const category of TOKEN_CATEGORIES) {
        const price = finite(rawEntry.prices?.[category]);
        if (price !== null && price > 0) prices[category] = price;
      }
      if (Object.keys(prices).length === 0) continue;
      destination[model] = {
        aliases: [...new Set((Array.isArray(rawEntry.aliases) ? rawEntry.aliases : [])
          .map((alias) => cleanId(alias)).filter(Boolean))],
        prices
      };
    }
    if (Object.keys(destination).length) models[provider] = destination;
  }
  const sources = (Array.isArray(source.sources) ? source.sources : []).map((entry) => ({
    provider: cleanId(entry?.provider, 48),
    url: safeHttpsUrl(entry?.url),
    version: typeof entry?.version === 'string' ? entry.version.trim().slice(0, 160) : ''
  })).filter((entry) => entry.provider && entry.url);
  if (!sources.length) return null;
  const reference = source.reference && typeof source.reference === 'object' ? {
    provider: cleanId(source.reference.provider, 48),
    model: cleanId(source.reference.model),
    category: normalizeCategory(source.reference.category)
  } : null;
  const assumption = normalizeAssumption(source.assumption);
  return {
    version: Number.isInteger(Number(source.version)) ? Number(source.version) : PRICING_SNAPSHOT_VERSION,
    snapshotId,
    sourceId,
    verifiedAt,
    effectiveFrom,
    sources,
    models,
    ...(reference ? { reference } : {}),
    ...(assumption ? { assumption } : {})
  };
}

function providerForClient(client) {
  // Only clients with a wired adapter are mapped; an unmapped client keeps
  // its own (unpriced) provider name.
  return ({ codex: 'openai' })[cleanId(client, 48)] || '';
}

function resolveModel(snapshot, provider, model) {
  const providerModels = snapshot?.models?.[provider];
  const requested = cleanId(model);
  if (!providerModels || !requested) return null;
  if (providerModels[requested]) return { model: requested, entry: providerModels[requested] };
  for (const [canonical, entry] of Object.entries(providerModels)) {
    if (entry.aliases.includes(requested)) return { model: canonical, entry };
  }
  return null;
}

function lookupPrice(snapshotValue, providerValue, modelValue, categoryValue) {
  const snapshot = normalizePricingSnapshot(snapshotValue);
  const provider = cleanId(providerValue, 48);
  const category = normalizeCategory(categoryValue);
  if (!snapshot || !TOKEN_CATEGORIES.includes(category)) return null;
  const resolved = resolveModel(snapshot, provider, modelValue);
  const unitPriceUsdPerMillion = resolved?.entry.prices[category];
  return unitPriceUsdPerMillion > 0 ? {
    provider,
    requestedModel: cleanId(modelValue),
    model: resolved.model,
    category,
    unitPriceUsdPerMillion,
    snapshotId: snapshot.snapshotId
  } : null;
}

function roundedMoney(value) {
  return Number(value.toFixed(12));
}

function emptyEstimate(snapshot) {
  return {
    snapshotId: snapshot?.snapshotId || null,
    apiEquivalentCostUsd: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    referenceEquivalentTokens: null,
    observedUnitCostUsd: null,
    observedUnitCostUsdPerMillion: null,
    pricingCoverage: null,
    lineItems: [],
    ...(snapshot?.assumption ? { assumption: snapshot.assumption } : {})
  };
}

function unpricedReason(snapshot, provider, model, category) {
  if (category === 'unclassified') return 'unclassified-category';
  return resolveModel(snapshot, provider, model) ? 'category-unpriced' : 'model-unpriced';
}

function pushUnpriced(estimate, item) {
  estimate.unpricedTokens += item.tokens;
  const entry = {
    provider: item.provider,
    model: item.model,
    category: item.category,
    tokens: item.tokens,
    amountUsd: null,
    snapshotId: estimate.snapshotId,
    reason: item.reason
  };
  estimate.lineItems.push(entry);
}

function finishEstimate(estimate, snapshot) {
  const denominator = estimate.pricedTokens + estimate.unpricedTokens;
  estimate.pricingCoverage = denominator ? estimate.pricedTokens / denominator : null;
  if (estimate.pricedTokens) {
    estimate.observedUnitCostUsd = roundedMoney(estimate.apiEquivalentCostUsd / estimate.pricedTokens);
    estimate.observedUnitCostUsdPerMillion = roundedMoney(estimate.observedUnitCostUsd * 1000000);
  }
  const reference = snapshot?.reference;
  const referencePrice = reference && lookupPrice(snapshot, reference.provider, reference.model, reference.category);
  if (referencePrice) {
    estimate.reference = {
      provider: referencePrice.provider,
      model: referencePrice.model,
      category: referencePrice.category,
      unitPriceUsdPerMillion: referencePrice.unitPriceUsdPerMillion,
      snapshotId: snapshot.snapshotId
    };
    estimate.referenceEquivalentTokens = (estimate.apiEquivalentCostUsd * 1000000) / referencePrice.unitPriceUsdPerMillion;
  }
  if (snapshot?.assumption) estimate.assumption = snapshot.assumption;
  return estimate;
}

function usageTokenSum(usage, field) {
  const map = usage?.[field];
  if (!map || typeof map !== 'object') return 0;
  let sum = 0;
  for (const value of Object.values(map)) {
    if (field === 'tokenComponents' && value && typeof value === 'object') {
      for (const category of ALL_CATEGORIES) sum += Math.max(0, Math.round(finite(value[category]) || 0));
    } else {
      sum += Math.max(0, Math.round(finite(value) || 0));
    }
  }
  return sum;
}

function trustedUsageTokens(usage) {
  const explicit = Math.max(0, Math.round(finite(usage?.totalTokens) || 0));
  if (usage?.inconsistentComponentDelta === true || usage?.legacyComponentBaseline === true) return explicit;
  const modelSum = usageTokenSum(usage, 'models');
  if (explicit > 0) return explicit;
  if (modelSum > 0) return modelSum;
  return usageTokenSum(usage, 'tokenComponents');
}

function unpriceTrustedTotal(estimate, provider, snapshot, tokens, reason) {
  estimate.apiEquivalentCostUsd = 0;
  estimate.pricedTokens = 0;
  estimate.unpricedTokens = 0;
  estimate.lineItems = [];
  if (tokens) {
    pushUnpriced(estimate, {
      provider,
      model: '',
      category: 'unclassified',
      tokens,
      reason
    });
  }
  return finishEstimate(estimate, snapshot);
}

function priceLegacyComponentBaseline(usage, provider, snapshot, estimate) {
  return unpriceTrustedTotal(
    estimate,
    provider,
    snapshot,
    trustedUsageTokens(usage),
    LEGACY_COMPONENT_BASELINE_REASON
  );
}

function priceTokenComponents(usage, options = {}) {
  const snapshot = normalizePricingSnapshot(options.snapshot || DEFAULT_API_PRICING_SNAPSHOT);
  const estimate = emptyEstimate(snapshot);
  if (!snapshot) return estimate;
  const requestedProvider = cleanId(options.provider || options.client, 48);
  const provider = providerForClient(requestedProvider) || requestedProvider;
  const trusted = trustedUsageTokens(usage);
  const explicitTotal = Math.max(0, Math.round(finite(usage?.totalTokens) || 0));
  if (
    usage?.inconsistentComponentDelta === true
    || (explicitTotal > 0 && (
      usageTokenSum(usage, 'models') > explicitTotal
      || usageTokenSum(usage, 'tokenComponents') > explicitTotal
    ))
  ) {
    return unpriceTrustedTotal(estimate, provider, snapshot, trusted, INCONSISTENT_COMPONENT_DELTA_REASON);
  }
  if (usage?.legacyComponentBaseline === true) {
    return priceLegacyComponentBaseline(usage, provider, snapshot, estimate);
  }
  const componentsByModel = usage?.tokenComponents && typeof usage.tokenComponents === 'object'
    ? usage.tokenComponents : {};
  const modelTotals = usage?.models && typeof usage.models === 'object' ? usage.models : {};
  for (const [rawModel, rawComponent] of Object.entries(componentsByModel)) {
    const model = cleanId(rawModel);
    const component = rawComponent && typeof rawComponent === 'object' ? rawComponent : {};
    const observedTotal = Math.max(0, Math.round(finite(modelTotals[rawModel]) || 0));
    const pending = [];
    let accounted = 0;
    for (const category of ALL_CATEGORIES) {
      const tokens = Math.max(0, Math.round(finite(component[category]) || 0));
      if (!tokens) continue;
      accounted += tokens;
      pending.push({ category, tokens });
    }
    if (observedTotal > 0 && accounted > observedTotal) {
      pushUnpriced(estimate, {
        provider,
        model,
        category: 'unclassified',
        tokens: observedTotal,
        reason: 'malformed-row'
      });
      continue;
    }
    for (const { category, tokens } of pending) {
      const price = category === 'unclassified' ? null : lookupPrice(snapshot, provider, model, category);
      if (!price) {
        pushUnpriced(estimate, {
          provider,
          model,
          category,
          tokens,
          reason: unpricedReason(snapshot, provider, model, category)
        });
        continue;
      }
      const amountUsd = roundedMoney((tokens * price.unitPriceUsdPerMillion) / 1000000);
      estimate.pricedTokens += tokens;
      estimate.apiEquivalentCostUsd = roundedMoney(estimate.apiEquivalentCostUsd + amountUsd);
      estimate.lineItems.push({
        provider,
        model,
        canonicalModel: price.model,
        category,
        tokens,
        unitPriceUsdPerMillion: price.unitPriceUsdPerMillion,
        amountUsd,
        snapshotId: snapshot.snapshotId
      });
    }
    if (observedTotal > accounted) {
      pushUnpriced(estimate, {
        provider,
        model,
        category: 'unclassified',
        tokens: observedTotal - accounted,
        reason: 'incomplete-provenance'
      });
    }
  }
  for (const [rawModel, totalValue] of Object.entries(modelTotals)) {
    if (Object.hasOwn(componentsByModel, rawModel)) continue;
    const tokens = Math.max(0, Math.round(finite(totalValue) || 0));
    if (!tokens) continue;
    pushUnpriced(estimate, {
      provider,
      model: cleanId(rawModel),
      category: 'unclassified',
      tokens,
      reason: 'incomplete-provenance'
    });
  }
  const accounted = estimate.pricedTokens + estimate.unpricedTokens;
  if (trusted > 0 && accounted > trusted) {
    return unpriceTrustedTotal(estimate, provider, snapshot, trusted, INCONSISTENT_COMPONENT_DELTA_REASON);
  }
  if (trusted > accounted) {
    pushUnpriced(estimate, {
      provider,
      model: '',
      category: 'unclassified',
      tokens: trusted - accounted,
      reason: 'incomplete-provenance'
    });
  }
  return finishEstimate(estimate, snapshot);
}

function snapshotPublicMeta(snapshotValue) {
  const snapshot = normalizePricingSnapshot(snapshotValue);
  if (!snapshot) return null;
  return {
    snapshotId: snapshot.snapshotId,
    sourceId: snapshot.sourceId,
    verifiedAt: snapshot.verifiedAt,
    effectiveFrom: snapshot.effectiveFrom,
    sources: snapshot.sources,
    ...(snapshot.assumption ? { assumption: snapshot.assumption } : {}),
    ...(snapshot.reference ? { reference: snapshot.reference } : {})
  };
}

module.exports = {
  ALL_CATEGORIES,
  DEFAULT_API_PRICING_SNAPSHOT,
  INCONSISTENT_COMPONENT_DELTA_REASON,
  LEGACY_COMPONENT_BASELINE_REASON,
  PRICING_SNAPSHOT_VERSION,
  STANDARD_SHORT_CONTEXT_ASSUMPTION_ID,
  TOKEN_CATEGORIES,
  lookupPrice,
  normalizePricingSnapshot,
  priceTokenComponents,
  providerForClient,
  snapshotPublicMeta
};
