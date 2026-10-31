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
    runTokscale: async (input) => { input.onScanComplete(input.clients.split(',')); scans++; if (input.clients === 'codex') return { entries: [] }; return { entries: [{ client: 'cursor', sessionId: 's', model: 'shared', totalTokens: 1000, costUsd: 1 }] }; },
    runGraph: async input => { input.onScanComplete(input.clients.split(',')); return graph; },
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

async function watchFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-review-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.config/tokscale/cursor-cache');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'usage.json');
  const writeOwner = (id, age) => {
    fs.writeFileSync(file, JSON.stringify({ _tokscale: { version: 1, accountId: id }, usageEventsDisplay: [] }));
    const time = new Date(Date.now() - age);
    fs.utimesSync(file, time, time);
  };
  writeOwner('user_fixture', 10000);
  t.mock.method(require('../../src/shared/providers/cursor/auth'), 'runCursorSync', async () => ({ synced: true }));
  const { collectUsageOnce } = require('../../src/shared/collector');
  let captured;
  let broadTokens = 1000;
  let onScan = () => {};
  const options = { clients: 'cursor,codex', homeDir: home, env: {}, osInfo: {}, deviceId: 'A',
    allTimeSince: '2024-01-01', historyEnabled: false,
    runTokscale: async input => {
      input.onScanComplete(input.clients.split(','));
      onScan();
      if (input.clients === 'codex') return { entries: [] };
      const tokens = input.flags.includes('--today') ? 100 : broadTokens;
      return { entries: [{ client: 'cursor', sessionId: 's', model: 'shared', totalTokens: tokens, costUsd: tokens / 1000 }] };
    }, onAnchorComputed: value => { captured = value; } };
  const first = await collectUsageOnce(options);
  const anchor = { ...captured.windowsPeriods, dateKey: new Date().toLocaleDateString('en-CA'),
    todayPartitions: { ...captured.todayPartitions, codex: normalizePeriod({}) } };
  return { first, anchor, writeOwner, file, collect: extra => collectUsageOnce({ ...options, ...extra }),
    setBroad: value => { broadTokens = value; }, setOnScan: value => { onScan = value; } };
}

test('Today-only cache refresh cannot outrank a newer complete Month or All Time scan', async t => {
  const f = await watchFixture(t);
  f.writeOwner('user_fixture', 6000);
  f.setBroad(1200);
  const b = { ...await f.collect({ deviceId: 'B' }) };
  f.writeOwner('user_fixture', 2000);
  const a = await f.collect({ todayOnlyAnchor: f.anchor });
  for (const name of ['month', 'allTime']) {
    assert.equal(a[name].totalTokens, 1000);
    assert.equal(aggregateDevices([a, b], 0).periods[name].clients.cursor, 1200);
    assert.equal(a[name].cursorAccountUsage.observedAt, f.first[name].cursorAccountUsage.observedAt);
  }
  assert.notEqual(a.today.cursorAccountUsage.observedAt, f.first.today.cursorAccountUsage.observedAt);
  f.setBroad(900);
  const corrected = await f.collect({ deviceId: 'A' });
  assert.equal(aggregateDevices([corrected, b], 0).periods.month.clients.cursor, 900);
});

test('ownership switch, invalidation and scan-time cache change clear inherited broad scopes', async t => {
  const f = await watchFixture(t);
  f.writeOwner('user_other', 2000);
  const switched = await f.collect({ todayOnlyAnchor: f.anchor });
  assert.notEqual(switched.today.cursorAccountUsage.accountKey, key);
  for (const name of ['month', 'allTime']) assert.equal(switched[name].cursorAccountUsage, undefined);
  fs.writeFileSync(f.file, '{"usageEventsDisplay":[]}');
  const invalid = await f.collect({ todayOnlyAnchor: f.anchor });
  for (const name of ['today', 'month', 'allTime']) assert.equal(invalid[name].cursorAccountUsage, undefined);
  f.writeOwner('user_fixture', 2000);
  f.setOnScan(() => f.writeOwner('user_other', 1000));
  const changed = await f.collect({ todayOnlyAnchor: f.anchor });
  for (const name of ['today', 'month', 'allTime']) assert.equal(changed[name].cursorAccountUsage, undefined);
});

