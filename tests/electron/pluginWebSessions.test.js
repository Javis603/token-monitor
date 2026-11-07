'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createPluginWebSessions, connectionConfig } = require('../../src/electron/plugins/webSessions');
const config = { adapter: 'openai', key: 'platform', loginUrl: 'https://platform.openai.com/settings/organization/billing/overview', requestUrl: 'https://api.openai.com/v1/dashboard/billing/credit_grants', scopeHeaders: ['OpenAI-Organization'] };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-web-session-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessions = [], windows = [], calls = [], dialogs = []; let enabled = true, approval = 1;
  let fetch = async () => ({ ok: true, status: 200, body: Readable.from([Buffer.from('{"total_available":100}')]) });
  let applyProxy = async () => {}, closeConnections = async () => {};
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.dead = false; this.webContents = new EventEmitter(); this.webContents.id = windows.length + 10; this.webContents.setWindowOpenHandler = fn => { this.popup = fn; }; windows.push(this); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    async loadURL(url) { this.url = url; }
  }
  const electron = { BrowserWindow: Window,
    dialog: { showMessageBox: async options => { dialogs.push(options); return { response: approval }; } },
    session: { fromPartition: partition => {
      const sess = { partition, setProxy: async config => { sess.proxyConfig = config; await applyProxy(config); }, closeAllConnections: async () => { await closeConnections(); sess.connectionsClosed = true; }, clearStorageData: async () => {}, webRequest: { onBeforeSendHeaders: (...args) => { sess.before = args.at(-1); }, onCompleted: (...args) => { sess.completed = args.at(-1); } }, setPermissionRequestHandler: fn => { sess.permission = fn; }, fetch: async (...args) => { calls.push(args); return fetch(...args); } }; sessions.push(sess); return sess;
    } }
  };
  const create = (extra = {}) => createPluginWebSessions({ electron, fetchImpl: (...args) => electron.session.fromPartition('fixture-transport').fetch(...args), directory, active: () => enabled, ...extra });
  const service = create(); t.after(() => service.dispose());
  async function capture(statusCode = 200, changes = {}) {
    const sess = sessions.findLast(s => s.partition.startsWith('plugin-web-login-')), win = windows.at(-1);
    const request = { id: 10, url: config.requestUrl, method: 'GET', webContentsId: win.webContents.id,
      requestHeaders: { Authorization: 'Bearer synthetic-session-private', 'OpenAI-Organization': 'org-fixture' }, ...changes };
    let called = false; sess.before(request, () => { called = true; }); assert.equal(called, true);
    await sess.completed({ id: 10, statusCode });
  }
  return { service, create, capture, calls, windows, sessions, directory, electron, dialogs,
    applyProxy: value => { applyProxy = value; }, closeConnections: value => { closeConnections = value; },
    enabled: value => { enabled = value; }, approval: value => { approval = value; }, fetch: value => { fetch = value; } };
}
test('isolated login awaits current app proxy and socket cleanup before opening its page', async t => {
  const f = fixture(t), settings = {proxyUrl:'http://127.0.0.1:7890',noProxy:'example.test'};
  const service = f.create({getSettings:()=>settings}); t.after(()=>service.dispose());
  let finish; f.applyProxy(() => new Promise(resolve => { finish = resolve; }));
  const pending = service.connect('credit-test',config);
  for(let n=0;n<20&&!finish;n++) await new Promise(setImmediate);
  assert.equal(f.windows.length,0,'no page or window before proxy setup');
  assert.deepEqual(f.sessions[0].proxyConfig,{mode:'fixed_servers',proxyRules:settings.proxyUrl,proxyBypassRules:'example.test,*.example.test'});
  let closed; f.closeConnections(() => new Promise(resolve=>{closed=resolve;}));
  finish(); for(let n=0;n<20&&!closed;n++) await new Promise(setImmediate);
  assert.equal(f.windows.length,0,'socket cleanup is also awaited'); closed();
  assert.deepEqual(await pending,{state:'connecting'});
  assert.equal(f.windows[0].url,config.loginUrl);
  assert.equal(f.windows[0].options.webPreferences.session,f.sessions[0]);
  service.disconnect('credit-test','platform');
  settings.proxyUrl='http://127.0.0.1:7891'; f.applyProxy(async()=>{}); f.closeConnections(async()=>{});
  await service.connect('credit-test',config);
  assert.equal(f.sessions[1].proxyConfig.proxyRules,settings.proxyUrl,'new login reads current settings');
});
test('proxy setup or cleanup failure never opens a login page or falls back direct', async t => {
  for (const phase of ['applyProxy','closeConnections']) {
    const f = fixture(t), service = f.create({getSettings:()=>({proxyUrl:'http://127.0.0.1:7890'})}); t.after(()=>service.dispose());
    f[phase](async()=>{throw Error('synthetic proxy failure');});
    await assert.rejects(service.connect('credit-test',config),/web-session-connect-failed/);
    assert.equal(f.windows.length,0); assert.equal(f.calls.length,0);
    assert.equal((await service.status('credit-test','platform')).state,'notConnected');
  }
});
test('cancelling while the isolated proxy applies cannot open a late login', async t => {
  const f = fixture(t), service=f.create({getSettings:()=>({proxyUrl:'http://127.0.0.1:7890'})}); t.after(()=>service.dispose());
  let finish; f.applyProxy(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=service.connect('credit-test',config);
  for(let n=0;n<20&&!finish;n++) await new Promise(setImmediate);
  service.disconnect('credit-test','platform'); finish();
  assert.deepEqual(await pending,{state:'notConnected'}); assert.equal(f.windows.length,0);
});
test('a cancelled proxy setup failure cannot close a replacement login', async t => {
  const f=fixture(t), service=f.create({getSettings:()=>({proxyUrl:'http://127.0.0.1:7890'})}); t.after(()=>service.dispose());
  let fail; f.applyProxy(()=>new Promise((_resolve,reject)=>{fail=reject;}));
  const old=service.connect('credit-test',config);
  for(let n=0;n<20&&!fail;n++) await new Promise(setImmediate);
  service.disconnect('credit-test','platform'); f.applyProxy(async()=>{});
  assert.deepEqual(await service.connect('credit-test',config),{state:'connecting'});
  fail(Error('synthetic delayed proxy failure'));
  assert.deepEqual(await old,{state:'notConnected'});
  assert.equal(f.windows[0].dead,false);
  assert.equal((await service.status('credit-test','platform')).state,'connecting');
});
test('private JSON connection survives service restart; fixed GET includes captured organization and never returns the bearer', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.service.connect('credit-test', config), { state: 'connecting' });
  assert.match(f.dialogs[0].detail,/private JSON file/);
  assert.match(f.dialogs[0].detail,/not encrypted/);
  assert.ok(f.sessions[0].partition.startsWith('plugin-web-login-'));
  assert.equal(f.sessions[0].partition.startsWith('persist:'), false);
  await f.capture(); assert.equal(f.windows[0].dead, true);
  const files = fs.readdirSync(f.directory); assert.equal(files.length, 1);
  const record=JSON.parse(fs.readFileSync(path.join(f.directory,files[0]),'utf8'));
  assert.equal(record.authorization,'Bearer synthetic-session-private');
  assert.equal(record.encrypted,undefined);
  if(process.platform!=='win32'){assert.equal(fs.statSync(path.join(f.directory,files[0])).mode&0o777,0o600);assert.equal(fs.statSync(f.directory).mode&0o777,0o700);}
  f.enabled(false); f.service.cancelInactive();
  assert.deepEqual(fs.readdirSync(f.directory),files,'disable retains the private record');
  f.enabled(true);
  const second = f.create(); t.after(() => second.dispose());
  assert.deepEqual(await second.status('credit-test', 'platform'), { state: 'connected' });
  const result = await second.request('credit-test', 'platform');
  assert.deepEqual(result, { status: 200, body: { total_available: 100 } });
  assert.equal(JSON.stringify(result).includes('synthetic-session-private'), false);
  assert.equal(f.calls[0][0], config.requestUrl);
  assert.equal(f.calls[0][1].headers['OpenAI-Organization'], 'org-fixture');
  assert.equal(f.calls[0][1].redirect, 'error'); assert.equal(f.calls[0][1].credentials, 'omit');
  assert.deepEqual(await second.status('other-plugin', 'platform'), { state: 'notConnected' });
});
test('consent cancellation does not start login or persist anything', async t => {
  const f = fixture(t); f.approval(0);
  assert.deepEqual(await f.service.connect('credit-test', config), { state: 'notConnected' });
  assert.equal(f.windows.length, 0); assert.equal(fs.readdirSync(f.directory).length, 0);

});
for (const changes of [{ webContentsId: 999 }, { method: 'POST' }, { url: config.requestUrl + '/other' }, { requestHeaders: { Authorization: 'Bearer synthetic-session-private' } }]) test(`unrelated request cannot capture authorization: ${JSON.stringify(changes)}`, async t => {
  const f = fixture(t); await f.service.connect('credit-test', config); await f.capture(200, changes);
  assert.equal((await f.service.status('credit-test', 'platform')).state, 'connecting');
  assert.equal(fs.readdirSync(f.directory).length, 0);
});
test('failed billing response does not persist an authorization', async t => {
  const f = fixture(t); await f.service.connect('credit-test', config); await f.capture(401);
  assert.equal(fs.readdirSync(f.directory).length, 0);
});
test('disable cancels login and blocks requests; disconnect and uninstall remove persisted records', async t => {
  const f = fixture(t); await f.service.connect('credit-test', config); f.enabled(false); f.service.cancelInactive();
  assert.equal(f.windows[0].dead, true); await assert.rejects(f.service.request('credit-test', 'platform'), /inactive/);
  f.enabled(true); await f.service.connect('credit-test', config); await f.capture();
  f.service.disconnect('credit-test', 'platform'); assert.equal(fs.readdirSync(f.directory).length, 0);
  await f.service.connect('credit-test', config); await f.capture();
  f.service.forget('credit-test'); assert.equal(fs.readdirSync(f.directory).length, 0);
});
test('malformed persistence and remote errors fail without leaking backend messages', async t => {
  const f = fixture(t); await f.service.connect('credit-test', config); await f.capture();
  f.fetch(async () => { throw Error('Bearer synthetic-session-private'); });
  await assert.rejects(f.service.request('credit-test', 'platform'), error => error.message === 'web-session-request-failed');
  f.fetch(async () => ({ ok: false, status: 401 }));
  assert.deepEqual(await f.service.request('credit-test', 'platform'), { status: 401, body: null });
  f.service.cancelPlugin('credit-test');
  const second = f.create(); t.after(() => second.dispose());
  fs.writeFileSync(path.join(f.directory, fs.readdirSync(f.directory)[0]), 'broken');
  await assert.rejects(second.status('credit-test', 'platform'), /storage-unavailable/);
});
test('host adapter ignores caller destinations and rejects unknown adapters', async t => {
  const f = fixture(t);
  assert.equal(connectionConfig({...config, requestUrl:'https://other.example'}).requestUrl, config.requestUrl);
  assert.throws(()=>connectionConfig({adapter:'arbitrary'}));
  await assert.rejects(f.service.connect('../other', config), /invalid-key/);
  assert.equal(f.windows.length, 0);
});

