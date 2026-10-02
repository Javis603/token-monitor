'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { executorIdsFromProcesses, localThreadEnvironment } = require('../../src/shared/providers/codex/localExecutor');
const { createLocalUsageStore, usageCounters } = require('../../src/shared/providers/codex/localUsageStore');
const { createLocalUsageSource } = require('../../src/shared/providers/codex/localUsageSource');
const { collectUsageOnce, projectIdentity, localTodayKey } = require('../../src/shared/collector');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');
const { projectRowsForPeriod } = require('../../src/electron/renderer/projectRows');
const { readSessionDetail } = require('../../src/shared/sessionDetail');
const { buildLocalUsageView } = require('../../src/shared/providers/codex/localUsage');
const { syncPayload } = require('../../src/shared/syncPayload');
const { normalizeDeviceRecord } = require('../../src/shared/usage');

const ID = '01234567-1234-1234-1234-123456789abc';
const AT = new Date(2026, 9, 2, 12).toISOString();
const LOCAL = {
  id: ID, sessionId: 'ancestor-session', name: 'Dots local task', model: 'gpt-test',
  createdAt: 1790899200, status: { type: 'active' }, path: null,
  originator: 'codex_work_cca', threadSource: 'aeon_child',
  environments: [{ environmentId: 'executor-local', cwd: '/work/project' }]
};
const LAST = { inputTokens: 150127, cachedInputTokens: 105216, cacheWriteInputTokens: 0, outputTokens: 52, reasoningOutputTokens: 36, totalTokens: 150179 };
const TOTAL = { inputTokens: 18095423, cachedInputTokens: 17403136, cacheWriteInputTokens: 0, outputTokens: 295111, reasoningOutputTokens: 244670, totalTokens: 18390534 };

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-codex-local-'));
  const env = { TOKEN_MONITOR_SHARED_DIR: home, CODEX_HOME: path.join(home, '.codex'), TOKEN_MONITOR_CODEX_LOCAL_USAGE: '0' };
  const store = createLocalUsageStore({ env });
  const closeables = [store];
  t.after(() => { for (const item of closeables) item.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, env, store, closeables };
}

function event(overrides = {}) {
  return { accountKey: 'test-account', thread: LOCAL, ...LOCAL.environments[0], turnId: 'turn-1', tokenUsage: { last: LAST, total: TOTAL }, now: AT, ...overrides };
}

function addCounters(a, b) {
  return Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + b[key]]));
}

test('ownership requires the actual local executor, excluding cloud, other computers and native rollouts', () => {
  const ids = executorIdsFromProcesses('/app/codex exec-server --remote https://registry.test/api --environment-id executor-local\n/app/codex app-server\n/app/other exec-server --environment-id wrong');
  assert.deepEqual([...ids], ['executor-local']);
  assert.deepEqual([...executorIdsFromProcesses('"C:\\Program Files\\Codex\\codex.exe" exec-server --environment-id "executor-windows"')], ['executor-windows']);
  assert.equal(localThreadEnvironment(LOCAL, ids).cwd, '/work/project');
  assert.equal(localThreadEnvironment({ ...LOCAL, originator: 'orbit_cca_desktop', threadSource: 'aeon' }, ids), null);
  assert.equal(localThreadEnvironment({ ...LOCAL, environments: [{ environmentId: 'executor-other', cwd: '/work/project' }] }, ids), null);
  assert.equal(localThreadEnvironment({ ...LOCAL, path: '/rollout.jsonl' }, ids), null);
  assert.equal(localThreadEnvironment({ ...LOCAL, environments: [...LOCAL.environments, { environmentId: 'executor-other', cwd: '/work/project' }] }, ids), null);
});

test('canonical input excludes cached tokens; reasoning remains a subset of output', () => {
  assert.deepEqual(usageCounters(LAST), { input: 44911, cacheRead: 105216, cacheWrite: 0, output: 52, reasoning: 36, total: 150179 });
  assert.equal(usageCounters({ ...LAST, totalTokens: LAST.totalTokens + 36 }), null);
  assert.equal(usageCounters({ ...LAST, cachedInputTokens: LAST.inputTokens + 1 }), null);
  assert.equal(usageCounters({ ...LAST, inputTokens: NaN }), null);
});

