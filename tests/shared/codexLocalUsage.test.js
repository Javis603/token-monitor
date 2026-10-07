'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { executorIdsFromProcesses, localExecutorIds, localThreadEnvironment } = require('../../src/shared/providers/codex/localExecutor');
const { createLocalUsageStore, usageCounters } = require('../../src/shared/providers/codex/localUsageStore');
const { createLocalUsageSource } = require('../../src/shared/providers/codex/localUsageSource');
const { collectUsageOnce, projectIdentity, localTodayKey } = require('../../src/shared/collector');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { captureArchivedClientUsage, normalizeArchivedClientUsage } = require('../../src/shared/usage/clientUsageArchive');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');
const { projectRowsForPeriod } = require('../../src/electron/renderer/projectRows');
const { readSessionDetail } = require('../../src/shared/sessionDetail');
const { buildLocalUsageView, resolveLocalUsagePricing } = require('../../src/shared/providers/codex/localUsage');
const { syncPayload } = require('../../src/shared/syncPayload');
const { mergeDeviceRecord, normalizeDeviceRecord } = require('../../src/shared/usage');

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
  t.after(async () => { for (const item of closeables) await item.close(); fs.rmSync(home, { recursive: true, force: true }); });
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
  assert.deepEqual([...executorIdsFromProcesses('  codex exec-server --environment-id executor-bare')], ['executor-bare']);
  assert.deepEqual([...executorIdsFromProcesses([
    '/bin/bash -c "echo /tmp/codex exec-server --environment-id executor-local"',
    '/app/other --command /app/codex exec-server --environment-id executor-local',
    '/app/codex-wrapper exec-server --environment-id executor-local'
  ].join('\n'))], []);
  assert.equal(localThreadEnvironment(LOCAL, ids).cwd, '/work/project');
  assert.equal(localThreadEnvironment({ ...LOCAL, originator: 'orbit_cca_desktop', threadSource: 'aeon' }, ids), null);
  assert.equal(localThreadEnvironment({ ...LOCAL, environments: [{ environmentId: 'executor-other', cwd: '/work/project' }] }, ids), null);
  assert.equal(localThreadEnvironment({ ...LOCAL, path: '/rollout.jsonl' }, ids), null);
  assert.equal(localThreadEnvironment({ ...LOCAL, environments: [...LOCAL.environments, { environmentId: 'executor-other', cwd: '/work/project' }] }, ids), null);
});

test('executor probe failure is distinct from a successful empty process list', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await localExecutorIds({ platform: 'linux', signal: controller.signal }), null);
  assert.equal(await localExecutorIds({ platform: 'linux', spawn: () => { throw new Error('spawn failed'); } }), null);

  const processWith = (code) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => true;
    const probe = localExecutorIds({ platform: 'linux', spawn: () => child });
    child.emit('close', code);
    return probe;
  };
  const empty = await processWith(0);
  assert.ok(empty instanceof Set);
  assert.equal(empty.size, 0);
  assert.equal(await processWith(1), null);
});

test('canonical input excludes cached tokens; reasoning remains a subset of output', () => {
  assert.deepEqual(usageCounters(LAST), { input: 44911, cacheRead: 105216, cacheWrite: 0, output: 52, reasoning: 36, total: 150179 });
  assert.equal(usageCounters({ ...LAST, totalTokens: LAST.totalTokens + 36 }), null);
  assert.equal(usageCounters({ ...LAST, cachedInputTokens: LAST.inputTokens + 1 }), null);
  assert.equal(usageCounters({ ...LAST, inputTokens: NaN }), null);
});

test('persistent checkpoints deduplicate two collectors, restarts and late notifications without importing old totals', (t) => {
  const { env, store, closeables } = fixture(t);
  const other = createLocalUsageStore({ env });
  closeables.push(other);
  t.after(() => other.close());
  assert.equal(store.observe(event()), true);
  assert.equal(other.observe(event()), false);
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].usage.total, 150179);
  assert.equal(other.observe(event({ tokenUsage: { last: LAST, total: addCounters(TOTAL, LAST) } })), true);
  assert.equal(store.observe(event()), false);
  other.close();
  const restarted = createLocalUsageStore({ env });
  closeables.push(restarted);
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
    assert.equal(session.usageSource, 'codex-dots-local');
    assert.equal(session.usageCoverage, 'observed-only');
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
  assert.equal(normalizeDeviceRecord(wire).periods.today.sessions[`codex:${ID}`].usageCoverage, 'observed-only');
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

test('hiding Dots excludes its periods and history without deleting the ledger or retaining archive copies', async (t) => {
  const { env, home, store, closeables } = fixture(t);
  store.observe(event());
  const archiveStore = createSessionUsageArchiveStore({ env });
  closeables.push(archiveStore);
  const transform = createUsageTransform({ store: archiveStore });
  const options = {
    clients: 'codex', allTimeSince: '2025-01-01', now: AT, env, homeDir: home,
    codexLocalUsageStore: store, includeHistory: true, dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveOptions: { env },
    runTokscale: async () => ({ entries: [] }),
    runGraph: async () => ({ contributions: [] }), lookupModelPricing: async () => ({})
  };
  const visible = transform.transform(await collectUsageOnce(options));
  assert.equal(visible.allTime.totalTokens, LAST.totalTokens);
  const hidden = transform.transform(await collectUsageOnce({ ...options, codexDotsVisible: false }));
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(hidden[name].totalTokens, 0);
    assert.equal(Object.keys(hidden[name].sessions).length, 0);
    assert.equal(Object.keys(hidden[name].projects).length, 0);
  }
  assert.equal((hidden.history?.daily || []).reduce((sum, day) => sum + day.tokens, 0), 0);
  assert.equal(store.rows().length, 1);
  const restored = transform.transform(await collectUsageOnce(options));
  assert.equal(restored.allTime.totalTokens, LAST.totalTokens);
  assert.ok(restored.history.daily.some((day) => day.tokens === LAST.totalTokens));
});

