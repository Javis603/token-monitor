'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function fixture({ rich = false, businessAdapters = {} } = {}) {
  const publications = [];
  let webOptions, detachedDemand;
  const released = [], visibilityRefreshes = [];
  const win = { isDestroyed: () => false, isVisible: () => native.visible, isMinimized: () => native.minimized === true };
  const file = path.resolve(__dirname, '../../src/electron/plugins/runtime.js');
  const nativeRequire = createRequire(file), handlers = new Map(), events = new Map(), calls = [], messages = [], demands = new Map();
  const sender = new EventEmitter(); sender.id = 1; sender.mainFrame = {}; sender.isDestroyed = () => false; sender.send = (channel, payload) => messages.push({ channel, payload });
  const native = { visible: true };
  const settings = { notchPluginPages: ['demo/native'], pluginMainPages: ['demo/page'], homeModuleOrder: 'plugin:demo/home', pluginsEnabled: true };
  const manager = { list: () => ({ plugins: [{ id: 'demo', status: 'active', webDocuments: [{target:'settings'}], views: [
    {ref:'demo/home', surfaces:['home']},
    { ref: 'demo/native', surfaces: ['notch'] }, { ref: 'demo/page', surfaces: ['page'] }, { ref: 'demo/tray', surfaces: ['tray'] }, { ref: 'demo/optional', surfaces: ['page'] } ] }] }),
  onViews: () => () => {}, onChanged: () => () => {}, reload() {}, settingsChanged() {}, dispose() {}, hasActive: () => true,
  interact: (...args) => calls.push(args), setSurfaceDemand: (surface, refs) => demands.set(surface, refs), payload: surface => ({ surface, views: Object.fromEntries((demands.get(surface) || []).map(ref => [ref, { ref, status: "ok" }])) }) };
  const mocks = {
    '../../shared/plugins/dataBus': { createDataBus: () => ({ defineSource() {}, defineAlias() {}, dispose() {} }) },
    './businessData': { createBusinessDataService: options => { const api = nativeRequire('./businessData').createBusinessDataService(options); return { ...api, publish: (stats, extras) => { publications.push({stats,extras}); api.publish(stats,extras); } }; } },
    './webUi': { createWebUi: options => { webOptions = options; return { refreshWindowVisibility(win) { visibilityRefreshes.push(win); }, refreshPresentations() { visibilityRefreshes.push('presentations'); }, refreshSurfaces() { visibilityRefreshes.push('surfaces'); }, dispose() {}, releasePresentationHost: sender => released.push(sender.id) }; } },
    './pages': { createPluginPages: options => { detachedDemand = options.onDemand; return ({presentationContext: () => null, refreshVisibility() { visibilityRefreshes.push('pages'); }, refresh() {}, dispose() {}}); } },
    './appSources': { createAppSources: () => ({ publish() {} }) },
    './manager': { createPluginManager: () => manager },
    './managed': { createManagedPlugins: () => ({ recover() {}, describe() {}, dispose() {} }) },
    './catalog': { createPluginCatalog: () => ({ dispose() {} }) },
    '../limits/fetch': { createElectronNetFetch: () => () => {} },
    '../../shared/outboundFetch': { resolveProxyConfig: () => ({}) }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: id => mocks[id] || nativeRequire(id), __dirname: path.dirname(file), process, console, setTimeout, clearTimeout });
  const runtime = module.exports.createPluginRuntime({ electron: { app: {}, BrowserWindow: {fromWebContents: () => win}, ...(rich ? {WebContentsView: function () {}} : {}), ipcMain: {
    handle: (name, fn) => { if (handlers.has(name)) throw Error('duplicate handler'); handlers.set(name, fn); }, on: (name, fn) => events.set(name, fn), removeHandler: name => handlers.delete(name), removeListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); }
  } }, userDataDir: '/unused-plugin-runtime-fixture', getSettings: () => settings, getLocale: () => 'en',
  businessAdapters, isSurfaceSender: event => event.sender === sender, surfaceContext: () => native, isMainSender: event => event.sender === sender, env: { TOKEN_MONITOR_PLUGINS_SAFE_MODE: '1' } });
  runtime.start();
  win.webContents = sender;
  return { setDetachedDemand: refs => detachedDemand(refs), win, visibilityRefreshes, publications, webOptions, released, manager, native, runtime, handlers, events, sender, settings, calls, demands, messages, event: { sender, senderFrame: sender.mainFrame } };
}
test('main page IPC requires its main frame, declared surface, opted-in placement and active demand', () => {
  const f = fixture();
  const send = f.events.get('plugins:demand'), action = f.handlers.get('plugins:interact');
  assert.throws(() => action(f.event, { surface: 'page', ref: 'demo/page' }), /active plugin view/);
  send({ sender: f.sender, senderFrame: {} }, { surface: 'page', refs: ['demo/page'] });
  assert.equal(f.demands.has('page'), false);
  send(f.event, { surface: 'page', refs: ['demo/page', 'demo/tray', 'demo/optional', { toString: 0 }] });
  assert.deepEqual(Array.from(f.demands.get('page')), ['demo/page']);
  action(f.event, { surface: 'page', ref: 'demo/page', input: { type: 'press', action: 'go' }, revision: 7 });
  assert.equal(f.calls.length, 1);
  assert.throws(() => action({ sender: f.sender, senderFrame: {} }, { surface: 'page', ref: 'demo/page' }), /active plugin view/);
  f.settings.pluginMainPages = [];
  assert.throws(() => action(f.event, { surface: 'page', ref: 'demo/page' }), /placement was removed/);
  f.runtime.settingsChanged(); assert.deepEqual(Array.from(f.demands.get('page')), []);
  f.runtime.dispose();
});
test('destroying the main sender releases its demand', () => {
  const f = fixture(); f.events.get('plugins:demand')(f.event, { surface: 'page', refs: ['demo/page'] });
  f.sender.emit('destroyed'); assert.deepEqual(Array.from(f.demands.get('page')), []); f.runtime.dispose();
});

