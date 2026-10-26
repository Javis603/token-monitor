'use strict';
const path = require('node:path');
const { parseRef } = require('../../shared/plugins/placements');

// Visible application windows hosting trusted author modules through the same
// renderer adapter as the main window. Native window ownership stays here.
function createPluginPages({ BrowserWindow, ipcMain, manager, getSettings, getLocale,
  onDemand = refs => manager.setSurfaceDemand('page', refs) }) {
  const windows = new Map();
  let disposed = false;
  function catalog(id) { return manager.list().plugins.find(plugin => plugin.id === id); }
  function recordFor(event) {
    const record = [...windows.values()].find(entry => entry.win.webContents === event.sender);
    if (!record || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) throw new Error('not a plugin page');
    return record;
  }
  function metadata(record) {
    const plugin = catalog(record.id);
    return { id: record.id, ref: record.ref, name: plugin?.name || record.id, status: plugin?.status || 'missing',
      description: plugin?.description || '', views: (plugin?.views || []).filter(view => view.surfaces.includes('page')),
      locale: getLocale(), themeColors: getSettings()?.themeColors || {},
      appearance: Object.fromEntries(['interfaceFontFamily', 'displayFontFamily', 'textSize', 'reduceMotion', 'tokenNumberAnimation'].map(key => [key, getSettings()?.[key]])) };
  }
  function visible(record) { return !record.win.isDestroyed() && record.win.isVisible() && !record.win.isMinimized(); }
  function syncDemand() {
    onDemand([...windows.values()].filter(visible).map(record => record.ref));
    const payload = manager.payload('page');
    for (const record of windows.values()) if (visible(record)) sendViews(record, payload);
  }
  function sendMeta(record) {
    if (record.win.isDestroyed()) return;
    record.win.webContents.send('pluginPage:meta', metadata(record));
  }
  function sendViews(record, payload) {
    record.win.webContents.send('pluginPage:views', { surface: 'page', appearance: payload.appearance, views: { [record.ref]: payload.views[record.ref] || { ref: record.ref, status: 'missing' } } });
  }
  const offViews = manager.onViews((surface, payload) => {
    if (surface !== 'page') return;
    for (const record of windows.values()) {
      if (!visible(record)) continue;
      sendViews(record, payload);
    }
  });
  const offChanged = manager.onChanged(() => { for (const record of windows.values()) sendMeta(record); syncDemand(); });
  ipcMain.handle('pluginPage:metadata', event => metadata(recordFor(event)));
  ipcMain.handle('pluginPage:select', (event, ref) => {
    const record = recordFor(event);
    if (!catalog(record.id)?.views.some(view => view.ref === ref && view.surfaces.includes('page'))) throw new Error('page does not belong to this plugin');
    record.ref = ref;
    syncDemand();
    sendMeta(record);
    return metadata(record);
  });
  return {
    ownsSender(sender) { return [...windows.values()].some(record => record.win.webContents === sender); },
    broadcast(channel, value) { for (const record of windows.values()) if (!record.win.isDestroyed()) record.win.webContents.send(channel, value); },
    open(ref) {
      if (disposed) throw new Error('plugin pages are closed');
      const parsed = parseRef(ref);
      const plugin = parsed && catalog(parsed.pluginId);
      if (!plugin?.views.some(view => view.ref === ref && view.surfaces.includes('page'))) throw new Error('plugin page is unavailable');
      let record = windows.get(parsed.pluginId);
      if (record && !record.win.isDestroyed()) {
        record.ref = ref; record.win.restore(); record.win.show(); record.win.focus(); sendMeta(record); syncDemand(); return;
      }
      const win = new BrowserWindow({ width: 880, height: 640, minWidth: 380, minHeight: 360, show: false,
        title: `${plugin.name} — Token Monitor`, backgroundColor: '#303438',
        webPreferences: { preload: path.join(__dirname, 'pagePreload.js'), sandbox: true, contextIsolation: true,
          nodeIntegration: false, webviewTag: false, webSecurity: true } });
      record = { id: parsed.pluginId, ref, win };
      windows.set(record.id, record);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('will-attach-webview', event => event.preventDefault());
      win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
      for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, syncDemand);
      win.on('closed', () => { if (windows.get(record.id) === record) windows.delete(record.id); syncDemand(); });
      win.loadFile(path.join(__dirname, '../renderer/plugins/page.html')).catch(() => { if (!win.isDestroyed()) win.close(); });
    },
    reloadHosts() { for (const record of windows.values()) if (!record.win.isDestroyed()) record.win.webContents.reload(); },
    refreshVisibility: syncDemand,
    refresh() { for (const record of windows.values()) sendMeta(record); },
    dispose() {
      if (disposed) return;
      disposed = true; offViews(); offChanged();
      for (const record of windows.values()) if (!record.win.isDestroyed()) record.win.destroy();
      windows.clear(); onDemand([]);
      ipcMain.removeHandler('pluginPage:metadata'); ipcMain.removeHandler('pluginPage:select');
    }
  };
}
module.exports = { createPluginPages };
