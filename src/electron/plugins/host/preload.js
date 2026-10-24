'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The plugin host page's only bridge: one message channel to main. Plugin code
// runs in a Worker spawned by the host page and never sees this object.
contextBridge.exposeInMainWorld('tmPluginHost', {
  send: (message) => ipcRenderer.send('plugin-host:message', message),
  onMessage: (callback) => {
    ipcRenderer.on('plugin-host:message', (_event, message) => callback(message));
  }
});

// This measurement runs in the isolated, trusted preload world. The Worker
// cannot forge this IPC channel. On macOS private memory includes compressed
// pages that disappear from app.getAppMetrics().workingSetSize.
async function reportMemory() {
  try {
    const memory = await process.getProcessMemoryInfo();
    ipcRenderer.send('plugin-host:memory', memory.private);
  } catch {}
}
void reportMemory();
setInterval(reportMemory, 3000);
