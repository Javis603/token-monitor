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
  onRender: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('edgeDock:render', listener);
    return () => ipcRenderer.removeListener('edgeDock:render', listener);
  }
});
