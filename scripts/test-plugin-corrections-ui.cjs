'use strict';
// Deterministic Chromium fixture: production ring renderer and Notch navigation,
// synthetic readings/geometry; no primary App, user data or debugging port.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createResolver } = require('../src/shared/plugins/bindings');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-corrections-'));
const manifest = require('../src/electron/plugins/builtin/system-monitor/manifest.json');
const rings = [];
function walk(node) { if (!node || typeof node !== 'object') return; if (node.type === 'ring') rings.push(node); if (Array.isArray(node)) node.forEach(walk); else Object.values(node).forEach(walk); }
walk(manifest.views);
const trees = [20, 80].map(value => createResolver({ read: id => ({ value: id === 'sys.cpu' ? value : { percent: value } }), history: () => [], pluginId: manifest.id }).resolveNode({ type: 'stack', dir: 'row', gap: 24, children: rings }));
const dock = path.join(root, 'src/electron/renderer/edgeDock');
const scripts = [...fs.readFileSync(path.join(dock, 'index.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(s => !['dock.js', '../notch/panel.js'].includes(s));
// The before lane is a visual comparison only; no check reads it. A shallow
// clone or squash merge loses the baseline commit, so fall back to the current
// panel instead of failing before any check runs.
const baselineRef = process.env.TM_NOTCH_BASELINE || 'be3a88f3f';
let before;
try {
  before = execFileSync('git', ['show', `${baselineRef}:src/electron/renderer/notch/panel.js`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch {
  console.warn(`Baseline ${baselineRef} unavailable; the before lane renders the current panel.`);
  before = fs.readFileSync(path.join(root, 'src/electron/renderer/notch/panel.js'), 'utf8');
}
fs.writeFileSync(path.join(scratch, 'panel-before.js'), before.replace('TokenMonitorNotchPanel = api', 'TokenMonitorNotchPanelBefore = api'));
app.setPath('userData', path.join(scratch, 'profile'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  app.dock?.hide();
  fs.writeFileSync(path.join(scratch, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
  <link rel="stylesheet" href="file://${root}/src/electron/renderer/styles.css"><link rel="stylesheet" href="file://${dock}/dock.css"><link rel="stylesheet" href="file://${root}/src/electron/renderer/notch/notch.css"><link rel="stylesheet" href="file://${root}/src/electron/renderer/pluginViews.css">
  <style>body{background:#202124;color:#eee;margin:0;padding:20px;font:14px system-ui}h2{font:500 14px system-ui;margin:10px 0}.fixture-panel{position:relative;width:640px;height:245px;background:#141516;border-radius:0 0 24px 24px;overflow:hidden;margin:12px 0}.camera{position:absolute;top:0;left:230px;width:180px;height:32px;background:black;z-index:10;border-radius:0 0 12px 12px}.motion{display:flex;gap:28px;margin-bottom:20px}#settings{width:380px}.notch-panel{--notch-content-scale:1}.label{color:#aaa;font-size:12px}
  /* The before panel keeps its scoped legacy rail: arrows around a scrolled viewport. */
  #old-notch .notch-tab-rail{display:flex;align-items:center;overflow:hidden;position:static}
  #old-notch .notch-tab-viewport{min-width:0;max-width:100%;overflow-x:auto;scrollbar-width:none;overscroll-behavior:contain}
  #old-notch .notch-tab-viewport::-webkit-scrollbar{display:none}
  #old-notch .notch-tab-rail>button{flex:0 0 20px;height:28px;display:grid;place-items:center}
  #old-notch .notch-tab-rail>button[hidden]{display:none}
  #old-notch .notch-tab-rail>button:disabled{opacity:.3;cursor:default}
  #old-notch .notch-tabs-previous .cursor-disclosure-icon{transform:rotate(90deg)}
  #old-notch .notch-tabs-next .cursor-disclosure-icon{transform:rotate(-90deg)}
  #old-notch .notch-tab-rail.is-tight>button{flex-basis:10px}</style></head><body>
  <h2>System Monitor · CPU / RAM · 20 → 80%</h2><div class="motion"><section><div class="label">Before: explicit caption</div><div id="old-ring"></div></section><section><div class="label">After: App Count / Roll</div><div id="new-ring"></div></section></div>
  <h2>Before · 4 built-in + 3 plugin tabs, scroll arrows</h2><div class="fixture-panel is-notch-attached" id="old-notch"><div class="camera"></div></div>
  <h2>After · same 4 built-in + 3 plugin tabs, pages continue right of the camera</h2><div class="fixture-panel is-notch-attached" id="new-notch"><div class="camera"></div></div>
  <div class="label">Production renderer · synthetic readings / 180px camera gap · not native hardware acceptance</div>
  <div id="settings"><div class="notch-page-settings"><div class="notch-page-settings-heading"><span id="notchPagesLabel">Pages</span><span>Click to show or hide</span></div><div id="notchPageChoices" class="notch-page-chips" role="group" aria-labelledby="notchPagesLabel"></div><p class="settings-note">Use the arrows to browse when space is limited.</p></div></div>
  ${scripts.map(s => `<script src="file://${path.resolve(dock, s)}"></script>`).join('')}
  <script src="file://${scratch}/panel-before.js"></script><script src="file://${root}/src/electron/renderer/notch/panel.js"></script><script src="file://${root}/src/electron/renderer/notch/pageSettings.js"></script></body></html>`);
  const win = new BrowserWindow({ show: false, width: 700, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.join(scratch, 'index.html'));
  win.showInactive();
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const run = js => win.webContents.executeJavaScript(js);
  const checks = await run(`(async()=>{
    const checks=[],check=(name,ok,detail)=>checks.push({name,ok:!!ok,detail}),wait=ms=>new Promise(r=>setTimeout(r,ms));
    const trees=${JSON.stringify(trees)};
    const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
    let mode='roll',motion=true;
    const host=TokenMonitorPluginViews.createPluginViewHost({document,window,motionAllowed:()=>motion,motionMode:()=>mode});
    for(const id of ['old-ring','new-ring'])host.mount(document.getElementById(id),id,'home');
    function push(index){const tree=trees[index],old=JSON.parse(JSON.stringify(tree));for(const ring of old.children){delete ring.captionNumber;delete ring.captionFormat;}host.update({surface:'home',views:{'old-ring':{status:'ok',revision:1,tree:old},'new-ring':{status:'ok',revision:1,tree}}});}
    const captions=()=>[...document.querySelectorAll('#new-ring .pv-ring-caption')];
    push(0);await wait(20);push(1);
    check('real-System-Monitor-explicit-bindings-Roll',captions().every(n=>n.getAnimations({subtree:true}).length>0));
    check('before-explicit-captions-jump',document.getElementById('old-ring').getAnimations({subtree:true}).length===0);
    motion=false;host.refreshMotion();check('reduced-motion-settles-rings',captions().every(n=>n.textContent==='80%'&&n.getAnimations({subtree:true}).length===0));
    motion=true;mode='count';host.refreshMotion();push(0);host.refreshMotion();await wait(1100);push(1);await wait(100);
    check('real-System-Monitor-Count',captions().every(n=>parseInt(n.textContent)>20&&parseInt(n.textContent)<80));
    await wait(1100);check('Count-exact-final',captions().every(n=>n.textContent==='80%'));
    for(const ring of trees[0].children)ring.motion='none';for(const ring of trees[1].children)ring.motion='none';push(0);push(1);
    check('author-none-stays-static',captions().every(n=>n.textContent==='80%'&&TokenMonitorTokenNumberAnimation.currentCountValue(n)===undefined));
    const refs=Array.from({length:9},(_,i)=>'demo/page'+i),states=Object.fromEntries(refs.map((ref,i)=>[ref,{title:'Page '+(i+1),icon:'cpu'}]));
    const calls=[];
    const pluginHost=TokenMonitorPluginViews.createPluginViewHost({document,window,onDemand:(_,refs)=>calls.push(['demand',refs])});
    pluginHost.update({surface:'notch',views:Object.fromEntries(refs.map(ref=>[ref,{...states[ref],status:'ok',tree:{type:'text',text:states[ref].title}}]))});
    const formatRate=value=>{const n=Math.max(0,Number(value)||0);if(n>0&&n<.1)return '<0.1';if(n>0&&n<1)return n.toLocaleString('en',{maximumFractionDigits:1});return TokenMonitorCompactTokens.formatCompactTokens(n,'western','en',{style:'tray'});};
    let panelReducedMotion=true;
    const shared={pluginHost,markNode:()=>el('span'),hasMask:()=>false,providerLabel:x=>x,limitProviderColor:()=>'',formatTokens:String,formatCardTokens:String,formatBreakdownTokens:String,usageCostNode:()=>el('span'),formatRate,appearance:()=>({}),prefersReducedMotion:()=>panelReducedMotion,limitAccountTitle:()=>'',overflowText:{stop(){},preserveReading(){},refresh(){}},limitWindowsView:{},ensureRefreshButton:()=>el('button')};
    const options={document,window,el,t:key=>TokenMonitorI18n.translate('en',key),state:{locale:'en'},bridge:{},shared};
    const old=TokenMonitorNotchPanelBefore.createNotchPanel(options),panel=TokenMonitorNotchPanel.createNotchPanel(options);
    document.getElementById('old-notch').append(old.node);document.getElementById('new-notch').append(panel.node);
    const rateCell={id:'stat:liveRate',kind:'stat',metric:'liveRate',rate:28,rateMode:'speed',idle:false};
    const data={cells:[rateCell],panel:{builtinPages:[],pluginPages:refs,pluginCatalog:states}};
    old.render({cells:[rateCell],panel:{pluginPages:refs.slice(0,3),pluginCatalog:states}});old.place({notched:true,gapWidth:180,height:32},1);old.selectPage('plugin:'+refs[0]);
    panel.render(data);panel.place({notched:true,gapWidth:180,height:32},1);
    const tabs=()=>[...panel.node.querySelectorAll('.notch-tab')].filter(n=>!n.hidden);
    const steps=()=>[...panel.node.querySelectorAll('.notch-tab-step')].filter(n=>!n.hidden);
    const slots=()=>[...tabs(),...steps()];
    const leadRail=panel.node.querySelector('.notch-tab-rail.is-leading'),trailRail=panel.node.querySelector('.notch-tab-rail.is-trailing');
    const leadTrack=panel.node.querySelectorAll('.notch-tabs')[0],trailTrack=panel.node.querySelectorAll('.notch-tabs')[1];
    const statusEl=panel.node.querySelector('.notch-status'),back=()=>panel.node.querySelector('.notch-tab-step.is-back'),forward=()=>panel.node.querySelector('.notch-tab-step.is-forward');
    const seen=()=>tabs().map(n=>n.dataset.page).join('|');
    check('all-selected-pages-available',[...panel.node.querySelectorAll('.notch-tab')].filter(n=>n.dataset.page.startsWith('plugin:')).length===9&&panel.view.page==='plugin:'+refs[0]);
    for(const zoom of [.75,1,1.5])for(const width of [480,640,760]){
      const box=document.getElementById('new-notch');box.style.width=width+'px';panel.node.style.setProperty('--notch-zoom',zoom);panel.place({notched:true,gapWidth:180,height:32},zoom);await wait(35);
      panel.selectPage('plugin:'+refs[8]);await wait(10);
      const lead=leadRail.getBoundingClientRect(),trail=trailRail.getBoundingClientRect(),gap=panel.node.querySelector('.notch-band-gap').getBoundingClientRect();
      // Every whole slot stays inside its own rail and every icon inside its tab.
      const inside=slots().every(n=>{const r=n.getBoundingClientRect(),rail=n.closest('.notch-tab-rail').getBoundingClientRect();return r.left>=rail.left-1&&r.right<=rail.right+1;});
      const icons=tabs().every(n=>{const icon=n.firstElementChild;if(!icon)return true;const ir=icon.getBoundingClientRect(),tr=n.getBoundingClientRect();return ir.left>=tr.left-1&&ir.right<=tr.right+1;});
      check('camera-safe-'+width+'-'+zoom,inside&&icons&&lead.right<=gap.left+1&&trail.left>=gap.right-1,{slots:slots().length,lead:lead.right,gap:gap.left,trail:trail.left});
      check('trail-clear-of-status-'+width+'-'+zoom,trailTrack.getBoundingClientRect().right<=statusEl.getBoundingClientRect().left+1,{track:trailTrack.getBoundingClientRect().right,status:statusEl.getBoundingClientRect().left});
    }
    document.getElementById('new-notch').style.width='640px';panel.node.style.setProperty('--notch-zoom',1);panel.place({notched:true,gapWidth:180,height:32},1);
    // Four built-ins plus three plugin pages split across the two lanes.
    data.panel.builtinPages=['home','limits','sessions','breakdown'];data.panel.pluginPages=refs.slice(0,3);panel.render(data);await wait(25);
    check('seven-pages-no-steps',steps().length===0&&tabs().length===7&&trailTrack.querySelectorAll('.notch-tab').length===2,{visible:tabs().length,lead:leadRail.clientWidth,trail:trailRail.clientWidth,status:statusEl.offsetWidth});
    // The same spring handles local movement; crossing the camera fades between
    // the two fixed local indicators without drawing through the camera gap.
    panelReducedMotion=false;panel.render(data);panel.selectPage('home');await wait(500);
    const [leadPill,trailPill]=panel.node.querySelectorAll('.notch-tab-pill');
    const opacity=n=>Number(getComputedStyle(n).opacity),x=n=>new DOMMatrix(getComputedStyle(n).transform).m41;
    panel.selectPage('limits');await wait(40);
    check('same-lane-pill-keeps-existing-spring',leadPill.getAnimations().some(a=>a.transitionProperty==='transform')&&Math.abs(x(leadPill)-36)>1);
    await wait(500);panel.selectPage('plugin:'+refs[2]);await wait(40);
    const entering=opacity(trailPill);
    check('cross-lane-arrival-fades-instead-of-jumping',entering>0&&entering<1,{opacity:entering});
    check('cross-lane-departure-fades',opacity(leadPill)>0&&opacity(leadPill)<1,{opacity:opacity(leadPill)});
    check('cross-lane-arrival-already-at-target-slot',Math.abs(x(trailPill)-36)<.01&&!trailPill.getAnimations().some(a=>a.transitionProperty==='transform'));
    panel.render(data);await wait(25);
    check('live-push-preserves-cross-lane-transition',opacity(trailPill)>entering&&opacity(trailPill)<1,{before:entering,after:opacity(trailPill)});
    await wait(240);check('cross-lane-settles-to-one-highlight',opacity(trailPill)===1&&opacity(leadPill)===0);
    panel.selectPage('sessions');await wait(40);
    check('reverse-cross-lane-also-fades-at-target-slot',opacity(leadPill)>0&&opacity(leadPill)<1&&Math.abs(x(leadPill)-72)<.01);
    panel.selectPage('plugin:'+refs[1]);await wait(30);panel.selectPage('home');await wait(260);
    check('rapid-cross-lane-reversal-keeps-latest-selection',panel.view.page==='home'&&opacity(leadPill)===1&&opacity(trailPill)===0&&tabs().filter(n=>n.tabIndex===0).length===1);
    panelReducedMotion=true;panel.render(data);panel.selectPage('plugin:'+refs[2]);await wait(20);
    check('reduced-motion-cross-lane-switch-is-immediate',opacity(trailPill)===1&&opacity(leadPill)===0&&leadPill.getAnimations().length===0&&trailPill.getAnimations().length===0);
    const focusedTab=tabs().at(-1);focusedTab.focus();panel.render(data);await wait(20);check('tab-focus-survives-live-push',document.activeElement===focusedTab);
    const compactTabs=seen();data.cells[0].rate=88888;panel.render(data);await wait(25);check('first-large-reading-keeps-tab-capacity',seen()===compactTabs,{before:compactTabs,after:seen()});data.cells[0].rate=28;panel.render(data);
    // All nine plugin pages: the trailing lane (or, if too thin, the leading
    // lane) becomes a step pager over the rest of the page order.
    data.panel.pluginPages=refs;panel.render(data);await wait(25);
    const T=Math.max(0,Math.floor((trailRail.clientWidth-2)/36)),expectedPager=T>=2?trailTrack:leadTrack;
    check('pager-when-both-full',steps().length===2&&expectedPager.contains(back())&&expectedPager.contains(forward()),{T,steps:steps().length});
    panel.selectPage('plugin:'+refs[4]);await wait(10);const before=seen();
    forward().click();await wait(10);
    check('pager-steps-without-selecting',panel.view.page==='plugin:'+refs[4]&&seen()!==before,{before,after:seen()});
    for(let i=0;i<20&&!forward().disabled;i++)forward().click();await wait(10);check('paged-away-selection-keeps-keyboard-entry',tabs().some(n=>n.tabIndex===0));
    tabs()[0].dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));await wait(10);
    check('keyboard-reaches-last',panel.view.page==='plugin:'+refs[8]&&document.activeElement===panel.node.querySelector('[data-page="plugin:'+refs[8]+'"]'));
    // The reserved status width keeps the trail capacity stable as digits grow.
    const steady=seen();
    data.cells[0].rate=88888;panel.render(data);await wait(25);
    check('rate-change-keeps-tabs',seen()===steady,{before:steady,after:seen()});
    // Detached capsule: no camera, one lane ahead of the status.
    panel.place({notched:false,gapWidth:0,height:32},1);await wait(30);
    const clear=slots().every(n=>{const r=n.getBoundingClientRect();return n.closest('.notch-tab-rail')===leadRail&&r.right<=statusEl.getBoundingClientRect().left+1;});
    check('detached-lead-only',getComputedStyle(trailRail).display==='none'&&clear,{trail:trailRail.clientWidth,slots:slots().length});
    panel.place({notched:true,gapWidth:180,height:32},1);data.panel.builtinPages=[];panel.render(data);await wait(20);
    pluginHost.refreshDemand();await wait(40);check('only-visible-pages-demand-data',calls.at(-1)[1].includes(refs[8])&&!calls.at(-1)[1].includes(refs[4]));data.panel.pluginPages=refs.slice(0,2);panel.render(data);await wait(40);check('removed-selected-page-releases-demand',panel.view.page==='plugin:'+refs[0]&&!calls.at(-1)[1].includes(refs[8]));
    data.panel.pluginPages=refs;panel.render(data);panel.selectPage('plugin:'+refs[0]);
    let settings={},fail=false;const catalog={plugins:[{id:'demo',name:'Demo',status:'active',views:[{ref:'demo/page0',title:'Canvas',icon:'cpu',surfaces:['notch'],placements:{notch:true}},{ref:'demo/pulse',title:'Pulse',icon:'memory',surfaces:['notch'],placements:{notch:false}}]},{id:'idle',name:'Idle',status:'error',views:[{ref:'idle/main',title:'Idle View',surfaces:['notch'],placements:{notch:false}}]}]};
    const container=document.getElementById('notchPageChoices');let errors=0;
    const render=()=>TokenMonitorNotchPageSettings.render({document,container,settings,catalog,t:key=>TokenMonitorI18n.translate('en',key),save:async patch=>{if(fail)throw Error('disk');settings={...settings,...patch};render();},place:async(ref,value)=>{catalog.plugins.forEach(p=>{const v=p.views.find(v=>v.ref===ref);if(v)v.placements.notch=value;});render();},pluginIcon:name=>TokenMonitorPluginViews.iconNode(document,name,null,14),onError:()=>errors++});
    render();const toggle=async id=>{const chip=container.querySelector('[data-page="'+id+'"]');chip.focus();chip.click();await wait(10);};
    check('settings-chips-render',JSON.stringify([...container.querySelectorAll('.notch-page-chip')].map(chip=>chip.dataset.page))===JSON.stringify(['home','limits','sessions','breakdown','plugin:demo/page0','plugin:demo/pulse'])&&!container.querySelector('[data-page="plugin:idle/main"]'));
    await toggle('home');await toggle('limits');check('unified-settings-persist-successive-choices',JSON.stringify(settings.notchBuiltinPages)==='["sessions","breakdown"]');
    await toggle('plugin:demo/page0');check('plugin-toggle-uses-placement-contract',catalog.plugins[0].views[0].placements.notch===false);
    fail=true;await toggle('sessions');check('failed-save-restores-choice',errors===1&&container.querySelector('[data-page="sessions"]').getAttribute('aria-pressed')==='true');
    check('settings-retains-focus',document.activeElement?.dataset.page==='sessions');
    const rateData=mode=>({cells:[{...rateCell,rate:28,rateMode:mode}],panel:{builtinPages:['home','limits','sessions','breakdown'],pluginPages:refs,pluginCatalog:states}});
    panel.render(rateData('speed'));await wait(20);const rateButton=statusEl.querySelector('.notch-rate');rateButton.focus();panel.render(rateData('burn'));await wait(20);
    check('rate-mode-toggle-retains-focus',document.activeElement===rateButton&&rateButton.isConnected&&statusEl.querySelector('.notch-rate-unit').textContent==='TPM');
    for(const width of [630,700]){
      document.getElementById('new-notch').style.width=width+'px';const testData=rateData('speed');panel.render(testData);panel.place({notched:true,gapWidth:180,height:32},1);panel.selectPage('plugin:'+refs[5]);await wait(35);
      const beforeTabs=seen(),beforeWidth=statusEl.getBoundingClientRect().width;testData.cells[0].rate=99999;panel.render(testData);await wait(35);
      check('formatted-rounding-keeps-capacity-'+width,seen()===beforeTabs&&Math.abs(statusEl.getBoundingClientRect().width-beforeWidth)<1,{before:beforeTabs,after:seen(),beforeWidth,afterWidth:statusEl.getBoundingClientRect().width});
    }
    document.getElementById('new-notch').style.width='640px';panel.render(rateData('speed'));panel.place({notched:true,gapWidth:180,height:32},1);panel.selectPage('plugin:'+refs[4]);await wait(25);while(!forward().disabled)forward().click();await wait(10);
    const keyboardEntry=tabs().find(n=>n.tabIndex===0);keyboardEntry.focus();keyboardEntry.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await wait(10);
    check('fallback-keyboard-follows-focus',panel.view.page==='limits'&&document.activeElement?.dataset.page==='limits',{entry:keyboardEntry.dataset.page,selected:panel.view.page});
    window.fixture={panel,old,host,push,trees,states,refs};return checks;
  })()`);
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(checks, null, 2));
  const rate=`{id:'stat:liveRate',kind:'stat',metric:'liveRate',rate:28,rateMode:'speed',idle:false}`;
  // Band comparison at 640px: the before panel keeps its arrows; the after
  // panel continues pages in the lane right of the camera, one selected there.
  await run(`(async()=>{document.getElementById('settings').hidden=true;document.querySelector('.motion').hidden=true;document.querySelector('h2').hidden=true;fixture.old.render({cells:[${rate}],panel:{pluginPages:fixture.refs.slice(0,3),pluginCatalog:fixture.states}});fixture.old.selectPage('plugin:'+fixture.refs[2]);fixture.panel.render({cells:[${rate}],panel:{builtinPages:['home','limits','sessions','breakdown'],pluginPages:fixture.refs.slice(0,3),pluginCatalog:fixture.states}});fixture.panel.place({notched:true,gapWidth:180,height:32},1);fixture.panel.selectPage('plugin:'+fixture.refs[2]);fixture.trees.forEach(t=>t.children.forEach(n=>delete n.motion));fixture.push(0);})()`);
  await new Promise(resolve=>setTimeout(resolve,1100));
  await run('fixture.push(1)');
  await new Promise(resolve=>setTimeout(resolve,150));
  fs.writeFileSync(path.join(scratch,'comparison.png'),(await win.webContents.capturePage()).toPNG());
  // The trailing-lane pager: nine plugin pages with the last one selected.
  await run(`(async()=>{for(const child of [...document.body.children]) if(child.id!=='new-notch') child.hidden=true;const panel=fixture.panel;panel.render({cells:[${rate}],panel:{builtinPages:['home','limits','sessions','breakdown'],pluginPages:fixture.refs,pluginCatalog:fixture.states}});panel.place({notched:true,gapWidth:180,height:32},1);panel.selectPage('plugin:'+fixture.refs[8]);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
  await new Promise(resolve=>setTimeout(resolve,200));
  fs.writeFileSync(path.join(scratch,'trail-pager.png'),(await win.webContents.capturePage()).toPNG());
  // The detached capsule: no camera, one left lane ahead of the status.
  await run(`(async()=>{const panel=fixture.panel;panel.render({cells:[${rate}],panel:{builtinPages:['home','limits','sessions','breakdown'],pluginPages:fixture.refs.slice(0,3),pluginCatalog:fixture.states}});panel.place({notched:false,gapWidth:0,height:32},1);panel.selectPage('home');document.querySelector('#new-notch .camera').hidden=true;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
  await new Promise(resolve=>setTimeout(resolve,200));
  fs.writeFileSync(path.join(scratch,'detached-band.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#new-notch .camera').hidden=false`);
  await run(`(async()=>{for(const child of [...document.body.children]) if(child.id!=='settings') child.hidden=true;const settings=document.getElementById('settings');settings.hidden=false;settings.classList.add('settings-panel');settings.style.cssText='position:static;display:block;width:380px;max-height:none;overflow:visible';const title=document.createElement('h2');title.textContent='Notch · display pages (production controls / fixture)';document.body.prepend(title);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
  // Chromium capture can otherwise return the prior compositor frame.
  await new Promise(resolve=>setTimeout(resolve,200));
  fs.writeFileSync(path.join(scratch,'page-settings.png'),(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({scratch,passed:checks.filter(c=>c.ok).length,total:checks.length,failures:checks.filter(c=>!c.ok)},null,2));
  win.destroy();app.exit(checks.every(c=>c.ok)?0:1);
}).catch(error=>{console.error(error);app.exit(1);});
