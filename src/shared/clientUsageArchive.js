'use strict';

const { PERIODS, normalizePeriod } = require('./usage');
const { hasSummaryPeriod } = require('./archivePeriods');

function normalizeClientId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  return raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

function clientSet(value) {
  if (value instanceof Set) return new Set(Array.from(value).map(normalizeClientId).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map(normalizeClientId).filter(Boolean));
  return new Set(String(value || '').split(',').map(normalizeClientId).filter(Boolean));
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localDay(dateValue) {
  const date = toDate(dateValue);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localMonth(dateValue) {
  const date = toDate(dateValue);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function archivedPeriod(input) {
  const normalized = normalizePeriod({ sessions: input?.sessions });
  return {
    totalTokens: Math.max(0, Math.round(numberValue(input?.totalTokens))),
    costUsd: numberValue(input?.costUsd),
    models: normalizedModelMap(input?.models),
    modelCosts: normalizedModelMap(input?.modelCosts, false),
    sessions: normalized.sessions
  };
}

function hasUsage(period) {
  if (numberValue(period?.totalTokens) > 0 || numberValue(period?.costUsd) > 0) return true;
  return Object.values(period?.sessions || {}).some((session) => numberValue(session?.totalTokens) > 0 || numberValue(session?.costUsd) > 0);
}

function normalizeModelName(value) {
  const raw = String(value || '').trim();
  return raw || null;
}

function normalizedModelMap(input, roundTokens = true) {
  const result = {};
  if (!input || typeof input !== 'object') return result;
  for (const [model, value] of Object.entries(input)) {
    const key = normalizeModelName(model);
    if (!key) continue;
    const next = roundTokens ? Math.max(0, Math.round(numberValue(value))) : numberValue(value);
    if (next > 0) result[key] = (result[key] || 0) + next;
  }
  return result;
}

function periodFor(record, periodName) {
  return normalizePeriod(record?.periods?.[periodName] || record?.[periodName]);
}

function clientUsageFromPeriod(period, client) {
  const sessions = {};
  for (const [key, session] of Object.entries(period?.sessions || {})) {
    if (session?.client === client) sessions[key] = session;
  }
  return archivedPeriod({
    totalTokens: period?.clients?.[client],
    costUsd: period?.clientCosts?.[client],
    models: period?.clientModels?.[client],
    modelCosts: period?.clientModelCosts?.[client],
    sessions
  });
}

function normalizeArchivedClientUsage(value) {
  const source = value?.clients && typeof value.clients === 'object' ? value.clients : value;
  const normalized = { version: 1, clients: {} };
  if (!source || typeof source !== 'object') return normalized;

  for (const [key, rawEntry] of Object.entries(source)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const client = normalizeClientId(rawEntry.client || key);
    if (!client) continue;
    const capturedAt = toDate(rawEntry.capturedAt);
    const entry = {
      client,
      capturedAt: capturedAt.toISOString(),
      day: String(rawEntry.day || localDay(capturedAt)),
      month: String(rawEntry.month || localMonth(capturedAt)),
      periods: {}
    };
    let includesUsage = false;
    for (const periodName of PERIODS) {
      const period = archivedPeriod(rawEntry.periods?.[periodName] || rawEntry[periodName]);
      entry.periods[periodName] = period;
      includesUsage = includesUsage || hasUsage(period);
    }
    if (includesUsage) normalized.clients[client] = entry;
  }

  return normalized;
}

function captureArchivedClientUsage(existingArchive, deviceRecord, clients, capturedAt = new Date()) {
  const archive = normalizeArchivedClientUsage(existingArchive);
  if (!deviceRecord || typeof deviceRecord !== 'object') return archive;

  const captureDate = toDate(capturedAt);
  for (const client of clientSet(clients)) {
    const periods = {};
    let includesUsage = false;
    for (const periodName of PERIODS) {
      const usage = clientUsageFromPeriod(periodFor(deviceRecord, periodName), client);
      periods[periodName] = usage;
      includesUsage = includesUsage || hasUsage(usage);
    }
    if (!includesUsage) continue;
    archive.clients[client] = {
      client,
      capturedAt: captureDate.toISOString(),
      day: localDay(captureDate),
      month: localMonth(captureDate),
      periods
    };
  }

  return archive;
}

function cloneSummary(summary) {
  return JSON.parse(JSON.stringify(summary || {}));
}

function targetPeriod(summary, periodName) {
  if (summary.periods && typeof summary.periods === 'object') {
    summary.periods[periodName] = normalizePeriod(summary.periods[periodName]);
    return summary.periods[periodName];
  }
  summary[periodName] = normalizePeriod(summary[periodName]);
  return summary[periodName];
}

function addClientUsage(period, client, usage) {
  const tokens = Math.max(0, Math.round(numberValue(usage?.totalTokens)));
  const cost = numberValue(usage?.costUsd);
  const beforeComponents = {
    cacheRead: period.cacheReadTokens,
    cacheWrite: period.cacheWriteTokens,
    output: period.outputTokens,
    models: Object.fromEntries(Object.keys(usage?.models || {}).map((model) => [model, {
      cacheRead: numberValue(period.modelCacheReads?.[model]),
      cacheWrite: numberValue(period.modelCacheWrites?.[model]),
      output: numberValue(period.modelOutputs?.[model])
    }]))
  };
  period.totalTokens += tokens;
  period.costUsd += cost;
  if (tokens > 0) period.clients[client] = (period.clients[client] || 0) + tokens;
  if (cost > 0) period.clientCosts[client] = (period.clientCosts[client] || 0) + cost;
  for (const [model, modelTokens] of Object.entries(usage?.models || {})) {
    period.models[model] = (period.models[model] || 0) + Math.max(0, Math.round(numberValue(modelTokens)));
    if (!period.clientModels[client]) period.clientModels[client] = {};
    period.clientModels[client][model] = (period.clientModels[client][model] || 0) + Math.max(0, Math.round(numberValue(modelTokens)));
  }
  for (const [model, modelCost] of Object.entries(usage?.modelCosts || {})) {
    period.modelCosts[model] = (period.modelCosts[model] || 0) + numberValue(modelCost);
    if (!period.clientModelCosts[client]) period.clientModelCosts[client] = {};
    period.clientModelCosts[client][model] = (period.clientModelCosts[client][model] || 0) + numberValue(modelCost);
  }
  const normalizedSessions = normalizePeriod({ sessions: usage?.sessions }).sessions;
  for (const [key, session] of Object.entries(normalizedSessions)) {
    period.sessions[key] = session;
    addSessionBreakdown(period, client, session);
  }
  const known = Math.min(tokens,
    period.cacheReadTokens - beforeComponents.cacheRead
    + period.cacheWriteTokens - beforeComponents.cacheWrite
    + period.outputTokens - beforeComponents.output);
  const unclassified = Math.max(0, tokens - known);
  if (unclassified > 0) {
    period.unclassifiedTokens += unclassified;
    period.clientUnclassifiedTokens[client] = (period.clientUnclassifiedTokens[client] || 0) + unclassified;
    period.capabilities.tokenComponents = false;
  }
  for (const [model, modelTokens] of Object.entries(usage?.models || {})) {
    const before = beforeComponents.models[model] || {};
    const modelKnown = Math.min(Math.max(0, Math.round(numberValue(modelTokens))),
      numberValue(period.modelCacheReads?.[model]) - numberValue(before.cacheRead)
      + numberValue(period.modelCacheWrites?.[model]) - numberValue(before.cacheWrite)
      + numberValue(period.modelOutputs?.[model]) - numberValue(before.output));
    const modelUnclassified = Math.max(0, Math.round(numberValue(modelTokens)) - modelKnown);
    if (modelUnclassified > 0) {
      period.modelUnclassifiedTokens[model] = (period.modelUnclassifiedTokens[model] || 0) + modelUnclassified;
      period.capabilities.tokenComponents = false;
    }
  }
}

// The archived period keeps only token/cost totals, but its sessions still carry
// the full cache hit/write/output split. Rebuild the client- and model-level
// breakdown dicts from them on apply, so an archived (untracked) client's rows
// expand with a real cache split instead of dumping everything into "cache miss".
function addSessionBreakdown(period, client, session) {
  const cacheRead = Math.max(0, Math.round(numberValue(session?.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(numberValue(session?.cacheWriteTokens)));
  const output = Math.max(0, Math.round(numberValue(session?.outputTokens)));
  if (cacheRead === 0 && cacheWrite === 0 && output === 0) return;

  if (cacheRead > 0) period.clientCacheReads[client] = (period.clientCacheReads[client] || 0) + cacheRead;
  if (cacheWrite > 0) period.clientCacheWrites[client] = (period.clientCacheWrites[client] || 0) + cacheWrite;
  if (output > 0) period.clientOutputs[client] = (period.clientOutputs[client] || 0) + output;
  period.cacheReadTokens += cacheRead;
  period.cacheWriteTokens += cacheWrite;
  period.outputTokens += output;

  const modelTokens = Object.entries(session?.models || {})
    .map(([model, tokens]) => [model, numberValue(tokens)])
    .filter(([, tokens]) => tokens > 0);
  const totalModelTokens = modelTokens.reduce((sum, [, tokens]) => sum + tokens, 0);
  if (totalModelTokens === 0) return;
  // Session-level components have no client×model provenance. They are exact
  // only when the session has one model; a multi-model split would be a guess.
  if (modelTokens.length > 1) return;
  const [[model, tokens]] = modelTokens;
  const cr = Math.min(tokens, cacheRead);
  const cw = Math.min(tokens - cr, cacheWrite);
  const ou = Math.min(tokens - cr - cw, output);
  if (cr > 0) period.modelCacheReads[model] = (period.modelCacheReads[model] || 0) + cr;
  if (cw > 0) period.modelCacheWrites[model] = (period.modelCacheWrites[model] || 0) + cw;
  if (ou > 0) period.modelOutputs[model] = (period.modelOutputs[model] || 0) + ou;
}

function shouldApplyPeriod(periodName, entry, now) {
  if (periodName === 'today') return entry.day === localDay(now);
  if (periodName === 'month') return entry.month === localMonth(now);
  return periodName === 'allTime';
}

function applyArchivedClientUsage(summary, archive, options = {}) {
  const normalizedArchive = normalizeArchivedClientUsage(archive);
  const activeClients = clientSet(options.activeClients);
  const now = toDate(options.now);
  const next = cloneSummary(summary);

  for (const [client, entry] of Object.entries(normalizedArchive.clients)) {
    if (activeClients.has(client)) continue;
    for (const periodName of PERIODS) {
      const usage = entry.periods?.[periodName];
      if (!hasUsage(usage) || !shouldApplyPeriod(periodName, entry, now)) continue;
      if (!hasSummaryPeriod(next, periodName)) continue;
      addClientUsage(targetPeriod(next, periodName), client, usage);
    }
  }

  return next;
}

function pruneArchivedClientUsage(archive, activeClients) {
  const normalizedArchive = normalizeArchivedClientUsage(archive);
  for (const client of clientSet(activeClients)) delete normalizedArchive.clients[client];
  return normalizedArchive;
}

module.exports = {
  applyArchivedClientUsage,
  captureArchivedClientUsage,
  normalizeArchivedClientUsage,
  pruneArchivedClientUsage
};