test('faded native surfaces release saved demand without a renderer visibility event and resume once', () => {
  const f = fixture();
  f.events.get('topNotch:pluginDemand')(f.event, { refs: ['demo/native'] });
  assert.deepEqual(Array.from(f.demands.get('notch')), ['demo/native']);
  f.native.visible = false; f.runtime.refreshWebSurfaces();
  assert.deepEqual(Array.from(f.demands.get('notch')), []);
  f.events.get('topNotch:pluginDemand')(f.event, { refs: ['demo/native'] });
  assert.deepEqual(Array.from(f.demands.get('notch')), []);
  f.native.visible = true; f.runtime.refreshWebSurfaces();
  assert.deepEqual(Array.from(f.demands.get('notch')), ['demo/native']);
  f.settings.notchPluginPages = []; f.runtime.settingsChanged();
  assert.deepEqual(Array.from(f.demands.get('notch')), []);
  f.runtime.dispose();
});

test('opening and reopening delivers current authoritative data without the update throttle', () => {
  const f = fixture(), send = f.events.get('plugins:demand');
  for (const surface of ['page', 'tray']) {
    const ref = `demo/${surface}`;
    send(f.event, { surface, refs: [ref] });
    assert.equal(f.messages.at(-1)?.payload.views[ref]?.status, 'ok');
    send(f.event, { surface, refs: [] });
    send(f.event, { surface, refs: [ref] });
    assert.equal(f.messages.at(-1)?.payload.views[ref]?.status, 'ok');
  }
  f.events.get('topNotch:pluginDemand')(f.event, { refs: ['demo/native'] });
  assert.equal(f.messages.at(-1)?.payload.views['demo/native']?.status, 'ok');
  f.native.visible = false;
  f.events.get('topNotch:pluginDemand')(f.event, { refs: ['demo/native'] });
  assert.equal(Object.keys(f.messages.at(-1).payload.views).length, 0);
  f.settings.pluginMainPages = [];
  send(f.event, { surface: 'page', refs: ['demo/page'] });
  assert.equal(Object.keys(f.messages.at(-1).payload.views).length, 0);
  f.runtime.dispose();
});


