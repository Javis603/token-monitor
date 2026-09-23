'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The dock is a glance surface floating over other apps, so its renderer gets a
// deliberately narrow bridge: it can render what the main process pushes and
// report pointer gestures, nothing else (no settings writes, no credentials).
contextBridge.exposeInMainWorld('tokenMonitorEdgeDock', {
  ready: () => ipcRenderer.send('edgeDock:ready'),
  click: (cellIndex) => ipcRenderer.send('edgeDock:click', { cellIndex }),
  dragStart: (grabOffsetY) => ipcRenderer.send('edgeDock:dragStart', { grabOffsetY }),
  dragEnd: () => ipcRenderer.send('edgeDock:dragEnd'),
  reportBubbleSize: (cellId, height) => ipcRenderer.send('edgeDock:bubbleSize', { cellId, height }),
  dismiss: () => ipcRenderer.send('edgeDock:dismiss'),
  toggleRateMode: () => ipcRenderer.send('edgeDock:toggleRateMode'),
  // Switching the local Codex account is the one action the dock can take; it
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
  }
});
