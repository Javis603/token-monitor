'use strict';

// Keep provider order stable: it is also the default order for a new install.
// Saved user ordering is parsed separately and must not be overwritten.
const LIMIT_PROVIDER_IDS = Object.freeze([
  'claude', 'codex', 'opencode', 'cursor', 'antigravity', 'kimi', 'grok',
  'copilot', 'zed', 'commandcode', 'mimo', 'zai', 'zaiteam', 'kiro', 'workbuddy',
  'qoder', 'deepseek', 'openrouter', 'minimax', 'volcengine', 'ollama', 'trae',
  'alibaba', 'thirdparty'
]);

// Collection client ids normally match their Limits provider id. Keep the
// exceptions explicit here.
const LIMIT_PROVIDER_BY_CLIENT = Object.freeze({
  micode: 'mimo',
  zcode: 'zai',
  qodercn: 'qoder'
});

// These are the only window metrics that cross the shared limits schema.
const LIMIT_WINDOW_METRICS = Object.freeze(['credits', 'spend']);
const VALID_LIMIT_WINDOW_METRICS = new Set(LIMIT_WINDOW_METRICS);

// Initial discovery is deliberately narrower than the provider list: only a
// provider mapped from a currently detected local source can be seeded.
// Usage-derived client status can remain active after a source disappears, so
// source health is the authoritative signal here.
function limitProvidersForDetectedClients(clientHealth) {
  const clients = clientHealth?.clients;
  if (!clients || typeof clients !== 'object' || Array.isArray(clients)) return [];
  const detectedProviders = new Set();
  for (const [client, health] of Object.entries(clients)) {
    if (health?.source?.state !== 'detected') continue;
    const clientId = String(client).trim().toLowerCase();
    detectedProviders.add(LIMIT_PROVIDER_BY_CLIENT[clientId] || clientId);
  }
  return LIMIT_PROVIDER_IDS.filter((provider) => detectedProviders.has(provider));
}

module.exports = {
  LIMIT_PROVIDER_IDS,
  LIMIT_WINDOW_METRICS,
  VALID_LIMIT_WINDOW_METRICS,
  limitProvidersForDetectedClients
};
