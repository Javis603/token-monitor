'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { extractUsageFromTokscale, normalizePeriod } = require('../../src/shared/usage');
const { captureSourceLedger, projectSourceLedger, getSourceLedger } = require('../../src/shared/usage/sourceLedger');
const { periodIdentityStateFromSource, identityPeriodFromState, replaceIdentityToday, usageIdentityFromState,
  historyIdentityFromLedger, identityStateFromLedger, acceptedClaudeWindows } = require('../../src/shared/usage/sourceIdentity');

const id = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const clock = '2026-10-13T06:00:00.000Z';
const day = '2026-10-13';
const options = { timeZone: 'UTC', todayKey: day, allTimeSince: '2026-01-01' };
const event = (name, input = 10, observationKind = 'native', timestamp = Date.parse(clock)) => ({
  id: id(name), observationKind, contributions: [{ timestamp, modelId: 'claude-3-5-sonnet-20241022', providerId: 'anthropic',
    tokens: { input, output: 3, cacheRead: 5, cacheWrite: 2, reasoning: 0 }, cost: input / 100, messages: 1,
    performance: { timedTokens: input + 10, timedOutputTokens: 3, totalDurationMs: 150 }, pricing: { unpricedTokens: 2, unpricedMessages: 1 } }] });
const source = events => ({ version: 2, eventIdentityVersion: 2, fullHistory: false, capturedAt: clock,
  replacementClients: ['claude'], partialClients: [], rowsWithoutIdentity: {},
  scopes: [{ id: id('scope'), clients: ['claude'], readStatus: 'complete', identityStatus: 'exact' }],
  sessions: [{ client: 'claude', sessionId: 'session', scopeId: id('scope'), events }] });
const nativePeriod = events => normalizePeriod(extractUsageFromTokscale({ entries: events.flatMap(e => e.contributions.map(c => ({
  client: 'claude', sessionId: 'session', model: c.modelId, provider: c.providerId, ...c.tokens, cost: c.cost,
  messages: c.messages, performance: c.performance, unpricedTokens: c.pricing?.unpricedTokens }))) }));
const state = events => periodIdentityStateFromSource(source(events), nativePeriod(events), options);

test('warm unrelated events preserve past authority and mixed event fragments stay unproved until full capture', () => {
  const past = event('past', 30, 'native', Date.parse('2026-10-12T06:00:00Z'));
  const mixed = event('mixed');
  mixed.contributions.unshift(event('older', 20, 'native', Date.parse('2026-10-12T06:00:00Z')).contributions[0]);
  const base = state([past, mixed]);
  const capture = (events, at) => periodIdentityStateFromSource({ ...source(events), capturedAt: at }, nativePeriod(events), options);
  const next = replaceIdentityToday(base, capture([event('fresh'), event('mixed', 7)], '2026-10-13T09:00:00.000Z'), day);
  const proof = identityPeriodFromState(next);
  assert.equal(proof.events.find(e => e.id === id('past')).capturedAt, clock);
  assert.equal(proof.events.find(e => e.id === id('fresh')).capturedAt, '2026-10-13T09:00:00.000Z');
  assert.equal(proof.events.find(e => e.id === id('mixed')), undefined);
  const again = replaceIdentityToday(next, capture([event('mixed', 9)], '2026-10-13T10:00:00.000Z'), day);
  assert.equal(identityPeriodFromState(again).events.find(e => e.id === id('mixed')), undefined);
  assert.equal(identityPeriodFromState(capture([mixed], '2026-10-13T10:00:00.000Z')).events[0].capturedAt, '2026-10-13T10:00:00.000Z');
});

test('ledger event proof time survives serialization and absent-session inventory updates without upgrading legacy unknown time', () => {
  const full = { sourceUsage: { ...source([event('A')]), fullHistory: true } };
  const accepted = captureSourceLedger(undefined, [full], { retainedBoundaryChecked: true }).ledger;
  const old = JSON.parse(JSON.stringify(accepted));
  delete old.scopes[id('scope')].events[id('A')].capturedAt;
  const late = '2026-10-13T09:00:00.000Z';
  const nextGraph = { sourceUsage: { ...source([event('B')]), capturedAt: late, fullHistory: true,
    sessions: [{ ...source([event('B')]).sessions[0], sessionId: 'fresh-session' }] } };
  const next = captureSourceLedger(old, [nextGraph], { retainedBoundaryChecked: true }).ledger;
  const restored = JSON.parse(JSON.stringify(next));
  const proof = historyIdentityFromLedger(restored, options);
  assert.equal(proof.events.find(e => e.id === id('A')).capturedAt, clock);
  assert.equal(proof.events.find(e => e.id === id('B')).capturedAt, late);
  delete restored.scopes[id('scope')].events[id('A')].capturedAt;
  assert.equal(historyIdentityFromLedger(restored, options).events.find(e => e.id === id('A')), undefined);
  assert.equal(Object.keys(captureSourceLedger(restored, [], {}).ledger.scopes[id('scope')].events).length, 2, 'unknown proof time never discards retained accounting');
});

