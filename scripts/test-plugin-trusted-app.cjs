'use strict';
// Actual App HTML, renderer, preload and plugin runtime. Host collection/account
// IPC uses synthetic records; no personal profile, collector or credentials load.
const { app, BrowserWindow, ipcMain, session, utilityProcess, protocol, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createPluginRuntime, registerPluginScheme } = require('../src/electron/plugins/runtime');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-app-'));
const evidence = process.env.TM_PLUGIN_EVIDENCE || scratch;
if (process.env.TM_WINDOW_FOCUS_ONLY === '1') app.setPath('userData', scratch);
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
if (process.env.TM_DEFAULT_PLACEMENTS === '1') manifest.views.find(view => view.id === 'panel').defaultSurfaces = ['page','notch'];
fs.renameSync(path.join(fixtureDir, 'ui.mjs'), path.join(fixtureDir, 'basic.mjs'));
manifest.files.push('basic.mjs');
manifest.files.push('fixture.png');
const pixels = Buffer.alloc(160 * 60 * 4);
for (let y=0;y<60;y++) for (let x=0;x<160;x++) {
  const bar = x % 32 < 20 && y > 50 - (Math.floor(x/32)+1)*8;
  const offset=(y*160+x)*4; pixels[offset]=bar?180:32; pixels[offset+1]=bar?190:32; pixels[offset+2]=bar?100:32; pixels[offset+3]=255;
}
fs.writeFileSync(path.join(fixtureDir,'fixture.png'),nativeImage.createFromBitmap(pixels,{width:160,height:60}).toPNG());
if (process.env.TM_NAV_ICONS === '1') {
  manifest.identityIcon = nativeImage.createFromBitmap(pixels,{width:160,height:60}).toDataURL();
  manifest.views = [{ id: 'panel', title: 'Fixture', surfaces: ['page'] }];
  if (process.env.TM_NAV_HEIGHT === '1') for (let i=1;i<=3;i++) manifest.views.push({id:`extra-${i}`,title:`Plugin page ${i}`,surfaces:['page']});
}
fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(fixtureDir, 'ui.mjs'), `
import { activate as base } from './basic.mjs';
export function activate(ctx) {
  const basic = base(ctx);
  ctx.onDispose(() => { if (globalThis.fixtureCleanupFailure) throw Error('Intentional fixture cleanup failure'); });
  return { ...basic, mount(container, context) {
    globalThis.fixtureMountCount = (globalThis.fixtureMountCount || 0) + 1;
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
      return { update(next) {
        if (globalThis.fixtureUpdateFailure) { globalThis.fixtureUpdateFailure = false; throw Error('Intentional fixture update failure'); }
        container.dataset.period = next.period || '';
      }, hasUnsavedChanges:()=>Boolean(input.value), dispose(){container.replaceChildren();} };
    }
    if (context.surface === 'page' && globalThis.fixtureDeferredMount) {
      const title=document.createElement('p');title.textContent='非同步重繪測試';
      const input=document.createElement('input');input.setAttribute('aria-label','Fixture draft');
      container.append(title,input);
      return { update() {
        if (!globalThis.fixtureDeferUpdate) return;
        globalThis.fixtureDeferUpdate=false;
        return new Promise(resolve=>{globalThis.fixtureFinishUpdate=()=>{
          const late=document.createElement('input');late.setAttribute('aria-label','Late redraw');late.value='停用後不應留下的控制項';container.append(late);resolve();
        };});
      }, dispose(){title.remove();input.remove();globalThis.fixtureDeferredDisposed=true;} };
    }
    const mounted=basic.mount(container,context);
    const image=document.createElement('img');image.src=ctx.asset('fixture.png');image.alt='套件內的用量圖';image.dataset.fixtureAsset='true';image.style.cssText='width:320px;max-width:100%;image-rendering:pixelated';
    const background=document.createElement('div');background.dataset.fixtureBackground='true';background.style.cssText='width:160px;height:60px;background-size:contain';background.style.backgroundImage='url("'+ctx.asset('fixture.png')+'")';
    container.append(image,background);return mounted;
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
function assertConsoleClean(expected = []) {
  const unexpected = errors.filter(text => !text.includes('Electron Security Warning') && !text.includes('Autofill.') && !expected.some(value => text.includes(value)));
  assert.deepEqual(unexpected, [], 'unexpected renderer console errors');
}
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
    'settings:displayPreview': (_event, surface, phase, slots) => require('../src/electron/displayPreview').buildDisplayPreview(settings, surface, phase, process.platform, Date.now(), slots),
    'settings:update': async (event, patch) => { const after = await runtime.beforeSettingsChange(event, patch); settings = { ...settings, ...patch }; runtime.settingsChanged(); await after(); return settings; },
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
  const pluginCalls = [];
  const pluginIpc = Object.create(ipcMain);
  pluginIpc.handle = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    pluginCalls.push({ channel, frameUrl: event.senderFrame?.url });
    return handler(event, ...args);
  });
  const demandListener = (event, { surface, refs }) => pluginCalls.push({ channel: 'plugins:demand', frameUrl: event.senderFrame?.url, surface, refs });
  ipcMain.on('plugins:demand', demandListener);
  const toggleDialogs = [], toggleResponses = []; let toggleResponse = 1, selectedDirectory = fixtureDir;
  runtime = createPluginRuntime({ electron: { BrowserWindow, ipcMain: pluginIpc, session, utilityProcess,
    dialog: { showMessageBox: async (_owner, options) => { toggleDialogs.push(options); return { response: toggleResponses.length ? toggleResponses.shift() : toggleResponse }; }, showOpenDialog: async () => ({ canceled: false, filePaths: [selectedDirectory] }) } },
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
  if (process.env.TM_PREVIEWS_ONLY === '1') {
    const baseline = process.env.TM_EXPECT_BASELINE === '1';
    const results = [];
    await js(`window.previewMessages=[];window.addEventListener('message',event=>{
      if(event.data?.type?.startsWith('display-preview-'))window.previewMessages.push({type:event.data.type,url:event.source.location.href});
    });els.settingsButton.click();document.querySelector('[data-settings-section=window]').click()`);
    await pause(500);
    for (const surface of ['edgeDock','notch']) {
      const entry = surface === 'edgeDock' ? '.display-settings-row:first-child .display-settings-open' : '#display-tab-notch';
      await js(`document.querySelector('${entry}').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('${entry}').click()`);
      const stage = `#display-page-${surface} .display-settings-preview`;
      await waitFor(`document.querySelector('${stage} iframe')`, `${surface} iframe creation`);
      if (baseline) await pause(3400);
      else await waitFor(`document.querySelector('${stage} iframe')?.dataset.ready==='true' && !document.querySelector('${stage} iframe').hidden`, `${surface} ready/render`);
      await pause(500);
      await js(`document.querySelector('#display-page-${surface} .display-settings-title').scrollIntoView({block:'start',behavior:'instant'})`);
      await pause(200);
      fs.writeFileSync(path.join(evidence, `${surface}-preview.png`), (await capture()).toPNG());
      if (baseline) {
        assert.equal(await js(`document.querySelector('${stage} iframe')?.dataset.ready==='true'`), false);
        results.push({surface,ready:false,errors:[...errors]});
        continue;
      }
      const frame = win.webContents.mainFrame.frames.find(frame => frame.url.includes(`surface=${surface === 'notch' ? 'notch' : 'rail'}&settingsPreview=1`));
      assert.ok(frame, `${surface} real child frame`);
      const read = () => frame.executeJavaScript(`({trusted:typeof window.tokenMonitorTrustedPlugins,node:typeof require,preview:bridge.isSettingsPreview,host:pluginHost===null,content:pluginContent===null,payload:state.payload,shapes:document.querySelectorAll('.edge-dock-shape path').length,text:document.getElementById('edgeDockRoot').textContent})`);
      const first = await read();
      assert.equal(first.trusted,'undefined');assert.equal(first.node,'undefined');assert.equal(first.preview,true);
      assert.equal(first.host,true);assert.equal(first.content,true);assert.ok(first.payload);assert.ok(first.shapes>0);assert.ok(first.text.trim());
      const firstZoom = surface === 'notch' ? first.payload.appearance.zoomFactor : first.payload.side;
      if (surface === 'notch') {
        await js("document.querySelector('#display-notch-appearance-tab').click();document.querySelector('input[name=notchSize][value=large]').click()");
      } else {
        await js("document.querySelector('#display-edgeDock-appearance-tab').click();document.querySelector('input[name=edgeDockSide][value=left]').click()");
      }
      let updated;
      for(let i=0;i<100;i++) {
        updated=await read();
        if((surface==='notch'?updated.payload.appearance.zoomFactor:updated.payload.side)!==firstZoom)break;
        await pause(40);
      }
      assert.notEqual(surface==='notch'?updated.payload.appearance.zoomFactor:updated.payload.side,firstZoom, `${surface} settings reaches existing renderer`);
      if(surface==='notch') {
        await js("document.querySelector('#display-page-notch [data-phase=closed]').click()");
        for(let i=0;i<100&&(await read()).payload.expanded;i++)await pause(40);
        assert.equal((await read()).payload.expanded,false);
        await js("document.querySelector('#display-page-notch [data-phase=open]').click()");
        for(let i=0;i<100&&!(await read()).payload.expanded;i++)await pause(40);
        assert.equal((await read()).payload.expanded,true);
      }
      results.push({surface,ready:true,noTrustedBridge:true,noNode:true,pluginHost:false,nativeShapes:first.shapes,settingsUpdated:true});
    }
    const messages=await js('window.previewMessages');
    const previewCalls=pluginCalls.filter(call=>call.frameUrl?.includes('settingsPreview=1'));
    assert.deepEqual(previewCalls,[]);assert.equal(runtime.manager.backendCount(),0);
    assert.ok(pluginCalls.some(call=>!call.frameUrl?.includes('settingsPreview=1')), 'runtime observation includes parent calls');
    if(baseline) {assert.ok(errors.some(text=>text.includes('contentSelections')));assert.equal(messages.filter(message=>message.type==='display-preview-ready').length,0);}
    else {assertConsoleClean();assert.equal(messages.filter(message=>message.type==='display-preview-ready').length,2);}
    fs.writeFileSync(path.join(evidence,'preview-results.json'),JSON.stringify({baseline,results,messages,previewCalls,backendCount:runtime.manager.backendCount(),errors,electron:process.versions.electron,chrome:process.versions.chrome},null,2));
    console.log('PASS actual no-preload preview iframe checks',JSON.stringify(results));
    ipcMain.removeListener('plugins:demand',demandListener);
    await runtime.dispose();runtime=null;win.destroy();clearTimeout(deadline);app.exit(0);return;
  }
  const preview = await js("tokenMonitor.plugins.importPackage('directory')");
  if (process.env.TM_DEFAULT_PLACEMENTS === '1') {
    await js(`tokenMonitor.plugins.cancelInstall(${JSON.stringify(preview.token)})`);
    selectedDirectory = path.join(scratch,'initial-locations.tmplugin');
    fs.writeFileSync(selectedDirectory,require('../src/electron/plugins/package').packageDirectory(fixtureDir).bytes);
    await js("openSettingsPanel();for(const section of SETTINGS_SECTION_IDS)setSettingsSectionExpanded(section,section==='plugins');pluginSettingsPanel.refresh()");
    await waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent===t('plugins.package.import'))", 'import action');
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent===t('plugins.package.import')).click()");
    await waitFor("document.querySelector('.plugin-package-preview .plugin-allow')", 'placement consent');
    await js("document.querySelector('.plugin-package-preview').scrollIntoView({block:'start',behavior:'instant'})");
    await pause(200);
    fs.writeFileSync(path.join(evidence,'initial-locations-consent.png'),(await capture()).toPNG());
    if (process.env.TM_EXPECT_BASELINE === '1') {
      assert.equal(await js("!!document.querySelector('.plugin-default-placements')"),false);
    } else {
      assert.equal(await js("document.querySelector('.plugin-default-placements input[data-surface=page]').checked"),true);
      assert.equal(await js("document.querySelector('.plugin-default-placements input[data-surface=notch]').checked"),true);
      assert.equal(await js("document.querySelector('.plugin-default-placements input[data-surface=edgeDock]').checked"),false);
      await js("document.querySelector('.plugin-default-placements input[data-surface=notch]').click()");
      await js("document.querySelector('.plugin-package-preview .plugin-allow').click()");
      await waitFor("state.pluginCatalog?.plugins?.[0]?.status==='active'",'installed with choices');
      assert.deepEqual(settings.pluginMainPages,['trusted-fixture/panel']);
      assert.deepEqual(settings.notchPluginPages,[]);
      assert.equal(settings.notchEnabled,false);assert.equal(settings.edgeDockEnabled,false);
      const ready=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
      win.webContents.reload();await ready;
      await waitFor("state.pluginCatalog?.plugins?.[0]?.status==='active'",'restart restores choices');
      await js("openViewFromTray('plugin:trusted-fixture/panel')");
      await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]')",'default page author UI');
      fs.writeFileSync(path.join(evidence,'initial-locations-installed.png'),(await capture()).toPNG());
      assert.equal(settings.pluginPlacementDefaults['trusted-fixture'].applied,true);
    }
    assertConsoleClean();console.log('PASS actual renderer initial placement consent and selected page after reload');
    await runtime.dispose();runtime=null;win.destroy();clearTimeout(deadline);app.exit(0);return;
  }
  await js(`tokenMonitor.plugins.install(${JSON.stringify(preview.token)})`);
  if (process.env.TM_WINDOW_FOCUS_ONLY === '1') {
    await js("pluginApi.setEnabled('trusted-fixture',true)");
    await js("pluginApi.place('trusted-fixture/panel','page',true).then(applyPluginCatalog)");
    await js("openViewFromTray('plugin:trusted-fixture/panel')");
    await waitFor("document.querySelector('.plugin-header-actions') && document.querySelector('[aria-label=\"Fixture draft\"]')", 'focus fixture page');
    // Synthetic author action in the production header slot, with an observable
    // Enter action. The real App renderer/preload and native window stay in use.
    await js(`globalThis.focusClicks=0;globalThis.focusButton=document.createElement('button');
      focusButton.textContent='Privacy';focusButton.className='plugin-main-detach';
      focusButton.onclick=()=>focusClicks++;document.querySelector('.plugin-header-actions').append(focusButton)`);
    const source = fs.readFileSync(process.env.TM_FOCUS_MAIN_SOURCE || path.join(root,'src/electron/main.js'),'utf8');
    const handler = source.slice(source.indexOf('function handleWindowToggleShortcut('),source.indexOf('function handleTrayToggle('));
    const context = vm.createContext({ mainWindow:win,settings:{trayMode:false},floatingBubbleState:{collapsed:false},
      windowToggleShortcutAction:require('../src/electron/windowShortcut').windowToggleShortcutAction,
      pluginWindowActions:{hide:target=>target.hide()},focusExistingWindow:()=>win.show(),
      sendMainWindowEvent:channel=>win.webContents.send(channel) });
    vm.runInContext(handler,context);
    const reopen = async () => {
      context.handleWindowToggleShortcut(); await pause(60);
      context.handleWindowToggleShortcut(); win.focus(); await pause(120); await capture();
    };
    const baseline = Boolean(process.env.TM_FOCUS_MAIN_SOURCE);
    await js('focusButton.focus()'); await reopen();
    const parked = await js('document.activeElement===els.shell');
    assert.equal(parked,!baseline,'shortcut parks accidental header focus');
    if (baseline) {
      assert.equal(await js('document.activeElement===focusButton'),true);
      fs.writeFileSync(path.join(evidence,'focus-baseline.png'),(await capture()).toPNG());
    } else {
      fs.writeFileSync(path.join(evidence,'focus-plugin-neutral.png'),(await capture()).toPNG());
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
      win.webContents.sendInputEvent({type:'char',keyCode:'Return'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      await pause(50);assert.equal(await js('focusClicks'),0,'summoning must not arm the privacy action');
      // Tab is delivered through Chromium, not dispatched as a synthetic DOM event.
      app.focus({steal:true});win.show();win.focus();win.webContents.focus();await pause(100);
      await js('focusButton.focus()');
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});
      await pause(60);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
      await pause(80);
      assert.equal(await js('document.activeElement===focusButton'),true,'Tab reaches the author action');
      assert.equal(await js("focusButton.matches(':focus-visible')"),true);
      fs.writeFileSync(path.join(evidence,'focus-plugin-keyboard.png'),(await capture()).toPNG());
      await reopen();await waitFor('document.activeElement===focusButton','restored keyboard focus');
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
      win.webContents.sendInputEvent({type:'char',keyCode:'Return'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      await pause(50);assert.equal(await js('focusClicks'),1);
      await js("document.querySelector('[aria-label=\"Fixture draft\"]').focus()");
      await win.webContents.insertText('Unsubmitted draft'); await reopen();
      assert.equal(await js("document.activeElement.getAttribute('aria-label')"),'Fixture draft');
      assert.equal(await js('document.activeElement.value'),'Unsubmitted draft');
      await js("openViewFromTray('model');document.querySelector('.tab').focus()");
      await reopen();assert.equal(await js('document.activeElement===els.shell'),true,'native header uses the same policy');
      fs.writeFileSync(path.join(evidence,'focus-native.png'),(await capture()).toPNG());
    }
    fs.writeFileSync(path.join(evidence,'window-focus-results.json'),JSON.stringify({baseline,parked,electron:process.versions.electron,
      scope:'production renderer/preload/plugin runtime and main shortcut callback; native hide/show and Chromium Tab/Enter; OS global shortcut registration not driven'},null,2));
    assertConsoleClean();console.log(baseline?'PASS baseline reproduces retained header focus':'PASS shortcut focus, keyboard navigation/Enter, native parity and retained draft');
    await runtime.dispose();runtime=null;win.destroy();clearTimeout(deadline);app.exit(0);return;
  }
  if (process.env.TM_PACKAGE_RECOVERY_ONLY === '1') {
    let loads = 0; win.webContents.on('did-finish-load', () => loads++);
    await js("pluginApi.setEnabled('trusted-fixture',true)");
    await js("pluginApi.place('trusted-fixture/panel','page',true).then(applyPluginCatalog)");
    await js("openViewFromTray('plugin:trusted-fixture/panel')");
    await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]')", 'plugin mounted before failed cleanup');
    const installedManifest = path.join(scratch, 'plugins/trusted-fixture/manifest.json');
    const original = fs.readFileSync(installedManifest, 'utf8');
    fs.writeFileSync(path.join(evidence,'recovery-original.png'), (await capture()).toPNG());
    // Decline the package operation AND defer recovery: no reload without consent.
    toggleResponse = 0;
    await js("globalThis.fixtureCleanupFailure=true");
    const cancellation = await js("pluginApi.uninstall('trusted-fixture').then(()=>'unexpected success',error=>String(error.message||error))");
    assert.match(cancellation, /cancelled/);
    assert.equal(toggleDialogs.length, 2);
    assert.equal(loads, 0);
    assert.equal(runtime.manager.active('trusted-fixture'), true);
    assert.equal(fs.readFileSync(installedManifest, 'utf8'), original);
    assert.equal(await js("!!document.querySelector('[aria-label=\"Fixture draft\"]')"), false);
    fs.writeFileSync(path.join(evidence,'recovery-deferred.png'), (await capture()).toPNG());
    // Start a fresh renderer, then repeat and accept the immediate recovery offer.
    let ready = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload(); await ready;
    await waitFor("state.pluginCatalog?.plugins?.[0]?.status==='active'", 'fresh renderer ready');
    await js("openViewFromTray('plugin:trusted-fixture/panel')");
    await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]')", 'plugin restored for second probe');
    const beforeLoads = loads;
    toggleResponses.push(0, 1);
    ready = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await js("globalThis.fixtureCleanupFailure=true; void pluginApi.uninstall('trusted-fixture').catch(()=>{})");
    await ready;
    await waitFor("state.pluginCatalog?.plugins?.[0]?.status==='active' && !globalThis.fixtureCleanupFailure", 'accepted recovery renderer');
    await js("openViewFromTray('plugin:trusted-fixture/panel')");
    await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]')", 'author UI remounts after cancelled operation');
    assert.equal(loads, beforeLoads + 1);
    assert.equal(runtime.manager.active('trusted-fixture'), true);
    assert.equal(fs.readFileSync(installedManifest, 'utf8'), original);
    await js("document.querySelector('[aria-label=\"Fixture draft\"]').focus()");
    await win.webContents.insertText('Recovered input');
    assert.equal(await js("document.querySelector('[aria-label=\"Fixture draft\"]').value"), 'Recovered input');
    fs.writeFileSync(path.join(evidence,'recovery-restored.png'), (await capture()).toPNG());
    fs.writeFileSync(path.join(evidence,'recovery-results.json'), JSON.stringify({ loads, dialogs:toggleDialogs, cancellation, errors, electron:process.versions.electron },null,2));
    assertConsoleClean(['Intentional fixture cleanup failure']);
    console.log('PASS cancelled package keeps original enabled package, explicit recovery restores real renderer input; Later does not reload');
    await runtime.dispose(); runtime=null; win.destroy(); clearTimeout(deadline); app.exit(0); return;
  }
  if (process.env.TM_PACKAGE_LIFECYCLE_ONLY === '1') {
    let loads = 0; win.webContents.on('did-finish-load', () => loads++);
    await js("pluginApi.setEnabled('trusted-fixture',true)");
    await js("pluginApi.place('trusted-fixture/panel','page',true).then(applyPluginCatalog)");
    await js("openViewFromTray('plugin:trusted-fixture/panel')");
    await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]')", 'original plugin page');
    const oldPid = (await js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','before')")).pid;
    fs.writeFileSync(path.join(evidence,'package-before.png'), (await capture()).toPNG());
    manifest.version = '9.0.0'; fs.writeFileSync(path.join(fixtureDir,'manifest.json'), JSON.stringify(manifest));
    fs.appendFileSync(path.join(fixtureDir,'ui.mjs'), "\nglobalThis.packageRevisionLoaded = '9.0.0';\n");
    selectedDirectory = path.join(scratch,'update.tmplugin'); require('./build-plugin-package').main([fixtureDir,selectedDirectory]);
    await js("openSettingsPanel();for(const section of SETTINGS_SECTION_IDS)setSettingsSectionExpanded(section,section==='plugins');pluginSettingsPanel.refresh()");
    await waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent===t('plugins.package.import'))", 'import action');
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent===t('plugins.package.import')).click()");
    await waitFor("document.querySelector('.plugin-package-preview .plugin-allow')", 'update consent');
    assert.equal(await js("document.querySelector('.plugin-package-preview .plugin-allow').textContent"), '信任並更新');
    await pause(600);
    await js("document.querySelector('.plugin-package-preview').scrollIntoView({block:'center',behavior:'instant'})");
    await pause(300);
    fs.writeFileSync(path.join(evidence,'package-consent.png'), (await capture()).toPNG());
    await js("document.querySelector('.plugin-package-preview .plugin-allow').click()");
    await waitFor("globalThis.packageRevisionLoaded==='9.0.0' && state.pluginCatalog.plugins[0].status==='active'", 'new revision running');
    assert.equal(await js('state.breakdown'), 'plugin:trusted-fixture/panel');
    await js("els.settingsPanel.classList.add('hidden');openViewFromTray('plugin:trusted-fixture/panel')");
    await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]')", 'updated page');
    const newPid = (await js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','after')")).pid;
    assert.notEqual(oldPid,newPid); assert.equal(loads,0); assert.equal(toggleDialogs.length,0);
    fs.writeFileSync(path.join(evidence,'package-updated.png'), (await capture()).toPNG());
    await js("pluginApi.uninstall('trusted-fixture',{keepData:true,keepPlacements:false})");
    await waitFor("!document.querySelector('[aria-label=\"Fixture draft\"]')", 'removed controls');
    assert.equal(runtime.manager.backendCount(),0); assert.equal(loads,0); assert.equal(toggleDialogs.length,0);
    fs.writeFileSync(path.join(evidence,'package-removed.png'), (await capture()).toPNG());
    await js("openSettingsPanel();for(const section of SETTINGS_SECTION_IDS)setSettingsSectionExpanded(section,section==='plugins');pluginSettingsPanel.refresh()");
    await waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent===t('plugins.package.import'))", 'fresh import');
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent===t('plugins.package.import')).click()");
    await waitFor("document.querySelector('.plugin-package-preview .plugin-allow')", 'fresh consent');
    assert.equal(await js("document.querySelector('.plugin-package-preview .plugin-allow').textContent"), '信任並安裝啟用');
    assert.equal(await js("[...document.querySelectorAll('.plugin-package-preview button')].some(b=>b.textContent==='只安裝')"), true);
    await pause(600);
    await js("document.querySelector('.plugin-package-preview').scrollIntoView({block:'center',behavior:'instant'})");
    await pause(300);
    fs.writeFileSync(path.join(evidence,'install-consent.png'), (await capture()).toPNG());
    await js("document.querySelector('[data-settings-section=plugins]').scrollIntoView({block:'start',behavior:'instant'})");
    await pause(300);
    fs.writeFileSync(path.join(evidence,'overview-clean.png'), (await capture()).toPNG());
    assert.equal(await js("(() => { document.querySelector('[data-settings-section=plugins]').dispatchEvent(new PointerEvent('pointerenter')); return !!document.querySelector('#plugin-experimental-tip')?.matches(':popover-open'); })()"), false);
    assert.equal(await js("(() => { document.querySelector('.plugin-experimental-tooltip').dispatchEvent(new PointerEvent('pointerenter')); return document.querySelector('#plugin-experimental-tip').matches(':popover-open'); })()"), true);
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await js("(() => { const tip=document.querySelector('#plugin-experimental-tip'); const badge=document.querySelector('.plugin-section-experimental').getBoundingClientRect(); const box=tip.getBoundingClientRect(); const arrow=getComputedStyle(tip,'::after'); return Math.abs(box.left+parseFloat(arrow.left)+3.5-(badge.left+badge.width/2))<2; })()"), true);
    fs.writeFileSync(path.join(evidence,'overview-hover.png'), (await capture()).toPNG());
    await js("document.querySelector('.plugin-experimental-tooltip').dispatchEvent(new PointerEvent('pointerleave'))");
    await js("document.querySelector('[data-settings-section=plugins]').focus()");
    await waitFor("document.querySelector('#plugin-experimental-tip')?.matches(':popover-open')", 'experimental keyboard tooltip');
    fs.writeFileSync(path.join(evidence,'overview-tooltip.png'), (await capture()).toPNG());
    await js("document.querySelector('[data-settings-section=plugins]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert.equal(await js("document.querySelector('#plugin-experimental-tip').matches(':popover-open')"), false);

    await js("document.querySelector('.plugin-package-preview .plugin-allow').click()");
    await waitFor("state.pluginCatalog.plugins[0]?.status==='active' && !document.querySelector('.plugin-package-preview')", 'fresh install active without second consent');
    assert.equal(runtime.manager.list().plugins[0].background.enabled, false);
    assert.equal(loads,0);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(evidence,'package-results.json'),JSON.stringify({oldPid,newPid,loads,dialogs:toggleDialogs.length,errors},null,2));
    console.log('PASS real App package consent, new revision/PID, update and uninstall without reload');
    await runtime.dispose(); runtime=null; win.destroy(); clearTimeout(deadline); app.exit(0); return;
  }
  if (process.env.TM_TRANSACTIONS_ONLY === '1') {
    const baseline = process.env.TM_EXPECT_BASELINE === '1', results = [];
    await js("pluginApi.setEnabled('trusted-fixture',true)");
    await js("pluginApi.place('trusted-fixture/panel','home',true).then(applyPluginCatalog)");
    await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]')", 'B author input');
    const other = path.join(scratch, 'other-source');
    fs.cpSync(fixtureDir, other, { recursive: true });
    const otherManifest = { ...manifest, id: 'other-fixture', name: 'Transaction A' };
    const setVersion = version => fs.writeFileSync(path.join(other,'manifest.json'), JSON.stringify({ ...otherManifest, version }));
    setVersion('1.0.0'); selectedDirectory = other;
    for (const operation of ['install','update','rollback','uninstall']) {
      if (operation === 'update') setVersion('2.0.0');
      const token = ['install','update'].includes(operation) ? (await js("pluginApi.importPackage('directory')")).token : null;
      await js("globalThis.transactionInput=document.querySelector('[aria-label=\"Fixture draft\"]');transactionInput.value='';transactionInput.scrollIntoView({block:'center',behavior:'instant'});transactionInput.focus()");
      win.focus();
      await win.webContents.insertText('B draft');
      await waitFor("transactionInput.value==='B draft'", 'native typing');
      const pidBefore = (await js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','before')")).pid;
      const mountsBefore = await js('fixtureMountCount');
      const dialogCount = toggleDialogs.length;
      fs.writeFileSync(path.join(evidence, `transaction-${operation}-before.png`), (await capture()).toPNG());
      if (token) await js(`pluginApi.install(${JSON.stringify(token)})`);
      else if (operation === 'rollback') await js("pluginApi.rollback('other-fixture')");
      else await js("pluginApi.uninstall('other-fixture',{keepData:true,keepPlacements:true})");
      await pause(200);
      const retained = await js(`({sameInput:document.querySelector('[aria-label="Fixture draft"]')===transactionInput,
        focused:document.activeElement===transactionInput,draft:document.querySelector('[aria-label="Fixture draft"]')?.value,mounts:fixtureMountCount})`);
      await win.webContents.insertText(' + OK');
      await pause(50);
      const typed = await js("document.querySelector('[aria-label=\"Fixture draft\"]')?.value");
      const pidAfter = (await js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','after')")).pid;
      const result = { operation, ...retained, typed, mountsBefore, pidBefore, pidAfter, dialogs:toggleDialogs.length-dialogCount };
      results.push(result);
      fs.writeFileSync(path.join(evidence, `transaction-${operation}-after.png`), (await capture()).toPNG());
      fs.writeFileSync(path.join(evidence, 'transaction-results.json'), JSON.stringify({ baseline, results, electron:process.versions.electron, chrome:process.versions.chrome },null,2));
      assert.equal(result.dialogs,0);
      if (baseline) { assert.equal(retained.sameInput,false);assert.equal(retained.draft,'');assert.notEqual(pidAfter,pidBefore); }
      else {
        assert.equal(retained.sameInput,true);assert.equal(retained.focused,true);assert.equal(retained.draft,'B draft');
        assert.equal(typed,'B draft + OK');assert.equal(retained.mounts,mountsBefore);assert.equal(pidAfter,pidBefore);
      }
      console.log('PASS transaction isolation',JSON.stringify(result));
    }
    assertConsoleClean();
    await runtime.dispose();runtime=null;win.destroy();clearTimeout(deadline);app.exit(0);return;
  }
  if (process.env.TM_TOGGLE_ONLY === '1') {
    const baseline = process.env.TM_EXPECT_BASELINE === '1';
    let mainLoads = 0; win.webContents.on('did-finish-load', () => mainLoads++);
    const openPlugins = async () => {
      await js("openSettingsPanel();for(const section of SETTINGS_SECTION_IDS)setSettingsSectionExpanded(section,section==='plugins');pluginSettingsPanel.refresh()");
      await waitFor("document.querySelector('#pluginSettingsList .plugin-enable')", 'plugin switch');
      await js("document.querySelector('#pluginSettingsList .plugin-back')?.click();renderSettingsSummaries()");
      await js("document.querySelector('#pluginSettingsList').scrollIntoView({block:'start',behavior:'instant'})");
      await pause(200);
    };
    await openPlugins();
    await js("document.querySelector('#pluginSettingsList .plugin-enable').click()");
    await waitFor("document.querySelector('#pluginSettingsList .plugin-consent')", 'first trust');
    fs.writeFileSync(path.join(evidence,'first-trust.png'),(await capture()).toPNG());
    await js("document.querySelector('#pluginSettingsList .plugin-allow').click()");
    await waitFor("state.pluginCatalog?.plugins?.[0]?.status==='active'", 'trusted enabled');
    await js("pluginApi.place('trusted-fixture/panel','home',true).then(applyPluginCatalog);els.settingsPanel.classList.add('hidden');openViewFromTray('home')");
    await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]')", 'live home');
    await openPlugins();
    const previousLoads = mainLoads;
    const oldReload = baseline ? new Promise(resolve=>win.webContents.once('did-finish-load',resolve)) : null;
    await js("setTimeout(()=>document.querySelector('#pluginSettingsList .plugin-enable').click(),0);void 0");
    if(oldReload) await oldReload;
    await waitFor("state.pluginCatalog?.plugins?.[0]?.status==='disabled'", 'disabled');
    await pause(300); await openPlugins();
    const loadsAfterDisable = mainLoads - previousLoads;
    if (!baseline) { assert.equal(loadsAfterDisable,0);assert.equal(toggleDialogs.length,0); }
    await js("document.querySelector('#pluginSettingsList .plugin-enable').click()");
    if (baseline) await waitFor("document.querySelector('#pluginSettingsList .plugin-consent')", 'baseline repeated consent');
    else await waitFor("state.pluginCatalog?.plugins?.[0]?.status==='active' && !document.querySelector('#pluginSettingsList .plugin-consent')", 'one-click resume');
    await pause(1200);
    await js("renderSettingsSummaries();(document.querySelector('#pluginSettingsList .plugin-consent') || document.querySelector('#pluginSettingsList .plugin-card-head')).scrollIntoView({block:'center',behavior:'instant'})");
    await pause(200);
    fs.writeFileSync(path.join(evidence,'reenable.png'),(await capture()).toPNG());
    if (!baseline) {
      await js("els.settingsPanel.classList.add('hidden');openViewFromTray('home')");
      await waitFor("document.querySelector('[aria-label=\"Fixture draft\"]')", 'restored home');
      await js("tokenMonitor.plugins.openPage('trusted-fixture/panel')");
      let detached;
      for(let i=0;i<150;i++) {
        detached=BrowserWindow.getAllWindows().find(item=>item!==win);
        if(detached && !detached.webContents.isLoading() && await detached.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"Fixture draft\"]'))"))break;
        await pause(40);
      }
      assert.ok(detached);let detachedLoads=0;detached.webContents.on('did-finish-load',()=>detachedLoads++);
      await detached.webContents.executeJavaScript("document.querySelector('[aria-label=\"Fixture draft\"]').value='未保存的獨立視窗草稿'");
      toggleResponse=0;
      assert.match(await js("pluginApi.setEnabled('trusted-fixture',false).then(()=>'unexpected success',error=>String(error.message||error))"),/cancelled/);
      console.log('PASS cancelled disable keeps active plugin');
      assert.equal(runtime.manager.active('trusted-fixture'),true);
      assert.equal(await detached.webContents.executeJavaScript("document.querySelector('[aria-label=\"Fixture draft\"]').value"),'未保存的獨立視窗草稿');
      toggleResponse=1;await js("pluginApi.setEnabled('trusted-fixture',false)");console.log('PASS confirmed disable completed');
      assert.equal(runtime.manager.backendCount(),0);assert.equal(detachedLoads,0);assert.equal(mainLoads,0);
      assert.equal(await detached.webContents.executeJavaScript("document.querySelector('[aria-label=\"Fixture draft\"]')===null"),true);
      await waitFor("state.pluginCatalog.plugins[0].status==='disabled'", 'catalog disabled');
      await openPlugins();fs.writeFileSync(path.join(evidence,'disabled.png'),(await capture()).toPNG());
      await js("document.querySelector('#pluginSettingsList .plugin-enable').click()");
      await waitFor("state.pluginCatalog.plugins[0].status==='active'", 'resume again');
      for(let i=0;i<100&&!await detached.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"Fixture draft\"]'))");i++)await pause(30);
      assert.equal(await detached.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"Fixture draft\"]'))"),true);
      assert.equal(detachedLoads,0);assert.equal(mainLoads,0);
      console.log('PASS actual first trust, one-click unchanged resume, no reload, detached unsaved cancel/continue, backend stop, same-window reactivation');
      const dialogCount=toggleDialogs.length;
      await js("tokenMonitor.updateSettings({pluginsEnabled:false})");
      assert.equal(runtime.manager.backendCount(),0);assert.equal(runtime.manager.hasActive(),false);
      await js("tokenMonitor.updateSettings({pluginsEnabled:true})");
      assert.equal(runtime.manager.active('trusted-fixture'),true);assert.equal(toggleDialogs.length,dialogCount);
      assert.equal(mainLoads,0);assert.equal(detachedLoads,0);
      console.log('PASS production settings bridge master off/on reuses trust without reload');
      // A different plugin in its own busy renderer must not join A's lifecycle.
      const otherDir=path.join(scratch,'other-author');fs.mkdirSync(otherDir);
      fs.writeFileSync(path.join(otherDir,'manifest.json'),JSON.stringify({tmApi:1,id:'other-fixture',name:'Other fixture',version:'1.0.0',ui:'ui.mjs',files:['ui.mjs'],views:[{id:'panel',surfaces:['page']}]}));
      fs.writeFileSync(path.join(otherDir,'ui.mjs'),"export function mount(container){const p=document.createElement('p');p.textContent='Unrelated plugin B';container.append(p);return {dispose(){p.remove();}};}");
      selectedDirectory=otherDir;
      await js("pluginApi.importPackage('directory').then(p=>pluginApi.install(p.token))");
      selectedDirectory=fixtureDir;
      await js("pluginApi.setEnabled('other-fixture',true);void 0");
      for(let i=0;i<100&&!runtime.manager.active('other-fixture');i++)await pause(30);
      await js("tokenMonitor.plugins.openPage('other-fixture/panel')");
      let unrelated;
      for(let i=0;i<150;i++) {
        unrelated=BrowserWindow.getAllWindows().find(item=>item!==win&&item!==detached);
        if(unrelated&&!unrelated.webContents.isLoading()&&await unrelated.webContents.executeJavaScript("document.body.textContent.includes('Unrelated plugin B')"))break;
        await pause(30);
      }
      assert.ok(unrelated);
      assert.notEqual(unrelated.webContents.getOSProcessId(),win.webContents.getOSProcessId());
      const unrelatedLifecycle=[],send=unrelated.webContents.send.bind(unrelated.webContents);
      unrelated.webContents.send=(channel,...args)=>{if(channel==='plugins:lifecycle')unrelatedLifecycle.push(args[0]);return send(channel,...args);};
      await unrelated.webContents.executeJavaScript("setTimeout(()=>{const end=performance.now()+6200;while(performance.now()<end){};globalThis.busyFinished=true;},50);true");
      await pause(100);const dialogBefore=toggleDialogs.length,started=Date.now();
      await js("pluginApi.setEnabled('trusted-fixture',false)");
      await js("pluginApi.setEnabled('trusted-fixture',true)");
      const toggleMs=Date.now()-started;
      assert.ok(toggleMs<5000, 'unrelated busy renderer must not incur lifecycle timeout');
      assert.deepEqual(unrelatedLifecycle,[]);assert.equal(toggleDialogs.length,dialogBefore);
      await unrelated.webContents.executeJavaScript('busyFinished');
      unrelated.destroy();await js("pluginApi.uninstall('other-fixture')");
      console.log('PASS unrelated busy plugin renderer excluded from disable/resume', {toggleMs});
      // Same-document navigation must not unregister a live author host.
      await detached.webContents.executeJavaScript("location.hash='author-section';document.querySelector('[aria-label=\"Fixture draft\"]').value='hash navigation draft'");
      await pause(100); toggleResponse=0;
      assert.match(await js("pluginApi.setEnabled('trusted-fixture',false).then(()=>'unexpected success',error=>String(error.message||error))"),/cancelled/);
      toggleResponse=1;await detached.webContents.executeJavaScript("document.querySelector('[aria-label=\"Fixture draft\"]').value=''");
      console.log('PASS real same-document navigation retains draft inspection');
      await js("pluginApi.setEnabled('trusted-fixture',false)");
      await detached.webContents.executeJavaScript('globalThis.fixtureDeferredMount=true');
      await js("pluginApi.setEnabled('trusted-fixture',true)");
      for(let i=0;i<100&&!await detached.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"Fixture draft\"]'))");i++)await pause(30);
      await detached.webContents.executeJavaScript('globalThis.fixtureDeferUpdate=true');
      const [width,height]=detached.getSize();detached.setSize(width+20,height);
      for(let i=0;i<100&&!await detached.webContents.executeJavaScript("typeof fixtureFinishUpdate==='function'");i++)await pause(30);
      assert.equal(await detached.webContents.executeJavaScript("typeof fixtureFinishUpdate==='function'"),true);
      await detached.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      fs.writeFileSync(path.join(evidence,'pending-redraw-active.png'),(await detached.webContents.capturePage()).toPNG());
      const stopping=js("pluginApi.setEnabled('trusted-fixture',false)");
      for(let i=0;i<100&&await detached.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"Fixture draft\"]'))");i++)await pause(30);
      assert.equal(await detached.webContents.executeJavaScript("document.querySelector('[aria-label=\"Fixture draft\"]')===null"),true);
      await detached.webContents.executeJavaScript('fixtureFinishUpdate()');await stopping;
      assert.equal(await detached.webContents.executeJavaScript('fixtureDeferredDisposed'),true);
      assert.equal(await detached.webContents.executeJavaScript("document.querySelector('[aria-label=\"Late redraw\"]')===null"),true);
      await detached.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      fs.writeFileSync(path.join(evidence,'pending-redraw-disabled.png'),(await detached.webContents.capturePage()).toPNG());
      assert.equal(detachedLoads,0);assert.equal(mainLoads,0);
      console.log('PASS actual detached pending redraw drains with no connected controls after disable');
      await detached.webContents.executeJavaScript('globalThis.fixtureDeferredMount=false');
      await js("pluginApi.setEnabled('trusted-fixture',true)");
      toggleResponse=0;await js("globalThis.fixtureCleanupFailure=true;pluginApi.setEnabled('trusted-fixture',false)");
      assert.equal(runtime.manager.active('trusted-fixture'),false);assert.equal(mainLoads,0);
      assert.match(await js("pluginApi.setEnabled('trusted-fixture',true).then(()=>'unexpected success',error=>String(error.message||error))"),/cancelled/);
      toggleResponse=1;
      const recovered = new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
      await js("pluginApi.setEnabled('trusted-fixture',true)");await recovered;
      await waitFor("state.stats?.periods?.today?.totalTokens===125000 && state.pluginCatalog?.plugins?.[0]?.status==='active'", 'recovery renderer ready');
      assert.equal(mainLoads,1);assert.equal(detachedLoads,0);
      console.log('PASS failed cleanup remains disabled, recovery is explicit and reloads only failed host');
    }
    fs.writeFileSync(path.join(evidence,'toggle-results.json'),JSON.stringify({baseline,mainLoads,loadsAfterDisable,dialogs:toggleDialogs,errors,electron:process.versions.electron},null,2));
    assertConsoleClean(baseline?[]:['Intentional fixture cleanup failure']);
    for(const host of BrowserWindow.getAllWindows())host.destroy();
    await runtime.dispose();runtime=null;clearTimeout(deadline);app.exit(0);return;
  }
  await js("pluginApi.setEnabled('trusted-fixture',true)");
  if (process.env.TM_NAV_ICONS === '1') {
    await js("pluginApi.place('trusted-fixture/panel','page',true).then(applyPluginCatalog)");
    if (process.env.TM_NAV_HEIGHT === '1') for (let i=1;i<=3;i++) await js(`pluginApi.place('trusted-fixture/extra-${i}','page',true).then(applyPluginCatalog)`);
    await js("if(isSettingsPanelOpen())els.settingsButton.click();setViewSwitcherOpen(true)");
    await waitFor("document.querySelector('[data-view=\"plugin:trusted-fixture/panel\"] img')?.naturalWidth > 0", 'navigation artwork before opening page');
    assert.equal(await js("globalThis.fixtureMountCount || 0"),0);
    assert.equal(runtime.manager.backendCount(),0);
    fs.writeFileSync(path.join(evidence,'main-navigation.png'),(await capture()).toPNG());
    if (process.env.TM_NAV_HEIGHT === '1') {
      const measure = () => js("(() => {const menu=document.querySelector('#viewSwitcherMenu'),r=menu.getBoundingClientRect();return {height:r.height,top:r.top,bottom:r.bottom,viewport:innerHeight,client:menu.clientHeight,scroll:menu.scrollHeight};})()");
      const tall = await measure();
      fs.writeFileSync(path.join(evidence,'navigation-tall.json'),JSON.stringify(tall));
      assert.ok(tall.height > 280, 'menu uses available height rather than a fixed cap');
      assert.ok(tall.scroll <= tall.client + 1, 'all entries fit without scrolling in tall window');
      win.setSize(400,400); await pause(300);
      const short = await measure();
      console.log('menu short geometry', JSON.stringify({ ...short, nativeSize: win.getSize() }));
      assert.ok(short.top >= 0 && short.bottom <= short.viewport, 'short menu stays inside viewport');
      assert.ok(short.scroll > short.client, 'short window retains scrolling');
      await js("document.querySelector('#viewSwitcherMenu').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
      await pause(100);
      assert.equal(await js("document.activeElement.dataset.view"),'plugin:trusted-fixture/extra-3');
      fs.writeFileSync(path.join(evidence,'navigation-short.json'),JSON.stringify(short));
      fs.writeFileSync(path.join(evidence,'navigation-short.png'),(await capture()).toPNG());
    }
    await js("pluginApi.openPage('trusted-fixture/panel')");
    await waitFor("document.querySelector('.view-switcher-current img')?.naturalWidth > 0", 'selected navigation artwork');
    await js("pluginApi.setEnabled('trusted-fixture',false)");
    assert.equal(await js("Boolean(document.querySelector('[data-view=\"plugin:trusted-fixture/panel\"]'))"),false);
    assertConsoleClean();
    for(const host of BrowserWindow.getAllWindows())host.destroy();
    await runtime.dispose();runtime=null;clearTimeout(deadline);app.exit(0);return;
  }
  if (process.env.TM_PAGE_SETTINGS_LAYOUT === '1') {
    await js("pluginApi.place('trusted-fixture/panel','page',true).then(applyPluginCatalog).then(()=>pluginApi.openPage('trusted-fixture/panel'))");
    await waitFor("document.querySelector('.plugin-main-content input')", 'plugin page input');
    await js("globalThis.retainedLayoutInput=document.querySelector('.plugin-main-content input');retainedLayoutInput.value='Keep my draft';els.settingsButton.click();document.querySelectorAll('.settings-section-toggle[aria-expanded=true]').forEach(node=>node.click())");
    await pause(500);
    fs.writeFileSync(path.join(evidence,'plugin-settings.png'),(await capture()).toPNG());
    const geometry = await js(`(() => {
      const shell=els.shell.getBoundingClientRect(),footer=document.querySelector('.footer').getBoundingClientRect();
      return {bottomGap:shell.bottom-footer.bottom,viewport:innerHeight,pluginHidden:getComputedStyle(document.querySelector('.plugin-main-panel')).display==='none'};
    })()`);
    fs.writeFileSync(path.join(evidence,'page-settings-layout.json'),JSON.stringify(geometry,null,2));
    assert.equal(geometry.pluginHidden,false, 'settings must retain the plugin page');
    assert.ok(geometry.bottomGap < 40, 'footer must remain at the bottom with plugin content visible: '+JSON.stringify(geometry));
    assert.ok(await js("document.querySelector('.plugin-main-content').getBoundingClientRect().height > 100"));
    assert.ok(pluginCalls.filter(call=>call.channel==='plugins:demand' && call.surface==='page').at(-1)?.refs.includes('trusted-fixture/panel'), 'visible page retains foreground demand');
    await js("retainedLayoutInput.focus()");
    await win.webContents.insertText(' + continued');
    assert.equal(await js("retainedLayoutInput.value"),'Keep my draft + continued');
    const expandedLayouts = {};
    for (const page of ['plugin:trusted-fixture/panel', 'model']) {
      await js(`openViewFromTray(${JSON.stringify(page)});openSettingsPanel();document.querySelectorAll('.settings-section-toggle[aria-expanded=true]').forEach(node=>node.click());setSettingsSectionExpanded('general',true)`);
      await pause(500);
      expandedLayouts[page] = await js(`(() => {
        const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,height:r.height,bottom:r.bottom}; };
        return {settings:rect('.settings-panel'),content:rect(state.breakdown.startsWith('plugin:')?'.plugin-main-panel':'.breakdown'),footer:rect('.footer'),viewport:innerHeight};
      })()`);
      fs.writeFileSync(path.join(evidence,page.startsWith('plugin:')?'expanded-plugin.png':'expanded-native.png'),(await capture()).toPNG());
    }
    fs.writeFileSync(path.join(evidence,'expanded-layouts.json'),JSON.stringify(expandedLayouts,null,2));
    await js("openViewFromTray('plugin:trusted-fixture/panel');openSettingsPanel();document.querySelectorAll('.settings-section-toggle[aria-expanded=true]').forEach(node=>node.click())");
    await pause(500);
    assert.ok(await js("document.querySelector('.plugin-main-content').getBoundingClientRect().height > 100"));
    await js("els.settingsButton.click()");await pause(200);
    assert.equal(await js("document.querySelector('.plugin-main-content input')===retainedLayoutInput && retainedLayoutInput.value==='Keep my draft + continued'"),true);
    fs.writeFileSync(path.join(evidence,'plugin-restored.png'),(await capture()).toPNG());
    assertConsoleClean();
    for(const host of BrowserWindow.getAllWindows())host.destroy();
    await runtime.dispose();runtime=null;clearTimeout(deadline);app.exit(0);return;
  }
  if (process.env.TM_PLACEMENTS_ONLY === '1') {
    // Exercise the installed-view route through the real existing composers.
    const placementBaseline = process.env.TM_EXPECT_BASELINE === '1';
    const placementSettingsBefore = structuredClone(settings);
    const placementResults = {};
    // Wait for accordion/scroll anchoring before framing evidence. A mounted
    // control can still live in a hidden display-settings subpage.
    const frameVisible = async selector => {
      await pause(500);
      await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
      await pause(200);
      assert.equal(await js(`(() => {
        const node=document.querySelector(${JSON.stringify(selector)});
        const r=node.getBoundingClientRect();
        const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return r.width>0 && r.height>0 && (node===hit || node.contains(hit));
      })()`),true, `visible capture target: ${selector}`);
    };
    const captureRegion = async (name, expression) => {
      const rect = await js(`(() => { const r=${expression}; return {x:Math.floor(r.left),y:Math.floor(r.top),width:Math.ceil(r.width),height:Math.ceil(r.height)}; })()`);
      fs.writeFileSync(path.join(evidence,name),(await win.webContents.capturePage(rect)).toPNG());
    };
    await js("els.settingsButton.click();document.querySelector('[data-settings-section=window]').click()");
    for (const [surface, key] of [['floatingBubble', 'floatingBubbleCustomLayout'], ['notch', 'notchCustomLayout']]) {
      const entry = surface === 'floatingBubble' ? '.display-settings-row:nth-child(3) .display-settings-open' : '#display-tab-notch';
      await frameVisible(entry);
      await js(`document.querySelector('${entry}').click()`);
      if (surface === 'floatingBubble') {
        await js("if(!els.floatingBubbleInput.checked)els.floatingBubbleInput.click();els.floatingBubbleContentInput.value='custom';els.floatingBubbleContentInput.dispatchEvent(new Event('change',{bubbles:true}))");
      } else {
        await js("if(!els.notchInput.checked)els.notchInput.click();els.notchSummaryModeInput.value='custom';els.notchSummaryModeInput.dispatchEvent(new Event('change',{bubbles:true}))");
      }
      await waitFor(`document.querySelector('#${surface === 'notch' ? 'notch' : 'floatingBubble'}Composer .tray-composer-add')`, `${surface} composer`);
      const selector = `#${surface === 'notch' ? 'notch' : 'floatingBubble'}Composer`;
      await frameVisible(`${selector} .tray-composer-add`);
      fs.writeFileSync(path.join(evidence, `${surface}-context.png`), (await capture()).toPNG());
      await js(`document.querySelector('${selector} .tray-composer-add').click()`);
      const choices = await js("Array.from(document.querySelectorAll('.tray-composer-gallery [data-plugin-ref]'),node=>node.dataset.pluginRef)");
      placementResults[surface] = { choices };
      assert.equal(choices.includes('trusted-fixture/panel'), !placementBaseline);
      await frameVisible('.tray-composer-gallery section:last-child button:last-child');
      fs.writeFileSync(path.join(evidence, `${surface}-choices.png`), (await capture()).toPNG());
      await captureRegion(`${surface}-choice-detail.png`, `(() => {
        const gallery=document.querySelector('.tray-composer-gallery');
        const groups=[...gallery.querySelectorAll('section')];
        const spacing=groups.find(section=>section.textContent.includes('分隔點'));
        const a=gallery.getBoundingClientRect(),b=spacing.getBoundingClientRect();
        return {left:a.left,top:b.top,width:a.width,height:a.bottom-b.top};
      })()`);
      if (!placementBaseline) {
        await js("document.querySelector('.tray-composer-gallery [data-plugin-ref=\"trusted-fixture/panel\"]').click()");
        for(let i=0;i<100&&!settings[key]?.items?.some(item=>item.ref==='trusted-fixture/panel');i++)await pause(20);
        assert.ok(settings[key].items.some(item=>item.ref==='trusted-fixture/panel'));
        const id = settings[key].items.find(item=>item.ref==='trusted-fixture/panel').id;
        await js(`document.querySelector('${selector} [data-item-id="${id}"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);
        for(let i=0;i<100&&settings[key].items[0].id!==id;i++)await pause(20);
        assert.equal(settings[key].items[0].id,id);
        await frameVisible(`${selector} [data-item-id="${id}"]`);
        fs.writeFileSync(path.join(evidence, `${surface}-placed.png`), (await capture()).toPNG());
        if(surface==='notch') await captureRegion('notch-placement-detail.png', `(() => {
          const a=els.notchSummaryModeInput.closest('.settings-item').getBoundingClientRect();
          const b=document.querySelector('#notchComposer').getBoundingClientRect();
          return {left:b.left,top:a.top,width:b.width,height:b.bottom-a.top};
        })()`);
        await js(`document.querySelector('${selector} [data-item-id="${id}"]').click();document.querySelector('.tray-composer-editor .tray-composer-danger').click()`);
        for(let i=0;i<100&&settings[key].items.some(item=>item.id===id);i++)await pause(20);
        assert.ok(!settings[key].items.some(item=>item.id===id));
        placementResults[surface].saveReorderRemove = true;
      } else await js("document.querySelector('.tray-composer-gallery').hidePopover()");
    }
    Object.assign(settings, placementSettingsBefore); runtime.settingsChanged();
    await js(`Object.assign(state.settings,${JSON.stringify(placementSettingsBefore)});syncSettingsForm();document.querySelector('[data-settings-section=plugins]').click();pluginSettingsPanel.refresh()`);
    await js("document.querySelector('[data-plugin-id=\"trusted-fixture\"] .plugin-manage').click();document.querySelector('.plugin-diagnostics').click()");
    for(let i=0;i<100&&runtime.manager.backendCount();i++)await pause(20);
    assert.equal(runtime.manager.backendCount(),0);
    await js('pluginSettingsPanel.refresh()');
    await waitFor("document.querySelector('.plugin-runtime-text')", 'idle diagnostics');
    placementResults.idle = await js("document.querySelector('.plugin-runtime-text').textContent");
    assert.equal(placementResults.idle.includes('settings.plugins.runtimeState.idle'),placementBaseline);
    await frameVisible('.plugin-runtime-text');
    fs.writeFileSync(path.join(evidence, 'idle-diagnostics.png'), (await capture()).toPNG());
    await captureRegion('idle-detail.png', "document.querySelector('.plugin-detail').getBoundingClientRect()");
    fs.writeFileSync(path.join(evidence, 'placement-results.json'), JSON.stringify(placementResults,null,2));
    assertConsoleClean();
    console.log('PASS real App composer choices/save/reorder/remove and idle diagnostics', placementResults);
    await runtime.dispose();runtime=null;win.destroy();clearTimeout(deadline);app.exit(0);return;
  }
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
  await waitFor("document.querySelector('#pluginMainPanel .plugin-main-page:not(.hidden)') && document.querySelector('#pluginPageActions .plugin-main-actions:not(.hidden) .plugin-main-detach')", 'main plugin page and native header action');
  assert.equal(await js("Boolean(document.querySelector('#pluginMainPanel .plugin-main-detach'))"), false);
  await js("document.querySelector('#pluginPageActions .plugin-main-actions:not(.hidden) .plugin-main-detach').click()");
  for (let i = 0; i < 150 && BrowserWindow.getAllWindows().length === 1; i++) await pause(40);
  const detached = BrowserWindow.getAllWindows().find(candidate => candidate !== win);
  assert.ok(detached);
  for (let i=0;i<150;i++) { if (await detached.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"Fixture draft\"]'))")) break; await pause(40); }
  assert.equal(await detached.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"Fixture draft\"]'))"), true);
  await waitFor("document.querySelector('[data-fixture-asset]')?.naturalWidth===160", 'main plugin package image');
  for (let i=0;i<100;i++) { if (await detached.webContents.executeJavaScript("document.querySelector('[data-fixture-asset]')?.complete")) break; await pause(20); }
  const assetResult=await detached.webContents.executeJavaScript("({width:document.querySelector('[data-fixture-asset]').naturalWidth,background:getComputedStyle(document.querySelector('[data-fixture-background]')).backgroundImage})");
  fs.writeFileSync(path.join(evidence,'asset-results.json'),JSON.stringify(assetResult));
  assert.equal(assetResult.width,160); assert.match(assetResult.background,/tm-plugin:/);
  const detachedPid = await detached.webContents.executeJavaScript("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','detached')");
  assert.equal(detachedPid.pid, (await js("tokenMonitorTrustedPlugins.call('trusted-fixture','echo','shared')")).pid);
  fs.writeFileSync(path.join(evidence, 'app-detached.png'), (await detached.webContents.capturePage()).toPNG());
  detached.destroy();
  const bitmapLayout={items:[{id:'plugin',type:'plugin',ref:'trusted-fixture/panel'}]};
  const previousSettings={showTrayIcon:settings.showTrayIcon,trayCustomLayout:settings.trayCustomLayout,floatingBubbleContent:settings.floatingBubbleContent,floatingBubbleCustomLayout:settings.floatingBubbleCustomLayout};
  Object.assign(settings,{showTrayIcon:false,trayCustomLayout:{items:[]},floatingBubbleContent:'custom',floatingBubbleCustomLayout:bitmapLayout});runtime.settingsChanged();
  await js(`Object.assign(state.settings,${JSON.stringify({showTrayIcon:false,trayCustomLayout:{items:[]},floatingBubbleContent:'custom',floatingBubbleCustomLayout:bitmapLayout})});applyFloatingBubbleState({collapsed:true,side:'left'});renderFloatingBubbleContent()`);
  await waitFor("Boolean(els.floatingBubbleContent.querySelector('img')?.complete)",'bubble-only custom plugin bitmap');
  const bubbleResult=await js("({refs:trayLayoutApi.trayLayoutPluginRefs(state.settings.floatingBubbleCustomLayout),hasImage:Boolean(els.floatingBubbleContent.querySelector('img')),trayRefs:trayLayoutApi.trayLayoutPluginRefs(state.settings.trayCustomLayout)})");
  assert.equal(bubbleResult.hasImage,true);assert.deepEqual(bubbleResult.trayRefs,[]);
  fs.writeFileSync(path.join(evidence,'bubble-results.json'),JSON.stringify(bubbleResult));
  fs.writeFileSync(path.join(evidence,'bubble-bitmap.png'),(await capture()).toPNG());
  Object.assign(settings,previousSettings);runtime.settingsChanged();
  await js(`Object.assign(state.settings,${JSON.stringify(previousSettings)});applyFloatingBubbleState({collapsed:false});render()`);
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
  await js("state.rowSignature='';renderRows(rowsForPeriod(state.stats.periods[state.period]))");
  await waitFor(`document.querySelectorAll('[data-audit=inline]').length === ${inlineCount}`, 'partial native row renderer preserves inline extensions');
  console.log('PASS direct native renderRows reconciles section and inline anchors without App render wrapper');
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
  await js("globalThis.reviewInput=document.querySelector('[data-plugin-target=\"main.model.content\"] input'); reviewInput.value='未提交的草稿';reviewInput.focus();reviewInput.setSelectionRange(reviewInput.value.length,reviewInput.value.length);render();render()");
  await win.webContents.insertText('，繼續輸入');
  const focusResult=await js("({focused:document.activeElement===reviewInput,value:reviewInput.value,sameNode:reviewInput===document.querySelector('[data-plugin-target=\"main.model.content\"] input')})");
  fs.writeFileSync(path.join(evidence,'focus-results.json'),JSON.stringify(focusResult));
  fs.writeFileSync(path.join(evidence,'review-focus.png'),(await capture()).toPNG());
  assert.equal(focusResult.focused,true); assert.equal(focusResult.value,'未提交的草稿，繼續輸入'); assert.equal(focusResult.sameNode,true);
  await js("globalThis.fixtureUpdateFailure=true; document.querySelector('[data-plugin-target=\"main.model.content\"] [data-audit-native]').parentElement.style.width='95%'");
  await waitFor("document.querySelector('[data-plugin-target=\"main.model.content\"] .plugin-inline-error') && !els.breakdown.hidden", 'resize error restores native content');
  await js('render(); render()');
  await pause(50);
  assert.equal(await js('els.breakdown.hidden'), false);
  assert.match(await js("document.querySelector('[data-plugin-target=\"main.model.content\"] .plugin-inline-error').textContent"), /Intentional fixture update failure/);
  fs.writeFileSync(path.join(evidence, 'comparison-failed-update.png'), (await capture()).toPNG());
  console.log('PASS real ResizeObserver failure stays contained and native content survives later pushes');
  let disableReloads = 0; win.webContents.on('did-finish-load', () => disableReloads++);
  await js("pluginApi.setEnabled('trusted-fixture',false)");
  assert.equal(disableReloads, 0);
  await waitFor("state.stats?.periods?.today?.totalTokens === 125000 && state.pluginCatalog?.plugins?.[0]?.status === 'disabled'", 'disabled catalog update');
  await js("openViewFromTray('model')");
  assert.equal(await js("document.querySelectorAll('.plugin-content').length"), 0);
  await waitFor("state.breakdown === 'model' && els.breakdown.querySelectorAll('.row').length === 2", 'disabled native model rows');
  assert.equal(await js('els.breakdown.hidden'), false);
  assert.equal(runtime.manager.backendCount(), 0);
  fs.writeFileSync(path.join(evidence, 'comparison-disabled.png'), (await capture()).toPNG());
  fs.writeFileSync(path.join(evidence, 'coverage-results.json'), JSON.stringify({ coveredPages, sessionDetail:true, sectionRows:inlineCount, navigationOrder:true, trayCallback:true, authorSettings:true, disabledWithoutReloadRestored:true },null,2));
  console.log('PASS all native page roots, session detail, section/inline, navigation order, native factory, settings, Tray callback, disable/cleanup/restoration');
  console.log('PASS Home mount/draft, local backend, explicit original-page replacement and native restoration');
  assert.equal(errors.filter(text => text.includes('Intentional fixture update failure')).length, 1);
  assertConsoleClean(['Intentional fixture update failure']);
  fs.writeFileSync(path.join(evidence, 'app-results.json'), JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, errors, pid, scope: 'production index.html/app.js/preload + real plugin runtime; synthetic non-plugin IPC, not full main collector' }, null, 2));
  clearTimeout(deadline);
  if (process.argv.includes('--demo')) {
    console.log('DEMO ready: isolated synthetic App; enable Platform fixture in Settings > Plugins. Close the window to exit.');
    win.once('closed', () => { void runtime.dispose().finally(() => app.quit()); });
    return;
  }
  await runtime.dispose(); runtime = null; win.destroy(); app.exit(0);
}).catch(error => { console.error(error); runtime?.dispose(); clearTimeout(deadline); app.exit(1); });
