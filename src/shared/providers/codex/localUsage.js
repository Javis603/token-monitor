'use strict';

const { extractUsageFromTokscale } = require('../../usage');
const { localDayKey } = require('../../history');
const { createLocalUsageStore } = require('./localUsageStore');

function estimatedCost(usage, pricing) {
  if (!pricing) return { cost: 0, unpricedTokens: usage.total || 0 };
  let cost = 0;
  let unpricedTokens = 0;
  for (const [field, rate] of [
    ['input', 'inputCostPerToken'], ['cacheRead', 'cacheReadInputTokenCost'],
    ['cacheWrite', 'cacheCreationInputTokenCost'], ['output', 'outputCostPerToken']
  ]) {
    if (!usage[field]) continue;
    if (!Number.isFinite(pricing[rate]) || pricing[rate] < 0) unpricedTokens += usage[field];
    else cost += usage[field] * pricing[rate];
  }
  return { cost, unpricedTokens };
}

function buildLocalUsageView(rows, options = {}) {
  const now = new Date(options.now || Date.now());
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const since = Date.parse(options.allTimeSince || '') || 0;
  const nativeIds = new Set();
  for (const session of Object.values(options.nativePeriod?.sessions || {})) {
    if (session.client !== 'codex') continue;
    for (const id of String(session.sessionId || '').match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) || []) nativeIds.add(id);
  }
  const entries = [];
  const metadata = new Map();
  const days = new Map();
  for (const row of rows) {
    if (nativeIds.has(row.threadId) || row.nativeBacked === true) continue;
    const at = Date.parse(row.observedAt);
    if (!Number.isFinite(at) || at > now.getTime()) continue;
    const estimate = estimatedCost(row.usage, row.model === 'unknown' ? null : options.pricingByModel?.[row.model.toLowerCase()]);
    const cost = estimate.cost;
    const entry = {
      client: 'codex', provider: 'openai', sessionId: row.threadId, model: row.model,
      ...row.usage, output: row.usage.output - row.usage.reasoning,
      cost, ...(estimate.unpricedTokens > 0 ? { unpricedTokens: estimate.unpricedTokens } : {}), messageCount: 1, sessionTitle: row.title,
      startedAt: row.observedAt, lastUsedAt: row.observedAt,
      ...(options.projectsEnabled !== false ? options.projectIdentity(row.cwd) : {})
    };
    // The shared Tokscale decoder expects disjoint Codex output/reasoning.
    // Convert the RPC's inclusive output once before entering that decoder.
    delete entry.total;
    entries.push(entry);
    metadata.set(row.threadId, row);
    const date = localDayKey(new Date(at));
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const day = days.get(date);
    let model = day.clients.find((item) => item.modelId === row.model);
    if (!model) {
      model = { client: 'codex', modelId: row.model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 0 };
      day.clients.push(model);
    }
    for (const key of Object.keys(model.tokens)) model.tokens[key] += key === 'output'
      ? row.usage.output - row.usage.reasoning : row.usage[key];
    model.cost += cost;
    if (estimate.unpricedTokens > 0) model.unpricedTokens = (model.unpricedTokens || 0) + estimate.unpricedTokens;
    model.messages += 1;
  }
  function period(start) {
    const result = extractUsageFromTokscale({ entries: entries.filter((entry) => Date.parse(entry.lastUsedAt) >= start) });
    for (const session of Object.values(result.sessions)) {
      const row = metadata.get(session.sessionId);
      session.usageSource = 'codex-dots-local';
      session.usageCoverage = 'observed-only';
      session.turnEnded = row.turnEnded === true;
      session.contextTokens = row.contextTokens || 0;
      session.contextWindow = row.contextWindow || 0;
    }
    return result;
  }
  return {
    today: period(todayStart), month: period(monthStart), allTime: period(since),
    graph: { contributions: [...days.values()] },
    sessionKeys: [...metadata.keys()].map((id) => `codex:${id}`)
  };
}

