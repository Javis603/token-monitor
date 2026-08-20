'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokenMonitor', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  // Subscriptions are shared across devices when a hub is configured, so they
  // have their own channel: the write is a network round trip main.js has to
  // await, and it can fail in ways a settings write cannot.
  saveSubscriptions: (subscriptions, base) => ipcRenderer.invoke('subscriptions:save', subscriptions, base),
  // Records this device held before it joined a hub that already had a list.
  adoptOrphanedSubscriptions: () => ipcRenderer.invoke('subscriptions:adoptOrphans'),
  discardOrphanedSubscriptions: () => ipcRenderer.invoke('subscriptions:discardOrphans'),
  clearSessionUsageArchive: () => ipcRenderer.invoke('sessionUsageArchive:clear'),
  lookupModelPricing: (modelId) => ipcRenderer.invoke('pricing:lookup', modelId),
  previewAppearance: (patch) => ipcRenderer.invoke('appearance:preview', patch),
  getStats: (options) => ipcRenderer.invoke('stats:get', options),
  getSessionDetail: (args) => ipcRenderer.invoke('session:getDetail', args),
  getStreamStatus: () => ipcRenderer.invoke('stream:status'),
  getServiceStatus: (options) => ipcRenderer.invoke('serviceStatus:get', options),
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
  onSettingsPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('settings:push', listener);
    return () => ipcRenderer.removeListener('settings:push', listener);
  },
  onSystemUiThemePush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('theme:systemUi', listener);
    return () => ipcRenderer.removeListener('theme:systemUi', listener);
  },
  onOpenSettings: (callback) => {
    const listener = () => { try { callback(); } catch (_) {} };
    ipcRenderer.on('settings:open', listener);
    return () => ipcRenderer.removeListener('settings:open', listener);
  },
  onOpenView: (callback) => {
    const listener = (_event, viewId) => { try { callback(viewId); } catch (_) {} };
    ipcRenderer.on('view:open', listener);
    return () => ipcRenderer.removeListener('view:open', listener);
  },
  onTokscalePush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('tokscale:push', listener);
    return () => ipcRenderer.removeListener('tokscale:push', listener);
  },
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  generateDiagnosticReport: () => ipcRenderer.invoke('diagnostics:generate'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  clientSources: (clientId) => ipcRenderer.invoke('usage:clientSources', clientId),
  revealClientSource: (clientId) => ipcRenderer.invoke('usage:revealClientSource', clientId),
  rescanClient: (clientId) => ipcRenderer.invoke('usage:rescanClient', clientId),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openUserData: () => ipcRenderer.invoke('app:openUserData'),
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
  checkTokscaleNpm: () => ipcRenderer.invoke('tokscale:checkNpm'),
  downloadTokscaleFromNpm: () => ipcRenderer.invoke('tokscale:downloadFromNpm'),
  resetTokscaleToBundled: () => ipcRenderer.invoke('tokscale:resetToBundled'),
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
    logout: () => ipcRenderer.invoke('cursor:logout'),
    status: () => ipcRenderer.invoke('cursor:status')
  },
  claude: {
    saveCookie: (cookie) => ipcRenderer.invoke('claude:saveCookie', cookie)
  },
  ollama: {
    validateCookie: (cookie) => ipcRenderer.invoke('ollama:validateCookie', cookie)
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
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close')
});
