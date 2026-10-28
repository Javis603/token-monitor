'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Same narrow renderer contract; independent channels, never EdgeDock handlers.
contextBridge.exposeInMainWorld('tokenMonitorEdgeDock', {
  ready: () => ipcRenderer.send('topNotch:ready'),
  reportNotchSize: (height, slots, summaryMeasurement) => ipcRenderer.send('topNotch:size', { height, slots, summaryMeasurement }),
  reportMotionFrame: (id, elapsed) => ipcRenderer.send('topNotch:frame', { id, elapsed }),
  onAnimate: (callback) => subscribe('topNotch:animate', callback),
  onMotion: (callback) => subscribe('topNotch:motion', callback),
  dismiss: () => ipcRenderer.send('topNotch:dismiss'),
  pointer: () => ipcRenderer.send('topNotch:pointer'),
  press: () => ipcRenderer.send('topNotch:press'),
  wheel: (deltaX, deltaY) => ipcRenderer.send('topNotch:wheel', { deltaX, deltaY }),
  refreshLimits: () => ipcRenderer.invoke('topNotch:refreshLimits'),
  toggleRateMode: () => ipcRenderer.send('topNotch:toggleRateMode'),
  switchCodexAccount: (accountId) => ipcRenderer.invoke('topNotch:switchCodexAccount', { accountId }),
  onRender: (callback) => subscribe('topNotch:render', callback),
  // Plugin pages: which views the open panel shows, and their content.
  setPluginDemand: (refs) => ipcRenderer.send('topNotch:pluginDemand', { refs }),
  onPluginViews: (callback) => subscribe('plugins:views', callback),
  onScroll: (callback) => subscribe('topNotch:scroll', callback)
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
