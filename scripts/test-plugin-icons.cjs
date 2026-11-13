'use strict';
// Real Chromium load/error events and DOM reconciliation; no personal profile.
// Run: env -u ELECTRON_RUN_AS_NODE electron scripts/test-plugin-icons.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-icons-'));
app.setPath('userData', path.join(scratch, 'profile'));
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  const page = path.join(scratch, 'fixture.html');
  const scripts = ['src/shared/vendorPresentation.js', 'src/electron/renderer/domReconcile.js', 'src/electron/renderer/pluginViews.js'];
  fs.writeFileSync(page, '<!doctype html><body>' + scripts.map(file => `<script src="${pathToFileURL(path.join(root, file)).href}"></script>`).join(''));
  await win.loadFile(page);
  console.log(await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'tests/fixtures/plugin-icon-dom-regression.cjs'), 'utf8')));
  clearTimeout(deadline); win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
