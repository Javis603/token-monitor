'use strict';

// Pure projection that folds the cloud accounting summary into the stats every
// visible surface already reads (renderer, tray, Widget, edge dock). Cloud
// counters join today/month/allTime and the `codex` tool breakdown; model and
// cost fields stay untouched because the engine reports neither. The summary
// is lossy by design: no account scope, no paths, no credential material.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIODS = ['today', 'month', 'allTime'];
const rawProjectionSources = new WeakMap();

// The same strict identity the session-row merge uses: a canonical Codex
// thread UUID is the whole session id, a `canonicalSessionId`/`threadId` field,
// or the canonical key itself. A UUID-looking fragment inside a rollout name,
// title or label is a display hint, never proof of shared identity.
function canonicalCodexThreadId(session, key) {
  if (!session || session.client !== 'codex') return null;
  const stripped = String(key || '').replace(/^codex:/, '');
  const values = [session.canonicalSessionId, session.threadId, session.sessionId, stripped];
  const ids = new Set(values.filter((v) => typeof v === 'string' && UUID.test(v)).map((v) => v.toLowerCase()));
  return ids.size === 1 ? [...ids][0] : null;
}

function collectLocalCodexThreadUsage(stats, extraSessionMaps = []) {
  const usage = {};
  const add = (sessions, period) => {
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return;
    for (const [key, session] of Object.entries(sessions)) {
      const id = canonicalCodexThreadId(session, key);
      if (!id) {
        if (session?.client !== 'codex') continue;
        const claims = [session.canonicalSessionId, session.threadId, session.sessionId, String(key).replace(/^codex:/, '')]
          .filter((v) => typeof v === 'string' && UUID.test(v)).map((v) => v.toLowerCase());
        for (const claim of claims) usage[claim] = { ambiguous: true };
        continue;
      }
      const entry = usage[id] || (usage[id] = {});
      if (entry.ambiguous) continue;
      if (Number.isSafeInteger(session.totalTokens) && session.totalTokens >= 0) entry[period] = Math.max(entry[period] || 0, session.totalTokens);
    }
  };
  for (const period of PERIODS) add(stats?.periods?.[period]?.sessions, period);
  for (const sessions of extraSessionMaps) add(sessions, 'allTime');
  return usage;
}

function collectLocalCodexThreadIds(stats, extraSessionMaps = []) {
  const ids = new Set();
  const add = (sessions) => {
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return;
    for (const [key, session] of Object.entries(sessions)) {
      const id = canonicalCodexThreadId(session, key);
      if (id) ids.add(id);
    }
  };
  for (const period of PERIODS) add(stats?.periods?.[period]?.sessions);
  for (const sessions of extraSessionMaps) add(sessions);
  return ids;
}

function addSafe(left, right) {
  const sum = (Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0);
  return Number.isSafeInteger(sum) && sum >= 0 ? sum : null;
}

function patchPeriod(period, contribution) {
  if (!period || typeof period !== 'object') return { period, skipped: false };
  const cached = contribution.cachedInputTokens || 0;
  const output = contribution.outputTokens || 0;
  const total = addSafe(period.totalTokens || 0, contribution.totalTokens || 0);
  const extraUnclassified = Math.max(0, (contribution.totalTokens || 0) - cached - output);
  const unclassified = addSafe(period.unclassifiedTokens || 0, extraUnclassified);
  if (total === null || unclassified === null) return { period, skipped: true };
  const cacheRead = addSafe(period.cacheReadTokens || 0, cached);
  const outputTotal = addSafe(period.outputTokens || 0, output);
  const patched = {
    ...period,
    totalTokens: total,
    cacheReadTokens: cacheRead === null ? period.cacheReadTokens || 0 : cacheRead,
    outputTokens: outputTotal === null ? period.outputTokens || 0 : outputTotal,
    unclassifiedTokens: unclassified,
    clients: { ...(period.clients || {}) },
    clientCacheReads: { ...(period.clientCacheReads || {}) },
    clientOutputs: { ...(period.clientOutputs || {}) },
    clientUnclassifiedTokens: { ...(period.clientUnclassifiedTokens || {}) }
  };
  patched.clients.codex = (period.clients?.codex || 0) + (contribution.totalTokens || 0);
  patched.clientCacheReads.codex = (period.clientCacheReads?.codex || 0) + cached;
  patched.clientOutputs.codex = (period.clientOutputs?.codex || 0) + output;
  const clientUnclassified = (period.clientUnclassifiedTokens?.codex || 0) + extraUnclassified;
  if (clientUnclassified > 0) patched.clientUnclassifiedTokens.codex = clientUnclassified;
  else delete patched.clientUnclassifiedTokens.codex;
  return { period: patched, skipped: false };
}

