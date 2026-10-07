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

// --- Race guards: snapshot invalidation, generations and control boundaries ---
// The UI invalidates the cloud snapshot when the Codex login changes and while
// a monitoring control is pending. These tests drive those boundaries with
// controllable deferred reads: nothing started before the invalidation may
// publish, and the next refresh must issue a fresh read instead of joining a
// pre-change one.
function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
const flush = () => new Promise((resolve) => setImmediate(resolve));
const cloudAt = (marker, overrides = {}) => Object.assign(snapshot(), { marker }, overrides);
function deferredSource({ onChange = () => {}, timer = timerFixture() } = {}) {
  const reads = [];
  const source = api.createSource({ get: () => { const d = deferred(); reads.push(d); return d.promise; }, onChange, ...timer });
  return { source, reads, timer };
}
function appSource() { return fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8'); }

test('an account change clears the rendered snapshot synchronously and a delayed old read cannot republish it', async () => {
  const seen = [], { source, reads } = deferredSource({ onChange: (v) => seen.push(v) });
  source.setActive(true);
  const first = source.refresh(); reads[0].resolve(cloudAt('a')); await first;
  const old = source.refresh();                          // account A read still in flight
  assert.equal(reads.length, 2);
  source.invalidate({ refetch: true });                  // the renderer switches to account B
  assert.equal(source.snapshot(), null);                 // rows and detail data leave synchronously
  assert.equal(seen.at(-1), null);
  assert.equal(reads.length, 3);                         // a fresh read for B, not the pre-change promise
  reads[1].resolve(cloudAt('a-late')); await old;        // delayed old success
  assert.equal(source.snapshot(), null);                 // it cannot republish the previous account
  const next = source.refresh(); assert.equal(reads.length, 3);
  reads[2].resolve(cloudAt('b')); await next;
  assert.equal(source.snapshot().marker, 'b');
  source.dispose();
});
test('a cleared account keeps the empty snapshot and a delayed old failure cannot republish rows or an error', async () => {
  const seen = [], { source, reads } = deferredSource({ onChange: (v) => seen.push(v) });
  const first = source.refresh(); reads[0].resolve(cloudAt('a')); await first;
  const old = source.refresh();
  source.invalidate();                                   // account cleared: clear, no refetch
  assert.equal(source.snapshot(), null);
  assert.equal(reads.length, 2);
  reads[1].reject(new Error('PRIVATE')); await old;      // delayed old failure
  assert.equal(source.snapshot(), null);
  assert.equal(seen.filter((v) => v && v.errorCode).length, 0);
  assert.equal(seen.at(-1), null);
  source.dispose();
});
test('a late old read cannot overwrite newer data or drop the newer in-flight read from the pending slot', async () => {
  const { source, reads } = deferredSource();
  const old = source.refresh();                          // started before the control boundary
  source.invalidate({ clear: false });
  const current = source.refresh({ fresh: true });
  assert.equal(reads.length, 2);
  reads[0].resolve(cloudAt('old')); await old;           // the old read settles while the fresh one is in flight
  const joined = source.refresh();                       // must still join the fresh read, never start a third
  assert.equal(reads.length, 2);
  assert.equal(joined, current);
  reads[1].resolve(cloudAt('current')); await Promise.all([current, joined]);
  assert.equal(source.snapshot().marker, 'current');
  source.dispose();
});
test('stopping the listener cannot publish or reuse a periodic read that started before the control', async () => {
  const seen = [], { source, reads } = deferredSource({ onChange: (v) => seen.push(v) });
  source.setActive(true);
  const init = source.refresh(); reads[0].resolve(cloudAt('initial', { service: { running: true } })); await init;
  const poll = source.refresh();                         // the periodic read is in flight
  source.invalidate({ clear: false });                   // the toggle arms the control
  const refreshed = source.refresh({ fresh: true });     // the control confirms and refreshes
  assert.equal(reads.length, 3);                         // fresh read, not the pre-control promise
  reads[2].resolve(cloudAt('stopped', { service: { running: false } })); await refreshed;
  assert.equal(source.snapshot().service.running, false);
  reads[1].resolve(cloudAt('pre-control', { service: { running: true } })); await poll;
  assert.equal(source.snapshot().service.running, false);  // the delayed pre-control success cannot republish
  assert.ok(!seen.some((v) => v?.marker === 'pre-control'));
  source.dispose();
});
test('starting the listener suppresses a mid-control read and still refreshes after the control', async () => {
  const seen = [], { source, reads } = deferredSource({ onChange: (v) => seen.push(v) });
  source.setActive(true);
  const init = source.refresh(); reads[0].resolve(cloudAt('stopped', { service: { running: false } })); await init;
  source.invalidate({ clear: false });                   // the toggle arms the control
  const mid = source.refresh();                          // a poll while the control is pending
  assert.equal(reads.length, 2);
  const refreshed = source.refresh({ fresh: true });     // the control confirms and refreshes
  assert.equal(reads.length, 3);
  reads[1].resolve(cloudAt('mid-control', { service: { running: true } })); await mid;
  assert.equal(source.snapshot().service.running, false);  // the mid-control read stays suppressed
  reads[2].resolve(cloudAt('started', { service: { running: true } })); await refreshed;
  assert.equal(source.snapshot().marker, 'started');
  assert.ok(!seen.some((v) => v?.marker === 'mid-control'));
  source.dispose();
});
test('an account change while a control is pending leaves only the post-control generation publishable', async () => {
  const seen = [], { source, reads } = deferredSource({ onChange: (v) => seen.push(v) });
  source.setActive(true);
  const init = source.refresh(); reads[0].resolve(cloudAt('a')); await init;
  source.invalidate({ clear: false });                   // the control arms
  source.invalidate({ refetch: true });                  // the account changes to B mid-control
  assert.equal(source.snapshot(), null);                 // old account data leaves synchronously
  assert.equal(reads.length, 2);                         // a fresh B read, not the old A read
  const control = source.refresh({ fresh: true });       // the control confirms
  assert.equal(reads.length, 3);
  reads[1].resolve(cloudAt('b-before-control')); await flush();
  assert.equal(source.snapshot(), null);                 // the pre-completion read cannot publish
  reads[2].resolve(cloudAt('b-fresh')); await control;
  assert.equal(source.snapshot().marker, 'b-fresh');
  assert.ok(!seen.some((v) => v?.marker === 'b-before-control'));
  source.dispose();
});
test('an account change after a control suppresses the post-control read before clearing', async () => {
  const { source, reads } = deferredSource();
  source.setActive(true);
  const init = source.refresh(); reads[0].resolve(cloudAt('a')); await init;
  source.invalidate({ clear: false });                   // the control arms
  const control = source.refresh({ fresh: true });       // the post-control read is in flight
  source.invalidate({ refetch: true });                  // the account changes to B
  assert.equal(source.snapshot(), null);                 // rows and detail leave synchronously
  assert.equal(reads.length, 3);                         // a fresh B read, not the control read
  reads[1].resolve(cloudAt('post-control')); await control;
  assert.equal(source.snapshot(), null);                 // the pre-change read cannot publish
  reads[2].resolve(cloudAt('b')); await flush();
  assert.equal(source.snapshot().marker, 'b');
  source.dispose();
});
test('the codex active-account push invalidates cloud rows before its early return', () => {
  const source = appSource();
  const start = source.indexOf('window.tokenMonitor.codex.onActiveAccount?.(');
  const end = source.indexOf('reducedMotionMedia', start);
  assert.ok(start >= 0 && end > start, 'active-account callback not found');
  const calls = []; let callback = null;
  const context = { window: { tokenMonitor: { codex: { onActiveAccount: (cb) => { callback = cb; } } } },
    cloudSessionsSource: { invalidate: (options) => calls.push(['invalidate', options?.refetch === true, options?.clear === true]) },
    applyCodexOptimisticActiveAccount: () => calls.push(['account']), renderLimits: () => calls.push(['limits']),
    renderCodexAccounts: () => calls.push(['accounts']), renderSettingsSummaries: () => calls.push(['settings']), maybeUpdateBarsIcon: () => calls.push(['bars']) };
  new vm.Script(source.slice(start, end)).runInNewContext(context);
  assert.equal(typeof callback, 'function');
  callback(null);
  assert.deepEqual(calls, [['invalidate', true, false]]);  // a cleared account still invalidates before the early return
  calls.length = 0;
  callback({ accountKey: 'b' });
  assert.deepEqual(calls, [['invalidate', true, false], ['account'], ['limits'], ['accounts'], ['settings'], ['bars']]);
});
test('the monitoring toggle cuts pre-control reads and refreshes freshly after the control', async () => {
  const source = appSource();
  const start = source.indexOf("document.getElementById('cloudSessionsEnabled').addEventListener('change'");
  const end = source.indexOf("window.addEventListener('beforeunload'", start);
  assert.ok(start >= 0 && end > start, 'cloud monitoring toggle handler not found');
  let handler = null, invalidation = 0, invalidateOptions = null, refreshed = null;
  const control = deferred(), actions = [];
  const context = { cloudSessionControlBusy: false, cloudSessionControlError: false,
    document: { getElementById: () => ({ addEventListener: (type, fn) => { if (type === 'change') handler = fn; } }) },
    cloudSessionsSource: { invalidate: (options) => { invalidation += 1; invalidateOptions = [options?.clear === true, options?.refetch === true]; }, refresh: (options) => { refreshed = options?.fresh === true; return Promise.resolve(null); } },
    renderCloudSessionSettings: () => {},
    window: { tokenMonitor: { cloudUsage: { control: (action) => { actions.push(action); return control.promise; } } } } };
  new vm.Script(source.slice(start, end)).runInNewContext(context);
  assert.equal(typeof handler, 'function');
  const run = handler({ target: { checked: false } });
  assert.deepEqual(actions, ['stop']);
  assert.equal(invalidation, 1);                         // no pre-control read may publish once the toggle arms
  assert.deepEqual(invalidateOptions, [false, false]);   // the arm clears nothing and does not refetch
  assert.equal(refreshed, null);                         // the refresh waits for the control result
  control.resolve({ ok: true }); await run;
  assert.equal(refreshed, true);          // the post-control read is always fresh
  assert.equal(context.cloudSessionControlBusy, false);
  assert.equal(context.cloudSessionControlError, false);
});
test('a rejected control still records the failure and refreshes freshly', async () => {
  const source = appSource();
  const start = source.indexOf("document.getElementById('cloudSessionsEnabled').addEventListener('change'");
  const end = source.indexOf("window.addEventListener('beforeunload'", start);
  assert.ok(start >= 0 && end > start, 'cloud monitoring toggle handler not found');
  let handler = null, invalidation = 0, invalidateOptions = null, refreshed = null;
  const control = deferred(), actions = [];
  const context = { cloudSessionControlBusy: false, cloudSessionControlError: false,
    document: { getElementById: () => ({ addEventListener: (type, fn) => { if (type === 'change') handler = fn; } }) },
    cloudSessionsSource: { invalidate: (options) => { invalidation += 1; invalidateOptions = [options?.clear === true, options?.refetch === true]; }, refresh: (options) => { refreshed = options?.fresh === true; return Promise.resolve(null); } },
    renderCloudSessionSettings: () => {},
    window: { tokenMonitor: { cloudUsage: { control: (action) => { actions.push(action); return control.promise; } } } } };
  new vm.Script(source.slice(start, end)).runInNewContext(context);
  const run = handler({ target: { checked: true } });
  assert.deepEqual(actions, ['start']);
  assert.equal(invalidation, 1);
  assert.deepEqual(invalidateOptions, [false, false]);
  assert.equal(refreshed, null);
  control.resolve({ ok: false }); await run;
  assert.equal(context.cloudSessionControlError, true);
  assert.equal(refreshed, true);
});
