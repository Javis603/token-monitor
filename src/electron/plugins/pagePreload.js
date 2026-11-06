'use strict';
const { contextBridge, ipcRenderer } = require('electron');
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('tokenMonitorPluginPage', {
  metadata: () => ipcRenderer.invoke('pluginPage:metadata'),
  select: ref => ipcRenderer.invoke('pluginPage:select', ref),
  onMeta: callback => subscribe('pluginPage:meta', callback),
  onViews: callback => subscribe('pluginPage:views', callback)
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
