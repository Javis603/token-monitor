'use strict';
// Real Chromium freeze/thaw and production bridge; disposable fixtures only.
// TM_CACHE_BASELINE points to a saved pre-change controller for matched timing.
const electron = require('electron');
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'src/electron/plugins/webUi.js');
let implementation = require(modulePath);
if (process.env.TM_CACHE_BASELINE) {
  const Module = require('node:module'), m = new Module(modulePath, module);
  m.filename = modulePath; m.paths = module.paths;
  m._compile(fs.readFileSync(process.env.TM_CACHE_BASELINE, 'utf8'), modulePath); implementation = m.exports;
}
const { createWebUi, registerWebUiScheme } = implementation;
const { createPluginManager } = require('../src/electron/plugins/manager');
const { createDataBus } = require('../src/shared/plugins/dataBus');
const { packageDirectory, unpackPackage } = require('../src/electron/plugins/package');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-web-cache-'));
app.setPath('userData', path.join(scratch, 'profile')); registerWebUiScheme(electron.protocol); app.on('window-all-closed', () => {});
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await delay(10); } throw Error('condition timed out after ' + (checks.at(-1)?.name || 'startup')); }
let nextLoadBarrier;
function armLoadBarrier() {
  let release, finish;
  const gate = new Promise(resolve => { release = resolve; });
  const settled = new Promise(resolve => { finish = resolve; });
  return nextLoadBarrier = { gate, release, finish, settled, wc: null, navigated: false };
}
class BarrierView extends electron.WebContentsView {
  constructor(options) {
    super(options);
    const wc = this.webContents, load = wc.loadURL.bind(wc);
    wc.loadURL = async (...args) => {
      const barrier = nextLoadBarrier;
      if (!barrier) return load(...args);
      nextLoadBarrier = null; barrier.wc = wc;
      lifecycle.push({ id: wc.id, event: 'load-barrier-entered', at: Date.now() });
      await barrier.gate;
      try { if (!wc.isDestroyed()) { barrier.navigated = true; return await load(...args); } }
      finally { barrier.finish(); }
    };
  }
}
const checks = [], timings = [], lifecycle = [], hosts = new Map(); let service, manager, bus, settings = { pluginsEnabled: true, pluginStates: {} }, sampleCalls = 0, memoryMode = 'real', placed = true;
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); }
const itemFor = h => service.surfaces().find(i => i.host === h.win.webContents);
async function sync(h, visible = true) {
  h.active = visible;
  return h.win.webContents.executeJavaScript(`bridge.sync(${JSON.stringify({ surface: 'notch', visible, entries: visible ? [{ ref: 'surface-studio/notch', rect: { x: 16, y: 40, width: 360, height: 260 } }] : [], theme: h.theme })})`);
}
async function open(h) {
  let failure = null;
  let pending = Promise.resolve();
  const shown = () => {
    pending = pending.then(() => sync(h)).catch(error => { failure ??= error; });
  };
  h.win.on('show', shown);
  try {
    h.win.showInactive(); h.win.moveTop();
    const start = performance.now(); await sync(h);
    await until(() => {
      if (failure) throw failure;
      const item = itemFor(h);
      return item?.ready && !item.resuming && !item.awaitingResume;
    });
    await pending;
    if (failure) throw failure;
    await sync(h);
    return performance.now() - start;
  } catch (error) {
    console.error('OPEN_FAILED', JSON.stringify({ host: h.win.webContents.id, visible: h.win.isVisible(), active: h.active, lifecycle: lifecycle.slice(-12) }));
    throw error;
  } finally {
    h.win.removeListener('show', shown);
  }
}

