'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function pluginSettingsResult(promise) {
  const result = await promise;
  if (result?.ok === true) return result.value;
  // contextBridge strips custom properties from Error instances. A plain
  // rejection record preserves validation fields in the isolated main world.
  return Promise.reject({ message: result?.error?.code || 'settings-unavailable',
    code: result?.error?.code || 'settings-unavailable', fields: result?.error?.fields || {} });
}

contextBridge.exposeInMainWorld('tokenMonitor', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => {
    // Membership is owned by the dedicated account commands, never generic settings.
    const { workbuddyManagedAccounts: _managedAccounts, ...safePatch } = patch || {};
    return ipcRenderer.invoke('settings:update', safePatch);
  },
  // Subscriptions are shared across devices when a hub is configured, so they
  // have their own channel: the write is a network round trip main.js has to
  // await, and it can fail in ways a settings write cannot.
  saveSubscriptions: (subscriptions, base) => ipcRenderer.invoke('subscriptions:save', subscriptions, base),
  // Records this device held before it joined a hub that already had a list.
  adoptOrphanedSubscriptions: () => ipcRenderer.invoke('subscriptions:adoptOrphans'),
  discardOrphanedSubscriptions: () => ipcRenderer.invoke('subscriptions:discardOrphans'),
  clearSessionUsageArchive: () => ipcRenderer.invoke('sessionUsageArchive:clear'),
  lookupModelPricing: (modelId) => ipcRenderer.invoke('pricing:lookup', modelId),
  getDisplayPreview: (surface, phase, slots) => ipcRenderer.invoke('settings:displayPreview', surface, phase, slots),
  previewAppearance: (patch) => ipcRenderer.invoke('appearance:preview', patch),
  getBackgroundImage: () => ipcRenderer.invoke('appearance:getBackgroundImage'),
  chooseBackgroundImage: () => ipcRenderer.invoke('appearance:chooseBackgroundImage'),
  clearBackgroundImage: () => ipcRenderer.invoke('appearance:clearBackgroundImage'),
  getNativeMaterialState: () => ipcRenderer.invoke('appearance:getNativeMaterial'),
  onNativeMaterialState: (callback) => {
    const listener = (_event, state) => { try { callback(state); } catch (_) {} };
    ipcRenderer.on('appearance:nativeMaterial', listener);
    return () => ipcRenderer.removeListener('appearance:nativeMaterial', listener);
  },
  getStats: (options) => ipcRenderer.invoke('stats:get', options),
  deleteDevice: (deviceId) => ipcRenderer.invoke('devices:delete', deviceId),
  getAllTimeSessions: (snapshotId) => ipcRenderer.invoke('stats:allTimeSessions', snapshotId),
  getSessionDetail: (args) => ipcRenderer.invoke('session:getDetail', args),
  getStreamStatus: () => ipcRenderer.invoke('stream:status'),
  getServiceStatus: (options) => ipcRenderer.invoke('serviceStatus:get', options),
  getCodexResetForecast: (options) => ipcRenderer.invoke('codexResetForecast:get', options),
  openDashboard: () => ipcRenderer.invoke('dashboard:open'),
  getDashboardHistory: (options) => ipcRenderer.invoke('dashboard:getHistory', options),
  onDashboardHistoryChanged: (callback) => {
    const listener = () => { try { callback(); } catch (_) {} };
    ipcRenderer.on('dashboard:historyChanged', listener);
    return () => ipcRenderer.removeListener('dashboard:historyChanged', listener);
  },
  dashboard: {
    ready: () => ipcRenderer.send('dashboard:ready'),
    minimize: () => ipcRenderer.send('dashboard:minimize'),
    close: () => ipcRenderer.send('dashboard:close')
  },
  getSyncContentStatus: (refresh = true) => ipcRenderer.invoke('syncContent:status', refresh),
  previewSyncContent: (kind) => ipcRenderer.invoke('syncContent:preview', kind),
  configureSyncContent: (options) => ipcRenderer.invoke('syncContent:configure', options),
  retrySyncContentCleanup: () => ipcRenderer.invoke('syncContent:retryCleanup'),
  onSyncContentPush: (callback) => {
    const listener = (_event, status) => { try { callback(status); } catch (_) {} };
    ipcRenderer.on('syncContent:push', listener);
    return () => ipcRenderer.removeListener('syncContent:push', listener);
  },
  getHubInfo: () => ipcRenderer.invoke('hub:getInfo'),
  getHubBuildStatus: () => ipcRenderer.invoke('hub:getBuildStatus'),
  regenerateHubSecret: () => ipcRenderer.invoke('hub:regenerateSecret'),
  onHubPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('hub:push', listener);
    return () => ipcRenderer.removeListener('hub:push', listener);
  },
  onStatsPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('stats:push', listener);
    return () => ipcRenderer.removeListener('stats:push', listener);
  },
  onWindowVisibilityPush: (callback) => {
    const listener = (_event, visible) => { try { callback(Boolean(visible)); } catch (_) {} };
    ipcRenderer.on('window:visibility', listener);
    return () => ipcRenderer.removeListener('window:visibility', listener);
  },
  onSettingsPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('settings:push', listener);
    return () => ipcRenderer.removeListener('settings:push', listener);
  },
  onNotchCapabilitiesPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('topNotch:capabilities', listener);
    return () => ipcRenderer.removeListener('topNotch:capabilities', listener);
  },
  onSystemUiThemePush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('theme:systemUi', listener);
    return () => ipcRenderer.removeListener('theme:systemUi', listener);
  },
  onOpenSettings: (callback) => {
    const listener = (_event, section) => { try { callback(section); } catch (_) {} };
    ipcRenderer.on('settings:open', listener);
    return () => ipcRenderer.removeListener('settings:open', listener);
  },
  onOpenView: (callback) => {
    const listener = (_event, viewId) => { try { callback(viewId); } catch (_) {} };
    ipcRenderer.on('view:open', listener);
    return () => ipcRenderer.removeListener('view:open', listener);
  },
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  generateDiagnosticReport: () => ipcRenderer.invoke('diagnostics:generate'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  clientSources: (clientId) => ipcRenderer.invoke('usage:clientSources', clientId),
  pickCustomScanPath: (clientId) => ipcRenderer.invoke('usage:pickCustomScanPath', clientId),
  revealClientSource: (clientId) => ipcRenderer.invoke('usage:revealClientSource', clientId),
  revealClientSyncLock: (clientId) => ipcRenderer.invoke('usage:revealClientSyncLock', clientId),
  rescanClient: (clientId) => ipcRenderer.invoke('usage:rescanClient', clientId),
  repairClientSyncLock: (clientId) => ipcRenderer.invoke('usage:repairClientSyncLock', clientId),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openUserData: () => ipcRenderer.invoke('app:openUserData'),
  antigravity: {
    accounts: () => ipcRenderer.invoke('antigravity:accounts'),
    addAccount: () => ipcRenderer.invoke('antigravity:addAccount'),
    cancelLogin: () => ipcRenderer.invoke('antigravity:cancelLogin'),
    removeAccount: (id) => ipcRenderer.invoke('antigravity:removeAccount', id),
    setAccountEnabled: (id, enabled) => ipcRenderer.invoke('antigravity:setAccountEnabled', id, enabled),
    onAccounts: (callback) => {
      const handler = (_event, accounts) => callback(accounts);
      ipcRenderer.on('antigravity:accounts', handler);
      return () => ipcRenderer.removeListener('antigravity:accounts', handler);
    }
  },
  workbuddy: {
    accounts: () => ipcRenderer.invoke('workbuddy:accounts'),
    addAccount: (realm) => ipcRenderer.invoke('workbuddy:addAccount', realm),
    cancelLogin: () => ipcRenderer.invoke('workbuddy:cancelLogin'),
    removeAccount: (id) => ipcRenderer.invoke('workbuddy:removeAccount', id),
    setAccountEnabled: (id, enabled) => ipcRenderer.invoke('workbuddy:setAccountEnabled', id, enabled),
    onAccounts: (callback) => {
      const handler = (_event, accounts) => { try { callback(accounts); } catch (_) {} };
      ipcRenderer.on('workbuddy:accounts', handler);
      return () => ipcRenderer.removeListener('workbuddy:accounts', handler);
    }
  },
  mimo: {
    accounts: () => ipcRenderer.invoke('mimo:accounts'),
    addAccount: (cookieHeader) => ipcRenderer.invoke('mimo:addAccount', cookieHeader),
    openConsole: () => ipcRenderer.invoke('mimo:openConsole'),
    removeAccount: (id) => ipcRenderer.invoke('mimo:removeAccount', id),
    setAccountEnabled: (id, enabled) => ipcRenderer.invoke('mimo:setAccountEnabled', id, enabled),
    onAccounts: (callback) => {
      const handler = (_event, accounts) => callback(accounts);
      ipcRenderer.on('mimo:accounts', handler);
      return () => ipcRenderer.removeListener('mimo:accounts', handler);
    }
  },
  exportNow: () => ipcRenderer.invoke('export:now'),
  pickExportDir: () => ipcRenderer.invoke('export:pickAutoDir'),
  getTokscaleStatus: () => ipcRenderer.invoke('tokscale:getStatus'),
  getAppUpdateState: () => ipcRenderer.invoke('appUpdate:getState'),
  checkAppUpdateNow: () => ipcRenderer.invoke('appUpdate:checkNow'),
  downloadAppUpdate: () => ipcRenderer.invoke('appUpdate:download'),
  installAppUpdate: () => ipcRenderer.invoke('appUpdate:install'),
  dismissAppUpdate: (version) => ipcRenderer.invoke('appUpdate:dismiss', version),
  expandFloatingBubble: () => ipcRenderer.invoke('floatingBubble:expand'),
  moveFloatingBubble: (delta) => ipcRenderer.invoke('floatingBubble:move', delta),
  signalContentReady: () => ipcRenderer.send('window:contentReady'),
  setViewState: (patch) => ipcRenderer.send('window:viewState', patch),
  peekFloatingBubble: () => ipcRenderer.invoke('floatingBubble:peek'),
  collapseFloatingBubbleIfIdle: () => ipcRenderer.invoke('floatingBubble:collapseIfIdle'),
  setFloatingBubbleCollapsedSize: (size) => ipcRenderer.invoke('floatingBubble:setCollapsedSize', size),
  onFloatingBubbleState: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('floatingBubble:state', listener);
    return () => ipcRenderer.removeListener('floatingBubble:state', listener);
  },
  onAppUpdatePush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('appUpdate:push', listener);
    return () => ipcRenderer.removeListener('appUpdate:push', listener);
  },
  setTrayIcons: (icons) => ipcRenderer.invoke('tray:setIcons', icons),
  cursor: {
    loginManual: (token) => ipcRenderer.invoke('cursor:loginManual', token),
    setAccountEnabled: (accountId, enabled) => ipcRenderer.invoke('cursor:setAccountEnabled', accountId, enabled),
    logout: (accountId) => ipcRenderer.invoke('cursor:logout', accountId),
    status: (options = {}) => ipcRenderer.invoke('cursor:status', options)
  },
  claude: {
    accounts: () => ipcRenderer.invoke('claude:accounts'),
    saveWebAccount: (values) => ipcRenderer.invoke('claude:saveWebAccount', values),
    removeWebAccount: (id) => ipcRenderer.invoke('claude:removeWebAccount', id),
    setAccountEnabled: (id, enabled) => ipcRenderer.invoke('claude:setAccountEnabled', id, enabled)
  },
  limits: {
    saveCredential: (providerId, values) => ipcRenderer.invoke('limits:saveCredential', providerId, values),
    listOrganizationChoices: (providerId) => ipcRenderer.invoke('limits:listOrganizationChoices', providerId),
    clearCredential: (providerId) => ipcRenderer.invoke('limits:clearCredential', providerId),
    refresh: (providerId) => ipcRenderer.invoke('limits:refresh', providerId)
  },
  opencode: {
    saveCookie: (cookie) => ipcRenderer.invoke('opencode:saveCookie', cookie),
    logout: () => ipcRenderer.invoke('opencode:logout'),
    status: () => ipcRenderer.invoke('opencode:status'),
    getProfiles: () => ipcRenderer.invoke('opencode:getProfiles'),
    saveProfile: (name, credential, kind, options) => ipcRenderer.invoke('opencode:saveProfile', name, credential, kind, options),
    deleteProfile: (name) => ipcRenderer.invoke('opencode:deleteProfile', name),
    renameProfile: (oldName, newName, options) => ipcRenderer.invoke('opencode:renameProfile', oldName, newName, options),
    removeCredential: (name, kind) => ipcRenderer.invoke('opencode:removeCredential', name, kind),
    moveCredential: (name, kind, targetName, options) => ipcRenderer.invoke('opencode:moveCredential', name, kind, targetName, options),
    setProfileEnabled: (name, enabled) => ipcRenderer.invoke('opencode:setProfileEnabled', name, enabled),
    setAmbientEnabled: (enabled) => ipcRenderer.invoke('opencode:setAmbientEnabled', enabled)
  },
  openrouter: {
    getProfiles: () => ipcRenderer.invoke('openrouter:getProfiles'),
    saveProfile: (name, apiKey) => ipcRenderer.invoke('openrouter:saveProfile', name, apiKey),
    deleteProfile: (name) => ipcRenderer.invoke('openrouter:deleteProfile', name),
    renameProfile: (oldName, newName) => ipcRenderer.invoke('openrouter:renameProfile', oldName, newName),
    setProfileEnabled: (name, enabled) => ipcRenderer.invoke('openrouter:setProfileEnabled', name, enabled)
  },
  thirdparty: {
    getProfiles: () => ipcRenderer.invoke('thirdparty:getProfiles'),
    saveProfile: (profile) => ipcRenderer.invoke('thirdparty:saveProfile', profile),
    deleteProfile: (name) => ipcRenderer.invoke('thirdparty:deleteProfile', name),
    renameProfile: (oldName, newName) => ipcRenderer.invoke('thirdparty:renameProfile', oldName, newName),
    setProfileEnabled: (name, enabled) => ipcRenderer.invoke('thirdparty:setProfileEnabled', name, enabled)
  },
  codex: {
    accounts: () => ipcRenderer.invoke('codex:accounts'),
    addAccount: (options = {}) => ipcRenderer.invoke('codex:addAccount', options),
    selectWorkspace: (options = {}) => ipcRenderer.invoke('codex:selectWorkspace', options),
    cancelLogin: (options = {}) => ipcRenderer.invoke('codex:cancelLogin', options),
    removeAccount: (id) => ipcRenderer.invoke('codex:removeAccount', id),
    setAccountEnabled: (id, enabled) => ipcRenderer.invoke('codex:setAccountEnabled', id, enabled),
    switchSystemAccount: (id) => ipcRenderer.invoke('codex:switchSystemAccount', id),
    refreshAccountLimits: (id) => ipcRenderer.invoke('codex:refreshAccountLimits', id),
    onActiveAccount: (callback) => {
      const handler = (_event, account) => callback(account);
      ipcRenderer.on('codex:activeAccount', handler);
      return () => ipcRenderer.removeListener('codex:activeAccount', handler);
    },
    onLoginStatus: (callback) => {
      const handler = (_event, status) => callback(status);
      ipcRenderer.on('codex:loginStatus', handler);
      return () => ipcRenderer.removeListener('codex:loginStatus', handler);
    }
  },
  copilot: {
    signIn: (options = {}) => ipcRenderer.invoke('copilot:signIn', options),
    cancelSignIn: (options = {}) => ipcRenderer.invoke('copilot:cancelSignIn', options),
    onLoginStatus: (callback) => {
      const handler = (_event, status) => callback(status);
      ipcRenderer.on('copilot:loginStatus', handler);
      return () => ipcRenderer.removeListener('copilot:loginStatus', handler);
    }
  },
  // Plugin management and the views this window draws (Home, tray bitmap).
  // Trust and installation run in main; enabled author UI executes in this page.
  plugins: {
    getSettings: id => pluginSettingsResult(ipcRenderer.invoke('plugins:getSettings', id)),
    updateSettings: (id, input) => pluginSettingsResult(ipcRenderer.invoke('plugins:updateSettings', id, input)),
    list: () => ipcRenderer.invoke('plugins:list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', { id, enabled }),
    setBackground: (id, enabled) => ipcRenderer.invoke('plugins:setBackground', { id, enabled }),
    restart: (id) => ipcRenderer.invoke('plugins:restart', { id }),
    reload: () => ipcRenderer.invoke('plugins:reload'),
    openFolder: () => ipcRenderer.invoke('plugins:openFolder'),
    openPage: ref => ipcRenderer.invoke('plugins:openPage', ref),
    catalog: () => ipcRenderer.invoke('plugins:catalog'),
    catalogPreview: (source, id, version) => ipcRenderer.invoke('plugins:catalogPreview', source, id, version),
    addSource: input => ipcRenderer.invoke('plugins:addSource', input),
    refreshSource: id => ipcRenderer.invoke('plugins:refreshSource', id),
    removeSource: id => ipcRenderer.invoke('plugins:removeSource', id),
    importPackage: kind => ipcRenderer.invoke('plugins:import', kind),
    install: (token, options) => ipcRenderer.invoke('plugins:install', token, options),
    cancelInstall: token => ipcRenderer.invoke('plugins:cancelInstall', token),
    rollback: id => ipcRenderer.invoke('plugins:rollback', id),
    uninstall: (id, options) => ipcRenderer.invoke('plugins:uninstall', id, options),
    place: (ref, surface, placed) => ipcRenderer.invoke('plugins:place', { ref, surface, placed }),
    skins: () => ipcRenderer.invoke('plugins:skins'),
    views: (surface) => ipcRenderer.invoke('plugins:views', { surface }),
    setDemand: (surface, refs) => ipcRenderer.send('plugins:demand', { surface, refs }),
    onViews: (callback) => {
      const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
      ipcRenderer.on('plugins:views', listener);
      return () => ipcRenderer.removeListener('plugins:views', listener);
    },
    onChanged: (callback) => {
      const listener = () => { try { callback(); } catch (_) {} };
      ipcRenderer.on('plugins:changed', listener);
      return () => ipcRenderer.removeListener('plugins:changed', listener);
    }
  },
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close')
});

