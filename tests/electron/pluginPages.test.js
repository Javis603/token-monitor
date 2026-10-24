'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createPluginManager } = require('../../src/electron/plugins/manager');
const { createDataBus } = require('../../src/shared/plugins/dataBus');
const { createWebUi } = require('../../src/electron/plugins/webUi');
const { createPluginPages } = require('../../src/electron/plugins/pages');
const { createWindowVisibilityActions } = require('../../src/electron/plugins/windowVisibility');
function fixture(options = {}) {
  const handlers = new Map(), windows = [], demands = [], messages = [];
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.visible = false; this.minimized = false; this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: windows.length, mainFrame: {}, getZoomFactor: () => 1, isDestroyed: () => this.isDestroyed(), setWindowOpenHandler() {}, send: (channel, payload) => messages.push({ channel, payload }) }); }
    isDestroyed() { return Boolean(this.dead); } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
    show() { this.visible = true; this.emit('show'); } hide() { this.visible = false; if (!this.silentVisibility) this.emit('hide'); }
    minimize() { this.minimized = true; if (!this.silentVisibility) this.emit('minimize'); } restore() { this.minimized = false; this.emit('restore'); }
    getContentSize() { return [880, 640]; }
    contentView = { addChildView() {}, removeChildView() {} };
    static fromWebContents(sender) { return windows.find(win => win.webContents === sender); }
    focus() {} loadFile() { return Promise.resolve(); }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const plugin = { id: 'demo', name: 'Demo', status: 'active', views: [
    { ref: 'demo/first', title: 'First', surfaces: ['page'] }, { ref: 'demo/second', title: 'Second', surfaces: ['page'] }] };
  const manager = options.manager || { payload: surface => ({ surface, views: Object.fromEntries((demands.at(-1)?.[1] || []).map(ref => [ref, { ref, status: 'ok' }])) }), list: () => ({ plugins: [plugin] }), onViews: () => () => {}, onChanged: () => () => {}, setSurfaceDemand: (surface, refs) => demands.push([surface, refs]) };
  const ipcMain = { handle: (id, fn) => handlers.set(id, fn), removeHandler: id => handlers.delete(id) };
  const pages = createPluginPages({ BrowserWindow: Window, ipcMain, manager,
    getSettings: options.getSettings || (() => ({ themeColors: { accent: '#abcdef' }, interfaceFontFamily: 'Georgia', displayFontFamily: 'Arial', reduceMotion: 'on', tokenNumberAnimation: 'count', secret: 'never expose' })), getLocale: () => 'en' });
  return { pages, handlers, windows, demands, messages, manager, Window, ipcMain };
}
test('independent plugin pages follow native visibility and reuse their window', () => {
  const f = fixture(); f.pages.open('demo/first'); const win = f.windows[0]; win.emit('ready-to-show');
  assert.deepEqual(f.demands.at(-1), ['page', ['demo/first']]);
  assert.equal(f.messages.at(-1).payload.views['demo/first'].status, 'ok');
  win.minimize(); assert.deepEqual(f.demands.at(-1), ['page', []]);
  f.pages.open('demo/second'); assert.equal(f.windows.length, 1); assert.deepEqual(f.demands.at(-1), ['page', ['demo/second']]);
  win.hide(); assert.deepEqual(f.demands.at(-1), ['page', []]);
  win.show(); win.destroy(); assert.deepEqual(f.demands.at(-1), ['page', []]); f.pages.dispose();
});
test('page IPC accepts only its native sender and views of the same plugin', () => {
  const f = fixture(); f.pages.open('demo/first'); const event = { sender: f.windows[0].webContents };
  assert.throws(() => f.handlers.get('pluginPage:metadata')({ sender: {} }), /not a plugin page/);
  assert.throws(() => f.handlers.get('pluginPage:select')(event, 'other/first'), /does not belong/);
  const metadata = f.handlers.get('pluginPage:metadata')(event);
  assert.equal(metadata.secret, undefined);
  assert.deepEqual(metadata.appearance, { interfaceFontFamily: 'Georgia', displayFontFamily: 'Arial', textSize: undefined, reduceMotion: 'on', tokenNumberAnimation: 'count' });
  assert.equal(f.handlers.get('pluginPage:select')(event, 'demo/second').ref, 'demo/second'); f.pages.dispose();
});

