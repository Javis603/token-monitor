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
  onScroll: (callback) => subscribe('topNotch:scroll', callback)
});
