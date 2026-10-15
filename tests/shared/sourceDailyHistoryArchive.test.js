'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  captureDailyHistoryArchive, graphFromDailyHistoryArchive, captureLiveDailyHistory,
  normalizeDailyHistoryArchive, sourceSnapshotsFromGraphs, retainDailyHistory,
  retainLiveDailyHistory, readDailyHistoryArchive, writeDailyHistoryArchive
} = require('../../src/shared/dailyHistoryArchive');
const { getSourceLedger, projectSourceLedger } = require('../../src/shared/usage/sourceLedger');
const { parseGraphResult, normalizeHistory } = require('../../src/shared/history');
const { applySourceDailyUsage } = require('../../src/shared/usage/sourceDailyUsage');
const { captureSessionUsageArchive, applySessionUsageArchive, updateSessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { extractUsageFromTokscale, applyPeriodDelta } = require('../../src/shared/usage');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');
const CLOCK = '2026-10-11T12:00:00Z';
const ZONE = 'Asia/Hong_Kong';
const TODAY = '2026-10-11';
const options = { todayKey: TODAY, timeZone: ZONE, sessionUsageArchive: { version: 1, sessions: {} } };
const roundTrip = value => normalizeDailyHistoryArchive(JSON.parse(JSON.stringify(value)));
const total = archive => normalizeHistory(parseGraphResult(graphFromDailyHistoryArchive([], archive, options)), options).summary.totalTokens;
const tokens = (input, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0) => ({ input, output, cacheRead, cacheWrite, reasoning });
function value(input, extra = {}) {
  return { timestamp: Date.parse(CLOCK), modelId: 'model', providerId: 'provider', tokens: tokens(input), cost: input / 100, messages: 1, ...extra };
}
function event(id, input, extra = {}) { return { id, contributions: [value(input, extra)] }; }
function session(id, input, eventId = id, client = 'claude', scopeId = 'scanner-domain') {
  return { client, sessionId: id, scopeId, events: input === 0 ? [] : [event(eventId, input)] };
}
function graph(sessions, capturedAt = CLOCK, extra = {}) {
  const clients = [...new Set(sessions.map(row => row.client))];
  const scopeIds = [...new Set(sessions.map(row => row.scopeId))];
  const sourceUsage = { version: 2, eventIdentityVersion: 2, capturedAt, fullHistory: true, bucketTimezone: ZONE,
    dayKey: TODAY, replacementClients: clients, partialClients: [], rowsWithoutIdentity: {},
    scopes: scopeIds.map(id => ({ id, clients: sessions.filter(row => row.scopeId === id).map(row => row.client).filter((client, index, rows) => rows.indexOf(client) === index),
      readStatus: 'complete', identityStatus: 'exact' })), sessions, ...extra };
  // Aggregate output remains independent of source rows and shares pricing.
  const contributions = sessions.flatMap(row => row.events.flatMap(event => event.contributions.map(value => ({
    date: TODAY, clients: [{ client: row.client, modelId: value.modelId, providerId: value.providerId,
      tokens: value.tokens, cost: value.cost, messages: value.messages }]
  }))));
  return { sourceUsage, contributions };
}
function capture(archive, input, extra = {}) { return captureDailyHistoryArchive(archive, input, { ...options, ...extra }); }
function summary(rows = [], timeZone = ZONE) {
  const period = extractUsageFromTokscale({ entries: rows.map(([client, sessionId, input]) => ({ client, sessionId, model: 'model', provider: 'provider', input, cost: input / 100 })) });
  return { today: structuredClone(period), month: structuredClone(period), allTime: structuredClone(period),
    periodWindows: { timeZone }, sessionArchiveSource: { fullScan: true, presentKeys: Object.keys(period.sessions) } };
}
function visible(archive, native = [], extra = {}) {
  const next = summary(native, extra.timeZone || ZONE);
  const projection = graphFromDailyHistoryArchive([], archive, { ...options, ...extra }).sourceUsage;
  applySourceDailyUsage(next, projection, { ...options, ...extra });
  return next;
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...options, path: path.join(dir, 'daily.json') };
}
function assertPeriods(summary, expected) {
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(summary[name].totalTokens, expected, name);
    assert.ok(Math.abs(summary[name].costUsd - expected / 100) < 1e-9, `${name} coherent cost`);
    assert.equal(Object.values(summary[name].sessions).reduce((sum, row) => sum + row.totalTokens, 0), expected, name);
  }
}

