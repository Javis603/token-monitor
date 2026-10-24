'use strict';
// Real built-in package, manager, isolated WebContentsView and fixed bridge.
// Synthetic readings, temporary profile, no primary App or debugging port.
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { createPluginManager } = require('../src/electron/plugins/manager');
const { createWebUi, registerWebUiScheme } = require('../src/electron/plugins/webUi');
const { createResolver } = require('../src/shared/plugins/bindings');
const { createDataBus } = require('../src/shared/plugins/dataBus');
const { packageDirectory, unpackPackage } = require('../src/electron/plugins/package');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-system-rich-'));
app.setPath('userData', path.join(scratch, 'profile')); registerWebUiScheme(electron.protocol);
app.on('window-all-closed', () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 120; i++) { if (await fn()) return; await wait(25); } throw Error('condition timed out'); }
const checks = [];
function check(name, value) { checks.push({ name, ok: Boolean(value) }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); assert.ok(value, name); }
let manager, service, bus;
const hosts = new Map();
let settings = { pluginsEnabled: true, pluginStates: { 'system-monitor': { enabled: true, background: false, grant: { permissions: ['sys.cpu', 'sys.memory', 'notify'], hosts: [] } } } };
const theme = { colors: { text: '#eee', muted: '#a6a8ad', accent: '#8aafff' }, dark: true, font: 'system-ui', reducedMotion: false };
async function sync(host, ref, surface, width, height, reducedMotion = false) {
 return ipcMain._invokeHandlers.get('plugins:surface:sync')({ sender: host.webContents, senderFrame: host.webContents.mainFrame }, { surface, visible: true, entries: [{ ref, rect: { x: 16, y: 16, width, height } }], theme: { ...theme, reducedMotion } });
}
async function main() {
 bus = createDataBus(); bus.defineSource('sys.cpu'); bus.defineSource('sys.memory');
 manager = createPluginManager({ builtinDir: path.join(root, 'src/electron/plugins/builtin'), userDir: scratch + '/none', dataDir: scratch + '/data', bus, getSettings: () => settings, saveStates: value => { settings.pluginStates = value; }, getLocale: () => 'zh-TW' });
 manager.reload();
 check('existing grant requires explicit approval for rich UI', manager.list().plugins.find(p => p.id === 'system-monitor').status === 'needsApproval');
 manager.setEnabled('system-monitor', true);
 const pkg = packageDirectory(path.join(root, 'src/electron/plugins/builtin/system-monitor'));
 unpackPackage(pkg, scratch + '/roundtrip');
 check('built-in HTML CSS JS survive package round trip', packageDirectory(scratch + '/roundtrip').hash === pkg.hash && Object.keys(pkg.assets).length === 5);
 manager.setSurfaceDemand('notch', ['system-monitor/overview']);
 const originalCadence = bus.effectiveInterval('sys.cpu');
 check('declarative source cadence starts at two seconds', originalCadence === 2000);
 manager.setSurfaceDemand('notch', []);
 service = createWebUi({ electron, manager, bus, file: scratch + '/selections.json', isMainSender: () => false, surfaceContext: (event, surface) => { const h = hosts.get(event.sender.id); return h?.surface === surface ? { kind: h.kind, visible: true } : null; }, surfacePlaced: () => true });
 const base = Date.now() - 2000;
 for (let i = 0; i < 60; i++) { const at = base - (59 - i) * 2000; bus.publish('sys.cpu', 25 + Math.sin(i * .55) * 15, at); bus.publish('sys.memory', { percent: 62 + Math.sin(i * .35) * 3, used: 10000000000, total: 16000000000 }, at); }
 for (const metric of ['cpu', 'memory']) {
  await manager.webStorage('system-monitor/notch-chart', 'set', `chart-history-v1-${metric}`, JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ at: base - (59 - i) * 2000, value: metric === 'cpu' ? 25 + Math.sin(i * .55) * 15 : 62 + Math.sin(i * .35) * 3 }))));
 }
 const fallbackFile = scratch + '/fallback.html';
 fs.writeFileSync(fallbackFile, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="file://${root}/src/electron/renderer/pluginViews.css"><style>:root{--overlay-rgb:255,255,255;--text:#eee;--muted:#a6a8ad;--chart-color:#8aafff;--success:#72cda1;--orange:#e8ae64;--red:#ec7777}body{margin:0;background:#181a1d;color:#eee;font:12px system-ui}</style><main></main><script src="file://${root}/src/electron/renderer/pluginViews.js"></script>`);
 const fallback = new BrowserWindow({width:592,height:152,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 hosts.set(fallback.webContents.id, {host:fallback}); await fallback.loadFile(fallbackFile); fallback.showInactive();
 async function paintFallback() {
  const manifest = require('../src/electron/plugins/builtin/system-monitor/manifest.json');
  const tree = createResolver({read:bus.read,history:bus.history,pluginId:manifest.id,locale:'zh-TW'}).resolveNode(manifest.views.find(v=>v.id==='overview').layouts.notch);
  await fallback.webContents.executeJavaScript(`document.querySelector('main').replaceChildren(TokenMonitorPluginViews.renderTree(document,${JSON.stringify(tree)}));`);
 }
 await paintFallback(); await wait(40); fs.writeFileSync(scratch + '/declarative-before.png', (await fallback.webContents.capturePage()).toPNG());
 const views = [];
 for (const [id, surface, kind, width, height] of [['notch-chart', 'notch', 'notch', 592, 152], ['cpu-chart', 'edgeDock', 'bubble', 252, 168], ['memory-chart', 'edgeDock', 'bubble', 252, 168]]) {
  const host = new BrowserWindow({ width: width + 32, height: height + 32, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const hostSend = host.webContents.send.bind(host.webContents); host.webContents.send = (channel, payload) => { if (channel === 'plugins:surface:failed') console.log('SURFACE_FAILURE', payload); return hostSend(channel, payload); };
  hosts.set(host.webContents.id, { host, surface, kind }); await host.loadURL('data:text/html,<body style="background:%23202325"></body>'); host.showInactive();
  await sync(host, `system-monitor/${id}`, surface, width, height);
  const item = service.surfaces().find(item => item.host === host.webContents), wc = item.view.webContents;
  await until(async () => (await sync(host, `system-monitor/${id}`, surface, width, height)).mounted.includes(`system-monitor/${id}`));
  await until(() => wc.executeJavaScript(`document.querySelector('.line')?.getAttribute('d')?.length>10`).catch(() => false));
  views.push({ host, wc, id, surface, width, height });
  check(`${id}: built-in authored document loaded`, wc.getURL().includes(`/ui/${id === 'notch-chart' ? 'overview' : id.split('-')[0]}.html`));
  check(`${id}: theme and locale inherited`, await wc.executeJavaScript(`document.documentElement.lang==='zh-TW'&&getComputedStyle(document.body).fontFamily==='system-ui'&&getComputedStyle(document.body).backgroundColor==='rgba(0, 0, 0, 0)'`));
 }
 const wc = views[0].wc;
 check('Notch includes CPU and memory; side cards each retain one metric', await wc.executeJavaScript(`document.querySelectorAll('.metric').length===2`) && (await Promise.all(views.slice(1).map(v => v.wc.executeJavaScript(`document.querySelectorAll('.metric').length===1`)))).every(Boolean));
 const paths = () => wc.executeJavaScript(`[...document.querySelectorAll('.line')].map(n=>n.getAttribute('d')+'|'+n.getAttribute('transform'))`);
 for (const v of views.slice(1)) fs.writeFileSync(scratch + '/' + v.id + '.png', (await v.wc.capturePage()).toPNG());
 const sampleAt = Date.now();
 const before = await paths(); fs.writeFileSync(scratch + '/before.png', (await wc.capturePage()).toPNG());
 bus.publish('sys.cpu', 84, sampleAt + 0); bus.publish('sys.memory', { percent: 81, used: 13000000000, total: 16000000000 }, sampleAt + 0);
 await paintFallback();
 const fallbackPath = await fallback.webContents.executeJavaScript(`document.querySelector('.pv-sparkline-line').getAttribute('d')`);
 await wait(120); const middle = await paths(); fs.writeFileSync(scratch + '/middle.png', (await wc.capturePage()).toPNG());
 await wait(420); const after = await paths(); fs.writeFileSync(scratch + '/after.png', (await wc.capturePage()).toPNG());
 fs.writeFileSync(scratch + '/declarative-after.png', (await fallback.webContents.capturePage()).toPNG());
 check('declarative baseline graph has no intermediate transition', fallbackPath === await fallback.webContents.executeJavaScript(`document.querySelector('.pv-sparkline-line').getAttribute('d')`));
 check('both curves have intermediate frames rather than one-step replacement', before.every((p, i) => p !== middle[i] && middle[i] !== after[i]));
 check('side-card curves also animate to their latest sample', (await Promise.all(views.slice(1).map(v => v.wc.executeJavaScript(`document.querySelector('.line').getAttribute('d').length>100 && document.querySelector('.value').textContent===${JSON.stringify(v.id === 'cpu-chart' ? '84%' : '81%')}`)))).every(Boolean));
 const stored = await manager.webStorage('system-monitor/notch-chart', 'get', 'chart-history-v1-cpu');
 check('history survives real broker quotas beyond 32 samples', typeof stored === 'string' && JSON.parse(stored).length > 32 && JSON.parse(stored).at(-1).value === 84);
 check('settles on exact latest percentages', await wc.executeJavaScript(`[...document.querySelectorAll('.value')].map(n=>n.textContent).join(',')==='84%,81%'`));
 await wait(350); check('curve keeps moving between two-second samples beyond the old 400ms transition', JSON.stringify(await paths()) !== JSON.stringify(after));
 await wait(2600); const settled = await paths(); await wait(100); check('stalled samples stop at the last measured timestamp', JSON.stringify(await paths()) === JSON.stringify(settled));
 bus.publish('sys.cpu', 84, sampleAt + 0); await wait(60); check('duplicate timestamp does not append history', JSON.stringify(await paths()) === JSON.stringify(settled));
 await sync(views[0].host, 'system-monitor/notch-chart', 'notch', 592, 152, true);
 bus.publish('sys.cpu', 10, sampleAt + 2000); await wait(60); const reduced = await paths(); await wait(180);
 check('reduced motion updates once and stays settled', JSON.stringify(await paths()) === JSON.stringify(reduced) && await wc.executeJavaScript(`document.querySelector('.value').textContent==='10%'`));
 bus.publish('sys.cpu', null, sampleAt + 4000); await wait(80);
 check('missing reading is not fabricated as zero', await wc.executeJavaScript(`document.querySelector('.value').textContent==='—'`));
 bus.publish('sys.cpu', 30, sampleAt + 24000); await wait(60);
 check('sampling gaps break the curve', await wc.executeJavaScript(`(document.querySelector('.line').getAttribute('d').match(/M/g)||[]).length>=2`));
 check('Rich UI preserves the declarative system sampling cadence', bus.effectiveInterval('sys.cpu') === originalCadence && bus.effectiveInterval('sys.memory') === originalCadence);
 for (const v of views) {
  const retainedPath=await v.wc.executeJavaScript(`document.querySelector('.line').getAttribute('d')`);
  v.host.hide(); await until(() => !service.surfaces().some(i=>i.host===v.host.webContents));
  v.host.showInactive();
  await until(async () => (await sync(v.host, `system-monitor/${v.id}`, v.surface, v.width, v.height)).mounted.includes(`system-monitor/${v.id}`));
  check(`${v.id}: quick reopen retains rich document and measured history`, service.surfaces().find(i=>i.host===v.host.webContents).view.webContents===v.wc&&await v.wc.executeJavaScript(`document.querySelector('.line').getAttribute('d')===${JSON.stringify(retainedPath)}`));
  v.host.hide(); await until(() => !service.surfaces().some(i=>i.host===v.host.webContents));
 }
 check('hiding all charts releases every demand', service.surfaces().length === 0 && bus.effectiveInterval('sys.cpu') === 0 && bus.effectiveInterval('sys.memory') === 0);
 manager.setEnabled('system-monitor', false);
 check('disabled built-in cannot mount authored document', (() => { try { manager.webDocument('system-monitor/notch-chart'); return false; } catch { return true; } })());
 await sampleCadence();
 fs.writeFileSync(scratch + '/results.json', JSON.stringify({ checks, scratch }, null, 2)); console.log(JSON.stringify({ pass: checks.length, scratch }));
}
// Real source projections share a single sampler; only reader functions are synthetic.
async function sampleCadence() {
 cleanup(); hosts.clear();
 let cpuCalls = 0, memoryCalls = 0;
 const times = [];
 bus = createDataBus();
 require('../src/electron/plugins/systemDetails').registerSystemSources(bus, {
  platform: 'fixture',
  cpus: () => { cpuCalls++; times.push(Date.now()); return [{times:{idle:cpuCalls*60,user:cpuCalls*40,sys:0,nice:0,irq:0}}]; },
  memory: () => { memoryCalls++; return {percent:50,used:8e9,total:16e9}; }
 });
 manager = createPluginManager({builtinDir:path.join(root,'src/electron/plugins/builtin'),userDir:scratch+'/none',dataDir:scratch+'/sampling',bus,getSettings:()=>settings,saveStates:value=>{settings.pluginStates=value;}});
 manager.reload(); manager.setEnabled('system-monitor',true);
 service = createWebUi({electron,manager,bus,file:scratch+'/sampling-selections.json',isMainSender:()=>false,surfaceContext:(event,surface)=>hosts.get(event.sender.id)?.surface===surface?{kind:'notch',visible:true}:null,surfacePlaced:()=>true});
 manager.setSurfaceDemand('notch',['system-monitor/overview']);
 await wait(2350);
 check('production declarative aliases share two-second sampling',bus.effectiveInterval('sys.snapshot')===2000&&cpuCalls===2&&memoryCalls===2);
 manager.setSurfaceDemand('notch',[]);
 const host = new BrowserWindow({width:624,height:184,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 hosts.set(host.webContents.id,{host,surface:'notch',kind:'notch'}); await host.loadURL('data:text/html,<body></body>');host.showInactive();
 const count = cpuCalls, index = times.length;
 await sync(host,'system-monitor/notch-chart','notch',592,152);
 await until(()=>bus.effectiveInterval('sys.snapshot')>0);await wait(2350);
 check('rich document preserves actual sampling count and interval',bus.effectiveInterval('sys.snapshot')===2000&&cpuCalls-count===2&&memoryCalls===cpuCalls&&times[index+1]-times[index]>=1850);
 host.hide(); await until(()=>service.surfaces().length===0);
 const stopped = cpuCalls;await wait(2100);
 check('hidden production sampler performs no further reads',cpuCalls===stopped&&memoryCalls===stopped&&bus.effectiveInterval('sys.snapshot')===0);
}
function cleanup() { service?.dispose(); manager?.dispose(); bus?.dispose(); for (const { host } of hosts.values()) if (!host.isDestroyed()) host.destroy(); }
app.whenReady().then(main).then(() => { cleanup(); app.exit(0); }).catch(error => { console.error(error); cleanup(); app.exit(1); });