test('targeted ticks never mutate shared account counters or the original anchor', async t => {
  const f = await watchFixture(t);
  const before = JSON.stringify(f.anchor);
  Object.freeze(f.anchor.today.cursorAccountUsage.usage);
  for (let index = 0; index < 2; index++) {
    await f.collect({ todayOnlyAnchor: f.anchor, targetClients: ['codex'] });
    assert.equal(JSON.stringify(f.anchor), before);
  }
});

test('account evidence omission covers top-level and nested periods without mutating input', () => {
  const source = record('A', 1000, 2000);
  source.periods = { today: source.today, month: source.month, allTime: source.allTime };
  const before = JSON.stringify(source);
  const payload = buildSyncPayload(source, { omitAccountUsage: true });
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(payload[name].cursorAccountUsage, undefined);
    assert.equal(payload.periods[name].cursorAccountUsage, undefined);
    assert.equal(payload.periods[name].totalTokens, 1100);
  }
  assert.equal(JSON.stringify(source), before);
});

test('HTTP 413 retries once without account evidence even below the local size budget', async () => {
  const { postSyncPayload } = require('../../src/shared/syncPayload');
  const source = record('A', 1000, 2000);
  source.periods = { today: source.today, month: source.month, allTime: source.allTime };
  const bodies = [];
  const result = await postSyncPayload(async (_url, options) => {
    bodies.push(options.body);
    return { status: bodies.length === 1 ? 413 : 200, async arrayBuffer() {} };
  }, 'https://fixture.invalid/api/ingest', { summary: source });
  assert.equal(result.retried, true);
  assert.equal(bodies.length, 2);
  assert.ok(Buffer.byteLength(bodies[1]) < Buffer.byteLength(bodies[0]));
  assert.doesNotMatch(bodies[1], /cursorAccountUsage/);
  assert.equal(JSON.parse(bodies[1]).today.totalTokens, 1100);
});

test('fixed ranges admit a missing account day as zero while retaining unrelated usage and archive residue', () => {
  const ranges = require('../../src/electron/renderer/fixedPeriodRanges');
  const { computePeriodWindows } = require('../../src/shared/collector');
  // Tuesday keeps yesterday inside all three fixed ranges, including Week.
  const clock = new Date(2026, 9, 27, 12);
  const windows = computePeriodWindows(clock);
  const yesterday = new Date(2026, 9, 26, 12).toLocaleDateString('en-CA');
  const bucket = (date, cursor, codex = 0) => ({ date, clients: [
    { client: 'cursor', modelId: 'shared', tokens: { input: cursor }, cost: cursor / 1000 },
    ...(codex ? [{ client: 'codex', modelId: 'shared', tokens: { input: codex }, cost: codex / 1000 }] : [])
  ] });
  const history = rows => normalizeHistory(parseGraphResult({ contributions: rows }), { todayKey: windows.today.key });
  const a = { ...record('A', 1, 2000), periodWindows: windows, historyAvailable: true };
  const b = { ...record('B', 1, 1000), periodWindows: windows, historyAvailable: true };
  for (const row of [a, b]) {
    row.today = period('cursor', 1, 0.001);
    row.today.cursorAccountUsage = { ...row.month.cursorAccountUsage, usage: accountingCounters(row.today) };
  }
  a.history = history([bucket(yesterday, 105, 20), bucket(windows.today.key, 1)]);
  b.history = history([bucket(windows.today.key, 1)]);
  a.history.cursorAccountUsage = { ...a.today.cursorAccountUsage, range: `history:${windows.timeZone}`,
    usage: history([bucket(yesterday, 100), bucket(windows.today.key, 1)]) };
  b.history.cursorAccountUsage = { ...b.today.cursorAccountUsage, range: `history:${windows.timeZone}`,
    usage: history([bucket(windows.today.key, 1)]) };
  for (const selection of ['week', 'last7', 'last30']) {
    const result = ranges.fixedPeriodSnapshotFromDevices(selection, [a, b], { now: clock, historyAvailable: true });
    assert.equal(result.status, 'ready');
    assert.equal(result.period.totalTokens, 26);
    assert.equal(result.period.clients.cursor, 6);
    assert.equal(result.period.clients.codex, 20);
    assert.equal(result.devices[0].period.totalTokens, 126);
    assert.equal(result.devices[1].period.totalTokens, 1);
  }
});

