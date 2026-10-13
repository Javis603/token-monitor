'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createCloudUsageBridge, projectReport, trustedSender, registerCloudUsageIpc, readJson, LABEL } = require('../../src/electron/cloudUsageBridge');
const sessionRows = require('../../src/electron/renderer/cloudSessionRows');
const tid = '01900000-0000-7000-8000-000000000001';
const child = '01900000-0000-7000-8000-000000000002';
const NOW = Date.parse('2026-10-05T10:00:00Z');
const total = { inputTokens: 90, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 100 };
function raw() { return { version: 1, kind: 'codex-cloud-auto-watch', state: 'listening', observedAt: new Date(NOW).toISOString(), lastDiscoveryAt: new Date(NOW).toISOString(), scopeFingerprint: 'scope-a', pid: 42, scans: 10, connectionNumber: 1, waitingForSlot: 0, discoveryComplete: true,
  threads: [{ threadId: tid, kind: 'aeon', runtimeStatus: 'active', listening: true, status: 'observed', total, observedAt: new Date(NOW).toISOString(), gapCount: 0, receivedEvents: 1 },
    { threadId: child, kind: 'aeon_child', delegationParentId: tid, runtimeStatus: 'idle', listening: false, status: 'no-usage-notification', total: null }] }; }
function project(r = raw(), options = {}) { return projectReport(r, { scopeFingerprint: 'scope-a', now: NOW, service: { installed: true, running: true, canControl: true }, ...options }); }
function temp(t) { const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cloud-native-'))); t.after(() => fs.rmSync(r, { recursive: true, force: true })); return r; }

test('native cloud projection keeps separate per-thread counters and unknown children', () => {
  const r = project(); assert.equal(r.state, 'listening'); assert.equal(r.knownThreads, 2); assert.equal(r.measuredThreads, 1); assert.equal(r.listeningThreads, 1);
  assert.equal(r.threads[0].total.totalTokens, 100); assert.equal(r.threads[1].total, null); assert.equal(r.threads[1].delegationParentId, tid);
  assert.equal(r.taskTotalTokens, null); assert.equal(r.canCombineWithLocal, false); assert.equal(r.accountCloudCoverage, 'unknown');
});
test('account scope mismatch drops all counters, not just account labels', () => {
  const r = project(raw(), { scopeFingerprint: 'different' }); assert.equal(r.errorCode, 'CLOUD_ACCOUNT_MISMATCH'); assert.deepEqual(r.threads, []); assert.equal(r.knownThreads, null);
});
test('stale and stopped services cannot make a saved thread look live', () => {
  const old = project(raw(), { now: NOW + 31000 }); assert.equal(old.stale, true); assert.equal(old.state, 'stale'); assert.equal(old.listeningThreads, 0); assert.equal(old.threads[0].total.totalTokens, 100);
  const stopped = project(raw(), { service: { running: false } }); assert.equal(stopped.stale, true); assert.equal(stopped.listeningThreads, 0);
});
test('empty zero and unavailable token observations remain distinct', () => {
  const r = raw(); r.threads[0].total = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const p = project(r); assert.equal(p.threads[0].total.totalTokens, 0); assert.equal(p.threads[1].total, null);
});
test('invalid totals are excluded while thread metadata survives', () => {
  const r = raw(); r.threads[0].total = { ...total, inputTokens: 91 };
  const p = project(r); assert.equal(p.measuredThreads, 0); assert.equal(p.threads[0].status, 'ambiguous'); assert.equal(p.threads[0].total, null);
});
test('ambiguous engine counters never become measured native totals', () => {
  const r = raw(); r.threads[0].problem = 'NONMONOTONIC_COUNTER'; const p = project(r); assert.equal(p.threads[0].total, null); assert.equal(p.measuredThreads, 0);
});
test('private report fields and arbitrary source flags never cross preload', () => {
  const r = raw(); r.token = 'SECRET'; r.scopeSecret = 'SECRET'; r.threads[0].title = 'PRIVATE_PROMPT'; r.threads[0].cwd = '/private/work'; r.taskTotalTokens = 9999; r.canCombineWithLocal = true;
  const p = project(r), s = JSON.stringify(p); assert.ok(!s.includes('SECRET')); assert.ok(!s.includes('PRIVATE_PROMPT')); assert.ok(!s.includes('/private/work')); assert.ok(!s.includes('scope-a')); assert.ok(!s.includes('9999'));
});
test('malformed report, duplicate ids, oversized catalog and future time fail closed', () => {
  for (const r of [null, { ...raw(), kind: 'other' }, { ...raw(), threads: [raw().threads[0], raw().threads[0]] }, { ...raw(), threads: Array(5001).fill({}) }, { ...raw(), observedAt: new Date(NOW + 600000).toISOString() }]) {
    const p = project(r); assert.equal(p.state, 'unavailable'); assert.equal(p.threads.length, 0);
  }
});
test('returned counters are independent of the source snapshot', () => {
  const source = raw(), r = project(source); r.threads[0].total.inputTokens = 999; assert.equal(source.threads[0].total.inputTokens, 90);
});
test('JSON reader refuses symlinks and oversized files', (t) => {
  const root = temp(t), file = path.join(root, 'report.json'); fs.writeFileSync(file, JSON.stringify(raw())); assert.equal(readJson(file).threads.length, 2);
  const link = path.join(root, 'link'); fs.symlinkSync(file, link); assert.throws(() => readJson(link));
  fs.truncateSync(file, 9 * 1024 * 1024); assert.throws(() => readJson(file), { code: 'INVALID_CLOUD_REPORT' });
});
function serviceFixture(t) {
  const home = temp(t); const p = path.join(home, 'Library/LaunchAgents'); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, LABEL + '.plist'), 'fixture');
  const calls = []; let running = true;
  const execute = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === 'print') { if (!running) throw Object.assign(new Error('not loaded'), { code: 'ENOENT' }); return { stdout: 'state = running\npid = 42\n' }; }
    if (args[0] === 'bootout') running = false;
    if (args[0] === 'kickstart') running = true;
    return { stdout: '' };
  };
  const bridge = createCloudUsageBridge({ home, uid: 501, platform: 'darwin', execute, getScope: () => 'scope-a', readReport: () => ({ ...raw(), observedAt: new Date().toISOString() }) });
  return { bridge, calls, execute, home };
}
test('get reads local report only and never starts another observer', async (t) => {
  const { bridge, calls } = serviceFixture(t); const r = await bridge.get(); assert.equal(r.measuredThreads, 1); assert.ok(calls.every((c) => c.args[0] === 'print')); assert.ok(calls.every((c) => c.binary === '/bin/launchctl'));
});
test('start is idempotent and stop only targets the registered user service', async (t) => {
  const { bridge, calls } = serviceFixture(t); await bridge.control('start'); assert.ok(!calls.some((c) => c.args[0] === 'kickstart'));
  await bridge.control('stop'); assert.ok(calls.some((c) => c.args.join(' ') === `disable gui/501/${LABEL}`)); assert.ok(calls.some((c) => c.args.join(' ') === `bootout gui/501/${LABEL}`));
  assert.ok(!calls.some((c) => c.args.includes('-k')));
  await bridge.control('start'); assert.ok(calls.some((c) => c.args.join(' ') === `kickstart gui/501/${LABEL}`));
});
test('invalid controls and unavailable installation do not run arbitrary commands', async (t) => {
  const { bridge, calls } = serviceFixture(t); await assert.rejects(bridge.control('stop; echo malicious'), { code: 'INVALID_CLOUD_ACTION' }); assert.equal(calls.length, 0);
  const missing = createCloudUsageBridge({ platform: 'linux' }); await assert.rejects(missing.control('start'), { code: 'CLOUD_SERVICE_NOT_INSTALLED' });
});
test('login change during read discards the report', async (t) => {
  const f = serviceFixture(t); let calls = 0;
  const bridge = createCloudUsageBridge({ home: f.home, platform: 'darwin', execute: f.execute, getScope: () => ++calls === 1 ? 'scope-a' : 'other', readReport: raw });
  const r = await bridge.get(); assert.equal(r.errorCode, 'CLOUD_ACCOUNT_CHANGED'); assert.equal(r.threads.length, 0);
});
function sender() { const rendererDir = path.resolve('/fixture/renderer'); const frame = { url: pathToFileURL(path.join(rendererDir, 'dashboard.html')).href + '?tab=cloud' }; const contents = { mainFrame: frame }; const win = { isDestroyed: () => false, webContents: contents }; return { rendererDir, event: { sender: contents, senderFrame: frame }, win }; }
test('IPC accepts only the owned top-frame bundled renderer', () => {
  const f = sender(); assert.equal(trustedSender(f.event, [f.win], f.rendererDir), true);
  assert.equal(trustedSender({ ...f.event, senderFrame: { ...f.event.senderFrame } }, [f.win], f.rendererDir), false);
  f.event.senderFrame.url = 'https://example.com/dashboard.html'; assert.equal(trustedSender(f.event, [f.win], f.rendererDir), false);
  assert.equal(trustedSender(f.event, [], f.rendererDir), false);
});
test('new IPC is guarded and does not expose filesystem paths or generic exec', async () => {
  const f = sender(), handlers = new Map(); let opened = false;
  registerCloudUsageIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getWindows: () => [f.win], rendererDir: f.rendererDir, open: () => { opened = true; }, bridge: { get: async () => project(), control: async (action) => ({ action }) } });
  assert.deepEqual([...handlers.keys()], ['cloudUsage:get', 'cloudUsage:control', 'cloudUsage:open']);
  assert.equal((await handlers.get('cloudUsage:get')(f.event)).measuredThreads, 1);
  handlers.get('cloudUsage:open')(f.event); assert.equal(opened, true);
  assert.throws(() => handlers.get('cloudUsage:get')({}), { code: 'UNTRUSTED_CLOUD_SENDER' });
});
test('native projection supplies cloud rows to the existing session builder', () => {
  const snapshot = project(); const rows = sessionRows.mergeRows([], {}, snapshot, { period: 'allTime', locale: 'zh-CN', now: new Date(NOW) });
  assert.equal(rows.length, 2); assert.equal(rows[0].cloudOnly, true);
  assert.equal(rows[0].value, 100); assert.equal(rows[1].tokenDataUnavailable, true);
});
test('normal product entry points include the cloud pane without changing local data sources', () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, '../../', name), 'utf8');
  const main = read('src/electron/main.js'), preload = read('src/electron/preload.js');
  assert.match(main, /registerCloudUsageIpc/); assert.match(preload, /cloudUsage: \{/);
  assert.doesNotMatch(read('src/electron/renderer/dashboard.html'), /id="cloudTab"/); assert.match(read('src/electron/renderer/index.html'), /id="cloudSessionsEnabled"/);
  assert.match(read('src/electron/renderer/app.js'), /cloudSessionsSource\.dispose/);
  for (const file of ['src/shared/collector.js', 'src/shared/stats.js']) { if (fs.existsSync(path.join(__dirname, '../../', file))) assert.doesNotMatch(read(file), /cloudUsageBridge|cloudAutoWatch/); }
});


