'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../../src/electron/renderer/cloudSessionRows');
const sessions = require('../../src/electron/renderer/sessionRows');
const { breakdownPage } = require('../../src/electron/renderer/breakdownRenderPolicy');
const a = '01900000-0000-7000-8000-000000000001', b = '01900000-0000-7000-8000-000000000002';
const now = new Date(2026, 9, 5, 12, 0, 0);
const iso = (day, hour = 9) => new Date(2026, 9, day, hour).toISOString();
const total = { inputTokens: 900, cachedInputTokens: 800, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1000 };
function snapshot(threads) { return { state: 'listening', observedAt: now.toISOString(), stale: false, service: { running: true }, threads: threads || [
  { threadId: a, kind: 'aeon_child', status: 'observed', runtimeStatus: 'active', total, lastActivityAt: iso(5), createdAt: iso(4), observedAt: now.toISOString(), gapCount: 0 },
  { threadId: b, kind: 'subagent', status: 'no-usage-notification', runtimeStatus: 'idle', total: null, lastActivityAt: iso(5, 8), engineParentId: a }
] }; }
const options = { period: 'today', now, locale: 'zh-CN', color: 'fixture-color' };
function localPeriod(id = 'local-one') { return { totalTokens: 70, costUsd: 1, sessions: { ['codex:' + id]: { client: 'codex', sessionId: id, title: 'Local task', totalTokens: 70, costUsd: 1, lastUsedAt: iso(5, 10) } } }; }
function merge(p = localPeriod(), s = snapshot(), opts = options) { return api.mergeRows(sessions.sessionRowsForPeriod(p, { now }), p, s, opts); }

