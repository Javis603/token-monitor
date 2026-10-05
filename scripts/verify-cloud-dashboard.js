'use strict';
// Run with Electron, not Node. Uses the real bundled dashboard and local report;
// never starts a model turn, scans cloud history or stops the observer.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerCloudUsageIpc } = require('../src/electron/cloudUsageBridge');
const output = process.env.TM_CLOUD_VERIFY_DIR;
if (!output || !path.isAbsolute(output)) throw new Error('TM_CLOUD_VERIFY_DIR must be an explicit absolute test directory');
app.setPath('userData', path.join(output, 'electron-profile'));
let windowHandle;
const errors = [];
const deadline = setTimeout(() => { console.error('CLOUD_DASHBOARD_TIMEOUT'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const renderer = path.resolve(__dirname, '../src/electron/renderer');
  windowHandle = new BrowserWindow({ width: 1320, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.resolve(__dirname, '../src/electron/preload.js') } });
  windowHandle.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(String(event.message)); });
  windowHandle.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ipcMain.handle('settings:get', () => ({ language: 'zh-CN', dashboardFlat: true, compactTokenUnits: 'western' }));
  ipcMain.handle('appearance:getNativeMaterial', () => ({ type: 'transparent' }));
  ipcMain.handle('dashboard:getHistory', () => ({ daily: [], monthly: [] }));
  ipcMain.handle('settings:update', () => ({ ok: true }));
  registerCloudUsageIpc({ ipcMain, getWindows: () => [windowHandle], rendererDir: renderer, open() {} });
  ipcMain.on('dashboard:ready', async () => {
    try {
      windowHandle.showInactive();
      const until = Date.now() + 20000;
      let count = 0;
      while (Date.now() < until) {
        count = await windowHandle.webContents.executeJavaScript('document.querySelectorAll("[data-cloud-thread]").length');
        if (count > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const ui = await windowHandle.webContents.executeJavaScript(`(() => {
        const tab = document.getElementById('cloudTab');
        const pane = document.getElementById('cloudPane');
        const info = { tab: tab.textContent, active: tab.classList.contains('active'), visible: !pane.classList.contains('hidden'), rows: document.querySelectorAll('[data-cloud-thread]').length, text: document.querySelector('.cloud-status-line').textContent };
        const filter = document.querySelector('.cloud-filter'); filter.value = 'measured'; filter.dispatchEvent(new Event('change'));
        info.measuredRows = document.querySelectorAll('[data-cloud-thread]').length;
        return info;
      })()`);
      if (!ui.active || !ui.visible || !ui.rows || errors.length) throw new Error('Cloud dashboard acceptance failed');
      await windowHandle.webContents.executeJavaScript(`new Promise(resolve => { document.getElementById('cloudPane').scrollTop = 0; requestAnimationFrame(() => requestAnimationFrame(resolve)); })`);
      const positions = await windowHandle.webContents.executeJavaScript(`(() => { const p=document.getElementById('cloudPane'), h=document.querySelector('.cloud-heading'); return {scroll:p.scrollTop,paneTop:p.getBoundingClientRect().top,headingTop:h.getBoundingClientRect().top,rootTop:h.parentElement.getBoundingClientRect().top}; })()`);
      const image = await windowHandle.webContents.capturePage();
      fs.writeFileSync(path.join(output, 'native-cloud-dashboard.png'), image.toPNG(), { mode: 0o600 });
      fs.writeFileSync(path.join(output, 'native-cloud-dashboard.json'), JSON.stringify({ ...ui, errors, view: 'real-electron-real-local-report' }, null, 2), { mode: 0o600 });
      console.log('CLOUD_NATIVE_UI_PASS', JSON.stringify({ ...ui, positions }));
      clearTimeout(deadline); app.exit(0);
    } catch (e) { console.error('CLOUD_NATIVE_UI_FAILED', e.message, JSON.stringify(errors)); clearTimeout(deadline); app.exit(1); }
  });
  await windowHandle.loadFile(path.join(renderer, 'dashboard.html'), { query: { tab: 'cloud' } });
}).catch((e) => { console.error(e.message); clearTimeout(deadline); app.exit(1); });
