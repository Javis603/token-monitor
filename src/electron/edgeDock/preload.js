'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The dock is a glance surface floating over other apps, so its renderer gets a
// deliberately narrow bridge: it can render what the main process pushes and
// report pointer gestures, nothing else (no settings writes, no credentials).
contextBridge.exposeInMainWorld('tokenMonitorEdgeDock', {
  syncWebSurface: input => ipcRenderer.invoke('plugins:surface:sync', input),
  onWebSurfaceReady: callback => { const listener = () => callback(); ipcRenderer.on('plugins:surface:ready', listener); return () => ipcRenderer.removeListener('plugins:surface:ready', listener); },
  onWebSurfaceFailed: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('plugins:surface:failed', listener); return () => ipcRenderer.removeListener('plugins:surface:failed', listener); },
  onWebSurfaceEscape: callback => { const listener = () => callback(); ipcRenderer.on('plugins:surface:escape', listener); return () => ipcRenderer.removeListener('plugins:surface:escape', listener); },
  ready: () => ipcRenderer.send('edgeDock:ready'),
  click: (cellIndex) => ipcRenderer.send('edgeDock:click', { cellIndex }),
  pointer: () => ipcRenderer.send('edgeDock:pointer'),
  dragStart: (grabOffsetY) => ipcRenderer.send('edgeDock:dragStart', { grabOffsetY }),
  dragEnd: () => ipcRenderer.send('edgeDock:dragEnd'),
  reportBubbleSize: (cellId, height) => ipcRenderer.send('edgeDock:bubbleSize', { cellId, height }),
  dismiss: () => ipcRenderer.send('edgeDock:dismiss'),
  toggleRateMode: () => ipcRenderer.send('edgeDock:toggleRateMode'),
  refreshLimits: () => ipcRenderer.invoke('edgeDock:refreshLimits'),
  peekPainted: (mode, shapeKey) => ipcRenderer.send('edgeDock:peekPainted', { mode, shapeKey }),
  // Switching the local Codex account runs through the same action as the widget; it
  // is the same call the Limits view's Switch button makes, and the main
  // process re-projects the cards once it lands.
  switchCodexAccount: (accountId) => ipcRenderer.invoke('edgeDock:switchCodexAccount', { accountId }),
  // The Codex reset forecast row is a link on the Limits page, and the card is
  // that row. The renderer names the intent rather than a URL, so widening this
  // bridge did not hand a floating surface a general "open anything" verb.
  openResetForecastSource: () => ipcRenderer.send('edgeDock:openResetForecastSource'),
  onRender: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('edgeDock:render', listener);
    return () => ipcRenderer.removeListener('edgeDock:render', listener);
  },
  // Plugin cells: which views this window shows, and their resolved content.
  setPluginDemand: (refs) => ipcRenderer.send('edgeDock:pluginDemand', { refs }),
  interact: (ref, input, revision) => ipcRenderer.invoke('plugins:interact', { surface: 'edgeDock', ref, input, revision }),
  onPluginViews: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('plugins:views', listener);
    return () => ipcRenderer.removeListener('plugins:views', listener);
  }
});