test('accepted event kind, unpriced counters and timed samples survive archive restart and partial reads', () => {
  const row = session('ssh-session', 100, `sha256:${'a'.repeat(64)}`);
  row.events[0].observationKind = 'mirror';
  Object.assign(row.events[0].contributions[0], {
    cost: 0, pricing: { unpricedTokens: 100, unpricedMessages: 1 },
    performance: { totalDurationMs: 200, timedTokens: 100, timedOutputTokens: 0, sampleCount: 1 }
  });
  const archive = roundTrip(capture({}, graph([row])));
  const projection = graphFromDailyHistoryArchive([], archive, options).sourceUsage;
  const accepted = getSourceLedger(projection);
  assert.equal(accepted.scopes['scanner-domain'].events[row.events[0].id].observationKind, 'mirror');
  assert.deepEqual(accepted.scopes['scanner-domain'].events[row.events[0].id].contributions[0].pricing,
    { unpricedTokens: 100, unpricedMessages: 1 });
  assert.equal(accepted.scopes['scanner-domain'].events[row.events[0].id].contributions[0].performance.totalDurationMs, 200);
  assert.equal(getSourceLedger(JSON.parse(JSON.stringify(projection))), null);
  const visibleUsage = visible(archive);
  for (const name of ['today', 'month', 'allTime']) assert.equal(visibleUsage[name].unpricedTokens, 100);
  const history = normalizeHistory(parseGraphResult(graphFromDailyHistoryArchive([], archive, options)), options);
  assert.equal(history.summary.unpricedTokens, 100);
  assert.equal(history.daily[0].perClient.claude.unpricedTokens, 100);
  assert.equal(history.monthly[0].perModel.model.unpricedTokens, 100);
  const failed = graph([], '2026-10-11T13:00:00Z', { scopes: [{ id: 'scanner-domain', clients: ['claude'], readStatus: 'partial', identityStatus: 'exact' }] });
  const retained = roundTrip(capture(archive, failed));
  assert.equal(total(retained), 100);
  assert.equal(getSourceLedger(graphFromDailyHistoryArchive([], retained, options).sourceUsage)
    .scopes['scanner-domain'].events[row.events[0].id].observationKind, 'mirror');
});

test('ledger projection preserves main session identities and a cross-client parent through retention', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const key = `codex:${sessionId}`;
  const metadata = { parentSessionId: 'claude-parent', parentClient: 'claude',
    nativeSessionId: '22222222-2222-4222-8222-222222222222', t3ThreadId: 't3-child' };
  const archive = capture({}, graph([session(sessionId, 100, 'turn', 'codex')]));
  const projected = summary([['codex', sessionId, 100]]);
  for (const name of ['today', 'month', 'allTime']) Object.assign(projected[name].sessions[key], metadata);
  applySourceDailyUsage(projected, graphFromDailyHistoryArchive([], archive, options).sourceUsage, options);
  assertPeriods(projected, 100);
  for (const name of ['today', 'month', 'allTime']) {
    for (const [field, value] of Object.entries(metadata)) assert.equal(projected[name].sessions[key][field], value, `${name}.${field}`);
  }
  const generic = roundTripGeneric(captureSessionUsageArchive({}, projected, new Date(CLOCK)));
  assert.equal(generic.sessions[key].periods.allTime.totalTokens, 0);
  for (const [field, value] of Object.entries(metadata)) assert.equal(generic.sessions[key].periods.allTime[field], value, field);
  const omitted = applySessionUsageArchive(visible(archive), generic, { now: new Date(CLOCK) });
  assertPeriods(omitted, 100);
  for (const name of ['today', 'month', 'allTime']) {
    for (const [field, value] of Object.entries(metadata)) assert.equal(omitted[name].sessions[key][field], value, `omitted ${name}.${field}`);
  }
});

function roundTripGeneric(archive) { return JSON.parse(JSON.stringify(archive)); }

test('the generic owned archive stores new identity metadata without counting native usage twice', () => {
  const key = 'codex:child';
  const native = summary([['codex', 'child', 100]]);
  const metadata = { parentSessionId: 'parent', parentClient: 'claude',
    nativeSessionId: '22222222-2222-4222-8222-222222222222', t3ThreadId: 't3-child' };
  for (const name of ['today', 'month', 'allTime']) Object.assign(native[name].sessions[key], metadata);
  native.sessionArchiveSource.ownedClients = ['codex'];
  native.sessionArchiveSource.boundaryCheckedClients = ['codex'];
  native.sessionArchiveSource.managedKeys = [key];
  const archive = roundTripGeneric(captureSessionUsageArchive({}, native, new Date(CLOCK)));
  assert.equal(archive.sessions[key].periods.allTime.totalTokens, 0);
  for (const [field, value] of Object.entries(metadata)) assert.equal(archive.sessions[key].periods.allTime[field], value, field);
  assertPeriods(applySessionUsageArchive(native, archive, { now: new Date(CLOCK) }), 100);
});

