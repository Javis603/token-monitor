'use strict';
// Real secondary renderer/preloads/runtime; synthetic native controller payloads.
const { app, BrowserWindow, ipcMain, session, utilityProcess, protocol } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const root = process.env.TM_PLUGIN_SOURCE_ROOT || path.resolve(__dirname, '..');
const baseline = process.env.TM_EXPECT_BASELINE === '1';
const { createPluginRuntime, registerPluginScheme } = require(path.join(root, 'src/electron/plugins/runtime'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-surfaces-'));
const evidence = process.env.TM_PLUGIN_EVIDENCE || scratch;
fs.mkdirSync(evidence, { recursive: true });
const authorSource=path.join(scratch,'author-source');fs.cpSync(path.join(root,'tests/fixtures/trusted-plugin'),authorSource,{recursive:true});
const authorManifest=JSON.parse(fs.readFileSync(path.join(authorSource,'manifest.json')));
authorManifest.views.push({id:'bitmap',surfaces:['tray']});fs.writeFileSync(path.join(authorSource,'manifest.json'),JSON.stringify(authorManifest));
const uiFile=path.join(authorSource,'ui.mjs');
fs.writeFileSync(uiFile, `export function activate(ctx) { return {
  renderTray(canvas) { const g=canvas.getContext('2d');g.fillStyle='#78c8b4';g.fillRect(0,0,canvas.width,canvas.height);g.fillStyle='#233e36';g.fillRect(canvas.width/3,canvas.height/4,canvas.width/3,canvas.height/2); },
  mount(container) {
    globalThis.probeMounts=(globalThis.probeMounts||0)+1;
    container.style.cssText='display:grid;gap:5px;padding:4px;box-sizing:border-box';
    const label=document.createElement('span');label.textContent='Draft';label.style.fontSize='10px';
    const input=document.createElement('input');input.setAttribute('aria-label','Fixture draft');input.style.cssText='width:74px;min-width:0;font-size:10px';
    container.append(label,input);const off=ctx.backend.subscribe(()=>{});
    return {update(){},dispose(){globalThis.probeDisposes=(globalThis.probeDisposes||0)+1;off();container.replaceChildren();}};
  }
};}`);
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
  console.log('STAGE Electron ready');
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
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [require(path.join(root, 'src/electron/contentSecurityPolicy')).contentSecurityPolicyForRequest(details)] } }));
  await runtime.start(); await main.loadURL('about:blank');console.log('STAGE runtime started');
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
  assert.equal(runtime.manager.backendCount(), 0);console.log('STAGE fixture enabled');
  const shape = { key: 'fixture', width: 680, height: 300, d: 'M0 0H680V300H0Z' };
  const stat = require(path.join(root,'src/electron/renderer/edgeDock/presentation')).buildEdgeDockCells({periods:{today:{totalTokens:125000,costUsd:4.25}}},{items:[{type:'stat',metric:'today'}]})[0];
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
    const win = new BrowserWindow({ show: true, width: kind === 'rail' ? 120 : 700, height: 420,
      webPreferences: { preload: path.join(root, `src/electron/${kind === 'notch' ? 'notch' : 'edgeDock'}/preload.js`), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.set(kind, win);
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) { errors.push(message); console.log(kind, message); } });
    console.log('STAGE loading',kind);
    await win.loadFile(path.join(root, 'src/electron/renderer/edgeDock/index.html'), { query: { surface: kind } });
    await wait(win, 'state.payload !== null', `${kind} native renderer`);
    await pause(100);
    fs.writeFileSync(path.join(evidence, `${kind}-native.png`), (await win.webContents.capturePage()).toPNG());
  }
  assert.equal(runtime.manager.backendCount(), 0);
  const result={scope:'Production runtime/manager/backend plus actual secondary renderer/preloads. Synthetic controller payloads and self-built fixture; no physical Dock/Notch hit-testing.',baseline,sourceRoot:root};
  const rail=windows.get('rail');rail.show();rail.focus();await wait(rail,"document.visibilityState==='visible'",'foreground rail visibility');
  settings.edgeDockItems=[{type:'plugin',ref:'trusted-fixture/panel'}];runtime.settingsChanged();
  const railPayload=payloads.get('rail');railPayload.cells=[stat,{id:'plugin:trusted-fixture/panel',kind:'plugin',ref:'trusted-fixture/panel'}];railPayload.cellLayout={tops:[12,100],heights:[72,90],compact:false};push('rail');
  await wait(rail,"document.querySelector('.edge-dock-plugin-cell input')",'rail plugin input');
  await rail.webContents.executeJavaScript("globalThis.savedInput=document.querySelector('.edge-dock-plugin-cell input');savedInput.value='draft';savedInput.focus();savedInput.setSelectionRange(5,5)");
  const inspect=()=>rail.webContents.executeJavaScript("({sameNode:document.querySelector('.edge-dock-plugin-cell input')===savedInput,focus:document.activeElement===savedInput,value:document.querySelector('.edge-dock-plugin-cell input')?.value,mounts:globalThis.probeMounts,disposes:globalThis.probeDisposes||0})");
  result.railBefore=await inspect();
  await rail.webContents.executeJavaScript("tokenMonitorTrustedPlugins.views('edgeDock').then(updatePluginViews)");await pause(100);
  result.descriptorOnlyControl=await inspect();
  await rail.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');fs.writeFileSync(path.join(evidence,'rail-before.png'),(await rail.webContents.capturePage()).toPNG());
  result.railRefreshes=[];
  for(let i=0;i<3;i++) { railPayload.cells[0]={...stat,totalTokens:125001+i,tokens:125001+i};push('rail');await pause(150);await wait(rail,"document.querySelector('.edge-dock-plugin-cell input')",'refreshed rail input');result.railRefreshes.push(await inspect()); }
  await rail.webContents.insertText('X');result.railAfterTyping=await inspect();
  await rail.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  fs.writeFileSync(path.join(evidence,'rail-after.png'),(await rail.webContents.capturePage()).toPNG());
  assert.equal(result.descriptorOnlyControl.sameNode,true);assert.equal(result.descriptorOnlyControl.focus,true);for (const refresh of result.railRefreshes) { assert.equal(refresh.sameNode,!baseline);assert.equal(refresh.focus,!baseline);assert.equal(refresh.value,baseline?'':'draft'); }
  assert.equal(result.railAfterTyping.value,baseline?'':'draftX');
  if (!baseline) { assert.equal(result.railAfterTyping.mounts,1);assert.equal(result.railAfterTyping.disposes,0); }
  if (!baseline) {
    const next = structuredClone(runtime.payload('edgeDock'));
    next.views['trusted-fixture/panel'].revision += '-fixture-revision';
    rail.webContents.send('plugins:views',next);
    await wait(rail,'globalThis.probeMounts===2 && globalThis.probeDisposes===1','revision replaces author instance');
    result.revision=await inspect();assert.equal(result.revision.sameNode,false);
  }
  railPayload.cells=[stat];push('rail');await wait(rail,"!document.querySelector('.edge-dock-plugin-cell')",'removed rail mount');await pause(100);
  result.removed=await rail.webContents.executeJavaScript('({mounts:globalThis.probeMounts,disposes:globalThis.probeDisposes})');assert.equal(result.removed.mounts,result.removed.disposes);rail.hide();windows.get('bubble').hide();runtime.refreshSurfaces();
  for(let i=0;i<100&&runtime.manager.backendCount();i++)await pause(20);assert.equal(runtime.manager.backendCount(),0);
  const notch=windows.get('notch'),np=payloads.get('notch');notch.show();notch.focus();await wait(notch,"document.visibilityState==='visible'",'foreground Notch visibility');
  const bitmapLayout={version:1,items:[{id:'bitmap',type:'plugin',ref:'trusted-fixture/bitmap'}]};
  Object.assign(settings,{showTrayIcon:false,trayContent:'custom',trayCustomLayout:bitmapLayout,notchSummaryMode:'tray'});runtime.settingsChanged();
  np.expanded=false;np.motion={...np.motion,progress:0,bodyHeight:0,headerHeight:32};np.geometry.summaryBudget=300;
  const build=require(root+'/src/electron/notch/data').buildNotchData;
  np.summary=build({},[],settings).summary;push('notch');runtime.refreshSurfaces();
  await wait(notch,"document.querySelector('.notch-plugin-bitmap')",'mirror bitmap canvas');await pause(200);
  if (!baseline) await wait(notch,"document.querySelector('.notch-plugin-bitmap')?.getContext('2d').getImageData(1,1,1,1).data[3]===255",'mirror bitmap image');
  result.mirror={layoutRefs:np.summary.items.filter(i=>i.type==='plugin').map(i=>i.ref),payloadRefs:Object.keys(runtime.payload('notch').views),requested:notchDemand,backendCount:runtime.manager.backendCount(),pixelAlpha:await notch.webContents.executeJavaScript("document.querySelector('.notch-plugin-bitmap').getContext('2d').getImageData(1,1,1,1).data[3]")};
  fs.writeFileSync(path.join(evidence,'mirror-tray.png'),(await notch.webContents.capturePage({x:0,y:0,width:700,height:60})).toPNG());
  np.summary=null;push('notch');for(let i=0;i<100&&notchDemand.length;i++)await pause(20);assert.deepEqual(notchDemand,[]);
  Object.assign(settings,{notchSummaryMode:'custom',notchCustomLayout:bitmapLayout});runtime.settingsChanged();np.summary=build({},[],settings).summary;push('notch');runtime.refreshSurfaces();
  await wait(notch,"document.querySelector('.notch-plugin-bitmap')?.getContext('2d').getImageData(1,1,1,1).data[3]===255",'custom bitmap positive control');
  for(let i=0;i<100&&!runtime.manager.backendCount();i++)await pause(20);
  result.customControl={payloadRefs:Object.keys(runtime.payload('notch').views),backendCount:runtime.manager.backendCount(),pixelAlpha:255};
  assert.equal(result.mirror.backendCount,baseline?0:1);assert.equal(result.mirror.pixelAlpha,baseline?0:255);assert.equal(result.mirror.payloadRefs.includes('trusted-fixture/bitmap'),!baseline);assert.equal(result.customControl.backendCount,1);
  notch.hide();runtime.refreshSurfaces();for(let i=0;i<100&&runtime.manager.backendCount();i++)await pause(20);assert.equal(runtime.manager.backendCount(),0);result.finalBackendCount=runtime.manager.backendCount();
  result.errors=errors;result.versions={electron:process.versions.electron,chrome:process.versions.chrome};
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  await runtime.dispose();runtime=null;for(const win of windows.values())win.destroy();main.destroy();clearTimeout(deadline);app.exit(0);
}).catch(error=>{console.error(error);runtime?.dispose();clearTimeout(deadline);app.exit(1)});
