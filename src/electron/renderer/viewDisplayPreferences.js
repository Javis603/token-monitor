'use strict';

(function exposeViewDisplayPreferences(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorViewDisplayPreferences = api;
})(typeof window !== 'undefined' ? window : null, function createViewDisplayPreferencesApi() {
  function normalizeId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function csvItems(value) {
    return Array.isArray(value) ? value : String(value || '').split(',');
  }

  function viewIds(views) {
    return (views || [])
      .map((view) => normalizeId(typeof view === 'string' ? view : view?.id))
      .filter(Boolean);
  }

  function hasCustomViewDisplayOrder(value) {
    return csvItems(value).some((item) => normalizeId(item));
  }

  function defaultViewDisplayPreferences() {
    return { viewDisplayOrder: '', hiddenViews: 'status' };
  }

  function normalizeViewDisplayOrder(value, views) {
    const known = viewIds(views);
    const knownSet = new Set(known);
    const seen = new Set();
    const order = [];
    for (const item of csvItems(value)) {
      const id = normalizeId(item);
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

  function normalizeHiddenViews(value, views) {
    const known = viewIds(views);
    const knownSet = new Set(known);
    const seen = new Set();
    const hidden = [];
    for (const item of csvItems(value)) {
      const id = normalizeId(item);
      if (!knownSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      hidden.push(id);
    }
    return hidden.length >= known.length ? '' : hidden.join(',');
  }

  function orderedViews(views, value) {
    const byId = new Map((views || []).map((view) => [normalizeId(view?.id), view]));
    return normalizeViewDisplayOrder(value, views).map((id) => byId.get(id)).filter(Boolean);
  }

  function moveViewDisplayOrder(value, views, viewId, direction) {
    const order = normalizeViewDisplayOrder(value, views);
    const from = order.indexOf(normalizeId(viewId));
    const offset = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    const to = from + offset;
    if (from < 0 || offset === 0 || to < 0 || to >= order.length) return order.join(',');
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    return order.join(',');
  }

  function reorderViewDisplayOrder(value, views, viewId, targetIndex) {
    const order = normalizeViewDisplayOrder(value, views);
    const from = order.indexOf(normalizeId(viewId));
    if (from < 0) return order.join(',');
    const to = Math.max(0, Math.min(order.length - 1, Number(targetIndex) || 0));
    if (from === to) return order.join(',');
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    return order.join(',');
  }

  function visibleViewOrder({ views, orderValue, hiddenValue, availableIds, includeIds } = {}) {
    const ordered = normalizeViewDisplayOrder(orderValue, views);
    const available = new Set((availableIds || ordered).map(normalizeId).filter(Boolean));
    const hidden = new Set(normalizeHiddenViews(hiddenValue, views).split(',').filter(Boolean));
    const included = new Set((includeIds || []).map(normalizeId).filter(Boolean));
    const visible = ordered.filter((id) => available.has(id) && (!hidden.has(id) || included.has(id)));
    if (visible.length > 0) return visible;
    return ordered.filter((id) => available.has(id)).slice(0, 1);
  }

  function preferredViewId({ views, orderValue, hiddenValue, availableIds, currentId, preferFirst = false, fallback = 'tool' } = {}) {
    const order = visibleViewOrder({ views, orderValue, hiddenValue, availableIds });
    const current = normalizeId(currentId);
    if (!preferFirst && order.includes(current)) return current;
    return order[0] || fallback;
  }

  function hasViewDisplayPreferences(orderValue, hiddenValue, views) {
    const rawOrder = new Set(csvItems(orderValue).map(normalizeId).filter(Boolean));
    const hasKnownOrder = normalizeViewDisplayOrder(orderValue, views).some((id) => rawOrder.has(id));
    return hasKnownOrder || normalizeHiddenViews(hiddenValue, views).length > 0;
  }

  return {
    defaultViewDisplayPreferences,
    hasCustomViewDisplayOrder,
    hasViewDisplayPreferences,
    moveViewDisplayOrder,
    normalizeHiddenViews,
    normalizeViewDisplayOrder,
    orderedViews,
    preferredViewId,
    reorderViewDisplayOrder,
    visibleViewOrder
  };
});
