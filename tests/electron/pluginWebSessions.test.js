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
  const sessions = [], windows = [], calls = []; let enabled = true, encrypted = true, backend = 'gnome_libsecret', approval = 1;
  let fetch = async () => ({ ok: true, status: 200, body: Readable.from([Buffer.from('{"total_available":100}')]) });
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.dead = false; this.webContents = new EventEmitter(); this.webContents.id = windows.length + 10; this.webContents.setWindowOpenHandler = fn => { this.popup = fn; }; windows.push(this); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    async loadURL(url) { this.url = url; }
  }
  const crypt = value => Buffer.from([...value].map(byte => byte ^ 113));
  const electron = { BrowserWindow: Window,
    safeStorage: { isAsyncEncryptionAvailable: async () => encrypted, getSelectedStorageBackend: () => backend, encryptStringAsync: async value => crypt(Buffer.from(value)), decryptStringAsync: async value => ({ result: crypt(value).toString(), shouldReEncrypt: false }) },
    dialog: { showMessageBox: async () => ({ response: approval }) },
    session: { fromPartition: partition => {
      const sess = { partition, clearStorageData: async () => {}, webRequest: { onBeforeSendHeaders: (...args) => { sess.before = args.at(-1); }, onCompleted: (...args) => { sess.completed = args.at(-1); } }, setPermissionRequestHandler: fn => { sess.permission = fn; }, fetch: async (...args) => { calls.push(args); return fetch(...args); } }; sessions.push(sess); return sess;
    } }
  };
  const create = (extra = {}) => createPluginWebSessions({ electron, directory, active: () => enabled, ...extra });
  const service = create(); t.after(() => service.dispose());
  async function capture(statusCode = 200, changes = {}) {
    const sess = sessions.findLast(s => s.partition.startsWith('plugin-web-login-')), win = windows.at(-1);
    const request = { id: 10, url: config.requestUrl, method: 'GET', webContentsId: win.webContents.id,
      requestHeaders: { Authorization: 'Bearer synthetic-session-private', 'OpenAI-Organization': 'org-fixture' }, ...changes };
    let called = false; sess.before(request, () => { called = true; }); assert.equal(called, true);
    await sess.completed({ id: 10, statusCode });
  }
  return { service, create, capture, calls, windows, sessions, directory, electron,
    enabled: value => { enabled = value; }, encrypted: value => { encrypted = value; }, backend: value => { backend = value; }, approval: value => { approval = value; }, fetch: value => { fetch = value; } };
}
test('encrypted connection survives service restart; fixed GET includes captured organization and never returns the bearer', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.service.connect('credit-test', config), { state: 'connecting' });
  assert.ok(f.sessions[0].partition.startsWith('plugin-web-login-'));
  assert.equal(f.sessions[0].partition.startsWith('persist:'), false);
  await f.capture(); assert.equal(f.windows[0].dead, true);
  const files = fs.readdirSync(f.directory); assert.equal(files.length, 1);
  assert.equal(fs.readFileSync(path.join(f.directory, files[0]), 'utf8').includes('synthetic-session-private'), false);
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
test('consent cancellation and unsafe storage do not start login or persist anything', async t => {
  const f = fixture(t); f.approval(0);
  assert.deepEqual(await f.service.connect('credit-test', config), { state: 'notConnected' });
  assert.equal(f.windows.length, 0); assert.equal(fs.readdirSync(f.directory).length, 0);
  f.encrypted(false); await assert.rejects(f.service.connect('credit-test', config), /secure-storage-unavailable/);
  f.encrypted(true); f.backend('basic_text'); await assert.rejects(f.service.connect('credit-test', config), /secure-storage-unavailable/);
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

test('disconnect during async encryption cannot restore a deleted authorization', async t => {
  const f = fixture(t); await f.service.connect('credit-test', config);
  let finish;
  f.electron.safeStorage.encryptStringAsync = () => new Promise(resolve => { finish = resolve; });
  const capture = f.capture(); await new Promise(setImmediate);
  f.service.disconnect('credit-test', 'platform'); finish(Buffer.from('fixture-encrypted-data')); await capture;
  assert.equal(fs.readdirSync(f.directory).length, 0);
  assert.equal((await f.service.status('credit-test', 'platform')).state, 'notConnected');
});
test('disconnect while decrypting prevents sending a request with the old authorization', async t => {
  const f = fixture(t); await f.service.connect('credit-test', config); await f.capture();
  const original = f.electron.safeStorage.decryptStringAsync; let finish;
  f.electron.safeStorage.decryptStringAsync = value => new Promise(resolve => { finish = async () => resolve(await original(value)); });
  const request = f.service.request('credit-test', 'platform'); await new Promise(setImmediate);
  f.service.disconnect('credit-test', 'platform'); await finish();
  await assert.rejects(request, /cancelled/); assert.equal(f.calls.length, 0);
});
test('disconnect during encryption availability checks cannot open a late login window', async t => {
  const f = fixture(t); let finish;
  f.electron.safeStorage.isAsyncEncryptionAvailable = () => new Promise(resolve => { finish = resolve; });
  const pending = f.service.connect('credit-test', config); await new Promise(setImmediate);
  f.service.disconnect('credit-test', 'platform'); finish(true);
  assert.equal((await pending).state, 'notConnected'); assert.equal(f.windows.length, 0);
});
test('unknown Linux key providers fail closed', async t => {
  const f = fixture(t); f.backend('unknown'); const linux = f.create({ platform: 'linux' }); t.after(() => linux.dispose());
  await assert.rejects(linux.connect('credit-test', config), /secure-storage-unavailable/);
  assert.equal(f.windows.length, 0);
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