test('untracking Codex captures only native usage and cannot replay Dots after hiding', async (t) => {
  const { env, home, store, closeables } = fixture(t);
  store.observe(event());
  const archiveStore = createSessionUsageArchiveStore({ env });
  closeables.push(archiveStore);
  let settings = { clients: 'codex' };
  const transform = createUsageTransform({ store: archiveStore, getSettings: () => settings });
  const options = {
    clients: 'codex', now: AT, env, homeDir: home, codexLocalUsageStore: store,
    runTokscale: async () => ({ entries: [{ client: 'codex', sessionId: 'native-other', model: 'gpt-test', input: 10, output: 2 }] }),
    lookupModelPricing: async () => ({})
  };
  const visible = transform.transform(await collectUsageOnce(options));
  settings = { clients: 'claude', codexDotsVisible: false,
    archivedClientUsage: captureArchivedClientUsage(null, visible, ['codex'], AT) };
  const hidden = transform.transform(await collectUsageOnce({ ...options, clients: 'claude', codexDotsVisible: false,
    runTokscale: async () => ({ entries: [] }) }));
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(hidden[name].totalTokens, 12);
    assert.equal(hidden[name].sessions[`codex:${ID}`], undefined);
    assert.equal(settings.archivedClientUsage.clients.codex.periods[name].totalTokens, 12);
  }
  assert.equal(normalizeDeviceRecord(syncPayload(hidden)).periods.today.totalTokens, 12);
  // Older snapshots are repaired from explicit provenance even without the
  // local-only summary marker; native amounts and models survive the repair.
  const legacy = { clients: { codex: { capturedAt: AT, periods: {} } } };
  for (const name of ['today', 'month', 'allTime']) {
    const period = visible[name];
    legacy.clients.codex.periods[name] = { totalTokens: period.clients.codex,
      costUsd: period.clientCosts.codex, models: period.clientModels.codex,
      modelCosts: period.clientModelCosts.codex, sessions: period.sessions };
  }
  const repaired = normalizeArchivedClientUsage(legacy);
  assert.equal(repaired.clients.codex.periods.allTime.totalTokens, 12);
  assert.equal(repaired.clients.codex.periods.allTime.models.unknown, undefined);
  assert.equal(store.rows().length, 1);
});

