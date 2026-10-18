'use strict';

function settingsLimitInvalidationPlan(runtimeChange = {}) {
  const scopes = Array.isArray(runtimeChange.limitScopes) ? runtimeChange.limitScopes : [];
  return scopes.map((scope) => ({
    scope,
    reason: 'settings-change',
    options: { clear: true }
  }));
}

async function runLimitInvalidation(runtime, scope, reason = 'credential-change', options = {}) {
  if (options.clear === true) runtime.clearLimits(scope, reason);
  if (options.refresh === false) return { cleared: true };
  return runtime.refreshLimits(scope, reason);
}

async function runManualDeviceRefresh(runtime, options = {}) {
  if (!runtime) return;
  const limitsTask = Promise.resolve(runtime.refreshLimits({ all: true }, 'manual'));
  limitsTask.catch((error) => options.onLimitsError?.(error));
  if (options.refreshUsage === false) return;
  await runtime.tick('manual', {
    ...(options.todayOnly === true ? { todayOnly: true } : {}),
    forceHistory: options.forceHistory === true,
    // Self-sync subprocesses remain opt-in because settings and account flows
    // must not pay their cost unless the caller explicitly requests it.
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
  runLimitInvalidation,
  runManualDeviceRefresh,
  settingsLimitInvalidationPlan
};