test('an owned session changing to a same-client parent cannot inherit an old parent namespace', () => {
  const key = 'codex:child';
  const archive = capture({}, graph([session('child', 100, 'turn', 'codex')]));
  function projected(parentSessionId, parentClient) {
    const next = summary([['codex', 'child', 100]]);
    for (const name of ['today', 'month', 'allTime']) {
      next[name].sessions[key].parentSessionId = parentSessionId;
      if (parentClient) next[name].sessions[key].parentClient = parentClient;
    }
    applySourceDailyUsage(next, graphFromDailyHistoryArchive([], archive, options).sourceUsage, options);
    return next;
  }
  const old = captureSessionUsageArchive({}, projected('old-parent', 'claude'), new Date(CLOCK));
  const current = projected('new-parent');
  const next = roundTripGeneric(captureSessionUsageArchive(old, current, new Date('2026-10-11T12:01:00Z')));
  assert.equal(next.sessions[key].periods.allTime.parentSessionId, 'new-parent');
  assert.equal(next.sessions[key].periods.allTime.parentClient, undefined);
  assert.equal(next.sessions[key].periods.allTime.totalTokens, 0);
  for (const candidate of [applySessionUsageArchive(current, next, { now: new Date(CLOCK) }),
    applySessionUsageArchive(visible(archive), next, { now: new Date(CLOCK) })]) {
    assertPeriods(candidate, 100);
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(candidate[name].sessions[key].parentSessionId, 'new-parent');
      assert.equal(candidate[name].sessions[key].parentClient, undefined);
    }
  }
});
test('opaque domain ownership survives A100 -> B20, timezone, fallback, unsupported export and disk reload', t => {
  const file = temp(t);
  let archive = capture({}, graph([session('A', 100, 'shared')]));
  const oldGeneric = captureSessionUsageArchive({}, summary([['claude', 'A', 100]]), new Date(CLOCK));
  archive = capture(archive, graph([session('B', 20, 'shared')], '2026-10-11T12:01:00Z'));
  assert.equal(total(archive), 20);
  for (const phase of ['timezone', 'aggregate', 'unsupported', 'reload']) {
    if (phase === 'aggregate') archive = capture(archive, { meta: { generatedAt: '2026-10-11T12:02:00Z' }, contributions: graph([session('A', 100)]).contributions });
    if (phase === 'unsupported') archive = capture(archive, graph([session('A', 100)], '2026-10-11T12:03:00Z', { version: 99 }));
    if (phase === 'reload') { writeDailyHistoryArchive(archive, file); archive = readDailyHistoryArchive(file); }
    const timeZone = phase === 'timezone' ? 'America/Los_Angeles' : ZONE;
    const projected = applySessionUsageArchive(visible(archive, [['claude', 'A', 100]], { timeZone }), oldGeneric, { now: new Date(CLOCK) });
    assertPeriods(projected, 20);
    assert.equal(projected.allTime.sessions['claude:A'], undefined, phase);
    assert.equal(normalizeHistory(parseGraphResult(graphFromDailyHistoryArchive([], archive, { ...options, timeZone })), options).summary.totalTokens, 20, phase);
  }
  const scope = archive.sourceLedger.scopes['scanner-domain'];
  assert.equal(scope.events.shared.ownerKey, 'claude:B');
  assert.equal(scope.mode, 'ledger');
  assert.equal(scope.acceptedAt, '2026-10-11T12:01:00Z');
  assert.equal(scope.observationFrontier, '2026-10-11T12:03:00Z');
});

for (const readStatus of ['partial', 'unknown']) test(`Codex complete45 -> ${readStatus}15 preserves45 -> complete exact15 corrects`, () => {
  const make = (n, clock, status) => graph([session('turn', n, 'turn-uid', 'codex')], clock,
    { scopes: [{ id: 'scanner-domain', clients: ['codex'], readStatus: status, identityStatus: 'exact' }] });
  const first = capture({}, make(45, CLOCK, 'complete'));
  const partial = roundTrip(capture(first, make(15, '2026-10-11T12:01:00Z', readStatus)));
  assert.equal(total(partial), 45);
  assertPeriods(visible(partial, [['codex', 'turn', 15]]), 45);
  const accepted = capture(partial, make(15, '2026-10-11T12:02:00Z', 'complete'));
  assert.equal(total(accepted), 15);
  assertPeriods(visible(accepted), 15);
});

for (const extra of [{ fullHistory: false }, { eventIdentityVersion: 99 },
  { scopes: [{ id: 'scanner-domain', clients: ['claude'], readStatus: 'complete', identityStatus: 'unresolved' }] },
  { partialClients: ['claude'] }, { rowsWithoutIdentity: { claude: 1 } }]) test(`insufficient replacement proof preserves prior counters: ${JSON.stringify(extra)}`, () => {
  const first = capture({}, graph([session('old', 45)]));
  const next = capture(first, graph([session('old', 15)], '2026-10-11T12:01:00Z', extra));
  assert.equal(total(next), 45);
  assertPeriods(visible(next, [['claude', 'old', 15]]), 45);
});

