'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { aggregateDevices, aggregateHistory, normalizePeriod, mergePeriods, mergeSyncDeviceRecord } = require('../../src/shared/usage');
const { normalizeHistory, parseGraphResult } = require('../../src/shared/history');
const { accountingCounters } = require('../../src/shared/cursorAccountUsage');
const { hashKey } = require('../../src/shared/hashKey');
const { readCursorUsageOwnership } = require('../../src/shared/providers/cursor/usageOwnership');
const { createHub } = require('../../src/hub/server');
const { buildSyncPayload, serializeSyncPayload } = require('../../src/shared/syncPayload');

const key = hashKey('cursor', 'user_fixture');
const now = Date.now();
function period(client, tokens, cost) {
  return normalizePeriod({ totalTokens: tokens, costUsd: cost, outputTokens: tokens,
    clients: { [client]: tokens }, clientCosts: { [client]: cost }, clientOutputs: { [client]: tokens },
    models: { shared: tokens }, modelCosts: { shared: cost }, modelOutputs: { shared: tokens },
    clientModels: { [client]: { shared: tokens } }, clientModelCosts: { [client]: { shared: cost } },
    sessions: { [`${client}:s`]: { client, sessionId: 's', totalTokens: tokens, costUsd: cost, outputTokens: tokens,
      models: { shared: tokens }, modelCosts: { shared: cost } } } });
}
function record(deviceId, tokens, age, accountKey = key) {
  const cursor = period('cursor', tokens, tokens / 1000);
  const combined = mergePeriods(cursor, period('codex', 100, 0.1));
  combined.cursorAccountUsage = { accountKey, observedAt: new Date(now - age).toISOString(), range: 'fixture-range',
    usage: accountingCounters(cursor) };
  return { deviceId, updatedAt: new Date(now).toISOString(), today: combined, month: combined, allTime: combined };
}

test('same account picks one complete Cursor observation, while other clients remain additive', () => {
  for (const devices of [[record('A', 1000, 2000), record('B', 1200, 1000)],
    [record('B', 1200, 1000), record('A', 1000, 2000)]]) {
    const stats = aggregateDevices(devices, 0);
    for (const p of Object.values(stats.periods)) {
      assert.equal(p.totalTokens, 1400);
      assert.equal(p.costUsd, 1.4);
      assert.equal(p.clients.cursor, 1200);
      assert.equal(p.clients.codex, 200);
      assert.equal(p.models.shared, 1400);
      assert.equal(p.outputTokens, 1400);
      assert.equal(p.sessions['cursor:s'].totalTokens, 1200);
      assert.equal(p.sessions['codex:s'].totalTokens, 200);
    }
    assert.equal(stats.devices[0].periods.today.clients.cursor, 1000);
  }
});

test('fresh corrected lower totals win; distinct accounts, ranges and unknown identity stay additive', () => {
  assert.equal(aggregateDevices([record('A', 1200, 2000), record('B', 1000, 1000)], 0).periods.today.clients.cursor, 1000);
  const b = record('B', 1000, 1000, hashKey('cursor', 'user_other'));
  assert.equal(aggregateDevices([record('A', 1000, 2000), b], 0).periods.today.clients.cursor, 2000);
  b.today.cursorAccountUsage.accountKey = key;
  b.today.cursorAccountUsage.range = 'different-window';
  assert.equal(aggregateDevices([record('A', 1000, 2000), b], 0).periods.today.clients.cursor, 2000);
  delete b.today.cursorAccountUsage;
  assert.equal(aggregateDevices([record('A', 1000, 2000), b], 0).periods.today.clients.cursor, 2000);
});

test('archive residue stays counted and a limits-only update retains usage provenance', () => {
  const a = record('A', 1000, 2000);
  const residue = period('cursor', 50, 0.05);
  residue.sessions = { 'cursor:old': { ...residue.sessions['cursor:s'], sessionId: 'old', archived: true } };
  a.today = mergePeriods(a.today, residue);
  a.today.cursorAccountUsage = record('source', 1000, 2000).today.cursorAccountUsage;
  const retained = mergeSyncDeviceRecord(a, { deviceId: 'A', limitsOnly: true, limits: { providers: [] } });
  const stats = aggregateDevices([retained, record('B', 1200, 1000)], 0);
  assert.equal(stats.periods.today.clients.cursor, 1250);
  assert.equal(stats.periods.today.sessions['cursor:old'].totalTokens, 50);
});

test('untrusted oversized contribution is rejected before it can subtract another client', () => {
  const a = record('A', 1000, 2000);
  a.today.cursorAccountUsage.usage.clients.codex = 100;
  assert.equal(aggregateDevices([a, record('B', 1000, 1000)], 0).periods.today.clients.cursor, 2000);
});

