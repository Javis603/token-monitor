'use strict';

// Desktop-only registry. These records never enter DeviceRecord or Hub history.
const { normalizeLimitWindow } = require('../../shared/limits/core');
const { createLimitsRuntime } = require('../../shared/limits/runtime');
const MODULE_ID = /^plugin:[a-z0-9][a-z0-9-]{1,39}:[a-z][a-z0-9-]{0,31}$/;
const identity = (plugin, module) => `plugin:${plugin}:${module}`;
function desktopProviderPreference(value, builtins) {
  const native = builtins(value), allowed = new Set(native);
  if (value === undefined || value === null) return native.join(',');
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(raw.map(id => String(id).trim().toLowerCase()).filter(id => allowed.has(id) || MODULE_ID.test(id)))].join(',');
}
function normalizeReading(input, provider) {
  if (!input || !['ok', 'notConfigured', 'unauthorized', 'rateLimited', 'unavailable', 'error'].includes(input.status)
    || !Array.isArray(input.windows) || input.windows.length > 16) throw Error('Invalid plugin limits reading');
  const windows = input.windows.map(normalizeLimitWindow);
  if (windows.some(window => !window)) throw Error('Invalid plugin limits window');
  return { provider, status: input.status, windows, plan: typeof input.plan === 'string' ? input.plan.slice(0, 80) : '', updatedAt: Number.isFinite(Date.parse(input.updatedAt)) ? new Date(input.updatedAt).toISOString() : new Date().toISOString() };
}
function createPluginLimits({ manager, getSettings, changed }) {
  let runtime = null, disposed = false;
  let byId = new Map();
  const demands = new Map();
  function catalog() {
    return manager.list().plugins.filter(plugin => plugin.status === 'active').flatMap(plugin => (plugin.limits || []).map(module => ({
      ...module, id: identity(plugin.id, module.id), moduleId: module.id, pluginId: plugin.id, label: module.name,
      settingsLabel: module.name, revision: plugin.revision, sampling: runtime !== null && byId.has(identity(plugin.id, module.id))
    })));
  }
  function reconcile() {
    if (disposed) return;
    const settings = getSettings(), modules = catalog();
    const selected = modules.filter(module => demands.size > 0 && settings.limitsEnabled !== false && String(settings.limitProviders || '').split(',').includes(module.id));
    const previous = byId;
    byId = new Map(selected.map(module => [module.id, module]));
    if (!selected.length) { runtime?.stop(); runtime = null; return; }
    const options = { limitsEnabled: true, limitProviders: selected.map(module => module.id), limitsRefreshMs: settings.limitsRefreshMs, limitsRefreshMode: settings.limitsRefreshMode };
    if (runtime) {
      const revisions = selected.filter(module => previous.has(module.id) && previous.get(module.id).revision !== module.revision);
      for (const module of revisions) runtime.clear({ provider: module.id }, 'plugin revision changed');
      runtime.reconfigure(options);
      for (const module of revisions) void runtime.refresh({ provider: module.id }, 'settings-change');
      return;
    }
    runtime = createLimitsRuntime(options, {
      autoStart: false,
      parseProviders: value => (Array.isArray(value) ? value : String(value || '').split(',')).filter(id => byId.has(id)),
      normalizeProvider: value => {
        if (!byId.has(value?.provider)) return null;
        try { return normalizeReading(value, value.provider); } catch { return null; }
      },
      normalizeSummary: value => ({ ...value, providers: value.providers || [] }),
      providerPhysicalBoundMs: () => 30000,
      probeProvider: async (id, _options, { signal }) => {
        const module = byId.get(id);
        if (signal.aborted) return [];
        const value = await manager.call(module.pluginId, 'limits.collect', { moduleId: module.moduleId });
        if (signal.aborted) return [];
        return [normalizeReading(value, id)];
      }
    });
    runtime.subscribe(changed); runtime.start();
  }
  return { catalog, records: () => runtime?.getSnapshot().providers || [], reconcile,
    demand(value, owner = 'main.limits') {
      if (demands.has(owner) === (value === true)) return;
      if (value === true) demands.set(owner, true); else demands.delete(owner);
      reconcile();
    },
    refresh(id, reason = 'credential-change') { return runtime?.refresh(id ? { provider: id } : {}, reason) || Promise.resolve(); },
    dispose() { disposed = true; runtime?.stop(); runtime = null; } };
}
module.exports = { MODULE_ID, identity, desktopProviderPreference, normalizeReading, createPluginLimits };