test('persistent checkpoints deduplicate two collectors, restarts and late notifications without importing old totals', (t) => {
  const { env, store } = fixture(t);
  const other = createLocalUsageStore({ env });
  t.after(() => other.close());
  assert.equal(store.observe(event()), true);
  assert.equal(other.observe(event()), false);
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].usage.total, 150179);
  assert.equal(other.observe(event({ tokenUsage: { last: LAST, total: addCounters(TOTAL, LAST) } })), true);
  assert.equal(store.observe(event()), false);
  other.close();
  const restarted = createLocalUsageStore({ env });
  assert.equal(restarted.observe(event({ tokenUsage: { last: LAST, total: addCounters(TOTAL, LAST) } })), false);
  assert.equal(restarted.rows().reduce((sum, row) => sum + row.usage.total, 0), 300358);
  restarted.close();
});

test('gaps count only the observed last request and overlapping incremental updates count only new counters', (t) => {
  const { store } = fixture(t);
  store.observe(event());
  const gap = addCounters(addCounters(TOTAL, LAST), LAST);
  store.observe(event({ tokenUsage: { last: LAST, total: gap } }));
  const increment = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 10 };
  store.observe(event({ tokenUsage: { last: addCounters(LAST, increment), total: addCounters(gap, increment) } }));
  assert.equal(store.rows().reduce((sum, row) => sum + row.usage.total, 0), 300368);
});

test('the collector, archive transform, renderer and details consume one canonical local contribution', async (t) => {
  const { env, home, store, closeables } = fixture(t);
  store.observe(event());
  store.updateThread('test-account', ID, { turnEnded: true });
  const archiveStore = createSessionUsageArchiveStore({ env });
  closeables.push(archiveStore);
  const transform = createUsageTransform({ store: archiveStore, getSettings: () => ({ clients: 'codex', projectsEnabled: true }) });
  let scans = 0;
  const options = {
    clients: 'codex', allTimeSince: '2025-01-01', homeDir: home, env, deviceId: 'local-mac',
    now: AT, codexLocalUsageStore: store, includeHistory: true,
    runTokscale: async () => { scans += 1; return { entries: [] }; },
    runGraph: async () => ({ contributions: [] }),
    lookupModelPricing: async () => ({ pricing: { inputCostPerToken: 0.000001, outputCostPerToken: 0.000002, cacheReadInputTokenCost: 0.0000001 } })
  };
  let anchor;
  const collected = await collectUsageOnce({ ...options, onAnchorComputed: (x) => { anchor = { dateKey: localTodayKey(new Date(AT)), ...x.windowsPeriods, todayPartitions: x.todayPartitions }; } });
  assert.equal(scans, 3);
  const visible = transform.transform(collected);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(visible[name].totalTokens, 150179);
    assert.equal(visible[name].clients.codex, 150179);
    const session = visible[name].sessions[`codex:${ID}`];
    assert.equal(session.inputTokens, 44911);
    assert.equal(session.reasoningTokens, 36);
    assert.equal(session.projectId, projectIdentity('/work/project').projectId);
    const rows = sessionRowsForPeriod(visible[name], { clientLabels: { codex: 'Codex' }, now: new Date(AT) });
    assert.equal(rows[0].name, 'Dots local task');
    assert.equal(rows[0].value, 150179);
    assert.equal(rows[0].activityState, 'ended');
    const projects = projectRowsForPeriod(visible[name], { clientLabels: { codex: 'Codex' } });
    assert.equal(projects[0].name, 'project');
    assert.equal(projects[0].value, 150179);
  }
  assert.equal(visible.history.daily.find((row) => row.date === localTodayKey(new Date(AT))).tokens, 150179);
  assert.equal(Object.keys(archiveStore.read().sessions).length, 0, 'durable source must not also be archived as a vanished native session');
  assert.equal(anchor.allTime.totalTokens, 0, 'native anchor must exclude the supplemental contribution');
  const warm = await collectUsageOnce({ ...options, includeHistory: false, todayOnlyAnchor: anchor });
  assert.equal(scans, 4, 'warm tick scans today only');
  assert.equal(transform.transform(warm).allTime.totalTokens, 150179);
  const detail = readSessionDetail({ client: 'codex', sessionId: ID, home, env, deps: { now: () => Date.parse(AT) } });
  assert.equal(detail.found, true);
  assert.equal(detail.totals.totalTokens, 150179);
  assert.equal(detail.exchanges[0].promptPreview, '');
  const wire = syncPayload(visible);
  assert.equal(wire.codexLocalSessionKeys, undefined);
  assert.equal(wire.today.sessions[`codex:${ID}`].title, undefined);
  assert.equal(wire.allTime.sessions, undefined);
  assert.equal(JSON.stringify(wire).includes('/work/project'), false);
  assert.equal(normalizeDeviceRecord(wire).periods.today.totalTokens, 150179);
});

