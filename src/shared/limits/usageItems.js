'use strict';

// Per-provider "visible usage items": which rows of a provider's limits card
// the user has hidden.
//
// The rows themselves are not listed here. The card renderer
// (renderer/limits/windowsView.js) tags every row it draws with the item id
// below, and the settings checklist is read off an unfiltered render, so the
// list can never name a row the card does not draw or miss one it does. This
// module only owns the identity of a row and the stored selection.
//
// `settings.limitProviderHiddenItems` stores the hidden half —
// `{ providerId: [itemId, ...] }` — so a row that appears later is shown by
// default instead of silently missing on upgraded installs.
//
// Pure data and pure functions, no DOM and no Node built-ins: the renderers
// load it as a plain <script>, the main process requires it to normalize the
// setting, and node:test can require it.
(function exposeLimitUsageItems(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(
    node ? require('./providers') : root?.TokenMonitorLimitProviders,
    node ? require('./windowLabels') : root?.TokenMonitorLimitWindowLabels
  );
  if (node) module.exports = api;
  if (root) root.TokenMonitorLimitUsageItems = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLimitUsageItemsApi(limitProviders, windowLabels) {
  // Rows that keep one identity whichever way the payload carries them: the
  // money balance ('credits' — a credits window, a provider-level balance, or
  // Cline's credits row with its spend folded in), the spend line ('spend' — a
  // spend window or the note built from balance spend fields) and the
  // reset-credit line ('resets'). Every other row is keyed by its window.
  const USAGE_ITEM_IDS = Object.freeze(['credits', 'spend', 'resets']);
  const USAGE_ITEM_ID_SET = new Set(USAGE_ITEM_IDS);
  const MAX_HIDDEN_ITEMS = 64;

  function normalizedId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function legacyLimitWindowKey(window) {
    if (!window || typeof window !== 'object' || !window.kind) return '';
    return JSON.stringify([
      String(window.kind), String(window.label || ''),
      String(window.metric || ''), window.additional === true
    ]);
  }

  // Backend ids survive display-name changes. Cadence separates primary and
  // secondary windows belonging to the same metered feature.
  function limitWindowKey(window) {
    const legacy = legacyLimitWindowKey(window);
    if (!legacy) return '';
    const limitId = String(window.limitId || '').trim();
    if (!limitId) return legacy;
    const minutes = Number(window.windowMinutes);
    return JSON.stringify([
      'id', limitId, String(window.kind), String(window.metric || ''),
      window.additional === true,
      Number.isFinite(minutes) && minutes > 0 ? minutes : null
    ]);
  }

  function limitWindowKeys(window) {
    return [...new Set([limitWindowKey(window), legacyLimitWindowKey(window)])].filter(Boolean);
  }

  function parseWindowKey(value) {
    if (typeof value !== 'string' || value.length > 400) return null;
    try {
      const parts = JSON.parse(value);
      if (!Array.isArray(parts)) return null;
      if (parts.length === 6 && parts[0] === 'id') {
        const [, limitId, kind, metric, additional, windowMinutes] = parts;
        if (typeof limitId !== 'string' || !limitId.trim() || typeof kind !== 'string' || !kind
          || typeof metric !== 'string' || typeof additional !== 'boolean'
          || !(windowMinutes === null || (typeof windowMinutes === 'number' && windowMinutes > 0))) return null;
        return { limitId, kind, metric, additional, windowMinutes };
      }
      if (parts.length !== 4) return null;
      const [kind, label, metric, additional] = parts;
      if (typeof kind !== 'string' || !kind || typeof label !== 'string'
        || typeof metric !== 'string' || typeof additional !== 'boolean') return null;
      return { kind, label, metric, additional };
    } catch (_) { return null; }
  }

  // A stored key in canonical form, or '' when `limitWindowKey` could not have
  // produced it.
  function normalizeWindowKey(value) {
    const window = parseWindowKey(value);
    return window ? limitWindowKey(window) : '';
  }

  // The item a window's row belongs to.
  function limitUsageItemId(window) {
    const metric = normalizedId(window?.metric);
    if (metric === 'credits' || metric === 'spend') return metric;
    return limitWindowKey(window);
  }

  function normalizeUsageItemId(value) {
    const id = typeof value === 'string' ? value.trim() : '';
    return USAGE_ITEM_ID_SET.has(id) ? id : normalizeWindowKey(id);
  }

  // What a hidden item is called while nothing in the payload draws it, so it
  // can still be listed and shown again. Window keys name themselves from
  // their kind; the fixed items return '' and the caller localizes them.
  function usageItemFallbackLabel(providerId, itemId) {
    if (USAGE_ITEM_ID_SET.has(itemId)) return '';
    const window = parseWindowKey(itemId);
    if (!window) return '';
    return windowLabels?.limitWindowLabel(normalizedId(providerId), window) || String(window.kind);
  }

  function hiddenItemList(raw) {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map(normalizeUsageItemId).filter(Boolean))].slice(0, MAX_HIDDEN_ITEMS);
  }

  // The whole setting. Unknown providers, malformed ids and empty selections
  // are dropped, so a provider with nothing hidden has no entry at all.
  function normalizeLimitProviderHiddenItems(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    const providerIds = new Set((limitProviders?.LIMIT_PROVIDER_IDS || []).map(normalizedId));
    for (const [key, raw] of Object.entries(value)) {
      const provider = normalizedId(key);
      if (!providerIds.has(provider)) continue;
      const items = hiddenItemList(raw);
      if (items.length) result[provider] = items;
    }
    return result;
  }

  function hiddenUsageItemSet(value, providerId) {
    const raw = value && typeof value === 'object' && !Array.isArray(value)
      ? value[normalizedId(providerId)]
      : null;
    return new Set(hiddenItemList(raw));
  }

  // The next setting value with one item shown or hidden.
  function setUsageItemHidden(value, providerId, itemId, hidden) {
    const provider = normalizedId(providerId);
    const items = hiddenUsageItemSet(value, provider);
    if (hidden) items.add(itemId);
    else items.delete(itemId);
    return normalizeLimitProviderHiddenItems({ ...(value || {}), [provider]: [...items] });
  }

  function restoreUsageItemDefaults(value, providerId) {
    return normalizeLimitProviderHiddenItems({ ...(value || {}), [normalizedId(providerId)]: [] });
  }

  // For surfaces that list a provider's windows rather than its card rows (the
  // Home module, the dock's pinned-window picker). Codex's additional pools are
  // governed by their own switch and never appear on the checklist, so no
  // stored id can hide them.
  function isLimitWindowHidden(value, providerId, window) {
    if (normalizedId(providerId) === 'codex' && window?.additional === true) return false;
    const hidden = hiddenUsageItemSet(value, providerId);
    return hidden.size > 0 && hidden.has(limitUsageItemId(window));
  }

  return {
    USAGE_ITEM_IDS,
    hiddenUsageItemSet,
    isLimitWindowHidden,
    legacyLimitWindowKey,
    limitUsageItemId,
    limitWindowKey,
    limitWindowKeys,
    normalizeLimitProviderHiddenItems,
    normalizeWindowKey,
    restoreUsageItemDefaults,
    setUsageItemHidden,
    usageItemFallbackLabel
  };
});
