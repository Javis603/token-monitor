'use strict';

(function exposeLimitProviderOrder(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitProviderOrder = api;
})(typeof window !== 'undefined' ? window : null, function createLimitProviderOrderApi() {
  function providerIds(providers) {
    return (providers || []).map((provider) => String(provider?.id || '').trim().toLowerCase()).filter(Boolean);
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
    moveLimitProvider,
    normalizeLimitProviderOrder,
    normalizeLimitProviderSelection,
    orderedLimitProviders,
    reorderLimitProvider
  };
});