test('explicit native opening prepares data but collapse releases demand immediately', () => {
  const f = fixture();
  f.native.visible = false; f.native.preparing = true;
  f.events.get('topNotch:pluginDemand')(f.event, { refs: ['demo/native'] });
  assert.deepEqual(Array.from(f.demands.get('notch')), ['demo/native']);
  assert.equal(f.messages.at(-1).payload.views['demo/native'].status, 'ok');
  f.native.preparing = false; f.runtime.refreshWebSurfaces();
  assert.deepEqual(Array.from(f.demands.get('notch')), []);
  f.runtime.dispose();
});

test('Rich presentation authority retains hidden owners but rejects removed placements', () => {
  const f = fixture({ rich: true });
  const context = f.webOptions.presentationContext;
  assert.equal(context(f.event, 'home', 'demo/home').visible, false);
  f.events.get('plugins:demand')(f.event, {surface:'home',refs:['demo/home']});
  assert.equal(context(f.event, 'home', 'demo/home').visible, true);
  f.native.visible = false;
  assert.equal(context(f.event, 'home', 'demo/home').visible, false);
  f.native.visible = true;
  f.events.get('plugins:demand')(f.event, {surface:'home',refs:[]});
  assert.equal(context(f.event, 'home', 'demo/home').visible, false);
  f.settings.hiddenHomeModules = 'plugin:demo/home';
  assert.equal(context(f.event, 'home', 'demo/home'), null);
  assert.equal(context({sender:f.sender,senderFrame:{}}, 'settings', 'demo'), null);
  assert.equal(context(f.event, 'settings', 'demo').visible, true);
  f.sender.emit('destroyed');
  assert.deepEqual(f.released, [1]);
  f.runtime.dispose();
});
test('host settings IPC preserves structured conflicts without exporting file errors', () => {
  const f = fixture();
  f.manager.getAuthorSettings = () => ({revision:2,values:{density:3}});
  assert.equal(f.handlers.get('plugins:getSettings')(f.event,'demo').value.revision, 2);
  f.manager.updateAuthorSettings = () => { const e = new Error('/private/secret/path'); e.code='settings-conflict'; e.fields={density:'invalid'}; throw e; };
  const reply=f.handlers.get('plugins:updateSettings')(f.event,'demo',{});
  assert.equal(reply.ok,false);
  assert.equal(reply.error.code,'settings-conflict');
  assert.equal(reply.error.fields.density,'invalid');
  assert.equal(JSON.stringify(reply).includes('secret'),false);
  assert.throws(()=>f.handlers.get('plugins:getSettings')({sender:f.sender,senderFrame:{}},'demo'),/main window/);
  f.runtime.dispose();
});

test('runtime dispose unregisters owned IPC and fences retained callbacks', () => {
  const f = fixture();
  const saved = f.handlers.get('plugins:updateSettings');
  let writes = 0;
  f.manager.updateAuthorSettings = () => writes++;
  const retainedDemand = f.events.get('plugins:demand');
  f.runtime.dispose();
  assert.equal(f.handlers.size, 0); assert.equal(f.events.size, 0);
  assert.throws(() => saved(f.event, 'demo', {}), /disposed/);
  retainedDemand(f.event, {surface:'page', refs:['demo/page']});
  assert.equal(writes, 0); assert.equal(f.demands.size, 0);
  assert.throws(() => f.runtime.start(), /disposed/);
  f.runtime.dispose();
});