test('dates, model changes and project changes preserve request attribution; projects can be disabled', (t) => {
  const { store } = fixture(t);
  const earlier = new Date(2026, 8, 30, 23, 59).toISOString();
  const first = new Date(2026, 9, 1, 0, 1).toISOString();
  store.observe(event({ now: earlier }));
  store.observe(event({ now: first, thread: { ...LOCAL, model: 'gpt-other' }, cwd: '/work/other', tokenUsage: { last: LAST, total: addCounters(TOTAL, LAST) } }));
  store.observe(event({ tokenUsage: { last: LAST, total: addCounters(addCounters(TOTAL, LAST), LAST) } }));
  const rows = store.rows();
  assert.deepEqual(rows.map((row) => row.model), ['gpt-test', 'gpt-other', 'gpt-test']);
  assert.deepEqual(rows.map((row) => row.cwd), ['/work/project', '/work/other', '/work/project']);
  const view = buildLocalUsageView(rows, { now: AT, allTimeSince: first, projectIdentity });
  assert.equal(view.today.totalTokens, 150179);
  assert.equal(view.month.totalTokens, 300358);
  assert.equal(view.allTime.totalTokens, 300358);
  assert.equal(view.month.sessions[`codex:${ID}`].models['gpt-other'], 150179);
  const disabled = buildLocalUsageView(rows, { now: AT, projectIdentity, projectsEnabled: false });
  assert.equal(disabled.allTime.sessions[`codex:${ID}`].projectLabel, '');
});

test('native rollout precedence does not resurrect an archived supplemental row', async (t) => {
  const { env, home, store, closeables } = fixture(t);
  store.observe(event());
  const archiveStore = createSessionUsageArchiveStore({ env });
  closeables.push(archiveStore);
  const transform = createUsageTransform({ store: archiveStore });
  const base = { clients: 'codex', allTimeSince: '2025-01-01', now: AT, env, homeDir: home, codexLocalUsageStore: store, lookupModelPricing: async () => ({}) };
  const initial = transform.transform(await collectUsageOnce({ ...base, runTokscale: async () => ({ entries: [] }) }));
  assert.equal(initial.allTime.totalTokens, 150179);
  const nativeId = `rollout-2026-10-02T12-00-00-${ID}`;
  const next = transform.transform(await collectUsageOnce({ ...base, runTokscale: async () => ({ entries: [{ client: 'codex', sessionId: nativeId, model: 'gpt-test', input: 44911, cacheRead: 105216, output: 52 }] }) }));
  assert.equal(next.allTime.totalTokens, 150179);
  assert.deepEqual(Object.keys(next.allTime.sessions), [`codex:${nativeId}`]);
});