// Trusted plugin UI shares this renderer. This is routing, not plugin isolation.
contextBridge.exposeInMainWorld('tokenMonitorTrustedPlugins', {
  uiLoading: id => ipcRenderer.send('plugins:uiLoading', id),
  onLifecycle(callback) {
    const listener = async (_event, request) => {
      try { ipcRenderer.send('plugins:lifecycleReply', { request: request.request, value: await callback(request) }); }
      catch (error) { ipcRenderer.send('plugins:lifecycleReply', { request: request.request, error: String(error?.message || error) }); }
    };
    ipcRenderer.on('plugins:lifecycle', listener);
    ipcRenderer.send('plugins:lifecycleHost', true);
    return () => { ipcRenderer.removeListener('plugins:lifecycle', listener); ipcRenderer.send('plugins:lifecycleHost', false); };
  },
  contentSelections: () => ipcRenderer.invoke('plugins:contentSelections'),
  orderContent: (target, refs) => ipcRenderer.invoke('plugins:orderContent', target, refs),
  selectContent: (target, ref) => ipcRenderer.invoke('plugins:selectContent', target, ref),
  call: (id, method, args) => ipcRenderer.invoke('plugins:call', id, method, args),
  host: (id, method, args) => ipcRenderer.invoke('plugins:host', id, method, args),
  views: surface => ipcRenderer.invoke('plugins:views', { surface }),
  subscribe(id, callback) {
    const listener = (_event, message) => { if (message.id === id) callback(message.value); };
    ipcRenderer.on('plugins:backend', listener);
    return () => ipcRenderer.removeListener('plugins:backend', listener);
  },
  subscribeData: (id, query) => ipcRenderer.invoke('plugins:subscribe', id, query),
  unsubscribeData: subscription => ipcRenderer.invoke('plugins:unsubscribe', subscription),
  onData(callback) {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('plugins:data', listener);
    return () => ipcRenderer.removeListener('plugins:data', listener);
  }
});
