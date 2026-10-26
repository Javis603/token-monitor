'use strict';
// Actual App HTML, renderer, preload and plugin runtime. Host collection/account
// IPC uses synthetic records; no personal profile, collector or credentials load.
const { app, BrowserWindow, ipcMain, session, utilityProcess, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createPluginRuntime, registerPluginScheme } = require('../src/electron/plugins/runtime');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-app-'));
const evidence = process.env.TM_PLUGIN_EVIDENCE || scratch;
fs.mkdirSync(evidence, { recursive: true });
app.setPath('userData', path.join(scratch, 'profile'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
registerPluginScheme(protocol);
app.on('window-all-closed', () => {});
let runtime, win;
const errors = [];
const deadline = setTimeout(() => { console.error('App fixture deadline'); app.exit(1); }, 90000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function defaults() {
  const source = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
  const fn = source.slice(source.indexOf('function defaultSettings()'), source.indexOf('\nfunction normalizeCollectionMode('));
  return vm.runInNewContext(fn + ';defaultSettings()', {
    process: { env: {} }, HUB_DEFAULT_PORT: 17321, HOME_LIMIT_ACCOUNT_COUNT_DEFAULT: 3,
    ...require('../src/shared/limits/collector'), ...require('../src/shared/currency'),
    ...require('../src/shared/trayLayout'), ...require('../src/shared/clientTracking'),
    ...require('../src/electron/syncUploadScheduler'), ...require('../src/electron/syncContentRuntime'),
    ...require('../src/electron/renderer/viewDisplayPreferences'), ...require('../src/electron/renderer/homeModulePreferences'),
    ...require('../src/electron/limits/accountSettings'),
    fontSettingsApi: require('../src/shared/fontSettings'), pluginPlacements: require('../src/shared/plugins/placements'),
    normalizeHistoryIntervalMs: () => 60000, defaultDeviceId: () => 'fixture', defaultLimitProviderOrder: () => ''
  });
}
async function waitFor(js, label) {
  for (let i = 0; i < 150; i++) { if (await win.webContents.executeJavaScript(js)) return; await pause(40); }
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  let settings = { ...defaults(), language: 'zh-TW', systemGlass: false, reduceMotion: 'on', tokenNumberAnimation: 'off', refreshMs: 3600000 };
  const period = { totalTokens: 125000, costUsd: 4.25, inputTokens: 100000, outputTokens: 25000, cachedInputTokens: 0, sessions: [], models: [], tools: [], devices: [], projects: [] };
  const stats = { updatedAt: new Date().toISOString(), periods: { today: period, month: { ...period, totalTokens: 750000 }, allTime: period }, devices: [], limits: { providers: [] } };
  win = new BrowserWindow({ show: true, width: 400, height: 820, backgroundColor: '#17181a', webPreferences: { preload: path.join(root, 'src/electron/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) { errors.push(message); console.log('RENDERER', message); } });
  win.webContents.on('render-process-gone', (_event, details) => { console.error(details); app.exit(1); });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [require('../src/electron/contentSecurityPolicy').contentSecurityPolicyForRequest(details)] } }));
  const handlers = {
    'settings:get': () => settings,
    'settings:update': async (event, patch) => { const after = await runtime.beforeSettingsChange(event, patch); settings = { ...settings, ...patch }; runtime.settingsChanged(); after(); return settings; },
    'app:getInfo': () => ({ version: 'fixture', platform: process.platform, systemUiTheme: 'dark', loginItemSupported: false }),
    'appUpdate:get': () => ({}), 'appearance:getNativeMaterial': () => null,
    'stats:get': () => stats, 'stream:status': () => ({ connected: true, mode: 'local' }),
    'syncContent:status': () => ({ identity: 'fixture', available: false }),
    'hub:getInfo': () => ({ mode: 'local', devices: [] }), 'hub:getBuildStatus': () => ({}),
    'tokscale:status': () => ({ available: true, version: 'fixture' }),
    'appearance:getBackgroundImage': () => null
  };
  // Every non-plugin invoke gets an isolated stub. Unexpected use remains visible.
  const preload = fs.readFileSync(path.join(root, 'src/electron/preload.js'), 'utf8');
  for (const [, channel] of preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)) {
    if (channel.startsWith('plugins:')) continue;
    const handler = handlers[channel] || (() => channel.endsWith(':accounts') ? [] : {});
    ipcMain.removeHandler(channel); ipcMain.handle(channel, handler);
  }
  const patch = value => { settings = { ...settings, ...value }; win.webContents.send('settings:push', settings); };
  runtime = createPluginRuntime({ electron: { BrowserWindow, ipcMain, session, utilityProcess,
    dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(root, 'tests/fixtures/trusted-plugin')] }) } },
    userDataDir: scratch, getSettings: () => settings, getAppSettings: () => settings, getContext: () => ({ source: 'fixture' }), getLocale: () => 'zh-TW',
    isMainSender: event => event.sender === win.webContents, persistPluginStates: pluginStates => patch({ pluginStates }), persistManagementSettings: patch,
    applySettingsPatch: patch, env: {}, log: console.log });
  await runtime.start(); runtime.publishStats(stats);
  await win.loadFile(path.join(root, 'src/electron/renderer/index.html'));
  const js = source => win.webContents.executeJavaScript(source);
  await waitFor("state.stats?.periods?.today?.totalTokens === 125000", 'App initialization');
  assert.equal(runtime.manager.backendCount(), 0);
  await pause(150);
  fs.writeFileSync(path.join(evidence, 'app-native.png'), (await win.webContents.capturePage()).toPNG());
  console.log('PASS actual App renderer initialized without plugin work');
  const preview = await js("tokenMonitor.plugins.importPackage('directory')");
  await js(`tokenMonitor.plugins.install(${JSON.stringify(preview.token)})`);
  await js("pluginApi.setEnabled('trusted-fixture',true)");
  await js("pluginApi.place('trusted-fixture/panel','home',true)");
  await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]')", 'Home author UI');
  const pid = await js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','app')");
  assert.equal(pid.value, 'app'); assert.equal(runtime.manager.backendCount(), 1);
  await js("document.querySelector('[aria-label=\"Fixture draft\"]').value='未提交的草稿'");
  await js("render()");
  assert.equal(await js("document.querySelector('[aria-label=\"Fixture draft\"]').value"), '未提交的草稿');
  await js("setPeriod('month');render()");
  await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]').parentElement.dataset.period === 'month'", 'period context');
  assert.equal(await js("document.querySelector('[aria-label=\"Fixture draft\"]').value"), '未提交的草稿');
  const trayPainted = await js("(()=>{const view=pluginViewHost.state('home','trusted-fixture/panel');const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const ok=pluginViewHost.renderTray(view,canvas,{textColor:'#ffffff'});return ok&&canvas.getContext('2d').getImageData(0,0,1,1).data[3]===255})()");
  assert.equal(trayPainted, true);
  await js("setPeriod('today');render()");
  fs.writeFileSync(path.join(evidence, 'app-author-home.png'), (await win.webContents.capturePage()).toPNG());
  await js("openViewFromTray('limits')");
  fs.writeFileSync(path.join(evidence, 'app-native-limits.png'), (await win.webContents.capturePage()).toPNG());
  await js("tokenMonitorTrustedPlugins.selectContent('main.limits.content','trusted-fixture/content').then(applyPluginCatalog)");
  await waitFor("document.querySelector('[data-plugin-target=\"main.limits.content\"] input')", 'native content replacement');
  assert.equal(await js('els.limitsPanel.hidden'), true);
  fs.writeFileSync(path.join(evidence, 'app-author-limits.png'), (await win.webContents.capturePage()).toPNG());
  await js("tokenMonitorTrustedPlugins.selectContent('main.limits.content',null).then(applyPluginCatalog)");
  await waitFor('!els.limitsPanel.hidden', 'native fallback');
  await js("pluginApi.place('trusted-fixture/panel','page',true)");
  await js("pluginApi.openPage('trusted-fixture/panel')");
  await waitFor("document.querySelector('#pluginMainPanel .plugin-main-detach')", 'main plugin page');
  await js("document.querySelector('#pluginMainPanel .plugin-main-detach').click()");
  for (let i = 0; i < 150 && BrowserWindow.getAllWindows().length === 1; i++) await pause(40);
  const detached = BrowserWindow.getAllWindows().find(candidate => candidate !== win);
  assert.ok(detached);
  for (let i=0;i<150;i++) { if (await detached.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"Fixture draft\"]'))")) break; await pause(40); }
  assert.equal(await detached.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"Fixture draft\"]'))"), true);
  const detachedPid = await detached.webContents.executeJavaScript("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','detached')");
  assert.equal(detachedPid.pid, (await js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','shared')")).pid);
  fs.writeFileSync(path.join(evidence, 'app-detached.png'), (await detached.webContents.capturePage()).toPNG());
  detached.destroy();
  console.log('PASS Home mount/draft, local backend, explicit original-page replacement and native restoration');
  assert.deepEqual(errors.filter(text => !text.includes('Electron Security Warning') && !text.includes('Autofill.')), []);
  fs.writeFileSync(path.join(evidence, 'app-results.json'), JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, errors, pid, scope: 'production index.html/app.js/preload + real plugin runtime; synthetic non-plugin IPC, not full main collector' }, null, 2));
  await runtime.dispose(); runtime = null; win.destroy(); clearTimeout(deadline); app.exit(0);
}).catch(error => { console.error(error); runtime?.dispose(); clearTimeout(deadline); app.exit(1); });
