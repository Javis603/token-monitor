'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentTitleSync } = require('../../src/agent/titleSync');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { createHub } = require('../../src/hub/server');

const request = { hubUrl: 'https://a.example', deviceId: 'one', headers: { authorization: 'Bearer private-a' }, enabled: true };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-title-journal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const warnings = [], calls = [];
  const hubs = new Map();
  const secrets = new Map([['a.example', 'Bearer private-a'], ['b.example', 'Bearer private-b']]);
  let offline = new Set();
  let intercept;
  let writeFailure;
  for (const host of secrets.keys()) hubs.set(host, createHub({ dataFile: path.join(directory, host + '.json'), syncSessionTitles: true }));
  const fetchFn = async (url, options = {}) => {
    const u = new URL(url), hub = hubs.get(u.hostname);
    const payload = options.body ? JSON.parse(options.body) : null;
    const call = { url, host: u.hostname, ...options, payload };
    calls.push(call);
    if (intercept) {
      const response = await intercept(call);
      if (response) return response;
    }
    if (offline.has(u.hostname)) throw new Error('offline');
    if (options.headers?.authorization !== secrets.get(u.hostname)) return new Response('', { status: 401 });
    if (u.pathname === '/api/sync/content') return Response.json(hub.getSyncContent());
    return Response.json({ ok: true, ...hub.setSyncTitlePolicy(decodeURIComponent(u.pathname.split('/').at(-1)), payload.enabled) });
  };
  const filePath = path.join(directory, 'agent-sync-credentials.json');
  const store = new CredentialStore(directory, { filePath });
  const write = store.writeDocument.bind(store);
  store.writeDocument = document => { if (writeFailure?.(document)) throw Object.assign(new Error('sensitive disk failure'), { code: 'ENOSPC' }); return write(document); };
  const make = extra => createAgentTitleSync({ dataDir: directory, fetchFn, store, logger: { warn: text => warnings.push(text) }, ...extra });
  const state = () => store.readDocument().credentials.hub?.titleSync;
  const policy = (host, id) => JSON.parse(fs.readFileSync(path.join(directory, host + '.json'))).syncTitlePolicies[id];
  function upload(host, id, options) {
    return hubs.get(host).ingest({ deviceId: id, sessionTitleSyncGeneration: options.sessionTitleSyncGeneration,
      today: { totalTokens: 4, sessions: { 'codex:s': { client: 'codex', sessionId: 's', totalTokens: 4, title: 'sensitive fixture', preview: 'never' } } } });
  }
  return { make, store, directory, filePath, calls, warnings, secrets, hubs, state, policy, upload,
    offline: hosts => { offline = new Set(hosts); }, intercept: fn => { intercept = fn; }, failWrites: fn => { writeFailure = fn; } };
}

for (const change of ['hub', 'device', 'credential']) test(`restart revokes old ${change} binding before admitting the replacement`, async t => {
  const f = fixture(t);
  const before = await f.make().negotiate(request);
  assert.equal(before.syncSessionTitles, true);
  f.upload('a.example', 'one', before);
  const next = change === 'hub' ? { ...request, hubUrl: 'https://b.example', headers: { authorization: 'Bearer private-b' } }
    : change === 'device' ? { ...request, deviceId: 'two' } : { ...request, headers: { authorization: 'Bearer private-new' } };
  // A rotated server can accept the old credential for revocation during migration.
  if (change === 'credential') f.intercept(call => {
    if (call.host === 'a.example' && call.payload?.enabled === true && call.headers.authorization === 'Bearer private-new') {
      return Response.json({ ok: true, ...f.hubs.get('a.example').setSyncTitlePolicy('one', true) });
    }
    if (call.url.endsWith('/api/sync/content') && call.headers.authorization === 'Bearer private-new') return Response.json(f.hubs.get('a.example').getSyncContent());
  });
  const start = f.calls.length;
  const result = await f.make().negotiate(next);
  assert.equal(result.syncSessionTitles, true);
  assert.equal(f.calls[start].host, 'a.example');
  assert.equal(f.calls[start].payload.enabled, false);
  assert.equal(f.calls[start].headers.authorization, 'Bearer private-a');
  assert.equal(f.hubs.get('a.example').getDevices()[0].periods.today.sessions['codex:s'].title, undefined);
  assert.equal(f.state().pending.length, 0);
  assert.equal(f.state().active.deviceId, next.deviceId);
  assert.ok(f.calls.every(call => call.redirect === 'error'));
});