async function readLocalUsageView(options = {}) {
  const store = options.store || createLocalUsageStore(options);
  try {
    const rows = store.rows();
    const pricingByModel = rows.length && options.resolvePricing ? await options.resolvePricing(rows) : {};
    return buildLocalUsageView(rows, { ...options, pricingByModel });
  } finally {
    if (!options.store) store.close();
  }
}

const pricingCache = new Map();
const MAX_PRICING_LOOKUPS_PER_TICK = 4;
let pricingCursor = 0;
async function resolveLocalUsagePricing(rows, options = {}) {
  const result = {};
  const models = [...new Set(rows.map((row) => row.model.toLowerCase()))];
  const pending = [];
  for (const [index, model] of models.entries()) {
    if (model === 'unknown') { result[model] = null; continue; }
    const key = `${options.pricingRevision || ''}:${model}`;
    const cached = pricingCache.get(key);
    if (!cached || cached.until <= Date.now()) {
      result[model] = null;
      pending.push({ model, key, index });
    } else {
      result[model] = cached.pricing;
    }
  }
  // Keep serial catalog subprocesses bounded without delaying native scans for
  // every historical model. Rotate through pending models so failures, expiry
  // and cache eviction cannot starve later models on subsequent ticks.
  const start = pricingCursor % (models.length || 1);
  pending.sort((a, b) => (a.index - start + models.length) % models.length
    - (b.index - start + models.length) % models.length);
  for (const { model, key, index } of pending.slice(0, MAX_PRICING_LOOKUPS_PER_TICK)) {
    pricingCursor = index + 1;
    let pricing = null;
    try { pricing = (await options.lookupModelPricing(model, options.commandTimeoutMs || 1500))?.pricing || null; } catch (_) { /* Usage remains valid without a price. */ }
    pricingCache.set(key, { pricing, until: Date.now() + (pricing ? 300000 : 30000) });
    if (pricingCache.size > 256) pricingCache.delete(pricingCache.keys().next().value);
    result[model] = pricing;
  }
  return result;
}

// Details carry request buckets through the worker, then resolve prices in main
// with the same injected catalog lookup. No session-wide proportional split.
async function priceLocalSessionDetail(detail, options = {}) {
  if (detail?.usageSource !== 'codex-dots-local') return detail;
  const models = [...new Set((detail.exchanges || []).flatMap((ex) => ex.turns || [])
    .map((turn) => String(turn.model || 'unknown').toLowerCase()))];
  const prices = new Map();
  // Bound the work when opening unusually large multi-model sessions. Omitted
  // models remain unpriced rather than blocking or borrowing another rate.
  for (const model of models.filter((id) => id !== 'unknown').slice(0, 16)) {
    let pricing = null;
    try { pricing = (await options.lookupModelPricing?.(model, 1500))?.pricing || null; } catch (_) { /* Explicitly unpriced. */ }
    prices.set(model, pricing);
  }
  let knownCost = 0;
  let unpricedTokens = 0;
  for (const ex of detail.exchanges || []) {
    ex.costEstimate = 0;
    delete ex.unpricedTokens;
    for (const turn of ex.turns || []) {
      const estimate = estimatedCost(turn.tokens || {}, prices.get(String(turn.model || 'unknown').toLowerCase()));
      turn.costEstimate = estimate.cost;
      delete turn.unpricedTokens;
      if (estimate.unpricedTokens > 0) {
        turn.unpricedTokens = estimate.unpricedTokens;
        ex.unpricedTokens = (ex.unpricedTokens || 0) + turn.unpricedTokens;
      }
      ex.costEstimate += turn.costEstimate;
    }
    knownCost += ex.costEstimate;
    unpricedTokens += ex.unpricedTokens || 0;
  }
  detail.totals.costUsd = knownCost;
  delete detail.totals.unpricedTokens;
  if (unpricedTokens > 0) detail.totals.unpricedTokens = unpricedTokens;
  return detail;
}

module.exports = { buildLocalUsageView, readLocalUsageView, resolveLocalUsagePricing, priceLocalSessionDetail };
