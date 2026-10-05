'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { options, ReportSink, run } = require('../../scripts/codex-cloud-auto-watch');
const ID = '01900000-0000-7000-8000-000000000001', TURN = '01900000-0000-7000-8000-000000000002', SCOPE = 'a'.repeat(64);
function temp(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-auto-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function sample(n) { const usage = { inputTokens: n - 10, outputTokens: 10, totalTokens: n, cachedInputTokens: 0, reasoningOutputTokens: 0 }; return { threadId: ID, turnId: TURN, total: usage, last: { ...usage }, observedAt: new Date().toISOString() }; }
function report(scope = SCOPE) { return { kind: 'codex-cloud-auto-watch', scopeFingerprint: scope, state: 'listening', observedAt: new Date().toISOString(), knownThreads: 0, listeningThreads: 0, measuredThreads: 0, waitingForSlot: 0, threads: [], diagnostics: [] }; }
test('help and missing consent never load credentials or connect', () => {
  const entry = path.resolve(__dirname, '../../scripts/codex-cloud-auto-watch.js');
  const h = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: '/nonexistent' } });
  assert.equal(h.status, 0); assert.ok(h.stdout.includes('No manual thread IDs'));
  assert.throws(() => options([]), { code: 'AUTO_ATTACH_CONSENT_REQUIRED' });
  for (const args of [['--interval', '1'], ['--max-listening', '129'], ['--seconds', '0'], ['--pages', '100']]) assert.throws(() => options(['--acknowledge-auto-attach', ...args]));
});
test('one directory cannot have duplicate active monitors', (t) => {
  const root = temp(t); const a = new ReportSink(root);
  try { assert.throws(() => new ReportSink(root), { code: 'AUTO_MONITOR_ALREADY_RUNNING' }); }
  finally { a.close(); }
  const b = new ReportSink(root); b.close(); assert.ok(!fs.existsSync(path.join(root, 'process.lock')));
});
test('numeric event journal and snapshots use private files and preserve scope', (t) => {
  const s = new ReportSink(temp(t));
  try {
    s.event({ scopeFingerprint: SCOPE, connectionNumber: 1, sample: sample(100) }); s.publish(report());
    assert.equal(fs.statSync(path.join(s.runDir, 'events.ndjson')).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, 'report.json'))).scopeFingerprint, SCOPE);
    assert.throws(() => s.event({ scopeFingerprint: 'b'.repeat(64), sample: sample(200) }), { code: 'ACCOUNT_SCOPE_CHANGED' });
    assert.throws(() => s.publish(report('b'.repeat(64))), { code: 'ACCOUNT_SCOPE_CHANGED' });
  } finally { s.close(); }
});
test('a new process run never adds the prior run total again', (t) => {
  const root = temp(t), a = new ReportSink(root); a.event({ scopeFingerprint: SCOPE, sample: sample(100) }); const first = a.runDir; a.close();
  const b = new ReportSink(root); try { b.event({ scopeFingerprint: SCOPE, sample: sample(100) }); assert.notEqual(b.runDir, first); assert.equal(fs.readFileSync(path.join(first, 'events.ndjson'), 'utf8').trim().split('\n').length, 1); } finally { b.close(); }
});
test('journal limits fail closed without deleting earlier evidence', (t) => {
  const s = new ReportSink(temp(t)); try { s.bytes = 128 * 1024 * 1024; assert.throws(() => s.event({ scopeFingerprint: SCOPE, sample: sample(100) }), { code: 'CAPTURE_STORAGE_LIMIT' }); } finally { s.close(); }
});
test('symlink output directory and ambiguous process lock are refused', (t) => {
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