test('unchanged restart resumes active consent without revocation or repeated disk writes', async t => {
  const f = fixture(t);
  const first = await f.make().negotiate(request);
  const file = fs.readFileSync(f.filePath, 'utf8');
  const resumed = f.make();
  assert.equal((await resumed.negotiate(request)).sessionTitleSyncGeneration, first.sessionTitleSyncGeneration);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), file);
  assert.equal(f.calls.some(c => c.payload?.enabled === false), false);
  const count = f.calls.length;
  await resumed.negotiate(request);
  assert.equal(f.calls.length, count);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
});

test('offline old hub cleanup survives restart, retries, and does not block new destination usage/title consent', async t => {
  const f = fixture(t);
  f.upload('a.example', 'one', await f.make().negotiate(request));
  f.offline(['a.example']);
  const next = { ...request, hubUrl: 'https://b.example', headers: { authorization: 'Bearer private-b' } };
  assert.equal((await f.make().negotiate(next)).syncSessionTitles, true);
  assert.equal(f.state().pending.length, 1);
  assert.equal(f.policy('a.example', 'one').enabled, true);
  assert.ok(f.warnings.some(w => w.includes('pending')));
  f.offline([]);
  assert.equal((await f.make().negotiate(next)).syncSessionTitles, true);
  assert.equal(f.state().pending.length, 0);
  assert.equal(f.policy('a.example', 'one').enabled, false);
  assert.equal(f.hubs.get('a.example').getDevices()[0].periods.today.sessions['codex:s'].title, undefined);
});

test('same-target credential rotation with unauthorized old cleanup stays text-free without losing obligation', async t => {
  const f = fixture(t);
  await f.make().negotiate(request);
  f.secrets.set('a.example', 'Bearer private-new');
  const next = { ...request, headers: { authorization: 'Bearer private-new' } };
  const result = await f.make().negotiate(next);
  assert.equal(result.syncSessionTitles, false);
  assert.equal(f.state().active, null);
  assert.equal(f.state().pending.length, 1);
  assert.equal(f.state().pending[0].headers.authorization, request.headers.authorization);
  assert.ok(!f.calls.some(c => c.payload?.enabled === true && c.headers.authorization === 'Bearer private-new'));
});

test('restart with OFF revokes stored title and deletes credential only after acknowledgement', async t => {
  const f = fixture(t);
  f.upload('a.example', 'one', await f.make().negotiate(request));
  f.offline(['a.example']);
  assert.equal((await f.make().negotiate({ ...request, enabled: false })).syncSessionTitles, false);
  assert.equal(f.state().active, null);
  assert.equal(f.state().pending.length, 1);
  f.offline([]);
  const off = f.make();
  await off.negotiate({ ...request, enabled: false });
  assert.equal(f.state().pending.length, 0);
  assert.equal(f.policy('a.example', 'one').enabled, false);
  const count = f.calls.length;
  await off.negotiate({ ...request, enabled: false });
  assert.equal(f.calls.length, count);
});

test('admission write failure never sends ON and later writable recovery succeeds', async t => {
  const f = fixture(t), n = f.make();
  f.failWrites(() => true);
  assert.equal((await n.negotiate(request)).syncSessionTitles, false);
  assert.ok(!f.calls.some(c => c.payload?.enabled === true));
  f.failWrites(null);
  assert.equal((await n.negotiate(request)).syncSessionTitles, true);
  assert.equal(f.state().active.deviceId, 'one');
  assert.doesNotMatch(f.warnings.join(' '), /private-a|sensitive disk failure/);
});

