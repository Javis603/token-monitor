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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-credit-limits-'));
const evidence = process.env.TM_PLUGIN_EVIDENCE || scratch;

const fixtureDir = path.join(scratch, 'source');
fs.mkdirSync(fixtureDir, { recursive: true });
const fixtureManifest = {tmApi:1,id:'synthetic-limits',name:'Synthetic limits',identityIcon:nativeImage.createFromBitmap(Buffer.from([80,180,130,255,80,180,130,255,80,180,130,255,80,180,130,255]),{width:2,height:2}).toDataURL(),version:'1.0.0',backend:'backend.cjs',ui:'settings.mjs',files:['backend.cjs','settings.mjs'],views:[{id:'quota-settings',title:'Quota preferences',surfaces:['settings']}],settings:{version:1,fields:[{id:'displayMode',type:'select',label:'Display mode',default:'meter',options:[{value:'meter',label:'Percentage + balance'},{value:'balance',label:'Balance only'}]}]},limits:[{id:'one',name:'Claude',settingsView:'quota-settings',credentials:{validation:true,fields:[{id:'token',label:'Platform session Bearer',required:true},{id:'cookies',label:'Cookies',control:'textarea'}]},capabilities:['cli','oauth','web'],tags:[{en:'Team pool','zh-TW':'作者團隊池'}]},{id:'two',name:'API balance',settingsView:'quota-settings',credentials:{fields:[{id:'token',label:'Token',required:true}]},capabilities:['api','apiKey'],tags:[{en:'Custom pool','zh-TW':'作者自填池'},'Token Plan']}]};
if(process.env.TM_PLUGIN_SETTINGS_AUTOSAVE_PROOF==='1')fixtureManifest.settings.fields.push({id:'showCost',type:'boolean',label:'顯示費用',default:false},{id:'label',type:'string',label:'顯示名稱',default:'Synthetic'},{id:'rows',type:'number',label:'列數',default:2,min:1,max:10,integer:true});
if(process.env.TM_PLUGIN_NATIVE_SURFACES_PROOF==='1'){fixtureManifest.limits[0].name='API credits';fixtureManifest.views.push({id:'native-card',title:'Custom panel',icon:'chart',surfaces:['edgeDock']});}
const fixtureSvg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect fill="#f06b77" x="2" y="2" width="20" height="20" rx="4"/><path fill="#ffdb70" d="M7 7h10v10H7z"/><line x1="4" y1="4" x2="20" y2="20" stroke="#ffffff"/></svg>').toString('base64');
fixtureManifest.presentation = { icon: { native: 'codex' }, color: { palette: 'codex' } };
fixtureManifest.limits[1].presentation = { icon: { data: fixtureSvg, mode: process.env.TM_PLUGIN_SVG_MASK === '1' ? 'mask' : 'image' }, color: { hex: '#d68cf0' } };
fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), JSON.stringify(fixtureManifest));
fs.writeFileSync(path.join(fixtureDir, 'backend.cjs'), `const fs=require('node:fs');const file=${JSON.stringify(path.join(scratch,'fixture-status.txt'))};exports.activate=async({host})=>({call:async(method,args)=>{if(method==='fixture-read'){const value=await host.call('credentials.read',{moduleId:args.moduleId});return {configured:value.token==='synthetic-token'};}if(method==='fixture-network'){const value=await host.call('credentials.read',{moduleId:args.moduleId});return host.call('network.request',{moduleId:args.moduleId,requestId:'fixture-probe',url:'https://example.test/quota',headers:{Authorization:'Bearer '+value.token}});}if(method==='fixture-status'){fs.writeFileSync(file,args.status);return true;}const {moduleId}=args;if(method==='fixture-check-count')return fs.existsSync(file+'.checks')?Number(fs.readFileSync(file+'.checks','utf8')):0;if(method==='credentials.validate'){fs.writeFileSync(file+'.checks',String(1+(fs.existsSync(file+'.checks')?Number(fs.readFileSync(file+'.checks','utf8')):0)));await new Promise(resolve=>setTimeout(resolve,150));await host.call('credentials.read',{moduleId,expectedRevision:args.revision});return {status:fs.existsSync(file+'.validation')?fs.readFileSync(file+'.validation','utf8'):'valid'};}if(method==='fixture-validation'){fs.writeFileSync(file+'.validation',args.status);return true;}if(method==='fixture-layout'){fs.writeFileSync(file+'.layout',JSON.stringify(args));return true;}if(method==='fixture-window'){fs.writeFileSync(file+'.window',JSON.stringify(args));return true;}const status=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'ok';return{status:moduleId==='one'?status:'ok',plan:moduleId==='one'?'Synthetic Team':undefined,notes:moduleId==='two'&&fs.existsSync(file+'.layout')?JSON.parse(fs.readFileSync(file+'.layout','utf8')).notes:undefined,windows:moduleId==='one'&&status==='error'?[]:moduleId==='two'&&fs.existsSync(file+'.layout')?JSON.parse(fs.readFileSync(file+'.layout','utf8')).windows:moduleId==='two'?[{kind:'daily',label:'Daily pool',usedPercent:25,remainingPercent:75},{kind:'billing',label:'Billing pool',usedPercent:40,remainingPercent:60}]:[{kind:'billing',label:'API credits',metric:'credits',used:moduleId==='one'?20:40,limit:100,remaining:moduleId==='one'?80:60,currency:'USD',usedPercent:moduleId==='one'?20:40,remainingPercent:moduleId==='one'?80:60,...(fs.existsSync(file+'.window')?JSON.parse(fs.readFileSync(file+'.window','utf8')):{})}]};}});`);
fs.writeFileSync(path.join(fixtureDir,'settings.mjs'), `
export async function activate(ctx) {
  window.quotaViewEvents ||= [];
  return {async mount(container,context) {
    const id=context.moduleId;
    if(!id){container.textContent='Open quota settings to edit credentials.';return {dispose(){container.replaceChildren();}};}
    window.quotaViewEvents.push({type:'mount',id});
    let snapshot=await ctx.host.call('settings.get');
    container.innerHTML='<label class="settings-item"><span class="settings-item-text">Display mode</span><select data-quota-mode><option value="meter">Percentage + balance</option><option value="balance">Balance only</option></select></label><label class="settings-item"><span class="settings-item-text">Organization draft</span><input data-quota-draft placeholder="Synthetic organization" /></label><div class="settings-actions"><button data-quota-save>Save preferences</button><span data-quota-feedback></span></div>';
    const mode=container.querySelector('[data-quota-mode]'),draft=container.querySelector('[data-quota-draft]');
    let credentialEditor;
    if(id==='one') {
      const extra=document.createElement('p');extra.dataset.credentialHelp='';extra.textContent='Author explanation + shared native credentials';container.prepend(extra);
      credentialEditor=await ctx.native.credentials.mount(container,{moduleId:id,onStateChange(state){extra.hidden=!state.editing;(window.credentialUiStates ||= []).push(state);window.credentialUiState=state;}});
    } else {
      let saved=await ctx.host.call('credentials.status',{moduleId:id});
      const editor=document.createElement('div');editor.innerHTML='<p>Custom author layout</p><input type="password" data-custom-token placeholder="Token (saved value never loaded)" /><div class="settings-actions"><button data-custom-save>Save custom credentials</button><span data-custom-result class="settings-note"></span></div>';
      container.append(editor);const token=editor.querySelector('[data-custom-token]');token.className='credential-input';
      editor.querySelector('[data-custom-save]').onclick=async()=>{try{saved=await ctx.host.call('credentials.update',{moduleId:id,expectedRevision:saved.revision,patch:{token:token.value}});token.value='';editor.querySelector('[data-custom-result]').textContent='Saved';}catch{editor.querySelector('[data-custom-result]').textContent='Failed';}};
      credentialEditor={update(){},hasUnsavedChanges:()=>!!token.value,dispose(){editor.remove();}};
    }
    if (${process.env.TM_CREDENTIAL_LAYOUT_PROOF === '1'}) {
      container.querySelector('[data-quota-draft]').closest('label').hidden=true;
      container.querySelector('[data-quota-mode]').closest('label').querySelector('span').textContent='餘額顯示方式';
      mode.options[0].textContent='進度條及餘額';mode.options[1].textContent='僅顯示餘額';
      container.querySelector('[data-quota-save]').textContent='儲存設定';
      const helper=container.querySelector('.plugin-credential-form');
      if(helper)container.prepend(helper);
      const help=container.querySelector('[data-credential-help]');
      if(help){help.className='settings-note';help.textContent='貼上服務提供的憑證；已儲存的值不會重新填入。';}
    }
    mode.value=snapshot.values.displayMode;
    container.querySelector('[data-quota-save]').onclick=async()=>{
      snapshot=await ctx.host.call('settings.update',{schemaVersion:snapshot.schemaVersion,expectedRevision:snapshot.revision,patch:{displayMode:mode.value}});
      container.querySelector('[data-quota-feedback]').textContent='Saved';
    };
    return {update(value){void credentialEditor.update(value);window.quotaViewEvents.push({type:'visible',id,visible:value.visible});},hasUnsavedChanges(){return credentialEditor.hasUnsavedChanges()||!!draft.value||mode.value!==snapshot.values.displayMode;},dispose(){credentialEditor.dispose();window.quotaViewEvents.push({type:'dispose',id});container.replaceChildren();}};
  }};
}
`);
fs.mkdirSync(evidence,{recursive:true});
app.setPath('userData',path.join(scratch,'profile'));
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
registerPluginScheme(protocol);
app.on('window-all-closed',()=>{});
let runtime,win;
let packageSource=fixtureDir;
let transportCalls=[], fixtureConsent=1, credentialConfirmations=0;
const errors=[];
const nativeProofSurfaces = new Map();
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
    'settings:displayPreview': (_event, surface, phase, slots) => require('../src/electron/displayPreview').buildDisplayPreview(settings, surface, phase, process.platform, Date.now(), slots, runtime?.limitsSnapshot()),
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
  runtime=createPluginRuntime({electron:{BrowserWindow,ipcMain,session,utilityProcess,
   dialog:{showMessageBox:async(_win,options)=>{if(options.message===require('../src/electron/renderer/i18n').translate(settings.language,'plugins.credentials.forgetConfirm'))credentialConfirmations++;return {response:fixtureConsent};},showOpenDialog:async()=>({canceled:false,filePaths:[packageSource]})}},
   fetchImpl:async(url,init)=>{transportCalls.push({url,init});return new Response('{"remaining":80}',{status:200});},userDataDir:scratch,getSettings:()=>settings,getAppSettings:()=>settings,getContext:()=>({source:'fixture'}),getLocale:()=>settings.language,
   isMainSender:event=>event.sender===win.webContents,isSurfaceSender:(event,surface)=>nativeProofSurfaces.get(event.sender.id)===surface,surfaceContext:(event,surface)=>nativeProofSurfaces.get(event.sender.id)===surface?{visible:true,summaryVisible:true}:null,persistPluginStates:pluginStates=>patch({pluginStates}),
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
  const capture=async name=>{
    await pause(250);
    if(process.env.TM_CREDENTIAL_LAYOUT_PROOF==='1')await js("(()=>{for(let node=els.settingsPanel.parentElement;node;node=node.parentElement)node.scrollTop=0;window.scrollTo(0,0);})()");
    if(process.env.TM_PLUGIN_SETTINGS_AUTOSAVE_PROOF==='1') {
      await js("(()=>{const target=document.querySelector('.plugin-author-form');els.settingsPanel.scrollTop+=target.getBoundingClientRect().top-els.settingsPanel.getBoundingClientRect().top-150;})()");
      await pause(80);
      const frame=await js("(()=>{const a=document.querySelector('.plugin-author-form').getBoundingClientRect(),p=els.settingsPanel.getBoundingClientRect();return {form:a.toJSON(),panel:p.toJSON(),scroll:els.settingsPanel.scrollTop,height:els.settingsPanel.scrollHeight};})()");
      console.log('native settings viewport',JSON.stringify(frame));
      assert.ok(frame.form.top>=frame.panel.top&&frame.form.bottom<=frame.panel.bottom,'settings controls must be visible in native proof');
    }
    fs.writeFileSync(path.join(evidence,name),(await win.webContents.capturePage()).toPNG());
  };
  if (process.env.TM_PLUGIN_NATIVE_SURFACES_PROOF === '1') {
    await require('./plugin-native-surfaces-proof.cjs')({ BrowserWindow, ipcMain, win, runtime, settings, stats, root, evidence, js, waitFor, capture, nativeProofSurfaces });
    console.log('PASS native plugin quota surfaces. Evidence:', evidence);
    await runtime.dispose(); win.destroy(); clearTimeout(deadline); app.exit(0); return;
  }
  if (process.env.TM_PLUGIN_SETTINGS_AUTOSAVE_PROOF === '1') {
    if(process.env.TM_PLUGIN_SETTINGS_SOURCE){
      await js(fs.readFileSync(process.env.TM_PLUGIN_SETTINGS_SOURCE,'utf8'));
      const appSource=fs.readFileSync(path.join(root,'src/electron/renderer/app.js'),'utf8');
      const start=appSource.indexOf('pluginSettingsPanel = pluginApi && window.TokenMonitorPluginSettings');
      const end=appSource.indexOf('}) : null;',start)+'}) : null;'.length;
      assert.ok(start>=0&&end>start);
      await js('pluginSettingsPanel.dispose();'+appSource.slice(start,end)+';true');
    }
    await js("openSettingsPanel();setSettingsSectionExpanded('plugins',true);pluginSettingsPanel.refresh()");
    await waitFor("document.querySelector('.plugin-manage')",'plugin management');
    await js(`document.querySelector('[data-plugin-id="${fixtureManifest.id}"] .plugin-manage').click()`);
    await waitFor("document.querySelector('.plugin-author-form select')",'native declarative settings form');
    await js("document.querySelector('.plugin-author-settings').scrollIntoView({block:'center'})");
    await capture('plugin-settings-before-change.png');
    if(process.env.TM_PLUGIN_SETTINGS_SOURCE&&!process.env.TM_PLUGIN_BUSY_SETTINGS_PROOF){console.log('PASS baseline native manual-settings capture. Evidence:',evidence);await runtime.dispose();win.destroy();app.exit(0);return;}
    assert.equal(await js("!!document.querySelector('[data-control-key=author-save]')"),false,'no routine Save button');
    await js("(()=>{const select=document.querySelector('.plugin-author-form select');select.focus();window.ordinaryControl=select;select.value='balance';select.dispatchEvent(new Event('change'));})()");
    await waitFor(`document.querySelector('.plugin-author-status').hidden&&!document.querySelector('[data-control-key=author-reload]').getAttribute('disabled')`,'autosave feedback settles');
    const saved=await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`);
    assert.equal(saved.values.displayMode,'balance','select saved without a Save action');
    assert.equal(await js("document.activeElement===ordinaryControl"),true,'save preserves focus');
    await js("pluginSettingsPanel.refresh()");await pause(150);
    assert.equal(await js("document.querySelector('.plugin-author-form select')===ordinaryControl"),true,'refresh retains native form controls');
    assert.equal(await js("document.activeElement===ordinaryControl"),true,'refresh preserves focus');
    await capture('plugin-settings-autosaved.png');
    await js("(()=>{const input=document.querySelector('[data-control-key=author-showCost]');input.checked=true;input.dispatchEvent(new Event('change'));})()");
    await waitFor("document.querySelector('.plugin-author-status').hidden",'boolean autosaves');
    assert.equal((await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`)).values.showCost,true);
    await js("(()=>{const input=document.querySelector('[data-control-key=author-label]');input.focus();window.textControl=input;input.value='New label';input.dispatchEvent(new Event('input'));input.setSelectionRange(2,5);})()");
    const textBase=await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`);
    assert.equal(textBase.values.label,'Synthetic','text does not save mid-input');
    await js("pluginSettingsPanel.refresh()");await pause(100);
    assert.deepEqual(await js("[document.activeElement===textControl,textControl.value,textControl.selectionStart,textControl.selectionEnd]"),[true,'New label',2,5]);
    await js("textControl.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));textControl.dispatchEvent(new Event('change'))");await waitFor("document.querySelector('.plugin-author-status').hidden",'completed text saves');
    const textSaved=await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`);
    assert.equal(textSaved.values.label,'New label');
    assert.equal(textSaved.revision,textBase.revision+1,'Enter then blur saves one revision');
    await js("textControl.blur();textControl.focus();textControl.value='Intermediate label';textControl.dispatchEvent(new Event('input'));textControl.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
    await waitFor("document.querySelector('.plugin-author-status').hidden",'Enter saves intermediate value');
    assert.equal((await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`)).values.label,'Intermediate label');
    await js("textControl.value='New label';textControl.dispatchEvent(new Event('input'));textControl.blur()");
    await waitFor("document.querySelector('.plugin-author-status').hidden",'blur completes return to focus-entry value');
    assert.equal((await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`)).values.label,'New label','blur saves final draft without relying on change');
    await js("(()=>{window.restoreSetEnabled=pluginApi.setEnabled;pluginApi.setEnabled=()=>new Promise(resolve=>{window.releaseSettingsManagement=async()=>resolve(await pluginApi.list());});textControl.focus();const toggle=document.querySelector('.plugin-detail .plugin-enable');toggle.checked=!toggle.checked;toggle.dispatchEvent(new Event('change'));})()");
    await waitFor("typeof releaseSettingsManagement==='function'",'management action pending');
    assert.equal(await js("textControl.disabled"),false,'focused field stays editable during management');
    await js("textControl.value='Edited while busy';textControl.dispatchEvent(new Event('input'));textControl.dispatchEvent(new Event('change'))");
    await pause(80);
    assert.equal((await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`)).values.label,'New label','management holds completed writes');
    await js("releaseSettingsManagement();pluginApi.setEnabled=restoreSetEnabled;true");
    await waitFor("document.querySelector('.plugin-author-status').hidden&&document.querySelector('.plugin-detail').closest('[aria-busy]')?.getAttribute('aria-busy')==='false'",'management releases completed edit');
    assert.equal((await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`)).values.label,'Edited while busy','focused busy edit saved after management');
    assert.equal(await js("textControl.value"),'Edited while busy','management render preserves the edit');
    await js("(()=>{window.restoreSettingsUpdate=pluginApi.updateSettings;pluginApi.updateSettings=async()=>{throw Error('synthetic storage failure');};textControl.value='Unsaved after failure';textControl.dispatchEvent(new Event('input'));textControl.dispatchEvent(new Event('change'));})()");
    await waitFor("!document.querySelector('[data-control-key=author-retry]').hidden",'failed save offers recovery');
    await js("pluginApi.updateSettings=restoreSettingsUpdate;window.packageAttempts=0;window.restoreUninstall=pluginApi.uninstall;pluginApi.uninstall=async()=>{packageAttempts++;return pluginApi.list();};document.querySelector('.plugin-detail-utilities button:last-child').click();true");
    await js("[...document.querySelectorAll('.plugin-detail .plugin-consent-actions button')].find(button=>button.textContent===t('plugins.package.uninstall')).click()");
    await waitFor("document.querySelector('.plugin-detail').closest('[aria-busy]')?.getAttribute('aria-busy')==='false'",'package action settles');
    assert.equal(await js("packageAttempts"),0,'failed draft blocks package changes');
    assert.equal(await js("document.querySelector('[data-control-key=author-label]').value"),'Unsaved after failure','blocked package change retains draft');
    assert.equal(await js("document.querySelector('[data-control-key=author-reload]').hidden"),false,'failed draft offers explicit discard');
    await js("document.querySelector('[data-control-key=author-reload]').click()");
    await waitFor("document.querySelector('[data-control-key=author-label]').value==='Edited while busy'",'explicit reload discards failed draft');
    await js("[...document.querySelectorAll('.plugin-detail .plugin-consent-actions button')].find(button=>button.textContent===t('plugins.package.uninstall')).click()");
    await waitFor("packageAttempts===1&&document.querySelector('.plugin-detail').closest('[aria-busy]')?.getAttribute('aria-busy')==='false'",'recovered package action allowed');
    await js("pluginApi.uninstall=restoreUninstall;true");
    await js("(()=>{const input=document.querySelector('[data-control-key=author-rows]');input.value='0';input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('change'));})()");
    await waitFor("document.querySelector('[data-control-key=author-rows]').getAttribute('aria-invalid')==='true'",'invalid number remains visible');
    await js("(()=>{const input=document.querySelector('.plugin-author-form select');input.value='meter';input.dispatchEvent(new Event('change'));})()");
    await waitFor("document.querySelector('.plugin-author-status').textContent!==t('plugins.authorSettings.saving')",'other valid control saves despite invalid draft');
    assert.equal((await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`)).values.displayMode,'meter');
    assert.equal(await js("document.querySelector('[data-control-key=author-rows]').getAttribute('aria-invalid')"),'true','invalid draft/error stays visible');
    await js("(()=>{const input=document.querySelector('[data-control-key=author-rows]');input.value='3';input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('change'));})()");
    await waitFor("document.querySelector('.plugin-author-status').hidden",'corrected number saves');
    assert.equal((await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`)).values.rows,3);
    await capture('plugin-settings-controls.png');
    await js("(()=>{const trigger=document.querySelector('.plugin-author-heading .plugin-more');trigger.click();})()");
    await waitFor("document.querySelector('.plugin-author-heading .plugin-menu').matches(':popover-open')",'secondary settings menu');
    await capture('plugin-settings-defaults-menu.png');
    await js("document.querySelector('.plugin-author-heading .plugin-menu button').click()");
    await waitFor("document.querySelector('.plugin-author-status').hidden",'defaults apply without Save');
    assert.equal((await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`)).values.label,'Synthetic');

    const externalBase=await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`);
    await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.update',{schemaVersion:${externalBase.schemaVersion},expectedRevision:${externalBase.revision},patch:{displayMode:'balance'}})`);
    await js("(()=>{const select=document.querySelector('.plugin-author-form select');select.value='balance';select.dispatchEvent(new Event('change'));})()");
    await waitFor("!document.querySelector('[data-control-key=author-reload]').hidden",'conflict offers explicit reload');
    await capture('plugin-settings-conflict.png');
    await js("document.querySelector('[data-control-key=author-reload]').click()");
    await waitFor("document.querySelector('.plugin-author-form select')?.value==='balance'&&document.querySelector('[data-control-key=author-reload]').hidden",'reload recovers');
    const second=path.join(scratch,'second-settings-plugin');fs.cpSync(fixtureDir,second,{recursive:true});
    const secondManifest={...fixtureManifest,id:'synthetic-settings-two',name:'Second settings plugin'};fs.writeFileSync(path.join(second,'manifest.json'),JSON.stringify(secondManifest));
    packageSource=second;
    const secondPreview=await js("tokenMonitor.plugins.importPackage('directory')");await js(`tokenMonitor.plugins.install(${JSON.stringify(secondPreview.token)},{trustInstall:false})`);
    await js("document.querySelector('.plugin-detail .plugin-back').click();pluginSettingsPanel.refresh()");
    await waitFor("document.querySelector('[data-plugin-id=synthetic-settings-two] .plugin-manage')",'second disabled plugin');
    await js("document.querySelector('[data-plugin-id=synthetic-settings-two] .plugin-manage').click()");
    await waitFor("document.querySelector('.plugin-author-form select')",'disabled plugin settings');
    await js("(()=>{const input=document.querySelector('.plugin-author-form select');input.value='balance';input.dispatchEvent(new Event('change'));})()");
    await waitFor("document.querySelector('.plugin-author-status').hidden",'second plugin autosaves independently');
    assert.equal((await js("tokenMonitor.plugins.getSettings('synthetic-settings-two')")).values.displayMode,'balance');
    assert.equal((await js(`tokenMonitorTrustedPlugins.host('${fixtureManifest.id}','settings.get')`)).values.displayMode,'balance','first plugin stays at external saved value');
    await capture('plugin-settings-second-plugin.png');
    console.log('PASS native shared settings autosave, no Save row, durable select, retained focus/control and conflict recovery. Evidence:',evidence);
    await runtime.dispose();win.destroy();app.exit(0);return;
  }
  if (process.env.TM_CREDENTIAL_LAYOUT_PROOF === '1') {
    if (process.env.TM_CREDENTIAL_CONTROLLER_SOURCE) await js(fs.readFileSync(process.env.TM_CREDENTIAL_CONTROLLER_SOURCE, 'utf8'));
    await js("openSettingsPanel();setSettingsSectionExpanded('limits',true);renderLimitProviderCheckboxes();document.getElementById('limitProviderDisclosure-plugin:synthetic-limits:one').click()");
    const box=`document.querySelector('[data-limit-module="plugin:synthetic-limits:one"] .plugin-credential-form')`;
    await waitFor(box,'real Settings credential form');
    await js(`${box}.closest('.limit-provider-row').scrollIntoView({block:'center'})`);
    await capture('settings-credentials-empty.png');
    await js(`(()=>{const input=${box}.querySelector('input');input.value='synthetic-token';input.dispatchEvent(new Event('input'));${box}.querySelector('[data-credential-action=save]').click();})()`);
    await waitFor(`${box}.querySelector('.plugin-credential-editor').hidden&&!${box}.querySelector('[data-credential-action=save]').disabled&&credentialUiState.verification==='valid'`,'verified credentials collapse');
    await js('window.scrollTo(0,0)');
    await capture('settings-credentials-connected.png');
    if (process.env.TM_CREDENTIAL_RETRY_PROOF === '1') {
      const checks=await runtime.manager.call(fixtureManifest.id,'fixture-check-count',{});
      await js(`tokenMonitor.plugins.restart('${fixtureManifest.id}')`);
      await waitFor("credentialUiState.verification==='unverified'&&!credentialUiState.pending",'restart shows saved presence without a validation request');
      assert.equal(await runtime.manager.call(fixtureManifest.id,'fixture-check-count',{}),checks,'Settings restart does not verify saved credentials');
      await waitFor(`document.querySelector('[data-provider="plugin:${fixtureManifest.id}:one"] .plugin-limit-status')?.textContent===t('plugins.credentials.status.configured')`,'saved status reaches the native header');
      await capture('settings-credentials-configured.png');
      if (process.env.TM_CREDENTIAL_LAYOUT_AFTER === '1') {
        assert.equal(await js(`${box}.querySelector('.plugin-credential-editor').hidden`),true,'configured credentials remain compact');
        assert.equal(await js(`${box}.querySelector('[data-credential-action=verify]').hidden`),true,'no routine verify action');
        assert.equal(await js(`document.querySelector('[data-provider="plugin:${fixtureManifest.id}:one"] .plugin-limit-status').textContent`),await js("t('plugins.credentials.status.configured')"));
      }
    }
    if (process.env.TM_CREDENTIAL_LAYOUT_AFTER === '1') {
      assert.equal(await js(`${box}.querySelector('[role="status"]').hidden`),true,'no duplicate inline status');
      await waitFor(`document.querySelector('[data-provider="plugin:synthetic-limits:one"] .plugin-limit-status')?.textContent===t('${process.env.TM_CREDENTIAL_RETRY_PROOF === '1' ? 'plugins.credentials.status.configured' : 'plugins.credentials.valid'}')`,'credential status in native header');
    }
    await js(`${box}.querySelector('[data-credential-action=edit]').click()`);
    await capture('settings-credentials-edit.png');
    await runtime.manager.call(fixtureManifest.id,'fixture-validation',{status:'rejected'});
    // Save a replacement through the editor to exercise rejected validation.
    await js(`(()=>{const input=${box}.querySelector('input');input.value='synthetic-replacement';input.dispatchEvent(new Event('input'));${box}.querySelector('[data-credential-action=save]').click();})()`);
    await waitFor(`${box}.querySelector('[role="status"]').textContent===t('plugins.credentials.rejected')&&!${box}.querySelector('[data-credential-action=save]').disabled`,'rejected replacement');
    await capture('settings-credentials-rejected.png');
    if (process.env.TM_CREDENTIAL_LAYOUT_AFTER === '1') {
      await waitFor(`document.querySelector('[data-provider="plugin:synthetic-limits:one"] .plugin-limit-status')?.textContent===t('plugins.credentials.status.rejected')`,'rejected status in native header');
      assert.equal(await js(`${box}.querySelector('.plugin-credential-editor').hidden`),false);
    }
    if (process.env.TM_CREDENTIAL_RETRY_PROOF === '1') {
      assert.equal(await js(`${box}.querySelector('[data-credential-action=verify]').hidden`),false,'failed check offers retry');
      if (process.env.TM_CREDENTIAL_LAYOUT_AFTER === '1') assert.equal(await js(`${box}.querySelector('[data-credential-action=verify]').textContent`),await js("t('plugins.credentials.retry')"));
      await runtime.manager.call(fixtureManifest.id,'fixture-validation',{status:'valid'});
      await js(`${box}.querySelector('[data-credential-action=verify]').click()`);
      await waitFor(`${box}.querySelector('.plugin-credential-editor').hidden&&!${box}.querySelector('[data-credential-action=save]').disabled`,'retry validates and collapses');
      assert.equal(await js(`${box}.querySelector('[data-credential-action=verify]').hidden`),true,'success removes retry');
      await capture('settings-credentials-retry-success.png');
    }
    console.log('PASS real Settings credential layout, verified/edit/rejected states; Evidence:',evidence);
    await runtime.dispose();win.destroy();app.exit(0);return;
  }
  if (process.env.TM_CREDENTIAL_RECOVERY_PROOF === '1') {
    const before = process.env.TM_CREDENTIAL_CONTROLLER_SOURCE;
    if (before) await js(fs.readFileSync(before, 'utf8'));
    await js(`(async()=>{
      const host=(method,args)=>tokenMonitorTrustedPlugins.host(${JSON.stringify(fixtureManifest.id)},method,args);
      const initial=await host('credentials.status',{moduleId:'two'});
      await host('credentials.update',{moduleId:'two',expectedRevision:initial.revision,patch:{token:'synthetic-initial'}});
      const panel=document.createElement('section');panel.className='settings-section';
      Object.assign(panel.style,{position:'fixed',inset:'0',zIndex:'999',background:'#24282a',padding:'28px 22px',overflow:'auto'});
      const title=document.createElement('h2');title.textContent='合成憑證衝突測試';
      const context=document.createElement('p');context.className='settings-note';context.textContent='另一個編輯器已更新憑證；此表單尚未重新載入。';
      const result=document.createElement('p');result.className='settings-note';result.id='recoveryResult';
      panel.append(title,context);document.body.append(panel);
      window.recoveryEditor=await TokenMonitorPluginCredentials.create({document,call:host,t,localize:value=>value['']||value.en||value}).mount(panel,{moduleId:'two'});
      panel.append(result);
      const current=await host('credentials.status',{moduleId:'two'});
      await host('credentials.update',{moduleId:'two',expectedRevision:current.revision,patch:{token:'synthetic-other-editor'}});
      window.recoveryHost=host;window.recoveryPanel=panel;
      panel.querySelector('[data-credential-action=clear]').click();
    })()`);
    await waitFor("recoveryPanel.querySelector('[data-credential-action=reload]').hidden===false",'conflicting clear is visible');
    await capture('credential-conflict-initial.png');
    await js("recoveryEditor.update({visible:true})");
    const beforeRevision=await js("recoveryHost('credentials.status',{moduleId:'two'}).then(value=>value.revision)");
    await js("(()=>{const input=recoveryPanel.querySelector('input');input.value='synthetic-replacement';input.dispatchEvent(new Event('input'));recoveryPanel.querySelector('[data-credential-action=save]').click();})()");
    await waitFor("!recoveryPanel.querySelector('[data-credential-action=save]').disabled",'save attempt settles');
    const afterRevision=await js("recoveryHost('credentials.status',{moduleId:'two'}).then(value=>value.revision)");
    if (before) {
      assert.equal(afterRevision,beforeRevision+1,'baseline silently rebases and saves without reload');
      assert.equal(await js("recoveryPanel.querySelector('input').value"),'');
      await js("document.getElementById('recoveryResult').textContent='修正前：未重新載入，但修改已寫入。'");
    } else {
      assert.equal(afterRevision,beforeRevision,'fixed editor preserves conflict revision');
      assert.equal(await js("recoveryPanel.querySelector('input').value"),'synthetic-replacement');
      assert.equal(await js("recoveryPanel.querySelector('[data-credential-action=reload]').hidden"),false);
      await js("document.getElementById('recoveryResult').textContent='修正後：仍然拒絕寫入，草稿保留；請先重新載入。'");
    }
    await capture('credential-conflict-after-background-update.png');
    if (!before) {
      await js("recoveryPanel.querySelector('[data-credential-action=reload]').click()");
      await waitFor("recoveryPanel.querySelector('[data-credential-action=reload]').hidden",'explicit revision reload');
      assert.equal(await js("recoveryPanel.querySelector('input').value"),'synthetic-replacement');
      await js("recoveryPanel.querySelector('[data-credential-action=save]').click()");
      await waitFor("recoveryPanel.querySelector('input').value===''",'explicit reload permits save');
    }
    console.log('PASS native synthetic credential conflict proof:',before?'BEFORE: silently overwritten':'AFTER: blocked until explicit reload; draft retained');
    console.log('Evidence:',evidence);
    await runtime.dispose();win.destroy();app.exit(0);return;
  }
  assert.deepEqual(await js("[...document.querySelectorAll('#limitsPanel > *')].map(node=>node.innerText.split('\\n')[0])"),['API balance','Claude','Claude']);
  assert.equal(await js("document.querySelector('#limitsPanel').textContent.includes('Synthetic Team')"),true,'documented plugin plan appears in native Limits');
  assert.equal(await js("state.pluginCatalog.limits.providers.find(row=>row.provider==='plugin:synthetic-limits:two').planLabel"),'','missing plan stays blank');
  assert.equal(await js("document.querySelector('#limitsPanel').textContent.includes('Daily pool')&&document.querySelector('#limitsPanel').textContent.includes('Billing pool')"),true,'non-credit daily and billing plugin quotas render');
  await waitFor("document.querySelector('#limitsPanel .limit-name .row-icon-codex')",'native Codex mask decodes');
  const imageMode = process.env.TM_PLUGIN_SVG_MASK !== '1';
  if (imageMode) {
    await waitFor("document.querySelector('#limitsPanel .limit-name img')?.naturalWidth>0",'custom multicolor SVG decodes');
    assert.equal(await js("document.querySelector('#limitsPanel .limit-name img').src.startsWith('data:image/svg+xml;base64,')"),true);
    await js("document.querySelector('#limitsPanel .limit-name img').dispatchEvent(new Event('error'))");
    await waitFor("document.querySelector('#limitsPanel .limit-name img')?.naturalWidth>0",'PNG identity fallback decodes');
    assert.equal(await js("document.querySelector('#limitsPanel .limit-name img').src.startsWith('data:image/png;base64,')"),true);
    await js("document.querySelector('#limitsPanel .limit-name img').dispatchEvent(new Event('error'))");
    assert.equal(await js("!!document.querySelector('#limitsPanel .limit-name .pv-icon')"),true,'failed artwork ultimately uses shared fallback');
  } else {
    await waitFor("document.querySelector('#limitsPanel > :first-child .limit-name span[style*=mask-image]')",'custom SVG mask decodes');
  }
  await js("state.limitPanelRenderSignature='';renderLimits()");
  await capture('presentation-native-and-custom.png');
  assert.equal(await js("limitProviderColor(state.pluginCatalog.limits.modules.find(m=>m.moduleId==='one').id)===clientColors.codex"),true);
  assert.equal(await js("limitProviderColor(state.pluginCatalog.limits.modules.find(m=>m.moduleId==='two').id)"),'#d68cf0');
  const beforePalette = await js("clientColors.codex");
  await js("tokenMonitor.updateSettings({vendorColors:{...state.settings.vendorColors,codex:'#efab45'}})");
  await waitFor("clientColors.codex==='#efab45'",'live Codex user override');
  assert.equal(await js("limitProviderColor(state.pluginCatalog.limits.modules.find(m=>m.moduleId==='one').id)"),'#efab45');
  assert.equal(await js("limitProviderColor(state.pluginCatalog.limits.modules.find(m=>m.moduleId==='two').id)"),'#d68cf0');
  await capture('presentation-user-palette.png');
  await js(`tokenMonitor.updateSettings({vendorColors:{codex:${JSON.stringify(beforePalette)}}})`);
  await capture('limits-mixed.png');
  const detailRows=[{label:'Today',value:{amount:0.25,currency:'USD'}},{label:'Week',value:{amount:1.5,currency:'USD'}},{label:'Month',value:{amount:4.25,currency:'USD'}},{label:'All time',value:{amount:12,currency:'USD'}}];
  const layouts={windows:[
    {kind:'session',label:'5-hour',usedPercent:3,span:1,infoRows:[{label:'Scope',value:'Synthetic team pool'}]},
    {kind:'weekly',usedPercent:11,span:1},
    {kind:'billing',label:'Monthly',metric:'credits',remaining:54.89,limit:70,currency:'USD',creditsDisplay:'percent',span:2},
    {kind:'daily',label:'Daily pool',usedPercent:25,span:1},
    {kind:'billing',label:'Credit pool',metric:'credits',remaining:83.25,limit:100,currency:'USD',creditsDisplay:'percent',span:1}
  ],notes:[{label:'Spend',value:{amount:4.25,currency:'USD'},infoRows:detailRows}]};
  await runtime.manager.call(fixtureManifest.id,'fixture-layout',layouts);await runtime.refreshLimits();
  await waitFor("document.querySelector('#limitsPanel > :first-child .limit-spend-summary')?.textContent==='$4.25'",'native plugin notes');
  const layoutProof=await js("[...document.querySelectorAll('#limitsPanel > :first-child .limit-windows > .limit-window')].map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width};})");
  assert.equal(layoutProof.length,6);
  assert.equal(layoutProof[0].y,layoutProof[1].y,'two half-width bars share row');
  assert.ok(layoutProof[2].w>layoutProof[0].w*1.9,'monthly window spans full row');
  assert.equal(layoutProof[3].y,layoutProof[4].y,'percentage and credit bars share next row');
  assert.ok(layoutProof[2].y>layoutProof[0].y&&layoutProof[3].y>layoutProof[2].y,'input order survives mixed metrics');
  assert.equal(await js("getComputedStyle(document.querySelector('#limitsPanel > :first-child .limit-windows > :nth-child(3) .limit-reset')).display==='none'"),false,'money detail remains visible without reset/expiry');
  await capture('quota-layout-multiple.png');
  await js("document.querySelector('#limitsPanel > :first-child .limit-window-label .limit-detail-tooltip-trigger').focus()");
  await waitFor("document.querySelector('#limitsPanel > :first-child .limit-window-label .limit-detail-tooltip').matches(':popover-open')",'window label shares native tooltip');
  assert.equal(await js("document.querySelector('#limitsPanel > :first-child .limit-window-label .limit-detail-tooltip-trigger').getAttribute('aria-label')"),'Scope: Synthetic team pool');
  const tooltipBounds=await js("(()=>{const r=document.querySelector('#limitsPanel > :first-child .limit-window-label .limit-detail-tooltip').getBoundingClientRect();return {left:r.left,right:r.right,width:document.documentElement.clientWidth};})()");
  assert.ok(tooltipBounds.left>=0&&tooltipBounds.right<=tooltipBounds.width,'window-label tooltip stays inside viewport: '+JSON.stringify(tooltipBounds));
  await capture('quota-tooltip-window.png');
  await js("document.activeElement.blur()");
  await js("document.querySelector('#limitsPanel > :first-child .limit-spend .limit-detail-tooltip-trigger').focus()");
  await waitFor("document.querySelector('#limitsPanel > :first-child .limit-spend .limit-detail-tooltip').matches(':popover-open')",'keyboard focus opens native tooltip');
  assert.equal(await js("[...document.querySelectorAll('#limitsPanel > :first-child .limit-spend .limit-detail-tooltip-row')].map(row=>row.textContent).join('|')"),'Today$0.25|Week$1.50|Month$4.25|All time$12.00');
  await capture('quota-tooltip-keyboard.png');
  await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await waitFor("!document.querySelector('#limitsPanel > :first-child .limit-spend .limit-detail-tooltip').matches(':popover-open')",'Escape closes tooltip');
  await js("document.activeElement.blur();document.querySelector('#limitsPanel > :first-child .limit-spend .limit-detail-tooltip-wrap').dispatchEvent(new PointerEvent('pointerenter'))");
  await waitFor("document.querySelector('#limitsPanel > :first-child .limit-spend .limit-detail-tooltip').matches(':popover-open')",'hover opens native tooltip');
  await js("document.querySelector('#limitsPanel > :first-child .limit-spend .limit-detail-tooltip-wrap').dispatchEvent(new PointerEvent('pointerleave'))");
  await waitFor("!document.querySelector('#limitsPanel > :first-child .limit-spend .limit-detail-tooltip').matches(':popover-open')",'hover exit closes tooltip');
  await js("tokenMonitor.updateSettings({showLimitUsed:true})");
  await waitFor("document.querySelector('#limitsPanel > :first-child').textContent.includes('$16.75 / $100.00')",'mixed-row money follows used mode');
  await capture('quota-layout-used.png');
  await js("tokenMonitor.updateSettings({showLimitUsed:false})");
  await runtime.manager.call(fixtureManifest.id,'fixture-layout',{windows:[{kind:'daily',label:'Daily pool',usedPercent:25},{kind:'billing',label:'Billing pool',usedPercent:40}]});await runtime.refreshLimits();
  await waitFor("!document.querySelector('#limitsPanel > :first-child .limit-spend')",'native notes dispose on replacement reading');
  assert.equal(await js("document.querySelectorAll('#limitsPanel .limit-detail-tooltip:popover-open').length"),0,'no detached tooltip remains open');
  console.log('PASS native plugin multi-row spans, mixed metric order, money mode, tooltip focus/Escape/hover and disposal');

  await js("window.quotaThemeRebuilds=0;window.originalQuotaThemeRender=renderThemePresetChips;renderThemePresetChips=(...args)=>{quotaThemeRebuilds++;return originalQuotaThemeRender(...args);};true");
  const creditWindow = {creditsDisplay:'percent',remaining:83.25,limit:100,boundaryKind:'expiry',resetsAt:new Date(Date.now()+30*86400000).toISOString()};
  await runtime.manager.call('synthetic-limits','fixture-window',creditWindow);
  await runtime.refreshLimits();
  await waitFor("document.querySelector('#limitsPanel').textContent.includes('$83.25 / $100.00')",'percent credit money detail');
  assert.equal(await js("quotaThemeRebuilds"),0,'quota-only update does not rebuild unrelated theme controls');
  await js("renderThemePresetChips=originalQuotaThemeRender;true");
  assert.equal(await js("document.querySelector('#limitsPanel').textContent.includes('83% left')"),true);
  await capture('credits-percent-remaining.png');
  await js("tokenMonitor.updateSettings({showLimitUsed:true})");
  await waitFor("document.querySelector('#limitsPanel').textContent.includes('$16.75 / $100.00')",'used credit money detail');
  assert.equal(await js("document.querySelector('#limitsPanel').textContent.includes('17% used')"),true);
  await capture('credits-percent-used.png');
  await runtime.manager.call('synthetic-limits','fixture-window',{...creditWindow,creditsDisplay:'balance'});
  await runtime.refreshLimits();
  await waitFor("!document.querySelector('#limitsPanel').textContent.includes('$16.75 / $100.00')",'balance-only credit');
  await capture('credits-balance.png');
  await runtime.manager.call('synthetic-limits','fixture-window',{...creditWindow,limit:null});
  await runtime.refreshLimits();
  await capture('credits-unknown-total.png');
  await js("tokenMonitor.updateSettings({showLimitUsed:false})");
  await runtime.manager.call('synthetic-limits','fixture-window',{});
  await runtime.refreshLimits();
  await waitFor("document.querySelector('#limitsPanel').textContent.includes('$80.00')",'restore legacy fixture credit');

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
  const helperBox = `document.querySelector('[data-limit-module="plugin:synthetic-limits:one"] .plugin-credential-form')`;
  await waitFor(`${helperBox}`,'author composed native credential helper');
  assert.equal(await js(`${helperBox}.querySelector('[data-credential-action=clear]').hidden`),true,'no saved field hides clear');
  await capture('credentials-empty.png');
  const nativeStyleProof=await js(`(()=>{
    const own=${helperBox}.querySelector('input'), builtin=document.getElementById('minimaxApiKeyInput');
    const properties=['fontFamily','fontSize','backgroundColor','paddingTop','paddingRight','paddingBottom','paddingLeft','borderRadius','borderTopColor'];
    const pick=node=>Object.fromEntries(properties.map(key=>[key,getComputedStyle(node)[key]]));
    return {own:pick(own),builtin:pick(builtin),fieldGap:getComputedStyle(own.closest('label')).gap,builtinFieldGap:getComputedStyle(builtin.closest('label')).gap,
      formGap:getComputedStyle(${helperBox}.querySelector('.plugin-credential-editor')).gap,builtinFormGap:getComputedStyle(builtin.closest('.opencode-credential-fields')).gap};
  })()`);
  assert.deepEqual(nativeStyleProof.own,nativeStyleProof.builtin,'shared credentials use built-in provider input styles');
  assert.equal(nativeStyleProof.fieldGap,nativeStyleProof.builtinFieldGap);
  assert.equal(nativeStyleProof.formGap,nativeStyleProof.builtinFormGap);
  console.log('PASS native credential input and spacing match built-in provider computed styles');
  const sharedControlAudit=await js(`(()=>{
    const box=${helperBox};const style=(node,keys)=>Object.fromEntries(keys.map(key=>[key,getComputedStyle(node)[key]]));
    const inputKeys=['fontFamily','fontSize','backgroundColor','paddingTop','paddingRight','borderRadius','borderTopColor'];
    const selectKeys=['fontFamily','fontSize','backgroundColor','paddingTop','paddingRight','borderRadius','borderTopColor'];
    return {
      select:style(document.querySelector('[data-quota-mode]'),selectKeys),builtinSelect:style(document.getElementById('languageInput'),selectKeys),
      textarea:style(box.querySelector('textarea'),inputKeys),builtinTextarea:style(document.querySelector('#cursorManualPanel textarea'),inputKeys),
      button:style(box.querySelector('[data-credential-action=save]'),['fontSize','paddingLeft','paddingRight','borderRadius','minHeight']),builtinButton:style(document.getElementById('minimaxKeySubmit'),['fontSize','paddingLeft','paddingRight','borderRadius','minHeight']),
      label:style(box.querySelector('label'),['fontSize','color','gap']),builtinLabel:style(document.getElementById('minimaxApiKeyInput').closest('label'),['fontSize','color','gap']),
      note:style(box.querySelector('.settings-note'),['fontSize','color','lineHeight']),builtinNote:style(document.getElementById('networkProxyNote'),['fontSize','color','lineHeight'])
    };
  })()`);
  for(const name of ['select','textarea','button','label','note'])assert.deepEqual(sharedControlAudit[name],sharedControlAudit['builtin'+name[0].toUpperCase()+name.slice(1)],name+' matches existing native settings');
  console.log('PASS native select, textarea, button, label and note style audit');


  await js(`(()=>{const input=${helperBox}.querySelector('[data-credential-field="token"]');input.value='synthetic-token';input.dispatchEvent(new Event('input'));${helperBox}.querySelector('[data-credential-action=save]').click();})()`);
  await waitFor(`${helperBox}.querySelector('[role="status"]').textContent===t('plugins.credentials.valid')`,'manual credentials saved and verified');
  assert.equal(await js(`${helperBox}.querySelector('input').value`),'','save clears input');
  assert.equal(await js("state.pluginCatalog.limits.providers.some(row=>row.provider==='plugin:synthetic-limits:one')"),false,'credential update invalidates paused reading');
  assert.equal(await js("state.pluginCatalog.limits.providers.some(row=>row.provider==='plugin:synthetic-limits:two')"),true,'credential update preserves sibling');
  assert.equal((await runtime.manager.call('synthetic-limits','fixture-read',{moduleId:'one'})).configured,true,'backend-only read');
  const routed=await runtime.manager.call('synthetic-limits','fixture-network',{moduleId:'one'});
  assert.equal(routed.status,200);assert.equal(transportCalls.at(-1).init.credentials,'omit');
  await assert.rejects(js("tokenMonitorTrustedPlugins.host('synthetic-limits','credentials.read',{moduleId:'one'})"),/Backend-only/);
  await assert.rejects(js("tokenMonitorTrustedPlugins.host('synthetic-limits','network.request',{moduleId:'one'})"),/Backend-only/);
  const credentialDirectory=path.join(scratch,'plugin-credentials','synthetic-limits');
  const credentialFile=path.join(credentialDirectory,fs.readdirSync(credentialDirectory)[0]);
  assert.equal(JSON.parse(fs.readFileSync(credentialFile)).values.token,'synthetic-token');
  if(process.platform!=='win32')assert.equal(fs.statSync(credentialFile).mode&0o777,0o600);
  await js(`${helperBox}.scrollIntoView({block:'center'})`);
  await capture('settings-native-helper.png');
  assert.equal(await js(`${helperBox}.querySelector('.plugin-credential-editor').hidden`),true,'successful validation collapses editor');
  assert.equal(await js("document.querySelector('[data-credential-help]').hidden"),true,'author help follows public state callback');
  await capture('credentials-linked-summary.png');
  await js(`${helperBox}.querySelector('[data-credential-action=edit]').click()`);
  assert.equal(await js(`${helperBox}.querySelector('input').value`),'','edit never fills saved secret');

  await js(`(()=>{const input=${helperBox}.querySelector('input');input.value='';input.dispatchEvent(new Event('input'));${helperBox}.querySelector('[data-credential-action=save]').click();})()`);
  await waitFor(`${helperBox}.querySelector('[role="alert"]').textContent.length>0`,'explicit required empty rejected');
  assert.equal((await runtime.manager.call('synthetic-limits','fixture-read',{moduleId:'one'})).configured,true);
  await js(`(()=>{const input=${helperBox}.querySelector('input');input.value='synthetic-token';input.dispatchEvent(new Event('input'));${helperBox}.querySelector('[data-credential-action=save]').click();})()`);
  await waitFor(`!${helperBox}.querySelector('[data-credential-action=save]').disabled&&${helperBox}.querySelector('input').value===''`,'helper resave');
  await js(`${helperBox}.querySelector('[data-credential-action=edit]').click()`);
  await js(`(()=>{const input=${helperBox}.querySelector('input');input.value='conflict-draft';input.dispatchEvent(new Event('input'));})()`);
  const external=await js("tokenMonitorTrustedPlugins.host('synthetic-limits','credentials.status',{moduleId:'one'})");
  await js(`tokenMonitorTrustedPlugins.host('synthetic-limits','credentials.update',{moduleId:'one',expectedRevision:${external.revision},patch:{cookies:'synthetic-cookie'}})`);
  await js(`${helperBox}.querySelector('[data-credential-action=save]').click()`);
  await waitFor(`${helperBox}.querySelector('[role="alert"]').textContent===t('plugins.credentials.conflict')`,'conflict keeps draft');
  assert.equal(await js(`${helperBox}.querySelector('input').value`),'conflict-draft');
  await js(`${helperBox}.querySelector('input').value='';${helperBox}.scrollIntoView({block:'center'})`);
  await capture('settings-credential-conflict.png');
  await js(`${helperBox}.querySelector('[data-credential-action=reload]').click()`);
  await waitFor(`!${helperBox}.querySelector('[data-credential-action=save]').disabled`,'explicit revision reload');
  await js(`(()=>{const input=${helperBox}.querySelector('input');input.value='synthetic-token';input.dispatchEvent(new Event('input'));${helperBox}.querySelector('[data-credential-action=save]').click();})()`);
  await waitFor(`!${helperBox}.querySelector('[data-credential-action=save]').disabled&&${helperBox}.querySelector('input').value===''`,'save after explicit conflict reload');
  for(const status of ['rejected','expired','unavailable']) {
    await runtime.manager.call('synthetic-limits','fixture-validation',{status});
    await js(`${helperBox}.querySelector('[data-credential-action=edit]').click()`);
    await js(`(()=>{const input=${helperBox}.querySelector('input');input.value='synthetic-token';input.dispatchEvent(new Event('input'));${helperBox}.querySelector('[data-credential-action=save]').click();})()`);
    await waitFor("credentialUiState.verification==='verifying'",'verifying state callback');
    await waitFor(`credentialUiState.verification==='${status}'&&!credentialUiState.pending`,'explicit '+status+' result');
    assert.equal(await js(`${helperBox}.querySelector('.plugin-credential-editor').hidden`),false,'failed validation keeps editor');
    assert.equal(await js(`${helperBox}.querySelector('[data-credential-action=clear]').hidden`),false,'failed credentials remain clearable');
    await capture('credentials-'+status+'.png');
  }
  await runtime.manager.call('synthetic-limits','fixture-validation',{status:'valid'});
  await js(`${helperBox}.querySelector('[data-credential-action=verify]').click()`);
  await waitFor("credentialUiState.verification==='valid'&&!credentialUiState.pending",'reverify succeeds');
  await js("setLimitProviderSettingsExpanded('plugin:synthetic-limits:two')");
  await waitFor("document.querySelector('[data-custom-token]')",'custom credential DOM');
  await js("document.querySelector('[data-custom-token]').value='synthetic-token';document.querySelector('[data-custom-save]').click()");
  await waitFor("document.querySelector('[data-custom-result]').textContent==='Saved'",'custom UI uses same credential API');
  assert.equal((await runtime.manager.call('synthetic-limits','fixture-read',{moduleId:'two'})).configured,true);
  await js("document.querySelector('[data-custom-token]').scrollIntoView({block:'center'})");
  await capture('settings-custom-credentials.png');
  await js("setLimitProviderSettingsExpanded('plugin:synthetic-limits:one')");

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
  assert.equal(await js(`document.querySelector(${JSON.stringify(statusSelector)})?.textContent`),'已連接','verified state is in the native header');
  assert.equal(await js(`${helperBox}.querySelector('[role="status"]').hidden`),true,'expanded form omits duplicate status');
  for (const [status,label] of [['notConfigured','已連接'],['unauthorized','驗證失敗'],['error','驗證失敗']]) {
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
  await waitFor(`document.querySelector(${JSON.stringify(statusSelector)})?.textContent==='驗證失敗'`,'a healthy quota cannot revalidate rejected credentials');
  const savedForVerify=await js("tokenMonitorTrustedPlugins.host('synthetic-limits','credentials.status',{moduleId:'one'})");
  await js(`tokenMonitorTrustedPlugins.host('synthetic-limits','credentials.verify',{moduleId:'one',expectedRevision:${savedForVerify.revision}})`);
  await waitFor(`document.querySelector(${JSON.stringify(statusSelector)})?.textContent==='已連接'`,'explicit verification restores native header status');

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
  const updated = JSON.parse(fs.readFileSync(path.join(fixtureDir,'manifest.json'))); updated.version = '1.0.1'; updated.limits.push({id:'plain',name:'Plain module'},{id:'native',name:'Native form',credentials:{fields:[{id:'token',label:'API key',required:true},{id:'cookies',label:'Cookies',control:'textarea'}]}}); updated.limits[1].tags[0] = {en:'Updated pool','zh-TW':'更新後自填池'};
  fs.writeFileSync(path.join(fixtureDir,'manifest.json'),JSON.stringify(updated));
  const updatePreview = await js("tokenMonitor.plugins.importPackage('directory')");
  await js(`tokenMonitor.plugins.install(${JSON.stringify(updatePreview.token)},{trustUpdate:true})`);
  await waitFor("state.pluginCatalog?.plugins?.some(p=>p.version==='1.0.1')",'update');
  assert.equal(await js("state.settings.limitProviderOrder.split(',')[0]"),'plugin:synthetic-limits:one');
  await js("openSettingsPanel();setSettingsSectionExpanded('limits',true);renderLimitProviderCheckboxes()");
  await waitFor(`document.querySelector('[data-provider="plugin:synthetic-limits:two"]').textContent.includes('更新後自填池')`,'updated custom labels');
  assert.equal(await js("!!document.getElementById('limitProviderDisclosure-plugin:synthetic-limits:plain')"),false,'module with no controls has no empty disclosure');
  await js("setLimitProviderSettingsExpanded('plugin:synthetic-limits:native')");
  const defaultBox=`document.querySelector('[data-limit-module="plugin:synthetic-limits:native"] .plugin-credential-form')`;
  await waitFor(defaultBox,'host default credentials without author view');
  await js(`${defaultBox}.scrollIntoView({block:'center'})`);await pause(150);
  await js("tokenMonitorTrustedPlugins.host('synthetic-limits','credentials.update',{moduleId:'native',expectedRevision:0,patch:{cookies:'synthetic=partial'}})");
  await waitFor(`${defaultBox}.querySelector('[role=status]').textContent===t('plugins.credentials.partial')`,'partial saved status');
  assert.equal(await js(`${defaultBox}.querySelector('[data-credential-action=clear]').hidden`),false,'partial saved fields enable clear');
  await capture('credentials-partial.png');
  await js(`${defaultBox}.querySelector('[data-credential-action=clear]').click()`);
  await waitFor(`${defaultBox}.querySelector('[data-credential-action=clear]').hidden`,'clear returns to empty editor');

  await js(`(()=>{const input=${defaultBox}.querySelector('input');input.value='synthetic-token';input.dispatchEvent(new Event('input'));${defaultBox}.querySelector('[data-credential-action=save]').click();})()`);
  await waitFor(`${defaultBox}.querySelector('[role="status"]').textContent===t('plugins.credentials.configured')`,'host default form saves');
  assert.equal((await runtime.manager.call('synthetic-limits','fixture-read',{moduleId:'native'})).configured,true);
  await js(`${defaultBox}.querySelector('input').value='unsaved';${defaultBox}.querySelector('input').dispatchEvent(new Event('input'))`);
  assert.equal(await js("pluginViewHost.hasUnsavedChanges(['synthetic-limits'])"),true,'default form participates in existing unsaved-work lifecycle');
  await js(`${defaultBox}.querySelector('input').value='synthetic-token';${defaultBox}.querySelector('input').dispatchEvent(new Event('input'));${defaultBox}.querySelector('[data-credential-action=save]').click()`);
  await waitFor(`!${defaultBox}.querySelector('[data-credential-action=save]').disabled&&${defaultBox}.querySelector('input').value===''`,'default form save resets draft');
  await js(`${defaultBox}.scrollIntoView({block:'center'})`);
  await capture('settings-default-credentials.png');
  await js("openSettingsPanel();setSettingsSectionExpanded('plugins',true);pluginSettingsPanel.refresh()");
  await waitFor("document.querySelector('[data-plugin-id=\"synthetic-limits\"] .plugin-card-footer')",'installed plugin controls');
  await waitFor("document.querySelector('.plugin-identity-art .row-icon-codex')",'native plugin identity before author settings opens');
  await capture('presentation-management.png');
  await js(`document.querySelector('[data-plugin-id="synthetic-limits"] .plugin-manage').click()`);
  await waitFor("document.querySelector('.plugin-author-form select')",'host ordinary settings select');
  const ordinarySelectAudit=await js(`(()=>{const a=getComputedStyle(document.querySelector('.plugin-author-form select')),b=getComputedStyle(document.getElementById('minimaxBillingModeInput'));return ['fontFamily','fontSize','backgroundColor','paddingTop','paddingRight','borderRadius','borderTopColor'].map(key=>[key,a[key],b[key]]);})()`);
  assert.ok(ordinarySelectAudit.every(([,a,b])=>a===b),'host ordinary select matches provider select: '+JSON.stringify(ordinarySelectAudit));
  console.log('PASS host-generated ordinary settings select uses built-in provider visual styles');
  await js("document.querySelector('.plugin-author-form select').scrollIntoView({block:'center'})");
  await capture('settings-plugin-native-select.png');
  assert.equal(await js("document.querySelector('[data-control-key=author-reload]').hidden"),true,'reload hidden during ordinary editing');
  const settingsBase=await js("tokenMonitorTrustedPlugins.host('synthetic-limits','settings.get')");
  await js(`tokenMonitorTrustedPlugins.host('synthetic-limits','settings.update',{schemaVersion:${settingsBase.schemaVersion},expectedRevision:${settingsBase.revision},patch:{displayMode:'balance'}})`);
  const conflictMode=settingsBase.values.displayMode==='meter'?'balance':'meter';
  await js("(()=>{const input=document.querySelector('.plugin-author-form select');input.value=input.value==='meter'?'balance':'meter';input.dispatchEvent(new Event('change'));})()");
  await waitFor("document.querySelector('[data-control-key=author-reload]')?.hidden===false",'conflict exposes recovery action');
  assert.equal(await js("document.querySelector('.plugin-author-form select').value"),conflictMode,'conflict retains draft');
  await js("document.querySelector('[data-control-key=author-reload]').click()");
  await waitFor("document.querySelector('.plugin-author-form select')?.value==='balance'&&document.querySelector('[data-control-key=author-reload]')?.hidden===true",'explicit reload adopts saved settings');
  await js("document.querySelector('.plugin-detail-utilities').scrollIntoView({block:'center'})");
  await capture('settings-management-cleanup.png');
  fixtureConsent=0;
  await js(`(()=>{const card=document.querySelector('.plugin-detail-utilities');[...card.querySelectorAll('button')].find(button=>button.textContent===t('plugins.credentials.forget')).click();})()`);
  await waitFor("!document.querySelector('.plugin-detail-utilities button:disabled')",'cancelled credential clear settles');
  await pause(100);assert.ok(fs.readdirSync(credentialDirectory).length>0,'cancel preserves credentials');
  fixtureConsent=1;
  await js(`(()=>{const card=document.querySelector('.plugin-detail-utilities');[...card.querySelectorAll('button')].find(button=>button.textContent===t('plugins.credentials.forget')).click();})()`);
  await waitFor("!document.querySelector('.plugin-detail-utilities button:disabled')",'credential clear settles');
  assert.equal(credentialConfirmations,2,'cancel and confirm use host native dialog');
  await waitFor("!state.pluginCatalog.limits.providers.some(row=>row.provider==='plugin:synthetic-limits:one')",'native forget clears captured connection quota');
  await js("document.querySelector('#pluginSettingsList .plugin-back').click()");
  await waitFor("document.querySelector('.plugin-card-footer')",'return to installed list');
  assert.equal(await js("[...document.querySelectorAll('.plugin-card-footer button')].some(button=>button.textContent===t('plugins.credentials.forget'))"),false,'list has no credential management action');
  await capture('settings-installed-clean.png');
  await js("document.querySelector('.plugin-type-filter').value='appearance';document.querySelector('.plugin-type-filter').dispatchEvent(new Event('change'))");
  await waitFor("document.querySelector('#pluginSettingsList').textContent.includes(t('plugins.catalog.noResults'))",'filtered installed empty state');
  const forgotten=await js("tokenMonitorTrustedPlugins.host('synthetic-limits','credentials.status',{moduleId:'one'})");
  await js(`tokenMonitorTrustedPlugins.host('synthetic-limits','credentials.update',{moduleId:'one',expectedRevision:${forgotten.revision},patch:{token:'synthetic-token'}})`);
  assert.ok(fs.readdirSync(credentialDirectory).length>0,'credential records exist before keepData uninstall');
  await js("tokenMonitor.plugins.uninstall('synthetic-limits',{keepData:true})");
  await waitFor("state.pluginCatalog?.limits?.modules?.length===0",'uninstall');
  assert.equal(fs.existsSync(credentialDirectory),false,'keepData uninstall removes private credential namespace');
  console.log('PASS custom quota UI: lazy mount, retained draft/focus, collapse visibility, host settings save, disable cleanup');
  console.log('PASS synthetic native Limits: mixed pointer drag/order, same-name identities, search, disclosure, visibility, disable, reenable, reload, restart, update, uninstall');
  console.log('Evidence:',evidence);
  clearTimeout(deadline);await runtime.dispose();win.destroy();app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
