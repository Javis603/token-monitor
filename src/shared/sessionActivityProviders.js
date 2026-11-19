'use strict';

// Portable declarations only. The renderer and Hub share admission/expiry
// rules without loading the native readers bound in sessionActivityRegistry.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSessionActivityProviders = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  const SESSION_ACTIVITY_PROVIDERS = Object.freeze([
    Object.freeze({ id: 'claude', t3Driver: 'claudeAgent', metadataDepsKey: 'claudeMetadataDeps' }),
    Object.freeze({ id: 'codex', t3Driver: 'codex', metadataDepsKey: 'codexDeps' })
  ]);
  const SESSION_ACTIVITY_CLIENTS = Object.freeze(SESSION_ACTIVITY_PROVIDERS.map((entry) => entry.id));
  const clients = new Set(SESSION_ACTIVITY_CLIENTS);
  function isSessionActivityClient(client) { return clients.has(client); }
  return { SESSION_ACTIVITY_PROVIDERS, SESSION_ACTIVITY_CLIENTS, isSessionActivityClient };
});
