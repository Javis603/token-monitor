'use strict';

// Wires the plugin platform into the widget: the Data Bus and its built-in
// sources, the sandbox, the manager, and the IPC each surface uses. main.js
// supplies settings access and the transports; nothing here reaches into
// collection, limits or credentials.

const fs = require('node:fs');
const path = require('node:path');
const { createDataBus } = require('../../shared/plugins/dataBus');
const { registerSystemSources } = require('./systemDetails');
const { createAppSources } = require('./appSources');
const { createBusinessDataService } = require('./businessData');
const { createPluginCapabilities } = require('./capabilities');
const { createPluginSettingsStore } = require('./settings');
const { createPluginSandbox, PLUGIN_SCHEME } = require('./sandbox');
const { createWebUi, WEB_UI_SCHEME, configureWebUiNetworkIsolation } = require('./webUi');
const { createPluginPages } = require('./pages');
const { createManagedPlugins } = require('./managed');
const { createPluginAppearance } = require('./appearance');
const { normalizeAppearance } = require('../../shared/plugins/appearance');
const { createPluginCatalog } = require('./catalog');
const { createPluginManager } = require('./manager');
const { placementPatch, placementsFor } = require('./placementSettings');
const { createElectronNetFetch } = require('../limits/fetch');
const { createOutboundFetch, resolveProxyConfig } = require('../../shared/outboundFetch');

const NET_PARTITION = 'tm-plugin-net';
const CHANGED_THROTTLE_MS = 1000;
const MAIN_SURFACES = new Set(['home', 'tray', 'page']);
const { createSurfaceDemand } = require('./surfaceDemand');

function safeModeRequested(argv = process.argv, env = process.env) {
  return argv.includes('--plugins-safe-mode') || env.TOKEN_MONITOR_PLUGINS_SAFE_MODE === '1';
}

// Applied author presets are snapshots, independent of package lifetime. This
// schema is also used at settings load; no arbitrary CSS or renderer DTO survives.
function normalizePluginAuthorSkin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.ref !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}\/[a-z][a-z0-9-]{0,31}$/.test(value.ref)
    || !value.appearance || typeof value.appearance !== 'object' || Array.isArray(value.appearance)) return null;
  try { return { ref: value.ref, appearance: normalizeAppearance(value.appearance) }; }
  catch { return null; }
}