test('canonical-data invalidation republishes current extras and fences source changes without collection', () => {
  let source = 'a', amount = 100, reads = 0;
  const f = fixture({businessAdapters:{sourceId:()=>source, extras:()=>({subscriptions:[{amount}]}),loadHistory:()=>{reads++;}}});
  const stats = {periods:{today:{totalTokens:1}}};
  f.runtime.publishStats(stats);
  amount = 900; f.runtime.refreshBusinessData();
  assert.equal(f.publications.at(-1).stats,stats);
  assert.equal(f.publications.at(-1).extras.subscriptions[0].amount,900);
  source = 'b'; f.runtime.refreshBusinessData();
  assert.equal(f.publications.at(-1).stats,null);
  assert.equal(f.publications.at(-1).extras.sourceId,'b');
  assert.equal(reads,0);
  const count = f.publications.length; f.runtime.dispose(); f.runtime.refreshBusinessData();
  assert.equal(f.publications.length,count);
});


test('business extras revisions follow the published snapshot, including source reset', () => {
  const captured = [];
  let source = 'one';
  const f = fixture({ businessAdapters: { sourceId: () => source, extras: stats => {
    captured.push(stats); return { historyRevision: stats?.historyRevision || 'empty' };
  } } });
  const stats = { historyRevision: 'first' };
  f.runtime.publishStats({}, stats);
  assert.equal(captured.at(-1), stats);
  assert.equal(f.publications.at(-1).extras.historyRevision, 'first');
  f.runtime.refreshBusinessData();
  assert.equal(captured.at(-1), stats);
  source = 'two'; f.runtime.refreshBusinessData();
  assert.equal(captured.at(-1), null);
  assert.equal(f.publications.at(-1).extras.historyRevision, 'empty');
  f.runtime.dispose();
});

test('explicit host actions use runtime refresh for Rich and detached demand', () => {
  const { createWindowVisibilityActions } = require('../../src/electron/plugins/windowVisibility');
  const f = fixture({ rich: true });
  const actions = createWindowVisibilityActions(win => f.runtime.refreshWindowVisibility(win));
  const win = { isDestroyed: () => false, hide() { f.native.visible = false; } };
  actions.hide(win);
  assert.deepEqual(f.visibilityRefreshes, [win, 'pages']);
  f.runtime.dispose(); f.visibilityRefreshes.length = 0;
  actions.hide(win);
  assert.deepEqual(f.visibilityRefreshes, [], 'disposed runtime ignores late host callbacks');
});

for (const surface of ['home', 'page']) test(`${surface}: native hide/minimize caps requests and restores only valid demand`, () => {
  const f = fixture(), ref = `demo/${surface}`, send = () => f.events.get('plugins:demand')(f.event, { surface, refs: [ref] });
  send(); assert.deepEqual(Array.from(f.demands.get(surface)), [ref]);
  // No DOM notification or native event: the explicit completed-state callback is sufficient.
  f.native.visible = false; f.runtime.refreshWindowVisibility(f.win);
  assert.deepEqual(Array.from(f.demands.get(surface)), []);
  send(); assert.deepEqual(Array.from(f.demands.get(surface)), [], 'late IPC cannot restart hidden work');
  assert.throws(() => f.handlers.get('plugins:interact')(f.event, { surface, ref }), /active plugin view/);
  f.native.visible = true; f.runtime.refreshWindowVisibility(f.win);
  assert.deepEqual(Array.from(f.demands.get(surface)), [ref], 'show needs no new renderer request');
  f.native.minimized = true; f.runtime.refreshWindowVisibility(f.win);
  assert.deepEqual(Array.from(f.demands.get(surface)), []);
  send(); assert.deepEqual(Array.from(f.demands.get(surface)), []);
  f.native.minimized = false; f.runtime.refreshWindowVisibility(f.win);
  assert.deepEqual(Array.from(f.demands.get(surface)), [ref]);
  f.native.visible = false; f.runtime.refreshWindowVisibility(f.win);
  if (surface === 'home') f.settings.homeModuleOrder = ''; else f.settings.pluginMainPages = [];
  f.native.visible = true; f.runtime.refreshWindowVisibility(f.win);
  assert.deepEqual(Array.from(f.demands.get(surface)), [], 'show revalidates removed placement');
  f.runtime.dispose();
});