test('Hub preserves Dots missing-price attribution when Codex is untracked without borrowing live client usage', (t) => {
  const { store } = fixture(t);
  store.observe(event({ thread: { ...LOCAL, model: 'unknown' } }));
  const view = buildLocalUsageView(store.rows(), { now: AT, projectIdentity });
  const live = {
    totalTokens: 20, costUsd: 1, unpricedTokens: 5,
    clients: { claude: 20 }, clientCosts: { claude: 1 },
    clientUnpricedTokens: { claude: 5 },
    models: { unknown: 20 }, modelCosts: { unknown: 1 }, modelUnpricedTokens: { unknown: 5 },
    clientModels: { claude: { unknown: 20 } }, clientModelCosts: { claude: { unknown: 1 } },
    clientModelUnpricedTokens: { claude: { unknown: 5 } }
  };
  const existing = {
    deviceId: 'fixture', updatedAt: AT, trackedClients: ['codex'], ...view
  };
  const incoming = {
    deviceId: 'fixture', updatedAt: AT, trackedClients: ['claude'],
    today: live, month: live, allTime: live
  };
  const merged = mergeDeviceRecord(existing, incoming);
  for (const period of Object.values(merged.periods)) {
    assert.equal(period.totalTokens, LAST.totalTokens + 20);
    assert.equal(period.costUsd, 1);
    assert.equal(period.unpricedTokens, LAST.totalTokens + 5);
    assert.equal(period.clientUnpricedTokens.codex, LAST.totalTokens);
    assert.equal(period.clientUnpricedTokens.claude, 5);
    assert.equal(period.modelUnpricedTokens.unknown, LAST.totalTokens + 5);
    assert.equal(period.clientModelUnpricedTokens.codex.unknown, LAST.totalTokens);
    assert.equal(period.clientModelUnpricedTokens.claude.unknown, 5);
    assert.equal(period.sessions['codex:' + ID].unpricedTokens, LAST.totalTokens);
  }
  const repeated = mergeDeviceRecord(merged, incoming);
  for (const name of ['today', 'month', 'allTime']) {
    for (const field of ['totalTokens', 'costUsd', 'unpricedTokens', 'clientUnpricedTokens', 'modelUnpricedTokens', 'clientModelUnpricedTokens']) {
      assert.deepEqual(repeated.periods[name][field], merged.periods[name][field]);
    }
  }
  const replacement = mergeDeviceRecord(merged, {
    ...incoming, trackedClients: ['codex', 'claude']
  });
  assert.equal(replacement.periods.allTime.unpricedTokens, 5, 'live tracking replaces the preserved contribution');
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
  store.updateThread('test-account', ID, { nativeBacked: true });
  assert.equal(store.observe(event({ tokenUsage: { last: LAST, total: addCounters(TOTAL, LAST) } })), false);
  assert.equal(buildLocalUsageView(store.rows(), { now: AT, projectIdentity }).allTime.totalTokens, 0);
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

test('ownership standby retries promptly without probing until the lease is available', async (t) => {
  const { store } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let blocked = true;
  let scans = 0;
  const claim = store.claimObserver.bind(store);
  store.claimObserver = (owner) => !blocked && claim(owner);
  const source = createLocalUsageSource({ store, agentRuntime: 'headless-agent' }, {
    pollMs: 5000, idlePollMs: 30000,
    readAuth: () => ({ accessToken: 'fixture', accountId: 'account' }),
    localExecutorIds: () => { scans++; return new Set(); }
  });
  t.after(() => source.stop());
  source.start();
  await source.whenIdle();
  assert.equal(source.getDiagnostics().state, 'standby');
  assert.equal(scans, 0);
  blocked = false;
  t.mock.timers.tick(4999);
  await source.whenIdle();
  assert.equal(scans, 0);
  t.mock.timers.tick(1);
  await source.whenIdle();
  assert.equal(scans, 1, 'ownership must not use the no-executor idle delay');
  t.mock.timers.tick(29999);
  await source.whenIdle();
  assert.equal(scans, 1, 'confirmed absence of an executor still uses idle cadence');
  t.mock.timers.tick(1);
  await source.whenIdle();
  assert.equal(scans, 2);
});

test('Dots missing prices survive history, sync, Hub/Worker merging and fixed ranges', async (t) => {
  const { env, home, store } = fixture(t);
  store.observe(event({ thread: { ...LOCAL, model: 'unknown' } }));
  const collected = await collectUsageOnce({
    clients: 'codex', allTimeSince: '2025-01-01', now: AT, env, homeDir: home,
    deviceId: 'fixture', codexLocalUsageStore: store, includeHistory: true,
    runTokscale: async () => ({ entries: [] }), runGraph: async () => ({ contributions: [] })
  });
  const { aggregateHistory } = require('../../src/shared/usage');
  const workerUsage = require('../../worker/src/shared/usage');
  const { historyPreview } = require('../../src/shared/history');
  const ranges = require('../../src/electron/renderer/fixedPeriodRanges');
  const { usageCostLabel } = require('../../src/electron/renderer/usageAttributionRows');
  const synced = normalizeDeviceRecord(syncPayload(collected));
  for (const aggregate of [aggregateHistory, workerUsage.aggregateHistory]) {
    const history = aggregate([synced, { ...synced, deviceId: 'fixture-2' }], { todayKey: localTodayKey(new Date(AT)) });
    const day = history.daily.find((row) => row.date === localTodayKey(new Date(AT)));
    const expected = LAST.totalTokens * 2;
    assert.equal(day.unpricedTokens, expected);
    assert.equal(day.perClient.codex.unpricedTokens, expected);
    assert.equal(day.perModel.unknown.unpricedTokens, expected);
    assert.equal(history.monthly[0].unpricedTokens, expected);
    assert.equal(history.summary.unpricedTokens, expected);
    assert.equal(historyPreview(history).daily.find((row) => row.date === day.date).unpricedTokens, expected);
    const period = ranges.derivePeriod(history.daily, { start: day.date, end: day.date });
    assert.equal(period.unpricedTokens, expected);
    assert.equal(period.clientUnpricedTokens.codex, expected);
    assert.equal(period.modelUnpricedTokens.unknown, expected);
    assert.notEqual(usageCostLabel(period.costUsd, period.unpricedTokens, String, String, 'unpriced'), '0');
  }
});

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
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'baseline', tokenUsage: { last: LAST, total: TOTAL } });
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'turn-1', tokenUsage: { last: LAST, total: addCounters(TOTAL, LAST) } });
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'baseline', tokenUsage: { last: LAST, total: TOTAL } });
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'turn-1', tokenUsage: { last: LAST, total: addCounters(TOTAL, LAST) } });
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
    clients: 'codex', homeDir: home, env: { ...env, TOKEN_MONITOR_CODEX_LOCAL_USAGE: '0' },
    codexDotsEnabled: true,
    deviceId: 'test-mac', agentRuntime: 'headless-agent', now: AT, historyEnabled: false, watchEnabled: false,
    anchorPersistenceEnabled: false, intervalMs: 60000, watchDebounceMs: 1,
    runTokscale: async () => { scans += 1; return { entries: [] }; },
    lookupModelPricing: async () => ({}),
    onUpdate(summary) { if (summary.today.totalTokens) receive(summary); }
  });
  await runtime.whenIdle();
  await source.whenIdle();
  assert.equal(scans, 3);
  assert.equal(store.agentObserverRequested(), true);
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'baseline', tokenUsage: { last: LAST, total: TOTAL } });
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'turn-1', tokenUsage: { last: LAST, total: addCounters(TOTAL, LAST) } });
  const summary = await received;
  assert.equal(scans, 4);
  assert.equal(summary.today.totalTokens, 150179);
  assert.equal(summary.month.totalTokens, 150179);
  assert.equal(summary.allTime.totalTokens, 150179);
  runtime.stop();
  await runtime.whenIdle();
  assert.equal(runtime.getDiagnostics().codexLocalUsage.state, 'stopped');
  assert.equal(store.agentObserverRequested(), false);
});

