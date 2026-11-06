'use strict';
// Production shared drag controller, wrapped chips and Notch renderer in a
// disposable Chromium profile. Uses real pointer/keyboard events and disk prefs.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const placements = require('../src/shared/plugins/placements');
const root = path.resolve(__dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-notch-order-'));
app.setPath('userData', path.join(scratch, 'profile'));
app.on('window-all-closed', () => {});
let fail = false, saves = 0;
const file = path.join(scratch, 'settings.json'); fs.writeFileSync(file, '{}');
ipcMain.handle('order:read', () => JSON.parse(fs.readFileSync(file, 'utf8')));
ipcMain.handle('order:save', async (_, patch) => {
  if (fail) throw Error('Fixture write failed');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Object.hasOwn(patch, 'notchPageOrder')) patch.notchPageOrder = placements.normalizeNotchPageOrder(patch.notchPageOrder);
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch })); saves++;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
});
fs.writeFileSync(path.join(scratch, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('orderBridge',{read:()=>ipcRenderer.invoke('order:read'),save:patch=>ipcRenderer.invoke('order:save',patch)});`);
app.whenReady().then(async () => {
  app.dock?.hide();
  const dock = path.join(root, 'src/electron/renderer/edgeDock');
  const scripts = [...fs.readFileSync(path.join(dock, 'index.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(s => s !== 'dock.js');
  fs.writeFileSync(path.join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="file://${root}/src/electron/renderer/styles.css"><link rel="stylesheet" href="file://${dock}/dock.css"><link rel="stylesheet" href="file://${dock}/composer.css"><link rel="stylesheet" href="file://${root}/src/electron/renderer/notch/notch.css"><link rel="stylesheet" href="file://${root}/src/electron/renderer/pluginViews.css"><style>body{margin:0;padding:20px;background:#151618;color:#eee;font:13px system-ui}.settings-panel{position:static;display:block;width:340px;height:220px;overflow:auto;padding:12px;margin:0 0 20px;border:1px solid #42464e;border-radius:12px}#space{height:260px}.notch-page-chips{width:300px}#panel{width:640px;height:225px;background:#08090b;border-radius:0 0 24px 24px;position:relative;overflow:hidden}.camera{position:absolute;top:0;left:230px;width:180px;height:32px;background:#000;border-radius:0 0 12px 12px;z-index:4}h2{font:500 13px system-ui;margin:0 0 10px}.notch-panel{--notch-content-scale:1}</style><h2>Notch 分頁：拖曳排序 · 點擊顯示／隱藏</h2><div id="scroll" class="settings-panel"><div class="edge-dock-composer-heading"><span>顯示分頁</span><span class="edge-dock-composer-heading-actions"><span class="edge-dock-composer-heading-hint">拖曳排序 · 點擊顯示或隱藏</span><button id="reset" class="edge-dock-composer-reset" title="重設排序" aria-label="重設排序">還原預設</button></span></div><div id="choices" class="notch-page-chips"></div><div id="space"></div></div><div id="panel"><div class="camera"></div></div><button id="outside">Outside</button>${scripts.map(s => `<script src="file://${path.resolve(dock, s)}"></script>`).join('')}<script src="file://${root}/src/electron/renderer/verticalDragSort.js"></script><script src="file://${root}/src/electron/renderer/rowDragController.js"></script><script src="file://${root}/src/electron/renderer/notch/pageSettings.js"></script><script src="file://${scratch}/init.js"></script>`);
  fs.writeFileSync(path.join(scratch, 'init.js'), `window.ready=(async()=>{
    const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n};
    const document=window.document,container=document.getElementById('choices'),scroll=document.getElementById('scroll');
    const refs=['demo/system','demo/canvas','demo/pulse'],titles=['系統監控','我的專屬繪圖畫布','Token 脈搏'];
    const states=Object.fromEntries(refs.map((ref,i)=>[ref,{title:titles[i],icon:['cpu','draw','chart'][i]}]));
    const catalog={plugins:[{id:'demo',name:'Demo',status:'active',views:refs.map((ref,i)=>({ref,title:titles[i],icon:'cpu',surfaces:['notch'],placements:{notch:true}}))}]};
    let settings=await orderBridge.read(),drag;
    const host=TokenMonitorPluginViews.createPluginViewHost({document,window});host.update({surface:'notch',views:Object.fromEntries(refs.map(r=>[r,{...states[r],status:'active'}]))});
    const shared={pluginHost:host,markNode:()=>el('span'),hasMask:()=>false,providerLabel:x=>x,limitProviderColor:()=>'',formatTokens:String,formatCardTokens:String,formatBreakdownTokens:String,usageCostNode:()=>el('span'),formatRate:v=>TokenMonitorCompactTokens.formatCompactTokens(v,'western','en',{style:'tray'}),appearance:()=>({}),prefersReducedMotion:()=>true,limitAccountTitle:()=>'',overflowText:{stop(){},preserveReading(){},refresh(){}},limitWindowsView:{},ensureRefreshButton:()=>el('button')};
    const panel=TokenMonitorNotchPanel.createNotchPanel({document,window,el,t:key=>TokenMonitorI18n.translate('zh-TW',key),state:{locale:'zh-TW'},bridge:{},shared});document.getElementById('panel').append(panel.node);
    const chips=()=>[...container.querySelectorAll('button')];
    const render=()=>{
      TokenMonitorNotchPageSettings.render({document,container,resetButton:document.getElementById('reset'),settings,catalog,t:key=>TokenMonitorI18n.translate('zh-TW',key),
        save:async patch=>{settings=await orderBridge.save(patch);render()},
        place:async(ref,value)=>{catalog.plugins[0].views.find(v=>v.ref===ref).placements.notch=value;render()},
        pluginIcon:name=>TokenMonitorPluginViews.iconNode(document,name,null,14),
        createRowDrag:config=>{drag=TokenMonitorRowDragController.createRowDragController({dragSort:TokenMonitorVerticalDragSort,getScrollPanel:()=>scroll,...config});return drag}
      });
      panel.render({cells:[{id:'stat:liveRate',kind:'stat',metric:'liveRate',rate:31,rateMode:'speed',idle:false}],panel:{builtinPages:settings.notchBuiltinPages,pluginPages:refs.filter(r=>catalog.plugins[0].views.find(v=>v.ref===r).placements.notch),pageOrder:settings.notchPageOrder,pluginCatalog:states}});panel.place({notched:true,gapWidth:180,height:32},1);
    };
    render();
    window.orderFixture={render,availability:(status,master=true)=>{catalog.plugins[0].status=status;settings.pluginsEnabled=master;render()},inspect:()=>({ids:chips().map(n=>n.dataset.page),chosen:chips().map(n=>[n.dataset.page,n.getAttribute('aria-pressed')]),order:settings.notchPageOrder,focus:document.activeElement?.dataset.page,busy:container.dataset.saving==='true',dragging:drag.isDragging(),errors:[...container.querySelectorAll('.plugin-action-error')].map(n=>n.textContent),top:[...panel.node.querySelectorAll('.notch-tab')].filter(n=>!n.hidden).map(n=>n.dataset.page),scroll:scroll.scrollTop}),point:id=>{const n=chips().find(n=>n.dataset.page===id);n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}},focus:id=>chips().find(n=>n.dataset.page===id).focus({preventScroll:true})};
  })();`);
  const win = new BrowserWindow({ show: false, width: 700, height: 680, webPreferences: { preload: path.join(scratch, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.join(scratch, 'index.html')); await win.webContents.executeJavaScript('window.ready');
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const wait = ms => new Promise(r => setTimeout(r, ms)), checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const inspect = () => win.webContents.executeJavaScript('orderFixture.inspect()');
  const point = id => win.webContents.executeJavaScript(`orderFixture.point(${JSON.stringify(id)})`);
  const mouse = (type, p) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
  const key = async (key, code, modifiers = 0) => { await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers }); await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); await wait(120); };
  const startDrag = async (from, to) => { const a = await point(from), b = await point(to); await mouse('mouseMoved', a); await mouse('mousePressed', a); await mouse('mouseMoved', { x: a.x + 8, y: a.y + 8 }); await mouse('mouseMoved', b); await wait(40); return b; };
  const original = await inspect();
  const captureFigure = async name => {
    await win.webContents.executeJavaScript('document.getElementById("space").hidden=true;document.getElementById("scroll").style.height="auto"');
    await wait(100);
    fs.writeFileSync(path.join(scratch,name), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('document.getElementById("space").hidden=false;document.getElementById("scroll").style.height="220px"');
  };
  await captureFigure('before.png');
  let end = await startDrag('plugin:demo/canvas', 'home');
  check('wrapped-drag-uses-shared-controller', (await inspect()).dragging);
  await win.webContents.executeJavaScript('orderFixture.render()'); check('live-refresh-keeps-gesture-alive', (await inspect()).dragging);
  await mouse('mouseReleased', end); await wait(160);
  let next = await inspect(); check('plugin-can-move-ahead-of-builtins', next.ids[0] === 'plugin:demo/canvas' && next.order[0] === 'plugin:demo/canvas', next);
  check('drag-does-not-toggle-pages-or-save-twice', next.chosen.every(([id, on]) => original.chosen.find(([key]) => key === id)?.[1] === on));
  check('single-drop-single-persist', saves === 1, { saves });
  check('top-tabs-follow-same-mixed-order', JSON.stringify(next.top) === JSON.stringify(next.ids));
  await captureFigure('after-first-drag.png');
  const beforeCancel = [...next.ids]; end = await startDrag('plugin:demo/pulse', 'home'); await key('Escape', 'Escape'); await mouse('mouseReleased', end); await wait(60);
  next = await inspect(); check('escape-cancels-without-persisting-or-toggling', !next.dragging && saves === 1 && JSON.stringify(next.ids) === JSON.stringify(beforeCancel));
  // A true click after a drag changes visibility without touching saved order.
  const home = await point('home'); await mouse('mouseMoved', home); await mouse('mousePressed', home); await mouse('mouseReleased', home); await wait(100);
  next = await inspect(); check('click-still-hides-page-without-reordering', next.chosen.find(([id]) => id === 'home')[1] === 'false' && JSON.stringify(next.ids) === JSON.stringify(beforeCancel) && !next.top.includes('home'));
  await win.webContents.executeJavaScript('orderFixture.focus("plugin:demo/canvas")'); fail = true; await key('ArrowRight', 'ArrowRight', 1);
  next = await inspect(); check('failed-order-save-restores-authoritative-order-and-focus', next.errors.length === 1 && JSON.stringify(next.ids) === JSON.stringify(beforeCancel) && next.focus === 'plugin:demo/canvas' && !next.busy);
  fail = false; await key('End', 'End', 1); next = await inspect();
  check('keyboard-can-move-plugin-to-end', next.ids.at(-1) === 'plugin:demo/canvas' && next.focus === 'plugin:demo/canvas');
  const persisted = [...next.ids]; const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.webContents.reload(); await loaded; await win.webContents.executeJavaScript('window.ready'); await wait(80); next = await inspect();
  check('order-and-hidden-state-survive-profile-reload', JSON.stringify(next.ids) === JSON.stringify(persisted) && next.chosen.find(([id]) => id === 'home')[1] === 'false', next);
  await win.webContents.executeJavaScript('document.getElementById("scroll").style.zoom="1.25"');
  end = await startDrag('plugin:demo/pulse', 'home'); await mouse('mouseReleased', end); await wait(160); next = await inspect();
  check('wrapped-drag-respects-css-zoom', next.ids[0] === 'plugin:demo/pulse', next);
  check('drop-clears-transform-and-busy-state', !next.busy && !next.dragging && await win.webContents.executeJavaScript('[...document.querySelectorAll(".notch-page-chip")].every(n=>!n.style.getPropertyValue("--drag-x")&&!n.style.getPropertyValue("--drag-shift-x"))'));
  const selectedBeforeReset = next.chosen, orderBeforeReset = next.order;
  fail = true;
  await win.webContents.executeJavaScript('document.getElementById("reset").click()'); await wait(120);
  next = await inspect();
  check('reset-failure-retains-order-and-can-retry', JSON.stringify(next.order) === JSON.stringify(orderBeforeReset) && !next.busy && await win.webContents.executeJavaScript('!document.getElementById("reset").disabled && !document.getElementById("reset").hidden'));
  fail = false;
  await win.webContents.executeJavaScript('document.getElementById("reset").focus();document.getElementById("reset").click()'); await wait(120);
  next = await inspect();
  check('reset-restores-default-order-without-toggling', next.order.length === 0 && next.ids[0] === 'home' && JSON.stringify([...next.chosen].sort()) === JSON.stringify([...selectedBeforeReset].sort()), next);
  check('reset-focus-and-disabled-state', next.focus === 'home' && await win.webContents.executeJavaScript('document.getElementById("reset").disabled && document.getElementById("reset").hidden'));
  const beforeDisable = await inspect();
  await win.webContents.executeJavaScript('orderFixture.availability("disabled")');
  next = await inspect();
  check('disabled-plugin-pages-disappear-from-settings', next.ids.length === 4 && next.ids.every(id=>!id.startsWith('plugin:')), next);
  await captureFigure('disabled-plugins.png');
  await win.webContents.executeJavaScript('orderFixture.availability("active", false)');
  check('master-off-hides-all-plugin-page-choices', (await inspect()).ids.length === 4);
  await win.webContents.executeJavaScript('orderFixture.availability("active")');
  next = await inspect();
  check('reenable-restores-order-and-visibility-without-saving', JSON.stringify(next.ids) === JSON.stringify(beforeDisable.ids) && JSON.stringify(next.chosen) === JSON.stringify(beforeDisable.chosen), next);
  await captureFigure('after-reset.png');
  fs.writeFileSync(path.join(scratch, 'after.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify({ scratch, passed: checks.filter(c => c.ok).length, total: checks.length, failures: checks.filter(c => !c.ok) }, null, 2));
  assert.ok(checks.every(c => c.ok), 'Notch order UI regression failed'); win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
