'use strict';
// Production controller + DOM adapter + Chromium. Synthetic package, isolated
// temporary profile, no App runtime/collector, no remote debugging ports.
const electron = require('electron');
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { createWebUi, registerWebUiScheme } = require('../src/electron/plugins/webUi');
const { createWindowVisibilityActions } = require('../src/electron/plugins/windowVisibility');
const { createDataBus } = require('../src/shared/plugins/dataBus');
const root = path.resolve(__dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-presentation-'));
app.setPath('userData', path.join(scratch, 'profile')); registerWebUiScheme(electron.protocol); app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(30); } throw Error('condition timed out'); }
let service, bus, samples = 0, grant = true, revision = 1;
const hosts = new Map(), released = [], demands = new Map(), checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); }
const children = h => service.presentations().filter(item => item.host === h.win.webContents);
const run = (h, code) => h.win.webContents.executeJavaScript(code);
async function main() {
  const dir = path.join(scratch, 'package'); fs.mkdirSync(dir);
  const documents = ['home', 'page', 'settings'].map(target => ({ id: target, target, entry: 'body.html', slot: 'replace', height: 150, retainMs: 'until-evicted', ...(target === 'settings' ? {} : { view: 'canvas', variant: 'full' }) }));
  const manifest = { id: 'rich-probe', name: 'Probe', version: '1.0.0', tmApi: 1, permissions: ['ui.web', 'sys.cpu'], views: [{ id: 'canvas', title: 'Canvas', surfaces: ['home', 'page'], layout: { type: 'text', text: 'Fallback' } }], webUi: { version: 1, assets: ['body.html', 'body.js'], documents } };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'body.html'), '<!doctype html><html><body style="background:#213b35;color:white;margin:8px"><p>Authored synthetic canvas</p><input id="draft" aria-label="Draft"><script src="body.js"></script></body></html>');
  fs.writeFileSync(path.join(dir, 'body.js'), "window.ticks=0;setInterval(()=>ticks++,20);tm.context().then(c=>{if(c.surface!=='settings')return tm.subscribe(['sys.cpu']);});");
  const assets = Object.fromEntries(manifest.webUi.assets.map(name => [name, fs.readFileSync(path.join(dir, name))]));
  bus = createDataBus(); bus.defineSource('sys.cpu', { minIntervalMs: 1000, sample: () => { samples++; return { percent: 42 }; } });
  const manager = {
    webDocument(ref) { const document = documents.find(doc => ref === `rich-probe/${doc.id}`); if (!grant || !document) throw Error('revoked'); return { pluginId: 'rich-probe', ref, document, dir, assets, revision, locale: 'en', manifest: { visible: { intervalMs: 1000 } } }; },
    setWebVisible(owner, ref) { if (ref) demands.set(owner, ref); else demands.delete(owner); },
    webSource: (_ref, source) => source, webReadAllowed: (_ref, source) => source === 'sys.cpu',
    webStorage: () => null, onAuthorSettings: callback => { manager.settingsChanged = callback; return () => {}; }, onChanged: callback => { manager.changed = callback; return () => {}; }
  };
  service = createWebUi({ electron, manager, bus, isMainSender: () => false,
    presentationContext(event, surface, ref) { const host = hosts.get(event.sender.id); if (!host || host.revoked || host.surface !== surface) return null; return { visible: host.active && host.win.isVisible() && !host.win.isMinimized() && (ref === null || ref === (surface === 'settings' ? 'rich-probe' : 'rich-probe/canvas')) }; },
    documentCapabilities: { call: (item, op) => ({ owner: item.owner, op }), release: owner => released.push(owner) }, file: path.join(scratch, 'selection.json') });
  const preload = path.join(scratch, 'host.cjs');
  fs.writeFileSync(preload, "const {contextBridge,ipcRenderer}=require('electron');const on=(c,f)=>{const l=(_e,v)=>f(v);ipcRenderer.on(c,l);return()=>ipcRenderer.removeListener(c,l)};contextBridge.exposeInMainWorld('bridge',{syncWebPresentation:x=>ipcRenderer.invoke('plugins:presentation:sync',x),onWebPresentationReady:f=>on('plugins:presentation:ready',f),onWebPresentationFailed:f=>on('plugins:presentation:failed',f)});");
  async function host(surface, count = 1) {
    const html = path.join(scratch, `${surface}-${hosts.size}.html`);
    fs.writeFileSync(html, `<!doctype html><html><head><style>body{margin:0;font:14px system-ui;background:#17191c;color:#eee}header{height:45px}#scroll{height:${count > 1 ? 540 : 400}px;overflow:auto}.card{padding:10px;margin:8px;border:1px solid #555}.mount{min-height:150px}.pv-web-mounted>*{visibility:hidden}#overlay{position:fixed;top:70px;left:20px;width:180px;height:70px;background:orange;color:black}footer{height:30px}</style></head><body><header>Host shell · synthetic fixture</header><main id="scroll">${Array.from({ length: count }, (_, i) => `<section class="card"><h2>Plugin ${i + 1}</h2><div class="mount"><p>Lightweight fallback ${i + 1}</p></div></section>`).join('')}<div style="height:300px">Host content</div></main><footer>Host footer</footer><div id="overlay" role="dialog" hidden>Host overlay</div><script src="file://${root}/src/electron/renderer/pluginPresentationWeb.js"></script></body></html>`);
    const win = new BrowserWindow({ width: 620, height: count > 1 ? 800 : 650, show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
    const h = { win, surface, active: true }; hosts.set(win.webContents.id, h);
    await win.loadFile(html); win.showInactive();
    await run(h, `window.adapter=TokenMonitorPluginPresentationWeb.create({document,window,bridge,surface:${JSON.stringify(surface)},stateFor:()=>({status:'ok',revision:1,webDocuments:[{ref:'rich-probe/${surface}',height:150,variant:'full'}]})});document.querySelectorAll('.mount').forEach(container=>adapter.track({container,ref:'${surface === 'settings' ? 'rich-probe' : 'rich-probe/canvas'}'}));`);
    return h;
  }
  const home = await host('home');
  await until(() => children(home)[0]?.view.getVisible());
  const first = children(home)[0], wc = first.view.webContents;
  check('home mounts without native page snapshot permission', first.context.snapshot === undefined && first.context.surface === 'home');
  check('child has separate renderer and no host bridge/Node', wc.getOSProcessId() !== home.win.webContents.getOSProcessId() && await wc.executeJavaScript("typeof require==='undefined'&&typeof bridge==='undefined'&&typeof tm==='object'"));
  await wc.executeJavaScript("draft.value='retained draft'");
  const releasedBeforeRefresh = released.length;
  await run(home, "document.querySelector('footer').classList.toggle('stats-refreshed')");
  await delay(180);
  check('unrelated host refresh preserves visible child without release', children(home)[0] === first && first.view.getVisible() && released.length === releasedBeforeRefresh);

  await run(home, "overlay.hidden=false");
  await until(() => !children(home).length && service.cached().some(item => item === first && !item.resuming));
  check('overlapping host overlay parks native content and releases source and capabilities', bus.effectiveInterval('sys.cpu') === 0 && released.includes(first.owner));
  const before = samples;
  const ticks = (await wc.debugger.sendCommand('Runtime.evaluate', { expression: 'ticks', returnByValue: true })).result.value;
  await delay(1100);
  check('parked author timers and source sampling stop', before === samples && ticks === (await wc.debugger.sendCommand('Runtime.evaluate', { expression: 'ticks', returnByValue: true })).result.value);
  await run(home, 'overlay.hidden=true'); await until(() => children(home)[0]?.view.getVisible());
  check('overlay removal reuses controller cache and author draft', children(home)[0] === first && await wc.executeJavaScript("draft.value==='retained draft'"));
  await run(home, "document.getElementById('scroll').scrollTop=140"); await until(() => !children(home).length);
  check('partially clipped Home card releases native child', !first.view.getVisible());
  await run(home, "document.getElementById('scroll').scrollTop=0"); await until(() => children(home)[0]?.view.getVisible());
  home.win.webContents.setZoomFactor(1.25); await run(home, 'adapter.suspend()'); await until(() => children(home)[0]?.view.getVisible());
  check('child zoom follows host zoom', Math.abs(wc.getZoomFactor() - 1.25) < .01);
  const main = await host('page'), detached = await host('page');
  await until(() => children(main)[0]?.view.getVisible() && children(detached)[0]?.view.getVisible());
  check('main and detached instances have independent identity and WebContents', children(main)[0].owner !== children(detached)[0].owner && children(main)[0].view.webContents !== children(detached)[0].view.webContents);
  // Same explicit host-action adapter as main.js; settle startup sync so a
  // late renderer message cannot accidentally supply the hide notification.
  await delay(500);
  const mainChild = children(main)[0];
  const windowActions = createWindowVisibilityActions(win => service.refreshWindowVisibility(win));
  windowActions.hide(main.win); await until(() => !children(main).length);
  check('hiding one page preserves another owner demand', children(detached)[0].view.getVisible() && demands.has(children(detached)[0].owner) && !demands.has(mainChild.owner));
  const settings = await host('settings'); await until(() => children(settings)[0]?.view.getVisible());
  const editor = children(settings)[0];
  check('management settings editor does not create display worker demand', editor.context.surface === 'settings' && !demands.has(editor.owner));
  check('settings cannot start legacy source demand', await editor.view.webContents.executeJavaScript("tm.subscribe(['sys.cpu']).then(()=>false,()=>true)"));
  await editor.view.webContents.executeJavaScript("window.settingEvents=[];tm.settings.onChange(value=>settingEvents.push(value));true;");
  manager.settingsChanged('rich-probe', { revision: 2, values: { theme: 'green' } });
  await until(() => editor.view.webContents.executeJavaScript('settingEvents.length===1'));
  check('active settings changes use the fixed child event', await editor.view.webContents.executeJavaScript("settingEvents[0].revision===2"));
  const multi = await host('home', 2); await until(() => children(multi).filter(item => item.view.getVisible()).length === 2);
  check('same document in two Home cards retains separate instance identities', new Set(children(multi).map(item => item.owner)).size === 2);
  check('wrong view ownership cannot mount', (await run(detached, "bridge.syncWebPresentation({surface:'page',visible:true,entries:[{instance:'bad',viewRef:'other/canvas',ref:'rich-probe/page',rect:{x:10,y:50,width:200,height:150}}]})")).mounted.length === 0);
  detached.active = false; service.refreshPresentations();
  check('temporary owner invisibility retains the frozen document', service.cached().some(item => item.host === detached.win.webContents));
  detached.revoked = true; service.refreshPresentations();
  check('owner revocation destroys retained detached instances', !service.cached().some(item => item.host === detached.win.webContents));
  grant = false; revision++; manager.changed();
  check('grant revocation destroys all active and retained documents', service.presentations().length === 0 && service.cached().length === 0 && bus.effectiveInterval('sys.cpu') === 0);
  fs.writeFileSync(path.join(scratch, 'host.png'), (await home.win.capturePage()).toPNG());
}
function finish(error) {
  if (error) console.error(error);
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify({ checks, error: error ? String(error) : null, scratch, electron: process.versions.electron, limits: ['Synthetic host geometry and stub manager; parent runtime integration tested separately', 'No physical device, OS compositor, IME or trackpad acceptance'] }, null, 2));
  console.log(JSON.stringify({ passed: checks.filter(c => c.ok).length, total: checks.length, scratch }));
  for (const h of hosts.values()) if (!h.win.isDestroyed()) h.win.destroy(); service?.dispose(); bus?.dispose(); app.exit(error ? 1 : 0);
}
app.whenReady().then(main).then(() => finish()).catch(finish);