test('MiMo cli/desktop shared scanner scope changes owners at15 and accepts complete lower5 only', () => {
  const clients = ['micode', 'micode-desktop'];
  const extra = readStatus => ({ replacementClients: clients, scopes: [{ id: 'scanner-domain', clients, readStatus, identityStatus: 'exact' }] });
  let archive = capture({}, graph([session('cli', 15, 'response', 'micode')], CLOCK, extra('complete')));
  archive = capture(archive, graph([session('desktop', 15, 'response', 'micode-desktop')], '2026-10-11T12:01:00Z', extra('complete')));
  assert.equal(total(archive), 15);
  assertPeriods(visible(archive), 15);
  assert.equal(visible(archive).allTime.sessions['mimo:cli'], undefined);
  assert.equal(visible(archive).allTime.sessions['mimo:desktop'].totalTokens, 15);
  archive = capture(archive, graph([session('desktop', 5, 'response', 'micode-desktop')], '2026-10-11T12:02:00Z', extra('partial')));
  assert.equal(total(archive), 15);
  archive = roundTrip(capture(archive, graph([session('desktop', 5, 'response', 'micode-desktop')], '2026-10-11T12:03:00Z', extra('complete'))));
  assert.equal(total(archive), 5);
});

test('a partial surface selection cannot authorize a complete shared scope', () => {
  const input = graph([session('cli', 15, 'response', 'micode')], CLOCK,
    { replacementClients: ['micode'], scopes: [{ id: 'scanner-domain', clients: ['micode', 'micode-desktop'], readStatus: 'complete', identityStatus: 'exact' }] });
  assert.equal(sourceSnapshotsFromGraphs(input).size, 0);
  const archive = capture({}, input);
  assert.equal(archive.sourceLedger.scopes['scanner-domain'], undefined);
  assert.equal(archive.sourceLedger.observations['scanner-domain'].reason, 'partial-client-scope');
});

test('whole observed IDs replace all events/days/models including zero and explicit zero-priced usage', () => {
  const first = capture({}, graph([{ ...session('one', 50), events: [event('old-a', 50, { timestamp: Date.parse('2026-09-01T12:00:00Z'), modelId: 'old' }), event('old-b', 10)] }, session('omitted', 7)]));
  const lower = graph([{ ...session('one', 5), events: [event('new', 5, { modelId: 'corrected', cost: 0 })] }], '2026-10-11T12:01:00Z');
  const next = roundTrip(capture(first, lower));
  assert.equal(total(next), 12);
  assert.deepEqual(Object.keys(next.sourceLedger.scopes['scanner-domain'].events).sort(), ['new', 'omitted']);
  const current = visible(next);
  assert.equal(current.allTime.sessions['claude:one'].costUsd, 0);
  assert.deepEqual(current.allTime.sessions['claude:one'].models, { corrected: 5 });
  const zero = roundTrip(capture(next, graph([session('one', 0)], '2026-10-11T12:02:00Z')));
  assert.equal(total(zero), 7);
  assert.ok(zero.sourceLedger.scopes['scanner-domain'].sessions['claude:one']);
  assert.equal(visible(zero).allTime.sessions['claude:one'], undefined);
});

test('only claimed groups move; omitted owners keep exact unclaimed cost/components without ratios', () => {
  const old = { ...session('old', 100), events: [event('move', 100, { tokens: tokens(20, 30, 40, 10), cost: 2 }), event('keep', 5, { cost: 0.1 })] };
  const first = capture({}, graph([old]));
  const next = roundTrip(capture(first, graph([{ ...session('new', 3), events: [event('move', 3, { tokens: tokens(1, 1, 1), cost: 0.03 })] }], '2026-10-11T12:01:00Z')));
  const rows = visible(next).allTime.sessions;
  assert.equal(total(next), 8);
  assert.equal(rows['claude:old'].totalTokens, 5);
  assert.equal(rows['claude:old'].costUsd, 0.1);
  assert.equal(rows['claude:new'].cacheReadTokens, 1);
  assert.equal(rows['claude:new'].outputTokens, 1);
});

test('raw independent clients sharing SID and UID remain distinct when scanner scopes differ', () => {
  const first = capture({}, graph([session('same', 100, 'same-uid', 'devin-cli', 'domain-cli')]));
  const next = roundTrip(capture(first, graph([session('same', 5, 'same-uid', 'devin-desktop', 'domain-desktop')], '2026-10-11T12:01:00Z')));
  assert.equal(total(next), 105);
  assert.equal(visible(next).allTime.sessions['devin:same'].totalTokens, 105);
  const corrected = capture(next, graph([session('same', 0, 'same-uid', 'devin-desktop', 'domain-desktop')], '2026-10-11T12:02:00Z'));
  assert.equal(total(corrected), 100);
});

test('unproven raw sibling cannot add a native fallback after the canonical boundary is owned', () => {
  const archive = capture({}, graph([session('same', 5, 'uid', 'devin-cli', 'cli-domain')]));
  const nativeCli = summary([['devin-cli', 'same', 50]]).allTime;
  const nativeDesktop = summary([['devin-desktop', 'same', 7]]).allTime;
  const nativeRawPartitions = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, { 'devin-cli': structuredClone(nativeCli), 'devin-desktop': structuredClone(nativeDesktop) }]));
  const next = visible(archive, [], { nativeRawPartitions });
  assertPeriods(next, 5);
});

