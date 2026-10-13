'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { options, ReportSink, run, lock, identityOf, identityFromProcStat } = require('../../scripts/codex-cloud-auto-watch');
const POSIX = ['linux', 'darwin'].includes(process.platform);
// Secure on-disk observer ownership currently relies on POSIX mode/uid checks.
// Keep the existing refusal on Windows; do not weaken it to run these cases.
function storageTest(name, optionsOrBody, body) {
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody;
  return test(name, { ...options, skip: POSIX ? options.skip : 'Observer storage requires POSIX ownership; Windows ACL support is unavailable' }, body || optionsOrBody);
}
const ID = '01900000-0000-7000-8000-000000000001', TURN = '01900000-0000-7000-8000-000000000002', SCOPE = 'a'.repeat(64);
function temp(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-auto-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function sample(n) { const usage = { inputTokens: n - 10, outputTokens: 10, totalTokens: n, cachedInputTokens: 0, reasoningOutputTokens: 0 }; return { threadId: ID, turnId: TURN, total: usage, last: { ...usage }, observedAt: new Date().toISOString() }; }
function report(scope = SCOPE) { return { kind: 'codex-cloud-auto-watch', scopeFingerprint: scope, state: 'listening', observedAt: new Date().toISOString(), knownThreads: 0, listeningThreads: 0, measuredThreads: 0, waitingForSlot: 0, threads: [], diagnostics: [] }; }
test('Windows observer storage fails closed without deleting existing owner evidence', { skip: process.platform !== 'win32' }, (t) => {
  const root = temp(t), folder = path.join(root, 'process.lock');
  fs.mkdirSync(folder);
  const owner = path.join(folder, 'owner.json'), evidence = '{"unverified":"preserve"}\n';
  fs.writeFileSync(owner, evidence);
  assert.throws(() => lock(root), { code: 'UNSAFE_AUTO_LOCK' });
  assert.throws(() => new ReportSink(root), { code: 'UNSAFE_AUTO_LOCK' });
  assert.equal(fs.readFileSync(owner, 'utf8'), evidence);
  assert.deepEqual(fs.readdirSync(root), ['process.lock']);
});
test('help and missing consent never load credentials or connect', () => {
  const entry = path.resolve(__dirname, '../../scripts/codex-cloud-auto-watch.js');
  const h = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: '/nonexistent' } });
  assert.equal(h.status, 0); assert.ok(h.stdout.includes('No manual thread IDs'));
  assert.throws(() => options([]), { code: 'AUTO_ATTACH_CONSENT_REQUIRED' });
  for (const args of [['--interval', '1'], ['--max-listening', '129'], ['--seconds', '0'], ['--pages', '100']]) assert.throws(() => options(['--acknowledge-auto-attach', ...args]));
});
storageTest('one directory cannot have duplicate active monitors', (t) => {
  const root = temp(t); const a = new ReportSink(root);
  try { assert.throws(() => new ReportSink(root), { code: 'AUTO_MONITOR_ALREADY_RUNNING' }); }
  finally { a.close(); }
  const b = new ReportSink(root); b.close(); assert.ok(!fs.existsSync(path.join(root, 'process.lock')));
});
storageTest('numeric event journal and snapshots use private files and preserve scope', (t) => {
  const s = new ReportSink(temp(t));
  try {
    s.event({ scopeFingerprint: SCOPE, connectionNumber: 1, sample: sample(100) }); s.publish(report());
    assert.equal(fs.statSync(path.join(s.runDir, 'events.ndjson')).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, 'report.json'))).scopeFingerprint, SCOPE);
    assert.throws(() => s.event({ scopeFingerprint: 'b'.repeat(64), sample: sample(200) }), { code: 'ACCOUNT_SCOPE_CHANGED' });
    assert.throws(() => s.publish(report('b'.repeat(64))), { code: 'ACCOUNT_SCOPE_CHANGED' });
  } finally { s.close(); }
});
storageTest('a new process run never adds the prior run total again', (t) => {
  const root = temp(t), a = new ReportSink(root); a.event({ scopeFingerprint: SCOPE, sample: sample(100) }); const first = a.runDir; a.close();
  const b = new ReportSink(root); try { b.event({ scopeFingerprint: SCOPE, sample: sample(100) }); assert.notEqual(b.runDir, first); assert.equal(fs.readFileSync(path.join(first, 'events.ndjson'), 'utf8').trim().split('\n').length, 1); } finally { b.close(); }
});
storageTest('journal limits fail closed without deleting earlier evidence', (t) => {
  const s = new ReportSink(temp(t)); try { s.bytes = 128 * 1024 * 1024; assert.throws(() => s.event({ scopeFingerprint: SCOPE, sample: sample(100) }), { code: 'CAPTURE_STORAGE_LIMIT' }); } finally { s.close(); }
});
storageTest('symlink output directory and ambiguous process lock are refused', (t) => {
  const root = temp(t); const real = path.join(root, 'real'); fs.mkdirSync(real); const link = path.join(root, 'link'); fs.symlinkSync(real, link, 'dir');
  assert.throws(() => new ReportSink(link), { code: 'UNSAFE_AUTO_DIRECTORY' });
  fs.mkdirSync(path.join(real, 'process.lock')); assert.throws(() => new ReportSink(real), { code: 'AUTO_LOCK_NEEDS_REVIEW' });
});
test('automatic loop discovers, receives a counter and stops without starting any model', async () => {
  const controller = new AbortController(); const saved = [], states = [], calls = [];
  const connection = { scopeFingerprint: SCOPE, closed: false, async initialize() {}, assertIdentity() {}, renewLease() {}, async close() { this.closed = true; },
    async request(method, params) { calls.push(method); return { data: params.archived || params.sourceKinds ? [] : [{ id: ID, status: { type: 'active' }, createdAt: Date.now() / 1000 - 1000, updatedAt: Date.now() / 1000 }], nextCursor: null }; },
    async send(method, params) { calls.push(method); if (method === 'thread/resume') { const s = sample(100); this.eventSink({ method: 'thread/tokenUsage/updated', params: { threadId: ID, turnId: TURN, tokenUsage: { total: s.total, last: s.last } } }); } return { thread: { id: params.threadId }, status: 'unsubscribed' }; }
  };
  const sink = { event(e) { saved.push(e); }, publish(r) { states.push(r); if (r.scans >= 2) controller.abort(); }, close() {} };
  const end = await run({ maxListening: 4, maxPages: 1, intervalMs: 1, runMs: 3000 }, { controller, createConnection: () => connection, seedReferences: () => [], sink });
  assert.equal(end.state, 'stopped'); assert.equal(saved.length, 1); assert.equal(states.at(-1).listeningThreads, 0);
  assert.equal(states.at(-1).threads[0].total.totalTokens, 100); assert.equal(calls.filter((m) => m === 'thread/resume').length, 1);
  assert.ok(!calls.includes('turn/start')); assert.equal(connection.closed, true);
});
test('account scope switch pauses instead of following another account', async () => {
  const controller = new AbortController(); let connects = 0; const states = [];
  const create = () => {
    connects += 1; const index = connects;
    return { scopeFingerprint: index === 1 ? SCOPE : 'b'.repeat(64), closed: false, async initialize() {}, assertIdentity() {}, renewLease() {},
      async close() { this.closed = true; }, async request() { if (index === 1) throw Object.assign(new Error(), { code: 'CLOUD_CLOSED' }); return { data: [], nextCursor: null }; } };
  };
  const end = await run({ maxListening: 4, maxPages: 1, intervalMs: 1, runMs: 5000 }, { controller, createConnection: create, seedReferences: () => [], sink: { event() {}, publish(r) { states.push(r); }, close() {} } });
  assert.equal(end.fatal, 'ACCOUNT_SCOPE_CHANGED'); assert.equal(connects, 2); assert.equal(states.at(-1).scopeFingerprint, SCOPE);
});

