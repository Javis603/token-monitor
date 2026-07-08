'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokenMonitor', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  lookupModelPricing: (modelId) => ipcRenderer.invoke('pricing:lookup', modelId),
  previewAppearance: (patch) => ipcRenderer.invoke('appearance:preview', patch),
  getStats: (options) => ipcRenderer.invoke('stats:get', options),
  getSessionDetail: (args) => ipcRenderer.invoke('session:getDetail', args),
  getStreamStatus: () => ipcRenderer.invoke('stream:status'),
  getServiceStatus: (options) => ipcRenderer.invoke('serviceStatus:get', options),
  openDashboard: () => ipcRenderer.invoke('dashboard:open'),
  getDashboardHistory: () => ipcRenderer.invoke('dashboard:getHistory'),
  dashboard: {
    minimize: () => ipcRenderer.send('dashboard:minimize'),
    close: () => ipcRenderer.send('dashboard:close')
  },
  getHubInfo: () => ipcRenderer.invoke('hub:getInfo'),
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
  onTokscalePush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('tokscale:push', listener);
    return () => ipcRenderer.removeListener('tokscale:push', listener);
  },
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openUserData: () => ipcRenderer.invoke('app:openUserData'),
  exportNow: () => ipcRenderer.invoke('export:now'),
  pickExportDir: () => ipcRenderer.invoke('export:pickAutoDir'),
  getTokscaleStatus: () => ipcRenderer.invoke('tokscale:getStatus'),
  checkTokscaleNpm: () => ipcRenderer.invoke('tokscale:checkNpm'),
  downloadTokscaleFromNpm: () => ipcRenderer.invoke('tokscale:downloadFromNpm'),
  resetTokscaleToBundled: () => ipcRenderer.invoke('tokscale:resetToBundled'),
  getAppUpdateState: () => ipcRenderer.invoke('appUpdate:getState'),
  checkAppUpdateNow: () => ipcRenderer.invoke('appUpdate:checkNow'),
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
  opencode: {
    saveCookie: (cookie) => ipcRenderer.invoke('opencode:saveCookie', cookie),
    logout: () => ipcRenderer.invoke('opencode:logout'),
    status: () => ipcRenderer.invoke('opencode:status'),
    getProfiles: () => ipcRenderer.invoke('opencode:getProfiles'),
    saveProfile: (name, cookie) => ipcRenderer.invoke('opencode:saveProfile', name, cookie),
    deleteProfile: (name) => ipcRenderer.invoke('opencode:deleteProfile', name),
    renameProfile: (oldName, newName) => ipcRenderer.invoke('opencode:renameProfile', oldName, newName),
    setProfileEnabled: (name, enabled) => ipcRenderer.invoke('opencode:setProfileEnabled', name, enabled)
  },
  codex: {
    accounts: () => ipcRenderer.invoke('codex:accounts'),
    addAccount: () => ipcRenderer.invoke('codex:addAccount'),
    removeAccount: (id) => ipcRenderer.invoke('codex:removeAccount', id),
    setAccountEnabled: (id, enabled) => ipcRenderer.invoke('codex:setAccountEnabled', id, enabled),
    switchSystemAccount: (id) => ipcRenderer.invoke('codex:switchSystemAccount', id),
    refreshAccountLimits: (id) => ipcRenderer.invoke('codex:refreshAccountLimits', id),
    onLoginOutput: (callback) => {
      const handler = (_event, text) => callback(text);
      ipcRenderer.on('codex:loginOutput', handler);
      return () => ipcRenderer.removeListener('codex:loginOutput', handler);
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