function createPluginRuntime({
  electron,
  userDataDir,
  getSettings,
  applySettingsPatch,
  persistPluginStates,
  persistManagementSettings,
  getLocale,
  getContext,
  businessAdapters = {},
  isMainSender,
  isSurfaceSender = () => false,
  surfaceContext = () => null,
  placementContext = () => ({}),
  tokenRateApi,
  presentation,
  log = (message) => console.log(message),
  env = process.env
}) {
  const { app, BrowserWindow, Notification, ipcMain, session, shell, dialog } = electron;
  let disposed = false, started = false;
  const ipcHandlers = new Set(), ipcListeners = [], observerCleanup = [];
  const handle = (channel, fn) => {
    ipcMain.handle(channel, (...args) => {
      if (disposed) throw new Error('plugin runtime disposed');
      return fn(...args);
    });
    ipcHandlers.add(channel);
  };
  const on = (channel, fn) => {
    const listener = (...args) => { if (!disposed) fn(...args); };
    ipcMain.on(channel, listener); ipcListeners.push([channel, listener]);
  };
  const safeMode = safeModeRequested(process.argv, env);
  const bus = createDataBus({ onError: (error) => log(`[plugins] source failed: ${error.message}`) });
  registerSystemSources(bus, { powerMonitor: electron.powerMonitor });
  const appSources = createAppSources({ bus, tokenRateApi, presentation, getContext });
  const businessData = createBusinessDataService(businessAdapters);
  let businessStatsSnapshot = null;
  let businessSource = businessAdapters.sourceId?.() || 'local';
  // With no active plugin nothing reads host data, so pushes are only kept
  // (a reference) and published once a plugin becomes active.
  let parkedStats = null;
  let businessResetSource = null;
  let businessRefreshPending = false;
  function observeBusinessSource() {
    const source = businessAdapters.sourceId?.() || 'local';
    if (source !== businessSource) {
      businessSource = source;
      businessStatsSnapshot = null;
      parkedStats = null;
      businessResetSource ??= source;
    }
    return source;
  }
  function resetPublishedSource() {
    if (businessResetSource === null) return;
    // Replay the first crossed source even after A -> B -> A while parked:
    // existing cursors and in-flight loaders must cross a real source fence.
    businessData.publish(null, { sourceId: businessResetSource });
    if (businessResetSource !== businessSource) businessData.publish(null, { sourceId: businessSource });
    appSources.publish({});
    businessResetSource = null;
  }
  function publishHostData({ stats, businessStats, extras }) {
    try {
      resetPublishedSource();
      appSources.publish(stats);
      businessStatsSnapshot = businessStats;
      businessData.publish(businessStats, { ...businessAdapters.extras?.(businessStats), ...extras, sourceId: businessSource });
      businessRefreshPending = false;
    } catch (error) {
      // Plugin data must never stop the host's own dock, tray and window updates.
      log(`[plugins] stats publish failed: ${error.message}`);
    }
  }
  const capabilities = createPluginCapabilities({ businessData });
  const authorSettings = createPluginSettingsStore({ directory: path.join(userDataDir, 'plugin-settings') });
  const userDir = path.join(userDataDir, 'plugins');

  // Requests leave from a cookie-less in-memory session through the same
  // proxy policy as provider calls; the sandbox session itself has no network.
  const proxy = resolveProxyConfig(env);
  const netFetch = proxy.httpProxy || proxy.httpsProxy
    ? createOutboundFetch(env)
    : createElectronNetFetch({ fetch: (input, init) => session.fromPartition(NET_PARTITION, { cache: false }).fetch(input, init) });

  function notify({ title, body }) {
    try {
      if (Notification?.isSupported?.() === false) return;
      new Notification({ title, body, silent: false }).show();
    } catch (error) {
      log(`[plugins] notification failed: ${error.message}`);
    }
  }

  const appearance = createPluginAppearance({ file: path.join(userDataDir, 'plugin-appearance.json') });
  let manager = null;
  const sandbox = safeMode ? null : createPluginSandbox({
    electron: { BrowserWindow, session, app },
    onMessage: (pluginId, message) => manager?.handleMessage(pluginId, message),
    onExit: (pluginId, reason) => manager?.handleExit(pluginId, reason),
    log
  });
  manager = createPluginManager({
    builtinDir: path.join(__dirname, 'builtin'),
    userDir,
    dataDir: path.join(userDataDir, 'plugin-data'),
    bus,
    sandbox,
    notify,
    netFetch,
    capabilities,
    authorSettings,
    getSettings,
    saveStates: persistPluginStates,
    getLocale,
    getAppearance: () => normalizePluginAuthorSkin(getSettings()?.pluginAuthorSkin)?.appearance || appearance.get(),
    safeMode,
    log
  });

  let pages = null;
  const documentCapabilities = {
    call(item, op, args) {
      return capabilities.call(item.owner, op, args, {
        auth: () => {
          try { return { ...manager.webDataAuth(item.ref), revision: item.revision, active: !item.dead && !item.parked && !item.resuming && (!item.awaitingResume || item.authorityRestored === true) }; }
          catch { return { pluginId: item.pluginId, active: false, permissions: [] }; }
        },
        settings: manager.webAuthorSettings(item.ref),
        send: event => { if (!item.view.webContents.isDestroyed()) item.view.webContents.send('plugins:web:business', event); }
      });
    },
    release: owner => capabilities.release(owner)
  };
  function presentationContext(event, surface, ref) {
    const detached = pages?.presentationContext(event, surface, ref);
    if (detached) return detached;
    if (!mainSender(event)) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return null;
    const visible = win.isVisible() && !win.isMinimized();
    if (ref === null) return ['home', 'page', 'settings'].includes(surface) ? { visible } : null;
    const plugin = manager.list().plugins.find(p => p.status === 'active'
      && (surface === 'settings' ? p.id === ref : p.views?.some(view => view.ref === ref && view.surfaces.includes(surface))));
    if (!plugin) return null;
    if (surface === 'settings') return plugin.webDocuments?.some(doc => doc.target === 'settings') ? { visible } : null;
    if (!['home', 'page'].includes(surface) || !placementsFor(getSettings(), ref)[surface]) return null;
    // Placement is authority; foreground demand is visibility. Empty demand
    // must park a reusable document, not revoke its still-valid owner.
    return { visible: visible && subscribers.get(event.sender.id)?.demands.get(surface)?.includes(ref) === true };
  }

  const webUi = electron.WebContentsView ? createWebUi({ electron, manager, bus, isMainSender, surfaceContext,
    presentationContext, documentCapabilities,
    surfacePlaced: (ref, surface) => placementsFor(getSettings(), ref)[surface],
    file: path.join(userDataDir, 'plugin-page-designs.json') }) : null;
  const managed = createManagedPlugins({ root: path.join(userDataDir, 'plugin-manager'), userDir,
    dataDir: path.join(userDataDir, 'plugin-data'), settingsDir: path.join(userDataDir, 'plugin-settings'), manager, getSettings, saveSettings: persistManagementSettings, getLocale });
  try { managed.recover(); }
  catch (error) { log(`[plugins] Plugin management unavailable: ${error.message}`); }
  const catalog = createPluginCatalog({ manager, managed, getLocale, root: path.join(userDataDir, 'plugin-catalogs'), fetchImpl: netFetch });
  const demand = createSurfaceDemand((surface, refs) => manager.setSurfaceDemand(surface, refs));
  const detachedPageOwner = Symbol('detached-pages');
  pages = createPluginPages({ BrowserWindow, ipcMain, manager, getSettings, getLocale,
    onDemand: refs => demand.set(detachedPageOwner, 'page', refs) });

  // Each window that draws plugin views registers which refs it shows on
  // which surface; a surface's demand is the union across its windows.
  const subscribers = new Map();
  const nativeDemandVisible = (webContents, surface) => { const scope = surfaceContext({ sender: webContents }, surface); return scope?.visible === true || scope?.preparing === true; };
  function demandVisible(webContents, surface) {
    if (['home', 'page'].includes(surface)) {
      const win = BrowserWindow.fromWebContents(webContents);
      return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
    }
    return !['notch', 'edgeDock'].includes(surface) || nativeDemandVisible(webContents, surface);
  }
  function setDemand(webContents, surface, refs) {
    let subscriber = subscribers.get(webContents.id);
    if (!subscriber) {
      subscriber = { webContents, demands: new Map() };
      subscribers.set(webContents.id, subscriber);
      const destroyed = () => {
        webUi?.releasePresentationHost?.(webContents);
        subscribers.delete(webContents.id);
        demand.remove(webContents.id);
      };
      webContents.once('destroyed', destroyed);
      observerCleanup.push(() => webContents.removeListener('destroyed', destroyed));
    }
    const allowed = new Set(manager.list().plugins.filter(plugin => plugin.status === 'active')
      .flatMap(plugin => (plugin.views || []).filter(view => view.surfaces.includes(surface)
        && (!['home', 'page', 'notch', 'edgeDock'].includes(surface) || placementsFor(getSettings(), view.ref)[surface])).map(view => view.ref)));
    const selected = Array.isArray(refs) ? refs.filter(ref => typeof ref === 'string' && allowed.has(ref)).slice(0, 32) : [];
    subscriber.demands.set(surface, selected);
    webUi?.refreshPresentations?.();
    // Retain the request across native hide/show, but never grant foreground work while hidden.
    demand.set(webContents.id, surface, demandVisible(webContents, surface) ? selected : []);
    // Opening a view is not a streaming update: resolve existing readings now.
    // This neither samples nor bypasses active placement / native visibility.
    if (!webContents.isDestroyed()) webContents.send('plugins:views', manager.payload(surface));
  }
  manager.onViews((surface, payload) => {
    if (disposed) return;
    for (const subscriber of subscribers.values()) {
      if (!subscriber.demands.has(surface) || subscriber.webContents.isDestroyed()) continue;
      subscriber.webContents.send('plugins:views', payload);
    }
  });

  let changedTimer = null;
  const listListeners = new Set();
  manager.onChanged(() => {
    if (disposed) return;
    observeBusinessSource();
    if (manager.hasActive()) {
      resetPublishedSource();
      if (parkedStats) { const push = parkedStats; parkedStats = null; publishHostData(push); }
      else if (businessRefreshPending) refreshBusinessData();
    }
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = null;
      for (const webContents of [...listListeners]) {
        if (webContents.isDestroyed()) listListeners.delete(webContents);
        else webContents.send('plugins:changed');
      }
    }, CHANGED_THROTTLE_MS);
    changedTimer.unref?.();
  });

  function listWithPlacements() {
    const list = manager.list();
    list.management = managed.status?.() || { available: true, error: null };
    const settings = getSettings() || {};
    const discovered = new Set(list.plugins.map(plugin => plugin.id));
    // Registry-only entries belong to management, never runtime discovery.
    for (const record of managed.list?.() || []) {
      if (discovered.has(record.id)) continue;
      list.plugins.push({ id: record.id, name: record.id, version: record.installation.version, source: 'user',
        status: record.missing ? 'missing' : 'invalid', managementOnly: true, enabled: false,
        views: [], permissions: [], hosts: [], skins: [], errors: [] });
    }
    for (const plugin of list.plugins) {
      plugin.installation = managed.describe(plugin.id);
      if (plugin.installation) plugin.settingsIdentity = `${plugin.installation.sha256}:${plugin.installation.installedAt}`;
      for (const view of plugin.views || []) view.placements = placementsFor(settings, view.ref);
    }
    return list;
  }

  function mainSender(event) {
    return !disposed && isMainSender(event) && (!event.senderFrame || event.senderFrame === event.sender.mainFrame);
  }

  function requireMain(event) {
    if (!mainSender(event)) throw new Error('plugins can only be managed from the main window');
    if (!listListeners.has(event.sender)) {
      listListeners.add(event.sender);
      const destroyed = () => listListeners.delete(event.sender);
      event.sender.once('destroyed', destroyed);
      observerCleanup.push(() => event.sender.removeListener('destroyed', destroyed));
    }
  }

  // Electron invoke drops custom Error properties. Keep field validation and
  // compare-and-swap conflicts structured across this host-only boundary.
  function settingsResult(operation) {
    try { return { ok: true, value: operation() }; }
    catch (error) {
      return { ok: false, error: { code: error.code || 'settings-unavailable',
        fields: error.fields && typeof error.fields === 'object' ? error.fields : {} } };
    }
  }

  function registerIpc() {
    handle('plugins:list', (event) => {
      requireMain(event);
      return listWithPlacements();
    });
    handle('plugins:getSettings', (event, id) => { requireMain(event); return settingsResult(() => manager.getAuthorSettings(id)); });
    handle('plugins:updateSettings', (event, id, input) => { requireMain(event); return settingsResult(() => manager.updateAuthorSettings(id, input)); });
    handle('plugins:setEnabled', (event, { id, enabled } = {}) => {
      requireMain(event);
      manager.setEnabled(String(id), enabled === true);
      return listWithPlacements();
    });
    handle('plugins:setBackground', (event, { id, enabled } = {}) => {
      requireMain(event);
      manager.setBackground(String(id), enabled === true);
      return listWithPlacements();
    });
    handle('plugins:restart', (event, { id } = {}) => {
      requireMain(event);
      manager.restart(String(id));
      return listWithPlacements();
    });
    handle('plugins:reload', (event) => {
      requireMain(event);
      manager.reload();
      return listWithPlacements();
    });
    handle('plugins:addSource', (event, input) => { requireMain(event); managed.assertAvailable(); return catalog.addSource(input); });
    handle('plugins:refreshSource', (event, id) => { requireMain(event); managed.assertAvailable(); return catalog.refreshSource(id); });
    handle('plugins:removeSource', (event, id) => { requireMain(event); managed.assertAvailable(); return catalog.removeSource(id); });
    handle('plugins:catalog', event => {
      requireMain(event);
      const result = catalog.list();
      const status = managed.status?.();
      if (status?.error) result.error = status.error.message;
      return result;
    });
    handle('plugins:catalogPreview', (event, source, id, version) => { requireMain(event); managed.assertAvailable(); return catalog.preview(source, id, version); });
    handle('plugins:import', async (event, kind) => {
      requireMain(event);
      managed.assertAvailable();
      const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        properties: kind === 'directory' ? ['openDirectory'] : ['openFile'],
        ...(kind === 'directory' ? {} : { filters: [{ name: 'Token Monitor plugin', extensions: ['tmplugin'] }] })
      });
      requireMain(event);
      if (selection.canceled || !selection.filePaths.length) return null;
      return kind === 'directory' ? managed.previewDirectory(selection.filePaths[0]) : managed.previewFile(selection.filePaths[0]);
    });
    handle('plugins:install', (event, token) => { requireMain(event); managed.install(token); return listWithPlacements(); });
    handle('plugins:cancelInstall', (event, token) => { requireMain(event); managed.cancel(token); });
    handle('plugins:rollback', (event, id) => { requireMain(event); managed.rollback(id); return listWithPlacements(); });
    handle('plugins:uninstall', (event, id, options) => { requireMain(event); managed.uninstall(id, options); return listWithPlacements(); });
    handle('plugins:openPage', (event, ref) => { requireMain(event); pages.open(ref); return { ok: true }; });
    handle('plugins:openFolder', async (event) => {
      requireMain(event);
      fs.mkdirSync(userDir, { recursive: true });
      const error = await shell.openPath(userDir);
      return { ok: !error, error };
    });
    handle('plugins:place', (event, { ref, surface, placed } = {}) => {
      requireMain(event);
      const view = manager.list().plugins.flatMap((plugin) => plugin.views || []).find((entry) => entry.ref === ref);
      if (!view?.surfaces.includes(surface)) throw new Error('unsupported plugin placement');
      const patch = placementPatch(getSettings() || {}, { ref: String(ref || ''), surface: String(surface || ''), placed: placed === true }, placementContext());
      applySettingsPatch(patch);
      return listWithPlacements();
    });
    handle('plugins:skins', (event) => {
      requireMain(event);
      return manager.skins();
    });
    handle('plugins:interact', (event, { surface, ref, input, revision } = {}) => {
      const allowed = ['home', 'page'].includes(surface) ? mainSender(event) : ['edgeDock', 'notch'].includes(surface) && isSurfaceSender(event, surface);
      if (!allowed || !demandVisible(event.sender, surface) || !subscribers.get(event.sender.id)?.demands.get(surface)?.includes(ref)) throw new Error('interaction is not from an active plugin view');
      if (surface === 'page' && !placementsFor(getSettings(), ref).page) throw new Error('plugin page placement was removed');
      return manager.interact(surface, ref, input, revision);
    });
    handle('plugins:views', (event, { surface } = {}) => {
      if (!MAIN_SURFACES.has(surface) || !mainSender(event)) return { surface, views: {} };
      return manager.payload(surface);
    });
    on('plugins:demand', (event, { surface, refs } = {}) => {
      if (!MAIN_SURFACES.has(surface) || !mainSender(event)) return;
      setDemand(event.sender, surface, refs);
    });
    for (const [channel, surface] of [['edgeDock:pluginDemand', 'edgeDock'], ['topNotch:pluginDemand', 'notch']]) {
      on(channel, (event, { refs } = {}) => {
        if (isSurfaceSender(event, surface)) setDemand(event.sender, surface, refs);
      });
    }
  }

  function refreshBusinessData() {
    if (disposed) return;
    const source = observeBusinessSource();
    if (!manager.hasActive()) { businessRefreshPending = businessStatsSnapshot !== null; return; }
    resetPublishedSource();
    businessData.publish(businessStatsSnapshot, { ...businessAdapters.extras?.(businessStatsSnapshot), sourceId: source });
    businessRefreshPending = false;
  }

  return {
    resolveSkin(ref) {
      if (disposed || typeof ref !== 'string' || ref.length > 73) throw new Error('plugin skin is unavailable');
      const skin = manager.skins().find(entry => entry.ref === ref);
      if (!skin) throw new Error('plugin skin is unavailable');
      return structuredClone(skin);
    },
    manager,
    bus,
    refreshBusinessData,
    refreshWindowVisibility(win) {
      if (disposed) return;
      const subscriber = subscribers.get(win?.webContents?.id);
      if (subscriber) for (const surface of ['home', 'page']) {
        if (subscriber.demands.has(surface)) setDemand(subscriber.webContents, surface, subscriber.demands.get(surface));
      }
      webUi?.refreshWindowVisibility(win);
      pages.refreshVisibility();
    },
    refreshWebSurfaces() {
      if (disposed) return;
      webUi?.refreshSurfaces();
      webUi?.refreshPresentations?.();
      for (const subscriber of subscribers.values()) for (const [surface, refs] of subscriber.demands) {
        if (['notch', 'edgeDock'].includes(surface)) demand.set(subscriber.webContents.id, surface, nativeDemandVisible(subscriber.webContents, surface) ? refs : []);
      }
    },
    safeMode,
    start() {
      if (disposed) throw new Error('plugin runtime disposed');
      if (started) return;
      started = true;
      registerIpc();
      manager.reload();
    },
    publishStats(stats, businessStats = stats, extras = {}) {
      if (disposed) return;
      observeBusinessSource();
      const push = { stats, businessStats, extras };
      if (!manager.hasActive()) { parkedStats = push; return; }
      parkedStats = null;
      publishHostData(push);
    },
    settingsChanged() {
      if (disposed) return;
      refreshBusinessData();
      manager.settingsChanged();
      webUi?.refreshSurfaces();
      webUi?.refreshPresentations?.();
      pages.refresh();
      for (const subscriber of subscribers.values()) {
        for (const surface of ['home', 'page', 'notch', 'edgeDock']) if (subscriber.demands.has(surface)) setDemand(subscriber.webContents, surface, subscriber.demands.get(surface));
      }
    },
    // Rendered tray items need view state synchronously with the bitmap.
    payload: (surface) => manager.payload(surface),
    // Hidden plugin host windows must not count as app windows.
    owns: (win) => Boolean(sandbox?.owns(win)),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const channel of ipcHandlers) ipcMain.removeHandler(channel);
      for (const [channel, listener] of ipcListeners) ipcMain.removeListener(channel, listener);
      observerCleanup.forEach(cleanup => cleanup());
      subscribers.clear(); listListeners.clear();
      if (changedTimer) clearTimeout(changedTimer);
      catalog.dispose();
      managed.dispose();
      pages.dispose();
      webUi?.dispose();
      manager.dispose();
      capabilities.dispose();
      businessData.dispose();
      bus.dispose();
    }
  };
}

// Electron accepts privilege declarations only once, before app ready.
function registerPluginScheme(protocol, commandLine = require('electron').app.commandLine) {
  configureWebUiNetworkIsolation(commandLine);
  protocol.registerSchemesAsPrivileged([PLUGIN_SCHEME, WEB_UI_SCHEME]);
}

module.exports = { createPluginRuntime, registerPluginScheme, safeModeRequested, normalizePluginAuthorSkin };