test('fixed ranges admit a complete all-zero source but never treat missing evidence as a correction', () => {
  const ranges = require('../../src/electron/renderer/fixedPeriodRanges');
  const { computePeriodWindows } = require('../../src/shared/collector');
  const clock = new Date(2026, 9, 27, 12);
  const windows = computePeriodWindows(clock);
  const history = (tokens, codex = 0) => normalizeHistory(parseGraphResult({ contributions: tokens || codex ? [{
    date: '2026-10-26', clients: [
      { client: 'cursor', modelId: 'shared', tokens: { input: tokens }, cost: tokens / 1000 },
      ...(codex ? [{ client: 'codex', modelId: 'shared', tokens: { input: codex }, cost: codex / 1000 }] : [])
    ]
  }] : [] }), { todayKey: windows.today.key });
  const a = { ...record('A', 101, 2000), periodWindows: windows, historyAvailable: true };
  const b = { ...record('B', 0, 1000), periodWindows: windows, historyAvailable: true };
  for (const row of [a, b]) {
    for (const name of ['today', 'month', 'allTime']) row[name] = normalizePeriod({});
  }
  // Retain five unowned Cursor tokens plus twenty from Codex.
  a.history = history(106, 20);
  a.history.cursorAccountUsage = { ...record('A', 101, 2000).today.cursorAccountUsage, range: `history:${windows.timeZone}`, usage: history(101) };
  b.history = history(0);
  b.history.cursorAccountUsage = { ...record('B', 0, 1000).today.cursorAccountUsage, range: `history:${windows.timeZone}`, usage: history(0) };
  for (const selection of ['week', 'last7', 'last30']) {
    for (const sources of [[a, b], [b, a]]) {
      const result = ranges.fixedPeriodSnapshotFromDevices(selection, sources, { now: clock, historyAvailable: true });
      assert.equal(result.status, 'ready');
      assert.equal(result.period.totalTokens, 25);
      assert.ok(Math.abs(result.period.costUsd - 0.025) < 1e-8);
      assert.equal(result.period.clients.cursor, 5);
      assert.equal(result.period.clients.codex, 20);
      assert.equal(result.devices.find(row => row.deviceId === 'A').period.totalTokens, 126);
      assert.equal(result.devices.find(row => row.deviceId === 'B').period.totalTokens, 0);
    }
    const unowned = structuredClone(b);
    delete unowned.history.cursorAccountUsage;
    assert.equal(ranges.fixedPeriodSnapshotFromDevices(selection, [a, unowned], { now: clock, historyAvailable: true }).period.totalTokens, 126);
    const incompatible = structuredClone(b);
    incompatible.history.cursorAccountUsage.accountKey = hashKey('cursor', 'another-user');
    assert.equal(ranges.fixedPeriodSnapshotFromDevices(selection, [a, incompatible], { now: clock, historyAvailable: true }).period.totalTokens, 126);
    assert.equal(ranges.fixedPeriodSnapshotFromDevices(selection, [a, { ...b, historyAvailable: false }], { now: clock }).status, 'unavailable');
  }
});