// Exercise asynchronous storage failures and conservative stale-lock recovery.
const SCRIPT_ENTRY = path.resolve(__dirname, '../../scripts/codex-cloud-auto-watch.js');
function usageEvent(total = 150) {
  const usage = { inputTokens: total - 10, outputTokens: 10, totalTokens: total, cachedInputTokens: 0, reasoningOutputTokens: 0 };
  return { method: 'thread/tokenUsage/updated', params: { threadId: ID, turnId: TURN, tokenUsage: { total: usage, last: { ...usage } } } };
}
function idleConnection() {
  return { scopeFingerprint: SCOPE, closed: false, failure: null, eventSink: null, initializeCalls: 0,
    async initialize() { this.initializeCalls += 1; }, renewLease() {},
    assertIdentity() { if (this.closed) throw Object.assign(new Error(this.failure || 'CLOSED'), { code: this.failure || 'CLOSED' }); },
    async close() { if (!this.closed) { this.closed = true; this.failure = 'CLOSED'; } },
    async request(_method, params) { return { data: params.archived || params.sourceKinds ? [] : [{ id: ID, status: { type: 'active' }, createdAt: Date.now() / 1000 - 1000, updatedAt: Date.now() / 1000 }], nextCursor: null }; },
    async send(method, params) { return method === 'thread/resume' ? { thread: { id: params.threadId } } : { status: 'unsubscribed' }; },
    fail(code) { if (this.closed) return; this.closed = true; this.failure = code; },
    deliver(event) { try { this.eventSink(event); } catch (e) { this.fail((e && e.code) || 'CLOUD_READ_FAILED'); } } };
}
function collect(child) {
  const out = [], err = [];
  child.stdout.on('data', (d) => out.push(d)); child.stderr.on('data', (d) => err.push(d));
  return { stdout: () => Buffer.concat(out).toString(), stderr: () => Buffer.concat(err).toString(),
    done: new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }))) };
}
function lockFolder(root) { return path.join(root, 'process.lock'); }
function writeLockRaw(root, raw) { const folder = lockFolder(root); fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(folder, 'owner.json'), raw); }
function writeLockRecord(root, record) { writeLockRaw(root, JSON.stringify(record) + '\n'); }
function readLockRaw(root) { return fs.readFileSync(path.join(lockFolder(root), 'owner.json'), 'utf8'); }
function readLockRecord(root) { return JSON.parse(readLockRaw(root)); }
function crashedOwner(started, timeout = 15000, t) {
  const child = t ? spawn(process.execPath, ['-e', started], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawnSync(process.execPath, ['-e', started], { encoding: 'utf8', timeout });
  if (t) t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
  return child;
}

for (const code of ['CAPTURE_STORAGE_LIMIT', 'CAPTURE_WRITE_FAILED', 'ACCOUNT_SCOPE_CHANGED']) {
  test(`an asynchronous ${code} during the main-loop sleep is recorded, stops and never reconnects`, async () => {
    const controller = new AbortController(); let connects = 0; let fired = false; let first = null;
    const sink = { events: [], states: [], armed: false,
      event(e) { if (this.armed) throw Object.assign(new Error(code), { code }); this.events.push(e); },
      publish(r) { this.states.push(r); if (r.scans >= 2) controller.abort(); if (!fired && r.state === 'listening') { fired = true; this.armed = true; setTimeout(() => first.deliver(usageEvent()), 10); } },
      close() {} };
    const create = () => { connects += 1; const c = idleConnection(); if (!first) first = c; return c; };
    const end = await run({ maxListening: 4, maxPages: 1, intervalMs: 80, runMs: 4000 }, { controller, createConnection: create, seedReferences: () => [], sink });
    assert.equal(end.fatal, code);
    assert.equal(connects, 1, 'a fatal capture failure must never reconnect');
    assert.equal(first.closed, true); assert.equal(first.failure, code);
    assert.equal(end.state, 'paused-' + code.toLowerCase());
    assert.equal(sink.states.at(-1).state, 'paused-' + code.toLowerCase());
    assert.ok(sink.states.at(-1).diagnostics.some((d) => d.code === code));
  });
}
storageTest('journal and report evidence survive an asynchronous capture stop', async (t) => {
  const controller = new AbortController(); const root = temp(t); const sink = new ReportSink(root);
  sink.event({ scopeFingerprint: SCOPE, connectionNumber: 1, sample: sample(100) });
  const journal = path.join(sink.runDir, 'events.ndjson'); const before = fs.readFileSync(journal, 'utf8');
  const write = sink.event.bind(sink); const publish = sink.publish.bind(sink);
  let fired = false; let first = null; let connects = 0;
  sink.event = (e) => { if (sink.armed) throw Object.assign(new Error('limit'), { code: 'CAPTURE_STORAGE_LIMIT' }); write(e); };
  sink.publish = (r) => { publish(r); if (r.scans >= 2) controller.abort(); if (!fired && r.state === 'listening') { fired = true; sink.armed = true; setTimeout(() => first.deliver(usageEvent()), 10); } };
  const create = () => { connects += 1; const c = idleConnection(); if (!first) first = c; return c; };
  const end = await run({ maxListening: 4, maxPages: 1, intervalMs: 60, runMs: 3000 }, { controller, createConnection: create, seedReferences: () => [], sink });
  assert.equal(end.fatal, 'CAPTURE_STORAGE_LIMIT'); assert.equal(connects, 1);
  assert.equal(fs.readFileSync(journal, 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8')).state, 'paused-capture_storage_limit');
  sink.armed = false;
  assert.throws(() => sink.event({ scopeFingerprint: SCOPE, sample: sample(2) }), { code: 'CAPTURE_STORE_CLOSED' });
});
test('a non-fatal asynchronous disconnect still reconnects and keeps the run alive', async () => {
  const controller = new AbortController(); let connects = 0; let fired = false; let first = null;
  const sink = { event() {}, publish(r) { if (!fired && r.state === 'listening') { fired = true; setTimeout(() => first.fail('CLOUD_CLOSED'), 10); } if (r.scans >= 3) controller.abort(); }, close() {} };
  const create = () => { connects += 1; const c = idleConnection(); if (!first) first = c; return c; };
  const end = await run({ maxListening: 4, maxPages: 1, intervalMs: 40, runMs: 4000 }, { controller, createConnection: create, seedReferences: () => [], sink });
  assert.equal(connects, 2); assert.equal(end.fatal, null); assert.equal(end.state, 'stopped');
});

test('linux process start-time parsing is bounded and rejects malformed stat data', () => {
  const tail = Array.from({ length: 50 }, (_, i) => String(i)); tail[0] = 'R'; tail[19] = '987654321';
  const stat = '4242 (node (weird) name) ' + tail.join(' ') + '\n';
  assert.deepEqual(identityFromProcStat(stat, '00000000-0000-0000-0000-000000000000'), { method: 'linux-proc-starttime-v1', value: '00000000-0000-0000-0000-000000000000:987654321' });
  assert.equal(identityFromProcStat('', 'boot'), null); assert.equal(identityFromProcStat('4242 R 1', 'boot'), null);
  assert.equal(identityFromProcStat(stat, 'not a boot id'), null);
});
const OS_IDENTITY = POSIX && typeof identityOf === 'function' && identityOf(process.pid) !== null;
function probeStub(pid, value) { return (target) => target === pid ? { method: 'linux-proc-starttime-v1', value } : (typeof identityOf === 'function' ? identityOf(target) : null); }
test('process identity is stable for a live process and null once it is gone', { skip: OS_IDENTITY ? false : 'OS process identity probe unavailable in this environment', timeout: 20000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', `const { identityOf } = require(${JSON.stringify(SCRIPT_ENTRY)}); process.stdout.write(JSON.stringify(identityOf(process.pid)) + '\\n'); setTimeout(() => {}, 8000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
  const reported = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process identity probe timed out')), 5000);
    let buf = ''; child.stdout.on('data', (d) => { buf += d; const line = buf.split('\n')[0]; if (line) { clearTimeout(timer); resolve(JSON.parse(line)); } });
  });
  assert.deepEqual(identityOf(child.pid), reported);
  assert.equal(typeof reported.value, 'string'); assert.ok(reported.value.length > 0);
  const gone = spawnSync(process.execPath, ['-e', '']);
  try { process.kill(gone.pid, 0); } catch (_) { assert.equal(identityOf(gone.pid), null); }
});
storageTest('an unavailable OS identity probe fails closed instead of guessing ownership', { timeout: 20000 }, async (t) => {
  if (OS_IDENTITY) { t.skip('OS identity probe is available here'); return; }
  const child = crashedOwner('setTimeout(() => {}, 8000);', 15000, t); const root = temp(t);
  const record = { pid: child.pid, nonce: randomUUID(), identity: { method: 'darwin-ps-lstart-v1', value: 'Thu Jan  1 00:00:00 1970' } };
  writeLockRecord(root, record);
  assert.throws(() => lock(root), { code: 'AUTO_LOCK_NEEDS_REVIEW' });
  assert.deepEqual(readLockRecord(root), record);
});
storageTest('a live owner whose recorded identity matches the live probe blocks a second monitor', { timeout: 20000 }, async (t) => {
  const child = crashedOwner('setTimeout(() => {}, 8000);', 15000, t); const root = temp(t);
  const record = { pid: child.pid, nonce: randomUUID(), identity: { method: 'linux-proc-starttime-v1', value: '00000000-0000-0000-0000-000000000000:1' } };
  writeLockRecord(root, record);
  assert.throws(() => lock(root, probeStub(child.pid, '00000000-0000-0000-0000-000000000000:1')), { code: 'AUTO_MONITOR_ALREADY_RUNNING' });
  assert.deepEqual(readLockRecord(root), record);
});
storageTest('a live reused pid whose recorded identity does not match is reclaimed as stale', { timeout: 20000 }, async (t) => {
  const child = crashedOwner('setTimeout(() => {}, 8000);', 15000, t); const root = temp(t);
  writeLockRecord(root, { pid: child.pid, nonce: randomUUID(), identity: { method: 'linux-proc-starttime-v1', value: '00000000-0000-0000-0000-000000000000:1' } });
  const unlock = lock(root, probeStub(child.pid, '00000000-0000-0000-0000-000000000000:2'));
  assert.equal(readLockRecord(root).pid, process.pid);
  unlock(); assert.ok(!fs.existsSync(lockFolder(root)));
});
test('the real OS probe blocks a matching live instance and reclaims a mismatched one', { skip: OS_IDENTITY ? false : 'OS process identity probe unavailable in this environment', timeout: 20000 }, async (t) => {
  const child = crashedOwner('setTimeout(() => {}, 8000);', 15000, t); const root = temp(t);
  const real = identityOf(child.pid); assert.ok(real);
  const matching = { pid: child.pid, nonce: randomUUID(), identity: real };
  writeLockRecord(root, matching);
  assert.throws(() => lock(root), { code: 'AUTO_MONITOR_ALREADY_RUNNING' });
  assert.deepEqual(readLockRecord(root), matching);
  writeLockRecord(root, { ...matching, nonce: randomUUID(), identity: { method: real.method, value: real.method === 'linux-proc-starttime-v1' ? '00000000-0000-0000-0000-000000000000:1' : 'Mon Jan 1 00:00:00 1900' } });
  const unlock = lock(root); assert.equal(readLockRecord(root).pid, process.pid); unlock();
});
storageTest('a malformed or missing identity fails closed without deleting the lock', { timeout: 20000 }, async (t) => {
  const child = crashedOwner('setTimeout(() => {}, 8000);', 15000, t); const root = temp(t);
  const malformed = JSON.stringify({ pid: child.pid, nonce: randomUUID(), identity: { method: 'bad method!', value: 7 } }) + '\n';
  writeLockRaw(root, malformed);
  assert.throws(() => lock(root), { code: 'AUTO_LOCK_NEEDS_REVIEW' });
  assert.equal(readLockRaw(root), malformed);
  const missing = JSON.stringify({ pid: child.pid, nonce: randomUUID() }) + '\n';
  writeLockRaw(root, missing);
  assert.throws(() => lock(root), { code: 'AUTO_LOCK_NEEDS_REVIEW' });
  assert.equal(readLockRaw(root), missing);
});
storageTest('a symlinked owner record is refused and left untouched', (t) => {
  const root = temp(t); const folder = lockFolder(root); fs.mkdirSync(folder);
  const victim = path.join(root, 'victim.json');
  fs.writeFileSync(victim, JSON.stringify({ pid: process.pid, nonce: randomUUID(), identity: identityOf(process.pid) }) + '\n');
  fs.symlinkSync(victim, path.join(folder, 'owner.json'), 'file');
  assert.throws(() => lock(root), { code: 'AUTO_LOCK_NEEDS_REVIEW' });
  assert.ok(fs.lstatSync(path.join(folder, 'owner.json')).isSymbolicLink()); assert.ok(fs.existsSync(victim));
});
test('a symlinked lock folder is refused', (t) => {
  const root = temp(t); fs.mkdirSync(path.join(root, 'actual'));
  fs.symlinkSync(path.join(root, 'actual'), lockFolder(root), 'dir');
  assert.throws(() => lock(root), { code: 'UNSAFE_AUTO_LOCK' });
});
storageTest('a lock folder with foreign files is never auto-deleted', (t) => {
  const root = temp(t); writeLockRecord(root, { pid: 2147483646, nonce: randomUUID(), identity: null });
  fs.writeFileSync(path.join(lockFolder(root), 'extra.txt'), 'keep');
  assert.throws(() => lock(root), { code: 'AUTO_LOCK_NEEDS_REVIEW' });
  assert.equal(fs.readFileSync(path.join(lockFolder(root), 'extra.txt'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(lockFolder(root), 'owner.json')));
});
storageTest('a lock left by a crashed owner is reclaimed', (t) => {
  const root = temp(t);
  const holder = spawnSync(process.execPath, ['-e', `const { lock } = require(${JSON.stringify(SCRIPT_ENTRY)}); lock(${JSON.stringify(root)});`], { encoding: 'utf8' });
  assert.equal(holder.status, 0, holder.stderr);
  assert.ok(fs.existsSync(path.join(lockFolder(root), 'owner.json')));
  const unlock = lock(root); assert.equal(readLockRecord(root).pid, process.pid);
  unlock(); assert.ok(!fs.existsSync(lockFolder(root)));
});
storageTest('release never removes a newer generation or a substituted record', (t) => {
  const root = temp(t); const unlock = lock(root);
  const ours = readLockRecord(root);
  const takeover = { pid: ours.pid, nonce: randomUUID(), identity: ours.identity };
  writeLockRecord(root, takeover); unlock();
  assert.deepEqual(readLockRecord(root), takeover);
  const pidChanged = { ...takeover, pid: takeover.pid + 1 };
  writeLockRecord(root, pidChanged); unlock();
  assert.deepEqual(readLockRecord(root), pidChanged);
  const target = path.join(lockFolder(root), 'owner.json');
  const copy = path.join(root, 'copy.json'); fs.writeFileSync(copy, JSON.stringify(pidChanged) + '\n');
  fs.unlinkSync(target); fs.symlinkSync(copy, target, 'file'); unlock();
  assert.ok(fs.lstatSync(target).isSymbolicLink());
  assert.equal(fs.readFileSync(copy, 'utf8'), JSON.stringify(pidChanged) + '\n');
});
storageTest('two real startup processes contending a stale lock: exactly one owns it', { timeout: 30000 }, async (t) => {
  const root = temp(t);
  const holder = spawnSync(process.execPath, ['-e', `const { lock } = require(${JSON.stringify(SCRIPT_ENTRY)}); lock(${JSON.stringify(root)});`], { encoding: 'utf8' });
  assert.equal(holder.status, 0, holder.stderr);
  const go = path.join(root, 'go');
  const code = `const fs = require('node:fs'); const { lock } = require(${JSON.stringify(SCRIPT_ENTRY)});
const root = ${JSON.stringify(root)}, go = ${JSON.stringify(go)};
const until = Date.now() + 15000;
process.stdout.write('WAIT\\n');
while (!fs.existsSync(go)) { if (Date.now() > until) process.exit(3); }
try { const unlock = lock(root); process.stdout.write('ACQUIRED\\n'); setTimeout(() => { unlock(); process.exit(0); }, 1200); setTimeout(() => process.exit(0), 20000); }
catch (e) { process.stdout.write('BUSY:' + ((e && e.code) || 'UNKNOWN') + '\\n'); process.exit(0); }`;
  const children = [spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] }), spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })];
  t.after(() => { for (const child of children) { try { child.kill('SIGKILL'); } catch (_) {} } });
  const runs = children.map(collect);
  await Promise.all(runs.map((r) => new Promise((resolve) => { const timer = setInterval(() => { if (r.stdout().includes('WAIT')) { clearInterval(timer); resolve(); } }, 5); })));
  fs.writeFileSync(go, '');
  const results = await Promise.all(runs.map((r) => r.done));
  const acquired = results.filter((r) => r.stdout.includes('ACQUIRED'));
  const busy = results.filter((r) => r.stdout.includes('BUSY:'));
  assert.equal(acquired.length, 1, JSON.stringify(results));
  assert.equal(busy.length, 1, JSON.stringify(results));
  assert.match(busy[0].stdout, /BUSY:AUTO_(MONITOR_ALREADY_RUNNING|LOCK_NEEDS_REVIEW)/);
});

