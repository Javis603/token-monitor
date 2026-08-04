'use strict';

(function exposeClientDisplayPreferences(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorClientDisplayPreferences = api;
})(typeof window !== 'undefined' ? window : null, function createClientDisplayPreferencesApi() {
  function normalizeId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function clientIds(clients) {
    return (clients || [])
      .map((client) => normalizeId(typeof client === 'string' ? client : client?.id))
      .filter(Boolean);
  }

  function csvItems(value) {
    return Array.isArray(value) ? value : String(value || '').split(',');
  }

  function hasCustomDisplayOrder(value) {
    return csvItems(value).some((item) => normalizeId(item));
  }

  function defaultClientDisplayPreferences() {
    return { clientDisplayOrder: '', hiddenClients: '', pinnedClients: '' };
  }

  function normalizeClientDisplayOrder(value, clients) {
    const known = clientIds(clients);
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

  function normalizeSelectedClients(value, clients) {
    const knownSet = new Set(clientIds(clients));
    const seen = new Set();
    const selected = [];
    for (const item of csvItems(value)) {
      const id = normalizeId(item);
      if (!knownSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      selected.push(id);
    }
    return selected;
  }

  function normalizeHiddenClients(value, clients) {
    return normalizeSelectedClients(value, clients).join(',');
  }

  function normalizePinnedClients(value, clients) {
    return normalizeSelectedClients(value, clients).join(',');
  }

  function pinnedClientIds(value, clients) {
    return normalizePinnedClients(value, clients).split(',').filter(Boolean);
  }

  function orderPinnedIds(ids, pinnedValue, clients) {
    const pinned = pinnedClientIds(pinnedValue, clients);
    if (pinned.length === 0) return ids;
    const allowed = new Set(ids);
    const pinnedSet = new Set(pinned);
    return [
      ...pinned.filter((id) => allowed.has(id)),
      ...ids.filter((id) => !pinnedSet.has(id))
    ];
  }

  function orderedClients(clients, value, pinnedValue) {
    const byId = new Map((clients || []).map((client) => [normalizeId(client?.id), client]));
    const order = normalizeClientDisplayOrder(value, clients);
    const ids = hasCustomDisplayOrder(value) ? order : orderPinnedIds(order, pinnedValue, clients);
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function moveClientDisplayOrder(value, clients, clientId, direction) {
    const order = normalizeClientDisplayOrder(value, clients);
    const from = order.indexOf(normalizeId(clientId));
    const offset = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    const to = from + offset;
    if (from < 0 || offset === 0 || to < 0 || to >= order.length) return order.join(',');
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    return order.join(',');
  }

  function reorderClientDisplayOrder(value, clients, clientId, targetIndex) {
    const order = normalizeClientDisplayOrder(value, clients);
    const from = order.indexOf(normalizeId(clientId));
    if (from < 0) return order.join(',');
    const to = Math.max(0, Math.min(order.length - 1, Number(targetIndex) || 0));
    if (from === to) return order.join(',');
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    return order.join(',');
  }

  function togglePinnedClient(value, clients, clientId) {
    const id = normalizeId(clientId);
    const known = new Set(clientIds(clients));
    if (!known.has(id)) return normalizePinnedClients(value, clients);
    const pinned = pinnedClientIds(value, clients);
    const index = pinned.indexOf(id);
    if (index >= 0) pinned.splice(index, 1);
    else pinned.push(id);
    return pinned.join(',');
  }

  function movePinnedClient(value, clients, clientId, direction) {
    const pinned = pinnedClientIds(value, clients);
    const from = pinned.indexOf(normalizeId(clientId));
    const offset = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    const to = from + offset;
    if (from < 0 || offset === 0 || to < 0 || to >= pinned.length) return pinned.join(',');
    const [item] = pinned.splice(from, 1);
    pinned.splice(to, 0, item);
    return pinned.join(',');
  }

  function reorderPinnedClient(value, clients, clientId, targetIndex) {
    const pinned = pinnedClientIds(value, clients);
    const from = pinned.indexOf(normalizeId(clientId));
    if (from < 0) return pinned.join(',');
    const to = Math.max(0, Math.min(pinned.length - 1, Number(targetIndex) || 0));
    if (from === to) return pinned.join(',');
    const [item] = pinned.splice(from, 1);
    pinned.splice(to, 0, item);
    return pinned.join(',');
  }

  // A whole-row drag hands back the list exactly as it was dropped; this turns
  // that into the settings patch it means. While no explicit display order
  // exists the pinned block is the only thing shaping the list, so a drop that
  // merely reshuffles that block stays a pin change and leaves everything below
  // it on the default order. Any other drop is the user taking the order over,
  // which pins cannot express, so it becomes an explicit order and clears them.
  function clientDisplayOrderCommit(order, clients, orderValue, pinnedValue, clientId) {
    const next = normalizeClientDisplayOrder(order, clients);
    const pinned = pinnedClientIds(pinnedValue, clients);
    const pinnedSet = new Set(pinned);
    const head = next.slice(0, pinned.length);
    const withinPinnedBlock = pinnedSet.has(normalizeId(clientId))
      && head.length === pinned.length
      && head.every((id) => pinnedSet.has(id));
    if (!hasCustomDisplayOrder(orderValue) && withinPinnedBlock) return { pinnedClients: head.join(',') };
    return { clientDisplayOrder: next.join(','), pinnedClients: '' };
  }

  function applyClientDisplayPreferences(rows, orderValue, hiddenValue, clients, pinnedValue) {
    const hidden = new Set(normalizeHiddenClients(hiddenValue, clients).split(',').filter(Boolean));
    const visible = (rows || []).filter((row) => !hidden.has(normalizeId(row?.key)));
    if (!hasCustomDisplayOrder(orderValue)) return applyPinnedClientDisplayPreferences(visible, pinnedValue, clients);

    const orderIndex = new Map(normalizeClientDisplayOrder(orderValue, clients).map((id, index) => [id, index]));
    const fallbackIndex = Number.MAX_SAFE_INTEGER;
    return visible.slice().sort((a, b) => {
      const aIndex = orderIndex.has(normalizeId(a?.key)) ? orderIndex.get(normalizeId(a?.key)) : fallbackIndex;
      const bIndex = orderIndex.has(normalizeId(b?.key)) ? orderIndex.get(normalizeId(b?.key)) : fallbackIndex;
      return aIndex - bIndex;
    });
  }

  function applyPinnedClientDisplayPreferences(rows, pinnedValue, clients) {
    const pinned = pinnedClientIds(pinnedValue, clients);
    if (pinned.length === 0) return rows;
    const pinnedIndex = new Map(pinned.map((id, index) => [id, index]));
    return (rows || []).slice().sort((a, b) => {
      const aIndex = pinnedIndex.get(normalizeId(a?.key));
      const bIndex = pinnedIndex.get(normalizeId(b?.key));
      const aPinned = aIndex !== undefined;
      const bPinned = bIndex !== undefined;
      if (aPinned && bPinned) return aIndex - bIndex;
      if (aPinned) return -1;
      if (bPinned) return 1;
      return 0;
    });
  }

  function hasClientDisplayPreferences(orderValue, hiddenValue, clients, pinnedValue) {
    const hasKnownOrder = normalizeClientDisplayOrder(orderValue, clients).some((id) => {
      return csvItems(orderValue).some((item) => normalizeId(item) === id);
    });
    return hasKnownOrder || normalizeHiddenClients(hiddenValue, clients).length > 0 || normalizePinnedClients(pinnedValue, clients).length > 0;
  }

  return {
    applyClientDisplayPreferences,
    clientDisplayOrderCommit,
    defaultClientDisplayPreferences,
    hasClientDisplayPreferences,
    hasCustomDisplayOrder,
    moveClientDisplayOrder,
    movePinnedClient,
    normalizeClientDisplayOrder,
    normalizeHiddenClients,
    normalizePinnedClients,
    orderedClients,
    reorderClientDisplayOrder,
    reorderPinnedClient,
    togglePinnedClient
  };
});