test('ownership follows cache owner, survives logout, and distinguishes account sets and refuses unowned legacy caches', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'usage.json');
  const write = (id, generation = 'fixture') => fs.writeFileSync(file, JSON.stringify({
    _owner: { version: 1, ownerHash: crypto.createHash('sha256').update(id).digest('hex'), generation },
    _tokscale: { version: 1, accountId: id }, usageEventsDisplay: [], zzTokscaleOwner: { version: 1, generation }
  }));
  write('user_fixture');
  assert.equal(readCursorUsageOwnership({ cacheDir: dir }).accountKey, key);
  // No credential store exists: archived source identity remains authoritative.
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.copyFileSync(file, path.join(dir, 'archive', 'usage.old.json'));
  assert.equal(readCursorUsageOwnership({ cacheDir: dir }).accountKey, key);
  write('user_other');
  const combined = readCursorUsageOwnership({ cacheDir: dir }).accountKey;
  assert.notEqual(combined, key);
  assert.notEqual(combined, hashKey('cursor', 'user_other'));
  fs.writeFileSync(file, '{"usageEventsDisplay":[]}');
  assert.equal(readCursorUsageOwnership({ cacheDir: dir }), null);
});

test('Node ingest and Worker HTTP share account dedup and public stats omit identity', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-hub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const node = createHub({ dataFile: path.join(dir, 'hub.json'), persistIntervalMs: 0 });
  t.after(() => node.stop());
  const { HubDO } = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')));
  const stored = new Map();
  const worker = new HubDO({ storage: {
    async get(k) { return stored.get(k); }, async put(k, v) { stored.set(k, structuredClone(v)); },
    async list({ prefix }) { return new Map([...stored].filter(([k]) => k.startsWith(prefix))); }
  } }, { PUBLIC_STATS_ENABLED: '1', TOKEN_MONITOR_SECRET: 'fixture-secret' });
  for (const row of [record('A', 1000, 2000), record('B', 1200, 1000)]) {
    const body = buildSyncPayload(row);
    node.ingest(body);
    assert.equal((await worker.fetch(new Request('https://fixture.invalid/api/ingest', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-secret' }, body: JSON.stringify(body)
    }))).status, 200);
  }
  assert.equal(node.getStats().periods.allTime.totalTokens, 1400);
  const stats = await (await worker.fetch(new Request('https://fixture.invalid/api/stats', { headers: { authorization: 'Bearer fixture-secret' } }))).json();
  assert.equal(stats.periods.allTime.totalTokens, 1400);
  const publicStats = await (await worker.fetch(new Request('https://fixture.invalid/api/public/stats'))).json();
  assert.doesNotMatch(JSON.stringify(publicStats), /cursorAccountUsage|sha256:/);
});

test('collector reuses cache ownership and existing scans, including History and watch deltas', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-collector-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.config/tokscale/cursor-cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ _tokscale: { version: 1, accountId: 'user_fixture' }, usageEventsDisplay: [] }));
  t.mock.method(require('../../src/shared/providers/cursor/auth'), 'runCursorSync', async () => ({ synced: true }));
  const { collectUsageOnce } = require('../../src/shared/collector');
  const date = new Date().toLocaleDateString('en-CA');
  const graph = { contributions: [{ date, clients: [{ client: 'cursor', modelId: 'shared', tokens: { input: 1000 }, cost: 1 }] }] };
  let scans = 0;
  let captured;
  const options = { clients: 'cursor,codex', homeDir: home, env: {}, osInfo: {}, deviceId: 'A',
    allTimeSince: '2024-01-01', includeHistory: true, dailyHistoryArchiveEnabled: false,
    runTokscale: async (input) => { scans++; if (input.clients === 'codex') return { entries: [] }; return { entries: [{ client: 'cursor', sessionId: 's', model: 'shared', totalTokens: 1000, costUsd: 1 }] }; },
    runGraph: async () => graph,
    onAnchorComputed: value => { captured = value; } };
  const a = await collectUsageOnce(options);
  assert.equal(scans, 3);
  assert.equal(a.today.cursorAccountUsage.accountKey, key);
  const b = { ...a, deviceId: 'B' };
  assert.equal(aggregateDevices([a, b], 0).periods.allTime.totalTokens, 1000);
  assert.equal(aggregateHistory([a, b]).summary.totalTokens, 1000);
  assert.equal(a.history.cursorAccountUsage.accountKey, key);
  const anchor = { ...captured.windowsPeriods, dateKey: date, todayPartitions: { ...captured.todayPartitions, codex: normalizePeriod({}) } };
  const watch = await collectUsageOnce({ ...options, includeHistory: false, todayOnlyAnchor: anchor });
  assert.equal(scans, 4);
  assert.equal(watch.month.cursorAccountUsage.accountKey, key);
  assert.equal(aggregateDevices([watch, b], 0).periods.month.totalTokens, 1000);
  const changed = new Date();
  fs.utimesSync(path.join(dir, 'usage.json'), changed, changed);
  const codexTick = await collectUsageOnce({ ...options, includeHistory: false, todayOnlyAnchor: anchor, targetClients: ['codex'] });
  assert.equal(scans, 5);
  assert.equal(codexTick.today.cursorAccountUsage.observedAt, anchor.today.cursorAccountUsage.observedAt);
});