test('exact event claims use existing parser aliases, components, raw throughput and unpriced counters', () => {
  const events = [event('A'), event('B', 4, 'mirror')];
  const proof = usageIdentityFromState({ today: state(events) }, { today: nativePeriod(events) });
  assert.equal(proof.version, 1);
  assert.equal(proof.eventIdentityVersion, 2);
  assert.deepEqual(proof.periods.today.events.map(e => e.observationKind), ['native', 'mirror']);
  const claim = proof.periods.today.events[0].usage;
  assert.equal(claim.totalTokens, 20);
  assert.equal(claim.outputTokens, 3);
  assert.equal(claim.cacheReadTokens, 5);
  assert.equal(claim.timedOutputTokens, 3);
  assert.equal(claim.timedDurationMs, 150);
  assert.equal(claim.unpricedTokens, 2);
  assert.deepEqual(claim.models, nativePeriod([events[0]]).models);
  const text = JSON.stringify(proof);
  for (const key of ['contributions', 'timestamp', 'sourcePath', 'nativeSessionId', 'title', 'projectLabel']) assert.equal(text.includes(`"${key}"`), false, key);
});

test('same event ids are stable across native and mirror agents while disjoint ids stay distinct', () => {
  const a = identityPeriodFromState(state([event('shared', 10, 'native'), event('native-only')]));
  const b = identityPeriodFromState(state([event('shared', 10, 'mirror'), event('mirror-only', 2, 'mirror')]));
  assert.equal(a.events[0].id, b.events[0].id);
  assert.notEqual(a.events[1].id, b.events[1].id);
  assert.equal(b.events[0].observationKind, 'mirror');
});

for (const mutation of [s => { s.version = 1; }, s => { s.eventIdentityVersion = 1; },
  s => { s.scopes[0].readStatus = 'partial'; }, s => { s.scopes[0].readStatus = 'unknown'; },
  s => { s.scopes[0].identityStatus = 'unresolved'; }, s => { s.rowsWithoutIdentity.claude = 1; }]) {
  test(`unsupported or incomplete native export omits proof: ${mutation.toString()}`, () => {
    const s = source([event('A')]); mutation(s);
    assert.equal(periodIdentityStateFromSource(s, nativePeriod([event('A')]), options), null);
  });
}

test('unidentified events remain additive and never acquire an inferred native identity', () => {
  const s = source([event('A'), { ...event('unknown'), observationKind: undefined }]);
  const proof = identityPeriodFromState(periodIdentityStateFromSource(s, nativePeriod([event('A')]), options));
  assert.deepEqual(proof.events.map(e => e.id), [id('A')]);
});

test('duplicate event keys or overclaimed model and session counters fail closed', () => {
  assert.equal(periodIdentityStateFromSource(source([event('A'), event('A')]), nativePeriod([event('A')]), options), null);
  const s = state([event('A')]);
  const period = nativePeriod([event('A')]);
  period.outputTokens--;
  assert.equal(usageIdentityFromState({ today: s }, { today: period }), null);
  const changedModel = nativePeriod([event('A')]);
  changedModel.models = { wrong: 20 };
  assert.equal(usageIdentityFromState({ today: s }, { today: changedModel }), null);
});

test('watch replaces today claims including corrections and deletion while preserving older fragments', () => {
  const older = event('past', 30, 'native', Date.parse('2026-10-12T06:00:00Z'));
  const base = state([older, event('A'), event('deleted')]);
  const corrected = state([event('A', 4), event('new', 7, 'mirror')]);
  const next = identityPeriodFromState(replaceIdentityToday(base, corrected, day));
  assert.deepEqual(new Set(next.events.map(e => e.id)), new Set([id('past'), id('A'), id('new')]));
  assert.equal(next.events.find(e => e.id === id('A')).usage.totalTokens, 14);
  const deleted = identityPeriodFromState(replaceIdentityToday(base, state([]), day));
  assert.deepEqual(deleted.events.map(e => e.id), [id('past')]);
  assert.equal(replaceIdentityToday(base, null, day), null);
});