test('a cancelled capture cannot restore deleted authorization', async t => {
  const f=fixture(t); await f.service.connect('credit-test',config);
  const session=f.sessions[0], window=f.windows[0];
  const request={id:12,url:config.requestUrl,method:'GET',webContentsId:window.webContents.id,
    requestHeaders:{Authorization:'Bearer synthetic-session-private','OpenAI-Organization':'org-fixture'}};
  session.before(request,()=>{}); const completed=session.completed;
  f.service.disconnect('credit-test','platform'); await completed({id:12,statusCode:200});
  assert.equal(fs.readdirSync(f.directory).length,0);
});
test('disconnect before a queued request sends prevents using the old authorization', async t => {
  const f=fixture(t); await f.service.connect('credit-test',config); await f.capture();
  const request=f.service.request('credit-test','platform');
  f.service.disconnect('credit-test','platform');
  await assert.rejects(request,/cancelled/); assert.equal(f.calls.length,0);
});
test('private storage works without a keyring or safeStorage API', async t => {
  const f=fixture(t); assert.equal(Object.hasOwn(f.electron,'safeStorage'),false);
  await f.service.connect('credit-test',config); await f.capture();
  assert.equal((await f.service.status('credit-test','platform')).state,'connected');
  assert.equal((await f.service.request('credit-test','platform')).body.total_available,100);
});
test('failed atomic replacement preserves the previous record and removes temporary files', async t => {
  const f=fixture(t); await f.service.connect('credit-test',config); await f.capture();
  const files=fs.readdirSync(f.directory), target=path.join(f.directory,files[0]);
  const before=fs.readFileSync(target);
  await f.service.connect('credit-test',config);
  const rename=fs.renameSync;
  t.mock.method(fs,'renameSync',(from,to)=>{if(to===target)throw Error('synthetic write failure');return rename(from,to);});
  await f.capture();
  assert.deepEqual(fs.readFileSync(target),before);
  assert.deepEqual(fs.readdirSync(f.directory),files);
  assert.deepEqual(await f.service.status('credit-test','platform'),{state:'error',error:'web-session-storage-unavailable'});
});
test('private record reads reject malformed authorization, headers and destinations without sending requests', async t => {
  const f=fixture(t); await f.service.connect('credit-test',config); await f.capture();
  const target=path.join(f.directory,fs.readdirSync(f.directory)[0]), record=JSON.parse(fs.readFileSync(target));
  for(const change of [{version:99},{authorization:null},{authorization:'Bearer bad\nheader'},
    {headers:null},{headers:{'OpenAI-Organization':'bad\nheader'}},{requestUrl:'https://other.example'},
    {loginUrl:'https://other.example'},{expiresAt:'invalid'}]) {
    fs.writeFileSync(target,JSON.stringify({...record,...change}));
    await assert.rejects(f.service.request('credit-test','platform'),error=>error.message==='web-session-storage-unavailable');
  }
  assert.equal(f.calls.length,0);
});
test('private record reads reject symlinks and repair file permissions using the shared helper', async t => {
  const f=fixture(t); await f.service.connect('credit-test',config); await f.capture();
  const target=path.join(f.directory,fs.readdirSync(f.directory)[0]);
  if(process.platform!=='win32') {
    fs.chmodSync(target,0o644); await f.service.status('credit-test','platform');
    assert.equal(fs.statSync(target).mode&0o777,0o600);
    const other=path.join(f.directory,'synthetic-private-record'); fs.renameSync(target,other);fs.symlinkSync(other,target);
    await assert.rejects(f.service.status('credit-test','platform'),/storage-unavailable/);
    assert.equal(f.calls.length,0);
  }
});

