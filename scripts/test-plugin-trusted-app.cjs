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
const pageKeys = ['home', 'tool', 'device', 'model', 'project', 'session', 'status', 'limits', 'trends'];
const fixtureDir = path.join(scratch, 'author-source');
fs.cpSync(path.join(root, 'tests/fixtures/trusted-plugin'), fixtureDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json')));
manifest.views.find(view => view.id === 'content').targets.push(...pageKeys.map(key => `main.${key}.content`).filter(target => target !== 'main.limits.content'));
manifest.views.push(
  { id: 'section', targets: ['main.model.content'], selector: '.row-head' },
  { id: 'inline', targets: ['main.model.content'], selector: '.row-value' },
  { id: 'navigation', targets: ['main.navigation.content'], selector: '.view-switcher-label' },
  { id: 'navigation-second', targets: ['main.navigation.content'], selector: '.view-switcher-label' }
);
fs.renameSync(path.join(fixtureDir, 'ui.mjs'), path.join(fixtureDir, 'basic.mjs'));
manifest.files.push('basic.mjs');
fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(fixtureDir, 'ui.mjs'), `
import { activate as base } from './basic.mjs';
export function activate(ctx) {
  const basic = base(ctx);
  return { ...basic, mount(container, context) {
    if (['section','inline','navigation','navigation-second'].includes(context.viewId)) {
      const label = document.createElement('span');
      label.textContent = context.viewId === 'inline' ? ' · 作者註解' : context.viewId === 'section' ? '合成資料 · 區段擴展' : '◇';
      container.dataset.audit = context.viewId; container.append(label);
      return { update(next) { container.dataset.anchor = next.native?.className || ''; }, dispose() { container.replaceChildren(); } };
    }
    if (context.viewId === 'content') {
      const title = document.createElement('h2'); title.textContent = '作者自訂用量面板';
      const note = document.createElement('p'); note.textContent = '同一個 App 頁面；原生用量列由宿主建立，作者自行組合。';
      const input = document.createElement('input'); input.setAttribute('aria-label', 'Fixture draft'); input.placeholder = '作者自己的互動欄位';
      container.style.cssText = 'padding:16px;border:1px solid var(--accent);border-radius:12px;display:grid;gap:16px';
      const row = ctx.native.usageRow({ key:'audit', name:'原生用量元件', value:125000, cost:4.25, max:150000 });
      row.dataset.auditNative = 'true'; container.append(title,note,row,input);
      return { update(next) { container.dataset.period = next.period || ''; }, hasUnsavedChanges:()=>Boolean(input.value), dispose(){container.replaceChildren();} };
    }
    return basic.mount(container,context);
  } };
}
`);
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
  console.log('TIMEOUT STATE', await win.webContents.executeJavaScript("({view:state.breakdown, surface:visibleStatsSurface(), settings:isSettingsPanelOpen(), hidden:isRendererWindowHidden(), navigation:els.viewSwitcher.outerHTML, extensions:Array.from(document.querySelectorAll('.plugin-content'),node=>({target:node.dataset.pluginTarget,audit:node.dataset.audit,html:node.innerHTML.slice(0,200)}))})"));
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  let settings = { ...defaults(), language: 'zh-TW', systemGlass: false, reduceMotion: 'on', tokenNumberAnimation: 'off', refreshMs: 3600000 };
  const period = { totalTokens: 125000, costUsd: 4.25, inputTokens: 100000, outputTokens: 25000, cachedInputTokens: 0, sessions: [], models: { 'gpt-5': 100000, 'claude-sonnet': 25000 }, modelCosts: { 'gpt-5': 3.25, 'claude-sonnet': 1 }, clients: { codex: 125000 }, clientCosts: { codex: 4.25 }, devices: [], projects: { fixture: { label: 'Synthetic project', tokens: 125000, costUsd: 4.25, clients: { codex: 125000 } } } };
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
    dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: false, filePaths: [fixtureDir] }) } },
    userDataDir: scratch, getSettings: () => settings, getAppSettings: () => settings, getContext: () => ({ source: 'fixture' }), getLocale: () => 'zh-TW',
    isMainSender: event => event.sender === win.webContents, persistPluginStates: pluginStates => patch({ pluginStates }), persistManagementSettings: patch,
    applySettingsPatch: patch, env: {}, log: console.log });
  await runtime.start(); runtime.publishStats(stats);
  await win.loadFile(path.join(root, 'src/electron/renderer/index.html'));
  const js = source => win.webContents.executeJavaScript(source);
  const capture = async () => { await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); return win.webContents.capturePage(); };
  await waitFor("state.stats?.periods?.today?.totalTokens === 125000", 'App initialization');
  assert.equal(runtime.manager.backendCount(), 0);
  await pause(150);
  fs.writeFileSync(path.join(evidence, 'app-native.png'), (await capture()).toPNG());
  await js("openViewFromTray('model')");
  await waitFor("els.breakdown.querySelector('.row-value')", 'native model rows');
  fs.writeFileSync(path.join(evidence, 'comparison-native.png'), (await capture()).toPNG());
  await js("openViewFromTray('home')");
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
  fs.writeFileSync(path.join(evidence, 'app-author-home.png'), (await capture()).toPNG());
  await js("openViewFromTray('limits')");
  fs.writeFileSync(path.join(evidence, 'app-native-limits.png'), (await capture()).toPNG());
  await js("tokenMonitorTrustedPlugins.selectContent('main.limits.content','trusted-fixture/content').then(applyPluginCatalog)");
  await waitFor("document.querySelector('[data-plugin-target=\"main.limits.content\"] input')", 'native content replacement');
  assert.equal(await js('els.limitsPanel.hidden'), true);
  fs.writeFileSync(path.join(evidence, 'app-author-limits.png'), (await capture()).toPNG());
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
  const coveredPages = [];
  for (const key of pageKeys) {
    await js(`openViewFromTray(${JSON.stringify(key)})`);
    assert.equal(await js('state.breakdown'), key);
    const target = `main.${key}.content`;
    await js(`tokenMonitorTrustedPlugins.selectContent(${JSON.stringify(target)},'trusted-fixture/content').then(applyPluginCatalog)`);
    await waitFor(`document.querySelector('[data-plugin-target="${target}"] [data-audit-native]')`, target);
    assert.equal(await js(`document.querySelector('[data-plugin-target="${target}"] [data-audit-native]').closest('.plugin-content').previousElementSibling.hidden`), true);
    await js(`tokenMonitorTrustedPlugins.selectContent(${JSON.stringify(target)},null).then(applyPluginCatalog)`);
    coveredPages.push(key);
  }
  await js("openViewFromTray('session');openSessionDetail({client:'codex',sessionId:'synthetic-session',title:'Synthetic session'})");
  await js("tokenMonitorTrustedPlugins.selectContent('main.session.content','trusted-fixture/content').then(applyPluginCatalog)");
  await waitFor('els.sessionDetail.hidden', 'session detail replacement');
  assert.equal(await js("document.querySelector('[data-plugin-target=\"main.session.content\"]').previousElementSibling === els.sessionDetail"), true);
  await js("tokenMonitorTrustedPlugins.selectContent('main.session.content',null).then(applyPluginCatalog)");
  assert.equal(await js('els.sessionDetail.hidden'), false);
  await js("openViewFromTray('model')");
  await waitFor("document.querySelector('[data-audit=inline]') && document.querySelector('[data-audit=section]')", 'section and inline anchors');
  const inlineCount = await js("document.querySelectorAll('[data-audit=inline]').length");
  assert.equal(inlineCount, 2);
  await js("state.rowSignature='';render()");
  await waitFor(`document.querySelectorAll('[data-audit=inline]').length === ${inlineCount}`, 'rebuilt native rows');
  await js("tokenMonitorTrustedPlugins.orderContent('main.navigation.content',['trusted-fixture/navigation-second','trusted-fixture/navigation']).then(applyPluginCatalog)");
  await js('renderViewSwitcher()');
  await waitFor("document.querySelectorAll('[data-plugin-target=\"main.navigation.content\"][data-audit]').length === 2", 'navigation-only rerender');
  assert.deepEqual(await js("Array.from(document.querySelectorAll('[data-plugin-target=\"main.navigation.content\"][data-audit]'),node=>node.dataset.audit)"), ['navigation-second','navigation']);
  const { buildTrayMenuTemplate } = require('../src/electron/tray');
  let trayReply;
  const menu = buildTrayMenuTemplate({ state: { pluginMenu: runtime.trayMenu() }, onPluginMenu: (id, action) => { trayReply = runtime.trayAction(id, action); } });
  menu.find(item => item.label?.endsWith('Fixture callback')).click();
  assert.equal((await trayReply).action, 'ping');
  await js("els.settingsButton.click(); if(document.querySelector('[data-settings-section=plugins]').getAttribute('aria-expanded') !== 'true') document.querySelector('[data-settings-section=plugins]').click(); pluginSettingsPanel.refresh()");
  await js("document.querySelector('[data-plugin-id=\"trusted-fixture\"] .plugin-manage').click()");
  await waitFor("document.querySelector('#pluginSettingsList [aria-label=\"Fixture draft\"]')", 'custom author settings');
  await js("document.querySelector('#pluginSettingsList [aria-label=\"Fixture draft\"]').scrollIntoView({block:'center'})");
  assert.equal(await js("document.querySelector('#pluginSettingsList [aria-label=\"Fixture draft\"]').getBoundingClientRect().height > 0"), true);
  fs.writeFileSync(path.join(evidence, 'app-author-settings.png'), (await capture()).toPNG());
  await js("Array.from(document.querySelectorAll('#pluginSettingsList .plugin-content-order')).at(-1).querySelector('.settings-actions button:last-child').click()");
  await waitFor("state.pluginCatalog.contentOrder['main.navigation.content'][0] === 'trusted-fixture/navigation'", 'user ordering button');
  await js("els.settingsPanel.classList.add('hidden');openViewFromTray('model')");
  await js("tokenMonitorTrustedPlugins.selectContent('main.model.content','trusted-fixture/content').then(applyPluginCatalog)");
  await waitFor("document.querySelector('[data-plugin-target=\"main.model.content\"] [data-audit-native]')", 'comparison author');
  fs.writeFileSync(path.join(evidence, 'comparison-author.png'), (await capture()).toPNG());
  const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await js("pluginApi.setEnabled('trusted-fixture',false)");
  await reloaded;
  await waitFor("state.stats?.periods?.today?.totalTokens === 125000 && state.pluginCatalog?.plugins?.[0]?.status === 'disabled'", 'disabled renderer reinitialization');
  await js("openViewFromTray('model')");
  assert.equal(await js("document.querySelectorAll('.plugin-content').length"), 0);
  await waitFor("state.breakdown === 'model' && els.breakdown.querySelectorAll('.row').length === 2", 'disabled native model rows');
  assert.equal(await js('els.breakdown.hidden'), false);
  assert.equal(runtime.manager.backendCount(), 0);
  fs.writeFileSync(path.join(evidence, 'comparison-disabled.png'), (await capture()).toPNG());
  fs.writeFileSync(path.join(evidence, 'coverage-results.json'), JSON.stringify({ coveredPages, sessionDetail:true, sectionRows:inlineCount, navigationOrder:true, trayCallback:true, authorSettings:true, disabledReloadRestored:true },null,2));
  console.log('PASS all native page roots, session detail, section/inline, navigation order, native factory, settings, Tray callback, disable/reload/restoration');
  console.log('PASS Home mount/draft, local backend, explicit original-page replacement and native restoration');
  assert.deepEqual(errors.filter(text => !text.includes('Electron Security Warning') && !text.includes('Autofill.')), []);
  fs.writeFileSync(path.join(evidence, 'app-results.json'), JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, errors, pid, scope: 'production index.html/app.js/preload + real plugin runtime; synthetic non-plugin IPC, not full main collector' }, null, 2));
  clearTimeout(deadline);
  if (process.argv.includes('--demo')) {
    console.log('DEMO ready: isolated synthetic App; enable Platform fixture in Settings > Plugins. Close the window to exit.');
    win.once('closed', () => { void runtime.dispose().finally(() => app.quit()); });
    return;
  }
  await runtime.dispose(); runtime = null; win.destroy(); app.exit(0);
}).catch(error => { console.error(error); runtime?.dispose(); clearTimeout(deadline); app.exit(1); });