async function coldVisibilityRecovery(h) {
  // Replay the observed owner event boundary at a pre-navigation barrier.
  // This proves recovery, not why macOS emitted the spontaneous native hide.
  const beforeListeners = h.win.listenerCount('show');
  const barrier = armLoadBarrier(), opening = open(h);
  opening.catch(() => {});
  try {
    await until(() => barrier.wc);
    const old = itemFor(h), stale = barrier.wc, staleId = stale.id;
    check('cold visibility: initial sync reaches the explicit pre-navigation barrier', old?.view.webContents === stale && !old.loaded && !old.ready);
    h.win.emit('hide');
    check('cold visibility: transient owner hide tears down even while native visible', h.win.isVisible() && old.dead);
    check('cold visibility: hide immediately removes incomplete child and demand', old.dead && !itemFor(h) && service.cached().length === 0 && bus.effectiveInterval('sys.cpu') === 0);
    h.win.emit('show');
    await until(() => stale.isDestroyed());
    barrier.release(); await barrier.settled;
    check('cold visibility: released stale navigation never runs or resurrects', !barrier.navigated && stale.isDestroyed() && itemFor(h)?.view.webContents !== stale);
    const elapsedMs = await opening;
    const fresh = itemFor(h);
    check('cold visibility: opening remounts a fresh ready child within existing deadline', elapsedMs < 5000 && fresh?.view.webContents !== stale && fresh?.ready && fresh.view.getVisible() && stale.isDestroyed());
    check('cold visibility: open removes its owner-show listener', h.win.listenerCount('show') === beforeListeners);
    timings.push({ coldVisibilityRecoveryMs: elapsedMs, staleId, freshId: fresh.view.webContents.id });
  } finally { barrier.release(); }
}
async function hide(h) { await sync(h, false); service.refreshSurfaces(); }
async function readFrozen(c, expression) { return (await c.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true })).result.value; }
async function host() {
  const preload = path.join(scratch, 'host-preload.cjs');
  fs.writeFileSync(preload, "const {ipcRenderer,contextBridge}=require('electron');contextBridge.exposeInMainWorld('bridge',{sync:x=>ipcRenderer.invoke('plugins:surface:sync',x)});ipcRenderer.on('plugins:surface:failed',(_e,value)=>console.log('SURFACE_FAILED '+JSON.stringify(value)));");
  const win = new BrowserWindow({ width: 400, height: 330, show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
  for (const event of ['show', 'hide', 'resize', 'minimize', 'closed']) win.on(event, () => { lifecycle.push({id: win.isDestroyed() ? null : win.webContents.id, event: 'host-' + event, at: Date.now()}); console.log('HOST ' + event); });
  const h = { win, active: true, theme: { dark: true, colors: { text: '#eeeeee', accent: '#79cbb7' }, reducedMotion: false } }; hosts.set(win.webContents.id, h);
  await win.loadURL('data:text/html,<body style="background:%2317191c;color:%23eee;font:13px system-ui"><p>Production isolated surface · synthetic data</p>');
  return h;
}
async function main() {
  app.on('web-contents-created', (_event, wc) => {
    const id = wc.id, close = wc.close.bind(wc);
    // Observe the production teardown call site without changing its behavior.
    wc.close = (...args) => {
      lifecycle.push({ id, event: 'close-request', stack: new Error().stack, at: Date.now() });
      return close(...args);
    };
    wc.on('console-message', (_e, details, legacyMessage) => {
      const message = typeof details === 'object' ? details.message : legacyMessage;
      lifecycle.push({ id, event: 'console', message, at: Date.now() });
      if (message?.startsWith('SURFACE_FAILED')) console.log('RENDERER ' + id + ' ' + message);
    });
    wc.on('did-fail-load', (_e, code, description) => lifecycle.push({ id, event: 'did-fail-load', code, description, at: Date.now() }));
    for (const event of ['did-finish-load', 'destroyed', 'render-process-gone']) wc.on(event, () => lifecycle.push({ id, event, at: Date.now() }));
  });
  const dir = path.join(scratch, 'plugins'); fs.mkdirSync(dir);
  unpackPackage(packageDirectory(path.join(root, 'docs/plugins/examples/surface-studio')), path.join(dir, 'surface-studio'));
  bus = createDataBus(); bus.defineSource('sys.cpu', { minIntervalMs: 1000, sample: () => { sampleCalls++; return { percent: 37 }; } });
  manager = createPluginManager({ builtinDir: path.join(scratch, 'none'), userDir: dir, dataDir: path.join(scratch, 'data'), bus, getSettings: () => settings, saveStates: states => { settings = { ...settings, pluginStates: states }; } }); manager.reload(); manager.setEnabled('surface-studio', true);
  const appFacade = { getAppMetrics: () => app.getAppMetrics().map(m => memoryMode === 'real' ? m : { ...m, memory: { workingSetSize: memoryMode === 'high' ? 300 * 1024 : 1024 } }) };
  service = createWebUi({ electron: { ...electron, app: appFacade, WebContentsView: BarrierView }, manager, bus, isMainSender: () => false, surfacePlaced: () => placed, surfaceContext: e => { const h = hosts.get(e.sender.id); return h ? { kind: 'notch', visible: h.active } : null; }, file: path.join(scratch, 'selected.json') });
  if (process.argv.includes('--cold-visibility-only')) { await coldVisibilityRecovery(await host()); return; }
  const h = await host(); const coldMs = await open(h); const first = itemFor(h).view.webContents;
  await first.executeJavaScript("note.value='Keep my draft';window.ticks=0;window.frames=0;setInterval(()=>ticks++,10);requestAnimationFrame(function f(){frames++;requestAnimationFrame(f)});");
  await delay(100); await hide(h);
  if (process.env.TM_CACHE_BASELINE) {
    const reopenMs = await open(h); const same = first === itemFor(h).view.webContents;
    timings.push({ coldMs, reopenMs, sameDocument: same });
    await delay(150); fs.writeFileSync(path.join(scratch, 'reopened.png'), (await itemFor(h).view.webContents.capturePage()).toPNG());
    if(process.env.TM_CACHE_REQUIRE_REUSE) check('reopen reuses the exact WebContents and unsaved draft',same&&await itemFor(h).view.webContents.executeJavaScript("note.value==='Keep my draft'"));
    check('baseline recreates the child and loses unsaved DOM state', !same && await itemFor(h).view.webContents.executeJavaScript("note.value===''") );
    return;
  }
  await until(() => service.cached().length === 1 && !service.cached()[0].resuming);
  check('hide retains the same isolated document but removes its active mount', !first.isDestroyed() && !itemFor(h) && !service.cached()[0].view.getVisible());
  check('hidden document immediately releases source demand', bus.effectiveInterval('sys.cpu') === 0);
  const samples = sampleCalls, counters = await readFrozen(first, '[ticks,frames]');
  await delay(1200);
  check('Chromium freezes author timers and animation frames', JSON.stringify(await readFrozen(first, '[ticks,frames]')) === JSON.stringify(counters));
  check('hidden retained document performs zero sampling', sampleCalls === samples);
  check('retained document cannot call its bridge while parked', await readFrozen(first, "tm.context().then(()=>window.denied=false,()=>window.denied=true);true"));
  // Promise callbacks are also frozen; inspect the denial after thaw below.
  h.theme = { ...h.theme, reducedMotion: true, colors: { text: '#ffffff', accent: '#ffd080' } };
  const reopenMs = await open(h); timings.push({ coldMs, reopenMs, sameDocument: first === itemFor(h).view.webContents });
  check('reopen reuses the exact WebContents and unsaved draft', first === itemFor(h).view.webContents && await first.executeJavaScript("note.value==='Keep my draft'"));
  check('parked IPC rejection survives resumption', await first.executeJavaScript('denied===true'));
  check('current theme and reduced motion apply before warm reveal', await first.executeJavaScript("document.querySelector('.wave').getAnimations().length===0&&document.documentElement.style.getPropertyValue('--accent')==='#ffd080'"));
  check('resumption restores original sampling cadence', bus.effectiveInterval('sys.cpu') === 2000);
  await until(() => first.executeJavaScript(`ticks>${counters[0]}`), 1500); check('author timers resume after showing', await first.executeJavaScript(`ticks>${counters[0]}`));
  // Timer progress and IPC readiness do not establish a new compositor frame.
  const resumedFrames = await first.executeJavaScript('frames');
  await until(() => first.executeJavaScript(`frames>=${resumedFrames + 2}`), 1500);
  check('resumed child animation callbacks advance before capture', await first.executeJavaScript(`frames>=${resumedFrames + 2}`));
  const resumedImage = await first.capturePage();
  check('resumed child capture is nonempty', !resumedImage.isEmpty());
  fs.writeFileSync(path.join(scratch, 'reopened.png'), resumedImage.toPNG());
  check('resumed child capture contains painted pixels', resumedImage.toBitmap().some((value, index) => index % 4 === 3 && value > 0));
  // Immediate direction reversal queues freeze then thaw, never a frozen visible page.
  await hide(h); await open(h); check('rapid hide/show preserves document and responsiveness', itemFor(h).view.webContents === first && await first.executeJavaScript('1') === 1);
  await hide(h); manager.setEnabled('surface-studio', false);
  check('disable revokes cached capabilities synchronously', service.cached().length === 0);
  await until(() => first.isDestroyed());
  check('disable destroys cached documents', first.isDestroyed() && service.cached().length === 0 && bus.effectiveInterval('sys.cpu') === 0);
  manager.setEnabled('surface-studio', true); await open(h); let c = itemFor(h).view.webContents;
  await hide(h); placed = false; service.refreshSurfaces(); await until(() => c.isDestroyed()); check('placement removal destroys cached content', c.isDestroyed()); placed = true;
  await open(h); c = itemFor(h).view.webContents; await hide(h); settings.pluginsEnabled = false; manager.settingsChanged(); await until(() => c.isDestroyed()); check('master off destroys cached content', c.isDestroyed()); settings.pluginsEnabled = true; manager.settingsChanged();
  await open(h); c = itemFor(h).view.webContents; await hide(h); manager.reload(); await until(() => c.isDestroyed()); check('reload invalidates cached revisions', c.isDestroyed());
  await open(h); c = itemFor(h).view.webContents;
  const send = c.debugger.sendCommand.bind(c.debugger); c.debugger.sendCommand = (...args) => args[0] === 'Page.setWebLifecycleState' ? Promise.reject(Error('unsupported')) : send(...args);
  await hide(h); await until(() => c.isDestroyed()); check('unsupported freeze fails closed to destruction', c.isDestroyed() && bus.effectiveInterval('sys.cpu') === 0);
  await open(h); c = itemFor(h).view.webContents; const send2 = c.debugger.sendCommand.bind(c.debugger);
  c.debugger.sendCommand = (...args) => args[0] === 'Page.setWebLifecycleState' ? new Promise(() => {}) : send2(...args);
  await hide(h); await until(() => c.isDestroyed(), 1500); check('unresponsive freeze is bounded and destroys child', c.isDestroyed());
  await open(h); c = itemFor(h).view.webContents; await hide(h); await until(() => service.cached().length && !service.cached()[0].resuming); c.debugger.detach(); await until(() => c.isDestroyed()); check('lost lifecycle control destroys frozen child', c.isDestroyed());
  await open(h); c = itemFor(h).view.webContents; memoryMode = 'high'; await hide(h); await until(() => c.isDestroyed()); check('resident-memory budget evicts retained page', c.isDestroyed());
  // The installed declaration reaches the real controller (not a test-only timer override).
  memoryMode = 'real';
  const manifestFile = path.join(dir, 'surface-studio', 'manifest.json');
  const declaration = JSON.parse(fs.readFileSync(manifestFile));
  const setRetention = ms => {
    for (const doc of declaration.webUi.documents) doc.retainMs = ms;
    fs.writeFileSync(manifestFile, JSON.stringify(declaration)); manager.reload();
  };
  setRetention(0); await open(h); c = itemFor(h).view.webContents; await hide(h);
  check('author zero retention destroys immediately', c.isDestroyed() && service.cached().length === 0);
  setRetention(1200); await open(h); c = itemFor(h).view.webContents; await hide(h);
  await until(() => service.cached().length === 1 && !service.cached()[0].resuming);
  check('author retention keeps a ready frozen document', !c.isDestroyed());
  await until(() => c.isDestroyed(), 2500);
  check('author retention expires at its own deadline with no demand', bus.effectiveInterval('sys.cpu') === 0);
  setRetention(120000); await open(h); c = itemFor(h).view.webContents; await hide(h);
  check('longer author preference reaches controller', service.cached()[0]?.document.retainMs === 120000);
  manager.setEnabled('surface-studio', false); await until(() => c.isDestroyed());
  check('disable overrides longer retention', service.cached().length === 0);
  manager.setEnabled('surface-studio', true);
  setRetention(2147483648); await open(h); c = itemFor(h).view.webContents; await hide(h);
  await delay(100);
  check('long finite retention does not overflow into immediate expiry', !c.isDestroyed() && service.cached()[0]?.expiry?._idleTimeout > 2147480000);
  setRetention('until-evicted'); await open(h); c = itemFor(h).view.webContents; await hide(h);
  await until(() => service.cached().length === 1 && !service.cached()[0].resuming);
  check('until-evicted installs no idle expiry and releases sampling', service.cached()[0].expiry === undefined && bus.effectiveInterval('sys.cpu') === 0);
  const frozenTicks = await readFrozen(c, 'Date.now()'); await delay(100);
  check('until-evicted remains a live frozen document', !c.isDestroyed() && typeof frozenTicks === 'number');
  memoryMode = 'high'; service.refreshSurfaces();
  await until(() => c.isDestroyed(), 6500);
  check('memory pressure still evicts indefinite retention', service.cached().length === 0);
  memoryMode = 'real'; setRetention('until-evicted'); await open(h); c = itemFor(h).view.webContents; await hide(h);
  manager.setEnabled('surface-studio', false); await until(() => c.isDestroyed());
  check('disable still revokes indefinite retention', service.cached().length === 0);
  manager.setEnabled('surface-studio', true); setRetention(30000);
  memoryMode = 'low'; const kept = [];
  for (let n = 0; n < 4; n++) { const next = await host(); await open(next); kept.push(itemFor(next).view.webContents); await hide(next); await delay(40); }
  check('global retained count is bounded to three with oldest eviction', kept[0].isDestroyed() && service.cached().length === 3 && kept.slice(1).every(w => !w.isDestroyed()));
  // TTL is measured from hiding, not extended by refresh or background events.
  const beforeExpiry = Date.now(); while (service.cached().length && Date.now() - beforeExpiry < 31000) { service.refreshSurfaces(); await delay(200); }
  await until(() => kept.every(w => w.isDestroyed()));
  check('idle expiry destroys all retained pages without sampling', service.cached().length === 0 && kept.every(w => w.isDestroyed()) && bus.effectiveInterval('sys.cpu') === 0);
  memoryMode = 'real'; await coldVisibilityRecovery(h); await hide(h);
  await open(h); c = itemFor(h).view.webContents; await hide(h); h.win.destroy(); await until(() => c.isDestroyed()); check('closing owner destroys its cached document', c.isDestroyed());
  const endHost = await host(); await open(endHost); c = itemFor(endHost).view.webContents; await hide(endHost);
  fs.rmSync(path.join(dir, 'surface-studio'), { recursive: true, force: true }); manager.reload(); await until(() => c.isDestroyed()); check('uninstall revokes cached origins and subscriptions', c.isDestroyed() && service.cached().length === 0 && bus.effectiveInterval('sys.cpu') === 0);
}
function finish(error) {
  if (error) console.error(error);
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify({ checks, timings, lifecycle, active: service?.surfaces().map(i=>({ref:i.ref,ready:i.ready,resuming:i.resuming,awaitingResume:i.awaitingResume,present:i.present,url:i.view.webContents.getURL()})), error: error ? String(error) : null, scratch, platform: process.platform, electron: process.versions.electron, limits: ['Production controller with synthetic data and host geometry; no physical Notch or OS composite acceptance', 'Memory pressure injected only for eviction checks; actual renderer metrics used for reuse checks'] }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, pass: checks.filter(c => c.ok).length, timings, scratch }));
  service?.dispose(); manager?.dispose(); bus?.dispose(); for (const h of hosts.values()) if (!h.win.isDestroyed()) h.win.destroy(); app.exit(error ? 1 : 0);
}
app.whenReady().then(main).then(() => finish()).catch(finish);
