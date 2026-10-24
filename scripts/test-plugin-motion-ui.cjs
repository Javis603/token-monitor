'use strict';
// Isolated real Chromium + production renderer/roller. Values are deterministic fixtures.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=process.env.TM_PLUGIN_ROOT || path.resolve(__dirname,'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'tm-plugin-motion-'));
app.setPath('userData',path.join(scratch,'userData'));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 app.dock?.hide();
 const html=`<!doctype html><html><head><meta charset="utf-8">
 <link rel="stylesheet" href="file://${root}/src/electron/renderer/styles.css">
 <link rel="stylesheet" href="file://${root}/src/electron/renderer/edgeDock/dock.css">
 <link rel="stylesheet" href="file://${root}/src/electron/renderer/pluginViews.css">
 <style>body{margin:0;width:560px;height:280px;background:#202124;color:#eee;font-family:system-ui}main{padding:24px;display:flex;gap:32px}.sample{width:145px}h2{font:500 13px system-ui;color:#a6a8ad;margin:0 0 20px}.edge-dock-root{height:125px;background:#303133;border-radius:14px}.edge-dock-cell{position:relative;width:100%;height:110px;display:flex;justify-content:center;align-items:center}.pv-compact-value,.edge-dock-stat-value{font-size:24px!important;max-width:none!important}.pv-compact-label,.edge-dock-stat-label{font-size:11px!important}.legacy .pv-compact-label,.legacy .pv-compact-value{font-family:var(--ui-font,ui-monospace,monospace)!important}footer{padding:0 24px;font:12px system-ui;color:#a6a8ad}</style></head><body>
 <main><section class="sample"><h2>之前 · 直接跳值</h2><div class="edge-dock-root legacy" id="before"><div class="edge-dock-cell edge-dock-cell-plugin" data-plugin-ref="demo/memory"><div class="edge-dock-plugin-cell"></div></div></div></section>
 <section class="sample"><h2>之後 · 跟隨 App</h2><div class="edge-dock-root" id="after"><div class="edge-dock-cell edge-dock-cell-plugin" data-plugin-ref="demo/memory"><div class="edge-dock-plugin-cell"></div></div></div></section>
 <section class="sample"><h2>內置 App · 同一過渡</h2><div class="edge-dock-root"><div class="edge-dock-cell"><div><div class="edge-dock-stat-label">今日</div><div class="edge-dock-stat-value" id="builtin">71M</div></div></div></div></section></main><footer>真實 renderer／原有動畫；固定測試值 71 → 72，非即時系統讀數。</footer>
 <div id="full"></div>
 <script src="file://${root}/src/electron/tokenNumberAnimation.js"></script><script src="file://${root}/src/electron/renderer/edgeDock/railNumberRoll.js"></script><script src="file://${root}/src/electron/renderer/edgeDock/pluginRailNumbers.js"></script><script src="file://${root}/src/shared/plugins/numberFormat.js"></script><script src="file://${root}/src/electron/renderer/pluginViews.js"></script>
 </body></html>`;
 fs.writeFileSync(path.join(scratch,'index.html'),html);
 const win=new BrowserWindow({show:false,width:560,height:280,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.showInactive();
 await win.loadFile(path.join(scratch,'index.html'));
 const run=source=>win.webContents.executeJavaScript(source);
 await run(`window.fixture=(()=>{
 const api=TokenMonitorEdgeDockRailNumberRoll, animation=TokenMonitorTokenNumberAnimation;
 const checks=[];const check=(name,ok,evidence)=>checks.push({name,ok:!!ok,evidence});
 const before=document.getElementById('before'),after=document.getElementById('after'),builtin=document.getElementById('builtin');
 let allow=true,mode='roll';const host=TokenMonitorPluginViews.createPluginViewHost({document,window,motionAllowed:()=>allow,motionMode:()=>mode});
 const oldHost=TokenMonitorPluginViews.createPluginViewHost({document,window});
 host.mount(after.querySelector('.edge-dock-plugin-cell'),'demo/memory','edgeDock',{variant:'compact'});
 oldHost.mount(before.querySelector('.edge-dock-plugin-cell'),'demo/memory','edgeDock',{variant:'compact'});
 host.mount(document.getElementById('full'),'demo/full','edgeDock');
 const roller=TokenMonitorPluginRailNumbers.create({railNumbers:api,animation,viewFor:ref=>host.state('edgeDock',ref),enabled:()=>allow,mode:()=>mode,numberFormat:TokenMonitorPluginNumberFormat});
 const built=api.create({animation,mode:()=>mode});
 const value=()=>after.querySelector('.pv-compact-value');
 const anims=node=>node.getAnimations({subtree:true}).length;
 const payload=(number,opts={})=>({surface:'edgeDock',views:{'demo/memory':{status:opts.status||'ok',revision:opts.revision||1,compact:{label:'記憶體',value:number==null?'—':number+'%',valueNumber:number,valueFormat:{fmt:'percent',digits:0,locale:'zh-TW'},motion:opts.motion}},'demo/full':{status:'ok',revision:1,tree:{type:'stack',children:[{type:'ring',value:number,motion:'none'},{type:'ring',value:number,motion:'inherit'}]}}}});
 const push=(number,opts={})=>{const snapshot=roller.capture(after);host.update(payload(number,opts));oldHost.update(payload(number,opts));roller.update(after,snapshot,opts);};
 const baseline=(from=71)=>{allow=true;push(from);roller.settle();builtin.textContent=from+'M';api.mark(builtin,'builtin',from,n=>Math.round(n)+'M');};
 const compare=(from=71,to=72)=>{baseline(from);const snapshot=built.capture(builtin.parentElement);push(to);builtin.textContent=to+'M';api.mark(builtin,'builtin',to,n=>Math.round(n)+'M');built.play(builtin.parentElement,snapshot);};
 return {check,checks,push,baseline,compare,value,anims,roller,built,after,before,builtin,host,mode:v=>{mode=v;host.refreshMotion();},allow:v=>{allow=v;}};
})();undefined`);
 const result=await run(`(async()=>{const f=fixture,wait=ms=>new Promise(r=>setTimeout(r,ms));f.baseline();
 f.check('initial-reading-is-static',f.anims(f.value())===0);
 f.push(72);await wait(80);
 f.check('same-existing-app-roller-runs',f.anims(f.value())>0&&f.value().dataset.tokenNumberAnimation==='roll',{animations:f.anims(f.value())});
 f.check('legacy-update-does-not-roll',f.anims(f.before)===0);
 await wait(1000);f.check('settles-to-exact-reading',f.value().textContent==='72%'&&f.anims(f.value())===0);
 f.push(73,{motion:'none'});f.check('author-none-is-static',f.anims(f.value())===0&&f.value().dataset.pluginRoll===undefined);
 f.push(74,{motion:'inherit'});f.push(75,{motion:'inherit'});f.check('explicit-inherit-rolls',f.anims(f.value())>0);
 f.allow(false);f.push(76);f.check('host-preference-wins',f.anims(f.value())===0);
 f.allow(true);f.push(77,{revealing:true});f.check('reveal-does-not-roll',f.anims(f.value())===0);
 f.push(78,{revision:2});f.check('new-worker-revision-does-not-roll',f.anims(f.value())===0);
 f.push(null);f.check('missing-reading-is-static',f.anims(f.value())===0&&f.value().textContent==='—');
 f.baseline();f.push(72);await wait(70);f.push(70);await wait(1000);f.check('rapid-retarget-settles-exactly',f.value().textContent==='70%'&&f.anims(f.value())===0);
 f.compare();const builtAnims=f.builtin.getAnimations({subtree:true});f.push(73);
 f.check('plugin-push-does-not-cancel-builtins',builtAnims.length>0&&builtAnims.every(a=>a.playState!=='idle'));
 f.roller.settle();f.built.settle();
 const rings=[...document.querySelectorAll('#full .pv-ring-arc')];
 f.check('per-node-css-opt-out',getComputedStyle(rings[0]).transitionDuration==='0s'&&getComputedStyle(rings[1]).transitionDuration!=='0s');
 document.documentElement.dataset.reduceMotion='on';f.check('app-reduced-motion-suppresses-component-transition',rings.every(n=>getComputedStyle(n).transitionDuration==='0s'));delete document.documentElement.dataset.reduceMotion;
 const pluginStyle=getComputedStyle(f.value()),builtStyle=getComputedStyle(f.builtin);
 f.check('compact-font-matches-built-in',pluginStyle.fontFamily===builtStyle.fontFamily,{plugin:pluginStyle.fontFamily,builtIn:builtStyle.fontFamily});
 f.check('baseline-font-mismatch-reproduced',getComputedStyle(f.before.querySelector('.pv-compact-value')).fontFamily!==builtStyle.fontFamily);
 for(const font of ['system-ui','monospace']){document.documentElement.style.setProperty('--display-font',font);f.check('font-token-'+font,getComputedStyle(f.value()).fontFamily===getComputedStyle(f.builtin).fontFamily&&f.value().scrollWidth<=f.after.clientWidth);}
 document.documentElement.style.removeProperty('--display-font');
 const stage=document.getElementById('full');stage.style.cssText='position:fixed;top:0;left:0;width:550px;display:flex;gap:5px;opacity:0;pointer-events:none';
 let active=true,fullMode='roll';
 const fullHost=TokenMonitorPluginViews.createPluginViewHost({document,window,motionAllowed:()=>active,isSurfaceActive:()=>active,motionMode:()=>fullMode});
 const mounts={};
 for(const surface of ['home','page','notch','edgeDock']){const m=document.createElement('div');stage.append(m);mounts[surface]=m;fullHost.mount(m,'demo/values',surface);}
 const tree=value=>({type:'stack',children:[{type:'stat',value:value+'%',valueNumber:value,valueFormat:{fmt:'percent',digits:0}},{type:'stat',value:value+'%',valueNumber:value,valueFormat:{fmt:'percent',digits:0},motion:'none'},{type:'ring',value},{type:'ring',value,caption:'v'+value}]});
 const pushFull=(value,revision=1)=>{for(const surface of Object.keys(mounts))fullHost.update({surface,views:{'demo/values':{status:'ok',revision,tree:tree(value)}}});};
 pushFull(71);await wait(30);pushFull(72);
 for(const [surface,m] of Object.entries(mounts)) {
  const stats=m.querySelectorAll('.pv-stat-number'),rings=m.querySelectorAll('.pv-ring-caption');
  f.check(surface+'-full-numbers-inherit-existing-roll',f.anims(stats[0])>0&&f.anims(rings[0])>0);
  f.check(surface+'-author-none-and-text-caption-stay-static',f.anims(stats[1])===0&&f.anims(rings[1])===0);
 }
 active=false;fullHost.refreshMotion();f.check('host-preference-immediately-settles-all-surfaces',Object.values(mounts).every(m=>f.anims(m)===0));
 active=true;pushFull(73,2);f.check('full-view-revision-does-not-replay',Object.values(mounts).every(m=>f.anims(m)===0));

 fullMode='count';fullHost.refreshMotion();pushFull(100,2);pushFull(200,2);await wait(100);
 for(const [surface,m] of Object.entries(mounts)) {
  const stats=m.querySelectorAll('.pv-stat-number');
  const visible=parseInt(stats[0].textContent,10);
  f.check(surface+'-Count-interpolates-without-Roll',visible>100&&visible<200&&f.anims(stats[0])===0,{text:stats[0].textContent});
  f.check(surface+'-Count-respects-author-none',stats[1].textContent==='200%');
 }
 active=false;fullHost.refreshMotion();f.check('Count-global-reduce-settles-exactly',Object.values(mounts).every(m=>m.querySelector('.pv-stat-number').textContent==='200%'));
 active=true;pushFull(300,2);fullMode='roll';fullHost.refreshMotion();
 f.check('mode-change-cancels-old-Count',Object.values(mounts).every(m=>TokenMonitorTokenNumberAnimation.currentCountValue(m.querySelector('.pv-stat-number'))===undefined));
 stage.remove();fullHost.refreshDemand();
 f.mode('count');f.push(100);f.roller.settle();f.push(200);await wait(100);
 f.check('compact-Count-interpolates',parseInt(f.value().textContent,10)>100&&parseInt(f.value().textContent,10)<200&&f.anims(f.value())===0);
 f.push(50);await wait(100);f.roller.settle();f.check('compact-Count-retarget-settles-exactly',f.value().textContent==='50%');
 f.mode('roll');f.baseline();return f.checks;})()`);
 fs.writeFileSync(path.join(scratch,'results.json'),JSON.stringify(result,null,2));
 await run('fixture.compare()');
 // Freeze real WAAPI frames at deterministic times for repeatable visual evidence.
 for(let i=0;i<=18;i++){
  await run(`document.getAnimations().forEach(a=>{a.pause();a.currentTime=${i*50}})`);
  const image=await win.webContents.capturePage();fs.writeFileSync(path.join(scratch,`frame-${String(i).padStart(2,'0')}.png`),image.toPNG());
 }
 await run("fixture.mode('count');fixture.compare(100,200);document.querySelector('footer').textContent='真實 renderer／既有 Count 插值；固定測試值 100 → 200。'");
 const started=Date.now();
 for(let i=0;i<=20;i++){
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,i*50-(Date.now()-started))));
  const image=await win.webContents.capturePage();fs.writeFileSync(path.join(scratch,`count-${String(i).padStart(2,'0')}.png`),image.toPNG());
 }
 console.log(JSON.stringify({scratch,passed:result.filter(r=>r.ok).length,total:result.length,checks:result},null,2));
 win.destroy();app.exit(result.every(r=>r.ok)?0:1);
}).catch(e=>{console.error(e);app.exit(1)});
