'use strict';

(function exposeClientSourceCache(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorClientSourceCache = api;
})(typeof window !== 'undefined' ? window : null, function createClientSourceCacheApi() {
  function createClientSourceCache() {
    return { deviceId: '', entries: new Map() };
  }

  function normalizedIdentity(identity = {}) {
    return {
      deviceId: String(identity.deviceId || ''),
      clientId: String(identity.clientId || ''),
      observedAt: String(identity.observedAt || '')
    };
  }

  function hasCompleteIdentity(value) {
    return Boolean(value.deviceId && value.clientId && value.observedAt);
  }

  function clientSourceRequestKey(identity) {
    const value = normalizedIdentity(identity);
    return hasCompleteIdentity(value)
      ? `${value.deviceId}|${value.clientId}|${value.observedAt}`
      : '';
  }

  function readClientSources(cache, identity) {
    const value = normalizedIdentity(identity);
    if (!hasCompleteIdentity(value) || cache?.deviceId !== value.deviceId) return null;
    const entry = cache.entries.get(value.clientId);
    return entry?.observedAt === value.observedAt ? entry.sources : null;
  }

  function writeClientSources(cache, identity, sources) {
    const value = normalizedIdentity(identity);
    if (!hasCompleteIdentity(value)) return;
    if (cache.deviceId !== value.deviceId) {
      cache.deviceId = value.deviceId;
      cache.entries.clear();
    }
    cache.entries.set(value.clientId, {
      observedAt: value.observedAt,
      sources: Array.isArray(sources) ? sources : []
    });
  }

  function deleteClientSources(cache, identity) {
    const value = normalizedIdentity(identity);
    if (!hasCompleteIdentity(value) || cache?.deviceId !== value.deviceId) return;
    const entry = cache.entries.get(value.clientId);
    if (entry?.observedAt === value.observedAt) cache.entries.delete(value.clientId);
  }

  return {
    clientSourceRequestKey,
    createClientSourceCache,
    deleteClientSources,
    readClientSources,
    writeClientSources
  };
});