storageTest('another startup cannot claim while stale identity inspection is in progress', (t) => {
  const root = temp(t);
  const real = identityOf(process.pid);
  const identity = real?.method === 'darwin-ps-lstart-v1'
    ? { method: real.method, value: 'Mon Jan 1 00:00:00 1900' }
    : { method: 'linux-proc-starttime-v1', value: '00000000-0000-0000-0000-000000000000:1' };
  writeLockRecord(root, { pid: process.pid, nonce: randomUUID(), identity });
  const before = readLockRaw(root); let checked = false;
  const unlock = lock(root, () => {
    if (!checked) {
      checked = true;
      const contender = spawnSync(process.execPath, ['-e', `const { lock } = require(${JSON.stringify(SCRIPT_ENTRY)}); try { lock(${JSON.stringify(root)}); console.log('ACQUIRED'); } catch (e) { console.log(e.code); }`], { encoding: 'utf8', timeout: 5000 });
      assert.equal(contender.status, 0, contender.stderr);
      assert.equal(contender.stdout.trim(), 'AUTO_LOCK_NEEDS_REVIEW');
      assert.equal(readLockRaw(root), before);
    }
    return real || { method: identity.method, value: '00000000-0000-0000-0000-000000000000:2' };
  });
  assert.ok(checked); assert.equal(readLockRecord(root).pid, process.pid); unlock();
});
storageTest('an abandoned operation guard is preserved and requires review', (t) => {
  const root = temp(t), guard = path.join(root, 'process.lock.guard');
  fs.writeFileSync(guard, 'unknown owner', { mode: 0o600 });
  assert.throws(() => lock(root), { code: 'AUTO_LOCK_NEEDS_REVIEW' });
  assert.equal(fs.readFileSync(guard, 'utf8'), 'unknown owner');
  assert.ok(!fs.existsSync(lockFolder(root)));
});
storageTest('identity methods and malformed values never authorize reclaim', (t) => {
  const root = temp(t);
  for (const identity of [{ method: 'unknown-v1', value: 'abc' }, { method: 'linux-proc-starttime-v1', value: ':123' }, { method: 'darwin-ps-lstart-v1', value: 'bad' }]) {
    writeLockRecord(root, { pid: process.pid, nonce: randomUUID(), identity }); const before = readLockRaw(root);
    assert.throws(() => lock(root), { code: 'AUTO_LOCK_NEEDS_REVIEW' }); assert.equal(readLockRaw(root), before);
  }
});
storageTest('untrusted writable lock directories and hardlinked owner files are preserved', (t) => {
  const root = temp(t); writeLockRecord(root, { pid: process.pid, nonce: randomUUID(), identity: null });
  fs.chmodSync(lockFolder(root), 0o777);
  assert.throws(() => lock(root), { code: 'UNSAFE_AUTO_LOCK' }); fs.chmodSync(lockFolder(root), 0o700);
  fs.linkSync(path.join(lockFolder(root), 'owner.json'), path.join(root, 'owner-copy'));
  assert.throws(() => lock(root), { code: 'AUTO_LOCK_NEEDS_REVIEW' }); assert.ok(fs.existsSync(path.join(root, 'owner-copy')));
});
test('stored fatal wins over simultaneous shutdown and final report failure', async () => {
  const controller = new AbortController(); const conn = idleConnection(); let fired = false, closed = false;
  const sink = { event() {}, publish(r) {
    if (r.state.startsWith('paused-')) throw Object.assign(new Error(), { code: 'CAPTURE_WRITE_FAILED' });
    if (!fired && r.state === 'listening') { fired = true; setTimeout(() => { conn.fail('CAPTURE_STORAGE_LIMIT'); controller.abort(); }, 10); }
  }, close() { closed = true; } };
  const end = await run({ maxListening: 4, maxPages: 1, intervalMs: 80, runMs: 2000 }, { controller, createConnection: () => conn, seedReferences: () => [], sink });
  assert.equal(end.fatal, 'CAPTURE_STORAGE_LIMIT'); assert.equal(end.reportError, 'CAPTURE_WRITE_FAILED'); assert.ok(closed);
});
test('cleanup failures cannot hide the original storage fatal or skip sink cleanup', async () => {
  const conn = idleConnection(); let fired = false, sinkClosed = false; const states = [];
  conn.close = async () => { throw Object.assign(new Error(), { code: 'SOCKET_CLOSE_FAILED' }); };
  const sink = { event() {}, publish(r) { states.push(r); if (!fired && r.state === 'listening') { fired = true; setTimeout(() => conn.fail('CAPTURE_STORAGE_LIMIT'), 10); } },
    close() { sinkClosed = true; throw Object.assign(new Error(), { code: 'STORE_CLOSE_FAILED' }); } };
  const end = await run({ maxListening: 4, maxPages: 1, intervalMs: 40, runMs: 2000 }, { createConnection: () => conn, seedReferences: () => [], sink });
  assert.equal(end.fatal, 'CAPTURE_STORAGE_LIMIT'); assert.equal(end.cleanupError, 'SOCKET_CLOSE_FAILED');
  assert.equal(states.at(-1).state, 'paused-capture_storage_limit'); assert.ok(sinkClosed);
});
storageTest('a failed journal descriptor close still releases our lock', (t) => {
  const root = temp(t), sink = new ReportSink(root); const close = fs.closeSync;
  try {
    fs.closeSync = (fd) => { if (fd === sink.fd) throw new Error('close fixture'); return close(fd); };
    assert.throws(() => sink.close(), /close fixture/);
    assert.ok(!fs.existsSync(lockFolder(root)));
  } finally { fs.closeSync = close; close(sink.fd); }
});
storageTest('a contender cannot replace the inspected stale lock before owner removal', { timeout: 15000 }, (t) => {
  const root = temp(t), ready = path.join(root, 'contender-result');
  writeLockRecord(root, { pid: 2147483646, nonce: randomUUID(), identity: null });
  const unlink = fs.unlinkSync; let contender, entered = false;
  try {
    fs.unlinkSync = (file) => {
      if (!entered && file === path.join(lockFolder(root), 'owner.json')) {
        entered = true;
        contender = spawn(process.execPath, ['-e', `const fs = require('node:fs'); const { lock } = require(${JSON.stringify(SCRIPT_ENTRY)});
try { lock(${JSON.stringify(root)}); fs.writeFileSync(${JSON.stringify(ready)}, 'ACQUIRED'); setTimeout(() => {}, 10000); }
catch (e) { fs.writeFileSync(${JSON.stringify(ready)}, 'BUSY:' + e.code); }`], { stdio: 'ignore' });
        t.after(() => { try { contender.kill('SIGKILL'); } catch (_) {} });
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        assert.ok(fs.existsSync(ready), 'contender must reach its claim attempt');
      }
      return unlink(file);
    };
    const unlock = lock(root);
    assert.ok(entered);
    assert.equal(fs.readFileSync(ready, 'utf8'), 'BUSY:AUTO_LOCK_NEEDS_REVIEW');
    unlock();
  } finally { fs.unlinkSync = unlink; }
});