test('lost ON response and failed consent commit both leave a restart-revocable journal', async t => {
  for (const failure of ['response', 'commit']) {
    const f = fixture(t);
    if (failure === 'response') f.intercept(call => {
      if (call.payload?.enabled) {
        const journal = f.state();
        assert.equal(journal.active, null);
        assert.equal(journal.pending.length, 1, 'must exist on disk before server admission');
        f.hubs.get('a.example').setSyncTitlePolicy('one', true);
        throw new Error('response lost');
      }
    });
    else f.failWrites(d => Boolean(d.credentials.hub?.titleSync.active));
    assert.equal((await f.make().negotiate(request)).syncSessionTitles, false);
    assert.equal(f.state().pending.length, 1);
    assert.equal(f.policy('a.example', 'one').enabled, true);
    f.intercept(null); f.failWrites(null);
    await f.make().negotiate({ ...request, enabled: false });
    assert.equal(f.state().pending.length, 0);
    assert.equal(f.policy('a.example', 'one').enabled, false);
  }
});

test('remote OFF success followed by row-removal write failure remains retryable after restart', async t => {
  const f = fixture(t);
  await f.make().negotiate(request);
  f.failWrites(d => !d.credentials.hub.titleSync.active && d.credentials.hub.titleSync.pending.length === 0);
  await f.make().negotiate({ ...request, enabled: false });
  assert.equal(f.state().pending.length, 1);
  assert.equal(f.policy('a.example', 'one').enabled, false);
  f.failWrites(null);
  await f.make().negotiate({ ...request, enabled: false });
  assert.equal(f.state().pending.length, 0);
});

test('destination queue changes invalidate in-flight admission without publishing title consent', async t => {
  const f = fixture(t), n = f.make();
  let release, arrived;
  const waiting = new Promise(r => { arrived = r; });
  const gate = new Promise(r => { release = r; });
  f.intercept(async call => { if (call.host === 'a.example' && call.payload?.enabled) { arrived(); await gate; } });
  const a = n.negotiate(request);
  await waiting;
  const b = n.negotiate({ ...request, hubUrl: 'https://b.example', headers: { authorization: 'Bearer private-b' } });
  release();
  assert.equal((await a).syncSessionTitles, false);
  assert.equal((await b).syncSessionTitles, true);
  assert.equal(f.policy('a.example', 'one').enabled, false);
  assert.equal(f.state().pending.length, 0);
});

test('corrupt or symlinked journal is never replaced and title sending fails closed', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, '{broken');
  assert.equal((await f.make().negotiate(request)).syncSessionTitles, false);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), '{broken');
  assert.equal(f.calls.length, 0);
  fs.unlinkSync(f.filePath);
  const other = path.join(f.directory, 'other.json');
  fs.writeFileSync(other, '{}');
  try { fs.symlinkSync(other, f.filePath); } catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.equal((await f.make().negotiate(request)).syncSessionTitles, false);
  assert.equal(fs.readFileSync(other, 'utf8'), '{}');
  assert.ok(fs.lstatSync(f.filePath).isSymbolicLink());
});

test('live overlapping writer fails closed and dead-process lock recovery preserves pending cleanup', async t => {
  const f = fixture(t);
  await f.make().negotiate(request);
  const locks = f.filePath + '.locks';
  fs.mkdirSync(locks, { recursive: true });
  const lock = path.join(locks, `${process.pid}-00000000-0000-4000-8000-000000000000.json`);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const count = f.calls.length;
  assert.equal((await f.make({ isAlive: () => true }).negotiate(request)).syncSessionTitles, false);
  assert.equal(f.calls.length, count);
  assert.equal((await f.make({ isAlive: () => false }).negotiate({ ...request, enabled: false })).syncSessionTitles, false);
  assert.equal(f.policy('a.example', 'one').enabled, false);
  assert.equal(fs.existsSync(lock), false);
});

