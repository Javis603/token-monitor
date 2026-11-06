'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('limitsHistory', {
  platform: process.platform,
  cardFrame: motionId => ipcRenderer.send('limitsHistory:cardFrame', { motionId }),
  onCardMotion(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('limitsHistory:cardMotion', listener);
    return () => ipcRenderer.removeListener('limitsHistory:cardMotion', listener);
  },
  onNativeMaterial(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('appearance:nativeMaterial', listener);
    return () => ipcRenderer.removeListener('appearance:nativeMaterial', listener);
  },
  enter: () => ipcRenderer.send('limitsHistory:enter'),
  leave: () => ipcRenderer.send('limitsHistory:leave'),
  close: () => ipcRenderer.send('limitsHistory:close'),
  resize: (height, renderToken, animate = false, reduceMotion = false) => ipcRenderer.send('limitsHistory:resize', height, renderToken, animate, reduceMotion),
  onRender(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('limitsHistory:render', listener);
    return () => ipcRenderer.removeListener('limitsHistory:render', listener);
  }
});
