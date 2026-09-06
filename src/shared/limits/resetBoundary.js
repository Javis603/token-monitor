'use strict';

const LIMITS_RESET_BOUNDARY_DELAY_MS = 30 * 1000;
const LIMITS_RESET_BOUNDARY_MIN_TIMER_MS = 5 * 1000;
const LIMITS_RESET_BOUNDARY_MAX_TIMER_MS = 2_147_483_647;

function limitResetBoundaryEntries(limits) {
  const entries = [];
  for (const provider of limits?.providers || []) {
    const providerKey = [
      provider?.provider,
      provider?.accountKey,
      provider?.accountEmail,
      provider?.accountLabel
    ].map((value) => String(value || '').trim()).join(':');
    const scope = {
      provider: String(provider?.provider || '').trim(),
      accountKey: String(provider?.accountKey || '').trim(),
      accountEmail: String(provider?.accountEmail || '').trim().toLowerCase(),
      accountName: String(provider?.accountName || '').trim(),
      accountLabel: String(provider?.accountLabel || '').trim(),
      sourceDetail: String(provider?.sourceDetail || '').trim()
    };
    for (const window of provider?.windows || []) {
      const resetAt = Date.parse(window?.resetsAt || '');
      if (!Number.isFinite(resetAt)) continue;
      entries.push({
        resetAt,
        key: `${providerKey}:${String(window?.kind || '').trim()}:${new Date(resetAt).toISOString()}`,
        scope
      });
    }
  }
  return entries;
}

function nextLimitsResetBoundary(limits, nowMs = Date.now(), attempted = new Set()) {
  let refreshAt = Infinity;
  let keys = [];
  let scopes = new Map();
  for (const entry of limitResetBoundaryEntries(limits)) {
    if (attempted.has(entry.key)) continue;
    const candidate = entry.resetAt + LIMITS_RESET_BOUNDARY_DELAY_MS;
    if (candidate < refreshAt) {
      refreshAt = candidate;
      keys = [entry.key];
      scopes = new Map([[JSON.stringify(entry.scope), entry.scope]]);
    } else if (candidate === refreshAt) {
      keys.push(entry.key);
      scopes.set(JSON.stringify(entry.scope), entry.scope);
    }
  }
  if (!Number.isFinite(refreshAt)) return null;
  return {
    refreshAt,
    delayMs: Math.min(
      LIMITS_RESET_BOUNDARY_MAX_TIMER_MS,
      Math.max(LIMITS_RESET_BOUNDARY_MIN_TIMER_MS, refreshAt - nowMs)
    ),
    keys,
    scopes: [...scopes.values()]
  };
}

function pruneAttemptedResetBoundaries(limits, attempted) {
  const currentKeys = new Set(limitResetBoundaryEntries(limits).map((entry) => entry.key));
  for (const key of attempted) {
    if (!currentKeys.has(key)) attempted.delete(key);
  }
}

module.exports = {
  LIMITS_RESET_BOUNDARY_DELAY_MS,
  LIMITS_RESET_BOUNDARY_MIN_TIMER_MS,
  LIMITS_RESET_BOUNDARY_MAX_TIMER_MS,
  limitResetBoundaryEntries,
  nextLimitsResetBoundary,
  pruneAttemptedResetBoundaries
};
