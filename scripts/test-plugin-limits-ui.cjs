'use strict';
// Actual App HTML, renderer, preload and plugin runtime. Host collection/account
// IPC uses synthetic records; no personal profile, collector or credentials load.
const { app, BrowserWindow, ipcMain, session, utilityProcess, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPluginRuntime, registerPluginScheme } = require('../src/electron/plugins/runtime');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-credit-limits-'));
const evidence = process.env.TM_PLUGIN_EVIDENCE || scratch;

const fixtureDir = path.join(scratch, 'source');
fs.mkdirSync(fixtureDir, { recursive: true });
fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), JSON.stringify({tmApi:1,id:'synthetic-limits',name:'Synthetic limits',version:'1.0.0',backend:'backend.cjs',ui:'settings.mjs',files:['backend.cjs','settings.mjs'],views:[{id:'quota-settings',title:'Quota preferences',surfaces:['settings']}],settings:{version:1,fields:[{id:'displayMode',type:'string',label:'Display mode',default:'meter'}]},limits:[{id:'one',name:'Claude',settingsView:'quota-settings',connection:'openai',capabilities:['cli','oauth','web'],tags:[{en:'Team pool','zh-TW':'作者團隊池'}]},{id:'two',name:'API balance',settingsView:'quota-settings',capabilities:['api','apiKey'],tags:[{en:'Custom pool','zh-TW':'作者自填池'},'Token Plan']}]}));
fs.writeFileSync(path.join(fixtureDir, 'backend.cjs'), `const fs=require('node:fs');const file=${JSON.stringify(path.join(scratch,'fixture-status.txt'))};exports.activate=async()=>({call:async(method,args)=>{if(method==='fixture-status'){fs.writeFileSync(file,args.status);return true;}const {moduleId}=args;const status=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'ok';return{status:moduleId==='one'?status:'ok',plan:moduleId==='one'?'Synthetic Team':undefined,windows:moduleId==='two'?[{kind:'daily',label:'Daily pool',usedPercent:25,remainingPercent:75},{kind:'billing',label:'Billing pool',usedPercent:40,remainingPercent:60}]:[{kind:'billing',label:'API credits',metric:'credits',used:moduleId==='one'?20:40,limit:100,remaining:moduleId==='one'?80:60,currency:'USD',usedPercent:moduleId==='one'?20:40,remainingPercent:moduleId==='one'?80:60}]};}});`);
fs.writeFileSync(path.join(fixtureDir,'settings.mjs'), `
export async function activate(ctx) {
  window.quotaViewEvents ||= [];
  return {async mount(container,context) {
    const id=context.moduleId;
    window.quotaViewEvents.push({type:'mount',id});
    let snapshot=await ctx.host.call('settings.get');
    container.innerHTML='<label class="settings-item"><span class="settings-item-text">Display mode</span><select data-quota-mode><option value="meter">Percentage + balance</option><option value="balance">Balance only</option></select></label><label class="settings-item"><span class="settings-item-text">Organization draft</span><input data-quota-draft placeholder="Synthetic organization" /></label><div class="settings-actions"><button data-quota-save>Save preferences</button><span data-quota-feedback></span></div>';
    const mode=container.querySelector('[data-quota-mode]'),draft=container.querySelector('[data-quota-draft]');
    mode.value=snapshot.values.displayMode;
    container.querySelector('[data-quota-save]').onclick=async()=>{
      snapshot=await ctx.host.call('settings.update',{schemaVersion:snapshot.schemaVersion,expectedRevision:snapshot.revision,patch:{displayMode:mode.value}});
      container.querySelector('[data-quota-feedback]').textContent='Saved';
    };
    return {update(value){window.quotaViewEvents.push({type:'visible',id,visible:value.visible});},hasUnsavedChanges(){return !!draft.value||mode.value!==snapshot.values.displayMode;},dispose(){window.quotaViewEvents.push({type:'dispose',id});container.replaceChildren();}};
  }};
}
`);
fs.mkdirSync(evidence,{recursive:true});
app.setPath('userData',path.join(scratch,'profile'));
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
registerPluginScheme(protocol);
app.on('window-all-closed',()=>{});
let runtime,win;
let loginSession, loginWindow;
// Synthetic account capture exercises the real main/preload/renderer path.
// It never opens a website or invokes the OS credential backend.
function FixtureWindow(options) {
  if (!options.webPreferences?.session?.fixtureLogin) return new BrowserWindow(options);
  loginWindow = new EventEmitter();
  loginWindow.webContents = new EventEmitter();
  loginWindow.webContents.id = 900001;
  loginWindow.webContents.setWindowOpenHandler = () => {};
  loginWindow.isDestroyed = () => loginWindow.dead === true;
  loginWindow.destroy = () => { loginWindow.dead = true; loginWindow.emit('closed'); };
  loginWindow.loadURL = async () => {};
  return loginWindow;
}
FixtureWindow.fromWebContents = BrowserWindow.fromWebContents;
const fixtureSessions = { get defaultSession() { return session.defaultSession; }, fromPartition: (partition, ...args) => {
  if (!partition.startsWith('plugin-web-login-')) return session.fromPartition(partition, ...args);
  loginSession = { fixtureLogin: true, setPermissionRequestHandler() {}, clearStorageData: async () => {}, webRequest: {
    onBeforeSendHeaders: (...values) => { loginSession.before = values.at(-1); },
    onCompleted: (...values) => { loginSession.completed = values.at(-1); }
  } };
  return loginSession;
} };
const fixtureCrypt = value => Buffer.from([...value].map(byte => byte ^ 113));
const fixtureSafeStorage = { isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptStringAsync: async value => fixtureCrypt(Buffer.from(value)),
  decryptStringAsync: async value => ({ result: fixtureCrypt(value).toString(), shouldReEncrypt: false }) };
