'use strict';

(function exposeHomeModulePreferences(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorHomeModulePreferences = api;
})(typeof window !== 'undefined' ? window : null, function createHomeModulePreferencesApi() {
  const DEFAULT_HOME_MODULE_ORDER = 'limits,tool,model,session,device,trends';

  const HOME_MODULE_COUNT_MAX = 50;
  // Plugin views placed on Home (`plugin:<pluginId>/<viewId>`). They are kept
  // in the stored order even when the plugin is missing, so disabling or
  // reinstalling a plugin does not lose where the user put it.
  const PLUGIN_MODULE_RE = /^plugin:[a-z0-9][a-z0-9-]{1,39}\/[a-z][a-z0-9-]{0,31}$/;

  function isPluginModuleId(id) {
    return PLUGIN_MODULE_RE.test(String(id || ''));
  }
  const HOME_MODULE_COUNT_DEFAULTS = Object.freeze({ tool: 5, model: 5, session: 5, device: 4 });

  function normalizeHomeModuleCounts(value, previous) {
    const counts = {};
    for (const [id, fallback] of Object.entries(HOME_MODULE_COUNT_DEFAULTS)) {
      const raw = value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, id)
        ? value[id] : previous?.[id];
      const count = typeof raw === 'number' || (typeof raw === 'string' && raw.trim())
        ? Math.trunc(Number(raw)) : NaN;
      counts[id] = Number.isFinite(count) ? Math.max(1, Math.min(HOME_MODULE_COUNT_MAX, count)) : fallback;
    }
    return counts;
  }

  function homeModuleCount(settings, id) {
    return normalizeHomeModuleCounts(settings?.homeModuleCounts)[id];
  }

  function normalizeHomeLimitDisplayMode(value) {
    return value === 'bars' ? 'bars' : 'text';
  }

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
      if ((!knownSet.has(id) && !isPluginModuleId(id)) || seen.has(id)) continue;
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
      if ((!knownSet.has(id) && !isPluginModuleId(id)) || seen.has(id)) continue;
      seen.add(id);
      hidden.push(id);
    }
    // Hiding every known module is not a layout; plugin entries the caller
    // does not know about are carried through untouched.
    const knownHidden = hidden.filter((id) => knownSet.has(id));
    return knownHidden.length >= known.length ? hidden.filter((id) => !knownSet.has(id)).join(',') : hidden.join(',');
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
      hiddenHomeModules: 'tool,device'
    };
  }

  return {
    DEFAULT_HOME_MODULE_ORDER,
    HOME_MODULE_COUNT_MAX,
    homeModuleCount,
    normalizeHomeModuleCounts,
    defaultHomeModulePreferences,
    isPluginModuleId,
    moveHomeModuleOrder,
    normalizeHiddenHomeModules,
    normalizeHomeLimitDisplayMode,
    normalizeHomeModuleOrder,
    orderedHomeModules,
    reorderHomeModuleOrder
  };
});