function projectContribution(periodSummary) {
  return {
    totalTokens: periodSummary?.totalTokens || 0,
    inputTokens: periodSummary?.inputTokens || 0,
    cachedInputTokens: periodSummary?.cachedInputTokens || 0,
    outputTokens: periodSummary?.outputTokens || 0,
    reasoningOutputTokens: periodSummary?.reasoningOutputTokens || 0,
    threadCount: periodSummary?.threadCount || 0
  };
}

// `accounting` is the summary() of the cloud ledger runtime. Attaching it also
// when inactive lets the UI explain why nothing was counted (no account, no
// report) instead of silently showing zero.
function applyCloudAccounting(stats, accounting) {
  if (!stats || typeof stats !== 'object') return stats;
  if (!accounting || accounting.version !== 1 || !accounting.periods) return stats;
  stats = rawProjectionSources.get(stats) || stats;
  const rawStats = stats;
  const contributions = {};
  let hasContribution = false;
  let partialComponents = false;
  for (const period of PERIODS) {
    const projected = projectContribution(accounting.periods[period]);
    contributions[period] = projected;
    if (projected.totalTokens > 0 || projected.threadCount > 0) hasContribution = true;
  }
  if (accounting.periods.allTime?.partialComponents === true) partialComponents = true;
  let result = stats;
  if (hasContribution) {
    const periods = { ...(stats.periods || {}) };
    for (const name of PERIODS) {
      const contribution = contributions[name];
      if (!contribution.totalTokens) continue;
      const { period, skipped } = patchPeriod(periods[name], contribution);
      if (skipped) partialComponents = true;
      else periods[name] = period;
    }
    result = { ...stats, periods };
  }
  const block = {
    version: 1,
    state: accounting.state === 'active' ? 'active' : 'inactive',
    reason: typeof accounting.reason === 'string' ? accounting.reason : null,
    observedAt: typeof accounting.observedAt === 'string' ? accounting.observedAt : null,
    reportAt: typeof accounting.reportAt === 'string' ? accounting.reportAt : null,
    updatedAt: typeof accounting.updatedAt === 'string' ? accounting.updatedAt : null,
    periods: Object.fromEntries(PERIODS.map((name) => [name, contributions[name]])),
    baselineTokens: accounting.baselineTokens || 0,
    observedTokens: accounting.observedTokens || 0,
    excludedThreads: accounting.excludedThreads || 0,
    excludedReasons: {
      matchedLocal: accounting.excludedReasons?.matchedLocal || 0,
      parentOverlap: accounting.excludedReasons?.parentOverlap || 0
    },
    partialThreads: accounting.partialThreads || 0,
    bridgedThreads: accounting.bridgedThreads || 0,
    partialComponents,
    unknownCost: accounting.unknownCost !== false,
    threads: accounting.threads && typeof accounting.threads === 'object' ? accounting.threads : {}
  };
  const projected = { ...result, cloudAccounting: block };
  rawProjectionSources.set(projected, rawStats);
  return projected;
}

module.exports = { applyCloudAccounting, collectLocalCodexThreadIds, collectLocalCodexThreadUsage, canonicalCodexThreadId };