const errors=[];
const deadline=setTimeout(()=>{console.error('UI deadline',errors);app.exit(1);},45000);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
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
async function waitFor(source,label){
 for(let i=0;i<150;i++){if(await win.webContents.executeJavaScript(`Boolean(${source})`))return;await pause(40);}
 console.error(await win.webContents.executeJavaScript("({text:document.body.innerText,plugins:state.pluginCatalog})"));
 throw Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  let settings = { ...defaults(), language: 'zh-TW', locale: 'zh-TW', systemGlass: false, reduceMotion: 'on', tokenNumberAnimation: 'off', refreshMs: 3600000, limitProviders:'codex,claude', limitsHistoryOpenMode:'off' };
  const period = { totalTokens: 125000, costUsd: 4.25, inputTokens: 100000, outputTokens: 25000, cachedInputTokens: 0, sessions: [], models: { 'gpt-5': 100000, 'claude-sonnet': 25000 }, modelCosts: { 'gpt-5': 3.25, 'claude-sonnet': 1 }, clients: { codex: 125000 }, clientCosts: { codex: 4.25 }, devices: [], projects: { fixture: { label: 'Synthetic project', tokens: 125000, costUsd: 4.25, clients: { codex: 125000 } } } };
  const stats = { updatedAt: new Date().toISOString(), periods: { today: period, month: { ...period, totalTokens: 750000 }, allTime: period }, devices: [], limits: { providers: ['codex','claude'].map((provider,i)=>({provider,status:'ok',plan:i?'Max':'Pro',updatedAt:new Date().toISOString(),windows:[{kind:'session',usedPercent:i?36:18,remainingPercent:i?64:82,resetsAt:new Date(Date.now()+7200000).toISOString()},{kind:'weekly',usedPercent:i?58:27,remainingPercent:i?42:73,resetsAt:new Date(Date.now()+3*86400000).toISOString()}]})) } };
  win = new BrowserWindow({ show: true, width: 440, height: 760, backgroundColor: '#17181a', webPreferences: { preload: path.join(root, 'src/electron/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, ...(process.env.TM_UPDATE_CONSENT === '1' ? { backgroundThrottling: false, offscreen: true } : {}) } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) { errors.push(message); console.log('RENDERER', message); } });
  win.webContents.on('render-process-gone', (_event, details) => { console.error(details); app.exit(1); });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [require('../src/electron/contentSecurityPolicy').contentSecurityPolicyForRequest(details)] } }));
  const handlers = {
    'settings:get': () => settings,
    'settings:displayPreview': (_event, surface, phase, slots) => require('../src/electron/displayPreview').buildDisplayPreview(settings, surface, phase, process.platform, Date.now(), slots),
    'settings:update': async (event, patch) => { const after = await runtime.beforeSettingsChange(event, patch); settings = { ...settings, ...patch }; runtime.settingsChanged(); win.webContents.send('settings:push',settings); await after(); return settings; },
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
  const patch=value=>{settings={...settings,...value};win.webContents.send('settings:push',settings);};
  runtime=createPluginRuntime({electron:{BrowserWindow:FixtureWindow,ipcMain,session:fixtureSessions,utilityProcess,safeStorage:fixtureSafeStorage,
   dialog:{showMessageBox:async()=>({response:1}),showOpenDialog:async()=>({canceled:false,filePaths:[fixtureDir]})}},
   userDataDir:scratch,getSettings:()=>settings,getAppSettings:()=>settings,getContext:()=>({source:'fixture'}),getLocale:()=>settings.language,
   isMainSender:event=>event.sender===win.webContents,persistPluginStates:pluginStates=>patch({pluginStates}),
   persistManagementSettings:patch,applySettingsPatch:patch,env:{},log:console.log});
  await runtime.start();runtime.publishStats(stats);
  await win.loadFile(path.join(root,'src/electron/renderer/index.html'));
  const js=source=>win.webContents.executeJavaScript(source);
  await waitFor("state.stats?.periods?.today?.totalTokens===125000",'init');
  const preview=await js("tokenMonitor.plugins.importPackage('directory')");
  await js(`tokenMonitor.plugins.install(${JSON.stringify(preview.token)},{trustInstall:true})`);
  await js("pluginApi.setEnabled('synthetic-limits',true)");
  await js("tokenMonitor.updateSettings({limitsEnabled:true,limitProviders:'claude,plugin:synthetic-limits:one,plugin:synthetic-limits:two',limitProviderOrder:'plugin:synthetic-limits:two,claude,plugin:synthetic-limits:one'})");
  await js("openViewFromTray('limits')");
  await waitFor("state.pluginCatalog?.limits?.providers?.length===2",'native module samples');
  const capture=async name=>{await pause(250);fs.writeFileSync(path.join(evidence,name),(await win.webContents.capturePage()).toPNG());};
  assert.deepEqual(await js("[...document.querySelectorAll('#limitsPanel > *')].map(node=>node.innerText.split('\\n')[0])"),['API balance','Claude','Claude']);
  assert.equal(await js("document.querySelector('#limitsPanel').textContent.includes('Synthetic Team')"),true,'documented plugin plan appears in native Limits');
  assert.equal(await js("state.pluginCatalog.limits.providers.find(row=>row.provider==='plugin:synthetic-limits:two').planLabel"),'','missing plan stays blank');
  assert.equal(await js("document.querySelector('#limitsPanel').textContent.includes('Daily pool')&&document.querySelector('#limitsPanel').textContent.includes('Billing pool')"),true,'non-credit daily and billing plugin quotas render');
  await capture('limits-mixed.png');
  await js("openSettingsPanel()");
  await waitFor("state.pluginCatalog.limits.modules.every(module=>!module.sampling)",'pause before transient reveal');
  await runtime.manager.call('synthetic-limits','fixture-status',{status:'error'});
  await js("openViewFromTray('limits')");
  await waitFor("state.pluginCatalog.limits.providers.find(row=>row.provider==='plugin:synthetic-limits:one')?.status==='error'",'transient reveal attempt');
  assert.equal(await js("state.pluginCatalog.limits.providers.find(row=>row.provider==='plugin:synthetic-limits:one').windows[0]?.remaining"),80,'transient reveal retains last-good quota');
  assert.equal(await js("document.querySelector('#limitsPanel').textContent.includes('$80.00')"),true,'last-good balance remains visible after failed reveal');
  await capture('limits-retained-error.png');
  await runtime.manager.call('synthetic-limits','fixture-status',{status:'ok'});
  await runtime.refreshLimits();
  await waitFor("state.pluginCatalog.limits.providers.find(row=>row.provider==='plugin:synthetic-limits:one')?.status==='ok'",'reveal recovers');
  await js("applyFloatingBubbleState({collapsed:true,side:'left'})");
  await waitFor("state.pluginCatalog.limits.modules.every(module=>!module.sampling)",'bubble releases quota demand');
  await js("applyFloatingBubbleState({collapsed:false})");
  await waitFor("state.pluginCatalog.limits.modules.every(module=>module.sampling)",'expand restores quota demand');
  await js("openSettingsPanel();setSettingsSectionExpanded('limits',true);renderLimitProviderCheckboxes();document.querySelector('[data-provider=\"plugin:synthetic-limits:one\"]').scrollIntoView({block:'center'})");
  await waitFor("document.querySelectorAll('.limit-provider-row[data-provider^=\"plugin:\"]').length===2",'mixed settings rows');
  await waitFor("state.pluginCatalog.limits.modules.every(module=>!module.sampling)",'settings releases quota demand');
  assert.deepEqual(await js("limitProviderRows().providers.slice(0,3).map(p=>p.id)"),['plugin:synthetic-limits:two','claude','plugin:synthetic-limits:one']);
  assert.equal(await js("window.quotaViewEvents?.filter(event=>event.type==='mount').length||0"),0,'collapsed quota views do not execute');
  await js("document.getElementById('limitProviderDisclosure-plugin:synthetic-limits:one').click()");
  await waitFor("document.querySelector('[data-limit-module=\"plugin:synthetic-limits:one\"] [data-quota-draft]')",'author settings view');
  const accountBox = `document.getElementById('limitProviderOptions-plugin:synthetic-limits:one').querySelector('.plugin-limit-account')`;
  await js(`${accountBox}.querySelector('button').click()`);
  await waitFor(`${accountBox}.querySelector('span').textContent===t('plugins.connection.state.connecting')`,'synthetic login starts');
  assert.ok(loginSession && loginWindow);
  await js("state.limitProviderRenderSignature='';renderLimitProviderCheckboxes()");
  await waitFor(`${accountBox}.querySelector('span').textContent===t('plugins.connection.state.connecting')`,'rebuilt row reads current connection');
  const request = {id:10,url:'https://api.openai.com/v1/dashboard/billing/credit_grants',method:'GET',webContentsId:loginWindow.webContents.id,
    requestHeaders:{Authorization:'Bearer synthetic-ui-account', 'OpenAI-Organization':'org-synthetic'}};
  loginSession.before(request, () => {});
  await loginSession.completed({...request,statusCode:200});
  await waitFor(`${accountBox}.querySelector('span').textContent===t('plugins.connection.state.connected')`,'login completion updates rebuilt row without Status click');
  assert.equal(await js("state.pluginCatalog.limits.modules.every(module=>!module.sampling)"),true,'connection notification does not start quota demand');
  await capture('settings-connected.png');
  await js(`(()=>{window.quotaDraftNode=document.querySelector('[data-limit-module="plugin:synthetic-limits:one"] [data-quota-draft]');quotaDraftNode.value='unsaved fixture';quotaDraftNode.focus();state.limitProviderRenderSignature='';renderLimitProviderCheckboxes();})()`);
  assert.equal(await js("quotaDraftNode===document.querySelector('[data-limit-module=\"plugin:synthetic-limits:one\"] [data-quota-draft]')&&quotaDraftNode.value==='unsaved fixture'&&document.activeElement===quotaDraftNode"),true,'row refresh retains controls, draft and focus');
  await js("setLimitProviderSettingsExpanded('')");
  await waitFor("quotaViewEvents.findLast(event=>event.id==='one'&&event.type==='visible')?.visible===false",'collapsed author visibility');
  await js("setLimitProviderSettingsExpanded('plugin:synthetic-limits:one')");
  assert.equal(await js("quotaDraftNode.value"),'unsaved fixture');
  assert.equal(await js("quotaViewEvents.filter(event=>event.id==='one'&&event.type==='mount').length"),1,'reopen retains instance');
  await js(`(()=>{quotaDraftNode.value='';const box=document.querySelector('[data-limit-module="plugin:synthetic-limits:one"]');box.querySelector('[data-quota-mode]').value='balance';box.querySelector('[data-quota-save]').click();})()`);
  await waitFor("document.querySelector('[data-limit-module=\"plugin:synthetic-limits:one\"] [data-quota-feedback]')?.textContent==='Saved'",'author saves through host settings');
  assert.equal((await runtime.manager.getAuthorSettings('synthetic-limits')).values.displayMode,'balance');
  await js("openViewFromTray('limits')");
  await runtime.manager.call('synthetic-limits','fixture-status',{status:'ok'});
  await runtime.refreshLimits();
  await waitFor("quotaViewEvents.findLast(event=>event.id==='one'&&event.type==='visible')?.visible===false",'closed settings stay hidden through backend pushes');
  await js("openSettingsPanel();setSettingsSectionExpanded('limits',true)");
  await waitFor("quotaViewEvents.findLast(event=>event.id==='one'&&event.type==='visible')?.visible===true",'reopen author settings');
  const settingsScroll = await js("els.settingsPanel.scrollTop");
  await js(`document.querySelector('[data-limit-module="plugin:synthetic-limits:one"]').scrollIntoView({block:'center'})`);
  await capture('settings-author.png');
  await js(`els.settingsPanel.scrollTop=${settingsScroll}`);
  const moduleTags = id => js(`[...document.querySelectorAll('[data-provider="plugin:synthetic-limits:${id}"] .limit-provider-tags .limit-provider-tag')].map(node=>node.textContent)`);
  assert.deepEqual(await moduleTags('one'), ['OAuth/Web/CLI','作者團隊池']);
  assert.deepEqual(await moduleTags('two'), ['API 金鑰','作者自填池','Token Plan']);
  await capture('settings-mixed.png');
  await js("tokenMonitor.updateSettings({language:'en',locale:'en'})");
  await waitFor(`document.querySelector('[data-provider="plugin:synthetic-limits:two"]').textContent.includes('Custom pool')`,'localized custom label');
  assert.deepEqual(await moduleTags('two'), ['API key','Custom pool','Token Plan']);
  await js("tokenMonitor.updateSettings({language:'zh-TW',locale:'zh-TW'})");
  await waitFor(`document.querySelector('[data-provider="plugin:synthetic-limits:two"]').textContent.includes('作者自填池')`,'restore localized labels');
  const statusSelector = '[data-provider="plugin:synthetic-limits:one"] .plugin-limit-status';
  assert.equal(await js(`document.querySelector(${JSON.stringify(statusSelector)})`),null,'healthy state has no duplicate pill');
  for (const [status,label] of [['notConfigured','尚未設定'],['unauthorized','需要重新連接'],['error','讀取失敗']]) {
    await runtime.manager.call('synthetic-limits','fixture-status',{status});
    await js("openViewFromTray('limits')");
    await waitFor("state.pluginCatalog.limits.modules.every(module=>module.sampling)",'quota visible');
    await runtime.refreshLimits();
    await js("openSettingsPanel();setSettingsSectionExpanded('limits',true);renderLimitProviderCheckboxes()");
    await waitFor(`document.querySelector(${JSON.stringify(statusSelector)})?.textContent===${JSON.stringify(label)}`,'right-side '+status);
    assert.equal(await js(`document.querySelectorAll('[data-provider="plugin:synthetic-limits:one"] .limit-provider-tags .limit-provider-tag-status').length`),0,'no duplicate left status');
    await capture('settings-'+status+'.png');
  }
  await runtime.manager.call('synthetic-limits','fixture-status',{status:'ok'});
  await js("openViewFromTray('limits')");
  await waitFor("state.pluginCatalog.limits.modules.every(module=>module.sampling)",'healthy quota visible');
  await runtime.refreshLimits();
  await js("openSettingsPanel();setSettingsSectionExpanded('limits',true);renderLimitProviderCheckboxes()");
  await waitFor(`!document.querySelector(${JSON.stringify(statusSelector)})`,'healthy state clears pill');

  await js("state.limitProviderSearchQuery='API balance';renderLimitProviderCheckboxes()");
  assert.deepEqual(await js("[...document.querySelectorAll('.limit-provider-row:not(.is-filtered-out)')].map(row=>row.dataset.provider)"),['plugin:synthetic-limits:two']);
  await js("state.limitProviderSearchQuery='';renderLimitProviderCheckboxes();onLimitProviderMove('plugin:synthetic-limits:one','up')");
  await waitFor("[...document.querySelectorAll('.limit-provider-row')][1]?.dataset.provider==='plugin:synthetic-limits:one'",'keyboard mixed reorder repaints');
  await js("onLimitProviderMove('plugin:synthetic-limits:one','down')");
  await waitFor("[...document.querySelectorAll('.limit-provider-row')][2]?.dataset.provider==='plugin:synthetic-limits:one'",'keyboard reorder restores');
  await pause(200);
  const drag = await js(`(() => {
    const source = document.getElementById('limitProviderDisclosure-plugin:synthetic-limits:one').getBoundingClientRect();
    const target = document.querySelector('.limit-provider-row').getBoundingClientRect();
    return {x:Math.round(source.x+source.width/2),from:Math.round(source.y+source.height/2),to:Math.round(target.y+2)};
  })()`);
  win.webContents.sendInputEvent({type:'mouseMove',x:drag.x,y:drag.from});
  win.webContents.sendInputEvent({type:'mouseDown',x:drag.x,y:drag.from,button:'left',clickCount:1});
  for(let i=1;i<=12;i++) { win.webContents.sendInputEvent({type:'mouseMove',x:drag.x,y:Math.round(drag.from+(drag.to-drag.from)*i/12),button:'left'}); await pause(20); }
  win.webContents.sendInputEvent({type:'mouseUp',x:drag.x,y:drag.to,button:'left',clickCount:1});
  await waitFor("state.settings.limitProviderOrder.split(',')[0]==='plugin:synthetic-limits:one'",'native mixed drag persistence');
  assert.equal(await js("state.settings.limitProviderOrder.split(',')[0]"),'plugin:synthetic-limits:one');
  await js("tokenMonitor.updateSettings({limitsEnabled:true,limitProviders:'claude,plugin:synthetic-limits:two'})");
  await js("openViewFromTray('limits')");
  await waitFor("document.querySelectorAll('#limitsPanel > *').length===2",'visibility');
  assert.equal((await moduleTags('one')).includes('自動'),false,'unchecked module has no host automatic sampling badge');
  await js("tokenMonitor.plugins.setEnabled('synthetic-limits',false)");
  await waitFor("state.pluginCatalog?.limits?.modules?.length===0",'disable removes modules');
  await waitFor("quotaViewEvents.some(event=>event.id==='one'&&event.type==='dispose')",'disable disposes author view');
  await js("openSettingsPanel();setSettingsSectionExpanded('limits',true);renderLimitProviderCheckboxes()");
  const beforeDisabledOrder = await js("state.settings.limitProviderOrder.split(',').filter(id=>id.startsWith('plugin:'))");
  await js("document.getElementById('limitProviderEnabled-codex').click()");
  await waitFor("state.settings.limitProviders.split(',').includes('codex')",'edit builtin selection while plugin disabled');
  assert.equal(await js("state.settings.limitProviders.split(',').includes('plugin:synthetic-limits:two')"),true,'disabled plugin selection retained');
  await js("onLimitProviderMove('codex','up')");
  assert.deepEqual(await js("state.settings.limitProviderOrder.split(',').filter(id=>id.startsWith('plugin:'))"),beforeDisabledOrder,'disabled plugin order retained');
  await js("tokenMonitor.plugins.setEnabled('synthetic-limits',true)");
  await waitFor("state.pluginCatalog?.limits?.modules?.length===2",'reenable restores modules');
  await js("tokenMonitor.plugins.reload()");
  await waitFor("state.pluginCatalog?.limits?.modules?.length===2",'reload retains modules');
  await js("tokenMonitor.plugins.restart('synthetic-limits')");
  const updated = JSON.parse(fs.readFileSync(path.join(fixtureDir,'manifest.json'))); updated.version = '1.0.1'; updated.limits.push({id:'plain',name:'Plain module'}); updated.limits[1].tags[0] = {en:'Updated pool','zh-TW':'更新後自填池'};
  fs.writeFileSync(path.join(fixtureDir,'manifest.json'),JSON.stringify(updated));
  const updatePreview = await js("tokenMonitor.plugins.importPackage('directory')");
  await js(`tokenMonitor.plugins.install(${JSON.stringify(updatePreview.token)},{trustUpdate:true})`);
  await waitFor("state.pluginCatalog?.plugins?.some(p=>p.version==='1.0.1')",'update');
  assert.equal(await js("state.settings.limitProviderOrder.split(',')[0]"),'plugin:synthetic-limits:one');
  await js("openSettingsPanel();setSettingsSectionExpanded('limits',true);renderLimitProviderCheckboxes()");
  await waitFor(`document.querySelector('[data-provider="plugin:synthetic-limits:two"]').textContent.includes('更新後自填池')`,'updated custom labels');
  assert.equal(await js("!!document.getElementById('limitProviderDisclosure-plugin:synthetic-limits:plain')"),false,'module with no controls has no empty disclosure');
  await js("openSettingsPanel();setSettingsSectionExpanded('plugins',true);pluginSettingsPanel.refresh()");
  await waitFor("document.querySelector('[data-plugin-id=\"synthetic-limits\"] .plugin-card-footer')",'installed plugin controls');
  await js(`(()=>{const card=document.querySelector('[data-plugin-id="synthetic-limits"]');[...card.querySelectorAll('button')].find(button=>button.textContent===t('plugins.connection.forget')).click();})()`);
  await waitFor("!state.pluginCatalog.limits.providers.some(row=>row.provider==='plugin:synthetic-limits:one')",'native forget clears captured connection quota');
  await js("document.querySelector('.plugin-type-filter').value='appearance';document.querySelector('.plugin-type-filter').dispatchEvent(new Event('change'))");
  await waitFor("document.querySelector('#pluginSettingsList').textContent.includes(t('plugins.catalog.noResults'))",'filtered installed empty state');
  await js("tokenMonitor.plugins.uninstall('synthetic-limits',{keepData:true})");
  await waitFor("state.pluginCatalog?.limits?.modules?.length===0",'uninstall');
  console.log('PASS custom quota UI: lazy mount, retained draft/focus, collapse visibility, host settings save, disable cleanup');
  console.log('PASS synthetic native Limits: mixed pointer drag/order, same-name identities, search, disclosure, visibility, disable, reenable, reload, restart, update, uninstall');
  console.log('Evidence:',evidence);
  clearTimeout(deadline);await runtime.dispose();win.destroy();app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
