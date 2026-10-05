'use strict';

const { extractUsageFromTokscale } = require('../../usage');
const { localDayKey } = require('../../history');
const { createLocalUsageStore } = require('./localUsageStore');

function estimatedCost(usage, pricing) {
  if (!pricing) return null;
  let cost = 0;
  for (const [field, rate] of [
    ['input', 'inputCostPerToken'], ['cacheRead', 'cacheReadInputTokenCost'],
    ['cacheWrite', 'cacheCreationInputTokenCost'], ['output', 'outputCostPerToken']
  ]) {
    if (!usage[field]) continue;
    if (!Number.isFinite(pricing[rate]) || pricing[rate] < 0) return null;
    cost += usage[field] * pricing[rate];
  }
  return cost;
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
    const cost = estimate ?? 0;
    const entry = {
      client: 'codex', provider: 'openai', sessionId: row.threadId, model: row.model,
      ...row.usage, output: row.usage.output - row.usage.reasoning,
      cost, ...(estimate === null ? { unpricedTokens: row.usage.total } : {}), messageCount: 1, sessionTitle: row.title,
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
    if (estimate === null) model.unpricedTokens = (model.unpricedTokens || 0) + row.usage.total;
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
async function resolveLocalUsagePricing(rows, options = {}) {
  const result = {};
  const models = [...new Set(rows.map((row) => row.model.toLowerCase()))];
  for (const model of models) {
    if (model === 'unknown') { result[model] = null; continue; }
    const key = `${options.pricingRevision || ''}:${model}`;
    let cached = pricingCache.get(key);
    if (!cached || cached.until <= Date.now()) {
      let pricing = null;
      try { pricing = (await options.lookupModelPricing(model, options.commandTimeoutMs || 1500))?.pricing || null; } catch (_) { /* Usage remains valid without a price. */ }
      cached = { pricing, until: Date.now() + (pricing ? 300000 : 30000) };
      pricingCache.set(key, cached);
      if (pricingCache.size > 256) pricingCache.delete(pricingCache.keys().next().value);
    }
    result[model] = cached.pricing;
  }
  return result;
}

module.exports = { buildLocalUsageView, readLocalUsageView, resolveLocalUsagePricing };