test('cloud and local sessions join the same row array without changing totals or input maps', () => {
  const p = localPeriod(), before = JSON.stringify(p), rows = merge(p);
  assert.equal(rows.length, 3); assert.equal(rows[0].name, 'Local task');
  const cloud = rows.find(r => r.cloudOnly); assert.equal(cloud.client, 'codex'); assert.equal(cloud.kind, 'session'); assert.equal(cloud.value, 1000);
  assert.equal(cloud.barValue, 0); assert.equal(cloud.cost, 0); assert.equal(cloud.costLabel, '累计 · 云端'); assert.equal(cloud.periodTokenDataUnavailable, true);
  assert.equal(JSON.stringify(p), before); assert.equal(p.totalTokens, 70);
});
test('unknown cloud counters are visible rather than dropped or formatted as zero', () => {
  const row = merge().find(r => r.cloudThreadId === b); assert.ok(row); assert.equal(row.tokenDataUnavailable, true); assert.equal(row.costLabel, '累计 · 云端');
});
test('explicit zero remains a measured count', () => {
  const s = snapshot(); s.threads[0].total = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const row = merge(localPeriod(), s)[1]; assert.equal(row.value, 0); assert.equal(row.tokenDataUnavailable, false);
});
test('exact local/cloud identity is one row with local period counts and an attached cloud detail', () => {
  const rows = merge(localPeriod(a)); assert.equal(rows.length, 2); assert.equal(rows[0].cloudThreadId, a); assert.equal(rows[0].cloudOnly, false);
  assert.equal(rows[0].value, 70); assert.equal(rows[0].cost, 1); assert.ok(rows[0].subtitle.includes('本地 + 云端'));
});
test('UUID fragments in names or unrelated clients are never treated as shared identity', () => {
  assert.equal(api.localIdentity({ client: 'claude', sessionId: a }, 'claude:' + a), null);
  assert.equal(api.localIdentity({ client: 'codex', sessionId: 'notes-' + a }, 'codex:notes-' + a), null);
  assert.equal(api.localIdentity({ client: 'codex', canonicalSessionId: a }, 'codex:opaque'), a);
});
test('repeat cloud rows do not duplicate a session and repeat merges do not mutate prior rows', () => {
  const s = snapshot(); s.threads.push(s.threads[0]); const local = sessions.sessionRowsForPeriod(localPeriod(), { now });
  assert.equal(api.mergeRows(local, localPeriod(), s, options).length, 3); assert.equal(local.length, 1);
});
test('today and month use source activity dates, never replay observation time', () => {
  const old = { ...snapshot().threads[0], lastActivityAt: iso(3), createdAt: iso(3), observedAt: now.toISOString() };
  assert.equal(api.inPeriod(old, 'today', now), false); assert.equal(api.inPeriod(old, 'month', now), true);
  assert.equal(api.inPeriod({ ...old, lastActivityAt: null, createdAt: null }, 'today', now), false);
  assert.equal(api.inPeriod({ ...old, lastActivityAt: null, createdAt: null }, 'allTime', now), true);
});
test('local-midnight boundaries and unknown derived ranges remain exact', () => {
  const t = snapshot().threads[0]; const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  assert.equal(api.inPeriod({ ...t, lastActivityAt: new Date(start - 1).toISOString() }, 'today', now), false);
  assert.equal(api.inPeriod({ ...t, lastActivityAt: start.toISOString() }, 'today', now), true);
  assert.equal(api.inPeriod(t, 'last7', now), false);
});
test('stale or errored snapshots do not keep cloud work marked live', () => {
  const s = snapshot(); s.stale = true; const row = merge(localPeriod(), s)[1]; assert.equal(row.running, undefined); assert.equal(row.stale, true);
  s.stale = false; s.observedAt = new Date(now.getTime() - 31000).toISOString(); assert.equal(merge(localPeriod(), s)[1].running, undefined);
  s.errorCode = 'CLOUD_ACCOUNT_MISMATCH'; assert.equal(merge(localPeriod(), s).length, 1);
});
test('unsafe or ambiguous cloud values do not become list measurements', () => {
  for (const value of [-1, 1.5, '1000', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const s = snapshot(); s.threads[0].total = { ...total, totalTokens: value }; assert.equal(merge(localPeriod(), s)[1].tokenDataUnavailable, true);
  }
  const s = snapshot(); s.threads[0].status = 'ambiguous'; assert.equal(merge(localPeriod(), s)[1].tokenDataUnavailable, true);
});
test('cloud rows use the same existing session pagination', () => {
  const s = snapshot(Array.from({ length: 120 }, (_, n) => ({ ...snapshot().threads[0], threadId: `01900000-0000-7000-8000-${String(n).padStart(12, '0')}` })));
  const rows = merge(localPeriod(), s); const page = breakdownPage(rows, { breakdown: 'session', page: 1 });
  assert.equal(page.total, 121); assert.equal(page.pageCount, 2); assert.equal(page.rows.length, 21);
});
test('cloud detail shows actual component values and no invented cost or requests', () => {
  const d = api.detail(snapshot(), a, 'zh-CN'); assert.equal(d.fields[0][1], '1,000'); assert.equal(d.fields[2][1], '800');
  assert.ok(d.note.includes('未加入')); assert.ok(!JSON.stringify(d).includes('$')); assert.ok(!JSON.stringify(d).includes('call'));
  assert.equal(api.detail(snapshot(), b).fields[0][1], 'Unknown');
});
test('a changed-login detail clears data instead of looking for a local transcript', () => {
  const s = snapshot(); s.errorCode = 'CLOUD_ACCOUNT_CHANGED'; const d = api.detail(s, a); assert.equal(d.fields.length, 0); assert.ok(d.note.includes('No local transcript'));
});
test('cloud-only detail routes into the ordinary detail surface without local transcript IPC', async () => {
  const s = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const source = s.slice(s.indexOf('async function openSessionDetail('), s.indexOf('\nfunction renderCloudSessionDetail('));
  let fetches = 0, renders = 0;
  const context = { state: { settings: {}, period: 'today' }, window: { tokenMonitor: { getSessionDetail: async () => { fetches++; return { found: true }; } } },
    renderSessionDetail() { renders++; }, applySessionDetailResult() {} };
  const fn = new vm.Script(source + '\nopenSessionDetail;').runInNewContext(context);
  await fn({ client: 'codex', sessionId: a, cloudThreadId: a, cloudOnly: true }); assert.equal(fetches, 0); assert.equal(renders, 1);
  await fn({ client: 'codex', sessionId: a, cloudThreadId: a }); assert.equal(fetches, 1);
});
function timerFixture() { let callback = null; return { schedule(fn) { callback = fn; return 1; }, cancel() { callback = null; }, tick() { const fn = callback; callback = null; return fn?.(); }, armed() { return Boolean(callback); } }; }
test('one source read at a time, inactive surfaces do not poll', async () => {
  let resolve, calls = 0; const timer = timerFixture(); const source = api.createSource({ get: () => { calls++; return new Promise(r => { resolve = r; }); }, onChange() {}, ...timer });
  source.setActive(true); source.setActive(true); const joined = source.refresh(); assert.equal(calls, 1);
  resolve(snapshot()); await joined; assert.equal(timer.armed(), true); source.setActive(false); assert.equal(timer.armed(), false); source.dispose();
});
test('a failed refresh clears older account rows', async () => {
  let fail = false; const source = api.createSource({ get: async () => { if (fail) throw Error('PRIVATE'); return snapshot(); }, onChange() {} });
  await source.refresh(); assert.equal(source.snapshot().threads.length, 2); fail = true; await source.refresh(); assert.equal(source.snapshot().threads.length, 0); assert.equal(source.snapshot().errorCode, 'IPC_FAILED'); source.dispose();
});
test('late responses after disposal cannot repaint or restart polling', async () => {
  let resolve, changes = 0; const timer = timerFixture(); const source = api.createSource({ get: () => new Promise(r => { resolve = r; }), onChange() { changes++; }, ...timer });
  const p = source.refresh(); source.dispose(); resolve(snapshot()); await p; assert.equal(changes, 0); assert.equal(timer.armed(), false);
});
test('the shipped UI has no separate cloud tab or shortcut', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');
  assert.doesNotMatch(read('src/electron/renderer/dashboard.html'), /cloudTab|cloudPane|cloudUsagePanel/);
  assert.doesNotMatch(read('src/electron/renderer/index.html'), /cloudUsageButton|cloudUsageShortcut|cloudUsagePanel/);
  assert.match(read('src/electron/renderer/index.html'), /cloudSessionRows\.js/);
  assert.match(read('src/electron/renderer/app.js'), /cloudSessionRowsApi\.mergeRows\(localRows/);
  assert.match(read('src/electron/main.js'), /open: \(\) => openViewFromTray\('session'\)/);
});
