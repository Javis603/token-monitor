'use strict';

const { PERIODS, normalizeClientName, normalizePeriod } = require('./usage');
const {
  CLIENT_IDENTITY_GENERATION, CLIENT_IDENTITY_SPLITS, isPreSplitEntry
} = require('./clientIdentitySplits');
const {
  cloneJson,
  hasSummaryPeriod,
  localDay,
  localMonth,
  numberValue,
  periodFor,
  targetPeriod,
  toDate
} = require('./archiveHelpers');

function normalizeClientId(value) {
  return normalizeClientName(value);
}

function clientSet(value) {
  if (value instanceof Set) return new Set(Array.from(value).map(normalizeClientId).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map(normalizeClientId).filter(Boolean));
  return new Set(String(value || '').split(',').map(normalizeClientId).filter(Boolean));
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
      // Provenance survives normalization. An entry with no generation predates
      // the split, which is the only thing that lets a merged snapshot be told
      // from a genuinely single-client one written afterwards.
      ...(rawEntry.clientIdentityGeneration !== undefined
        ? { clientIdentityGeneration: numberValue(rawEntry.clientIdentityGeneration) }
        : {}),
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
      // Written by this version, so the client id means what it says.
      clientIdentityGeneration: CLIENT_IDENTITY_GENERATION,
      periods
    };
  }

  return archive;
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

// An entry recorded under a merged id on or after the day the two ids began
// resolving to one row. Its numbers may include the split client, which is what
// makes it different from every other entry here: an ordinary archived client is
// wholly that client, while a merged snapshot cannot be decomposed from its own
// contents.
//
// Decided by the entry's own generation, not by its client id. Tokscale has
// scanned `.omp/agent/sessions` under `pi` since v2.0.19 and Token Monitor has
// shipped that scanner continuously since these archives existed, so every `pi`
// snapshot written before the split covers both products. That says nothing about
// a `pi` snapshot written after it: a user who untracks Pi today stores a
// genuinely Pi-only entry, and treating that as merged would subtract the live
// split client from usage which never contained it.
function mergedSnapshotFor(client, entry) {
  for (const splitDef of CLIENT_IDENTITY_SPLITS) {
    if (client !== splitDef.merged) continue;
    if (!isPreSplitEntry(entry)) continue;
    return splitDef;
  }
  return null;
}

// Drop the archived sessions the live scan is now reporting, and keep the rest.
//
// A merged-window snapshot cannot be divided into "this much was Pi, this much was
// Oh My Pi", so subtracting a live aggregate is not an option: live usage grows
// while the snapshot is frozen, and subtracting the current total would keep
// eating into the half only the archive still holds. A session id is different -
// it is written by the client that produced the session, so the same id appearing
// on either side of a pair names the same session. Matching by id removes exactly
// the overlap and leaves the residue with the merged id, which is the only owner
// that data actually has. A live session that has since grown past its archived
// size still removes only its own archived contribution, so the growth survives.
function netOutLiveUsage(usage, livePeriod, splitDef) {
  const archivedSessions = Object.entries(usage?.sessions || {});
  const liveSessionIds = new Set();
  for (const [key, session] of Object.entries(livePeriod?.sessions || {})) {
    const separator = key.indexOf(':');
    const sessionId = String(session?.sessionId || (separator >= 0 ? key.slice(separator + 1) : key)).trim();
    if (sessionId) liveSessionIds.add(sessionId);
  }

  // Without session detail on either side there is no identity to match on, so
  // fall back to subtracting the live total. That is exact at the moment of the
  // split and decays toward the live figure as live usage grows, which
  // under-reports rather than inflates: the archive exists to stop usage from
  // disappearing, and a figure that is too low is a smaller error than one that
  // counts the same tokens twice. Real captures carry session detail for every
  // period, so this path is a guard rather than the normal route.
  if (archivedSessions.length === 0 || liveSessionIds.size === 0) {
    let liveTokens = 0;
    let liveCost = 0;
    for (const liveClientId of [splitDef.merged, splitDef.split]) {
      liveTokens += Math.max(0, Math.round(numberValue(livePeriod?.clients?.[liveClientId])));
      liveCost += numberValue(livePeriod?.clientCosts?.[liveClientId]);
    }
    if (liveTokens === 0 && liveCost === 0) return usage;
    return {
      ...usage,
      totalTokens: Math.max(0, Math.round(numberValue(usage?.totalTokens)) - liveTokens),
      costUsd: Math.max(0, numberValue(usage?.costUsd) - liveCost)
    };
  }

  const sessions = {};
  let removedTokens = 0;
  let removedCost = 0;
  for (const [key, session] of archivedSessions) {
    const separator = key.indexOf(':');
    const sessionId = String(session?.sessionId || (separator >= 0 ? key.slice(separator + 1) : key)).trim();
    if (sessionId && liveSessionIds.has(sessionId)) {
      removedTokens += Math.max(0, Math.round(numberValue(session?.totalTokens)));
      removedCost += numberValue(session?.costUsd);
      continue;
    }
    sessions[key] = session;
  }
  if (removedTokens === 0 && removedCost === 0) return usage;
  return {
    ...usage,
    totalTokens: Math.max(0, Math.round(numberValue(usage?.totalTokens)) - removedTokens),
    costUsd: Math.max(0, numberValue(usage?.costUsd) - removedCost),
    sessions
  };
}

