'use strict';
// Production isolated child/bridge/manager and surface adapter. Synthetic host
// shell geometry, disposable profile, no primary App or remote-debugging port.
const electron = require('electron');
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { createWebUi, registerWebUiScheme } = require('../src/electron/plugins/webUi');
const { createPluginManager } = require('../src/electron/plugins/manager');
const { createDataBus } = require('../src/shared/plugins/dataBus');
const { packageDirectory, unpackPackage } = require('../src/electron/plugins/package');
const { preventAppActivation } = require('../src/electron/macosSpaceBehavior');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-surface-web-'));
app.setPath('userData',path.join(scratch,'profile')); registerWebUiScheme(electron.protocol);app.on('window-all-closed',()=>{});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(40)}throw Error('condition timed out');}
let delayFirstDocument = true, loadDelayMs = 3000, nextLoadBarrier;
const recovery = [];
function armLoadBarrier() {
 let release, finish;
 const gate = new Promise(resolve => { release = resolve; });
 const settled = new Promise(resolve => { finish = resolve; });
 return nextLoadBarrier = { gate, release, finish, settled, wc: null, navigated: false };
}
class DelayedView extends electron.WebContentsView {
 constructor(options) {
  super(options);
  const wc = this.webContents, load = wc.loadURL.bind(wc);
  wc.loadURL = async url => {
   const barrier = nextLoadBarrier;
   if (barrier) {
    nextLoadBarrier = null; barrier.wc = wc;
    recovery.push({event:'load-barrier-entered',id:wc.id,at:Date.now()});
    await barrier.gate;
    try { if (!wc.isDestroyed()) { barrier.navigated = true; return await load(url); } }
    finally { barrier.finish(); }
    return;
   }
   if (delayFirstDocument) { delayFirstDocument = false; await delay(loadDelayMs); }
   if (!wc.isDestroyed()) return load(url);
  };
 }
}
const checks=[];function check(name,ok){checks.push({name,ok:Boolean(ok)});console.log(`${ok?'PASS':'FAIL'} ${name}`);assert.ok(ok,name);}
let service,manager,bus,settings={pluginsEnabled:true,pluginStates:{}},sampleCalls=0;const hosts=new Map();let placed=true;
const child=kind=>service.surfaces().find(item=>item.floating.kind===kind)?.view.webContents;
async function coldVisibilityRecovery(h) {
 // Stop prior author work, then let the actual renderer adapter own every sync.
 h.active=false; await h.win.webContents.executeJavaScript('live=false;adapter.refresh()'); service.refreshSurfaces();
 await until(()=>h.win.webContents.executeJavaScript(`!document.getElementById('mount').classList.contains('pv-web-mounted')&&!document.getElementById('mount').classList.contains('pv-web-pending')`));
 manager.setEnabled('surface-studio',false); manager.setEnabled('surface-studio',true);
 delayFirstDocument=false;
 const barrier=armLoadBarrier(), start=performance.now();
 const record=event=>recovery.push({event,at:Date.now()});
 const onHide=()=>record('owner-hide'),onShow=()=>record('owner-show');
 h.win.on('hide',onHide);h.win.on('show',onShow);
 try {
  h.active=true;await h.win.webContents.executeJavaScript('live=true;adapter.refresh()');
  await until(()=>barrier.wc);
  const old=service.surfaces().find(i=>i.host===h.win.webContents),stale=barrier.wc,staleId=stale.id;
  stale.once('destroyed',()=>record('stale-destroyed'));
  check('cold visibility: production sync reaches pre-navigation barrier',old?.view.webContents===stale&&!old.loaded&&!old.ready);
  // Inject the same native event boundary while isVisible() remains true.
  h.win.emit('hide');
  check('cold visibility: transient hide tears down even while native visible',h.win.isVisible()&&old.dead);
  check('cold visibility: native hide destroys incomplete child and releases demand',old.dead&&!child(h.kind)&&bus.effectiveInterval('sys.cpu')===0&&service.cached().length===0);
  h.win.emit('show');
  await until(()=>stale.isDestroyed());barrier.release();await barrier.settled;
  check('cold visibility: released stale load cannot navigate or resurrect',!barrier.navigated&&stale.isDestroyed()&&child(h.kind)!==stale);
  // No adapter.refresh(), resize, payload update or direct sync after showing.
  await until(()=>h.win.webContents.executeJavaScript(`document.getElementById('mount').classList.contains('pv-web-mounted')`),Math.max(1,5000-(performance.now()-start)));
  const fresh=service.surfaces().find(i=>i.host===h.win.webContents),elapsedMs=performance.now()-start;
  check('cold visibility: production adapter remounts a fresh ready child within existing deadline',elapsedMs<5000&&fresh?.ready&&fresh.view.getVisible()&&fresh.view.webContents!==stale&&stale.isDestroyed());
  check('cold visibility: recovered child restores production source subscription',bus.effectiveInterval('sys.cpu')===2000&&await fresh.view.webContents.executeJavaScript(`document.getElementById('value').textContent==='37%'`));
  recovery.push({event:'recovered',elapsedMs,staleId,freshId:fresh.view.webContents.id,at:Date.now()});
 } finally {barrier.release();h.win.removeListener('hide',onHide);h.win.removeListener('show',onShow);fs.writeFileSync(path.join(scratch,'cold-visibility.json'),JSON.stringify(recovery,null,2));}
}
async function main(){
 const userDir=path.join(scratch,'plugins');fs.mkdirSync(userDir);unpackPackage(packageDirectory(path.join(root,'docs/plugins/examples/surface-studio')),path.join(userDir,'surface-studio'));
 bus=createDataBus();bus.defineSource('sys.cpu',{minIntervalMs:1000,sample:()=>{sampleCalls++;return 37}});
 manager=createPluginManager({builtinDir:path.join(scratch,'none'),userDir,dataDir:path.join(scratch,'data'),bus,getSettings:()=>settings,saveStates:states=>{settings={...settings,pluginStates:states}}});manager.reload();manager.setEnabled('surface-studio',true);
 const storage=manager.webStorage.bind(manager);manager.webStorage=async(...args)=>{if(args[1]==='get')await delay(250);return storage(...args)};
 const preload=path.join(scratch,'preload.cjs');fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('bridge',{syncWebSurface:x=>ipcRenderer.invoke('plugins:surface:sync',x),onWebSurfaceReady:cb=>ipcRenderer.on('plugins:surface:ready',()=>cb()),onWebSurfaceFailed:cb=>ipcRenderer.on('plugins:surface:failed',(_e,x)=>cb(x))});ipcRenderer.on('plugins:surface:escape',()=>window.dispatchEvent(new Event('escape')));`);
 service=createWebUi({electron:{...electron,WebContentsView:DelayedView},manager,bus,isMainSender:()=>false,surfaceContext:(event,surface)=>{const h=hosts.get(event.sender.id);return h&&h.surface===surface?{kind:h.kind,visible:h.active,preparing:h.preparing===true}:null},surfacePlaced:()=>placed,file:path.join(scratch,'selections.json')});
 for(const [kind,width,height] of (process.argv.includes('--cold-visibility-only') ? [['notch',640,340]] : [['notch',640,340],['bubble',320,350],['rail',96,300]])){
  const surface=kind==='notch'?'notch':'edgeDock';
  const html=path.join(scratch,`${kind}.html`);fs.writeFileSync(html,`<!doctype html><html><head><link rel="stylesheet" href="file://${root}/src/electron/renderer/pluginViews.css"><style>html{--text:#eee;--muted:#aaa;--accent:#79cbb7}body{margin:0;background:transparent;color:#eee;font:13px system-ui}.shell{margin:8px;background:linear-gradient(#131313,#252525);border-radius:18px;padding:18px;height:calc(100vh - 16px);box-sizing:border-box}header{height:34px}#mount{min-height:70px}button{color:inherit;background:#333;border:0;border-radius:8px;padding:6px}.fixture{font-size:10px;color:#aaa}</style></head><body><main class="shell"><header><button id="nav">Home</button> <span class="fixture">${kind} · production adapter fixture</span></header><div id="mount"></div></main><script src="file://${root}/src/electron/renderer/pluginViews.js"></script><script src="file://${root}/src/electron/renderer/pluginSurfaceWeb.js"></script></body></html>`);
  const win=new BrowserWindow({width,height,show:false,frame:false,transparent:true,focusable:false,type:'panel',webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});preventAppActivation(win);hosts.set(win.webContents.id,{win,kind,surface,active:kind!=='notch',preparing:kind==='notch'});await win.loadFile(html);win.showInactive();
  manager.setSurfaceDemand(surface,['surface-studio/system']);const payload=manager.payload(surface);manager.setSurfaceDemand(surface,[]);
  await win.webContents.executeJavaScript(`window.payload=${JSON.stringify(payload)};window.live=true;window.reduce=false;window.events=[];document.addEventListener('mousedown',e=>events.push({type:'down',x:e.clientX,y:e.clientY}));document.addEventListener('mouseup',e=>events.push({type:'up',x:e.clientX,y:e.clientY}));window.host=TokenMonitorPluginViews.createPluginViewHost({document,window,onMount:m=>adapter.track(m),onPaint:m=>adapter.prepare(m)});window.adapter=TokenMonitorPluginSurfaceWeb.create({document,window,bridge,surface:'${surface}',kind:'${kind}',active:()=>live,reducedMotion:()=>reduce,t:()=> 'Loading',stateFor:ref=>host.state('${surface}',ref)});host.mount(document.getElementById('mount'),'surface-studio/system','${surface}',{variant:'${kind==='rail'?'compact':'full'}'});`);
  fs.writeFileSync(path.join(scratch,`${kind}-before.png`),(await win.capturePage()).toPNG());
  check(`${kind}: initial IPC wait never paints a loading layout`, await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.pv-placeholder')).visibility==='hidden'`));
  await win.webContents.executeJavaScript(`host.update(payload);adapter.refresh();window.frames=[];window.frameTimer=setInterval(()=>{const n=document.getElementById('mount');frames.push({at:performance.now(),height:n.offsetHeight,light:getComputedStyle(n.firstElementChild).visibility!=='hidden',rich:n.classList.contains('pv-web-mounted'),pending:n.classList.contains('pv-web-pending')})},16);`);
  await until(()=>child(kind));
  if (kind === 'notch') check('slow rich load hides both native child and intermediate declarative layout', !service.surfaces().find(i=>i.floating.kind===kind).view.getVisible() && await win.webContents.executeJavaScript(`!document.getElementById('mount').classList.contains('pv-web-mounted') && getComputedStyle(document.querySelector('.pv-root')).visibility==='hidden'&&document.getElementById('mount').classList.contains('pv-web-pending')`));
  fs.writeFileSync(path.join(scratch,`${kind}-pending.png`),(await win.capturePage()).toPNG());
  await new Promise(resolve=>child(kind).isLoading()?child(kind).once('did-finish-load',resolve):resolve());
  if(kind==='notch') {
   check('native opening scope can prepare before it can reveal',Boolean(child(kind))&&!service.surfaces().find(i=>i.floating.kind===kind).view.getVisible());
   await delay(350);check('native opening authority forbids early reveal even after preparation',!service.surfaces().find(i=>i.floating.kind===kind).view.getVisible());
   const scope=hosts.get(win.webContents.id);scope.active=true;scope.preparing=false;await win.webContents.executeJavaScript('adapter.refresh()');
  }
  await until(()=>win.webContents.executeJavaScript(`document.getElementById('mount').classList.contains('pv-web-mounted')`));
  check(`${kind}: completion notification reveals ready child after retry expiry`,service.surfaces().find(i=>i.floating.kind===kind).view.getVisible());
  check(`${kind}: first presentation already includes initial subscription data`, await child(kind).executeJavaScript(`document.getElementById('value').textContent==='37%'`));
  check(`${kind}: opening has no visible declarative frame and stable height`,await win.webContents.executeJavaScript(`clearInterval(frameTimer);frames.length>0&&frames.every(f=>!f.light)&&new Set(frames.map(f=>f.height)).size===1`));
  fs.writeFileSync(path.join(scratch,`${kind}-frames.json`),JSON.stringify(await win.webContents.executeJavaScript('frames')));

  check(`${kind}: authored browser animation and isolated renderer`,await child(kind).executeJavaScript(`document.querySelector('.wave').getAnimations().length===1&&typeof require==='undefined'`)&&child(kind).getOSProcessId()!==win.webContents.getOSProcessId());
  check(`${kind}: transparent author body`,await child(kind).executeJavaScript(`getComputedStyle(document.body).backgroundColor==='rgba(0, 0, 0, 0)'`));
  fs.writeFileSync(path.join(scratch,`${kind}-content.png`),(await child(kind).capturePage()).toPNG());
 }
 if(process.argv.includes('--cold-visibility-only')) {await coldVisibilityRecovery([...hosts.values()][0]);fs.writeFileSync(path.join(scratch,'results.json'),JSON.stringify({checks,recovery,scratch},null,2));console.log(JSON.stringify({checks:checks.length,pass:checks.filter(c=>c.ok).length,scratch}));return;}
 check('three independently mounted surfaces coexist',service.surfaces().length===3);
 check('concurrent author surfaces have separate renderer processes',new Set(service.surfaces().map(i=>i.view.webContents.getOSProcessId())).size===3);
 check('shared source uses one sampler',bus.effectiveInterval('sys.cpu')===2000&&sampleCalls<5);
 const bubble=[...hosts.values()].find(h=>h.kind==='bubble'),rail=[...hosts.values()].find(h=>h.kind==='rail'),notch=[...hosts.values()].find(h=>h.kind==='notch');
 const firstBubble=child('bubble');
 for(let n=0;n<3;n++){
  bubble.active=false;service.refreshSurfaces();await bubble.win.webContents.executeJavaScript('live=false;adapter.refresh()');await delay(80);
  bubble.active=true;await bubble.win.webContents.executeJavaScript('live=true;adapter.refresh()');await until(()=>bubble.win.webContents.executeJavaScript(`document.getElementById('mount').classList.contains('pv-web-mounted')`));
  check(`bubble hover ${n+1}: same rich page with no loading label`,child('bubble')===firstBubble&&await bubble.win.webContents.executeJavaScript(`!document.getElementById('mount').classList.contains('pv-web-waiting')`));
 }
 const retained=child('bubble');bubble.win.setSize(330,360);await delay(400);
 check('visible native resize retains document instead of reloading',child('bubble')===retained&&!retained.isDestroyed());
 const wc=child('bubble');const point=await wc.executeJavaScript(`(()=>{const r=note.getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()`);
 wc.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});wc.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});await delay(100);wc.sendInputEvent({type:'char',keyCode:'a'});await delay(80);
 check('click enables text input with native nonactivating panel installed',await wc.executeJavaScript(`document.activeElement.id==='note'&&note.value==='a'`));
 await wc.insertText('中文');check('Chromium text insertion accepts CJK',await wc.executeJavaScript(`note.value==='a中文'`));
 wc.debugger.attach('1.3');await wc.executeJavaScript(`window.compositions=[];note.addEventListener('compositionstart',()=>compositions.push('start'));note.addEventListener('compositionend',()=>compositions.push('end'));`);await wc.debugger.sendCommand('Input.imeSetComposition',{text:'輸入',selectionStart:0,selectionEnd:2});await wc.debugger.sendCommand('Input.insertText',{text:'輸入'});check('Chromium composition survives child focus',await wc.executeJavaScript(`compositions.includes('start')&&compositions.includes('end')&&note.value.includes('輸入')`));wc.debugger.detach();
 wc.sendInputEvent({type:'keyDown',keyCode:'TAB'});wc.sendInputEvent({type:'keyUp',keyCode:'TAB'});await delay(80);check('keyboard Tab moves inside authored content',await wc.executeJavaScript(`document.activeElement.className==='scroll'`));
 const scroll=await wc.executeJavaScript(`(()=>{const r=document.querySelector('.scroll').getBoundingClientRect();return{x:r.x+8,y:r.y+8}})()`);wc.sendInputEvent({type:'mouseWheel',...scroll,deltaY:-60,deltaX:0,canScroll:true});await delay(160);check('wheel scrolls authored details',await wc.executeJavaScript(`document.querySelector('.scroll').scrollTop>0`));
 const railWc=child('rail'),railItem=service.surfaces().find(x=>x.floating.kind==='rail');railWc.sendInputEvent({type:'mouseDown',x:10,y:10,button:'left',clickCount:1});railWc.sendInputEvent({type:'mouseUp',x:10,y:10,button:'left',clickCount:1});await delay(100);const forwarded=await rail.win.webContents.executeJavaScript('events');check('compact rail mouse input reaches host coordinates',forwarded.length===2&&Math.abs(forwarded[0].x-(railItem.view.getBounds().x+10))<1);
 wc.sendInputEvent({type:'keyDown',keyCode:'ESCAPE'});await delay(60);check('Escape returns keyboard ownership to host',!bubble.win.isFocusable());
 for(const h of hosts.values())await h.win.webContents.executeJavaScript(`reduce=true;adapter.refresh()`);await delay(100);check('global reduced motion reaches every author surface',(await Promise.all(service.surfaces().map(i=>i.view.webContents.executeJavaScript(`document.querySelector('.wave').getAnimations().length===0`)))).every(Boolean));
 check('author cannot obtain ungranted data or restore App selection',await wc.executeJavaScript(`Promise.all([tm.subscribe(['tm.limits']).then(()=>false,()=>true),tm.restoreOriginal().then(()=>false,()=>true)]).then(a=>a.every(Boolean))`));
 await notch.win.webContents.executeJavaScript(`document.querySelector('.shell').style.zoom='.8';adapter.refresh()`);await delay(120);check('Notch CSS zoom propagates to native child',Math.abs(child('notch').getZoomFactor()-.8)<.02);
 for(const zoom of [.75,1,1.5]){bubble.win.webContents.setZoomFactor(zoom);await bubble.win.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))');await delay(220);const item=service.surfaces().find(i=>i.floating.kind==='bubble');check(`zoom ${zoom}: child remains inside native bounds`,Boolean(item)&&item.view.getBounds().x+item.view.getBounds().width<=bubble.win.getContentSize()[0]&&item.view.getBounds().y+item.view.getBounds().height<=bubble.win.getContentSize()[1]);}
 // No host payload/resize is sent during these transitions: completion must
 // wake the adapter even while opacity or the current rectangle is ineligible.
 await notch.win.webContents.executeJavaScript(`document.querySelector('.shell').style.transition='opacity .22s ease';document.querySelector('.shell').style.opacity='0'`);await delay(500);
 check('faded host removes authored child',!child('notch'));
 await notch.win.webContents.executeJavaScript(`document.querySelector('.shell').style.transition='opacity .8s linear';document.querySelector('.shell').style.opacity='1'`);await delay(180);
 check('opening opacity prepares child before shell animation completes',Boolean(child('notch'))&&!service.surfaces().find(i=>i.floating.kind==='notch').view.getVisible());
 await delay(1000);
 check('opacity completion remounts without data or resize',Boolean(child('notch')));
 await notch.win.webContents.executeJavaScript(`document.querySelector('.shell').style.transition='transform .22s ease';document.querySelector('.shell').style.transform='translateX(-800px)'`);await delay(500);
 check('offscreen host removes authored child',!child('notch'));
 await notch.win.webContents.executeJavaScript(`document.querySelector('.shell').style.transform='none'`);await delay(800);
 check('geometry completion remounts without data or resize',Boolean(child('notch')));
 const oldNotch=child('notch');notch.active=false;service.refreshSurfaces();await until(()=>!child('notch'));check('collapse immediately hides child without waiting for renderer',!oldNotch.isDestroyed()&&!child('notch')&&Boolean(child('rail')));
 await notch.win.webContents.executeJavaScript('live=false;adapter.refresh()');
 const oldBubble=child('bubble');bubble.win.hide();await until(()=>!child('bubble'));check('native hide parks only that surface',!oldBubble.isDestroyed()&&Boolean(child('rail')));
 rail.active=false;service.refreshSurfaces();await rail.win.webContents.executeJavaScript('live=false;adapter.refresh()');await delay(80);check('last hidden surface releases all source sampling',bus.effectiveInterval('sys.cpu')===0);
 const samples=sampleCalls;await delay(1100);check('zero demand does not sample on a timer',sampleCalls===samples);
 const reusableNotch=!oldNotch.isDestroyed();notch.active=true;await notch.win.webContents.executeJavaScript('live=true;adapter.refresh()');await until(()=>child('notch'));await until(()=>notch.win.webContents.executeJavaScript(`document.getElementById('mount').classList.contains('pv-web-mounted')`));
 check('warm reopen reuses document and goes straight to authored layout',(!reusableNotch||child('notch')===oldNotch)&&await notch.win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.pv-root')).visibility==='hidden'&&!document.getElementById('mount').classList.contains('pv-web-pending')`));
 const warm=child('notch');notch.active=false;service.refreshSurfaces();await until(()=>!child('notch'));
 // Explicitly evict before exercising the genuinely cold-load deadline.
 manager.setEnabled('surface-studio',false);manager.setEnabled('surface-studio',true);await until(()=>warm.isDestroyed());await notch.win.webContents.executeJavaScript('live=false;adapter.refresh()');await delay(80);
 delayFirstDocument=true;loadDelayMs=5400;notch.active=true;await notch.win.webContents.executeJavaScript('live=true;adapter.refresh()');await until(()=>child('notch'));const slow=child('notch');await delay(5500);
 check('deadline shows one stable fallback and cancels the slow document',slow.isDestroyed()&&!child('notch')&&await notch.win.webContents.executeJavaScript(`!document.getElementById('mount').classList.contains('pv-web-pending')&&getComputedStyle(document.querySelector('.pv-root')).visibility==='visible'`));
 notch.active=false;service.refreshSurfaces();await notch.win.webContents.executeJavaScript('live=false;adapter.refresh()');await delay(80);notch.active=true;await notch.win.webContents.executeJavaScript('live=true;adapter.refresh()');await until(()=>child('notch'));await until(()=>notch.win.webContents.executeJavaScript(`document.getElementById('mount').classList.contains('pv-web-mounted')`));
 check('reopen retries after a previous deadline',Boolean(child('notch')));
 notch.active=false;service.refreshSurfaces();await notch.win.webContents.executeJavaScript('live=false;adapter.refresh()');await delay(80);
 manager.setEnabled('surface-studio',false);manager.setEnabled('surface-studio',true);delayFirstDocument=true;loadDelayMs=3000;notch.active=true;await notch.win.webContents.executeJavaScript('live=true;adapter.refresh()');await until(()=>child('notch'));manager.setEnabled('surface-studio',false);check('disable immediately revokes child and demand',service.surfaces().length===0&&bus.effectiveInterval('sys.cpu')===0);await delay(500);check('delayed load cannot resurrect a revoked child',service.surfaces().length===0&&bus.effectiveInterval('sys.cpu')===0);
 manager.setEnabled('surface-studio',true);await notch.win.webContents.executeJavaScript(`payload=${JSON.stringify(manager.payload('notch'))};window.dispatchEvent(new Event('resize'));`);
 // Fresh authoritative view state following enable.
 manager.setSurfaceDemand('notch',['surface-studio/system']);const next=manager.payload('notch');manager.setSurfaceDemand('notch',[]);await notch.win.webContents.executeJavaScript(`host.update(${JSON.stringify(next)});adapter.refresh()`);await until(()=>child('notch'));
 placed=false;service.refreshSurfaces();check('placement removal revokes mounted document',!child('notch'));placed=true;
 await notch.win.webContents.executeJavaScript(`window.dispatchEvent(new Event('resize'))`);await until(()=>child('notch'));
 await coldVisibilityRecovery(notch);
 fs.rmSync(path.join(userDir,'surface-studio'),{recursive:true,force:true});manager.reload();check('uninstall revokes every origin and subscription',service.surfaces().length===0&&bus.effectiveInterval('sys.cpu')===0);
 fs.writeFileSync(path.join(scratch,'results.json'),JSON.stringify({checks,scratch,platform:process.platform,limits:['Synthetic host shell; no physical Notch geometry acceptance','CJK text insertion is not an IME composition test','Native screen composition not captured']},null,2));console.log(JSON.stringify({checks:checks.length,pass:checks.filter(c=>c.ok).length,scratch}));
}
function cleanup(){service?.dispose();manager?.dispose();bus?.dispose();for(const h of hosts.values())if(!h.win.isDestroyed())h.win.destroy();}
app.whenReady().then(main).then(()=>{cleanup();app.exit(0)}).catch(error=>{console.error(error);fs.writeFileSync(path.join(scratch,'results.json'),JSON.stringify({checks,error:String(error),scratch},null,2));cleanup();app.exit(1)});
