'use strict';
// Isolated Electron regression. No app profile, network server or debug port.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, protocol, session, BrowserWindow } = require('electron');
const { registerPluginScheme } = require('../src/electron/plugins/runtime');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-schemes-review-'));
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'session'));
app.on('window-all-closed', () => {});
let calls = 0;
registerPluginScheme({ registerSchemesAsPrivileged(schemes) { calls++; protocol.registerSchemesAsPrivileged(schemes); } });
const report = { electron: process.versions.electron, calls, checks: [] };
const deadline = setTimeout(() => { console.error('scheme regression deadline'); app.exit(2); }, 20000);
app.whenReady().then(async () => {
  app.dock?.hide();
  const ses = session.fromPartition('tm-schemes-review', { cache: false });
  for (const scheme of ['tm-plugin', 'tm-plugin-ui']) {
    ses.protocol.handle(scheme, () => new Response('<!doctype html><title>scheme probe</title>', { headers: { 'content-type': 'text/html' } }));
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, nodeIntegration: false, contextIsolation: true } });
    try {
      await win.loadURL(`${scheme}://probe/index.html`);
      const result = await win.webContents.executeJavaScript(`({ secure: isSecureContext, origin: location.origin, crypto: typeof crypto.subtle, relative: new URL('child.js', location.href).href })`);
      report.checks.push({ scheme, ...result });
    } finally { win.destroy(); ses.protocol.unhandle(scheme); }
  }
  console.log(JSON.stringify(report, null, 2));
  const pass = calls === 1 && report.checks.every(r => r.secure && r.crypto === 'object' && r.origin === r.scheme + '://probe' && r.relative === r.scheme + '://probe/child.js');
  clearTimeout(deadline); app.exit(pass ? 0 : 1);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(2); });
