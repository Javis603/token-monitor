'use strict';
// Isolated production WebContentsView + manager + renderer fixture. No primary
// profile, debug port, network source, registry mutation or live account data.
const electron = require('electron');
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { createWebUi, registerWebUiScheme } = require('../src/electron/plugins/webUi');
const { createPluginManager } = require('../src/electron/plugins/manager');
const { createDataBus } = require('../src/shared/plugins/dataBus');
const { registerSystemSources } = require('../src/electron/plugins/systemDetails');
const { packageDirectory, unpackPackage } = require('../src/electron/plugins/package');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-web-ui-'));
app.setPath('userData', path.join(scratch,'profile')); registerWebUiScheme(electron.protocol);
app.on('window-all-closed',()=>{});
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn, timeout=5000) { const end=Date.now()+timeout; while(Date.now()<end) { if(await fn())return; await delay(40); } throw Error('condition timed out'); }
let win, service, manager, bus;
let delayFirstDocument = true;
class DelayedView extends electron.WebContentsView {
 constructor(options) {
  super(options);
  const wc = this.webContents, load = wc.loadURL.bind(wc);
  wc.loadURL = async url => {
   if (delayFirstDocument) { delayFirstDocument = false; await delay(6200); }
   if (!wc.isDestroyed()) return load(url);
  };
 }
}
const checks=[];function check(name, value) { checks.push({name,ok:Boolean(value)}); console.log(`${value?'PASS':'FAIL'} ${name}`); assert.ok(value,name); }
async function main() {
  const userDir=path.join(scratch,'plugins'); fs.mkdirSync(userDir);
  unpackPackage(packageDirectory(path.join(root,'docs/plugins/examples/page-studio')),path.join(userDir,'page-studio'));
  bus=createDataBus();registerSystemSources(bus,{powerMonitor:electron.powerMonitor});
  let settings={pluginsEnabled:true,pluginStates:{}};
  manager=createPluginManager({builtinDir:path.join(scratch,'none'),userDir,dataDir:path.join(scratch,'data'),bus,getSettings:()=>settings,saveStates:states=>{settings={...settings,pluginStates:states}}});manager.reload();manager.setEnabled('page-studio',true);
  const preload=path.join(scratch,'host-preload.cjs');
  fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{webSync:x=>ipcRenderer.invoke('plugins:web:sync',x),webSelect:(t,r)=>ipcRenderer.invoke('plugins:web:select',t,r),onWebRestore:cb=>ipcRenderer.on('plugins:web:restore',()=>cb()),onWebReady:cb=>ipcRenderer.on('plugins:web:ready',()=>cb()),onWebFailed:cb=>ipcRenderer.on('plugins:web:failed',(_event,reason)=>cb(reason))});`);
  const html=path.join(scratch,'host.html');
  fs.writeFileSync(html,`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${root}/src/electron/renderer/styles.css"><style>body{display:block;padding:16px;overflow:auto;background:#17191c;color:#eee}.shell{width:100%;height:auto;padding:12px}.footer{position:fixed;bottom:0;height:36px;background:#17191c;width:100%}.fixture-label{font:11px system-ui;color:#999}.breakdown{display:block}.breakdown p{padding:12px;border-bottom:1px solid #444}</style></head><body><main class="shell"><p class="fixture-label">Production page extension · synthetic usage</p><h2>Models</h2><section id="breakdown" class="breakdown"><p>Model Alpha  40,000</p><p>Model Beta  20,000</p></section></main><div class="footer">Token Monitor fixture</div><script src="file://${root}/src/electron/renderer/selectControl.js"></script><script src="file://${root}/src/electron/renderer/pluginPageDesigns.js"></script></body></html>`);
  win=new BrowserWindow({show:false,width:420,height:720,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  service=createWebUi({electron:{...electron,WebContentsView:DelayedView},manager,bus,isMainSender:event=>event.sender===win.webContents,file:path.join(scratch,'page-designs.json')});
  await win.loadFile(html);win.showInactive();
  const catalog=manager.list();
  await win.webContents.executeJavaScript(`window.input={visible:true,catalog:${JSON.stringify(catalog)},snapshot:{target:'model',period:'today',totalTokens:60000,costUsd:2,rows:[{label:'Model Alpha',tokens:40000,costUsd:1.5},{label:'Model Beta',tokens:20000,costUsd:.5}]}};window.paint=()=>controller.render(input);window.controller=TokenMonitorPluginPageDesigns.create({document,window,api,t:k=>({'plugins.web.design':'Page design','plugins.web.original':'App default'}[k]||k),breakdown:document.getElementById('breakdown'),update:()=>paint()});paint();`);
  await delay(150);fs.writeFileSync(path.join(scratch,'before.png'),(await win.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`const select=document.querySelector('select');select.value='page-studio/model';select.dispatchEvent(new Event('change'));`);
  await until(()=>service.current());
  check('original page remains visible during cold document load', !service.current().view.getVisible() && await win.webContents.executeJavaScript(`!document.getElementById('breakdown').classList.contains('plugin-web-replaced')`));
  fs.writeFileSync(path.join(scratch,'loading-fallback.png'),(await win.capturePage()).toPNG());
  await until(()=>service.current()?.view.getVisible(),9000);
  await until(()=>win.webContents.executeJavaScript(`document.getElementById('breakdown').classList.contains('plugin-web-replaced')`));
  check('completion notification hands off after main retry expiry',service.current().ready);

  const child=service.current().view.webContents;
  await until(()=>child.executeJavaScript('Boolean(document.querySelector(".bar"))').catch(()=>false));
  check('web UI runs in separate renderer process',child.getOSProcessId()!==win.webContents.getOSProcessId());
  check('fixed bridge exposed without Node or host bridge',await child.executeJavaScript(`typeof tm==='object'&&typeof require==='undefined'&&typeof tokenMonitor==='undefined'&&typeof process==='undefined'`));
  check('production snapshot renders model rows',await child.executeJavaScript(`document.getElementById('rows').textContent.includes('Model Alpha')`));
  check('packaged image decodes',await child.executeJavaScript(`document.querySelector('img').complete&&document.querySelector('img').naturalWidth>0`));
  check('network blocked',await child.executeJavaScript(`fetch('https://example.com/').then(()=>false,()=>true)`));
  check('ungranted source denied',await child.executeJavaScript(`tm.subscribe(['tm.limits']).then(()=>false,()=>true)`));
  check('storage roundtrip namespace',await child.executeJavaScript(`tm.storage.set('probe','saved').then(()=>tm.storage.get('probe')).then(v=>v==='saved')`));
  check('permission subscription produces detailed system data',await child.executeJavaScript(`tm.subscribe(['sys.details']).then(v=>typeof v==='object')`));
  await until(()=>bus.read('sys.details')?.value.cpu.status==='ok');
  await delay(500);fs.writeFileSync(path.join(scratch,'host-after.png'),(await win.capturePage()).toPNG());
  fs.writeFileSync(path.join(scratch,'authored-content.png'),(await child.capturePage()).toPNG());
  if (process.env.TM_WEB_PREVIEW === '1') { console.log(`PREVIEW_READY ${scratch}`); await new Promise(resolve=>setTimeout(resolve,60000)); }
  await win.webContents.executeJavaScript(`input.snapshot.rows[1].tokens=30000;paint()`);
  await delay(60);
  check('author CSS transition uses browser animation between host pushes',await child.executeJavaScript(`document.querySelectorAll('.bar')[1].getAnimations().length>0`));
  await win.webContents.executeJavaScript(`input.reducedMotion=true;paint()`);await delay(80);
  check('host reduced motion reaches author document',await child.executeJavaScript(`document.documentElement.dataset.reduced==='true'&&getComputedStyle(document.querySelector('.bar')).transitionDuration==='0s'`));
  await win.webContents.executeJavaScript(`document.documentElement.style.setProperty('--ui-font','serif');document.documentElement.style.setProperty('--glass-rgb','240, 241, 242');document.documentElement.style.colorScheme='light';paint()`);await delay(80);
  check('host font, background and light theme use production appearance tokens',await child.executeJavaScript(`tm.context().then(({theme})=>theme.font==='serif'&&theme.dark===false&&theme.colors.background==='rgb(240, 241, 242)'&&getComputedStyle(document.body).fontFamily==='serif')`));
  await win.webContents.executeJavaScript(`document.documentElement.style.removeProperty('--ui-font');document.documentElement.style.removeProperty('--glass-rgb');document.documentElement.style.removeProperty('color-scheme');paint()`);
  await win.webContents.executeJavaScript(`input.visible=false;paint()`);await until(()=>!service.current());
  check('hidden document retained without source demand',!child.isDestroyed()&&!service.current()&&bus.effectiveInterval('sys.details')===0);
  await win.webContents.executeJavaScript(`input.snapshot.rows[0].tokens=45000;input.visible=true;paint()`);await until(()=>service.current()?.ready&&!service.current()?.resuming&&!service.current()?.awaitingResume);await until(()=>service.current()?.view.getVisible());
  check('main page warm reopen reuses isolated document',service.current().view.webContents===child);
  check('main page warm reveal receives current snapshot',await child.executeJavaScript(`tm.context().then(v=>v.snapshot.rows[0].tokens===45000)`));
  await win.webContents.executeJavaScript(`input.visible=false;paint()`);await until(()=>!service.current());
  manager.setEnabled('page-studio',false);manager.setEnabled('page-studio',true);
  delayFirstDocument=true;
  await win.webContents.executeJavaScript(`input.visible=true;paint()`);await until(()=>service.current());
  const loadingChild=service.current().view.webContents;
  await win.webContents.executeJavaScript(`input.visible=false;paint()`);await delay(500);
  check('hiding during navigation prevents late resurrection and sampling',loadingChild.isDestroyed()&&!service.current()&&bus.effectiveInterval('sys.details')===0);
  await win.webContents.executeJavaScript(`input.visible=true;paint()`);await until(()=>service.current());
  await until(()=>service.current()?.view.webContents.executeJavaScript(`typeof tm==='object'`).catch(()=>false));
  manager.setEnabled('page-studio',false);check('disable immediately destroys view and subscription',!service.current()&&bus.effectiveInterval('sys.details')===0);
  await until(()=>win.webContents.executeJavaScript(`!document.querySelector('[role=status]').hidden`));
  manager.setEnabled('page-studio',true);await win.webContents.executeJavaScript(`input.catalog=${JSON.stringify(manager.list())};paint()`);await until(()=>service.current());
  await until(()=>service.current()?.view.webContents.executeJavaScript(`typeof tm==='object'`).catch(()=>false));
  const selectionFile=path.join(scratch,'page-designs.json'), retainedFile=`${selectionFile}.saved`;
  const mountedBeforeFailure=service.current();
  fs.renameSync(selectionFile,retainedFile);fs.mkdirSync(selectionFile);
  const restoreRejected=await mountedBeforeFailure.view.webContents.executeJavaScript(`tm.restoreOriginal().then(()=>false,()=>true)`);
  const selectRejected=await win.webContents.executeJavaScript(`api.webSelect('model','').then(()=>false,()=>true)`);
  const retainedMount=service.current()===mountedBeforeFailure;
  const afterFailure=await win.webContents.executeJavaScript(`api.webSync({visible:false})`);
  check('failed selection and restore preserve live selection and mounted document',restoreRejected&&selectRejected&&retainedMount&&afterFailure.selections.model==='page-studio/model');
  check('failed selection preserves persisted bytes',JSON.parse(fs.readFileSync(retainedFile,'utf8')).model==='page-studio/model');
  fs.rmdirSync(selectionFile);fs.renameSync(retainedFile,selectionFile);
  await win.webContents.executeJavaScript('paint()');await until(()=>service.current());
  await until(()=>service.current()?.view.webContents.executeJavaScript(`typeof tm==='object'`).catch(()=>false));
  void service.current().view.webContents.executeJavaScript('tm.restoreOriginal()').catch(()=>{});await until(()=>!service.current());
  check('restore clears selection without deleting plugin data',JSON.parse(fs.readFileSync(path.join(scratch,'page-designs.json'),'utf8')).model===undefined);
  await win.webContents.executeJavaScript(`document.querySelector('select').value='page-studio/model';document.querySelector('select').dispatchEvent(new Event('change'))`);await until(()=>service.current());
  await until(()=>service.current()?.view.webContents.executeJavaScript(`typeof tm==='object'`).catch(()=>false));
  for (const target of ['tool', 'device', 'model']) {
    const previous = service.current().view.webContents;
    await win.webContents.executeJavaScript(`input.snapshot.target='${target}';paint()`);
    await until(()=>win.webContents.executeJavaScript(`Boolean(document.querySelector('select option[value="page-studio/${target}"]'))`));
    await win.webContents.executeJavaScript(`document.querySelector('select').value='page-studio/${target}';document.querySelector('select').dispatchEvent(new Event('change'))`);
    await until(()=>service.current()?.target===target);
    await until(()=>service.current().view.webContents.executeJavaScript(`document.querySelector('h1')?.textContent==='${{tool:'Tools',device:'Devices',model:'Models'}[target]}'`).catch(()=>false));
    check(`${target} selection replaces previous document and keeps target-specific data`,previous.isDestroyed());
  }
  await win.webContents.executeJavaScript(`document.querySelector('.select-control-trigger').click()`);
  await until(()=>!service.current());
  check('host selection popup releases native child and demand',bus.effectiveInterval('sys.details')===0);
  await win.webContents.executeJavaScript(`document.querySelector('[popover]:popover-open').hidePopover()`);
  await until(()=>service.current());
  await until(()=>service.current().view.webContents.executeJavaScript(`typeof tm==='object'`).catch(()=>false));
  const runaway=service.current().view.webContents;void runaway.executeJavaScript('while(true){}').catch(()=>{});
  check('runaway child does not block host interaction',await win.webContents.executeJavaScript('1+1')===2);
  await until(()=>!service.current()&&runaway.isDestroyed(),12000);check('watchdog destroys runaway child',runaway.isDestroyed());
  manager.setEnabled('page-studio', false); manager.setEnabled('page-studio', true);
  await win.webContents.executeJavaScript(`input.catalog=${JSON.stringify(manager.list())};input.snapshot.target='tool';paint()`);
  await until(()=>service.current());
  fs.rmSync(path.join(userDir,'page-studio'),{recursive:true,force:true}); manager.reload();
  check('uninstall immediately revokes the mounted page and demand',!service.current()&&bus.effectiveInterval('sys.details')===0);
  fs.writeFileSync(path.join(scratch,'results.json'),JSON.stringify({checks,scratch},null,2));console.log(JSON.stringify({checks:checks.length,pass:checks.filter(c=>c.ok).length,scratch}));
}
app.whenReady().then(main).then(()=>{service?.dispose();manager?.dispose();bus?.dispose();win?.destroy();app.exit(0)}).catch(error=>{console.error(error);fs.writeFileSync(path.join(scratch,'results.json'),JSON.stringify({checks,error:String(error),scratch},null,2));service?.dispose();win?.destroy();app.exit(1)});
