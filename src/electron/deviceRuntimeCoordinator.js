'use strict';

function settingsLimitInvalidationPlan(runtimeChange = {}, ensureProvider = '') {
  const scopes = Array.isArray(runtimeChange.limitScopes) ? [...runtimeChange.limitScopes] : [];
  if (ensureProvider && !scopes.some((scope) => scope.provider === ensureProvider)) {
    scopes.push({ provider: ensureProvider });
  }
  return scopes.map(({ preserveReadings, ...scope }) => ({
    // MiniMax API and Muse Web settings do not own their local CLI logins.
    scope: scope.provider === 'minimax' ? { ...scope, source: 'api' }
      : scope.provider === 'muse' ? { ...scope, source: 'web' } : scope,
    reason: 'settings-change',
    options: { clear: preserveReadings !== true }
  }));
}

async function runLimitInvalidation(runtime, scope, reason = 'credential-change', options = {}) {
  if (options.clear === true) runtime.clearLimits(scope, reason);
  if (options.refresh === false) return { cleared: true };
  return runtime.refreshLimits(scope, reason);
}

// What a user-started limits refresh came to, from LimitsRuntime's answer.
// `reason` says why nothing new will arrive, for a button that would
// otherwise just stop: 'cooldown' (the provider asked us to back off),
// 'unavailable' (the runtime is stopped or the provider is off) or 'failed'
// (the probe itself threw).
function limitRefreshOutcome(result) {
  if (result === false) return { ok: false, reason: 'unavailable' };
  if (result?.deferred) return { ok: false, reason: 'cooldown', retryAt: result.retryAt || '' };
  if (result?.superseded && result.reason === 'disabled') return { ok: false, reason: 'unavailable' };
  // Superseded by a newer refresh of the row, whose answer stands for this one
  // (an aborted probe reports an error too, so this check comes first).
  if (result?.superseded) return { ok: true };
  if (result?.error) return { ok: false, reason: 'failed', error: result.error.message || String(result.error) };
  return { ok: true };
}

async function runManualDeviceRefresh(runtime, options = {}) {
  if (!runtime) return;
  const limitsTask = Promise.resolve(runtime.refreshLimits({ all: true }, 'manual'));
  limitsTask.catch((error) => options.onLimitsError?.(error));
  if (options.refreshUsage === false) {
    await limitsTask.catch(() => {});
    return;
  }
  await runtime.tick('manual', {
    forceHistory: options.forceHistory === true,
    // Cursor and Antigravity only move when their sync subprocess runs, and that
    // is throttled to once per 5 minutes. Without this the refresh button cannot
    // change their numbers at all, which reads as a broken button rather than as
    // a throttle. Opt-in for the same reason forceHistory is: the settings and
    // account flows refresh constantly and must not pay for the spawns.
    forceSelfSync: options.forceSelfSync === true
  });
}

function canRefreshUsageRuntime(mode, isExternalAgentActive) {
  return mode === 'local' || !isExternalAgentActive();
}

function drainPendingUsageClientRefreshes(pendingRefreshes, runtime, onError, options = {}) {
  const pending = [...pendingRefreshes.values()];
  pendingRefreshes.clear();
  if (options.enabled === false) return;
  for (const entry of pending) {
    void Promise.resolve()
      .then(() => runtime.refreshClient(entry.clientId, entry.options))
      .catch((error) => onError?.(error));
  }
}

module.exports = {
  canRefreshUsageRuntime,
  drainPendingUsageClientRefreshes,
  limitRefreshOutcome,
  runLimitInvalidation,
  runManualDeviceRefresh,
  settingsLimitInvalidationPlan
};