test('page action IPC rejects other views, foreign frames and hidden windows', () => {
  const f = fixture(); f.pages.open('demo/first'); const win = f.windows[0]; win.emit('ready-to-show');
  const sent = []; f.manager.interact = (...args) => sent.push(args);
  const interact = f.handlers.get('pluginPage:interact');
  interact({ sender: win.webContents }, 'demo/first', { action: 'save', type: 'press' }, 7);
  assert.deepEqual(sent[0], ['page', 'demo/first', { action: 'save', type: 'press' }, 7]);
  assert.throws(() => interact({ sender: win.webContents }, 'demo/second', {}, 7), /visible plugin page/);
  assert.throws(() => interact({ sender: win.webContents, senderFrame: {} }, 'demo/first', {}, 7), /not a plugin page/);
  win.hide(); assert.throws(() => interact({ sender: win.webContents }, 'demo/first', {}, 7), /visible plugin page/); f.pages.dispose();
});


// Real normalized manifests and manager DTOs: placements belong to the runtime's
// main-menu list, and must never be fabricated on manager.list() in this test.
function realFixture(t, { legacy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-detached-pages-'));
  const userDir = path.join(root, 'plugins');
  const manifest = {
    id: 'demo', name: 'Demo', version: '1.0.0', tmApi: 1, permissions: ['ui.web', 'tm.data.sessions', 'tm.data.identities'],
    views: ['first', 'second', 'home'].map(id => ({ id, title: id, surfaces: [id === 'home' ? 'home' : 'page'], layout: { type: 'text', text: 'Fallback' } })),
    webUi: { version: 1, assets: ['body.html'], documents: ['first', 'second'].map(view => ({
      id: `${view}-rich`, view, target: 'page', slot: 'replace', entry: 'body.html', retainMs: 'until-evicted'
    })) }
  };
  if (legacy) {
    manifest.permissions.push('tm.pages');
    manifest.webUi.documents.push({ id: 'model-rich', target: 'model', slot: 'replace', entry: 'body.html', retainMs: 'until-evicted' });
  }
  const dir = path.join(userDir, manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'body.html'), '<!doctype html><p>Rich page</p>');
  let settings = { pluginsEnabled: true, pluginStates: {}, pluginMainPages: [] };
  const bus = createDataBus();
  const manager = createPluginManager({ builtinDir: path.join(root, 'builtin'), userDir, dataDir: path.join(root, 'data'), bus,
    getSettings: () => settings, saveStates: pluginStates => { settings = { ...settings, pluginStates }; } });
  manager.reload(); manager.setEnabled('demo', true);
  const f = fixture({ manager, getSettings: () => settings });
  t.after(() => { f.pages.dispose(); manager.dispose(); bus.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(manager.list().plugins[0].status, 'active');
  assert.equal(manager.list().plugins[0].views[0].placements, undefined);
  return { ...f, bus, root, setMainPages: refs => { settings = { ...settings, pluginMainPages: refs }; } };
}

test('real manager detached authority follows explicit open independently of main-menu placement', t => {
  const f = realFixture(t);
  f.pages.open('demo/first'); const win = f.windows[0]; win.emit('ready-to-show');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const context = ref => f.pages.presentationContext(event, 'page', ref);
  assert.deepEqual(context('demo/first'), { visible: true }, 'explicit open needs no main-menu placement');
  f.setMainPages(['demo/first']); assert.deepEqual(context('demo/first'), { visible: true });
  f.setMainPages([]); assert.deepEqual(context('demo/first'), { visible: true }, 'removing a menu entry does not revoke a detached owner');
  assert.equal(f.pages.presentationContext(event, 'home', null), null);
  assert.equal(f.pages.presentationContext({ sender: {} }, 'page', null), null);
  assert.equal(f.pages.presentationContext({ ...event, senderFrame: {} }, 'page', 'demo/first'), null);
  assert.equal(context('demo/second'), null);
  assert.equal(context('other/first'), null);
  assert.equal(context('demo/home'), null);
  assert.throws(() => f.pages.open('demo/home'), /unavailable/);
  win.hide(); assert.deepEqual(context('demo/first'), { visible: false });
  win.show(); win.minimize(); assert.deepEqual(context('demo/first'), { visible: false });
  win.restore(); assert.deepEqual(context('demo/first'), { visible: true });
  f.handlers.get('pluginPage:select')(event, 'demo/second');
  assert.equal(context('demo/first'), null);
  assert.deepEqual(context('demo/second'), { visible: true });
  f.manager.setEnabled('demo', false); assert.equal(context('demo/second'), null);
  f.manager.setEnabled('demo', true); assert.deepEqual(context('demo/second'), { visible: true });
  win.destroy(); assert.equal(context(null), null); assert.equal(context('demo/second'), null);
});

// Only Electron primitives are faked; admission, package loading, retention and
// revocation use the production pages + manager + Web UI controllers.
function richController(f, documentCapabilities = {}) {
  let nextId = 100;
  class View {
    constructor() {
      const wc = this.webContents = new EventEmitter();
      const debug = wc.debugger = new EventEmitter();
      Object.assign(debug, { isAttached: () => Boolean(debug.attached), attach() { debug.attached = true; },
        detach() { debug.attached = false; debug.emit('detach'); }, sendCommand: async () => {} });
      Object.assign(wc, { id: nextId++, mainFrame: {}, getOSProcessId: () => 1, setWindowOpenHandler() {}, setZoomFactor() {},
        isDestroyed: () => Boolean(wc.dead), isFocused: () => false, getURL: () => wc.url,
        loadURL: async url => { wc.url = url; }, send() {}, close() { wc.dead = true; }, executeJavaScript: async () => 0 });
    }
    setVisible(value) { this.visible = value; } setBounds() {} setBackgroundColor() {}
  }
  const session = new EventEmitter();
  Object.assign(session, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: { onBeforeRequest() {} }, protocol: { handle() {}, unhandle() {} }, clearStorageData: async () => {} });
  return createWebUi({ electron: { BrowserWindow: f.Window, WebContentsView: View, ipcMain: f.ipcMain,
    session: { fromPartition: () => session }, app: { getAppMetrics: () => [{ pid: 1, memory: { workingSetSize: 1 } }] } },
  manager: f.manager, bus: f.bus, documentCapabilities, isMainSender: () => Boolean(f.mainSender),
  presentationContext: f.pages.presentationContext, file: path.join(f.root, 'selections.json') });
}

test('real manager detached Rich mounts, retains while hidden and destroys revoked owners', async t => {
  const f = realFixture(t), webUi = richController(f);
  t.after(() => webUi.dispose());
  f.pages.open('demo/first'); const win = f.windows[0]; win.emit('ready-to-show');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const input = { surface: 'page', visible: true, entries: [{ instance: 'body', viewRef: 'demo/first', ref: 'demo/first-rich', rect: { x: 10, y: 10, width: 400, height: 300 } }] };
  const sync = () => f.handlers.get('plugins:presentation:sync')(event, input);
  const call = (item, op, args) => f.handlers.get('plugins:web:call')({ sender: item.view.webContents, senderFrame: item.view.webContents.mainFrame }, op, args);
  const ready = () => {
    sync();
    assert.equal(webUi.presentations().length, 1, 'the real manager page document must mount');
    const item = webUi.presentations()[0];
    item.view.webContents.emit('did-finish-load'); call(item, 'present');
    assert.deepEqual(sync(), { mounted: ['body'] });
    return item;
  };
  const first = ready();
  win.hide(); await first.lifecycle;
  assert.deepEqual(webUi.presentations(), []);
  assert.deepEqual(webUi.cached(), [first]);
  assert.equal(first.view.visible, false);
  assert.throws(() => call(first, 'context'), /revoked/);
  sync(); assert.deepEqual(webUi.cached(), [first], 'hidden sync preserves eligible retained ownership');
  win.show(); sync(); await first.lifecycle;
  assert.equal(webUi.presentations()[0], first, 'show reuses the retained document');
  call(first, 'resumed', first.epoch); assert.deepEqual(sync(), { mounted: ['body'] });
  f.setMainPages(['demo/first']); webUi.refreshPresentations();
  f.setMainPages([]); webUi.refreshPresentations();
  assert.equal(webUi.presentations()[0], first, 'main-menu removal does not revoke an explicitly opened window');
  win.minimize(); await first.lifecycle;
  f.manager.setEnabled('demo', false);
  assert.deepEqual(webUi.cached(), []); assert.equal(first.dead, true);
  assert.throws(() => call(first, 'context'), /revoked/);
  win.restore(); f.manager.setEnabled('demo', true);
  const second = ready();
  f.handlers.get('pluginPage:select')(event, 'demo/second'); webUi.refreshPresentations();
  assert.equal(second.dead, true, 'selection change revokes the previous view');
  assert.deepEqual(sync(), { mounted: [] }, 'the old view cannot remount');
  f.pages.open('demo/first'); const third = ready();
  win.hide(); await third.lifecycle;
  win.destroy(); assert.equal(third.dead, true); assert.deepEqual(webUi.cached(), []);
});

function pagingRich(t, { count = 2000, settingsGet = () => ({ values: { count: 1 } }), query } = {}) {
  const { createPluginCapabilities } = require('../../src/electron/plugins/capabilities');
  const { createBusinessDataService } = require('../../src/electron/plugins/businessData');
  const f = realFixture(t);
  const business = createBusinessDataService();
  const stats = { periods: { today: { sessions: Object.fromEntries(Array.from({ length: count }, (_, i) => [i, { sessionId: String(i), client: 'codex', totalTokens: i, title: `Row ${i}` }])) } } };
  business.publish(stats);
  let queries = 0;
  const api = createPluginCapabilities({ businessData: { ...business, query(...args) { queries++; return query ? query(...args) : business.query(...args); } } });
  const webUi = richController(f, {
    call(item, op, args) { return api.call(item.owner, op, args, {
      auth: () => ({ ...f.manager.webDataAuth(item.ref), revision: item.revision, active: !item.dead && !item.parked && !item.resuming && !item.awaitingResume }),
      settings: { get: settingsGet }, send() {}
    }); }, release: owner => api.release(owner)
  });
  t.after(() => { webUi.dispose(); api.dispose(); business.dispose(); });
  f.pages.open('demo/first'); const win = f.windows[0]; win.emit('ready-to-show');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const input = { surface: 'page', visible: true, entries: [{ instance: 'body', viewRef: 'demo/first', ref: 'demo/first-rich', rect: { x: 10, y: 10, width: 400, height: 300 } }] };
  f.handlers.get('plugins:presentation:sync')(event, input);
  const item = webUi.presentations()[0]; assert.ok(item);
  const call = (op, args) => f.handlers.get('plugins:web:call')({ sender: item.view.webContents, senderFrame: item.view.webContents.mainFrame }, op, args);
  item.view.webContents.emit('did-finish-load'); call('present');
  return { ...f, webUi, item, win, call, business, stats, queries: () => queries };
}
for (const limit of [1, 100]) test(`Rich production controller traverses 2000 rows at limit ${limit} mixed with settings`, async t => {
  const f = pagingRich(t), start = Date.now(), rows = [];
  let cursor, pages = 0;
  do {
    const reply = await f.call('data.query', { query: { version: 1, resource: 'sessions', sort: { field: 'totalTokens' }, page: { limit, ...(cursor ? { cursor } : {}) } } });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const result = reply.value; assert.equal(result.availability, 'available');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 56 * 1024);
    rows.push(...result.rows); cursor = result.pageInfo.nextCursor; pages++;
    const settings = await f.call('settings.get', {}); assert.equal(settings.ok, true); assert.equal(settings.value.values.count, 1);
  } while (cursor);
  assert.equal(rows.length, 2000); assert.equal(new Set(rows.map(row => row.id)).size, 2000);
  assert.deepEqual(rows.map(row => row.totalTokens), Array.from({ length: 2000 }, (_, i) => i));
  assert.ok(Date.now() - start < 60000); assert.equal(f.item.dead, false);
  t.diagnostic(`${pages} pages plus settings replies in ${Date.now() - start}ms`);
});
test('Rich concurrent flood never starts queued service work and closes the document once', async t => {
  let finish;
  const f = pagingRich(t, { query: () => new Promise(resolve => { finish = resolve; }) });
  const args = { query: { version: 1, resource: 'sessions' } };
  const pending = [f.call('data.query', args)]; await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 31; i++) pending.push(f.call('data.query', args));
  assert.equal(f.queries(), 1);
  assert.throws(() => f.call('settings.get', {}), /request limit/);
  assert.equal(f.item.dead, true);
  for (let i = 0; i < 1000; i++) assert.throws(() => f.call('data.query', args), /revoked/);
  assert.ok((await Promise.all(pending)).every(reply => !reply.ok));
  finish({ rows: ['private'] }); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.queries(), 1);
});
for (const action of ['hide', 'revoke']) test(`Rich ${action} cancels queued queries before service entry`, async t => {
  let finish;
  const f = pagingRich(t, { settingsGet: () => new Promise(resolve => { finish = resolve; }) });
  const blocked = f.call('settings.get', {}); await new Promise(resolve => setImmediate(resolve));
  const queued = f.call('data.query', { query: { version: 1, resource: 'sessions' } });
  if (action === 'hide') f.win.hide(); else f.manager.setEnabled('demo', false);
  assert.equal((await queued).ok, false); assert.equal((await blocked).ok, false); assert.equal(f.queries(), 0);
  finish({ values: {} }); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.queries(), 0);
});
for (const change of ['privacy', 'source']) test(`Rich queued cursor observes ${change} change before projection`, async t => {
  let finish;
  const f = pagingRich(t, { count: 5, settingsGet: () => new Promise(resolve => { finish = resolve; }) });
  const first = await f.call('data.query', { query: { version: 1, resource: 'sessions', page: { limit: 1 } } });
  assert.equal(first.value.rows[0].title.startsWith('Row'), true);
  const blocked = f.call('settings.get', {}); await new Promise(resolve => setImmediate(resolve));
  const queued = f.call('data.query', { query: { version: 1, resource: 'sessions', page: { limit: 1, cursor: first.value.pageInfo.nextCursor } } });
  f.business.publish(f.stats, change === 'privacy' ? { preferences: { sessionTitlesEnabled: false } } : { sourceId: 'other' });
  finish({ values: {} }); await blocked;
  const result = await queued; assert.equal(result.ok, true); assert.equal(result.value.availability, 'snapshotExpired');
});
test('Rich invalid cursor-shaped envelopes, oversized payloads and unsolicited calls still exhaust abuse budget', t => {
  for (const [op, args] of [['data.query', { query: { page: { cursor: 'anything' } } }], ['settings.get', { payload: 'x'.repeat(65537) }], ['unknown', {}]]) {
    const f = pagingRich(t);
    for (let i = 0; i < 110; i++) assert.throws(() => f.call(op, args));
    assert.equal(f.item.dead, true); assert.equal(f.queries(), 0);
  }
});

