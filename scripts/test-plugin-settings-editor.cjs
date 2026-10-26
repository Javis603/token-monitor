'use strict';
// Real management renderer + production Rich controller, synthetic plugin only.
// No primary app/profile, collectors, network, or debugging ports.
const electron = require('electron');
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { createWebUi, registerWebUiScheme } = require('../src/electron/plugins/webUi');
const { packageDirectory } = require('../src/electron/plugins/package');
const { createDataBus } = require('../src/shared/plugins/dataBus');
const { normalizeSettings } = require('../src/shared/plugins/settings');
const root = path.resolve(__dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-settings-editor-'));
app.setPath('userData', path.join(scratch, 'profile')); registerWebUiScheme(electron.protocol);
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 8000; while (Date.now() < end) { if (await fn()) return; await delay(40); } throw Error('Settings editor condition timed out'); }
const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); }
async function main() {
  app.dock?.hide();
  const dir = path.join(scratch, 'package'); fs.mkdirSync(dir);
  const doc = { id: 'editor', target: 'settings', slot: 'replace', entry: 'editor.html', height: 280, retainMs: 'until-evicted' };
  const rawSchema = { version: 1, fields: [{ id: 'title', label: 'Canvas title', type: 'string', default: 'Weekly sketch', maxLength: 100 }] };
  const schema = normalizeSettings(rawSchema);
  fs.writeFileSync(path.join(dir, 'editor.html'), '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:20px;background:#202126;color:#eee;font:14px system-ui}label{display:block;margin:24px 0 8px}input{padding:10px;background:#15161a;color:inherit;border:1px solid #777;border-radius:6px;width:80%}p{color:#bbb;font-size:12px}</style></head><body><strong>Sketch Pad editor</strong><p>Synthetic authored editor · isolated renderer</p><label for="draft">Canvas title</label><input id="draft" value="Weekly sketch"><script src="editor.js"></script></body></html>');
  fs.writeFileSync(path.join(dir, 'editor.js'), 'tm.context().then(value=>{document.body.dataset.surface=value.surface})');
  const manifest = { id: 'demo', name: 'Sketch Pad', version: '1.0.0', tmApi: 1, permissions: ['ui.web'], settings: rawSchema, views: [], webUi: { version: 1, assets: ['editor.html', 'editor.js'], documents: [doc] }, visible: { intervalMs: 1000 } };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const assets = Object.freeze(packageDirectory(dir).assets);
  let permitted = true;
  const bus = createDataBus();
  const manager = { webDocument(ref) { if (!permitted || ref !== 'demo/editor') throw Error('revoked'); return { pluginId: 'demo', document: doc, dir, assets, revision: 1, locale: 'en', manifest }; }, setWebVisible(_owner, ref) { if (ref) throw Error('Settings must never demand a display source'); }, onChanged: () => () => {} };
  let win;
  const service = createWebUi({ electron, manager, bus, isMainSender: () => false, presentationContext(event, surface, ref) { return event.sender === win?.webContents && surface === 'settings' && (ref === null || ref === 'demo') && (ref === null || permitted) ? { visible: true } : null; }, file: path.join(scratch, 'selection.json') });
  const preload = path.join(scratch, 'preload.cjs');
  fs.writeFileSync(preload, "const {contextBridge,ipcRenderer}=require('electron');const on=(c,f)=>{const l=(_e,v)=>f(v);ipcRenderer.on(c,l);return()=>ipcRenderer.removeListener(c,l)};contextBridge.exposeInMainWorld('bridge',{syncWebPresentation:x=>ipcRenderer.invoke('plugins:presentation:sync',x),onWebPresentationReady:f=>on('plugins:presentation:ready',f),onWebPresentationFailed:f=>on('plugins:presentation:failed',f)});");
  const html = path.join(scratch, 'fixture.html');
  fs.writeFileSync(html, `<!doctype html><html lang="en"><head><link rel="stylesheet" href="file://${root}/src/electron/renderer/styles.css"><style>body{overflow:auto;padding:16px}#settings{max-width:640px;margin:auto}.settings-panel{display:block!important}h1{font-size:14px}</style></head><body><h1>Synthetic settings editor fixture</h1><div id="settings" class="settings-panel"></div><script src="file://${root}/src/electron/renderer/selectControl.js"></script><script src="file://${root}/src/electron/renderer/i18n.js"></script><script src="file://${root}/src/electron/renderer/pluginPresentationWeb.js"></script><script src="file://${root}/src/electron/renderer/pluginSettings.js"></script></body></html>`);
  win = new BrowserWindow({ width: 420, height: 900, show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(html); win.showInactive();
  const run = code => win.webContents.executeJavaScript(code);
  await run(`window.TokenMonitorPluginViews={renderTree:()=>document.createElement('span')};
    window.fixture={enabled:true,plugins:[{id:'demo',settingsIdentity:'install-1',webRevision:1,name:'Sketch Pad',author:'Fixture author',version:'1.0.0',source:'user',status:'active',enabled:true,settings:true,views:[],permissions:['ui.web'],hosts:[],webDocuments:[${JSON.stringify({ ...doc, ref: 'demo/editor' })}]}]};
    window.panel=TokenMonitorPluginSettings.createPluginSettingsPanel({document,container:document.getElementById('settings'),t:key=>TokenMonitorI18n.translate('en',key),api:{...bridge,syncWebPresentation:async input=>{window.fixtureSync=input;try{return await bridge.syncWebPresentation(input)}catch(error){window.fixtureFailure=error.message;throw error}},onWebPresentationFailed:fn=>bridge.onWebPresentationFailed(value=>{window.fixtureFailure=value;fn(value)}),list:async()=>structuredClone(fixture),getSettings:async()=>({schema:${JSON.stringify(schema)},schemaVersion:1,revision:0,values:{title:'Weekly sketch'},errors:{},readOnly:false}),updateSettings:async()=>{throw Error('unused')}}});
    panel.refresh().then(()=>document.querySelector('.plugin-manage').click());`);
  await until(() => run("!!document.querySelector('[data-control-key=author-editor]')"));
  const capture = async name => {
    await delay(200);
    const boundedCapture = wc => Promise.race([wc.capturePage(), delay(8000).then(()=>{throw Error('Capture timeout: '+name)})]);
    fs.writeFileSync(path.join(scratch, name + '.png'), (await boundedCapture(win.webContents)).toPNG());
    const child = service.presentations()[0];
    if (child?.view.getVisible()) fs.writeFileSync(path.join(scratch, name + '-child.png'), (await boundedCapture(child.view.webContents)).toPNG());
  };
  await capture('narrow-before');
  await run("document.querySelector('[data-control-key=author-editor]').click()");
  try { await until(() => service.presentations()[0]?.view.getVisible()); }
  catch (error) { console.error(await run("JSON.stringify({rect:document.querySelector('.plugin-author-editor')?.getBoundingClientRect(),failure:window.fixtureFailure,sync:window.fixtureSync})")); throw error; }
  const child = service.presentations()[0];
  check('actual-management-entry-mounts-independent-settings-child-without-placement', child.target === 'settings' && await child.view.webContents.executeJavaScript("document.body.dataset.surface==='settings'"));
  check('separate-renderer-sandbox', child.view.webContents.getOSProcessId() !== win.webContents.getOSProcessId() && await child.view.webContents.executeJavaScript("typeof require==='undefined'&&typeof bridge==='undefined'"));
  await capture('narrow-after');
  await child.view.webContents.executeJavaScript("draft.value='Rich unsaved draft'");
  await run('panel.refresh()');
  await until(() => service.presentations()[0]?.view.getVisible());
  check('ordinary-refresh-keeps-native-instance-and-rich-draft', service.presentations()[0] === child && await child.view.webContents.executeJavaScript("draft.value==='Rich unsaved draft'"));
  check('native-child-hides-host-fallback', await run("getComputedStyle(document.querySelector('.plugin-author-form')).visibility==='hidden'"));
  await run("document.querySelector('[data-control-key=author-editor]').click()");
  await until(() => !service.presentations().length);
  check('close-restores-host-form', await run("getComputedStyle(document.querySelector('.plugin-author-form')).visibility==='visible'&&!document.querySelector('[data-control-key=author-title]').disabled"));
  win.setSize(800, 900); await capture('wide-before');
  await run("document.querySelector('[data-control-key=author-editor]').click()");
  await until(() => service.presentations()[0]?.view.getVisible()); await capture('wide-after');
  await run("document.querySelector('[data-control-key=author-editor]').click()");
  await until(() => !service.presentations().length);
  permitted = false;
  await run("fixture.enabled=false;fixture.plugins[0].enabled=false;fixture.plugins[0].status='disabled';panel.refresh()");
  check('disabled-remains-editable-with-no-editor', await run("!document.querySelector('[data-control-key=author-editor]')&&!document.querySelector('[data-control-key=author-title]').disabled"));
  check('no-horizontal-overflow', await run('document.documentElement.scrollWidth<=innerWidth'));
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(checks, null, 2));
  console.log('Evidence:', scratch);
  await run('panel.dispose()'); service.dispose(); bus.dispose(); win.destroy(); app.quit();
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