test('hidden startup retains requests; revoked authority cannot be restored on show', () => {
  const f = fixture(); f.native.visible = false;
  f.events.get('plugins:demand')(f.event, { surface: 'home', refs: ['demo/home'] });
  assert.deepEqual(Array.from(f.demands.get('home')), []);
  assert.equal(f.messages.at(-1).channel, 'plugins:views', 'hidden startup can still paint before native reveal');
  f.native.visible = true; f.runtime.refreshWindowVisibility(f.win);
  assert.deepEqual(Array.from(f.demands.get('home')), ['demo/home']);
  f.native.visible = false; f.runtime.refreshWindowVisibility(f.win);
  f.manager.list = () => ({ plugins: [] });
  f.native.visible = true; f.runtime.refreshWindowVisibility(f.win);
  assert.deepEqual(Array.from(f.demands.get('home')), []);
  f.runtime.dispose();
});

test('hidden main owner does not clear detached page, tray or visible Notch demand', () => {
  const f = fixture(), send = f.events.get('plugins:demand');
  send(f.event, {surface:'page',refs:['demo/page']});
  send(f.event, {surface:'tray',refs:['demo/tray']});
  f.events.get('topNotch:pluginDemand')(f.event, {refs:['demo/native']});
  f.setDetachedDemand(['demo/page']);
  f.native.minimized = true; f.runtime.refreshWindowVisibility(f.win);
  assert.deepEqual(Array.from(f.demands.get('page')), ['demo/page']);
  assert.deepEqual(Array.from(f.demands.get('tray')), ['demo/tray']);
  assert.deepEqual(Array.from(f.demands.get('notch')), ['demo/native']);
  assert.throws(() => f.handlers.get('plugins:interact')(f.event, {surface:'page',ref:'demo/page'}), /active plugin view/);
  f.setDetachedDemand([]); assert.deepEqual(Array.from(f.demands.get('page')), []);
  f.native.minimized = false; f.runtime.refreshWindowVisibility(f.win);
  assert.deepEqual(Array.from(f.demands.get('page')), ['demo/page']);
  f.runtime.dispose();
});

test('main visibility pushes and explicit actions reconcile native demand; Home respects hidden state', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../../src/electron/main.js'), 'utf8');
  const callback = main.match(/^function syncPluginWindowVisibility\(win\) \{[^]*?^\}/m)?.[0];
  assert.ok(callback);
  const calls = [], win = {};
  vm.runInNewContext(`${callback};syncPluginWindowVisibility(win)`, {
    pluginRuntime: {refreshWindowVisibility: w => calls.push(['runtime',w])},
    sendMainWindowVisibility: w => calls.push(['renderer',w]), win
  });
  assert.deepEqual(calls, [['runtime',win],['renderer',win]]);
  assert.match(main, /createWindowVisibilityActions\(syncPluginWindowVisibility\)/);
  for (const event of ['show','hide','minimize','restore']) assert.ok(main.includes(`win.on('${event}', () => syncPluginWindowVisibility(win))`));
  const renderer = fs.readFileSync(path.resolve(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const predicate = renderer.match(/isSurfaceActive: (surface => [^\n]+)/)[1];
  for (const hidden of [false,true]) {
    const active = vm.runInNewContext(`(${predicate})`, {isRendererWindowHidden:()=>hidden,isSettingsPanelOpen:()=>false,state:{floatingBubble:{collapsed:false}}});
    assert.equal(active('home'),!hidden); assert.equal(active('page'),!hidden); assert.equal(active('tray'),true);
  }
});