test('Rich admits all sixteen subscription registrations plus settings in one startup burst', async t => {
  const f = pagingRich(t, { count: 5 });
  const pending = Array.from({ length: 16 }, (_, i) => f.call('data.subscribe', { id: `s${i}`, query: { version: 1, resource: 'sessions' } }));
  pending.push(f.call('settings.get', {}));
  assert.ok((await Promise.all(pending)).every(reply => reply.ok));
  assert.equal(f.item.dead, false);
});

test('cold Rich mounts share revision assets and ignore development edits until reload', t => {
  const f = realFixture(t), webUi = richController(f);
  t.after(() => webUi.dispose());
  f.pages.open('demo/first'); const win = f.windows[0]; win.emit('ready-to-show');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const input = { surface: 'page', visible: true, entries: [{ instance: 'body', viewRef: 'demo/first', ref: 'demo/first-rich', rect: { x: 10, y: 10, width: 400, height: 300 } }] };
  const sync = () => f.handlers.get('plugins:presentation:sync')(event, input);
  sync(); const original = webUi.presentations()[0]; assert.ok(original);
  const originalAssets = original.assets;
  const file = path.join(f.root, 'plugins/demo/body.html');
  fs.writeFileSync(file, '<p>New revision</p>');
  webUi.releasePresentationHost(win.webContents);
  sync(); const second = webUi.presentations()[0]; assert.ok(second);
  assert.equal(second.assets, originalAssets, 'new documents reuse the exact validated asset snapshot');
  assert.equal(second.assets['body.html'].toString(), '<!doctype html><p>Rich page</p>');
  fs.unlinkSync(file);
  webUi.releasePresentationHost(win.webContents);
  sync(); assert.ok(webUi.presentations()[0], 'no file IO on cold mount after external deletion');
  fs.writeFileSync(file, '<p>New revision</p>');
  f.manager.reload();
  sync(); const updated = webUi.presentations()[0]; assert.ok(updated);
  assert.notEqual(updated.assets, originalAssets);
  assert.equal(updated.assets['body.html'].toString(), '<p>New revision</p>');
  fs.unlinkSync(file); f.manager.reload();
  assert.equal(f.manager.list().plugins[0].status, 'invalid', 'invalid reload cannot mount missing assets');
  assert.equal(webUi.presentations().length, 0);
});

