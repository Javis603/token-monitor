'use strict';

// Trusted plugin management, same-page host routing and optional local backends.
// Formal data operations reuse captured App state without refreshing collectors.

const fs = require('node:fs');
const { showPluginNotification } = require('./notification');
const path = require('node:path');
const { createBusinessDataService } = require('./businessData');
const { createPluginSettingsStore } = require('./settings');
const { createPluginPages } = require('./pages');
const { createManagedPlugins } = require('./managed');
const { normalizeAppearance } = require('../../shared/plugins/appearance');
const { createPluginCatalog } = require('./catalog');
const { createPluginManager } = require('./manager');
const { translate } = require('../renderer/i18n');
const { initializePlacementPatch, placementPatch, placementsFor, summaryBitmapRefs } = require('./placementSettings');
const { trayLayoutPluginRefs } = require('../../shared/trayLayout');
const { createElectronNetFetch } = require('../limits/fetch');
const { createOutboundFetch, resolveProxyConfig } = require('../../shared/outboundFetch');

const NET_PARTITION = 'tm-plugin-net';
const CHANGED_THROTTLE_MS = 1000;
const MAIN_SURFACES = new Set(['home', 'tray', 'page', 'settings']);
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
  getAppSettings = () => ({}),
  businessAdapters = {},
  isMainSender,
  isSurfaceSender = () => false,
  surfaceContext = () => null,
  placementContext = () => ({}),
  log = (message) => console.log(message),
  hostActions = {},
  env = process.env
}) {
  const { BrowserWindow, Notification, ipcMain, session, shell, dialog } = electron;
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
    businessResetSource = null;
  }
  function publishHostData({ businessStats, extras }) {
    try {
      resetPublishedSource();
      businessStatsSnapshot = businessStats;
      businessData.publish(businessStats, { ...businessAdapters.extras?.(businessStats), ...extras, sourceId: businessSource });
      businessRefreshPending = false;
    } catch (error) {
      // Plugin data must never stop the host's own dock, tray and window updates.
      log(`[plugins] stats publish failed: ${error.message}`);
    }
  }
  const authorSettings = createPluginSettingsStore({ directory: path.join(userDataDir, 'plugin-settings') });
  const userDir = path.join(userDataDir, 'plugins');

  // Catalog downloads use the App transport. Plugin backends use their own Node networking.
  const proxy = resolveProxyConfig(env);
  const netFetch = proxy.httpProxy || proxy.httpsProxy
    ? createOutboundFetch(env)
    : createElectronNetFetch({ fetch: (input, init) => session.fromPartition(NET_PARTITION, { cache: false }).fetch(input, init) });

  const auth = id => () => ({ pluginId: id, active: manager.active(id) });
  async function hostCall(id, method, args) {
    if (!manager.active(id)) throw new Error('Plugin is disabled');
    if (method === 'data.query') return businessData.query({ version: 1, ...args }, auth(id), { owner: id });
    if (method === 'settings.get') return manager.getAuthorSettings(id);
    if (method === 'settings.update') return manager.updateAuthorSettings(id, args);
    if (method === 'app.context') return getContext();
    if (method === 'app.settings') return getAppSettings();
    if (method === 'app.updateSettings') {
      if (Object.hasOwn(args || {}, 'pluginsEnabled')) throw new Error('Use plugin management to change plugin execution');
      return applySettingsPatch(args);
    }
    if (method === 'notify') return showPluginNotification(Notification, { title: String(args?.title || id), body: String(args?.body || '') });
    if (typeof hostActions[method] === 'function') return hostActions[method](args);
    throw new Error(`Unknown host operation: ${method}`);
  }
  const manager = createPluginManager({ userDir, dataDir: path.join(userDataDir, 'plugin-data'), authorSettings,
    getSettings, saveStates: persistPluginStates, getLocale, safeMode, hostCall,
    fork: (...args) => electron.utilityProcess.fork(...args), log });
  const mime = name => ({ js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', woff2: 'font/woff2' }[name.split('.').pop()] || 'application/octet-stream');
  const protocol = session.defaultSession.protocol;
  protocol.handle('tm-plugin', request => {
    try {
      const url = new URL(request.url), parts = decodeURIComponent(url.pathname).slice(1).split('/');
      const revision = parts.shift(), name = parts.join('/');
      const bytes = manager.asset(url.hostname, revision, name);
      return bytes ? new Response(bytes, { headers: { 'content-type': mime(name), 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }) : new Response('', { status: 404 });
    } catch { return new Response('', { status: 400 }); }
  });
  const contentSelections = () => getSettings().pluginContentSelections || {};
  let pages = null;
  const managed = createManagedPlugins({ root: path.join(userDataDir, 'plugin-manager'), userDir,
    dataDir: path.join(userDataDir, 'plugin-data'), settingsDir: path.join(userDataDir, 'plugin-settings'), manager, getSettings, saveSettings: persistManagementSettings, getLocale, placementContext });
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
    if (['home', 'page', 'settings', 'tray'].includes(surface)) {
      const win = BrowserWindow.fromWebContents(webContents);
      return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
    }
    return !['notch', 'edgeDock'].includes(surface) || nativeDemandVisible(webContents, surface);
  }
  function effectiveDemand(webContents, surface, refs) {
    if (!refs.length) return refs;
    if (surface === 'tray') {
      const settings = getSettings();
      const trayRefs = settings.showTrayIcon !== false && settings.trayContent === 'custom' ? trayLayoutPluginRefs(settings.trayCustomLayout) : [];
      const win = BrowserWindow.fromWebContents(webContents);
      const bubbleRefs = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && settings.floatingBubbleContent === 'custom'
        ? trayLayoutPluginRefs(settings.floatingBubbleCustomLayout) : [];
      return refs.filter(ref => trayRefs.includes(ref) || bubbleRefs.includes(ref));
    }
    if (demandVisible(webContents, surface)) return refs;
    // A collapsed Notch still paints its summary, but its panel is hidden.
    if (surface !== 'notch' || surfaceContext({ sender: webContents }, surface)?.summaryVisible !== true) return [];
    const summaryRefs = new Set(manager.list().plugins.filter(plugin => plugin.status === 'active')
      .flatMap(plugin => plugin.views.filter(view => view.targets?.includes('notch.summary.content')).map(view => view.ref)));
    const bitmapRefs = summaryBitmapRefs(getSettings());
    return refs.filter(ref => summaryRefs.has(ref) || bitmapRefs.includes(ref));
  }
  function registerSubscriber(webContents) {
    let subscriber = subscribers.get(webContents.id);
    if (!subscriber) {
      subscriber = { webContents, demands: new Map() };
      subscribers.set(webContents.id, subscriber);
      const destroyed = () => {
        businessData.releaseOwner(String(webContents.id));
        subscribers.delete(webContents.id);
        demand.remove(webContents.id);
      };
      const navigating = (_event, _url, inPlace, isMainFrame) => { if (isMainFrame !== false && !inPlace) { businessData.releaseOwner(String(webContents.id)); subscriber.demands.clear(); demand.remove(webContents.id); } };
      webContents.on('did-start-navigation', navigating);
      observerCleanup.push(() => webContents.removeListener('did-start-navigation', navigating));
      webContents.once('destroyed', destroyed);
      observerCleanup.push(() => webContents.removeListener('destroyed', destroyed));
    }
    return subscriber;
  }
  function setDemand(webContents, surface, refs) {
    const subscriber = registerSubscriber(webContents);
    const bitmapRefs = surface === 'notch' ? summaryBitmapRefs(getSettings()) : [];
    const allowed = new Set(manager.list().plugins.filter(plugin => plugin.status === 'active')
      .flatMap(plugin => (plugin.views || []).filter(view => (view.surfaces.includes(surface) || view.targets?.length || (view.surfaces.includes('tray') && bitmapRefs.includes(view.ref)))
        && (view.targets?.length || bitmapRefs.includes(view.ref) || !['home', 'page', 'notch', 'edgeDock'].includes(surface) || placementsFor(getSettings(), view.ref)[surface])).map(view => view.ref)));
    const selected = Array.isArray(refs) ? refs.filter(ref => typeof ref === 'string' && allowed.has(ref)).slice(0, 32) : [];
    subscriber.demands.set(surface, selected);
    // Retain the request across native hide/show, but never grant foreground work while hidden.
    demand.set(webContents.id, surface, effectiveDemand(webContents, surface, selected));
    // Opening a view is not a streaming update: resolve existing readings now.
    // This neither samples nor bypasses active placement / native visibility.
    if (!webContents.isDestroyed()) webContents.send('plugins:views', manager.payload(surface));
  }
  manager.onData((id, value) => {
    for (const subscriber of subscribers.values()) if (!subscriber.webContents.isDestroyed()) subscriber.webContents.send('plugins:backend', { id, value });
    pages.broadcast('plugins:backend', { id, value });
  });
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
    list.contentSelections = { ...contentSelections() };
    list.contentOrder = { ...(getSettings().pluginContentOrder || {}) };
    list.management = managed.status?.() || { available: true, error: null };
    const settings = getSettings() || {};
    const discovered = new Set(list.plugins.map(plugin => plugin.id));
    // Registry-only entries belong to management, never runtime discovery.
    for (const record of managed.list?.() || []) {
      if (discovered.has(record.id)) continue;
      list.plugins.push({ id: record.id, name: record.id, version: record.installation.version, source: 'user',
        status: record.missing ? 'missing' : 'invalid', managementOnly: true, enabled: false,
        views: [], skins: [], errors: [] });
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

  const lifecycleHosts = new Set(), lifecyclePlugins = new Map(), observedLifecycleHosts = new WeakSet(), lifecycleRequests = new Map(), failedCleanup = new Map();
  let lifecycleSequence = 0;
  function requestLifecycle(host, action, ids) {
    if (host.isDestroyed()) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      const request = ++lifecycleSequence;
      const finish = (error, value) => {
        clearTimeout(timer); lifecycleRequests.delete(request);
        error ? reject(new Error(error)) : resolve(value || {});
      };
      const timer = setTimeout(() => finish('Plugin UI did not respond'), 5000);
      lifecycleRequests.set(request, { host, finish });
      host.send('plugins:lifecycle', { request, action, ids });
    });
  }
  async function inspectHosts(ids) {
    const results = await Promise.all([...lifecycleHosts].filter(host => ids.some(id => lifecyclePlugins.get(host)?.get(id) === 'loaded')).map(async host => {
      const loadedIds = ids.filter(id => lifecyclePlugins.get(host)?.get(id) === 'loaded');
      try { return { host, ids: loadedIds, ...await requestLifecycle(host, 'inspect', loadedIds) }; }
      catch (error) { return { host, ids: loadedIds, loaded: true, error: error.message }; }
    }));
    return results.filter(item => !item.host.isDestroyed() && item.loaded);
  }
  async function confirm(event, note, detail = null) {
    requireMain(event);
    const response = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'warning', title: translate(getLocale(), note === 'plugins.trusted.unsavedNote' ? 'plugins.trusted.disableTitle' : note === 'plugins.trusted.packageUnsavedNote' ? 'plugins.trusted.packageTitle' : 'plugins.trusted.reloadTitle'),
      message: translate(getLocale(), note),
      ...(detail ? { detail: translate(getLocale(), detail) } : {}),
      buttons: [translate(getLocale(), 'settings.plugins.cancel'), translate(getLocale(), 'plugins.trusted.continue')],
      defaultId: 0, cancelId: 0
    });
    if (response.response !== 1) throw new Error('Plugin change cancelled');
  }
  function reloadHosts(hosts) {
    setTimeout(() => { if (!disposed) for (const host of hosts) if (!host.isDestroyed()) host.reload(); }, 0);
  }
  async function prepareDisable(event, ids) {
    requireMain(event);
    const affected = await inspectHosts(ids);
    if (affected.some(item => item.error)) await confirm(event, 'plugins.trusted.reloadNote');
    else if (affected.some(item => item.unsaved)) await confirm(event, 'plugins.trusted.unsavedNote');
    return async () => {
      const reload = affected.filter(item => item.error).map(item => item.host);
      const results = await Promise.all(affected.filter(item => !item.error).map(async ({ host, ids: loadedIds }) => {
        try {
          await requestLifecycle(host, 'release', loadedIds);
          for (const id of loadedIds) if (lifecyclePlugins.get(host)?.has(id)) lifecyclePlugins.get(host).set(id, 'released');
          return null;
        }
        catch (error) {
          log(`[plugins] UI cleanup failed: ${error.message}`);
          failedCleanup.set(host, new Set([...(failedCleanup.get(host) || []), ...loadedIds]));
          return host;
        }
      }));
      const failed = results.filter(host => host && !host.isDestroyed());
      if (failed.length) {
        // The disable already persisted. Declining recovery must not silently
        // re-enable partially disposed code; another enable will offer it again.
        const response = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
          type: 'warning', title: translate(getLocale(), 'plugins.trusted.reloadTitle'),
          message: translate(getLocale(), 'plugins.trusted.cleanupNote'),
          buttons: [translate(getLocale(), 'plugins.trusted.later'), translate(getLocale(), 'plugins.trusted.reloadNow')], defaultId: 1, cancelId: 0
        });
        if (response.response === 1) reload.push(...failed);
      }
      reloadHosts(reload);
    };
  }
  async function resumeHosts(event, ids) {
    const failed = [...failedCleanup].filter(([host, values]) => !host.isDestroyed() && ids.some(id => values.has(id))).map(([host]) => host);
    await Promise.all([...lifecycleHosts].filter(host => !failed.includes(host) && ids.some(id => lifecyclePlugins.get(host)?.get(id) === 'released')).map(async host => {
      const releasedIds = ids.filter(id => lifecyclePlugins.get(host)?.get(id) === 'released');
      try {
        await requestLifecycle(host, 'resume', releasedIds);
        for (const id of releasedIds) if (lifecyclePlugins.get(host)?.get(id) === 'released') lifecyclePlugins.get(host).delete(id);
      } catch (error) {
        log(`[plugins] UI resume failed: ${error.message}`);
        failedCleanup.set(host, new Set([...(failedCleanup.get(host) || []), ...releasedIds]));
        failed.push(host);
      }
    }));
    if (failed.length) await confirm(event, 'plugins.trusted.reloadNote');
    return () => reloadHosts(failed);
  }
  async function changeCode(event, change, ids = manager.list().plugins.map(plugin => plugin.id)) {
    requireMain(event);
    const affected = await inspectHosts(ids);
    if (affected.length) await confirm(event, 'plugins.trusted.reloadNote');
    await change();
    const result = listWithPlacements();
    reloadHosts(affected.map(item => item.host));
    return result;
  }

  async function changePackage(event, change, ids) {
    requireMain(event);
    const affected = await inspectHosts(ids);
    for (const [host, failedIds] of failedCleanup) {
      if (host.isDestroyed() || !ids.some(id => failedIds.has(id))) continue;
      const item = affected.find(item => item.host === host);
      if (item) item.error = 'Previous cleanup failed';
      else affected.push({ host, ids: ids.filter(id => failedIds.has(id)), error: 'Previous cleanup failed' });
    }
    const reload = affected.filter(item => item.error).map(item => item.host);
    const unsaved = affected.some(item => item.unsaved);
    if (reload.length) await confirm(event, 'plugins.trusted.reloadNote', unsaved ? 'plugins.trusted.packageUnsavedNote' : null);
    else if (unsaved) await confirm(event, 'plugins.trusted.packageUnsavedNote');
    const released = [], recovery = [];
    try {
      for (const item of affected.filter(item => !item.error)) {
        // Include partially released hosts in recovery if author cleanup fails.
        try {
          await requestLifecycle(item.host, 'release', item.ids);
          released.push(item);
        } catch (error) {
          failedCleanup.set(item.host, new Set([...(failedCleanup.get(item.host) || []), ...item.ids]));
          recovery.push(item.host);
          log(`[plugins] package cleanup failed: ${error.message}`);
          await confirm(event, 'plugins.trusted.reloadNote');
          reload.push(item.host);
        }
      }
      await change();
    } finally {
      // Resume after both commit and rollback. Descriptor publication during
      // the transaction was ignored by blocked hosts, so publish once more.
      for (const item of released) {
        try { await requestLifecycle(item.host, 'resume', item.ids); }
        catch (error) {
          failedCleanup.set(item.host, new Set(item.ids));
          log(`[plugins] package resume failed: ${error.message}`);
          recovery.push(item.host);
        }
      }
      const needsRecovery = [...new Set(recovery)].filter(host => !host.isDestroyed() && !reload.includes(host));
      if (needsRecovery.length) {
        const response = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
          type: 'warning', title: translate(getLocale(), 'plugins.trusted.reloadTitle'),
          message: translate(getLocale(), 'plugins.trusted.packageRecoveryNote'),
          buttons: [translate(getLocale(), 'plugins.trusted.later'), translate(getLocale(), 'plugins.trusted.reloadNow')], defaultId: 1, cancelId: 0
        });
        if (response.response === 1) reload.push(...needsRecovery);
      }
      reloadHosts(reload);
      manager.settingsChanged();
    }
    return listWithPlacements();
  }

  function registerIpc() {
    handle('plugins:orderContent', (event, target, refs) => {
      requireMain(event);
      const allowed = new Set(manager.list().plugins.flatMap(plugin => (plugin.views || []).filter(view => view.targets?.includes(target) && view.mode !== 'replace').map(view => view.ref)));
      if (typeof target !== 'string' || !/^[a-zA-Z][a-zA-Z0-9.-]{0,119}$/.test(target) || !Array.isArray(refs) || refs.length > 256 || new Set(refs).size !== refs.length || refs.some(ref => !allowed.has(ref))) throw new Error('Invalid content order');
      const next = { ...(getSettings().pluginContentOrder || {}), [target]: refs };
      if (Object.keys(next).length > 128) throw new Error('Too many content orders');
      persistManagementSettings({ pluginContentOrder: next });
      manager.settingsChanged(); return listWithPlacements();
    });
    handle('plugins:selectContent', (event, target, ref) => {
      requireMain(event);
      if (typeof target !== 'string' || !/^[a-zA-Z][a-zA-Z0-9.-]{0,119}$/.test(target)) throw new Error('Invalid content target');
      if (ref !== null && !manager.list().plugins.some(plugin => plugin.status === 'active' && plugin.views?.some(view => view.ref === ref && view.mode === 'replace' && view.targets.includes(target)))) throw new Error('Content replacement is unavailable');
      const next = { ...contentSelections() };
      if (ref === null) delete next[target]; else next[target] = ref;
      if (Object.keys(next).length > 128) throw new Error('Too many content selections');
      persistManagementSettings({ pluginContentSelections: next });
      manager.settingsChanged(); return listWithPlacements();
    });
    handle('plugins:contentSelections', event => { requireHost(event); registerSubscriber(event.sender); return { ...contentSelections() }; });
    handle('plugins:list', (event) => {
      requireMain(event);
      return listWithPlacements();
    });
    handle('plugins:getSettings', (event, id) => { requireMain(event); return settingsResult(() => manager.getAuthorSettings(id)); });
    handle('plugins:updateSettings', (event, id, input) => { requireMain(event); return settingsResult(() => manager.updateAuthorSettings(id, input)); });
    handle('plugins:setEnabled', async (event, { id, enabled } = {}) => {
      requireMain(event); id = String(id);
      const finish = enabled ? await resumeHosts(event, [id]) : await prepareDisable(event, [id]);
      if (enabled === true) {
        const patch = initializePlacementPatch(getSettings(), id, placementContext(), manager.list().plugins.find(plugin => plugin.id === id)?.views || []);
        if (Object.keys(patch).length) persistManagementSettings(patch);
      }
      manager.setEnabled(id, enabled === true);
      await finish();
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
      return changeCode(event, () => manager.reload());
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
    handle('plugins:install', (event, token, options) => changePackage(event, () => managed.install(token, { trustUpdate: options?.trustUpdate === true, trustInstall: options?.trustInstall === true, placements: options?.placements }), [managed.previewId(token)]));
    handle('plugins:cancelInstall', (event, token) => { requireMain(event); managed.cancel(token); });
    handle('plugins:rollback', (event, id) => changeCode(event, () => managed.rollback(id), [id]));
    handle('plugins:uninstall', (event, id, options) => changePackage(event, () => managed.uninstall(id, options), [id]));
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
      const id = view.pluginId;
      applySettingsPatch(patch);
      const preferences = getSettings().pluginPlacementDefaults;
      const preference = preferences && Object.hasOwn(preferences, id) ? preferences[id] : null;
      if (preference && !preference.applied) persistManagementSettings({ pluginPlacementDefaults: { ...getSettings().pluginPlacementDefaults, [id]: { ...preference, applied: true } } });
      return listWithPlacements();
    });
    handle('plugins:skins', (event) => {
      requireMain(event);
      return manager.skins();
    });
    const requireHost = event => {
      if (!mainSender(event) && !['notch', 'edgeDock'].some(surface => isSurfaceSender(event, surface)) && !pages.ownsSender(event.sender)) throw new Error('Unknown plugin UI host');
    };
    on('plugins:lifecycleHost', (event, registered) => {
      try { requireHost(event); } catch { return; }
      const host = event.sender;
      if (!registered) { lifecycleHosts.delete(host); lifecyclePlugins.delete(host); return; }
      if (lifecycleHosts.has(host)) return;
      lifecycleHosts.add(host);
      if (observedLifecycleHosts.has(host)) return;
      observedLifecycleHosts.add(host);
      const clear = () => {
        lifecycleHosts.delete(host); lifecyclePlugins.delete(host); failedCleanup.delete(host);
        for (const pending of lifecycleRequests.values()) if (pending.host === host) pending.finish(null, {});
      };
      const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame !== false && !inPlace) clear(); };
      host.once('destroyed', clear); host.on('did-start-navigation', navigate);
      observerCleanup.push(() => { host.removeListener('destroyed', clear); host.removeListener('did-start-navigation', navigate); });
    });
    on('plugins:uiLoading', (event, id) => {
      try { requireHost(event); } catch { return; }
      if (!lifecycleHosts.has(event.sender) || !manager.active(id)) return;
      if (!lifecyclePlugins.has(event.sender)) lifecyclePlugins.set(event.sender, new Map());
      lifecyclePlugins.get(event.sender).set(id, 'loaded');
    });
    on('plugins:lifecycleReply', (event, reply) => {
      const pending = lifecycleRequests.get(reply?.request);
      if (pending?.host === event.sender && (!event.senderFrame || event.senderFrame === event.sender.mainFrame)) pending.finish(reply.error, reply.value);
    });
    handle('plugins:call', (event, id, method, args) => { requireHost(event); return manager.call(id, method, args); });
    handle('plugins:host', (event, id, method, args) => { requireHost(event); return hostCall(id, method, args); });
    handle('plugins:subscribe', (event, id, query) => {
      requireHost(event);
      registerSubscriber(event.sender);
      const subscription = businessData.subscribe(String(event.sender.id), { version: 1, ...query }, auth(id), value => {
        if (!event.sender.isDestroyed()) event.sender.send('plugins:data', { id, subscription, value });
      });
      return subscription;
    });
    handle('plugins:unsubscribe', (event, subscription) => { requireHost(event); return businessData.unsubscribe(String(event.sender.id), subscription); });
    handle('plugins:views', (event, { surface } = {}) => {
      requireHost(event);
      if (!['home', 'page', 'settings', 'tray', 'notch', 'edgeDock'].includes(surface)) throw new Error('Unknown plugin surface');
      const subscriber = registerSubscriber(event.sender);
      // Native content outlets need catalog changes before their first mount.
      // An empty request subscribes to descriptors without starting a backend.
      if (!subscriber.demands.has(surface)) subscriber.demands.set(surface, []);
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
    trayMenu: () => manager.trayMenu(),
    trayAction(id, action) {
      if (!manager.trayMenu().some(item => item.pluginId === id && item.id === action)) return Promise.reject(new Error('Plugin Tray action is unavailable'));
      return manager.call(id, 'tray', { id: action });
    },
    async beforeSettingsChange(event, patch) {
      if (patch.pluginsEnabled === undefined || patch.pluginsEnabled === getSettings().pluginsEnabled) return () => {};
      const ids = manager.list().plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id);
      return patch.pluginsEnabled === false ? prepareDisable(event, ids) : resumeHosts(event, ids);
    },
    refreshBusinessData,
    refreshWindowVisibility(win) {
      if (disposed) return;
      const subscriber = subscribers.get(win?.webContents?.id);
      if (subscriber) for (const surface of ['home', 'page', 'settings', 'tray']) {
        if (subscriber.demands.has(surface)) setDemand(subscriber.webContents, surface, subscriber.demands.get(surface));
      }
      pages.refreshVisibility();
    },
    refreshSurfaces() {
      if (disposed) return;
        for (const subscriber of subscribers.values()) for (const [surface, refs] of subscriber.demands) {
        if (['notch', 'edgeDock'].includes(surface)) demand.set(subscriber.webContents.id, surface, effectiveDemand(subscriber.webContents, surface, refs));
      }
    },
    safeMode,
    start() {
      if (disposed) throw new Error('plugin runtime disposed');
      if (started) return;
      started = true;
      registerIpc();
      return manager.reload();
    },
    publishStats(stats, businessStats = stats, extras = {}) {
      if (disposed) return;
      observeBusinessSource();
      manager.contextChanged({ ...getContext(), source: businessSource });
      const push = { stats, businessStats, extras };
      if (!manager.hasActive()) { parkedStats = push; return; }
      parkedStats = null;
      publishHostData(push);
    },
    settingsChanged() {
      if (disposed) return;
      refreshBusinessData();
      manager.settingsChanged();
        pages.refresh();
      for (const subscriber of subscribers.values()) {
        for (const surface of ['home', 'page', 'settings', 'tray', 'notch', 'edgeDock']) if (subscriber.demands.has(surface)) setDemand(subscriber.webContents, surface, subscriber.demands.get(surface));
      }
    },
    // Rendered tray items need view state synchronously with the bitmap.
    payload: (surface) => manager.payload(surface),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const channel of ipcHandlers) ipcMain.removeHandler(channel);
      for (const [channel, listener] of ipcListeners) ipcMain.removeListener(channel, listener);
      observerCleanup.forEach(cleanup => cleanup());
      for (const pending of lifecycleRequests.values()) pending.finish('Plugin runtime disposed');
      lifecycleHosts.clear(); lifecyclePlugins.clear(); failedCleanup.clear();
      subscribers.clear(); listListeners.clear();
      if (changedTimer) clearTimeout(changedTimer);
      catalog.dispose();
      managed.dispose();
      pages.dispose();
      protocol.unhandle('tm-plugin');
      businessData.dispose();
      return manager.dispose();
    }
  };
}

// Electron accepts privilege declarations only once, before app ready.
function registerPluginScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: 'tm-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}
module.exports = { createPluginRuntime, registerPluginScheme, safeModeRequested, normalizePluginAuthorSkin };
