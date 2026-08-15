'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { resolveSessionFile } = require('./sessionFiles');

const FAST_CREDIT_MULTIPLIERS = [
  [/^gpt-5\.6(?:-|$)/i, 2.5],
  [/^gpt-5\.5(?:-|$)/i, 2.5],
  [/^gpt-5\.4(?:-|$)/i, 2]
];

const profileCache = new Map();

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizedModel(value) {
  return String(value || '').trim().toLowerCase();
}

function fastCreditMultiplier(model) {
  const id = normalizedModel(model);
  for (const [pattern, multiplier] of FAST_CREDIT_MULTIPLIERS) {
    if (pattern.test(id)) return multiplier;
  }
  return 1;
}

function isFastTier(value) {
  return ['priority', 'fast'].includes(String(value || '').trim().toLowerCase());
}

function emptyComponents() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addUsage(target, usage) {
  const cacheRead = numberValue(usage?.cached_input_tokens);
  target.input += Math.max(0, numberValue(usage?.input_tokens) - cacheRead);
  target.output += numberValue(usage?.output_tokens);
  target.cacheRead += cacheRead;
  target.cacheWrite += numberValue(usage?.cache_creation_input_tokens);
}

function readCodexQuotaEvents(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return null; }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = profileCache.get(filePath);
  if (cached?.key === key) return cached;

  const events = [];
  let model = '';
  let serviceTier = 'default';
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch (_) { continue; }
    const payload = event?.payload;
    if (event?.type === 'turn_context') {
      model = normalizedModel(payload?.model) || model;
      continue;
    }
    if (event?.type !== 'event_msg' || !payload) continue;
    if (payload.type === 'thread_settings_applied') {
      model = normalizedModel(payload.thread_settings?.model) || model;
      serviceTier = String(payload.thread_settings?.service_tier || serviceTier).trim().toLowerCase();
      continue;
    }
    if (payload.type !== 'token_count' || !payload.info?.last_token_usage) continue;
    events.push({
      model: model || 'unknown',
      tier: isFastTier(serviceTier) ? 'fast' : 'standard',
      timestampMs: Date.parse(event.timestamp || payload.timestamp || ''),
      usage: payload.info.last_token_usage
    });
  }
  const value = { key, events };
  profileCache.set(filePath, value);
  return value;
}

function parseCodexQuotaProfile(filePath, options = {}) {
  const source = readCodexQuotaEvents(filePath);
  if (!source) return null;
  const sinceMs = Date.parse(options.since || '');
  const filterByTime = Number.isFinite(sinceMs);
  const byModel = {};
  let incomplete = false;
  for (const event of source.events) {
    if (filterByTime && !Number.isFinite(event.timestampMs)) {
      incomplete = true;
      continue;
    }
    if (filterByTime && event.timestampMs < sinceMs) continue;
    if (event.model === 'unknown') incomplete = true;
    const modelKey = event.model;
    const tierKey = event.tier;
    if (!byModel[modelKey]) byModel[modelKey] = { standard: emptyComponents(), fast: emptyComponents() };
    addUsage(byModel[modelKey][tierKey], event.usage);
  }

  const knownModels = Object.keys(byModel).filter((key) => key !== 'unknown');
  if (byModel.unknown && knownModels.length === 1) {
    for (const tier of ['standard', 'fast']) addUsage(byModel[knownModels[0]][tier], {
      input_tokens: byModel.unknown[tier].input + byModel.unknown[tier].cacheRead,
      cached_input_tokens: byModel.unknown[tier].cacheRead,
      output_tokens: byModel.unknown[tier].output,
      cache_creation_input_tokens: byModel.unknown[tier].cacheWrite
    });
    delete byModel.unknown;
    incomplete = false;
  }

  return { byModel, incomplete };
}

function componentCost(components, pricing) {
  const rates = pricing || {
    inputCostPerToken: 1,
    outputCostPerToken: 6,
    cacheReadInputTokenCost: 0.1,
    cacheCreationInputTokenCost: 1.25
  };
  return components.input * numberValue(rates.inputCostPerToken)
    + components.output * numberValue(rates.outputCostPerToken)
    + components.cacheRead * numberValue(rates.cacheReadInputTokenCost)
    + components.cacheWrite * numberValue(rates.cacheCreationInputTokenCost);
}