for (const action of ['hide', 'minimize']) test(`host ${action} parks Rich immediately without native or renderer events`, async t => {
  const f = realFixture(t), releases = [], webUi = richController(f, { release: owner => releases.push(owner) });
  t.after(() => webUi.dispose());
  f.pages.open('demo/first'); const win = f.windows[0]; win.emit('ready-to-show');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const input = { surface: 'page', visible: true, entries: [{ instance: 'body', viewRef: 'demo/first', ref: 'demo/first-rich', rect: { x: 10, y: 10, width: 400, height: 300 } }] };
  const sync = () => f.handlers.get('plugins:presentation:sync')(event, input);
  const call = (item, op, args) => f.handlers.get('plugins:web:call')({ sender: item.view.webContents, senderFrame: item.view.webContents.mainFrame }, op, args);
  sync(); const item = webUi.presentations()[0];
  item.view.webContents.emit('did-finish-load'); call(item, 'present'); sync();
  assert.equal(item.view.visible, true);
  win.silentVisibility = true;
  let nativeEvents = 0;
  win.on(action, () => nativeEvents++);
  const actions = createWindowVisibilityActions(win => {
    webUi.refreshWindowVisibility(win);
    f.pages.refreshVisibility();
  });
  actions[action](win);
  // No sync(), emitted event, timer, or await may rescue the release assertion.
  assert.equal(webUi.presentations().length, 0);
  assert.equal(nativeEvents, 0);
  assert.equal(releases.includes(item.owner), true);
  assert.equal(item.view.visible, false);
  assert.deepEqual(webUi.cached(), [item]);
  assert.throws(() => call(item, 'context'), /revoked/);
  await item.lifecycle;
  win.restore(); win.show(); sync(); await item.lifecycle;
  call(item, 'resumed', item.epoch); sync();
  assert.equal(webUi.presentations()[0], item);
  assert.equal(item.view.visible, true);
  // A delivered native event still works without an explicit host action.
  win.silentVisibility = false; win.hide();
  assert.equal(webUi.presentations().length, 0);
});

