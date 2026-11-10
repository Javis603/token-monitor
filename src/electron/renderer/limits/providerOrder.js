'use strict';

(function exposeLimitProviderOrder(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitProviderOrder = api;
})(typeof window !== 'undefined' ? window : null, function createLimitProviderOrderApi() {
  function providerIds(providers) {
    return (providers || []).map((provider) => String(provider?.id || '').trim().toLowerCase()).filter(Boolean);
  }

  function absentPluginProviders(value, providers) {
    const known = new Set(providerIds(providers));
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    return [...new Set(raw.map(id => String(id).trim().toLowerCase()).filter(id =>
      /^plugin:[a-z0-9][a-z0-9-]{1,39}:[a-z][a-z0-9-]{0,31}$/.test(id) && !known.has(id)))];
  }

  function preserveAbsentPluginOrder(value, next, providers) {
    const retained = new Set(absentPluginProviders(value, providers));
    const visible = new Set(providerIds(providers));
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    const pending = [...next], result = [], seen = new Set();
    for (const rawId of raw) {
      const id = String(rawId).trim().toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      if (retained.has(id)) result.push(id);
      else if (visible.has(id) && pending.length) result.push(pending.shift());
    }
    return [...result, ...pending];
  }

  function normalizeLimitProviderOrder(value, providers) {
    const known = providerIds(providers);
    const knownSet = new Set(known);
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    const seen = new Set();
    const order = [];
    for (const item of raw) {
      const id = String(item || '').trim().toLowerCase();
      if (!knownSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
    for (const id of known) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
    return order;
  }

  function normalizeLimitProviderSelection(value, providers) {
    const knownSet = new Set(providerIds(providers));
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    const seen = new Set();
    const selection = [];
    for (const item of raw) {
      const id = String(item || '').trim().toLowerCase();
      if (!knownSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      selection.push(id);
    }
    return selection;
  }

  function orderedLimitProviders(providers, value) {
    const byId = new Map((providers || []).map((provider) => [String(provider.id || '').toLowerCase(), provider]));
    return normalizeLimitProviderOrder(value, providers).map((id) => byId.get(id)).filter(Boolean);
  }

  function moveLimitProvider(value, providers, providerId, direction) {
    const order = normalizeLimitProviderOrder(value, providers);
    const from = order.indexOf(String(providerId || '').trim().toLowerCase());
    const offset = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    const to = from + offset;
    if (from < 0 || offset === 0 || to < 0 || to >= order.length) return order.join(',');
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    return order.join(',');
  }

  function reorderLimitProvider(value, providers, providerId, targetIndex) {
    const order = normalizeLimitProviderOrder(value, providers);
    const from = order.indexOf(String(providerId || '').trim().toLowerCase());
    if (from < 0) return order.join(',');
    const to = Math.max(0, Math.min(order.length - 1, Number(targetIndex) || 0));
    if (from === to) return order.join(',');
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    return order.join(',');
  }

  return {
    absentPluginProviders,
    preserveAbsentPluginOrder,
    moveLimitProvider,
    normalizeLimitProviderOrder,
    normalizeLimitProviderSelection,
    orderedLimitProviders,
    reorderLimitProvider
  };
});