test('stale scans and conflicting equal revisions cannot undo accepted ownership/counters', () => {
  const first = capture({}, graph([session('A', 100, 'shared')]));
  const newest = capture(first, graph([session('B', 20, 'shared')], '2026-10-11T12:02:00Z'));
  const stale = roundTrip(capture(newest, graph([session('A', 300, 'shared')], '2026-10-11T12:01:00Z')));
  assert.equal(total(stale), 20);
  assert.deepEqual(stale.sourceLedger, newest.sourceLedger);
  const conflict = capture(stale, graph([session('A', 300, 'shared')], '2026-10-11T12:02:00Z'));
  assert.equal(total(conflict), 20);
  assert.equal(conflict.sourceLedger.scopes['scanner-domain'].reason, 'conflicting-revision');
});

test('prewrite rebase rejects an older full scan without altering newer accounting or timing', () => {
  const timed = (n, capturedAt, activeTimeMs) => ({ ...graph([session('A', n)], capturedAt),
    contributions: [{ ...graph([session('A', n)]).contributions[0], activeTimeMs }], timeMetrics: { totalActiveTimeMs: activeTimeMs } });
  const first = capture({}, timed(100, CLOCK, 10000));
  const newest = capture(first, timed(20, '2026-10-11T12:02:00Z', 20000));
  let reads = 0;
  const writes = [];
  const result = retainDailyHistory(timed(300, '2026-10-11T12:01:00Z', 50000), { ...options,
    path: '/private/tmp/test-source-rebase.json', readJson: () => ++reads === 1 ? first : newest,
    writeJsonAtomic: (_path, value) => writes.push(value) });
  assert.equal(reads, 2);
  assert.deepEqual(writes, []);
  assert.equal(normalizeHistory(parseGraphResult(result)).summary.totalTokens, 20);
  assert.equal(result.timeMetrics.totalActiveTimeMs, 20000);
  assert.equal(result.contributions[0].activeTimeMs, 20000);
});

test('fallback observation frontier blocks a scan that finished after a newer unavailable export', () => {
  const first = capture({}, graph([session('A', 45)]));
  const fallback = capture(first, { meta: { generatedAt: '2026-10-11T12:03:00Z' }, contributions: [] });
  const stale = capture(fallback, graph([session('A', 15)], '2026-10-11T12:02:00Z'));
  assert.equal(total(stale), 45);
  assert.deepEqual(stale.sourceLedger, fallback.sourceLedger);
});

test('duplicate owners or malformed timestamp/counters cannot grant correction authority', () => {
  const first = capture({}, graph([session('old', 45)]));
  for (const rows of [[session('A', 5, 'duplicate'), session('B', 5, 'duplicate')],
    [{ ...session('old', 15), events: [event('old', 15, { timestamp: NaN })] }],
    [{ ...session('old', 15), events: [event('old', 15, { tokens: tokens(-1) })] }],
    [{ ...session('old', 15), events: [{ id: null, contributions: [value(15)] }] }]]) {
    assert.equal(total(capture(first, graph(rows, '2026-10-11T12:01:00Z'))), 45);
  }
});

test('timezone rebucketing derives all windows from UTC contributions without changing accepted mode', () => {
  const boundary = Date.parse('2026-10-01T00:30:00Z');
  const input = graph([{ ...session('boundary', 10), events: [event('boundary', 10, { timestamp: boundary })] }]);
  const archive = capture({}, input);
  const hk = visible(archive, [], { todayKey: '2026-10-01' });
  assertPeriods(hk, 10);
  const west = visible(archive, [], { todayKey: '2026-10-01', timeZone: 'America/Los_Angeles' });
  assert.equal(west.today.totalTokens, 0);
  assert.equal(west.month.totalTokens, 0);
  assert.equal(west.allTime.totalTokens, 10);
  assert.equal(archive.sourceLedger.scopes['scanner-domain'].mode, 'ledger');
});

test('watch exact Today delta anchors survive without normalizing or freezing source accounting', () => {
  const archive = capture({}, graph([session('A', 100)]));
  const projection = projectSourceLedger(archive.sourceLedger, options);
  const anchor = summary([['claude', 'A', 100]]);
  const native = summary([['claude', 'A', 120]]);
  for (const name of ['month', 'allTime']) native[name] = applyPeriodDelta(anchor[name], native.today, anchor.today);
  applySourceDailyUsage(native, projection, { ...options, replaceLive: false, nativeAnchor: anchor });
  assertPeriods(native, 120);
  const zero = summary([]);
  applySourceDailyUsage(zero, projection, { ...options, replaceLive: false, nativeAnchor: anchor });
  assertPeriods(zero, 0);
});

test('watch new live ID receives only retained past usage while omitted IDs retain their accounting', () => {
  const input = graph([{ ...session('A', 5), events: [event('A', 5, { timestamp: Date.parse('2026-10-10T12:00:00Z') })] }, session('omitted', 7)]);
  const archive = capture({}, input);
  const native = summary([['claude', 'A', 2]]);
  applySourceDailyUsage(native, projectSourceLedger(archive.sourceLedger, options), { ...options, replaceLive: false, nativeAnchor: summary([]) });
  assert.equal(native.today.totalTokens, 9);
  assert.equal(native.month.totalTokens, 14);
  assert.equal(native.allTime.totalTokens, 14);
});

