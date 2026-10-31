'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The dock is a glance surface floating over other apps, so its renderer gets a
// deliberately narrow bridge: it can render what the main process pushes and
// report pointer gestures, nothing else (no settings writes, no credentials).
contextBridge.exposeInMainWorld('tokenMonitorEdgeDock', {
  ready: () => ipcRenderer.send('edgeDock:ready'),
  click: (cellIndex) => ipcRenderer.send('edgeDock:click', { cellIndex }),
  pointer: () => ipcRenderer.send('edgeDock:pointer'),
  dragStart: (grabOffsetY) => ipcRenderer.send('edgeDock:dragStart', { grabOffsetY }),
  dragEnd: () => ipcRenderer.send('edgeDock:dragEnd'),
  // `holdTop` keeps the window's top edge fixed while the card grows for a
  // tooltip, so the card does not jump out from under the pointer.
  reportBubbleSize: (cellId, height, holdTop) => ipcRenderer.send('edgeDock:bubbleSize', {
    cellId, height, holdTop: holdTop === true
  }),
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
  onPluginViews: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('plugins:views', listener);
    return () => ipcRenderer.removeListener('plugins:views', listener);
  }
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
