'use strict';

const { limitProvidersForDetectedClients } = require('../shared/limitProviders');

function applyInitialLimitProviderSeed(pending, summary, deps = {}) {
  const healthClients = summary?.clientHealth?.clients;
  if (
    !pending
    || !deps.settings
    || !healthClients
    || typeof healthClients !== 'object'
    || Array.isArray(healthClients)
  ) {
    return false;
  }

  const previousProviders = deps.settings.limitProviders;
  const detectedProviders = limitProvidersForDetectedClients(summary.clientHealth);
  // Keep the Limits view discoverable on a source-free first run.
  deps.settings.limitProviders = (detectedProviders.length > 0 ? detectedProviders : ['codex']).join(',');
  try {
    if (deps.saveSettings?.() !== true) {
      deps.settings.limitProviders = previousProviders;
      return false;
    }
  } catch (error) {
    deps.settings.limitProviders = previousProviders;
    throw error;
  }

  deps.onPersisted?.();
  return true;
}

module.exports = {
  applyInitialLimitProviderSeed
};
