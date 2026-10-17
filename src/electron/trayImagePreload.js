'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayImage', {
  onRender(callback) {
    ipcRenderer.on('trayImage:render', async (_event, request) => {
      try {
        const icons = await callback(request.input);
        ipcRenderer.send('trayImage:rendered', { id: request.id, icons });
      } catch (_) {
        ipcRenderer.send('trayImage:rendered', { id: request.id, error: true });
      }
    });
    ipcRenderer.send('trayImage:ready');
  }
});