test('invalid replacement still revokes the saved old destination', async t => {
  const f = fixture(t);
  f.upload('a.example', 'one', await f.make().negotiate(request));
  assert.equal((await f.make().negotiate({ ...request, hubUrl: 'not a URL' })).syncSessionTitles, false);
  assert.equal(f.policy('a.example', 'one').enabled, false);
  assert.equal(f.state().active, null);
  assert.equal(f.state().pending.length, 0);
});

test('revocation failure retries without dropping old credentials; unauthorized current hub gets text-free usage', async t => {
  const f = fixture(t), n = f.make();
  await n.negotiate(request);
  f.secrets.set('a.example', 'changed');
  const options = await n.negotiate({ ...request, enabled: false });
  assert.equal(options.syncSessionTitles, false);
  assert.equal(f.state().pending.length, 1);
  f.secrets.set('a.example', 'Bearer private-a');
  await f.make().negotiate({ ...request, enabled: false });
  assert.equal(f.state().pending.length, 0);
  assert.equal(f.policy('a.example', 'one').enabled, false);
});

test('server off/on renews admission after retaining cleanup responsibility', async t => {
  const f = fixture(t);
  let allowed = true, time = 0;
  f.intercept(call => {
    if (call.url.endsWith('/api/sync/content')) return Response.json({ ...f.hubs.get(call.host).getSyncContent(), sessionTitles: { enabled: allowed } });
  });
  const n = f.make({ now: () => time });
  const first = await n.negotiate(request);
  allowed = false; time = 60001;
  assert.equal((await n.negotiate(request)).syncSessionTitles, false);
  assert.equal(f.state().active, null);
  allowed = true; time = 120002;
  const renewed = await n.negotiate(request);
  assert.equal(renewed.syncSessionTitles, true);
  assert.ok(renewed.sessionTitleSyncGeneration > first.sessionTitleSyncGeneration);
  assert.equal(f.state().active.deviceId, 'one');
});

test('bounded cleanup rotates unreachable rows and eventually scrubs reachable later rows', async t => {
  const f = fixture(t);
  await f.make().negotiate(request);
  const document = f.store.readDocument();
  const state = document.credentials.hub.titleSync;
  state.pending = Array.from({ length: 5 }, (_, i) => ({ ...request, deviceId: `old-${i}`, id: require('node:crypto').randomUUID() }));
  state.active = null;
  f.store.writeDocument(document);
  f.offline(['a.example']);
  const n = f.make();
  await n.negotiate({ ...request, hubUrl: 'https://b.example', headers: { authorization: 'Bearer private-b' } });
  assert.equal(f.state().pending[0].deviceId, 'old-4');
  const start = f.calls.length;
  f.offline([]);
  await n.negotiate({ ...request, hubUrl: 'https://b.example', headers: { authorization: 'Bearer private-b' } });
  assert.equal(f.calls[start].url.endsWith('/old-4'), true);
  assert.equal(f.state().pending.length, 1);
});