test('collector calendar ranges survive DST and separate zones with different month boundaries', async t => {
  const original = process.env.TZ;
  t.after(() => { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; });
  process.env.TZ = 'Europe/London';
  const f = await watchFixture(t);
  const before = await f.collect({ now: new Date('2026-10-22T12:00:00Z') });
  f.writeOwner('user_fixture', 5000);
  f.setBroad(1200);
  const after = await f.collect({ now: new Date('2026-10-30T12:00:00Z'), deviceId: 'B' });
  const earlyDay = await f.collect({ now: new Date('2026-10-25T00:30:00Z') });
  const lateDay = await f.collect({ now: new Date('2026-10-25T12:00:00Z') });
  process.env.TZ = 'Africa/Abidjan';
  const other = await f.collect({ now: new Date('2026-10-30T12:00:00Z'), deviceId: 'C' });
  await t.test('same month across DST still deduplicates', () => {
    assert.equal(before.month.cursorAccountUsage.range, after.month.cursorAccountUsage.range);
    assert.equal(aggregateDevices([before, after], 0, Date.parse('2026-10-30T12:00:00Z')).periods.month.clients.cursor, 1200);
  });
  await t.test('same day across DST retains one range', () => {
    assert.equal(earlyDay.today.cursorAccountUsage.range, lateDay.today.cursorAccountUsage.range);
  });
  await t.test('equal current offsets with different month starts remain additive', () => {
    assert.notEqual(after.month.cursorAccountUsage.range, other.month.cursorAccountUsage.range);
    assert.equal(aggregateDevices([after, other], 0, Date.parse('2026-10-30T12:00:00Z')).periods.month.clients.cursor, 2400);
  });
  await t.test('equivalent daily boundaries in different zones remain compatible', () => {
    assert.equal(after.today.cursorAccountUsage.range, other.today.cursorAccountUsage.range);
  });
});

function calendarRecord(deviceId, timeZone, date, live = false, rawModel = 'shared') {
  const day = '2026-10-30';
  const row = record(deviceId, 1000, deviceId === 'A' ? 2000 : 1000);
  row.periodWindows = { timeZone, today: { key: day, endsAt: '2026-10-31T00:00:00.000Z' } };
  row.historyAvailable = true;
  row.history = normalizeHistory(parseGraphResult({ contributions: [{ date, clients: [
    { client: 'cursor', modelId: rawModel, tokens: { input: 1000 }, cost: 1 }
  ] }] }), { todayKey: day });
  row.history.cursorAccountUsage = { ...row.today.cursorAccountUsage, range: `history:${timeZone}`, usage: structuredClone(row.history) };
  row.today = live ? normalizePeriod({ totalTokens: 1000, costUsd: 1, clients: { cursor: 1000 }, clientCosts: { cursor: 1 },
    models: { [rawModel]: 1000 }, modelCosts: { [rawModel]: 1 },
    clientModels: { cursor: { [rawModel]: 1000 } }, clientModelCosts: { cursor: { [rawModel]: 1 } } }) : normalizePeriod({});
  if (live) row.today.cursorAccountUsage = { ...row.month.cursorAccountUsage,
    range: 'today:2026-10-30T00:00:00.000Z:2026-10-31T00:00:00.000Z', usage: accountingCounters(row.today) };
  return row;
}

test('fixed ranges compare actual daily boundaries across timezone names and DST', () => {
  const ranges = require('../../src/electron/renderer/fixedPeriodRanges');
  const clock = new Date('2026-10-30T12:00:00Z');
  for (const live of [false, true]) {
    for (const selection of ['week', 'last7', 'last30']) {
      const a = calendarRecord('A', 'Europe/London', '2026-10-30', live);
      const b = calendarRecord('B', 'Africa/Abidjan', '2026-10-30', live);
      const result = ranges.fixedPeriodSnapshotFromDevices(selection, [a, b], { now: clock, historyAvailable: true });
      assert.equal(result.period.totalTokens, 1000);
      assert.equal(result.period.costUsd, 1);
      assert.deepEqual(result.devices.map(device => device.period.totalTokens), [1000, 1000]);
    }
  }
  for (const [date, otherZone, expected] of [
    ['2026-10-25', 'Africa/Abidjan', 2000], // London has a 25-hour day.
    ['2026-10-25', 'Europe/Belfast', 1000],
    ['2026-03-29', 'Africa/Abidjan', 2000], // London has a 23-hour day.
    ['2026-03-29', 'Europe/Belfast', 1000],
    ['2026-10-29', 'Asia/Tokyo', 2000],
    ['2026-10-29', 'Invalid/Zone', 2000],
    ['2026-10-29', '', 2000]
  ]) {
    const a = calendarRecord('A', 'Europe/London', date);
    const b = calendarRecord('B', otherZone, date);
    // Keep the tested historical day inside all three selected ranges.
    const today = new Date(`${date}T12:00:00Z`);
    for (const row of [a, b]) row.periodWindows.today = { key: date, endsAt: new Date(today.getTime() + 86400000).toISOString() };
    for (const selection of ['week', 'last7', 'last30']) {
      const result = ranges.fixedPeriodSnapshotFromDevices(selection, [a, b], { now: today, historyAvailable: true });
      assert.equal(result.period.totalTokens, expected, `${date} ${otherZone} ${selection}`);
    }
  }
});