test('one event spanning yesterday and today retains only yesterday after a today deletion', () => {
  const multi = event('spans');
  multi.contributions.push({ ...multi.contributions[0], timestamp: Date.parse('2026-10-12T06:00:00Z') });
  const broad = state([multi]);
  const replaced = identityPeriodFromState(replaceIdentityToday(broad, state([]), day));
  assert.equal(replaced.events[0].usage.totalTokens, 20);
});

test('accepted ledger History claims preserve ids and existing day shape, rejected graph cannot replace claims', () => {
  const events = [event('A', 8, 'mirror')];
  const graph = { sourceUsage: { ...source(events), fullHistory: true }, contributions: [] };
  const captured = captureSourceLedger(undefined, [graph], { retainedBoundaryChecked: true });
  const projection = projectSourceLedger(captured.ledger, options);
  const ledger = getSourceLedger(projection);
  const proof = historyIdentityFromLedger(ledger, { timeZone: 'UTC' });
  assert.equal(proof.events[0].id, id('A'));
  assert.equal(proof.events[0].observationKind, 'mirror');
  const usage = proof.events[0].days[0].usage;
  assert.equal(usage.tokens, 18);
  assert.equal(usage.cost, 0.08);
  assert.equal(usage.messages, 1);
  assert.equal(usage.outputTokens, 3);
  assert.equal(usage.perClient.claude.tokens, 18);
  assert.equal(Object.values(usage.perModel)[0].tokens, 18);
  const rejected = captureSourceLedger(ledger, [{ ...graph, sourceUsage: { ...graph.sourceUsage,
    capturedAt: '2026-10-13T07:00:00.000Z', scopes: [{ ...graph.sourceUsage.scopes[0], readStatus: 'partial' }] } }]);
  assert.deepEqual(historyIdentityFromLedger(rejected.ledger, { timeZone: 'UTC' }), proof);
  assert.equal(identityStateFromLedger(ledger, { today: nativePeriod(events), month: nativePeriod(events), allTime: nativePeriod(events) }, options).today.events[0].id, id('A'));
});

test('project claims use accepted canonical project keys and preserve the full contribution', () => {
  const events = [event('A')];
  const period = nativePeriod(events);
  period.sessions['claude:session'].projectId = 'project:opaque';
  period.sessions['claude:session'].projectLabel = 'My Project';
  period.projects = { 'my project': { label: 'My Project', tokens: 20, costUsd: 0.1, clients: { claude: 20 }, unpricedTokens: 2 } };
  const proof = usageIdentityFromState({ today: state(events) }, { today: period });
  assert.equal(proof.periods.today.events[0].usage.projects['my project'].tokens, 20);
  assert.equal(proof.periods.today.events[0].usage.projects['my project'].costUsd, 0.1);
  assert.deepEqual(Object.keys(proof.periods.today.events[0].usage.projects), ['my project']);
  assert.equal(JSON.stringify(proof).includes('projectLabel'), false);
});

test('accepted History includes old days retained only by a monthly tier', () => {
  const e = event('old', 7, 'mirror', Date.parse('2026-05-10T06:00:00Z'));
  const ledger = captureSourceLedger(undefined, [{ sourceUsage: { ...source([e]), fullHistory: true } }], { retainedBoundaryChecked: true }).ledger;
  const proof = historyIdentityFromLedger(ledger, { timeZone: 'UTC', history: { daily: [], monthly: [{ month: '2026-05' }] } });
  assert.equal(proof.events[0].days[0].date, '2026-05-10');
  assert.equal(proof.events[0].days[0].usage.tokens, 17);
});

test('accepted no-archive windows carry aggregates only within their bounds and rebucket dated event claims at rollover', () => {
  const events = [event('A')];
  const accepted = { dateKey: day, periods: Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, nativePeriod(events)])),
    identityState: Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, state(events)])) };
  const nextDay = acceptedClaudeWindows(accepted, { todayKey: '2026-10-14', allTimeSince: '2026-01-01' });
  assert.equal(nextDay.periods.today.totalTokens, 0);
  assert.equal(nextDay.periods.month.totalTokens, 20);
  const nextMonth = acceptedClaudeWindows(accepted, { todayKey: '2026-11-01', allTimeSince: '2026-01-01' });
  assert.equal(nextMonth.periods.today.totalTokens, 0);
  assert.equal(nextMonth.periods.month.totalTokens, 0);
  assert.equal(nextMonth.periods.allTime.totalTokens, 20);
  assert.equal(nextMonth.identityState.month.events.length, 0);
  assert.equal(nextMonth.identityState.allTime.events[0].id, id('A'));
});
