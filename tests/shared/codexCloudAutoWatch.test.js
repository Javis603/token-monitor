'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoCloudMonitor, AutoCloudConnection, renderAutoHtml } = require('../../src/shared/providers/codex/cloudAutoWatch');
const { CloudTransport } = require('../../src/shared/providers/codex/cloudTransport');
const ID = (n) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SCOPE = 'a'.repeat(64), NOW = 1791169200000;
const row = (n, type = 'active', extra = {}) => ({ id: ID(n), source: null, status: { type }, createdAt: NOW / 1000 - 500, updatedAt: NOW / 1000, ...extra });
const tokens = (n) => ({ inputTokens: n - 10, outputTokens: 10, totalTokens: n, cachedInputTokens: 0, reasoningOutputTokens: 0 });
const event = (id, n) => ({ method: 'thread/tokenUsage/updated', params: { threadId: id, turnId: ID(99), tokenUsage: { total: tokens(n), last: tokens(30) } } });
function rpc(initial = []) {
  return { scopeFingerprint: SCOPE, closed: false, rows: initial, calls: [], assertIdentity() {}, renewLease() {},
    async request(method, params) { this.calls.push({ method, params }); return { data: params.archived || params.sourceKinds ? [] : this.rows, nextCursor: null }; },
    async send(method, params) { this.calls.push({ method, params }); if (method === 'thread/resume') return { thread: { id: params.threadId } }; return { status: 'unsubscribed' }; }
  };
}
test('unfiltered null-source active threads are discovered and attached automatically', async () => {
  const r = rpc([row(1), row(2, 'idle'), row(3, 'notLoaded')]); const m = new AutoCloudMonitor({ now: () => NOW });
  m.connect(r); const report = await m.cycle();
  assert.equal(report.knownThreads, 3); assert.equal(report.listeningThreads, 1); assert.equal(report.scans, 1);
  assert.deepEqual(r.calls.filter((c) => c.method === 'thread/resume').map((c) => c.params), [{ threadId: ID(1), excludeTurns: true }]);
  assert.ok(r.calls.some((c) => c.params.sourceKinds));
});
test('recent warm tasks can be observed before their first turn; cold history is not loaded', async () => {
  const r = rpc([row(1, 'idle', { createdAt: NOW / 1000 - 5 }), row(2, 'notLoaded', { createdAt: NOW / 1000 - 5 })]);
  const m = new AutoCloudMonitor({ now: () => NOW }); m.connect(r); await m.cycle();
  assert.deepEqual([...m.listening], [ID(1)]);
});
test('new task discovered on a later scan needs no supplied ID', async () => {
  const r = rpc([row(1, 'idle')]); const m = new AutoCloudMonitor({ now: () => NOW }); m.connect(r); await m.cycle();
  r.rows.push(row(4, 'active', { threadSource: 'subagent', parentThreadId: ID(1) })); await m.cycle();
  assert.ok(m.listening.has(ID(4))); assert.equal(m.report().threads.find((t) => t.threadId === ID(4)).engineParentId, ID(1));
});
test('repeated discovery does not repeatedly resume already-listened threads', async () => {
  const r = rpc([row(1)]), m = new AutoCloudMonitor({ now: () => NOW }); m.connect(r);
  await m.cycle(); await m.cycle(); await m.cycle();
  assert.equal(r.calls.filter((c) => c.method === 'thread/resume').length, 1);
});
test('settled cumulative snapshots are replaced and exact duplicates are not persisted twice', async () => {
  const saved = []; const r = rpc([row(1)]), m = new AutoCloudMonitor({ now: () => NOW, onSample: (s) => saved.push(s) });
  m.connect(r); await m.cycle(); r.eventSink(event(ID(1), 100)); r.eventSink(event(ID(1), 200)); r.eventSink(event(ID(1), 200));
  assert.equal(saved.length, 2); assert.equal(m.report().threads[0].total.totalTokens, 200); assert.equal(m.report().taskTotalTokens, null);
});
test('reconnection reattaches automatically while retaining counters without adding snapshots', async () => {
  const m = new AutoCloudMonitor({ now: () => NOW }), a = rpc([row(1)]); m.connect(a); await m.cycle(); a.eventSink(event(ID(1), 100));
  m.disconnect(); const b = rpc([row(1)]); m.connect(b); await m.cycle(); b.eventSink(event(ID(1), 100)); b.eventSink(event(ID(1), 200));
  const t = m.report().threads[0]; assert.equal(t.total.totalTokens, 200); assert.equal(t.gapCount, 1); assert.equal(t.attachAttempts, 2);
});
test('different account scope is refused rather than combined', () => {
  const m = new AutoCloudMonitor(); m.connect(rpc()); m.disconnect(); const b = rpc(); b.scopeFingerprint = 'b'.repeat(64);
  assert.throws(() => m.connect(b), { code: 'ACCOUNT_SCOPE_CHANGED' });
});
test('unrelated text and unsolicited thread usage never enter numeric report', async () => {
  const m = new AutoCloudMonitor({ now: () => NOW }), r = rpc([row(1)]); m.connect(r); await m.cycle();
  r.eventSink({ method: 'item/agentMessage/delta', params: { threadId: ID(1), delta: 'PRIVATE_BODY' } });
  r.eventSink(event(ID(8), 300)); assert.equal(m.report().measuredThreads, 0); assert.ok(!JSON.stringify(m.report()).includes('PRIVATE_BODY'));
});
test('identity is checked before any valid token is passed to persistence', async () => {
  const saved = []; const m = new AutoCloudMonitor({ now: () => NOW, onSample: (s) => saved.push(s) }), r = rpc([row(1)]);
  m.connect(r); await m.cycle(); r.assertIdentity = () => { throw Object.assign(new Error('changed'), { code: 'LOGIN_CHANGED' }); };
  assert.throws(() => r.eventSink(event(ID(1), 100)), { code: 'LOGIN_CHANGED' }); assert.equal(saved.length, 0);
});
test('listening capacity and retry delay are enforced', async () => {
  const m = new AutoCloudMonitor({ now: () => NOW, maxListening: 1 }), r = rpc([row(1), row(2)]); m.connect(r); await m.cycle();
  assert.equal(m.listening.size, 1); assert.equal(m.report().waitingForSlot, 1);
  const x = new AutoCloudMonitor({ now: () => NOW }), failing = rpc([row(3)]); let attempts = 0;
  failing.send = async () => { attempts += 1; throw Object.assign(new Error(), { code: 'RPC_TIMEOUT' }); };
  x.connect(failing); await x.cycle(); await x.cycle(); assert.equal(attempts, 1);
});
test('idle grace retains tail usage then detaches the viewer only', async () => {
  let time = NOW; const m = new AutoCloudMonitor({ now: () => time, idleGraceMs: 1000 }), r = rpc([row(1)]);
  m.connect(r); await m.cycle(); r.rows[0].status.type = 'idle'; time += 500; await m.cycle(); assert.equal(m.listening.size, 1);
  time += 1000; await m.cycle(); assert.equal(m.listening.size, 0); assert.ok(r.calls.some((c) => c.method === 'thread/unsubscribe'));
  assert.ok(!r.calls.some((c) => ['turn/start', 'turn/interrupt', 'thread/stop', 'thread/archive'].includes(c.method)));
});
test('unsupported unsubscribe requests connection recycle, not a task stop', async () => {
  let time = NOW; const r = rpc([row(1)]), m = new AutoCloudMonitor({ now: () => time, idleGraceMs: 0 }); m.connect(r); await m.cycle();
  r.rows[0].status.type = 'idle'; r.send = async () => { throw new Error('not supported'); }; time += 1; await m.cycle(); assert.equal(m.recycle, true);
});
test('filtered sources and archived active tasks are unioned with default catalog', async () => {
  const r = rpc(); r.request = async (_method, p) => ({ data: p.archived ? [row(3)] : p.sourceKinds ? [row(2)] : [row(1)], nextCursor: null });
  const m = new AutoCloudMonitor({ now: () => NOW }); m.connect(r); await m.cycle({ includeArchived: true }); assert.equal(m.listening.size, 3);
});
test('repeated cursors remain incomplete and bounded', async () => {
  const r = rpc(); let count = 0; r.request = async () => { count += 1; return { data: [row(1)], nextCursor: 'same' }; };
  const m = new AutoCloudMonitor({ now: () => NOW }); m.connect(r); await m.cycle();
  assert.equal(m.discoveryComplete, false); assert.ok(count <= 4); assert.ok(m.diagnostics.some((d) => d.code === 'REPEATED_DISCOVERY_CURSOR'));
});
test('overlapping polls cannot create duplicate watchers', async () => {
  let release; const r = rpc(); r.request = () => new Promise((resolve) => { release = resolve; });
  const m = new AutoCloudMonitor(); m.connect(r); const work = m.cycle();
  await assert.rejects(m.cycle(), { code: 'OVERLAPPING_AUTO_SCAN' });
  release({ data: [], nextCursor: null }); await new Promise((resolve) => setImmediate(resolve)); release({ data: [], nextCursor: null }); await work;
});
test('token arriving before resume response is not lost', async () => {
  const r = rpc([row(1)]), m = new AutoCloudMonitor({ now: () => NOW }); r.send = async (_method, p) => { r.eventSink(event(p.threadId, 100)); return { thread: { id: p.threadId } }; };
  m.connect(r); await m.cycle(); assert.equal(m.report().threads[0].total.totalTokens, 100);
});
test('automatic transport rejects model/task mutation and configuration override', async () => {
  const x = Object.create(AutoCloudConnection.prototype);
  for (const method of ['turn/start', 'thread/start', 'thread/stop', 'thread/archive', 'turn/interrupt']) await assert.rejects(x.send(method, {}), { code: 'AUTO_WRITE_DENIED' });
  await assert.rejects(x.send('thread/resume', { threadId: ID(1), excludeTurns: false }), { code: 'AUTO_OVERRIDE_DENIED' });
  await assert.rejects(x.send('thread/resume', { threadId: ID(1), excludeTurns: true, model: 'wrong' }), { code: 'AUTO_OVERRIDE_DENIED' });
  assert.ok(AutoCloudConnection.prototype instanceof CloudTransport);
});
test('numeric and scope limits reject invalid configuration', () => {
  assert.throws(() => new AutoCloudMonitor({ maxListening: 0 })); assert.throws(() => new AutoCloudMonitor({ maxPages: 99 }));
  const m = new AutoCloudMonitor(); assert.throws(() => m.connect({ scopeFingerprint: 'unverified' }), { code: 'MISSING_ACCOUNT_SCOPE' });
});
test('HTML escapes metadata, advertises unknown coverage, and never includes a summed total', async () => {
  const m = new AutoCloudMonitor({ now: () => NOW }), r = rpc([row(1)]); m.connect(r); await m.cycle(); const report = m.report();
  report.threads[0].kind = '<script>bad</script>'; const html = renderAutoHtml(report);
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('未知不为零')); assert.ok(html.includes("default-src 'none'"));
});

test('temporary seed omission does not erase a verified delegation edge', async () => {
  const m = new AutoCloudMonitor({ now: () => NOW }), r = rpc([row(1)]); m.connect(r);
  await m.cycle({ seedReferences: [{ threadId: ID(1), delegationParentId: ID(2), bindingEvidence: 'cache-account-and-user-matched' }] });
  await m.cycle(); assert.equal(m.report().threads[0].delegationParentId, ID(2));
});
test('both catalog reads failing causes a reconnect, not a successful heartbeat', async () => {
  const m = new AutoCloudMonitor({ now: () => NOW }), r = rpc(); r.request = async () => { throw Object.assign(new Error(), { code: 'CLOUD_RPC_ERROR' }); };
  m.connect(r); await assert.rejects(m.cycle(), { code: 'DISCOVERY_UNAVAILABLE' }); assert.equal(m.scans, 0);
});
test('reconnect requires fresh active evidence instead of reattaching disappeared rows', async () => {
  const m = new AutoCloudMonitor({ now: () => NOW }), a = rpc([row(1)]); m.connect(a); await m.cycle();
  m.disconnect(); const b = rpc([]); m.connect(b); await m.cycle();
  assert.equal(b.calls.filter((c) => c.method === 'thread/resume').length, 0);
});