test('model alias projection keeps fixed-range account model contributions aligned without mutating raw records', () => {
  const { projectModelAliasStats, projectModelAliasHistory } = require('../../src/electron/modelAliasPresentation');
  const ranges = require('../../src/electron/renderer/fixedPeriodRanges');
  for (const live of [false, true]) {
    for (const [rawModel, aliases, options, display] of [
      ['shared', { shared: 'display-model' }, {}, 'display-model'],
      ['anthropic/claude-opus-5', {}, { grouping: 'prefix' }, 'claude-opus-5']
    ]) {
      const records = ['A', 'B'].map(id => calendarRecord(id, 'Europe/London', '2026-10-30', live, rawModel));
      const raw = JSON.stringify(records);
      const stats = projectModelAliasStats({ devices: records }, aliases, options);
      const histories = projectModelAliasHistory({ deviceHistories: records.map(row => ({
        ...row, periods: { today: row.today }
      })) }, aliases, options);
      for (const devices of [stats.devices, histories.deviceHistories]) {
        for (const selection of ['week', 'last7', 'last30']) {
          const result = ranges.fixedPeriodSnapshotFromDevices(selection, devices, { now: new Date('2026-10-30T12:00:00Z'), historyAvailable: true });
          assert.equal(result.period.totalTokens, 1000);
          assert.equal(result.period.models[display], 1000);
          assert.equal(result.period.modelCosts[display], 1);
        }
      }
      assert.equal(JSON.stringify(records), raw);
      assert.strictEqual(projectModelAliasStats({ devices: records }, { absent: 'other' }).devices, records);
    }
  }
});