function applyArchivedClientUsage(summary, archive, options = {}) {
  const normalizedArchive = normalizeArchivedClientUsage(archive);
  const activeClients = clientSet(options.activeClients);
  const now = toDate(options.now);
  const next = cloneJson(summary);

  for (const [client, entry] of Object.entries(normalizedArchive.clients)) {
    const splitDef = mergedSnapshotFor(client, entry);
    // An ordinary entry is skipped once its client is tracked: the live scan now
    // reports it, so adding the archived copy back would double count. A merged
    // snapshot cannot be skipped that way, because becoming tracked covers only
    // part of it — the live scan reports whichever of the pair is on disk today,
    // while the snapshot holds both products. Netting the live rows out is what
    // leaves the remainder, and that remainder belongs to the merged id whether
    // or not that id is tracked. When the pair is fully live the remainder is
    // empty and the entry contributes nothing, which is the correct answer rather
    // than a special case.
    if (activeClients.has(client) && !splitDef) continue;
    for (const periodName of PERIODS) {
      const usage = entry.periods?.[periodName];
      if (!hasUsage(usage) || !shouldApplyPeriod(periodName, entry, now)) continue;
      if (!hasSummaryPeriod(next, periodName)) continue;
      const effective = splitDef
        ? netOutLiveUsage(usage, periodFor(next, periodName), splitDef)
        : usage;
      if (!hasUsage(effective)) continue;
      addClientUsage(targetPeriod(next, periodName), client, effective);
    }
  }

  return next;
}

function pruneArchivedClientUsage(archive, activeClients) {
  const normalizedArchive = normalizeArchivedClientUsage(archive);
  const active = clientSet(activeClients);
  for (const client of active) {
    // Pruning is per-client and means "the live scan owns this id now". That is
    // true of an ordinary client but not of a merged snapshot, which holds two
    // products under one id: pruning it would discard whatever the live scan does
    // not report, and the archive is the only place that usage exists. A merged
    // entry is left in place and nets itself out against the live rows on every
    // apply instead, which is also what keeps a later untrack from resurfacing it.
    if (mergedSnapshotFor(client, normalizedArchive.clients[client])) continue;
    delete normalizedArchive.clients[client];
  }
  return normalizedArchive;
}

module.exports = {
  applyArchivedClientUsage,
  captureArchivedClientUsage,
  normalizeArchivedClientUsage,
  pruneArchivedClientUsage
};
