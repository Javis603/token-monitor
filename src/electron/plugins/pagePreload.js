'use strict';
const { contextBridge, ipcRenderer } = require('electron');
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('tokenMonitorPluginPage', {
  syncWebPresentation: input => ipcRenderer.invoke('plugins:presentation:sync', input),
  onWebPresentationReady: callback => subscribe('plugins:presentation:ready', callback),
  onWebPresentationFailed: callback => subscribe('plugins:presentation:failed', callback),
  metadata: () => ipcRenderer.invoke('pluginPage:metadata'),
  interact: (ref, input, revision) => ipcRenderer.invoke('pluginPage:interact', ref, input, revision),
  select: ref => ipcRenderer.invoke('pluginPage:select', ref),
  onMeta: callback => subscribe('pluginPage:meta', callback),
  onViews: callback => subscribe('pluginPage:views', callback)
});