test('released days/liveDays survive normalization and disk reload without an invented ledger', t => {
  const file = temp(t);
  const archive = captureLiveDailyHistory({ version: 1, days: {
    '2026-10-10': { date: '2026-10-10', observations: { old: {
      client: 'claude', modelId: 'model', tokens: 20, cost: 0.2, messages: 1
    } } }
  } }, summary([['claude', 'today', 5]]).today, options);
  writeDailyHistoryArchive(archive, file);
  const loaded = readDailyHistoryArchive(file);
  assert.deepEqual(loaded, roundTrip(archive));
  assert.equal(loaded.sourceLedger, undefined);
  assert.equal(total(loaded), 25);
  assert.equal(loaded.days['2026-10-10'].observations['["claude","model"]'].unclassifiedTokens, 20);
  assert.equal(loaded.liveDays[TODAY].observations['["claude","model"]'].tokens, 5);
});

test('released generic session archive cannot grant downward authority from matching IDs or totals', () => {
  const generic = captureSessionUsageArchive({}, summary([['claude', 'old', 45]]), new Date(2026, 9, 11, 12));
  let archive = roundTrip(capture({}, graph([session('old', 15)], '2026-10-11T12:01:00Z'), { sessionUsageArchive: generic }));
  assert.equal(archive.sourceLedger.scopes['scanner-domain'].mode, 'legacy');
  assert.equal(total(archive), 45);
  for (const [input, capturedAt] of [[45, '2026-10-11T12:02:00Z'], [15, '2026-10-11T12:03:00Z']]) {
    archive = roundTrip(capture(archive, graph([session('old', input)], capturedAt), { sessionUsageArchive: generic }));
    assert.equal(archive.sourceLedger.scopes['scanner-domain'].mode, 'legacy');
    assertPeriods(visible(archive), 45);
    assert.equal(visible(archive).allTime.sessions['claude:old'].totalTokens, 45);
  }
});

test('unresolved legacy aggregates never sum with new exact events or acquire migration from matching totals', () => {
  const aggregate = { version: 1, days: { [TODAY]: { date: TODAY, observations: { old: { client: 'claude', modelId: 'model', tokens: 45, cost: 0.45, messages: 1 } } } } };
  const next = roundTrip(capture(aggregate, graph([session('new', 45)], '2026-10-11T12:01:00Z')));
  assert.equal(total(next), 45);
  assert.equal(next.sourceLedger.scopes['scanner-domain'].mode, 'legacy');
  assert.equal(next.sourceLedger.scopes['scanner-domain'].reason, 'unresolved-legacy-boundary');
  const overlapping = roundTrip({ version: 1, days: {}, unresolvedDays: aggregate.days });
  const blocked = capture(overlapping, graph([session('old', 45)], '2026-10-11T12:01:00Z'));
  assert.equal(Object.values(blocked.sourceLedger.scopes)[0].mode, 'legacy');
  assert.equal(total(blocked), 45);
});

test('transient native Today does not create a persisted legacy boundary before exact source acceptance', () => {
  const live = captureLiveDailyHistory({}, summary([['claude', 'A', 100]]).today, options).liveDays;
  let written;
  const result = retainDailyHistory(graph([session('A', 20)]), { ...options, liveDays: live,
    readJson: () => ({}), writeJsonAtomic: (_path, value) => { written = value; } });
  assert.equal(written.sourceLedger.scopes['scanner-domain'].mode, 'ledger');
  assert.equal(normalizeHistory(parseGraphResult(result)).summary.totalTokens, 20);
});

test('fresh v1 and uninstrumented v2 exports keep a single exclusive aggregate legacy lane', () => {
  for (const extra of [{ version: 1, eventIdentityVersion: 1 },
    { scopes: [{ id: 'scanner-domain', clients: ['claude'], readStatus: 'unknown', identityStatus: 'unresolved' }] }]) {
    const first = capture({}, graph([session('A', 45)], CLOCK, extra));
    assert.equal(total(first), 45);
    const next = capture(first, graph([session('A', 15)], '2026-10-11T12:01:00Z', extra));
    assert.equal(total(next), 45);
    assert.equal(sourceSnapshotsFromGraphs(graph([session('A', 45)], CLOCK, extra)).size, 0);
    if (next.sourceLedger && Object.keys(next.sourceLedger.scopes).length) assert.equal(Object.values(next.sourceLedger.scopes)[0].mode, 'legacy');
  }
});

test('source ledger counters are not duplicated into generic session accounting; metadata still persists', () => {
  const archive = capture({}, graph([session('A', 45)]));
  const projected = visible(archive, [['claude', 'A', 45]]);
  for (const name of ['today', 'month', 'allTime']) projected[name].sessions['claude:A'].title = 'Retained title';
  const generic = updateSessionUsageArchive({}, projected, new Date(CLOCK)).archive;
  assert.equal(generic.sessions['claude:A'].periods.allTime.totalTokens, 0);
  assert.equal(generic.sessions['claude:A'].periods.allTime.title, 'Retained title');
  const lower = capture(archive, graph([session('A', 15)], '2026-10-11T12:01:00Z'));
  const next = applySessionUsageArchive(visible(lower), generic, { now: new Date(CLOCK) });
  assertPeriods(next, 15);
  assert.equal(next.allTime.sessions['claude:A'].title, 'Retained title');
});

