'use strict';
// Actual App HTML, renderer, preload and plugin runtime. Host collection/account
// IPC uses synthetic records; no personal profile, collector or credentials load.
const { app, BrowserWindow, ipcMain, session, utilityProcess, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
// Explicit test-only version metadata lets current main exercise the declared
// future release boundary without changing package.json or the imported plugin.
if (process.env.TM_PLUGIN_FIXTURE_HOST_VERSION) {
  assert.ok(require('semver').valid(process.env.TM_PLUGIN_FIXTURE_HOST_VERSION));
  require('../package.json').version = process.env.TM_PLUGIN_FIXTURE_HOST_VERSION;
  console.log('Fixture host version (metadata only):', process.env.TM_PLUGIN_FIXTURE_HOST_VERSION);
}
const { createPluginRuntime, registerPluginScheme } = require('../src/electron/plugins/runtime');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-credit-limits-'));
const evidence = process.env.TM_PLUGIN_EVIDENCE || scratch;

const fixtureDir=path.join(scratch,'source');
fs.cpSync(path.join(root,'plugins/openai-api-credit'),fixtureDir,{recursive:true});
const fixturePackage=path.join(scratch,'openai-api-credit-0.1.0.tmplugin');
const packaged=require('../src/electron/plugins/package').packageDirectory(fixtureDir);
fs.writeFileSync(fixturePackage,packaged.bytes);console.log('Tested package SHA-256:',packaged.hash);
let responseStatus=200,requests=0,copiedText;
const billing=()=>({object:'credit_summary',total_granted:124,total_used:40.75,total_available:83.25,total_paid_available:0,grants:{data:[{grant_amount:100,used_amount:16.75,effective_at:1,expires_at:Math.floor(Date.now()/1000)+30*86400},{grant_amount:24,used_amount:24,effective_at:1,expires_at:null}]}});
let responseBody=billing();
fs.mkdirSync(evidence,{recursive:true});
app.setPath('userData',path.join(scratch,'profile'));
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
registerPluginScheme(protocol);
app.on('window-all-closed',()=>{});
let runtime,win;

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
    'clipboard:write': (_event, text) => { copiedText = text; return true; },
    'settings:get': () => settings,
    'settings:displayPreview': (_event, surface, phase, slots) => require('../src/electron/displayPreview').buildDisplayPreview(settings, surface, phase, process.platform, Date.now(), slots),
    'settings:update': async (event, patch) => { const after = await runtime.beforeSettingsChange(event, patch); settings = { ...settings, ...patch }; runtime.settingsChanged(); win.webContents.send('settings:push',settings); await after(); return settings; },
    'app:getInfo': () => ({ version: require('../package.json').version, platform: process.platform, systemUiTheme: 'dark', loginItemSupported: false }),
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
   dialog:{showMessageBox:async()=>({response:1}),showOpenDialog:async()=>({canceled:false,filePaths:[fixturePackage]})}},
   fetchImpl:async(url,init)=>{
     requests++;assert.equal(url,'https://api.openai.com/v1/dashboard/billing/credit_grants');
     assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
     assert.equal(init.headers['OpenAI-Organization'],'org-synthetic');
     assert.equal(init.headers.Authorization,'Bearer example-session-value');
     return new Response(JSON.stringify(responseBody),{status:responseStatus});
   },userDataDir:scratch,getSettings:()=>settings,getAppSettings:()=>settings,getContext:()=>({source:'fixture'}),getLocale:()=>settings.language,
   isMainSender:event=>event.sender===win.webContents,persistPluginStates:pluginStates=>patch({pluginStates}),
   persistManagementSettings:patch,applySettingsPatch:patch,env:{},log:console.log});
  await runtime.start();runtime.publishStats(stats);
  await win.loadFile(path.join(root,'src/electron/renderer/index.html'));
  const js=source=>win.webContents.executeJavaScript(source);
  await waitFor("state.stats?.periods?.today?.totalTokens===125000",'init');
  const preview=await js("tokenMonitor.plugins.importPackage('file')");
  await js(`tokenMonitor.plugins.install(${JSON.stringify(preview.token)},{trustInstall:true})`);
  await js("pluginApi.setEnabled('openai-api-credit',true)");
  const ref='plugin:openai-api-credit:credits';
  await js(`tokenMonitor.updateSettings({limitsEnabled:true,limitProviders:'claude,${ref},codex',limitProviderOrder:'claude,${ref},codex'})`);
  await js("openViewFromTray('limits')");
  await waitFor("state.pluginCatalog.limits.providers[0]?.status==='notConfigured'",'missing manual credentials');
  assert.equal(requests,0);
  const moduleBox=`document.querySelector('[data-limit-module="${ref}"]')`;
  const credentialBox=`${moduleBox}.querySelector('.plugin-native-credentials')`;
  const capture=async name=>{await pause(250);fs.writeFileSync(path.join(evidence,name),(await win.webContents.capturePage()).toPNG());};
  const showSettings=async()=>{
    await js("openSettingsPanel();setSettingsSectionExpanded('limits',true)");
    await waitFor("document.getElementById('limitProviderDisclosure-plugin:openai-api-credit:credits')",'native module row');
    await js("setLimitProviderSettingsExpanded('plugin:openai-api-credit:credits')");
    await waitFor(`${credentialBox}`,'shared native credential form');
    await js(`${moduleBox}.scrollIntoView({block:'center',behavior:'instant'})`);
  };
  const saved=()=>`${credentialBox}.querySelector('[role=status]').textContent===t('plugins.credentials.valid')`;
  await showSettings();
  assert.equal(await js(`${credentialBox}.querySelector('[data-credential-action=clear]').hidden`),true,'empty state has no clear action');
  assert.equal(await js(`${moduleBox}.querySelector('[data-openai-reload]').hidden`),true,'no routine display reload action');
  await js(`(async()=>{const current=await tokenMonitorTrustedPlugins.host('openai-api-credit','settings.get');await tokenMonitorTrustedPlugins.host('openai-api-credit','settings.update',{schemaVersion:current.schemaVersion,expectedRevision:current.revision,patch:{displayMode:'balance'}});const select=${moduleBox}.querySelector('[data-openai-mode]');select.value='balance';select.dispatchEvent(new Event('change'));})()`);
  await waitFor(`${moduleBox}.textContent.includes('設定已在另一個介面更新')`,'real settings revision conflict');
  assert.equal(await js(`${moduleBox}.querySelector('[data-openai-reload]').hidden`),false);
  assert.equal(await js(`${moduleBox}.querySelector('[data-openai-mode]').value`),'balance','conflict retains draft');
  await js(`${moduleBox}.querySelector('[data-openai-reload]').click()`);
  await waitFor(`${moduleBox}.querySelector('[data-openai-reload]').hidden`,'reload recovers and disappears');
  await js(`(()=>{const select=${moduleBox}.querySelector('[data-openai-mode]');select.value='bar';select.dispatchEvent(new Event('change'));})()`);
  await waitFor(`${moduleBox}.textContent.includes('設定已儲存')`,'restore initial mode');
  const preferenceFile=path.join(scratch,'plugin-settings','openai-api-credit.json');
  const savedPreference=fs.readFileSync(preferenceFile);
  fs.writeFileSync(preferenceFile,'invalid JSON');
  await js(`(()=>{const select=${moduleBox}.querySelector('[data-openai-mode]');select.value='balance';select.dispatchEvent(new Event('change'));})()`);
  await waitFor(`!${moduleBox}.querySelector('[data-openai-retry]').hidden`,'failed autosave retains draft and offers retry');
  assert.equal(await js(`${moduleBox}.querySelector('[data-openai-mode]').value`),'balance');
  fs.writeFileSync(preferenceFile,savedPreference);
  await js(`${moduleBox}.querySelector('[data-openai-retry]').click()`);
  await waitFor(`${moduleBox}.textContent.includes('設定已儲存')`,'retry autosave succeeds');
  assert.equal(JSON.parse(fs.readFileSync(preferenceFile,'utf8')).values.displayMode,'balance','autosave durable without Save click');
  await js(`(()=>{const select=${moduleBox}.querySelector('[data-openai-mode]');select.value='bar';select.dispatchEvent(new Event('change'));})()`);
  await waitFor(`${moduleBox}.textContent.includes('設定已儲存') && ${moduleBox}.querySelector('[data-openai-retry]').hidden`,'restore initial display after retry');
  await capture('openai-manual-empty.png');
  const guide=`${moduleBox}.querySelector('[data-openai-setup]')`;
  assert.equal(await js(`${guide}.querySelectorAll('strong').length`),4,'four short native steps');
  assert.equal(await js(`${guide}.className`),'settings-note');
  assert.equal(await js(`${moduleBox}.querySelectorAll('details').length`),0,'no separate help disclosure');
  assert.equal(await js(`${moduleBox}.querySelector('[data-openai-url]').readOnly`),true,'public billing address can be selected without editing');
  assert.deepEqual(await js(`[...${guide}.querySelectorAll('code')].map(node=>node.textContent)`),
    ['credit_grants','Authorization','OpenAI-Organization']);
  await js(`${moduleBox}.querySelector('[data-openai-copy]').click()`);
  await waitFor(`${moduleBox}.textContent.includes('網址已複製')`,'copy billing URL feedback');
  assert.equal(copiedText,'https://platform.openai.com/settings/organization/billing/overview');
  assert.equal(requests,0,'copying public URL never collects or opens login');
  const guideStyle=await js(`(()=>{const a=getComputedStyle(${guide}),b=getComputedStyle(${credentialBox}.querySelector('.settings-note'));return ['fontSize','lineHeight','color'].map(key=>[key,a[key],b[key]]);})()`);
  assert.ok(guideStyle.every(([,a,b])=>a===b),'guide uses the same native note typography');
  await capture('openai-manual-setup.png');
  win.setSize(360,760);
  await js(`${moduleBox}.scrollIntoView({block:'center',behavior:'instant'})`);
  await capture('openai-manual-setup-compact.png');
  assert.ok(await js(`${guide}.scrollWidth <= ${guide}.clientWidth`),'setup fits narrow settings');
  win.setSize(440,760);
  await js(`${moduleBox}.scrollIntoView({block:'center',behavior:'instant'})`);
  assert.equal(BrowserWindow.getAllWindows().length,1,'no browser login window');
  assert.equal(await js(`${credentialBox}.querySelectorAll('input[type=password]').length`),2);
  await js(`(()=>{const box=${credentialBox};for(const [id,value] of Object.entries({sessionBearer:'example-session-value',organization:'org-synthetic'})){const input=box.querySelector('[data-credential-field="'+id+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}box.querySelector('[data-credential-action=save]').click();})()`);
  await waitFor(saved(),'credentials saved through native helper');
  assert.equal(requests,1,'save triggers exactly one explicit verification, no quota polling');
  assert.equal(await js(`${moduleBox}.querySelector('[data-openai-instructions]').hidden`),true,'verified credentials fold author instructions');
  assert.equal(await js(`${credentialBox}.querySelector('.plugin-credential-editor').hidden`),true,'verified credentials fold native editor');
  await js(`${moduleBox}.scrollIntoView({block:'center',behavior:'instant'})`);
  await capture('openai-verified-summary.png');
  await js(`${credentialBox}.querySelector('[data-credential-action=edit]').click()`);
  assert.equal(await js(`${moduleBox}.querySelector('[data-openai-instructions]').hidden`),false,'change credentials reopens author instructions');
  assert.ok(await js(`[...${credentialBox}.querySelectorAll('input')].every(input=>input.value==='')`),'change credentials never reads saved secrets');
  await capture('openai-change-credentials.png');
  await js(`${credentialBox}.querySelector('[data-credential-action=cancel]').click()`);
  assert.equal(await js(`${moduleBox}.querySelector('[data-openai-instructions]').hidden`),true,'cancel editing returns to summary');
  assert.ok(await js(`[...${credentialBox}.querySelectorAll('input')].every(input=>input.value==='')`),'successful save clears entered values');
  const status=await js("tokenMonitorTrustedPlugins.host('openai-api-credit','credentials.status',{moduleId:'credits'})");
  assert.equal(status.configured,true);assert.ok(!JSON.stringify(status).includes('example-session-value'));
  await assert.rejects(js("tokenMonitorTrustedPlugins.host('openai-api-credit','credentials.read',{moduleId:'credits'})"),/Backend-only/);
  await capture('openai-manual-saved.png');
  const has=phrase=>`document.querySelector('#limitsPanel').textContent.includes(${JSON.stringify(phrase)})`;
  await js("openViewFromTray('limits')");await waitFor(has('$83.25 / $100.00'),'actual manual backend native quota');
  assert.ok(await js(has('83% left')));
  assert.deepEqual(await js("[...document.querySelectorAll('#limitsPanel > .limit-row')].map(node=>node.querySelector('.limit-name-title').textContent)"),['Claude','OpenAI','Codex']);
  assert.equal(await js("document.querySelectorAll('#limitsPanel button').length"),0);
  assert.equal(BrowserWindow.getAllWindows().length,1);
  await waitFor("document.querySelector('#limitsPanel > .limit-row:nth-child(2) .limit-name .row-icon-codex')",'plugin identity icon in native Limits');
  assert.equal(await js("limitProviderColor('plugin:openai-api-credit:credits')===limitProviderColor('codex')"),true,'quota uses current Codex palette');
  await js("tokenMonitor.updateSettings({vendorColors:{codex:'#8844cc'}})");
  await waitFor("limitProviderColor('plugin:openai-api-credit:credits')==='#8844cc' && limitProviderColor('codex')==='#8844cc'",'quota follows a user Codex color override');
  await js("tokenMonitor.updateSettings({vendorColors:{}})");
  await waitFor("limitProviderColor('plugin:openai-api-credit:credits')===limitProviderColor('codex') && limitProviderColor('codex')!=='#8844cc'",'native palette restored');
  await capture('openai-manual-remaining.png');
  responseBody=billing();responseBody.total_available=100;responseBody.total_used=24;responseBody.grants.data[0].used_amount=0;
  await runtime.refreshLimits();await waitFor(has('$100.00 / $100.00'),'spent non-expiring grant excluded from current bar');
  assert.ok(await js(has('100% left')));
  await capture('openai-available-grants.png');
  assert.equal(await js("document.querySelectorAll('#limitsPanel > .limit-row:nth-child(2) .limit-detail-tooltip-trigger').length"),0,'single usable grant has no tooltip');
  await capture('openai-single-grant.png');
  responseBody.grants.data.push({grant_amount:50,used_amount:10,effective_at:1,expires_at:Math.floor(Date.now()/1000)+15*86400});
  responseBody.total_available=140;responseBody.total_granted=174;responseBody.total_used=34;
  await runtime.refreshLimits();await waitFor(has('$140.00 / $150.00'),'multiple usable grants');
  const info=`document.querySelector('#limitsPanel > .limit-row:nth-child(2) .limit-detail-tooltip-wrap')`;
  const beforeInfoRequests=requests;
  await js(`${info}.dispatchEvent(new PointerEvent('pointerenter'))`);
  await waitFor(`${info}.querySelector('.limit-detail-tooltip').matches(':popover-open')`,'batch tooltip hover');
  assert.ok(await js(`${info}.textContent.includes('$100.00') && ${info}.textContent.includes('$40.00') && !${info}.textContent.includes('Lifetime') && !${info}.textContent.includes('$24.00')`),'only usable batch balances and expiry are shown');
  assert.ok(await js(`(()=>{const r=${info}.querySelector('.limit-detail-tooltip').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;})()`),'batch tooltip within window');
  await capture('openai-credit-tooltip.png');
  await js(`${info}.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await js(`${info}.querySelector('.limit-detail-tooltip').matches(':popover-open')`),false,'Escape handler dismisses tooltip');
  assert.equal(requests,beforeInfoRequests,'tooltip makes no requests');
  responseBody=billing();await runtime.refreshLimits();await waitFor(has('$83.25 / $100.00'),'restore partial active grant');
  await js("onLimitProviderReorder('plugin:openai-api-credit:credits',0)");
  await waitFor("document.querySelector('#limitsPanel > .limit-row .limit-name-title')?.textContent==='OpenAI'",'native mixed reorder');
  await js("onLimitProviderReorder('plugin:openai-api-credit:credits',1)");
  await js("tokenMonitor.updateSettings({showLimitUsed:true})");await waitFor(has('$16.75 / $100.00'),'used money');assert.ok(await js(has('17% used')));
  await capture('openai-manual-used.png');await js("tokenMonitor.updateSettings({showLimitUsed:false})");
  await showSettings();
  await js(`(()=>{const select=${moduleBox}.querySelector('[data-openai-mode]');select.value='balance';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`${moduleBox}.textContent.includes('設定已儲存')`,'display preference saved');
  await js("openViewFromTray('limits')");await waitFor("state.pluginCatalog.limits.providers[0]?.windows[0]?.creditsDisplay==='balance'",'balance mode');
  await capture('openai-manual-balance.png');
  const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await loaded;
  await waitFor("state.stats?.periods?.today?.totalTokens===125000",'reload');await js("openViewFromTray('limits')");
  await waitFor("state.pluginCatalog.limits.providers[0]?.windows[0]?.creditsDisplay==='balance'",'saved mode and private credentials survive reload');
  await showSettings();
  assert.ok(await js(`[...${credentialBox}.querySelectorAll('input')].every(input=>input.value==='')`),'stored credentials are not filled back into renderer');
  assert.equal(await js(`${credentialBox}.querySelector('.plugin-credential-editor').hidden`),true,'complete saved credentials reopen folded without revalidation');
  const beforeReopen=requests;
  await js(`${credentialBox}.querySelector('[data-credential-action=edit]').click()`);
  assert.equal(requests,beforeReopen,'reopening editor does not collect or verify');
  await js(`(()=>{const input=${credentialBox}.querySelector('[data-credential-field=organization]');input.value='org-synthetic';input.dispatchEvent(new Event('input'));${credentialBox}.querySelector('[data-credential-action=save]').click();})()`);
  await waitFor(saved(),'partial update preserves token');
  await js(`(()=>{const select=${moduleBox}.querySelector('[data-openai-mode]');select.value='bar';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`${moduleBox}.textContent.includes('設定已儲存')`,'restore default bar');
  win.setSize(360,760);await capture('openai-manual-settings-compact.png');win.setSize(440,760);
  responseBody={...billing(),total_available:91};
  await js("openViewFromTray('limits')");await runtime.refreshLimits();await waitFor(has('$91.00'),'unknown total amount');
  assert.equal(await js("state.pluginCatalog.limits.providers[0].windows[0].limit"),null);
  assert.equal(await js("document.querySelectorAll('#limitsPanel > .limit-row:nth-child(2) .limit-meter').length"),0);
  responseBody=billing();responseBody.total_available=0;responseBody.grants.data[0].used_amount=100;
  await runtime.refreshLimits();await waitFor(has('$0.00'),'measured zero');
  assert.equal(await js("state.pluginCatalog.limits.providers[0].windows[0].limit"),null,'zero balance does not reuse exhausted lifetime grants');
  responseStatus=401;await runtime.refreshLimits();await waitFor("state.pluginCatalog.limits.providers[0]?.status==='unauthorized'",'invalid credential status');
  await showSettings();await js(`${credentialBox}.querySelector('[data-credential-action=clear]').click()`);
  await waitFor(`${credentialBox}.querySelector('[role=status]').textContent===t('plugins.credentials.notConfigured')`,'native clear credentials');
  const cleared=await js("tokenMonitorTrustedPlugins.host('openai-api-credit','credentials.status',{moduleId:'credits'})");
  assert.equal(cleared.configured,false);
  await js("setSettingsSectionExpanded('plugins',true);pluginSettingsPanel.refresh()");
  await waitFor("document.querySelector('[data-plugin-id=\"openai-api-credit\"] .plugin-manage')",'plugin management entry');
  await js("document.querySelector('[data-plugin-id=\"openai-api-credit\"] .plugin-manage').click()");
  await waitFor("document.querySelector('.plugin-author-form select')",'host display preferences');
  await waitFor("document.querySelector('.plugin-settings-content .plugin-identity-art .row-icon-codex')",'packaged OpenAI icon decodes in plugin management');
  await js("document.querySelector('.plugin-settings-content .plugin-identity').scrollIntoView({block:'start',behavior:'instant'})");
  await capture('openai-plugin-icon.png');
  await waitFor("[...document.querySelectorAll('.openai-credit-preferences')].some(node=>node.textContent.includes('憑證及設定步驟位於'))",'management view points to quota credentials');
  assert.equal(await js("document.querySelectorAll('.plugin-settings-content [data-openai-mode]').length"),0,'custom view does not duplicate management preference');
  assert.equal(await js("document.querySelector('[data-control-key=author-reload]').hidden"),true,'host reload also hidden normally');
  const credentialRecord=JSON.parse(fs.readFileSync(path.join(scratch,'plugin-credentials','openai-api-credit','credits.json')));
  assert.deepEqual(credentialRecord.values,{},'readable module path retains only a secret-free revision after clear');
  const { messages } = await import('../plugins/openai-api-credit/i18n.mjs');
  await showSettings();
  win.setSize(360,760);
  for (const [locale, words] of Object.entries(messages)) {
    await js(`tokenMonitor.updateSettings({language:${JSON.stringify(locale)},locale:${JSON.stringify(locale)}})`);
    await waitFor(`${moduleBox}.querySelector('[data-openai-copy]')?.textContent===${JSON.stringify(words.copyUrl)}`, `localized settings: ${locale}`);
    assert.ok(await js(`${guide}.textContent.includes(${JSON.stringify(words.step1)})`), `${locale} setup instructions`);
    assert.deepEqual(await js(`[...${guide}.querySelectorAll('code')].map(node=>node.textContent)`), ['credit_grants','Authorization','OpenAI-Organization']);
    assert.equal(await js(`${moduleBox}.querySelector('[data-openai-save]')`), null, 'no manual Save settings control');
    assert.equal(await js(`${moduleBox}.querySelector('[data-openai-retry]').hidden`), true);
    assert.ok(await js(`${guide}.scrollWidth <= ${guide}.clientWidth`), `${locale} guide fits narrow settings`);
    await capture(`openai-setup-${locale}.png`);
  }
  const settingsFile=path.join(scratch,'plugin-settings','openai-api-credit.json');
  const originalSettings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
  for (const status of ['newer-schema','invalid']) {
    fs.writeFileSync(settingsFile,JSON.stringify({...originalSettings,schemaVersion:status==='newer-schema'?2:1,values:{displayMode:status==='newer-schema'?'bar':'unknown'}}));
    await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
    await waitFor("state.stats?.periods?.today?.totalTokens===125000",'renderer reinitialized');
    await showSettings();
    const message=messages['pt-BR'][status==='newer-schema'?'newerSettings':'invalidSettings'];
    await waitFor(`${moduleBox}.textContent.includes(${JSON.stringify(message)})`, `${status} preference recovery guidance`);
    assert.equal(await js(`${moduleBox}.querySelector('[data-openai-mode]').disabled`),status==='newer-schema');
    assert.equal(await js(`${moduleBox}.querySelector('[data-openai-retry]').hidden`),true,'no save action for a blocked or unselected preference');
    await js(`${moduleBox}.querySelector('[data-openai-mode]').scrollIntoView({block:'center',behavior:'instant'})`);
    await capture(`openai-settings-${status}.png`);
    if(status==='invalid') {
      await js(`(()=>{const select=${moduleBox}.querySelector('[data-openai-mode]');select.value='bar';select.dispatchEvent(new Event('change'));})()`);
      await waitFor(`${moduleBox}.textContent.includes(${JSON.stringify(messages['pt-BR'].saved)})`,'invalid preference explicitly repaired');
      assert.equal(JSON.parse(fs.readFileSync(settingsFile,'utf8')).values.displayMode,'bar');
    }
  }
  assert.deepEqual(errors.filter(text=>!text.includes('Electron Security Warning')&&!text.includes('Autofill.')),[]);
  win.destroy();await pause(100);await runtime.dispose();clearTimeout(deadline);
  console.log('PASS immediate preference autosave/storage failure/draft retry/conflict recovery, invalid/newer settings recovery, six live UI locales and real OpenAI manual plugin and native credential helper: explicit revision-bound credential verification, folded summary/instructions, edit/cancel/no readback, native credit tooltip/hover/Escape handler/no extra request, native Codex SVG and live palette override, contextual display reload and real revision-conflict recovery, no duplicate management editor, native compact setup/header mapping, public URL copy and narrow layout, save/partial update/clear, no readback/browser login, private persistence/reload, mixed order, both modes, used/remaining, zero/unknown denominator and 401. Synthetic transport only.');
  console.log('Screenshots:',evidence);app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