for (const action of ['hide', 'minimize']) test(`host ${action} reconciles detached page worker demand without native events`, () => {
  const f = fixture();
  try {
    f.pages.open('demo/first'); const win = f.windows[0]; win.emit('ready-to-show');
    assert.deepEqual(f.demands.at(-1), ['page', ['demo/first']]);
    win.silentVisibility = true;
    createWindowVisibilityActions(() => f.pages.refreshVisibility())[action](win);
    assert.deepEqual(f.demands.at(-1), ['page', []]);
    f.pages.open('demo/first');
    assert.deepEqual(f.demands.at(-1), ['page', ['demo/first']]);
  } finally { f.pages.dispose(); }
});

test('window visibility actions ignore missing and destroyed windows', () => {
  let calls = 0;
  const actions = createWindowVisibilityActions(() => calls++);
  actions.hide(null); actions.minimize(undefined);
  actions.hide({ isDestroyed: () => true, hide() { throw Error('destroyed'); } });
  assert.equal(calls, 0);
});

for (const action of ['hide', 'minimize']) test(`host ${action} also parks original main authored targets without native events`, async t => {
  const f = realFixture(t, { legacy: true }); f.mainSender = true;
  const webUi = richController(f); t.after(() => webUi.dispose());
  f.pages.open('demo/first'); const win = f.windows[0]; win.emit('ready-to-show');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  f.handlers.get('plugins:web:select')(event, 'model', 'demo/model-rich');
  const input = { visible: true, snapshot: { target: 'model' }, rect: { x: 10, y: 10, width: 400, height: 300 } };
  const sync = () => f.handlers.get('plugins:web:sync')(event, input);
  sync(); const item = webUi.current();
  item.view.webContents.emit('did-finish-load');
  const childEvent = { sender: item.view.webContents, senderFrame: item.view.webContents.mainFrame };
  f.handlers.get('plugins:web:call')(childEvent, 'present'); sync();
  assert.equal(item.view.visible, true);
  assert.equal(item.presentation, undefined);
  win.silentVisibility = true;
  const actions = createWindowVisibilityActions(win => webUi.refreshWindowVisibility(win));
  actions[action](win);
  assert.equal(webUi.current(), null);
  assert.deepEqual(webUi.cached(), [item]);
  assert.equal(item.view.visible, false);
  // Stale renderer visibility cannot remount a natively hidden window.
  sync(); assert.equal(webUi.current(), null);
  await item.lifecycle;
  win.restore(); win.show(); sync(); await item.lifecycle;
  f.handlers.get('plugins:web:call')(childEvent, 'resumed', item.epoch); sync();
  assert.equal(webUi.current(), item);
  assert.equal(item.view.visible, true);
});
