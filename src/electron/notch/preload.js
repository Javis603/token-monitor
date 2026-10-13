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
  reportNotchSize: (height, slots, rows, summaryMeasurement) => ipcRenderer.send('topNotch:size', { height, slots, rows, summaryMeasurement }),
  reportBubbleSize: (cellId, height) => ipcRenderer.send('topNotch:bubbleSize', { cellId, height }),
  reportMotionFrame: (id, elapsed) => ipcRenderer.send('topNotch:frame', { id, elapsed }),
  onAnimate: (callback) => subscribe('topNotch:animate', callback),
  onMotion: (callback) => subscribe('topNotch:motion', callback),
  dismiss: () => ipcRenderer.send('topNotch:dismiss'),
  refreshLimits: () => ipcRenderer.invoke('topNotch:refreshLimits'),
  toggleRateMode: () => ipcRenderer.send('topNotch:toggleRateMode'),
  switchCodexAccount: (accountId) => ipcRenderer.invoke('topNotch:switchCodexAccount', { accountId }),
  openResetForecastSource: () => ipcRenderer.send('topNotch:openResetForecastSource'),
  onRender: (callback) => subscribe('topNotch:render', callback)
});
