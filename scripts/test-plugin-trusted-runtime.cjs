'use strict';
const { app, BrowserWindow, ipcMain, session, utilityProcess, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createPluginRuntime, registerPluginScheme } = require('../src/electron/plugins/runtime');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-runtime-'));
app.setPath('userData', path.join(scratch, 'profile'));
registerPluginScheme(protocol);
let runtime;
const fixture = path.join(scratch, 'source');
fs.cpSync(path.resolve('tests/fixtures/trusted-plugin'), fixture, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Runtime fixture deadline'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  let settings = { pluginsEnabled: true, pluginStates: {}, homeModuleOrder: 'plugin:trusted-fixture/panel', pluginMainPages: ['trusted-fixture/panel'] };
  const win = new BrowserWindow({ show: true, width: 420, height: 600, webPreferences: { preload: path.resolve('src/electron/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  runtime = createPluginRuntime({ electron: { app, BrowserWindow, ipcMain, session, utilityProcess, dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: false, filePaths: [fixture] }) } },
    userDataDir: scratch, getSettings: () => settings, getContext: () => ({ source: 'fixture' }), getLocale: () => 'en',
    isMainSender: event => event.sender === win.webContents,
    persistPluginStates: value => { settings.pluginStates = value; },
    persistManagementSettings: patch => { settings = { ...settings, ...patch }; },
    applySettingsPatch: patch => { settings = { ...settings, ...patch }; }, env: {}, log: console.log });
  await runtime.start();
  await win.loadURL('about:blank');
  const js = source => win.webContents.executeJavaScript(source);
  assert.equal(runtime.manager.backendCount(), 0);
  const preview = await js("tokenMonitor.plugins.importPackage('directory')");
  assert.equal(preview.trustedCode, true);
  await js(`tokenMonitor.plugins.install(${JSON.stringify(preview.token)})`);
  // install resolves only after the transaction and manager reload have completed.
  const installed = await js('tokenMonitor.plugins.list()');
  assert.equal(installed.plugins[0].status, process.argv.includes('--plugins-safe-mode') ? 'safeMode' : 'disabled');
  await js("tokenMonitor.plugins.setEnabled('trusted-fixture',true)");
  assert.equal(runtime.manager.backendCount(), 0);
  if (process.argv.includes('--plugins-safe-mode')) {
    assert.deepEqual(runtime.payload('home').views, {});
    assert.equal((await js('tokenMonitor.plugins.list()')).safeMode, true);
    await assert.rejects(js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo',1)"));
    await runtime.dispose(); runtime = null; clearTimeout(deadline); console.log('PASS external safe-mode flag permits management but no author execution'); app.exit(0); return;
  }
  console.log('PASS install never executes; enabled without demand remains idle');
  await js("tokenMonitor.plugins.setDemand('home',['trusted-fixture/panel'])");
  const result = await js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','native')");
  assert.equal(result.value, 'native'); assert.equal(runtime.manager.backendCount(), 1);
  const payload = await js("tokenMonitorTrustedPlugins.views('home')");
  const descriptor = payload.views['trusted-fixture/panel'];
  assert.ok(descriptor.entry.startsWith('tm-plugin://'));
  const bytes = await session.defaultSession.fetch(descriptor.entry);
  assert.equal(bytes.status, 200);
  console.log('PASS real runtime demand, Node backend and revision asset protocol');
  runtime.publishStats({ periods: { today: { totalTokens: 123, costUsd: 2 }, month: { totalTokens: 456, costUsd: 3 } } });
  const data = await js("tokenMonitorTrustedPlugins.host('trusted-fixture','data.query',{resource:'usage',period:'today'})");
  assert.equal(data.availability, 'available');
  assert.equal(data.rows[0].totalTokens, 123);
  console.log('PASS formal business data query', JSON.stringify(data));
  await js("tokenMonitor.plugins.setEnabled('trusted-fixture',false)");
  assert.equal(runtime.manager.backendCount(), 0);
  assert.equal((await session.defaultSession.fetch(descriptor.entry)).status, 404);
  await assert.rejects(js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo',1)"));
  console.log('PASS disable stops backend and rejects stale assets/calls');
  await pause(150);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json')));
  manifest.version = '2.0.0'; fs.writeFileSync(path.join(fixture, 'manifest.json'), JSON.stringify(manifest));
  fs.appendFileSync(path.join(fixture, 'ui.mjs'), '\n// fixture revision two');
  const update = await js("tokenMonitor.plugins.importPackage('directory')");
  assert.equal(update.operation, 'update');
  await js(`tokenMonitor.plugins.install(${JSON.stringify(update.token)})`);
  assert.equal((await js('tokenMonitor.plugins.list()')).plugins[0].version, '2.0.0');
  assert.equal(runtime.manager.backendCount(), 0);
  await js("tokenMonitor.plugins.setEnabled('trusted-fixture',true)");
  await js("tokenMonitorTrustedPlugins.call('trusted-fixture','file','retained plugin data')");
  await assert.rejects(js("tokenMonitorTrustedPlugins.call('trusted-fixture','fail')"), /Intentional fixture failure/);
  assert.equal((await js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','after error')")).value, 'after error');
  await js("tokenMonitor.plugins.rollback('trusted-fixture')"); await pause(150);
  assert.equal((await js('tokenMonitor.plugins.list()')).plugins[0].version, '1.0.0');
  assert.equal(fs.readFileSync(path.join(scratch, 'plugin-data/trusted-fixture/fixture.txt'), 'utf8'), 'retained plugin data');
  await js("tokenMonitor.plugins.uninstall('trusted-fixture',{keepData:true,keepPlacements:true})"); await pause(150);
  assert.equal((await js('tokenMonitor.plugins.list()')).plugins.length, 0);
  assert.equal(fs.readFileSync(path.join(scratch, 'plugin-data/trusted-fixture/fixture.txt'), 'utf8'), 'retained plugin data');
  console.log('PASS native update/retrust, call failure recovery, rollback and retained-data uninstall');
  await runtime.dispose(); runtime = null; clearTimeout(deadline);

  app.exit(0);
}).catch(error => { console.error(error); runtime?.dispose(); app.exit(1); });