function annotateCodexQuotaCosts(json, options = {}) {
  const rows = Array.isArray(json?.entries) ? json.entries : [];
  const home = options.homeDir || os.homedir();
  const pricingByModel = options.pricingByModel || {};
  const profileBySession = new Map();

  for (const row of rows) {
    if (String(row?.client || '').trim().toLowerCase() !== 'codex') continue;
    if (String(row?.provider || '').trim().toLowerCase() !== 'openai') continue;
    const sessionId = String(row?.sessionId || row?.session_id || '').trim();
    const model = normalizedModel(row?.model);
    const reportedCost = numberValue(row.cost ?? row.costUsd ?? row.cost_usd);
    if (reportedCost > 0) row.quotaCostUsd = reportedCost;
    if (!sessionId || !model) continue;
    let profile = profileBySession.get(sessionId);
    if (profile === undefined) {
      const filePath = resolveSessionFile('codex', sessionId, home);
      profile = filePath ? parseCodexQuotaProfile(filePath) : null;
      profileBySession.set(sessionId, profile);
    }
    const modelProfile = profile?.byModel?.[model];
    if (!modelProfile || profile.incomplete) continue;
    const standardCost = componentCost(modelProfile.standard, pricingByModel[model]);
    const fastCost = componentCost(modelProfile.fast, pricingByModel[model]);
    const calculatedCost = standardCost + fastCost;
    if (calculatedCost <= 0 || reportedCost <= 0) continue;
    const fastShare = Math.max(0, Math.min(1, fastCost / calculatedCost));
    const multiplier = fastCreditMultiplier(model);
    row.quotaCostUsd = reportedCost * (1 + fastShare * (multiplier - 1));
    row.fastCostShare = fastShare;
    row.fastCreditMultiplier = multiplier;
  }
  return json;
}

function modelProfileCost(profile, pricing) {
  if (!profile) return { standard: 0, fast: 0, total: 0 };
  const standard = componentCost(profile.standard, pricing);
  const fast = componentCost(profile.fast, pricing);
  return { standard, fast, total: standard + fast };
}

function officialCodexQuotaUsageSince(period, since, options = {}) {
  const sinceMs = Date.parse(since || '');
  if (!Number.isFinite(sinceMs) || !period) return { costUsd: null, reason: 'historyUnavailable' };
  const home = options.homeDir || os.homedir();
  const pricingByModel = options.pricingByModel || {};
  let costUsd = 0;
  let found = false;
  for (const session of Object.values(period.sessions || {})) {
    if (String(session?.client || '').trim().toLowerCase() !== 'codex') continue;
    const providers = Object.entries(session.providers || {}).filter(([, value]) => numberValue(value) > 0);
    if (providers.length !== 1 || String(providers[0][0]).toLowerCase() !== 'openai') continue;
    const lastUsedMs = Date.parse(session.lastUsedAt || '');
    if (Number.isFinite(lastUsedMs) && lastUsedMs < sinceMs) continue;
    found = true;
    const startedMs = Date.parse(session.startedAt || '');
    if (Number.isFinite(startedMs) && startedMs >= sinceMs) {
      costUsd += Math.max(0, numberValue(session.quotaCostUsd) || numberValue(session.costUsd));
      continue;
    }

    const sessionId = String(session.sessionId || '').trim();
    const filePath = sessionId ? resolveSessionFile('codex', sessionId, home) : '';
    const full = filePath ? parseCodexQuotaProfile(filePath) : null;
    const filtered = filePath ? parseCodexQuotaProfile(filePath, { since }) : null;
    if (!full || !filtered || full.incomplete || filtered.incomplete) {
      return { costUsd: null, reason: 'historyIncomplete' };
    }
    for (const [modelValue, rawModelCostValue] of Object.entries(session.modelCosts || {})) {
      const model = normalizedModel(modelValue);
      const rawModelCost = numberValue(rawModelCostValue);
      const fullCost = modelProfileCost(full.byModel[model], pricingByModel[model]);
      const filteredCost = modelProfileCost(filtered.byModel[model], pricingByModel[model]);
      if (filteredCost.total <= 0) continue;
      if (fullCost.total <= 0 || rawModelCost <= 0) return { costUsd: null, reason: 'historyIncomplete' };
      const rawFilteredCost = rawModelCost * Math.min(1, filteredCost.total / fullCost.total);
      const fastShare = filteredCost.fast / filteredCost.total;
      costUsd += rawFilteredCost * (1 + fastShare * (fastCreditMultiplier(model) - 1));
    }
  }
  return found ? { costUsd, reason: null } : { costUsd: 0, reason: null };
}

function resetCodexQuotaProfileCache() {
  profileCache.clear();
}

module.exports = {
  annotateCodexQuotaCosts,
  fastCreditMultiplier,
  isFastTier,
  officialCodexQuotaUsageSince,
  parseCodexQuotaProfile,
  resetCodexQuotaProfileCache
};
