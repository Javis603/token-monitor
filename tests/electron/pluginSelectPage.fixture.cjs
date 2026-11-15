'use strict';

// Exercise the actual detached page entry, with only its IPC bridge replaced.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-plugin-select-page-'));
app.setPath('userData', path.join(output, 'profile'));
const preload = path.join(output, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('tokenMonitorPluginPage',{
  metadata:async()=>({appearance:{},locale:'en',name:'Plugin select fixture',description:'',status:'active',themeColors:{},ref:'',views:[]}),
  onMeta:fn=>ipcRenderer.on('fixture:meta',(_,meta)=>fn(meta)),onViews:()=>{}
});
contextBridge.exposeInMainWorld('tokenMonitorTrustedPlugins',{});`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({width:500,height:600,webPreferences:{sandbox:true,preload}});
  const errors = [];
  win.webContents.on('console-message', event => { if(event.level==='error') errors.push(event.message); });
  await win.loadFile(path.resolve(__dirname,'../../src/electron/renderer/plugins/page.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const settle = () => run('new Promise(resolve=>setTimeout(resolve,80))');
  const click = async selector => {
    const point = await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector).replace(/</g,'\\u003c')}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await settle();
  };
  const key = async keyCode => {
    win.webContents.sendInputEvent({type:'keyDown',keyCode});
    win.webContents.sendInputEvent({type:'keyUp',keyCode});await settle();
  };
  await settle();
  assert.equal(await run('typeof TokenMonitorAppSelects'),'object','detached entry loads shared select modules');
  await run(`(()=>{
    const region=document.createElement('div');region.className='plugin-content';
    region.innerHTML='<label>Display<select id="detachedSelect"><option value="compact">Compact</option><option value="detailed" data-tm-select-description="Plugin-local detail text">Detailed</option></select></label><select id="authorNative" data-tm-native-select><option>Native author control</option></select><select id="detachedLong"></select>';
    for(let i=0;i<15;i++) region.querySelector('#detachedLong').add(new Option('Model '+i,String(i)));
    window.changes=0;region.querySelector('#detachedSelect').addEventListener('change',()=>changes++);
    document.getElementById('pageContent').append(region,region.querySelector('#authorNative'));
  })()`);
  await settle();
  assert.deepEqual(await run('({custom:document.getElementById("detachedSelect").hidden,native:document.getElementById("authorNative").hidden})'),{custom:true,native:false});
  await click('#detachedSelect + button');
  assert.equal(await run('document.querySelector(".select-control-popup:popover-open .select-control-description:not([hidden])").textContent'),'Plugin-local detail text');
  fs.writeFileSync(path.join(output,'detached-picker.png'),(await win.webContents.capturePage()).toPNG());
  await key('Down');await key('Return');
  assert.deepEqual(await run('({value:document.getElementById("detachedSelect").value,changes})'),{value:'detailed',changes:1});
  win.webContents.send('fixture:meta',{appearance:{},locale:'zh-TW',name:'Plugin select fixture',description:'',status:'active',themeColors:{},ref:'',views:[]});
  await settle();
  await click('#detachedLong + button');
  assert.equal(await run('document.activeElement.placeholder===TokenMonitorI18n.translate("zh-TW","trayComposer.search")'),true);
  await win.webContents.insertText('Model 14');await settle();await key('Return');
  assert.equal(await run('document.getElementById("detachedLong").value'),'14');
  await run('window.dispatchEvent(new Event("unload"))');
  assert.deepEqual(await run('({hidden:document.getElementById("detachedSelect").hidden,generated:document.querySelectorAll(".select-control-trigger,.select-control-popup").length})'),{hidden:false,generated:0});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'pass',output}));
  win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