test('service migration retains same-account prior counts only as marked last-known display', () => {
  const previous = { ...raw(), runId: 'old' }, current = { ...raw(), runId: 'new' };
  current.threads = current.threads.map((r) => ({ ...r, total: null, status: 'no-usage-notification' }));
  const r = project(current, { previous });
  assert.equal(r.threads[0].total.totalTokens, 100); assert.equal(r.threads[0].retainedFromPriorRun, true);
  assert.equal(r.threads[1].total, null); assert.equal(r.taskTotalTokens, null);
  previous.scopeFingerprint = 'another-account'; assert.equal(project(current, { previous }).measuredThreads, 0);
});
test('a current count or ambiguity never gets overwritten by a prior run', () => {
  const previous = { ...raw(), runId: 'old' }, current = { ...raw(), runId: 'new' };
  const r = project(current, { previous }); assert.equal(r.threads[0].retainedFromPriorRun, false);
  current.threads[0].status = 'ambiguous'; current.threads[0].problem = 'reset'; current.threads[0].total = null;
  assert.equal(project(current, { previous }).threads[0].total, null);
});


test('session filtering dates come from engine metadata instead of discovery or receipt time', () => {
  const r = raw(); r.threads[0].createdMs = NOW - 86400000; r.threads[0].updatedMs = NOW - 3600000;
  const row = project(r).threads[0]; assert.equal(row.createdAt, new Date(NOW - 86400000).toISOString()); assert.equal(row.lastActivityAt, new Date(NOW - 3600000).toISOString());
  delete r.threads[0].updatedMs; assert.equal(project(r).threads[0].lastActivityAt, null);
});