test('privacy whitelist drops scanner text and paths; source paths/evidence stay local after projection', t => {
  const file = temp(t);
  // Exercise JSON escaping even on hosts whose path separator is a slash.
  const sourcePath = path.join(path.dirname(file.path), 'private\\source.jsonl');
  const input = graph([{ ...session('A', 45), title: 'private scanner text' }]);
  input.sourceUsage.sessions[0].events[0].contributions[0].prompt = 'secret prompt';
  const first = capture({}, input, { sourcePaths: { 'claude:A': sourcePath } });
  const omitted = capture(first, graph([session('B', 1)], '2026-10-11T12:01:00Z'));
  assert.equal(omitted.sourceLedger.scopes['scanner-domain'].sessions['claude:A'].sourceState, 'missing');
  writeDailyHistoryArchive(omitted, file);
  const stored = fs.readFileSync(file.path, 'utf8');
  assert.equal(stored.includes('private scanner text'), false);
  assert.equal(stored.includes('secret prompt'), false);
  assert.equal(JSON.parse(stored).sourceLedger.scopes['scanner-domain'].sessions['claude:A'].sourcePath, sourcePath);
  const next = visible(readDailyHistoryArchive(file));
  assert.equal(next.allTime.sessions['claude:A'].archived, true);
  const wire = serializeSyncPayload(applySessionUsageArchive(next, {}, { now: new Date(CLOCK) })).body;
  for (const secret of [sourcePath, 'sourceLedger', 'ownedClients', 'scanner-domain', 'sourceObservedAt']) assert.equal(wire.includes(JSON.stringify(secret).slice(1, -1)), false, secret);
});

test('ledger projection and canonical loading reuse retained accounting without renormalizing events', () => {
  const archive = capture({}, graph([session('A', 45)]));
  const first = projectSourceLedger(archive.sourceLedger, options);
  const normalized = normalizeDailyHistoryArchive(archive);
  assert.equal(normalized.sourceLedger, archive.sourceLedger);
  assert.equal(projectSourceLedger(normalized.sourceLedger, options), first);
});

test('owned Today watch/activity capture returns before any disk read or normalization', () => {
  const archive = capture({}, graph([session('A', 45)]));
  const projection = projectSourceLedger(archive.sourceLedger, options);
  const liveDays = { sentinel: 'existing transient state' };
  const result = retainLiveDailyHistory(summary([['claude', 'A', 120]]).today, { ...options,
    sourceProjection: projection, liveDays, readJson: () => { throw new Error('must not read archive'); },
    writeJsonAtomic: () => { throw new Error('must not write archive'); } });
  assert.equal(result.liveDays, liveDays);
});

test('malformed persisted ledger documents fail closed rather than resetting mode or claims', t => {
  const file = temp(t);
  const archive = capture({}, graph([session('A', 45)]));
  archive.sourceLedger = JSON.parse(JSON.stringify(archive.sourceLedger));
  archive.sourceLedger.scopes['scanner-domain'].events.A.ownerKey = 'claude:unknown-owner';
  fs.writeFileSync(file.path, JSON.stringify(archive));
  const before = fs.readFileSync(file.path, 'utf8');
  assert.throws(() => retainDailyHistory(graph([session('A', 15)]), file), /Invalid source ledger claim/);
  assert.equal(fs.readFileSync(file.path, 'utf8'), before);
});

test('cached trusted App projection rebuckets on timezone change even if no archive can be loaded', () => {
  const first = capture({}, graph([session('A', 100, 'shared')]));
  const corrected = capture(first, graph([session('B', 20, 'shared')], '2026-10-11T12:01:00Z'));
  const cached = projectSourceLedger(corrected.sourceLedger, options);
  const next = summary([['claude', 'A', 100]], 'America/Los_Angeles');
  applySourceDailyUsage(next, cached, { ...options, timeZone: 'America/Los_Angeles' });
  assertPeriods(next, 20);
  assert.equal(next.allTime.sessions['claude:A'], undefined);
  assert.deepEqual(next.sessionArchiveSource.ownedClients, ['claude']);
});

