'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Same narrow renderer contract; independent channels, never EdgeDock handlers.
contextBridge.exposeInMainWorld('tokenMonitorEdgeDock', {
  syncWebSurface: input => ipcRenderer.invoke('plugins:surface:sync', input),
  onWebSurfaceReady: callback => { const listener = () => callback(); ipcRenderer.on('plugins:surface:ready', listener); return () => ipcRenderer.removeListener('plugins:surface:ready', listener); },
  onWebSurfaceFailed: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('plugins:surface:failed', listener); return () => ipcRenderer.removeListener('plugins:surface:failed', listener); },
  onWebSurfaceEscape: callback => { const listener = () => callback(); ipcRenderer.on('plugins:surface:escape', listener); return () => ipcRenderer.removeListener('plugins:surface:escape', listener); },
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
  interact: (ref, input, revision) => ipcRenderer.invoke('plugins:interact', { surface: 'notch', ref, input, revision }),
  onPluginViews: (callback) => subscribe('plugins:views', callback),
  onScroll: (callback) => subscribe('topNotch:scroll', callback)
});