test('collector uploads a complete owned empty graph to replace Hub History, but failures never clear it', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-empty-history-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.config/tokscale/cursor-cache');
  fs.mkdirSync(dir, { recursive: true });
  const cache = path.join(dir, 'usage.json');
  const writeOwner = (owned, age) => {
    fs.writeFileSync(cache, JSON.stringify({ ...(owned ? { _tokscale: { version: 1, accountId: 'user_fixture' } } : {}), usageEventsDisplay: [] }));
    const time = new Date(Date.now() - age);
    fs.utimesSync(cache, time, time);
  };
  writeOwner(true, 10000);
  t.mock.method(require('../../src/shared/providers/cursor/auth'), 'runCursorSync', async () => ({ synced: true }));
  const { collectUsageOnce } = require('../../src/shared/collector');
  const hub = createHub({ dataFile: path.join(home, 'hub.json'), persistIntervalMs: 0 });
  t.after(() => hub.stop());
  const date = new Date().toLocaleDateString('en-CA');
  const fullGraph = { contributions: [{ date, clients: [{ client: 'cursor', modelId: 'shared', tokens: { input: 1000 }, cost: 1 }] }] };
  const options = { clients: 'cursor', homeDir: home, env: {}, osInfo: {}, deviceId: 'A', allTimeSince: '2024-01-01',
    includeHistory: true, dailyHistoryArchiveEnabled: false,
    runTokscale: async input => { input.onScanComplete(input.clients.split(',')); return { entries: [] }; } };
  const previous = await collectUsageOnce({ ...options, runGraph: async input => { input.onScanComplete(input.clients.split(',')); return fullGraph; } });
  hub.ingest(buildSyncPayload(previous));
  assert.equal(hub.getHistory().summary.totalTokens, 1000);
  for (const runGraph of [
    async () => { throw new Error('synthetic scan failure'); },
    async () => ({}),
    async () => { writeOwner(false, 4000); return { contributions: [] }; }
  ]) {
    writeOwner(true, 5000);
    const failed = await collectUsageOnce({ ...options, runGraph });
    assert.equal(Object.hasOwn(failed, 'history'), false);
    hub.ingest(buildSyncPayload(failed));
    assert.equal(hub.getHistory().summary.totalTokens, 1000);
  }
  for (const archiveEnabled of [false, true]) {
    writeOwner(true, 2000);
    const empty = await collectUsageOnce({ ...options, dailyHistoryArchiveEnabled: archiveEnabled,
      dailyHistoryArchiveOptions: { path: path.join(home, 'empty-history.json') },
      runGraph: async input => { input.onScanComplete(input.clients.split(',')); return { contributions: [] }; } });
    assert.equal(empty.history?.summary.totalTokens, 0);
    assert.equal(empty.history.cursorAccountUsage.accountKey, key);
    assert.equal(empty.history.cursorAccountUsage.usage.daily.length, 0);
    // A newer zero observation also supersedes a different device's stale snapshot.
    const other = { ...empty, deviceId: 'B' };
    assert.equal(aggregateHistory([previous, other]).summary.totalTokens, 0);
    hub.ingest(buildSyncPayload(empty));
    assert.equal(hub.getHistory().summary.totalTokens, 0);
  }
});

test('retained History uses its recorded timezone after a history-less device timezone change', () => {
  const ranges = require('../../src/electron/renderer/fixedPeriodRanges');
  const date = '2026-10-29';
  const original = calendarRecord('A', 'Europe/London', date);
  const moved = mergeSyncDeviceRecord(original, { deviceId: 'A', updatedAt: new Date().toISOString(), historyAvailable: true,
    periodWindows: { timeZone: 'Asia/Tokyo', today: { key: '2026-10-30', endsAt: '2026-10-30T15:00:00.000Z' } }
  });
  assert.equal(moved.history.cursorAccountUsage.range, 'history:Europe/London');
  for (const [timeZone, expected] of [['Asia/Tokyo', 2000], ['Africa/Abidjan', 1000]]) {
    const other = calendarRecord('B', timeZone, date);
    for (const selection of ['week', 'last7', 'last30']) {
      const result = ranges.fixedPeriodSnapshotFromDevices(selection, [moved, other], {
        now: new Date('2026-10-30T12:00:00Z'), historyAvailable: true
      });
      assert.equal(result.period.totalTokens, expected, `${timeZone} ${selection}`);
      assert.deepEqual(result.devices.map(row => row.period.totalTokens), [1000, 1000]);
    }
  }
  for (const range of ['legacy-range', 'history:Invalid/Zone']) {
    const unknown = structuredClone(moved);
    unknown.history.cursorAccountUsage.range = range;
    for (const selection of ['week', 'last7', 'last30']) {
      const result = ranges.fixedPeriodSnapshotFromDevices(selection, [unknown, calendarRecord('B', 'Asia/Tokyo', date)], {
        now: new Date('2026-10-30T12:00:00Z'), historyAvailable: true
      });
      assert.equal(result.period.totalTokens, 2000, `${range} ${selection}`);
    }
  }
});