test('real process exit after remote admission leaves durable cleanup recovered over authenticated HTTP', async t => {
  const { spawn } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-title-process-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hub = createHub({ host: '127.0.0.1', port: 0, secret: 'fixture-secret', syncSessionTitles: true, dataFile: path.join(directory, 'hub.json') });
  await hub.start();
  t.after(() => hub.stop());
  const binding = { hubUrl: `http://127.0.0.1:${hub.server.address().port}`, deviceId: 'fixture-agent', headers: { authorization: 'Bearer fixture-secret' }, enabled: true };
  const script = `
    const { createAgentTitleSync } = require(process.argv[1]);
    const input = JSON.parse(process.argv[3]);
    const transport = async (url, options) => {
      const response = await fetch(url, options);
      if (options.body && JSON.parse(options.body).enabled && response.ok) process.exit(0);
      return response;
    };
    createAgentTitleSync({ dataDir: process.argv[2], fetchFn: transport }).negotiate(input).then(() => process.exit(2));
  `;
  const child = spawn(process.execPath, ['-e', script, path.resolve(__dirname, '../../src/agent/titleSync.js'), directory, JSON.stringify(binding)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('fixture process timeout')); }, 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(exitCode, 0);
  const store = new CredentialStore(directory, { filePath: path.join(directory, 'agent-sync-credentials.json') });
  assert.equal(store.readDocument().credentials.hub.titleSync.pending.length, 1);
  const policy = () => JSON.parse(fs.readFileSync(path.join(directory, 'hub.json'))).syncTitlePolicies['fixture-agent'];
  assert.equal(policy().enabled, true);
  hub.ingest({ deviceId: binding.deviceId, sessionTitleSyncGeneration: policy().generation,
    today: { totalTokens: 1, sessions: { 'codex:s': { client: 'codex', sessionId: 's', totalTokens: 1, title: 'private process fixture' } } } });
  const warnings = [];
  await createAgentTitleSync({ dataDir: directory, fetchFn: fetch, logger: { warn: x => warnings.push(x) } }).negotiate({ ...binding, enabled: false });
  assert.equal(policy().enabled, false);
  assert.equal(hub.getDevices()[0].periods.today.sessions['codex:s'].title, undefined);
  assert.equal(store.readDocument().credentials.hub.titleSync.pending.length, 0);
  assert.equal(fs.readdirSync(store.filePath + '.locks').length, 0);
  assert.equal(warnings.length, 0);
});

test('another process replacing the same admission invalidates a running agents cached generation', async t => {
  const { spawn } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-title-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hub = createHub({ host: '127.0.0.1', port: 0, secret: 'fixture-secret', syncSessionTitles: true, dataFile: path.join(directory, 'hub.json') });
  await hub.start();
  t.after(() => hub.stop());
  const binding = { hubUrl: `http://127.0.0.1:${hub.server.address().port}`, deviceId: 'fixture-agent', headers: { authorization: 'Bearer fixture-secret' }, enabled: true };
  const a = createAgentTitleSync({ dataDir: directory, fetchFn: fetch });
  const first = await a.negotiate(binding);
  const script = `
    const { createAgentTitleSync } = require(process.argv[1]);
    const input = JSON.parse(process.argv[3]);
    const n = createAgentTitleSync({ dataDir: process.argv[2], fetchFn: fetch });
    (async () => {
      await n.negotiate({ ...input, enabled: false });
      const options = await n.negotiate(input);
      process.stdout.write(JSON.stringify(options));
    })().catch(() => process.exit(2));
  `;
  const child = spawn(process.execPath, ['-e', script, path.resolve(__dirname, '../../src/agent/titleSync.js'), directory, JSON.stringify(binding)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('fixture process timeout')); }, 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(`fixture process exited ${code}`)); });
  });
  const renewed = JSON.parse(output);
  assert.ok(renewed.sessionTitleSyncGeneration > first.sessionTitleSyncGeneration);
  hub.ingest({ deviceId: binding.deviceId, sessionTitleSyncGeneration: renewed.sessionTitleSyncGeneration,
    today: { totalTokens: 1, sessions: { 'codex:s': { client: 'codex', sessionId: 's', totalTokens: 1, title: 'fresh child title' } } } });
  const resumed = await a.negotiate(binding);
  assert.equal(resumed.sessionTitleSyncGeneration, renewed.sessionTitleSyncGeneration);
  const { postSyncPayload } = require('../../src/shared/syncPayload');
  const sent = await postSyncPayload(fetch, `${binding.hubUrl}/api/ingest`, { headers: binding.headers,
    summary: { deviceId: binding.deviceId, today: { totalTokens: 2, sessions: { 'codex:s': { client: 'codex', sessionId: 's', totalTokens: 2, title: 'fresh parent title' } } } }, ...resumed });
  assert.equal(sent.response.ok, true);
  assert.equal(hub.getDevices()[0].periods.today.sessions['codex:s'].title, 'fresh parent title');
});