test('visibility switches preserve the live subscription and fence an in-flight visible result', { timeout: 5000 }, async (t) => {
  const { home, env, store } = fixture(t);
  const socket = new FakeSocket();
  const sourceModule = require('../../src/shared/providers/codex/localUsageSource');
  const collectorPath = require.resolve('../../src/shared/collector');
  const original = sourceModule.createLocalUsageSource;
  let source;
  let runtime;
  let starts = 0;
  let releaseScan;
  let enteredScan;
  let blockScan = false;
  const summaries = [];
  sourceModule.createLocalUsageSource = (options) => {
    starts += 1;
    source = original({ ...options, store }, {
      localExecutorIds: () => new Set(['executor-local']),
      readAuth: () => ({ accessToken: 'fixture-auth', accountId: 'fixture-account' }),
      makeSocket: () => { queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return { socket }; },
      now: () => new Date(AT)
    });
    return source;
  };
  delete require.cache[collectorPath];
  t.after(async () => {
    releaseScan?.();
    runtime?.stop();
    await runtime?.whenIdle();
    sourceModule.createLocalUsageSource = original;
    delete require.cache[collectorPath];
  });
  runtime = require(collectorPath).startCollector({
    clients: 'codex', homeDir: home, env, codexDotsEnabled: true,
    now: AT, historyEnabled: true, watchEnabled: false, anchorPersistenceEnabled: false,
    intervalMs: 60000, watchDebounceMs: 1,
    runTokscale: async () => {
      if (blockScan) {
        blockScan = false;
        enteredScan();
        await new Promise((resolve) => { releaseScan = resolve; });
      }
      return { entries: [] };
    },
    runGraph: async () => ({ contributions: [] }), lookupModelPricing: async () => ({}),
    onUpdate: (summary) => summaries.push(summary)
  });
  await runtime.whenIdle();
  await source.whenIdle();
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'baseline', tokenUsage: { last: LAST, total: TOTAL } });
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'turn-1', tokenUsage: { last: LAST, total: addCounters(TOTAL, LAST) } });
  await runtime.tick('manual');
  const resumeCount = socket.sent.filter((item) => item.method === 'thread/resume').length;
  const before = summaries.length;
  const scanEntered = new Promise((resolve) => { enteredScan = resolve; });
  blockScan = true;
  const inFlight = runtime.tick('manual');
  await scanEntered;
  const hidden = runtime.setCodexDotsVisible(false);
  releaseScan();
  await Promise.all([inFlight, hidden]);
  assert.ok(summaries.length > before);
  assert.ok(summaries.slice(before).every((summary) => summary.today.totalTokens === 0));
  assert.equal(summaries.at(-1).history.summary.totalTokens, 0);
  assert.equal(source.getDiagnostics().state, 'connected');
  socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'turn-2', tokenUsage: { last: LAST, total: addCounters(addCounters(TOTAL, LAST), LAST) } });
  assert.equal(store.rows().length, 2, 'hidden observation does not establish a new baseline');
  await runtime.setCodexDotsVisible(true);
  assert.equal(summaries.at(-1).allTime.totalTokens, LAST.totalTokens * 2);
  assert.equal(summaries.at(-1).history.summary.totalTokens, LAST.totalTokens * 2);
  assert.equal(starts, 1);
  assert.equal(socket.readyState, 1);
  assert.equal(socket.sent.filter((item) => item.method === 'thread/resume').length, resumeCount);
});

test('replacement during a hide refresh clears the previous Dots history on outgoing wire', async (t) => {
  const { env, home, store } = fixture(t);
  store.observe(event());
  const { startCollector } = require('../../src/shared/collector');
  const { createDeviceRuntime } = require('../../src/shared/usage/deviceRuntime');
  const base = { clients: 'codex', now: AT, env, homeDir: home, codexLocalUsageStore: store,
    historyEnabled: true, watchEnabled: false, anchorPersistenceEnabled: false, intervalMs: 60000,
    runTokscale: async () => ({ entries: [] }), runGraph: async () => ({ contributions: [] }),
    lookupModelPricing: async () => ({}) };
  const handles = [];
  const records = [];
  let release;
  let entered;
  let block = false;
  const options = { ...base, runTokscale: async () => {
    if (block) { block = false; entered(); await new Promise((resolve) => { release = resolve; }); }
    return { entries: [] };
  } };
  const runtime = createDeviceRuntime({ usageOptions: options, onRecord: (record) => records.push(record) }, {
    createUsageRuntime(next) { const handle = startCollector(next); handles.push(handle); return handle; },
    createLimitsRuntime: () => ({ stop() {} })
  });
  t.after(async () => { release?.(); runtime.stop(); await Promise.all(handles.map((handle) => handle.whenIdle())); });
  await handles[0].whenIdle();
  assert.equal(records.at(-1).history.summary.totalTokens, LAST.totalTokens);
  const scanEntered = new Promise((resolve) => { entered = resolve; });
  block = true;
  const hiding = runtime.setCodexDotsVisible(false);
  await scanEntered;
  runtime.reconfigureUsage({ ...base, codexDotsVisible: false, intervalMs: 120000 });
  release();
  await hiding;
  await handles[1].whenIdle();
  const hidden = records.at(-1);
  assert.equal(hidden.today.totalTokens, 0);
  assert.equal(hidden.history.summary.totalTokens, 0);
  assert.equal(syncPayload(hidden).history.summary.totalTokens, 0);
});

test('a worker crash before hide acknowledgement clears Dots history in the fallback record', async (t) => {
  const { env, home, store } = fixture(t);
  store.observe(event());
  const { startCollector } = require('../../src/shared/collector');
  const { createUsageHostCoordinator } = require('../../src/shared/usage/usageHost');
  const { createDeviceState } = require('../../src/shared/usage/deviceState');
  const options = { clients: 'codex', now: AT, env, homeDir: home, codexLocalUsageStore: store,
    historyEnabled: true, watchEnabled: false, anchorPersistenceEnabled: false, intervalMs: 60000,
    runTokscale: async () => ({ entries: [] }), runGraph: async () => ({ contributions: [] }),
    lookupModelPricing: async () => ({}) };
  const records = [];
  const state = createDeviceState({ onRecord: (record) => records.push(record) });
  state.updateUsage(await collectUsageOnce({ ...options, includeHistory: true }), 'initial');
  assert.equal(records.at(-1).history.summary.totalTokens, LAST.totalTokens);
  let worker;
  let fallback;
  class FakeWorker extends EventEmitter {
    constructor() { super(); worker = this; }
    postMessage() {}
    unref() {}
  }
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker,
    startCollector(next) { fallback = startCollector(next); return fallback; } });
  const host = coordinator.create({ ...options, onUpdate: (summary) => state.updateUsage(summary, 'fallback') });
  t.after(async () => { host.stop(); await host.whenIdle(); state.stop(); });
  await new Promise(setImmediate);
  const hiding = host.setCodexDotsVisible(false);
  worker.emit('error', new Error('fixture crash before visibility reply'));
  worker.emit('exit', 1);
  await hiding;
  await fallback.whenIdle();
  const hidden = records.at(-1);
  assert.equal(hidden.today.totalTokens, 0);
  assert.equal(hidden.history.summary.totalTokens, 0);
  assert.equal(syncPayload(hidden).history.summary.totalTokens, 0);
});