for (const readStatus of ['partial', 'unknown']) test(`${readStatus} rejection survives reload and a cached native watch15; complete proof unfreezes watch`, () => {
  const first = capture({}, graph([session('A', 45)]));
  const rejected = roundTrip(capture(first, graph([session('A', 15)], '2026-10-11T12:01:00Z', {
    scopes: [{ id: 'scanner-domain', clients: ['claude'], readStatus, identityStatus: 'exact' }]
  })));
  const native = summary([['claude', 'A', 15]]);
  applySourceDailyUsage(native, projectSourceLedger(rejected.sourceLedger, options), { ...options, replaceLive: false,
    nativeAnchor: summary([['claude', 'A', 45]]) });
  assertPeriods(native, 45);
  const fallback = capture(rejected, { meta: { generatedAt: '2026-10-11T12:02:00Z' }, contributions: [] });
  assert.equal(fallback.sourceLedger.scopes['scanner-domain'].blockNativeWatch, true);
  const complete = capture(fallback, graph([session('A', 15)], '2026-10-11T12:03:00Z'));
  const fresh = summary([['claude', 'A', 25]]);
  applySourceDailyUsage(fresh, projectSourceLedger(complete.sourceLedger, options), { ...options, replaceLive: false,
    nativeAnchor: summary([['claude', 'A', 15]]) });
  assertPeriods(fresh, 25);
});

test('same-canonical partial scope keeps the entire canonical client on the native legacy path', () => {
  const cli = session('cli', 30, 'cli-uid', 'antigravity-cli', 'cli-domain');
  const extension = session('extension', 5, 'extension-uid', 'antigravity-extension', 'extension-domain');
  const input = graph([cli, extension], CLOCK, { replacementClients: ['antigravity-cli'], partialClients: ['antigravity-extension'],
    scopes: [{ id: 'cli-domain', clients: ['antigravity-cli'], readStatus: 'complete', identityStatus: 'exact' },
      { id: 'extension-domain', clients: ['antigravity-extension'], readStatus: 'partial', identityStatus: 'exact' }] });
  const archive = capture({}, input);
  const raw = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, {
    'antigravity-cli': summary([['antigravity-cli', 'cli', 900]])[name],
    'antigravity-extension': summary([['antigravity-extension', 'extension', 20]])[name]
  }]));
  const next = visible(archive, [['antigravity-cli', 'cli', 900], ['antigravity-extension', 'extension', 20]], { nativeRawPartitions: raw });
  assertPeriods(next, 920);
  assert.deepEqual(projectSourceLedger(archive.sourceLedger, options).ownedClients, []);
  assert.equal(archive.sourceLedger.scopes['cli-domain'], undefined);
  assert.equal(archive.sourceLedger.observations['cli-domain'].reason, 'canonical-legacy-scope');
  assert.equal(archive.sourceLedger.scopes['extension-domain'], undefined);
  assert.equal(archive.sourceLedger.observations['extension-domain'].reason, 'read-partial');
});

test('accepted but currently omitted IDs stay display-only and do not mint native anchor presence', () => {
  const archive = capture({}, graph([session('A', 45)]));
  const native = summary([]);
  const nativePeriods = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, emptyNative()]));
  const nativeRawPartitions = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, { claude: emptyNative() }]));
  const nativeRawPresence = { today: [], month: [], allTime: [] };
  applySourceDailyUsage(native, projectSourceLedger(archive.sourceLedger, options), { ...options,
    nativePeriods, nativeRawPartitions, nativeRawPresence });
  assertPeriods(native, 45);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(nativePeriods[name].totalTokens, 0);
    assert.deepEqual(nativeRawPresence[name], []);
    assert.equal(native[name].sessions['claude:A'].retained, true);
    assert.equal(native[name].sessions['claude:A'].sourceState, 'unknown');
  }
});
function emptyNative() { return summary([]).allTime; }

test('untouched native rows and anchor periods preserve decorated context, timing, activity and titles', () => {
  const archive = capture({}, graph([session('A', 15)]));
  const native = summary([['claude', 'A', 900], ['codex', 'unowned', 7]]);
  const fields = { title: 'Decorated', projectId: 'project', projectLabel: 'Project', contextTokens: 123,
    contextWindow: 1000, waitingForInput: true, turnEnded: false,
    lastUsedAt: new Date(CLOCK).toISOString(), startedAt: '2026-10-11T11:00:00.000Z', promptCache: { observedAt: new Date(CLOCK).toISOString(), ttlSeconds: 300 },
    liveActivity: { observedAt: new Date(Date.now() - 1000).toISOString(), state: 'waiting' }, timedDurationMs: 1000, timedOutputTokens: 0 };
  const nativePeriods = {};
  const raw = {};
  for (const name of ['today', 'month', 'allTime']) {
    Object.assign(native[name].sessions['codex:unowned'], fields);
    nativePeriods[name] = native[name];
    raw[name] = { claude: summary([['claude', 'A', 900]])[name], codex: summary([['codex', 'unowned', 7]])[name] };
  }
  applySourceDailyUsage(native, projectSourceLedger(archive.sourceLedger, options), { ...options, nativePeriods, nativeRawPartitions: raw });
  for (const name of ['today', 'month', 'allTime']) {
    for (const field of Object.keys(fields)) {
      assert.deepEqual(native[name].sessions['codex:unowned'][field], fields[field], `${name}:${field}`);
      assert.deepEqual(nativePeriods[name].sessions['codex:unowned'][field], fields[field], `anchor ${name}:${field}`);
    }
  }
});
