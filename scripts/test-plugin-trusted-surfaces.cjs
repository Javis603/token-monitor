'use strict';
// Real secondary renderer/preloads/runtime; synthetic native controller payloads.
const { app, BrowserWindow, ipcMain, session, utilityProcess, protocol, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createPluginRuntime, registerPluginScheme } = require('../src/electron/plugins/runtime');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-surfaces-'));
const evidence = process.env.TM_PLUGIN_EVIDENCE || scratch;
fs.mkdirSync(evidence, { recursive: true });
const authorSource=path.join(scratch,'author-source');fs.cpSync(path.join(root,'tests/fixtures/trusted-plugin'),authorSource,{recursive:true});
const authorManifest=JSON.parse(fs.readFileSync(path.join(authorSource,'manifest.json')));
if (process.env.TM_NAV_ICONS === '1') authorManifest.identityIcon = nativeImage.createFromBitmap(Buffer.from(Array.from({length:16*16},(_,i)=>i%16 < 8 ? [80,180,240,255] : [240,160,70,255]).flat()),{width:16,height:16}).toDataURL();
authorManifest.views.push({id:'bitmap',surfaces:['tray']});fs.writeFileSync(path.join(authorSource,'manifest.json'),JSON.stringify(authorManifest));
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
  console.error('Surface timeout state', await win.webContents.executeJavaScript("({payload:state.payload,views:pluginHost.descriptors(state.payload?.surface==='notch'?'notch':'edgeDock'),content:document.querySelector('.edge-dock-content')?.innerHTML})"));
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  let settings = { pluginsEnabled: true, pluginStates: {}, pluginContentSelections: {}, homeModuleOrder: '' };
  const main = new BrowserWindow({ show: true, webPreferences: { preload: path.join(root, 'src/electron/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const surfaceOf = wc => [...windows].find(([, win]) => win.webContents === wc)?.[0];
  runtime = createPluginRuntime({ electron: { BrowserWindow, ipcMain, session, utilityProcess,
    dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: false, filePaths: [authorSource] }) } },
    userDataDir: scratch, getSettings: () => settings, getContext: () => ({ source: 'fixture' }), getLocale: () => 'en', env: {},
    isMainSender: event => event.sender === main.webContents,
    isSurfaceSender: (event, surface) => surfaceOf(event.sender) === 'notch' ? surface === 'notch' : Boolean(surfaceOf(event.sender)) && surface === 'edgeDock',
    surfaceContext: event => {
      const visible = BrowserWindow.fromWebContents(event.sender)?.isVisible() === true;
      if (surfaceOf(event.sender) !== 'notch') return { visible };
      const payload = payloads.get('notch');
      return { visible: visible && payload?.expanded === true, summaryVisible: visible && Boolean(payload?.summary) };
    },
    persistPluginStates: pluginStates => { settings = { ...settings, pluginStates }; },
    persistManagementSettings: patch => { settings = { ...settings, ...patch }; }, applySettingsPatch: patch => { settings = { ...settings, ...patch }; }, log: console.log });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_event, callback) => callback({ cancel: true }));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [require('../src/electron/contentSecurityPolicy').contentSecurityPolicyForRequest(details)] } }));
  await runtime.start(); await main.loadURL('about:blank');
  const demandEvents = [];
  let notchDemand = [];
  ipcMain.on('topNotch:pluginDemand', (_event, { refs }) => {
    notchDemand = refs;
    demandEvents.push({ refs, visible: windows.get('notch')?.isVisible(), backendCount: runtime.manager.backendCount() });
  });
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
    geometry: { notched: false, gapWidth: 0, height: 32, headerX: 0, headerWidth: 680, shoulder: 0, summaryZoom: 1 }, cells: [stat], panel: { builtinPages: ['home','limits','sessions','breakdown'], pluginPages: [] }, summary: { items: [] }, motion: { shape, progress: 1, bodyHeight: 260, headerHeight: 0, summaryHeight: 32, bodyBox: { x: 0, width: 680 } } });
  const push = kind => windows.get(kind)?.webContents.send(kind === 'notch' ? 'topNotch:render' : 'edgeDock:render', payloads.get(kind));
  ipcMain.on('edgeDock:ready', event => push(surfaceOf(event.sender)));
  ipcMain.on('topNotch:ready', () => push('notch'));
  let sizeReports = 0;
  ipcMain.on('edgeDock:bubbleSize', (_event, value) => {
    sizeReports++; if (sizeReports > 100) { console.error('Unbounded size reports'); app.exit(1); return; }
    const payload = payloads.get('bubble'); payload.placed = { cellId: value.cellId, height: value.height }; push('bubble');
  });
  for (const kind of ['rail', 'bubble', 'notch']) {
    // Match the native controllers: occlusion/lock must not throttle the
    // renderer used to prepare content; runtime gates demand separately.
    const win = new BrowserWindow({ show: true, width: kind === 'rail' ? 120 : 700, height: 420,
      webPreferences: { preload: path.join(root, `src/electron/${kind === 'notch' ? 'notch' : 'edgeDock'}/preload.js`), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    windows.set(kind, win);
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) { errors.push(message); console.log(kind, message); } });
    await win.loadFile(path.join(root, 'src/electron/renderer/edgeDock/index.html'), { query: { surface: kind } });
    await wait(win, 'state.payload !== null', `${kind} native renderer`);
    await pause(100);
    fs.writeFileSync(path.join(evidence, `${kind}-native.png`), (await win.webContents.capturePage()).toPNG());
  }
  assert.equal(runtime.manager.backendCount(), 0);
  if (process.env.TM_NAV_ICONS === '1') {
    await js("tokenMonitor.plugins.place('trusted-fixture/panel','notch',true)");
    const payload = payloads.get('notch');
    payload.panel.pluginPages = ['trusted-fixture/panel'];
    payload.panel.pluginCatalog = Object.fromEntries(runtime.manager.surfaceCatalog('notch').map(view=>[view.ref,{title:view.title,icon:view.icon,identityIcon:view.identityIcon}]));
    push('notch');
    const win=windows.get('notch');
    await wait(win,"document.querySelector('.notch-tab-plugin-icon img')?.naturalWidth > 0",'Notch artwork before opening plugin page');
    assert.equal(await win.webContents.executeJavaScript("Boolean(document.querySelector('.notch-plugin-body input'))"),false);
    assert.equal(runtime.manager.backendCount(),0);
    await pause(200);
    fs.writeFileSync(path.join(evidence,'notch-navigation.png'),(await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors,[]);
    for(const host of BrowserWindow.getAllWindows())host.destroy();
    await runtime.dispose();clearTimeout(deadline);app.exit(0);return;
  }
  for (const [kind, target] of [['rail', 'edgeDock.rail.stat.content'], ['bubble', 'edgeDock.stat.content'], ['notch', 'notch.home.content']]) {
    await js(`tokenMonitorTrustedPlugins.selectContent(${JSON.stringify(target)},'trusted-fixture/content')`);
    const win = windows.get(kind);
    await wait(win, `document.querySelector('[data-plugin-target="${target}"] input')`, `${kind} author content`);
    await pause(100);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-plugin-target="${target}"]').previousElementSibling.hidden`), true);
    fs.writeFileSync(path.join(evidence, `${kind}-author.png`), (await win.webContents.capturePage()).toPNG());
  }
  for (const page of ['limits','sessions','breakdown']) {
    const target = `notch.${page}.content`, win = windows.get('notch');
    await win.webContents.executeJavaScript(`document.querySelector('.notch-tab[data-page="${page}"]').click()`);
    await js(`tokenMonitorTrustedPlugins.selectContent(${JSON.stringify(target)},'trusted-fixture/content')`);
    await wait(win, `document.querySelector('[data-plugin-target="${target}"] input')`, target);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-plugin-target="${target}"]').previousElementSibling.hidden`), true);
    await js(`tokenMonitorTrustedPlugins.selectContent(${JSON.stringify(target)},null)`);
    await wait(win, `!document.querySelector('[data-plugin-target="${target}"]')`, `${target} restoration`);
  }
  await windows.get('notch').webContents.executeJavaScript("document.querySelector('.notch-tab[data-page=home]').click()");
  // Keep the native Home DOM/draft cached, but only the selected page demands work.
  for (const kind of ['rail', 'bubble']) windows.get(kind).hide();
  runtime.refreshSurfaces();
  const pageWindow = windows.get('notch');
  await pageWindow.webContents.executeJavaScript(`globalThis.savedPageInput=document.querySelector('[data-plugin-target="notch.home.content"] input'); savedPageInput.value='Notch draft';`);
  await pageWindow.webContents.executeJavaScript("document.querySelector('.notch-tab[data-page=limits]').click()");
  for (let i=0;i<150 && (notchDemand.length || runtime.manager.backendCount());i++) await pause(40);
  assert.deepEqual(notchDemand, [], 'inactive native page must release foreground demand');
  assert.equal(runtime.manager.backendCount(), 0, 'last visible page gone stops backend');
  await pageWindow.webContents.executeJavaScript("document.querySelector('.notch-tab[data-page=home]').click()");
  for (let i=0;i<150 && !runtime.manager.backendCount();i++) await pause(40);
  assert.equal(runtime.manager.backendCount(), 1, 'cached page return restores demand');
  assert.equal(await pageWindow.webContents.executeJavaScript(`savedPageInput === document.querySelector('[data-plugin-target="notch.home.content"] input') && savedPageInput.value === 'Notch draft'`), true, 'cached return retains draft and node');
  for (const kind of ['rail', 'bubble']) windows.get(kind).show();
  runtime.refreshSurfaces();
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
  console.log('RESTORE before demand settles', JSON.stringify({ notchDemand, backendCount: runtime.manager.backendCount() }));
  // DOM visibility and a one-shot backend call do not establish continuing
  // foreground demand. Wait for the real renderer demand IPC/start transition.
  for (let i = 0; i < 150 && (!notchDemand.includes('trusted-fixture/content') || runtime.manager.backendCount() !== 1); i++) await pause(40);
  assert.ok(notchDemand.includes('trusted-fixture/content'), 'visible Notch publishes foreground demand again');
  assert.equal(runtime.manager.backendCount(), 1);
  console.log('RESTORE demand settled', JSON.stringify(demandEvents));
  await js("tokenMonitorTrustedPlugins.selectContent('notch.home.content',null)");
  await wait(windows.get('notch'), "!document.querySelector('[data-plugin-target=\"notch.home.content\"]')", 'Notch native fallback');
  const collapsed = payloads.get('notch'); collapsed.expanded = false;
  collapsed.motion = { ...collapsed.motion, progress: 0, bodyHeight: 0, headerHeight: 32 };
  collapsed.geometry.summaryBudget=300;
  collapsed.summary={items:[{id:'tokens',type:'text',text:'125K tokens'},{id:'cost',type:'text',text:'$4.25'}]};
  push('notch'); runtime.refreshSurfaces();
  await js("tokenMonitorTrustedPlugins.selectContent('notch.summary.content','trusted-fixture/content')");
  await wait(windows.get('notch'), "document.querySelector('[data-plugin-target=\"notch.summary.content\"] input')", 'compact summary extension');
  for (let i = 0; i < 150 && runtime.manager.backendCount() !== 1; i++) await pause(40);
  assert.equal(runtime.manager.backendCount(), 1, 'collapsed summary alone maintains demand before any explicit call');
  const summaryPid = await windows.get('notch').webContents.executeJavaScript("tokenMonitorTrustedPlugins.call('trusted-fixture','start')");
  await wait(windows.get('notch'), "Number(document.querySelector('[data-plugin-target=\"notch.summary.content\"] output').dataset.update) >= 3", 'collapsed summary receives repeated backend publications');
  const notch=windows.get('notch');
  await notch.webContents.executeJavaScript("tokenMonitorTrustedPlugins.call('trusted-fixture','stop')");await pause(100);
  const captureSummary=async name=>{await notch.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');fs.writeFileSync(path.join(evidence,name),(await notch.webContents.capturePage()).toPNG());};
  await captureSummary('summary-replace.png');
  await notch.webContents.executeJavaScript("const snapshot=pluginHost.descriptors('notch'); snapshot.find(v=>v.ref==='trusted-fixture/content').mode='append';updatePluginViews({surface:'notch',views:Object.fromEntries(snapshot.map(v=>[v.ref,v]))})");
  await pause(100);await captureSummary('summary-append.png');
  const summaryGeometry=await notch.webContents.executeJavaScript(`(()=>{const h=document.querySelector('.notch-summary'),p=h.querySelector(':scope > .plugin-content'),a=h.getBoundingClientRect(),b=p.getBoundingClientRect();return {headerHeight:a.height,pluginBottom:b.bottom-a.top,pluginWidth:b.width,nativeHidden:p.previousElementSibling.hidden};})()`);
  fs.writeFileSync(path.join(evidence,'summary-geometry.json'),JSON.stringify(summaryGeometry));
  assert.ok(summaryGeometry.pluginBottom<=summaryGeometry.headerHeight+0.1,'author summary remains inside the fixed header');
  assert.equal(summaryGeometry.nativeHidden,false);
  collapsed.geometry={...collapsed.geometry,notched:true,gapWidth:180,gapOffset:250};push('notch');await pause(100);
  const cameraGeometry=await notch.webContents.executeJavaScript(`(()=>{const h=document.querySelector('.notch-summary'),p=h.querySelector(':scope > .plugin-content'),a=h.getBoundingClientRect(),b=p.getBoundingClientRect();return {left:b.left-a.left,right:b.right-a.left,bottom:b.bottom-a.top};})()`);
  assert.ok(cameraGeometry.left>=430 && cameraGeometry.right<=680.1 && cameraGeometry.bottom<=32.1,'root append stays outside camera gap');
  await captureSummary('summary-camera.png');
  collapsed.geometry={...collapsed.geometry,notched:false,gapWidth:0};push('notch');
  // Restore the manager's descriptor before testing selection removal.
  await notch.webContents.executeJavaScript("tokenMonitorTrustedPlugins.views('notch').then(updatePluginViews)");await pause(100);
  await js("tokenMonitorTrustedPlugins.selectContent('notch.summary.content',null)");
  await wait(windows.get('notch'), "!document.querySelector('[data-plugin-target=\"notch.summary.content\"]')", 'compact summary restoration');
  for (let i = 0; i < 150 && runtime.manager.backendCount() !== 0; i++) await pause(40);
  assert.equal(runtime.manager.backendCount(), 0, 'removing the last summary demand stops its backend');
  settings={...settings,notchSummaryMode:'custom',notchCustomLayout:{items:[{id:'bitmap',type:'plugin',ref:'trusted-fixture/bitmap'}]}};
  runtime.settingsChanged();
  collapsed.summary=require('../src/electron/notch/data').buildNotchData({},[],settings).summary;
  push('notch');runtime.refreshSurfaces();
  await wait(notch,"document.querySelector('.notch-plugin-bitmap')?.getContext('2d').getImageData(1,1,1,1).data[3]===255",'custom Notch bitmap uses the actual author renderTray');
  await captureSummary('summary-bitmap.png');
  assert.equal(runtime.manager.backendCount(),1);
  notch.hide();runtime.refreshSurfaces();
  for(let i=0;i<100&&runtime.manager.backendCount();i++)await pause(20);
  assert.equal(runtime.manager.backendCount(),0,'hidden bitmap summary releases final demand');
  const reloads=[];
  for(const [surface,win] of windows)win.webContents.on('did-finish-load',()=>reloads.push(surface));
  await js("tokenMonitor.plugins.setEnabled('trusted-fixture',false)");
  assert.equal(runtime.manager.backendCount(),0);
  for(const win of windows.values())assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('[aria-label=\"Fixture draft\"]').length"),0);
  assert.deepEqual(reloads,[]);
  await js("tokenMonitor.plugins.setEnabled('trusted-fixture',true)");
  notch.show();runtime.refreshSurfaces();push('notch');
  await wait(notch,"document.querySelector('.notch-plugin-bitmap')?.getContext('2d').getImageData(1,1,1,1).data[3]===255",'bitmap module reactivates after cooperative disable');
  assert.deepEqual(reloads,[]);
  notch.hide();runtime.refreshSurfaces();
  for(let i=0;i<100&&runtime.manager.backendCount();i++)await pause(20);
  assert.equal(runtime.manager.backendCount(),0);
  console.log('PASS Notch/Dock module cleanup and reactivation without renderer reload');
  assert.deepEqual(errors.filter(text => !text.startsWith('Canvas2D: Multiple readback operations')), []);
  fs.writeFileSync(path.join(evidence, 'surface-results.json'), JSON.stringify({ pids, summaryPid, summaryPublications: 3, finalBackendCount: runtime.manager.backendCount(), notchPages: ['home','limits','sessions','breakdown'], sizeReports, errors, electron: process.versions.electron, scope: 'production secondary renderer/preloads/runtime, synthetic controller payloads; not OS hit-testing acceptance' }, null, 2));
  console.log('PASS rail/bubble/Notch native content replacement, shared process, visibility union and restoration');
  await runtime.dispose(); runtime = null;
  for (const win of windows.values()) win.destroy(); main.destroy(); clearTimeout(deadline); app.exit(0);
}).catch(error => { console.error(error); runtime?.dispose(); clearTimeout(deadline); app.exit(1); });
