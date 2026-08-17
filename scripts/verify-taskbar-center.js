'use strict';

/**
 * Verification harness for the taskbar widget's vertical centering.
 * Loads the REAL widget page (src/electron/renderer/taskbarWidget.html +
 * taskbarWidget.css) in a window sized to the actual taskbar strip, injects
 * sample two-line text (as the live stats feed would), captures the rendered
 * page and saves it to <repo>/taskbar-center-check.png for pixel analysis.
 *
 * Run from the repo root:
 *   node_modules/electron/dist/electron.exe scripts/verify-taskbar-center.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const { taskbarWidgetBounds } = require('../src/electron/taskbarWidget');

const OUT = path.join(__dirname, '..', 'taskbar-center-check.png');

app.whenReady().then(async () => {
  const bounds = taskbarWidgetBounds(require('electron').screen.getPrimaryDisplay());
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    show: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'electron', 'renderer', 'taskbarWidget.html'));
  // Simulate the stats payload the live widget receives.
  await win.webContents.executeJavaScript(
    `document.getElementById('total').textContent = '2.0B tokens';
     document.getElementById('today').textContent = '今日 29M';`
  );
  await new Promise((r) => setTimeout(r, 250)); // let text settle/fonts load
  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());
  console.log('saved ' + OUT + ' size=' + bounds.width + 'x' + bounds.height);
  app.exit(0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