test('History selects one account contribution while retaining other tools and unknown archive residue', () => {
  const date = new Date().toLocaleDateString('en-CA');
  const makeHistory = (cursorTokens) => normalizeHistory(parseGraphResult({ contributions: [{ date, clients: [
    { client: 'cursor', modelId: 'shared', tokens: { input: cursorTokens }, cost: cursorTokens / 1000 },
    { client: 'codex', modelId: 'shared', tokens: { input: 100 }, cost: 0.1 }
  ] }] }));
  const records = [record('A', 1000, 2000), record('B', 1200, 1000)];
  for (const [i, r] of records.entries()) {
    const tokens = i ? 1200 : 1000;
    r.history = makeHistory(tokens + (i ? 0 : 50));
    r.history.cursorAccountUsage = { accountKey: key, range: 'all-history', observedAt: new Date(now - (i ? 1000 : 2000)).toISOString(),
      usage: normalizeHistory(parseGraphResult({ contributions: [{ date, clients: [
        { client: 'cursor', modelId: 'shared', tokens: { input: tokens }, cost: tokens / 1000 }
      ] }] })) };
  }
  const history = aggregateHistory(records);
  assert.equal(history.summary.totalTokens, 1450);
  assert.equal(history.daily.at(-1).perClient.cursor.tokens, 1250);
  assert.equal(history.daily.at(-1).perClient.codex.tokens, 200);
  assert.equal(history.daily.at(-1).perModel.shared.tokens, 1450);
});

test('payload budget drops account hints before evicting ordinary session details', () => {
  const source = record('A', 1000, 2000);
  const without = serializeSyncPayload(source, { omitAccountUsage: true, maxBytes: Number.MAX_SAFE_INTEGER });
  const compact = serializeSyncPayload(source, { maxBytes: without.bytes });
  assert.equal(compact.payload.today.cursorAccountUsage, undefined);
  assert.equal(compact.payload.today.sessions['cursor:s'].totalTokens, 1000);
  assert.equal(source.today.cursorAccountUsage.accountKey, key);
});

test('fixed ranges deduplicate the selected daily observation while keeping device cards intact', () => {
  const ranges = require('../../src/electron/renderer/fixedPeriodRanges');
  const { computePeriodWindows } = require('../../src/shared/collector');
  const windows = computePeriodWindows(new Date());
  const records = [record('A', 1300, 500), record('B', 1200, 1000)];
  for (const [index, r] of records.entries()) {
    const tokens = index ? 1200 : 1000;
    r.periodWindows = windows;
    r.historyAvailable = true;
    r.history = normalizeHistory(parseGraphResult({ contributions: [{ date: windows.today.key, clients: [
      { client: 'cursor', modelId: 'shared', tokens: { output: tokens }, cost: tokens / 1000 },
      { client: 'codex', modelId: 'shared', tokens: { output: 100 }, cost: 0.1 }
    ] }] }));
    r.history.cursorAccountUsage = { accountKey: key, range: 'all-history', observedAt: new Date(now - (index ? 500 : 2000)).toISOString(),
      usage: normalizeHistory(parseGraphResult({ contributions: [{ date: windows.today.key, clients: [
        { client: 'cursor', modelId: 'shared', tokens: { output: tokens }, cost: tokens / 1000 }
      ] }] })) };
  }
  for (const selection of ['week', 'last7', 'last30']) {
    const snapshot = ranges.fixedPeriodSnapshotFromDevices(selection, records, { now: new Date(), historyAvailable: true });
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.period.totalTokens, 1500);
    assert.equal(snapshot.period.clients.cursor, 1300);
    assert.equal(snapshot.period.clients.codex, 200);
    assert.equal(snapshot.devices[0].period.totalTokens, 1400);
    assert.equal(snapshot.devices[1].period.totalTokens, 1300);
  }
});

test('History ownership survives old-day component reduction without classifying unknown residue', () => {
  const date = new Date(Date.now() - 40 * 86400000).toLocaleDateString('en-CA');
  const make = (client, tokens) => ({ client, modelId: 'shared', tokens: { input: tokens }, cost: tokens / 1000 });
  const records = [record('A', 1000, 2000), record('B', 1000, 1000)];
  for (const row of records) {
    row.periodWindows = require('../../src/shared/collector').computePeriodWindows(new Date());
    row.history = normalizeHistory(parseGraphResult({ contributions: [{ date, clients: [make('cursor', 1000), make('codex', 100)] }] }));
    row.history.cursorAccountUsage = { ...row.today.cursorAccountUsage,
      usage: normalizeHistory(parseGraphResult({ contributions: [{ date, clients: [make('cursor', 1000)] }] })) };
  }
  const history = aggregateHistory(records.map(row => buildSyncPayload(row)));
  assert.equal(history.summary.totalTokens, 1200);
  assert.equal(history.daily[0].perClient.codex.tokens, 200);
  assert.equal(history.daily[0].unclassifiedTokens, 1200);
});