test('observer lease admits one writer, releases only its owner and recovers dead/expired owners', (t) => {
  const { env, store, closeables } = fixture(t);
  const other = createLocalUsageStore({ env });
  closeables.push(other);
  t.after(() => other.close());
  assert.equal(store.claimObserver('widget', 101, 1000, () => true), true);
  assert.equal(other.claimObserver('agent', 202, 1001, () => true), false);
  other.releaseObserver('agent');
  assert.equal(other.claimObserver('agent', 202, 1002, () => true), false);
  store.releaseObserver('widget');
  assert.equal(other.claimObserver('agent', 202, 1003, () => true), true);
  assert.equal(store.claimObserver('new-widget', 303, 1004, () => false), true);
  assert.equal(other.claimObserver('new-agent', 404, 31004, () => true), true);
});

test('reconnect discards its initial snapshot and offline gap, retaining only later observed requests', { timeout: 2000 }, async (t) => {
  const { store } = fixture(t);
  const sockets = [];
  let connected;
  const reconnect = new Promise((resolve) => { connected = resolve; });
  const source = createLocalUsageSource({ store }, {
    pollMs: 5, idlePollMs: 5,
    shouldYield: () => false,
    localExecutorIds: () => new Set(['executor-local']),
    readAuth: () => ({ accessToken: 'fixture', accountId: 'account' }),
    makeSocket() {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => { socket.dispatchEvent(new Event('open')); if (sockets.length === 2) connected(); });
      return { socket };
    }, now: () => new Date(AT)
  });
  t.after(() => source.stop());
  source.start();
  await new Promise(setImmediate);
  await source.whenIdle();
  const notify = (socket, total) => socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId: 'turn', tokenUsage: { last: LAST, total } });
  notify(sockets[0], TOTAL);
  assert.equal(store.rows().length, 0, 'old last request must not be charged on connection');
  notify(sockets[0], addCounters(TOTAL, LAST));
  sockets[0].close();
  await reconnect;
  await new Promise(setImmediate);
  await source.whenIdle();
  const gap = addCounters(addCounters(addCounters(TOTAL, LAST), LAST), LAST);
  notify(sockets[1], gap);
  assert.equal(store.rows().length, 1);
  notify(sockets[1], addCounters(gap, LAST));
  notify(sockets[1], addCounters(gap, LAST));
  assert.equal(store.rows().length, 2);
  assert.equal(store.rows().reduce((sum, row) => sum + row.usage.total, 0), LAST.totalTokens * 2);
});

test('an enabled source without a local executor never opens a socket; agent ownership avoids probes', async (t) => {
  const { store } = fixture(t);
  let scans = 0;
  let sockets = 0;
  const deps = {
    shouldYield: () => false,
    localExecutorIds: () => { scans += 1; return new Set(); },
    readAuth: () => ({ accessToken: 'fixture', accountId: 'account' }),
    makeSocket: () => { sockets += 1; return { socket: new FakeSocket() }; }
  };
  const source = createLocalUsageSource({ store }, deps);
  source.start();
  await source.whenIdle();
  assert.equal(scans, 1);
  assert.equal(sockets, 0);
  source.stop();
  const standby = createLocalUsageSource({ store }, { ...deps, shouldYield: () => true });
  standby.start();
  await standby.whenIdle();
  assert.equal(standby.getDiagnostics().state, 'standby');
  assert.equal(scans, 1);
  assert.equal(sockets, 0);
  standby.stop();
});