class FakeSocket extends EventTarget {
  readyState = 1;
  sent = [];
  notify(method, params, id) {
    const event = new Event('message');
    event.data = JSON.stringify({ method, params, ...(id == null ? {} : { id }) });
    this.dispatchEvent(event);
  }
  send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    if (message.id == null) return;
    const result = message.method === 'thread/list' ? { data: [LOCAL, { ...LOCAL, id: 'cloud', originator: 'orbit_cca_desktop' }, { ...LOCAL, id: 'other-mac', environments: [{ environmentId: 'executor-other', cwd: '/work/project' }] }], nextCursor: null } : {};
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      const event = new Event('message');
      event.data = JSON.stringify({ id: message.id, result });
      this.dispatchEvent(event);
    });
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('live source subscribes only to this executor, ignores content/approval requests and stops cleanly', async (t) => {
  const { store, home, env } = fixture(t);
  const socket = new FakeSocket();
  let changes = 0;
  let destroyed = false;
  const source = createLocalUsageSource({ store, onChange: () => { changes += 1; } }, {
    localExecutorIds: () => new Set(['executor-local']),
    readAuth: () => ({ accessToken: 'private-auth', accountId: 'account-1' }),
    makeSocket: () => { queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return { socket, destroy: () => { destroyed = true; } }; },
    now: () => new Date(AT)
  });
  t.after(() => source.stop());
  source.start();
  await new Promise(setImmediate);
  await source.whenIdle();
  assert.deepEqual(socket.sent.filter((item) => item.method === 'thread/resume').map((item) => item.params), [{ threadId: ID, excludeTurns: true }]);
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'turn-1', tokenUsage: { last: LAST, total: TOTAL } });
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'turn-1', tokenUsage: { last: LAST, total: TOTAL } });
  socket.notify('item/agentMessage/delta', { threadId: ID, delta: 'private-content' });
  const sent = socket.sent.length;
  socket.notify('item/commandExecution/requestApproval', { threadId: ID }, 112);
  assert.equal(socket.sent.length, sent);
  socket.notify('turn/completed', { threadId: ID });
  assert.equal(changes, 2);
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].turnEnded, true);
  assert.equal(JSON.stringify(store.rows()).includes('private-content'), false);
  assert.equal(JSON.stringify(socket.sent).includes('private-auth'), false);
  assert.equal(socket.sent.some((item) => item.method.startsWith('turn/')), false);
  const collected = await collectUsageOnce({
    clients: 'codex', homeDir: home, env, deviceId: 'test-mac', now: AT,
    codexLocalUsageStore: store, runTokscale: async () => ({ entries: [] }), lookupModelPricing: async () => ({})
  });
  assert.equal(sessionRowsForPeriod(collected.today, { clientLabels: { codex: 'Codex' } })[0].value, 150179);
  source.stop();
  await source.whenIdle();
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'turn-2', tokenUsage: { last: LAST, total: addCounters(TOTAL, LAST) } });
  assert.equal(store.rows().length, 1);
  assert.equal(source.getDiagnostics().state, 'stopped');
  assert.equal(destroyed, true);
});

test('a live notification drives the real collector debounce and exact warm period update', { timeout: 5000 }, async (t) => {
  const { home, env, store } = fixture(t);
  const socket = new FakeSocket();
  const sourceModule = require('../../src/shared/providers/codex/localUsageSource');
  const collectorPath = require.resolve('../../src/shared/collector');
  const original = sourceModule.createLocalUsageSource;
  let source;
  let runtime;
  let scans = 0;
  sourceModule.createLocalUsageSource = (options) => {
    source = original({ ...options, store }, {
      localExecutorIds: () => new Set(['executor-local']),
      readAuth: () => ({ accessToken: 'private-auth', accountId: 'account-1' }),
      makeSocket: () => { queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return { socket }; },
      now: () => new Date(AT)
    });
    return source;
  };
  delete require.cache[collectorPath];
  const { startCollector } = require(collectorPath);
  let receive;
  const received = new Promise((resolve) => { receive = resolve; });
  t.after(async () => {
    runtime?.stop();
    await runtime?.whenIdle();
    sourceModule.createLocalUsageSource = original;
    delete require.cache[collectorPath];
  });
  runtime = startCollector({
    clients: 'codex', homeDir: home, env: { ...env, TOKEN_MONITOR_CODEX_LOCAL_USAGE: '' },
    deviceId: 'test-mac', now: AT, historyEnabled: false, watchEnabled: false,
    anchorPersistenceEnabled: false, intervalMs: 60000, watchDebounceMs: 1,
    runTokscale: async () => { scans += 1; return { entries: [] }; },
    lookupModelPricing: async () => ({}),
    onUpdate(summary) { if (summary.today.totalTokens) receive(summary); }
  });
  await runtime.whenIdle();
  await source.whenIdle();
  assert.equal(scans, 3);
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'turn-1', tokenUsage: { last: LAST, total: TOTAL } });
  const summary = await received;
  assert.equal(scans, 4);
  assert.equal(summary.today.totalTokens, 150179);
  assert.equal(summary.month.totalTokens, 150179);
  assert.equal(summary.allTime.totalTokens, 150179);
  runtime.stop();
  await runtime.whenIdle();
  assert.equal(runtime.getDiagnostics().codexLocalUsage.state, 'stopped');
});
