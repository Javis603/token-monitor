'use strict';
// Real secondary renderer/preloads/runtime; synthetic native controller payloads.
const { app, BrowserWindow, ipcMain, session, utilityProcess, protocol } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createPluginRuntime, registerPluginScheme } = require('../src/electron/plugins/runtime');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-surfaces-'));
const evidence = process.env.TM_PLUGIN_EVIDENCE || scratch;
fs.mkdirSync(evidence, { recursive: true });
app.setPath('userData', path.join(scratch, 'profile'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
registerPluginScheme(protocol);
app.on('window-all-closed', () => {});
const windows = new Map(), payloads = new Map(), errors = [];
let runtime;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Surface fixture deadline'); app.exit(1); }, 90000);
async function wait(win, source, label) {
  for (let i = 0; i < 150; i++) { if (await win.webContents.executeJavaScript(source)) return; await pause(40); }
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  let settings = { pluginsEnabled: true, pluginStates: {}, pluginContentSelections: {}, homeModuleOrder: '' };
  const main = new BrowserWindow({ show: true, webPreferences: { preload: path.join(root, 'src/electron/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const surfaceOf = wc => [...windows].find(([, win]) => win.webContents === wc)?.[0];
  runtime = createPluginRuntime({ electron: { BrowserWindow, ipcMain, session, utilityProcess,
    dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(root, 'tests/fixtures/trusted-plugin')] }) } },
    userDataDir: scratch, getSettings: () => settings, getContext: () => ({ source: 'fixture' }), getLocale: () => 'en', env: {},
    isMainSender: event => event.sender === main.webContents,
    isSurfaceSender: (event, surface) => surfaceOf(event.sender) === 'notch' ? surface === 'notch' : Boolean(surfaceOf(event.sender)) && surface === 'edgeDock',
    surfaceContext: event => ({ visible: BrowserWindow.fromWebContents(event.sender)?.isVisible() }),
    persistPluginStates: pluginStates => { settings = { ...settings, pluginStates }; },
    persistManagementSettings: patch => { settings = { ...settings, ...patch }; }, applySettingsPatch: patch => { settings = { ...settings, ...patch }; }, log: console.log });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_event, callback) => callback({ cancel: true }));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [require('../src/electron/contentSecurityPolicy').contentSecurityPolicyForRequest(details)] } }));
  await runtime.start(); await main.loadURL('about:blank');
  const js = text => main.webContents.executeJavaScript(text);
  const preview = await js("tokenMonitor.plugins.importPackage('directory')");
  await js(`tokenMonitor.plugins.install(${JSON.stringify(preview.token)})`);
  await js("tokenMonitor.plugins.setEnabled('trusted-fixture',true)");
  assert.equal(runtime.manager.backendCount(), 0);
  const shape = { key: 'fixture', width: 680, height: 300, d: 'M0 0H680V300H0Z' };
  const stat = { id: 'tokens', kind: 'stat', metric: 'tokens', tokens: 125000, totalTokens: 125000, period: 'today', label: 'Tokens' };
  const appearance = { theme: 'obsidian', locale: 'en', zoomFactor: 1, reduceMotion: 'on', tokenNumberAnimation: 'off' };
  payloads.set('rail', { surface: 'rail', side: 'right', platform: process.platform, appearance, shape, cells: [stat], always: true, reveal: 1 });
  payloads.set('bubble', { surface: 'bubble', side: 'right', platform: process.platform, appearance, shape, cell: stat, maxCardHeight: 400 });
  payloads.set('notch', { surface: 'notch', platform: process.platform, appearance, shape, expanded: true,
    geometry: { notched: false, gapWidth: 0, height: 32, headerX: 0, headerWidth: 680, shoulder: 0, summaryZoom: 1 }, cells: [stat], panel: { builtinPages: ['home'], pluginPages: [] }, summary: { items: [] }, motion: { shape, progress: 1, bodyHeight: 260, headerHeight: 0, summaryHeight: 32, bodyBox: { x: 0, width: 680 } } });
  const push = kind => windows.get(kind)?.webContents.send(kind === 'notch' ? 'topNotch:render' : 'edgeDock:render', payloads.get(kind));
  ipcMain.on('edgeDock:ready', event => push(surfaceOf(event.sender)));
  ipcMain.on('topNotch:ready', () => push('notch'));
  let sizeReports = 0;
  ipcMain.on('edgeDock:bubbleSize', (_event, value) => {
    sizeReports++; if (sizeReports > 100) { console.error('Unbounded size reports'); app.exit(1); return; }
    const payload = payloads.get('bubble'); payload.placed = { cellId: value.cellId, height: value.height }; push('bubble');
  });
  for (const kind of ['rail', 'bubble', 'notch']) {
    const win = new BrowserWindow({ show: true, width: kind === 'rail' ? 120 : 700, height: 420,
      webPreferences: { preload: path.join(root, `src/electron/${kind === 'notch' ? 'notch' : 'edgeDock'}/preload.js`), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.set(kind, win);
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) { errors.push(message); console.log(kind, message); } });
    await win.loadFile(path.join(root, 'src/electron/renderer/edgeDock/index.html'), { query: { surface: kind } });
    await wait(win, 'state.payload !== null', `${kind} native renderer`);
    await pause(100);
    fs.writeFileSync(path.join(evidence, `${kind}-native.png`), (await win.webContents.capturePage()).toPNG());
  }
  assert.equal(runtime.manager.backendCount(), 0);
  for (const [kind, target] of [['rail', 'edgeDock.rail.stat.content'], ['bubble', 'edgeDock.stat.content'], ['notch', 'notch.home.content']]) {
    await js(`tokenMonitorTrustedPlugins.selectContent(${JSON.stringify(target)},'trusted-fixture/content')`);
    const win = windows.get(kind);
    await wait(win, `document.querySelector('[data-plugin-target="${target}"] input')`, `${kind} author content`);
    await pause(100);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-plugin-target="${target}"]').previousElementSibling.hidden`), true);
    fs.writeFileSync(path.join(evidence, `${kind}-author.png`), (await win.webContents.capturePage()).toPNG());
  }
  const pids = [];
  for (const win of windows.values()) pids.push((await win.webContents.executeJavaScript("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','surface')")).pid);
  assert.equal(new Set(pids).size, 1); assert.equal(runtime.manager.backendCount(), 1);
  // Secondary controllers notify refreshSurfaces, not the main-window hook.
  // Assert the synchronous native gate without waiting for renderer visibility IPC.
  for (const kind of ['rail', 'bubble']) { const win = windows.get(kind); win.hide(); runtime.refreshSurfaces(); }
  assert.equal(runtime.manager.backendCount(), 1);
  windows.get('notch').hide(); runtime.refreshSurfaces();
  assert.equal(runtime.manager.backendCount(), 0);
  windows.get('notch').show(); runtime.refreshSurfaces();
  await wait(windows.get('notch'), "document.visibilityState === 'visible'", 'Notch restore');
  await windows.get('notch').webContents.executeJavaScript("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','restored')");
  assert.equal(runtime.manager.backendCount(), 1);
  await js("tokenMonitorTrustedPlugins.selectContent('notch.home.content',null)");
  await wait(windows.get('notch'), "!document.querySelector('[data-plugin-target=\"notch.home.content\"]')", 'Notch native fallback');
  const collapsed = payloads.get('notch'); collapsed.expanded = false;
  collapsed.motion = { ...collapsed.motion, progress: 0, bodyHeight: 0, headerHeight: 32 };
  push('notch');
  await js("tokenMonitorTrustedPlugins.selectContent('notch.summary.content','trusted-fixture/content')");
  await wait(windows.get('notch'), "document.querySelector('[data-plugin-target=\"notch.summary.content\"] input')", 'compact summary extension');
  await js("tokenMonitorTrustedPlugins.selectContent('notch.summary.content',null)");
  await wait(windows.get('notch'), "!document.querySelector('[data-plugin-target=\"notch.summary.content\"]')", 'compact summary restoration');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, 'surface-results.json'), JSON.stringify({ pids, sizeReports, errors, electron: process.versions.electron, scope: 'production secondary renderer/preloads/runtime, synthetic controller payloads; not OS hit-testing acceptance' }, null, 2));
  console.log('PASS rail/bubble/Notch native content replacement, shared process, visibility union and restoration');
  await runtime.dispose(); runtime = null;
  for (const win of windows.values()) win.destroy(); main.destroy(); clearTimeout(deadline); app.exit(0);
}).catch(error => { console.error(error); runtime?.dispose(); clearTimeout(deadline); app.exit(1); });