test('an inconclusive executor probe retains the active local usage connection', async (t) => {
  const { store } = fixture(t);
  const socket = new FakeSocket();
  let scans = 0;
  const source = createLocalUsageSource({ store }, {
    pollMs: 5,
    idlePollMs: 30000,
    shouldYield: () => false,
    localExecutorIds: () => (++scans === 1 ? new Set(['executor-local']) : null),
    readAuth: () => ({ accessToken: 'fixture', accountId: 'account' }),
    makeSocket: () => { queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return { socket }; },
    now: () => new Date(AT)
  });
  t.after(() => source.stop());
  source.start();

  const deadline = Date.now() + 2000;
  while (source.getDiagnostics().subscriptions === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(source.getDiagnostics().state, 'connected');
  assert.equal(source.getDiagnostics().subscriptions, 1);

  while (scans < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(scans >= 2, 'the next executor probe ran');
  assert.equal(source.getDiagnostics().state, 'connected');
  assert.equal(source.getDiagnostics().localExecutors, 1);
  assert.equal(source.getDiagnostics().subscriptions, 1);
  assert.equal(socket.readyState, 1);
});

test('default and explicit disable do not construct the source, while keeping stored usage', async (t) => {
  const { home, env, store } = fixture(t);
  store.observe(event());
  const sourceModule = require('../../src/shared/providers/codex/localUsageSource');
  const collectorPath = require.resolve('../../src/shared/collector');
  const original = sourceModule.createLocalUsageSource;
  let constructions = 0;
  sourceModule.createLocalUsageSource = () => { constructions += 1; throw new Error('must not construct'); };
  delete require.cache[collectorPath];
  t.after(() => { sourceModule.createLocalUsageSource = original; delete require.cache[collectorPath]; });
  for (const [flag, codexDotsEnabled] of [[undefined, undefined], ['0', undefined], ['1', false]]) {
    const runtime = require(collectorPath).startCollector({
      clients: 'codex', env: { ...env, TOKEN_MONITOR_CODEX_LOCAL_USAGE: flag }, homeDir: home,
      codexDotsEnabled,
      codexLocalUsageStore: store, now: AT, deviceId: 'fixture',
      allTimeSince: '2025-01-01', historyEnabled: false, watchEnabled: false,
      anchorPersistenceEnabled: false, intervalMs: 60000,
      runTokscale: async () => ({ entries: [] }), lookupModelPricing: async () => ({}),
      onUpdate(summary) { assert.equal(summary.today.totalTokens, LAST.totalTokens); }
    });
    await runtime.whenIdle();
    runtime.stop();
    await runtime.whenIdle();
  }
  assert.equal(constructions, 0);
});

test('separate processes serialize duplicate ledger updates and transfer ownership after a crash', { timeout: 20000 }, async (t) => {
  const { home, store, closeables } = fixture(t);
  const modulePath = require.resolve('../../src/shared/providers/codex/localUsageStore');
  const script = `
    const store = require(process.argv[1]).createLocalUsageStore({ databasePath: process.argv[2] });
    process.on('message', (message) => {
      try {
        const result = message.method === 'observe' ? store.observe(message.event)
          : store.claimObserver(message.owner);
        process.send({ result });
      } catch (error) { process.send({ error: error.message }); }
    });
  `;
  const children = [0, 1].map(() => spawn(process.execPath, ['-e', script, modulePath, path.join(home, 'codex-local-usage.sqlite')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  closeables.push({ close: async () => {
    await Promise.all(children.map((child) => child.exitCode != null || child.signalCode
      ? null : new Promise((resolve) => { child.once('close', resolve); child.kill('SIGKILL'); })));
  } });
  const rpc = (child, message) => new Promise((resolve, reject) => {
    const failed = () => reject(new Error('ledger test subprocess exited before replying'));
    child.once('exit', failed);
    child.once('message', (reply) => {
      child.removeListener('exit', failed);
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply.result);
    });
    child.send(message, (error) => { if (error) reject(error); });
  });
  const updates = await Promise.all(children.map((child) => rpc(child, { method: 'observe', event: event() })));
  assert.deepEqual(updates.sort(), [false, true]);
  assert.equal(store.rows().length, 1);
  assert.equal(await rpc(children[0], { method: 'claim', owner: 'widget' }), true);
  assert.equal(await rpc(children[1], { method: 'claim', owner: 'agent' }), false);
  await new Promise((resolve) => { children[0].once('close', resolve); children[0].kill('SIGKILL'); });
  assert.equal(await rpc(children[1], { method: 'claim', owner: 'agent' }), true);
  assert.equal(await rpc(children[1], { method: 'observe', event: event() }), false);
});

test('live model attribution requires a turn-linked event rather than the thread current model', async (t) => {
  const { store } = fixture(t);
  const socket = new FakeSocket();
  const source = createLocalUsageSource({ store }, {
    shouldYield: () => false,
    localExecutorIds: () => new Set(['executor-local']),
    readAuth: () => ({ accessToken: 'fixture', accountId: 'account' }),
    makeSocket: () => { queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return { socket }; },
    now: () => new Date(AT)
  });
  t.after(() => source.stop());
  source.start();
  await new Promise(setImmediate);
  await source.whenIdle();
  const notify = (turnId, total) => socket.notify('thread/tokenUsage/updated', { threadId: ID, turnId, tokenUsage: { last: LAST, total } });
  notify('baseline', TOTAL);
  socket.notify('model/rerouted', { threadId: ID, toModel: 'unscoped-model' });
  const next = addCounters(TOTAL, LAST);
  socket.notify('turn/started', { threadId: ID, turn: { id: 'turn-unknown', model: 'unsupported-field' } });
  notify('turn-unknown', next);
  socket.notify('model/rerouted', { threadId: ID, turnId: 'turn-known', fromModel: 'original-model', toModel: 'confirmed-model', reason: 'modelCapacity' });
  notify('turn-known', addCounters(next, LAST));
  socket.notify('model/rerouted', { threadId: ID, turn: { id: 'turn-nested' }, toModel: 'nested-model' });
  socket.notify('thread/tokenUsage/updated', {
    threadId: ID, turn: { id: 'turn-nested' },
    tokenUsage: { last: LAST, total: addCounters(addCounters(next, LAST), LAST) }
  });
  assert.deepEqual(store.rows().map((row) => row.model), ['unknown', 'confirmed-model', 'nested-model']);
});

test('native replacement removes previously observed Dots usage from retained daily history', async (t) => {
  const { home, env, store } = fixture(t);
  store.observe(event());
  const base = {
    clients: 'codex', env, homeDir: home, codexLocalUsageStore: store, now: AT,
    allTimeSince: '2025-01-01', includeHistory: true, dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveOptions: { env }, lookupModelPricing: async () => ({})
  };
  const initial = await collectUsageOnce({ ...base, runTokscale: async () => ({ entries: [] }), runGraph: async () => ({ contributions: [] }) });
  assert.equal(initial.history.daily[0].tokens, LAST.totalTokens);
  const replacement = await collectUsageOnce({ ...base,
    runTokscale: async () => ({ entries: [{ client: 'codex', sessionId: `rollout-${ID}`, model: 'gpt-test', input: 20, output: 0 }] }),
    runGraph: async () => ({ contributions: [{ date: localTodayKey(new Date(AT)), clients: [{ client: 'codex', modelId: 'gpt-test', tokens: { input: 20, output: 0 }, messages: 1, cost: 0 }] }] })
  });
  assert.equal(replacement.today.totalTokens, 20);
  assert.equal(replacement.history.daily[0].tokens, 20, 'generic archive must not resurrect the old Dots maximum');
});


test('missing model or rates remain explicit across period/session/project normalization and display', () => {
  const { mergePeriods, applyProjectRollups } = require('../../src/shared/usage');
  const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 110 };
  const rows = ['unknown', 'priced', 'missing-rate', 'free'].map((model, index) => ({
    threadId: ID + index, model, usage, observedAt: AT, cwd: '/work/project', title: model
  }));
  const pricing = (rate) => ({ inputCostPerToken: rate, outputCostPerToken: rate });
  const view = buildLocalUsageView(rows, {
    now: AT, projectIdentity,
    pricingByModel: { unknown: pricing(1), priced: pricing(0.01), 'missing-rate': { inputCostPerToken: 0.01 }, free: pricing(0) }
  });
  applyProjectRollups(view);
  const normalized = normalizeDeviceRecord({ periods: { today: view.today } }).periods.today;
  assert.equal(normalized.totalTokens, 440);
  assert.equal(normalized.unpricedTokens, 120);
  assert.equal(normalized.costUsd, 2.1);
  assert.equal(normalized.sessions['codex:' + ID + '0'].unpricedTokens, 110);
  assert.equal(normalized.clientUnpricedTokens.codex, 120);
  assert.equal(normalized.modelUnpricedTokens.unknown, 110);
  assert.equal(Object.values(normalized.projects)[0].unpricedTokens, 120);
  assert.equal(sessionRowsForPeriod(normalized).find((row) => row.key === 'session:codex:' + ID + '0').unpricedTokens, 110);
  assert.equal(projectRowsForPeriod(normalized)[0].unpricedTokens, 120);
  assert.equal(mergePeriods(normalized, normalized).unpricedTokens, 240);
});

test('ledger details price each observed request without allocating the known subtotal to unknown models', async (t) => {
  const { home, env, store } = fixture(t);
  const { readSessionDetailForPlatform } = require('../../src/shared/sessionDetailResolver');
  const { exchangeRows } = require('../../src/electron/renderer/sessionDetail');
  const { usageCostLabel } = require('../../src/electron/renderer/usageAttributionRows');
  const previousDay = new Date(Date.parse(AT) - 86400000).toISOString();
  store.observe(event({ thread: { ...LOCAL, model: 'unknown' }, now: previousDay }));
  const next = addCounters(TOTAL, LAST);
  store.observe(event({ thread: { ...LOCAL, model: 'detail-priced' }, turnId: 'priced-turn', tokenUsage: { last: LAST, total: next } }));
  store.observe(event({ thread: { ...LOCAL, model: 'unknown' }, turnId: 'unknown-turn', tokenUsage: { last: LAST, total: addCounters(next, LAST) } }));
  const raw = readSessionDetail({ client: 'codex', sessionId: ID, home, env, period: 'today', sessionCost: 999, deps: { now: () => Date.parse(AT) } });
  assert.equal(raw.totals.costUsd, 0, 'an aggregate cannot price individual ledger requests');
  assert.equal(raw.totals.unpricedTokens, LAST.totalTokens * 2);
  const lookups = [];
  // Real worker message boundary and main-process pricing injection, then both
  // renderer adapters. IDs, models and counters only; no transcript content.
  const detail = await readSessionDetailForPlatform({ client: 'codex', sessionId: ID, env, period: 'total', sessionCost: 999 }, {
    lookupModelPricing: async (model) => {
      lookups.push(model);
      return { pricing: { inputCostPerToken: 0.000001, cacheReadInputTokenCost: 0.0000001, outputCostPerToken: 0.000002 } };
    }
  });
  const expected = 44911 * 0.000001 + 105216 * 0.0000001 + 52 * 0.000002;
  assert.deepEqual(lookups, ['detail-priced']);
  assert.equal(detail.totals.costUsd, expected);
  assert.equal(detail.totals.unpricedTokens, LAST.totalTokens * 2);
  const row = exchangeRows(detail)[0];
  assert.equal(row.unpricedTokens, LAST.totalTokens * 2);
  assert.equal(row.cost, expected);
  const unknown = row.turns.filter((turn) => turn.unpricedTokens > 0);
  assert.equal(unknown.length, 2);
  assert.ok(unknown.every((turn) => turn.cost === 0 && turn.unpricedTokens === LAST.totalTokens));
  const label = usageCostLabel(unknown[0].cost, unknown[0].unpricedTokens, (value) => `$${value}`, String, 'unpriced tokens');
  assert.match(label, /^—/);
  assert.equal(row.turns.filter((turn) => !turn.unpricedTokens)[0].cost, expected);
});


test('detail estimates keep known bucket prices when another used bucket has no rate', async () => {
  const { priceLocalSessionDetail } = require('../../src/shared/providers/codex/localUsage');
  const detail = { usageSource: 'codex-dots-local', totals: {}, exchanges: [{ turns: [{
    model: 'partial-price', tokens: { input: 100, cacheRead: 50, output: 10, total: 160 }
  }] }] };
  const priced = await priceLocalSessionDetail(detail, { lookupModelPricing: async () => ({ pricing: {
    inputCostPerToken: 0.01, cacheReadInputTokenCost: 0.01
  } }) });
  assert.equal(priced.totals.costUsd, 1.5);
  assert.equal(priced.totals.unpricedTokens, 10);
  assert.equal(priced.exchanges[0].turns[0].costEstimate, 1.5);
  assert.equal(priced.exchanges[0].turns[0].unpricedTokens, 10);
});

test('opening or refreshing Dots details bounds pricing work and never looks up unknown models', async () => {
  const { priceLocalSessionDetail } = require('../../src/shared/providers/codex/localUsage');
  const lookups = [];
  const makeDetail = () => ({ usageSource: 'codex-dots-local', totals: {}, exchanges: [{ turns:
    [...Array.from({ length: 20 }, (_, index) => `bounded-model-${index}`), 'unknown'].map((model) => ({ model, tokens: { input: 1, total: 1 } }))
  }] });
  const options = { lookupModelPricing: async (...args) => {
    lookups.push(args);
    return { pricing: { inputCostPerToken: 1 } };
  } };
  for (let refresh = 0; refresh < 2; refresh += 1) {
    const detail = await priceLocalSessionDetail(makeDetail(), options);
    assert.equal(detail.totals.costUsd, 16);
    assert.equal(detail.totals.unpricedTokens, 5);
  }
  assert.equal(lookups.length, 32);
  assert.ok(lookups.every(([model, timeout]) => model.startsWith('bounded-model-') && timeout === 1500));
});

test('aggregate Dots pricing bounds cold lookups, prices the remainder on later ticks and retains every token', async () => {
  const rows = [...Array.from({ length: 24 }, (_, index) => `aggregate-bounded-${index}`), 'unknown'].map((model, index) => ({
    model, threadId: `01234567-1234-1234-1234-${String(index).padStart(12, '0')}`,
    observedAt: AT, usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 10 }
  }));
  const lookups = [];
  const options = {
    pricingRevision: 'aggregate-bounded',
    lookupModelPricing: async (model, timeout) => {
      lookups.push({ model, timeout });
      return { pricing: { inputCostPerToken: 1 } };
    }
  };
  const viewOptions = { now: AT, projectsEnabled: false };
  // Duplicate/case-variant rows must not consume an extra lookup slot.
  const pricingRows = [...rows, { model: rows[0].model.toUpperCase() }];
  for (let tick = 0; tick < 6; tick += 1) {
    const before = lookups.length;
    const pricingByModel = await resolveLocalUsagePricing(pricingRows, options);
    assert.equal(lookups.length - before, 4);
    assert.equal(pricingByModel.unknown, null);
    const view = buildLocalUsageView(rows, { ...viewOptions, pricingByModel });
    for (const period of [view.today, view.month, view.allTime]) {
      assert.equal(period.totalTokens, 250);
      assert.equal(period.costUsd, (tick + 1) * 40);
      assert.equal(period.unpricedTokens, 250 - (tick + 1) * 40);
      assert.equal(Object.keys(period.sessions).length, 25);
    }
  }
  assert.equal(new Set(lookups.map(({ model }) => model)).size, 24);
  assert.ok(lookups.every(({ model, timeout }) => model !== 'unknown' && timeout === 1500));
  await resolveLocalUsagePricing(pricingRows, options);
  assert.equal(lookups.length, 24, 'warm cached models do not trigger subprocesses');

  const revised = await resolveLocalUsagePricing(pricingRows, { ...options, pricingRevision: 'aggregate-bounded-revised' });
  assert.equal(lookups.length, 28);
  const revisedView = buildLocalUsageView(rows, { ...viewOptions, pricingByModel: revised });
  assert.equal(revisedView.allTime.totalTokens, 250);
  assert.equal(revisedView.allTime.costUsd, 40, 'old-revision prices are not reused');
  assert.equal(revisedView.allTime.unpricedTokens, 210);
});

test('expired failed Dots prices rotate without starving remaining models', async (t) => {
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const rows = Array.from({ length: 24 }, (_, index) => ({ model: `aggregate-failed-${index}` }));
  const lookups = [];
  const options = {
    pricingRevision: 'aggregate-failed',
    lookupModelPricing: async (model) => { lookups.push(model); throw new Error('catalog unavailable'); }
  };
  for (let tick = 0; tick < 6; tick += 1) {
    const pricing = await resolveLocalUsagePricing(rows, options);
    assert.equal(lookups.length, (tick + 1) * 4);
    assert.equal(new Set(lookups).size, lookups.length, 'later models get queried despite expired failures');
    assert.ok(Object.values(pricing).every((price) => price === null));
    now += 30001;
  }
  await resolveLocalUsagePricing(rows, options);
  assert.deepEqual(lookups.slice(24), lookups.slice(0, 4));
});

test('pricing rotation reaches models beyond cache capacity even when prices expire between ticks', async (t) => {
  let now = 3000000;
  t.mock.method(Date, 'now', () => now);
  const rows = Array.from({ length: 300 }, (_, index) => ({ model: `aggregate-evicted-${index}` }));
  const lookups = [];
  const options = {
    pricingRevision: 'aggregate-evicted',
    lookupModelPricing: async (model) => { lookups.push(model); return { pricing: null }; }
  };
  for (let tick = 0; tick < 75; tick += 1) {
    await resolveLocalUsagePricing(rows, options);
    assert.equal(lookups.length, (tick + 1) * 4);
    now += 30001;
  }
  assert.equal(new Set(lookups).size, 300);
});

test('bounded Dots lookups preserve successful/missing cache lifetimes and explicit zero prices', async (t) => {
  let now = 2000000;
  t.mock.method(Date, 'now', () => now);
  const rows = [{ model: 'aggregate-free' }, { model: 'aggregate-missing' }, { model: 'unknown' }];
  const lookups = [];
  const free = { inputCostPerToken: 0 };
  const options = {
    pricingRevision: 'aggregate-cache-ttl', commandTimeoutMs: 250,
    lookupModelPricing: async (model, timeout) => {
      lookups.push({ model, timeout });
      return { pricing: model === 'aggregate-free' ? free : null };
    }
  };
  const first = await resolveLocalUsagePricing(rows, options);
  assert.equal(first['aggregate-free'], free);
  assert.equal(first['aggregate-missing'], null);
  assert.equal(first.unknown, null);
  now += 29999;
  await resolveLocalUsagePricing(rows, options);
  assert.equal(lookups.length, 2);
  now += 2;
  await resolveLocalUsagePricing(rows, options);
  assert.deepEqual(lookups.map(({ model }) => model), ['aggregate-free', 'aggregate-missing', 'aggregate-missing']);
  now = 2300000;
  await resolveLocalUsagePricing(rows, options);
  assert.equal(lookups.filter(({ model }) => model === 'aggregate-free').length, 2);
  assert.ok(lookups.every(({ model, timeout }) => model !== 'unknown' && timeout === 250));
});
