'use strict';

(function exposeHomeModulePreferences(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorHomeModulePreferences = api;
})(typeof window !== 'undefined' ? window : null, function createHomeModulePreferencesApi() {
  const DEFAULT_HOME_MODULE_ORDER = 'limits,tool,device,model,trends,liveRate';

  function optionIds(options) {
    return (options || []).map((option) => String(option?.id || '').trim().toLowerCase()).filter(Boolean);
  }

  function normalizeHomeModuleOrder(value, options) {
    const known = optionIds(options);
    const knownSet = new Set(known);
    const raw = Array.isArray(value) ? value : String(value || DEFAULT_HOME_MODULE_ORDER).split(',');
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

  function normalizeHiddenHomeModules(value, options) {
    const known = optionIds(options);
    const knownSet = new Set(known);
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    const hidden = [];
    const seen = new Set();
    for (const item of raw) {
      const id = String(item || '').trim().toLowerCase();
      if (!knownSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      hidden.push(id);
    }
    return hidden.length >= known.length ? '' : hidden.join(',');
  }

  function orderedHomeModules(options, value) {
    const byId = new Map((options || []).map((option) => [String(option.id || '').toLowerCase(), option]));
    return normalizeHomeModuleOrder(value, options).map((id) => byId.get(id)).filter(Boolean);
  }

  function moveHomeModuleOrder(value, options, moduleId, direction) {
    const order = normalizeHomeModuleOrder(value, options);
    const from = order.indexOf(String(moduleId || '').trim().toLowerCase());
    const offset = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    const to = from + offset;
    if (from < 0 || offset === 0 || to < 0 || to >= order.length) return order.join(',');
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    return order.join(',');
  }

  function reorderHomeModuleOrder(value, options, moduleId, targetIndex) {
    const order = normalizeHomeModuleOrder(value, options);
    const from = order.indexOf(String(moduleId || '').trim().toLowerCase());
    if (from < 0) return order.join(',');
    const to = Math.max(0, Math.min(order.length - 1, Number(targetIndex) || 0));
    if (from === to) return order.join(',');
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    return order.join(',');
  }

  function defaultHomeModulePreferences() {
    return {
      homeModuleOrder: DEFAULT_HOME_MODULE_ORDER,
      // tool/device stay hidden from the original overview decision; a new module
      // starts hidden too, so an upgrade never reshuffles an existing Home layout.
      hiddenHomeModules: 'tool,device,liveRate'
    };
  }

  return {
    DEFAULT_HOME_MODULE_ORDER,
    defaultHomeModulePreferences,
    moveHomeModuleOrder,
    normalizeHiddenHomeModules,
    normalizeHomeModuleOrder,
    orderedHomeModules,
    reorderHomeModuleOrder
  };
});
