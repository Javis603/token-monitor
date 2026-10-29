'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { packageDirectory, contentDigest } = require('./package');
const { localize } = require('../../shared/plugins/localized');
const { ID_RE, SURFACES } = require('../../shared/plugins/manifest');
const { normalizeAppearance } = require('../../shared/plugins/appearance');
const { pluginTypes } = require('./types');
const { createPluginBackends } = require('./backend');
const { summaryBitmapRefs } = require('./placementSettings');

function normalizePluginStates(value) {
  const result = {};
  for (const [id, state] of Object.entries(value || {})) {
    if (!ID_RE.test(id) || !state || typeof state !== 'object') continue;
    result[id] = { enabled: state.enabled === true, background: state.background === true,
      trustedRevision: typeof state.trustedRevision === 'string' && /^[a-f0-9]{64}$/.test(state.trustedRevision) ? state.trustedRevision : null };
  }
  return result;
}
function createPluginManager({ userDir, dataDir, getSettings, saveStates, getLocale = () => 'en', authorSettings, safeMode = false,
  fork, hostCall = async () => { throw new Error('Unknown host operation'); }, log = () => {} }) {
  const plugins = new Map(), demands = new Map(), changes = new Set(), views = new Set(), listeners = new Set();
  const mutating = new Set();
  let disposed = false, hostContext = {};
  const states = () => normalizePluginStates(getSettings()?.pluginStates);
  const master = () => !safeMode && !disposed && getSettings()?.pluginsEnabled !== false;
  const active = plugin => master() && plugin?.manifest && !mutating.has(plugin.id) && states()[plugin.id]?.enabled && states()[plugin.id]?.trustedRevision === plugin.revision;
  function addLog(id, message) {
    const plugin = plugins.get(id);
    if (!plugin) return;
    plugin.logs.push({ at: Date.now(), level: 'info', text: String(message).slice(0, 2000) });
    if (plugin.logs.length > 100) plugin.logs.shift();
    log(`[plugins:${id}] ${message}`);
  }
  const backends = createPluginBackends({ fork,
    hostCall: (id, method, args) => { if (!active(plugins.get(id))) throw new Error('Plugin is disabled'); return hostCall(id, method, args); },
    onData(id, value) {
      const plugin = plugins.get(id);
      if (!active(plugin)) return;
      plugin.data = value;
      for (const listener of listeners) { try { listener(id, value); } catch (error) { log(error.message); } }
      for (const surface of SURFACES) for (const fn of views) { try { fn(surface, payload(surface)); } catch (error) { log(error.message); } }
    },
    log: addLog,
    onError(id, error) { const plugin = plugins.get(id); if (!plugin) return; plugin.failure = error; backends.stop(id); addLog(id, error); emit(); }
  });
  function emit() {
    for (const fn of changes) { try { fn(); } catch (error) { log(error.message); } }
    for (const surface of SURFACES) for (const fn of views) { try { fn(surface, payload(surface)); } catch (error) { log(error.message); } }
  }
  function selected(plugin) {
    return [...demands.values()].some(refs => refs.some(ref => ref.startsWith(plugin.id + '/')));
  }
  function wanted(plugin) {
    return plugins.get(plugin.id) === plugin && active(plugin) && plugin.manifest.backend && !plugin.failure
      && (selected(plugin) || (plugin.manifest.background && states()[plugin.id]?.background) || plugin.calls > 0);
  }
  function startBackend(plugin) {
    if (plugin.starting) return plugin.starting;
    try {
      if (!backends.has(plugin.id) && contentDigest(packageDirectory(plugin.dir)) !== plugin.revision) throw new Error('Package changed; Reload and review the new revision before running it');
    } catch (error) {
      plugin.failure = error.message;
      emit(); return Promise.reject(error);
    }
    plugin.starting = backends.start(plugin.id, path.join(plugin.dir, plugin.manifest.backend), path.join(dataDir, plugin.id), () => wanted(plugin))
      .catch(error => {
        if (!plugin.cancelledStart && wanted(plugin)) { plugin.failure = error.message; emit(); }
        throw error;
      })
      .finally(() => {
        const cancelled = plugin.cancelledStart;
        plugin.cancelledStart = false;
        plugin.starting = null;
        // A visibility change can stop activation before ready, then request
        // it again while that promise is still settling. Real failures set
        // plugin.failure and remain stopped; cancelled activation may resume.
        if (cancelled && wanted(plugin) && !backends.has(plugin.id)) reconcile();
      });
    return plugin.starting;
  }
  function reconcile() {
    for (const plugin of plugins.values()) {
      if (!wanted(plugin)) { if (plugin.starting) plugin.cancelledStart = true; backends.stop(plugin.id); continue; }
      void startBackend(plugin).then(() => {
        if (wanted(plugin)) backends.update(plugin.id, { ...hostContext, visible: selected(plugin), background: states()[plugin.id]?.background === true });
      }).catch(() => {});
    }
  }
  function status(plugin) {
    if (!plugin.manifest) return 'invalid';
    if (safeMode) return 'safeMode';
    if (getSettings()?.pluginsEnabled === false) return 'disabled';
    const state = states()[plugin.id];
    if (!state?.enabled) return 'disabled';
    if (state.trustedRevision !== plugin.revision) return 'needsApproval';
    return 'active';
  }
  function descriptor(plugin, view) {
    const base = `tm-plugin://${plugin.id}/${plugin.revision}/`;
    return { ...view, identityIcon: plugin.manifest.identityIcon, title: localize(view.title, getLocale()), pluginId: plugin.id, ref: `${plugin.id}/${view.id}`,
      contentOrder: Object.fromEntries((view.targets || []).map(target => { const index = (getSettings().pluginContentOrder?.[target] || []).indexOf(`${plugin.id}/${view.id}`); return [target, index < 0 ? Number.MAX_SAFE_INTEGER : index]; })),
      revision: plugin.revision, entry: plugin.manifest.ui ? base + plugin.manifest.ui : null,
      css: plugin.manifest.css.map(name => base + name), data: plugin.data, status: status(plugin) };
  }
  function payload(surface) {
    const bitmapRefs = surface === 'notch' ? summaryBitmapRefs(getSettings()) : [];
    return { surface, appearance: normalizeAppearance(getSettings()?.pluginAuthorSkin?.appearance), views: Object.fromEntries([...plugins.values()].filter(active).flatMap(plugin => plugin.manifest.views
      .filter(view => view.surfaces.includes(surface) || view.targets.length || (view.surfaces.includes('tray') && bitmapRefs.includes(`${plugin.id}/${view.id}`))).map(view => { const value = descriptor(plugin, view); return [value.ref, value]; }))) };
  }
  function describe(plugin) {
    const m = plugin.manifest, state = states()[plugin.id];
    const base = { id: plugin.id, source: 'user', status: status(plugin), enabled: state?.enabled === true, errors: plugin.errors, name: plugin.id };
    if (!m) return base;
    return { ...base, name: localize(m.name, getLocale()), version: m.version, description: localize(m.description, getLocale()),
      author: m.author, homepage: m.homepage, identityIcon: m.identityIcon, types: pluginTypes(m), trustedCode: true, trusted: state?.trustedRevision === plugin.revision,
      hasCode: Boolean(m.ui || m.backend), hasBackend: Boolean(m.backend), settings: m.settings, settingsIdentity: plugin.revision,
      revision: plugin.revision, defaults: m.defaults, views: m.views.map(view => descriptor(plugin, view)),
      skins: m.skins.map(skin => ({ ...skin, ref: `${plugin.id}/${skin.id}`, name: localize(skin.name, getLocale()) })),
      background: { supported: Boolean(m.backend && m.background), enabled: state?.background === true, description: localize(m.backgroundDescription, getLocale()) },
      runtime: m.backend ? { state: plugin.failure ? 'error' : backends.has(plugin.id) ? 'running' : 'idle', mode: selected(plugin) ? 'visible' : 'background',
        cpuPercent: null, memoryMB: null, lastError: plugin.failure } : null, logs: plugin.logs.slice(-20) };
  }
  function requirePlugin(id) { const plugin = plugins.get(id); if (!plugin?.manifest) throw new Error('Plugin is unavailable'); return plugin; }
  function writeState(id, patch) { const current = states(); saveStates({ ...current, [id]: { ...current[id], ...patch } }); }
  async function reload(id) {
    await (id === undefined ? backends.dispose() : backends.stop(id));
    if (disposed) return;
    if (id === undefined) plugins.clear();
    else plugins.delete(id);
    let entries = [];
    try { entries = fs.readdirSync(userDir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') log(error.message); }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name) || (id !== undefined && entry.name !== id)) continue;
      const plugin = { id: entry.name, dir: path.join(userDir, entry.name), manifest: null, errors: [], logs: [], calls: 0, data: null, failure: null };
      try {
        const pkg = packageDirectory(plugin.dir);
        if (pkg.manifest.id !== entry.name) throw new Error('Plugin id must match its directory');
        Object.assign(plugin, { manifest: pkg.manifest, revision: contentDigest(pkg), files: pkg.files });
      } catch (error) { plugin.errors.push(error.message); }
      plugins.set(plugin.id, plugin);
    }
    // Publish the committed or recovered revision once endMutation runs.
    // An intermediate disabled catalog would navigate away from its page.
    reconcile(); if (!mutating.has(id)) emit();
  }
  return {
    reload, list: () => ({ enabled: master(), safeMode, plugins: [...plugins.values()].map(describe) }), payload,
    surfaceCatalog: surface => Object.values(payload(surface).views),
    trayMenu: () => [...plugins.values()].filter(active).flatMap(plugin => plugin.manifest.trayMenu.map(item => ({ pluginId: plugin.id, id: item.id,
      pluginName: localize(plugin.manifest.name, getLocale()), label: localize(item.label, getLocale()) }))),
    hasActive: () => [...plugins.values()].some(active),
    onChanged(fn) { changes.add(fn); return () => changes.delete(fn); },
    onViews(fn) { views.add(fn); return () => views.delete(fn); },
    onData(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setSurfaceDemand(surface, refs) { demands.set(surface, refs); reconcile(); },
    settingsChanged() { reconcile(); emit(); },
    contextChanged(value) { hostContext = value; reconcile(); },
    setEnabled(id, enabled) { const plugin = requirePlugin(id); writeState(id, { enabled, trustedRevision: enabled ? plugin.revision : states()[id]?.trustedRevision }); reconcile(); emit(); },
    setBackground(id, enabled) { requirePlugin(id); writeState(id, { background: enabled }); reconcile(); emit(); },
    restart(id) { const plugin = requirePlugin(id); if (plugin.starting) plugin.cancelledStart = true; backends.stop(id); plugin.failure = null; reconcile(); emit(); },
    beginMutation(id) {
      mutating.add(id);
      const plugin = plugins.get(id);
      if (plugin?.starting) plugin.cancelledStart = true;
      return backends.stop(id);
    },
    endMutation(id) { mutating.delete(id); reconcile(); emit(); },
    skins() { return [...plugins.values()].filter(active).flatMap(plugin => describe(plugin).skins); },
    getAuthorSettings(id) { const plugin = requirePlugin(id); return authorSettings.get(id, plugin.manifest.settings); },
    updateAuthorSettings(id, input) { const plugin = requirePlugin(id); const result = authorSettings.update(id, plugin.manifest.settings, input); backends.update(id, { settings: result }); return result; },
    async call(id, method, args) {
      const plugin = requirePlugin(id);
      if (!active(plugin) || !plugin.manifest.backend) throw new Error('Plugin backend is unavailable');
      plugin.calls++; reconcile();
      try { await startBackend(plugin); return await backends.call(id, method, args); }
      finally { plugin.calls--; reconcile(); }
    },
    asset(id, revision, file) {
      const plugin = plugins.get(id);
      if (!active(plugin) || plugin.revision !== revision || !Object.hasOwn(plugin.files, file)) return null;
      return plugin.files[file];
    },
    active: id => Boolean(active(plugins.get(id))),
    backendCount: () => backends.size(),
    dispose() { disposed = true; const stopped = backends.dispose(); changes.clear(); views.clear(); listeners.clear(); plugins.clear(); demands.clear(); return stopped; }
  };
}
module.exports = { SURFACES, normalizePluginStates, createPluginManager };