test('disconnect and missing-code cleanup isolate both connection and plugin namespaces', async t => {
  const f = fixture(t);
  await f.service.connect('credit-test', config); await f.capture();
  await f.service.connect('credit-test', { ...config, key: 'second' }); await f.capture();
  await f.service.connect('other-plugin', config); await f.capture();
  assert.equal(fs.readdirSync(f.directory).length, 3);
  f.service.disconnect('credit-test', 'platform');
  assert.equal((await f.service.status('credit-test', 'second')).state, 'connected');
  f.enabled(false); f.service.forget('credit-test');
  assert.equal(fs.readdirSync(f.directory).length, 1);
  f.enabled(true); assert.equal((await f.service.status('other-plugin', 'platform')).state, 'connected');
});
test('bearer responses are bounded and 401 makes reconnect visible', async t => {
  const f = fixture(t); await f.service.connect('credit-test', config); await f.capture();
  f.fetch(async () => ({ ok: true, status: 200, body: Readable.from([Buffer.alloc(262145)]) }));
  await assert.rejects(f.service.request('credit-test', 'platform'), /request-failed/);
  f.fetch(async () => ({ ok: false, status: 401 }));
  await f.service.request('credit-test', 'platform');
  assert.deepEqual(await f.service.status('credit-test', 'platform'), { state: 'error', error: 'reconnect-required' });
});
test('cancelled reconnect retains confirmed rejection until replacement authorization is saved', async t => {
  for (const code of [401,403]) {
    const f=fixture(t); await f.service.connect('credit-test',config); await f.capture();
    f.fetch(async()=>({ok:false,status:code})); await f.service.request('credit-test','platform');
    const rejected={state:'error',error:'reconnect-required'};
    f.approval(0);
    await f.service.connect('credit-test',config);
    assert.deepEqual(await f.service.status('credit-test','platform'),rejected,'consent cancellation preserves rejection');
    f.approval(1); await f.service.connect('credit-test',config); f.windows.at(-1).destroy();
    assert.deepEqual(await f.service.status('credit-test','platform'),rejected,'closing login preserves rejection');
    await f.service.connect('credit-test',config); await f.capture();
    assert.equal((await f.service.status('credit-test','platform')).state,'connected','saved replacement clears rejection');
  }
});
test('captured JWT expiry requires reconnect without sending expired authorization', async t => {
  const f = fixture(t); await f.service.connect('credit-test', config);
  const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url');
  await f.capture(200, { requestHeaders: { Authorization: `Bearer fixture.${payload}.signature`, 'OpenAI-Organization': 'org-fixture' } });
  assert.deepEqual(await f.service.status('credit-test', 'platform'), { state: 'reconnectRequired' });
  assert.equal((await f.service.request('credit-test', 'platform')).status, 401);
  assert.equal(f.calls.length, 0);
});
test('forget matches exact plugin namespace even when another valid ID begins with its delimiter', async t => {
  const f = fixture(t);
  await f.service.connect('fixture', config); await f.capture();
  await f.service.connect('fixture--other', config); await f.capture();
  assert.equal(fs.readdirSync(f.directory).length, 2);
  f.service.forget('fixture');
  assert.equal(fs.readdirSync(f.directory).length, 1);
  assert.equal((await f.service.status('fixture--other', 'platform')).state, 'connected');
});
test('forget clears an in-memory failure even when credential directory has disappeared', async t => {
  const f = fixture(t); await f.service.connect('credit-test', config); await f.capture();
  f.fetch(async () => ({ ok: false, status: 401 })); await f.service.request('credit-test', 'platform');
  fs.rmSync(f.directory, { recursive: true, force: true });
  f.service.forget('credit-test');
  assert.deepEqual(await f.service.status('credit-test', 'platform'), { state: 'notConnected' });
});
test('authenticated requests use the injected transport and never fall back around proxy failures', async t => {
  const f = fixture(t); await f.service.connect('credit-test', config); await f.capture();
  const injected = []; let rejectRoute = false;
  const service = f.create({ fetchImpl: async (...args) => {
    injected.push(args);
    if (rejectRoute) throw Error('synthetic proxy unavailable');
    return { ok: true, status: 200, body: Readable.from([Buffer.from('{"total_available":42}')]) };
  } }); t.after(() => service.dispose());
  assert.equal((await service.request('credit-test', 'platform')).body.total_available, 42);
  assert.equal(injected[0][0], config.requestUrl); assert.equal(injected[0][1].credentials, 'omit');
  assert.equal(injected[0][1].redirect, 'error'); assert.equal(f.calls.length, 0);
  rejectRoute = true; await assert.rejects(service.request('credit-test', 'platform'), /request-failed/);
  assert.equal(injected.length, 2); assert.equal(f.calls.length, 0);
});
