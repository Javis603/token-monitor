'use strict';

(function exposeServiceStatusProviderPreferences(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorServiceStatusProviderPreferences = api;
})(typeof window !== 'undefined' ? window : null, function createServiceStatusProviderPreferencesApi() {
  function normalizeId(value) {
    return String(value || '').trim();
  }
  function csvItems(value) {
    return normalizeId(value).split(',').map(normalizeId).filter(Boolean);
  }
  function optionIds(options) {
    return (Array.isArray(options) ? options : []).map((option) => normalizeId(option && option.id)).filter(Boolean);
  }

  function normalizeOrder(value, options) {
    const ids = optionIds(options);
    const known = new Set(ids);
    const seen = new Set();
    const ordered = [];
    for (const id of csvItems(value)) {
      if (known.has(id) && !seen.has(id)) { seen.add(id); ordered.push(id); }
    }
    for (const id of ids) if (!seen.has(id)) ordered.push(id);
    return ordered;
  }

  function hasCustomOrder(value) {
    return csvItems(value).length > 0;
  }

  function normalizeHidden(value, options) {
    const known = new Set(optionIds(options));
    const seen = new Set();
    const hidden = [];
    for (const id of csvItems(value)) {
      if (known.has(id) && !seen.has(id)) { seen.add(id); hidden.push(id); }
    }
    return hidden.join(',');
  }

  function orderedOptions(options, value) {
    const order = normalizeOrder(value, options);
    const byId = new Map((Array.isArray(options) ? options : []).map((option) => [normalizeId(option && option.id), option]));
    return order.map((id) => byId.get(id)).filter(Boolean);
  }

  function moveOrder(value, options, id, direction) {
    const order = normalizeOrder(value, options);
    const cleanId = normalizeId(id);
    const index = order.indexOf(cleanId);
    if (index < 0) return order.join(',');
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= order.length) return order.join(',');
    const next = order.slice();
    next.splice(index, 1);
    next.splice(target, 0, cleanId);
    return next.join(',');
  }

  function reorderOrder(value, options, id, targetIndex) {
    const order = normalizeOrder(value, options);
    const cleanId = normalizeId(id);
    if (!order.includes(cleanId)) return order.join(',');
    const next = order.filter((entry) => entry !== cleanId);
    const clamped = Math.max(0, Math.min(next.length, Number(targetIndex) || 0));
    next.splice(clamped, 0, cleanId);
    return next.join(',');
  }

  function visibleOrder(options, orderValue, hiddenValue) {
    const hidden = new Set(csvItems(normalizeHidden(hiddenValue, options)));
    return normalizeOrder(orderValue, options).filter((id) => !hidden.has(id));
  }

  return { normalizeOrder, hasCustomOrder, normalizeHidden, orderedOptions, moveOrder, reorderOrder, visibleOrder };
});