test('a rejected targeted Cursor partition never survives the selected full-scan fallback', async t => {
  const f = await watchFixture(t);
  const before = JSON.stringify(f.anchor);
  for (const attributed of [false, true]) {
    let scans = 0;
    const result = await f.collect({ todayOnlyAnchor: f.anchor, targetClients: ['cursor'],
      runTokscale: async input => {
        input.onScanComplete(input.clients.split(','));
        scans++;
        return { entries: scans === 1 ? [
          { client: 'cursor', sessionId: 's', model: 'shared', totalTokens: 600, costUsd: 0.6 },
          { client: 'codex', sessionId: 'c', model: 'shared', totalTokens: 20, costUsd: 0.02 }
        ] : [
          { client: 'cursor', sessionId: 's', model: 'shared', totalTokens: 1000, costUsd: 1 },
          ...(attributed ? [] : [{ totalTokens: 100, costUsd: 0.1, model: 'shared' }])
        ] };
      } });
    assert.equal(scans, 2);
    if (attributed) {
      assert.equal(result.today.cursorAccountUsage.usage.totalTokens, 1000);
    } else {
      for (const name of ['today', 'month', 'allTime']) assert.equal(result[name].cursorAccountUsage, undefined, name);
      const other = record('B', 800, 20000);
      assert.equal(aggregateDevices([result, other], 0).periods.today.totalTokens, 2000);
    }
    assert.equal(JSON.stringify(f.anchor), before);
  }
});

test('daily winners compete across date labels for the same UTC window, including zero corrections', () => {
  const ranges = require('../../src/electron/renderer/fixedPeriodRanges');
  const clock = new Date('2026-10-31T00:00:00Z');
  const boundary = '2026-10-30T10:00:00.000Z:2026-10-31T10:00:00.000Z';
  for (const live of [false, true]) {
    for (const latestTokens of [1000, 0]) {
      const sources = [
        ['A', 'Pacific/Kiritimati', '2026-10-31', 1000, 5, 20, 2000],
        ['B', 'Pacific/Honolulu', '2026-10-30', latestTokens, 0, 0, 1000]
      ].map(([deviceId, timeZone, date, tokens, residue, codex, age]) => {
        const whole = mergePeriods(period('cursor', tokens + residue, (tokens + residue) / 1000), period('codex', codex, codex / 1000));
        const history = (cursor, other = 0) => normalizeHistory(parseGraphResult({ contributions: [{ date, clients: [
          { client: 'cursor', modelId: 'shared', tokens: { input: cursor }, cost: cursor / 1000 },
          ...(other ? [{ client: 'codex', modelId: 'shared', tokens: { input: other }, cost: other / 1000 }] : [])
        ] }] }), { todayKey: date });
        const scope = { accountKey: key, observedAt: new Date(now - age).toISOString() };
        const source = { deviceId, updatedAt: new Date(now).toISOString(), historyAvailable: true,
          periodWindows: { timeZone, today: { key: date, endsAt: '2026-10-31T10:00:00.000Z' } },
          today: live ? whole : null, history: history(tokens + residue, codex) };
        source.history.cursorAccountUsage = { ...scope, range: `history:${timeZone}`, usage: history(tokens) };
        if (live) source.today.cursorAccountUsage = { ...scope, range: `today:${boundary}`, usage: accountingCounters(period('cursor', tokens, tokens / 1000)) };
        return source;
      });
      if (live) assert.equal(aggregateDevices(sources, 0, clock.getTime()).periods.today.totalTokens, latestTokens + 25);
      for (const selection of ['week', 'last7', 'last30']) {
        for (const devices of [sources, [...sources].reverse()]) {
          const result = ranges.fixedPeriodSnapshotFromDevices(selection, devices, { now: clock, historyAvailable: true });
          assert.equal(result.status, 'ready');
          assert.equal(result.period.totalTokens, latestTokens + 25, `${selection} live=${live} latest=${latestTokens}`);
          assert.equal(result.period.clients.cursor, latestTokens + 5);
          assert.equal(result.period.clients.codex, 20);
          assert.ok(Math.abs(result.period.costUsd - (latestTokens + 25) / 1000) < 1e-8);
          assert.equal(result.devices.find(row => row.deviceId === 'A').period.totalTokens, 1025);
          assert.equal(result.devices.find(row => row.deviceId === 'B').period.totalTokens, latestTokens);
        }
      }
    }
  }
});
