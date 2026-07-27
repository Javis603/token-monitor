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
  await runtime.tick('manual', { forceHistory: options.forceHistory === true });
}

module.exports = {
  runLimitInvalidation,
  runManualDeviceRefresh,
  settingsLimitInvalidationPlan
};
