'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  addPeriodInto, aggregateDevices, applyPeriodDelta, emptyPeriod,
  extractUsageBundleFromTokscale, extractUsageFromTokscale, mergePeriods, normalizePeriod
} = require('../../src/shared/usage');
const { applyTokscaleSessionMetadata } = require('../../src/shared/sessionMetadata');
const { applyRowUsageSource, sourceFromRow } = require('../../src/shared/usageSource');
const { serializeSyncPayload, syncPayload } = require('../../src/shared/syncPayload');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');

const ACCOUNT_A = `sha256:${'a'.repeat(64)}`;
const ACCOUNT_B = `sha256:${'b'.repeat(64)}`;

function row(usageSource, overrides = {}) {
  return {
    client: 'claude', sessionId: 's1', model: 'claude-opus-4-8',
    input: 100, output: 40, cacheRead: 800, cacheWrite: 60, messageCount: 2,
    performance: { totalDurationMs: 1000, timedTokens: 900 }, usageSource, ...overrides
  };
}
function extract(entries) { return extractUsageFromTokscale({ entries }); }
function sources(period) { return Object.values(period.modelSourceThroughput || {}); }
function source(accountId = ACCOUNT_A, platform = 'anthropic', accessType = 'subscription') {
  return { platform, accountId, accessType };
}

function assertSameCounters(actual, expected) {
  assert.equal(actual.timedOutputTokens, expected.timedOutputTokens);
  assert.equal(actual.timedDurationMs, expected.timedDurationMs);
}

test('one model retains distinct platforms, accounts and subscription/API access in exact client partitions', () => {
  const bundle = extractUsageBundleFromTokscale({ entries: [
    row(source()), row(source(ACCOUNT_B)), row(source(ACCOUNT_A, 'anthropic', 'api')),
    row(source(ACCOUNT_A, 'workbuddy-ai')), row(source(), { client: 'dsh' })
  ] });
  assert.equal(sources(bundle.period).length, 5);
  assert.equal(sources(bundle.byClient.claude).length, 4);
  assert.equal(sources(bundle.byClient.dsh).length, 1);
  for (const entry of sources(bundle.period)) assertSameCounters(entry, { timedOutputTokens: 40, timedDurationMs: 1000 });
  const totals = sources(bundle.period).reduce((sum, entry) => ({
    timedOutputTokens: sum.timedOutputTokens + entry.timedOutputTokens,
    timedDurationMs: sum.timedDurationMs + entry.timedDurationMs
  }), { timedOutputTokens: 0, timedDurationMs: 0 });
  assertSameCounters(totals, bundle.period);
});

test('aggregate-only nonzero usage does not imply an empty known source catalog', () => {
  const result = extractUsageFromTokscale({ totalTokens: 100 });
  assert.equal(result.totalTokens, 100);
  assert.equal(result.modelUsageSources, undefined);
  assert.equal(result.modelSourceThroughput, undefined);
  assert.deepEqual(extractUsageFromTokscale({ totalTokens: 0 }).modelUsageSources, Object.create(null));
});

test('legacy rows retain only observed provider with unknown account and access', () => {
  const result = extract([row(undefined, { provider: 'magpie' }), row(undefined)]);
  const [observed, missing] = sources(result);
  assert.equal(observed.platform, 'magpie');
  assert.equal(observed.accountId, '');
  assert.equal(observed.accessType, 'unknown');
  assert.equal(missing.platform, '');
  assert.equal(missing.accountLabel, '');
  assert.equal(missing.accessType, 'unknown');
});

test('collector hashes identities even without session/workspace arrays and strips raw account labels', () => {
  const entries = [row({ platform: 'Anthropic', accountId: 'one@example.invalid', accountLabel: 'one@example.invalid', accessType: 'api' })];
  assert.deepEqual(applyTokscaleSessionMetadata({ entries }), { sessions: 0, projects: 0 });
  assert.match(entries[0].usageSource.accountId, /^sha256:[a-f0-9]{64}$/);
  assert.match(entries[0].usageSource.accountLabel, /^账号 [a-f0-9]{8}$/);
  assert.equal(entries[0].usageSource.platform, 'anthropic');
  const serialized = JSON.stringify(extract(entries));
  assert.equal(serialized.includes('one@example.invalid'), false);
  assert.deepEqual(sourceFromRow(row(entries[0].usageSource)), entries[0].usageSource);
  assert.notEqual(sourceFromRow(row({ platform: 'openai', accountId: 'one@example.invalid' })).accountId, entries[0].usageSource.accountId);
});

test('collector sanitizes per-request source splits and preserves their native counters', () => {
  const entry = row(undefined, { usageSources: [
    { usageSource: { platform: 'anthropic', accountId: 'secret@example.invalid', accessType: 'api', apiKey: 'secret-key' }, timedOutputTokens: 10, timedDurationMs: 200 }
  ] });
  applyRowUsageSource(entry);
  assert.equal(JSON.stringify(entry.usageSources).includes('secret'), false);
  assertSameCounters(entry.usageSources[0], { timedOutputTokens: 10, timedDurationMs: 200 });
});

test('exact native source splits preserve sums across account switches', () => {
  const result = extract([row(undefined, { usageSources: [
    { usageSource: source(), timedOutputTokens: 10, timedDurationMs: 200 },
    { usageSource: source(ACCOUNT_B, 'anthropic', 'api'), timedOutputTokens: 30, timedDurationMs: 800 }
  ] })]);
  assert.equal(sources(result).length, 2);
  assertSameCounters(sources(result)[0], { timedOutputTokens: 10, timedDurationMs: 200 });
  assertSameCounters(sources(result)[1], { timedOutputTokens: 30, timedDurationMs: 800 });
  assertSameCounters(result, { timedOutputTokens: 40, timedDurationMs: 1000 });
});

test('partial native attribution leaves remainder on observed unknown source', () => {
  const result = extract([row(undefined, { provider: 'magpie', usageSources: [
    { usageSource: source(), timedOutputTokens: 10, timedDurationMs: 200 }
  ] })]);
  const [known, unknown] = sources(result);
  assertSameCounters(known, { timedOutputTokens: 10, timedDurationMs: 200 });
  assert.equal(unknown.platform, 'magpie');
  assert.equal(unknown.accountId, '');
  assertSameCounters(unknown, { timedOutputTokens: 30, timedDurationMs: 800 });
});

test('oversized, missing-time or inconsistent native splits cannot misattribute aggregate output', () => {
  for (const counters of [
    { timedOutputTokens: 41, timedDurationMs: 1000 },
    { timedOutputTokens: 30, timedDurationMs: 1000 },
    { timedOutputTokens: 30, timedDurationMs: 0 },
    { timedOutputTokens: 30, timedDurationMs: NaN }
  ]) {
    const result = extract([row(undefined, { provider: 'magpie', usageSources: [{ usageSource: source(), ...counters }] })]);
    assert.equal(sources(result).length, 1);
    assert.equal(sources(result)[0].accountId, '');
    assert.equal(sources(result)[0].platform, 'magpie');
    assertSameCounters(sources(result)[0], result);
  }
});

test('normalization ignores raw dictionary keys and rejects raw account identities and arbitrary metadata', () => {
  const original = extract([row(source())]);
  const dangerous = JSON.parse('{"__proto__":{"model":"claude-opus-4-8","client":"claude","platform":"Anthropic","accountId":"raw@example.invalid","accountLabel":"sk-secret","accessType":"api","timedOutputTokens":999,"timedDurationMs":99999}}');
  const normalized = normalizePeriod({ ...original, modelSourceThroughput: dangerous });
  const [entry] = sources(normalized);
  assert.equal(entry.platform, 'anthropic');
  assert.equal(entry.accountId, '');
  assert.equal(entry.accountLabel, '');
  assertSameCounters(entry, original);
  assert.equal(JSON.stringify(normalized.modelSourceThroughput).includes('raw@example.invalid'), false);
  assert.equal(Object.getPrototypeOf(normalized.modelSourceThroughput), null);
  assert.equal(Object.hasOwn(normalized.modelSourceThroughput, '__proto__'), false);
});

test('missing and malformed source maps remain unavailable while an empty source map is an exact baseline', () => {
  for (const modelSourceThroughput of [undefined, null, [], { bad: null }, { bad: {} }]) {
    const normalized = normalizePeriod({ ...extract([row(source())]), modelSourceThroughput });
    assert.equal(normalized.modelSourceThroughput, undefined);
  }
  assert.equal(normalizePeriod(undefined).modelSourceThroughput, undefined);
  assert.equal(Object.keys(normalizePeriod({ modelSourceThroughput: {} }).modelSourceThroughput).length, 0);
  assert.equal(Object.keys(emptyPeriod().modelSourceThroughput).length, 0);
});

test('normalization bounds combined source counters against model and period counters', () => {
  const original = extract([row(source())]);
  const normalized = normalizePeriod({ ...original, modelSourceThroughput: {
    one: { ...sources(original)[0], timedOutputTokens: 39, timedDurationMs: 900 },
    two: { ...sources(original)[0], accountId: ACCOUNT_B, timedOutputTokens: 100, timedDurationMs: 1000 }
  } });
  assertSameCounters(sources(normalized)[0], { timedOutputTokens: 39, timedDurationMs: 900 });
  assertSameCounters(sources(normalized)[1], { timedOutputTokens: 1, timedDurationMs: 100 });
});

test('merge, ingest and synchronization preserve whitelisted source metadata and additive counters', () => {
  const a = extract([row(source())]);
  const b = extract([row(source()), row(source(ACCOUNT_B, 'openai', 'api'))]);
  const merged = mergePeriods(a, b);
  assert.equal(sources(merged).length, 2);
  assertSameCounters(sources(merged)[0], { timedOutputTokens: 80, timedDurationMs: 2000 });
  const target = emptyPeriod();
  addPeriodInto(target, a);
  assert.deepEqual(sources(target), sources(a));
  const payload = syncPayload({ deviceId: 'd', today: a, month: merged, allTime: merged });
  assert.deepEqual(sources(normalizePeriod(payload.month)), sources(merged));
  const fleet = aggregateDevices([{ deviceId: 'a', today: a, month: a, allTime: a }, { deviceId: 'b', today: b, month: b, allTime: b }]);
  assert.deepEqual(sources(fleet.periods.today), sources(merged));
  assert.equal(mergePeriods(a, { ...a, modelSourceThroughput: undefined }).modelSourceThroughput, undefined);
});

test('anchored delta changes only counters and drops removed sources with unavailable propagation', () => {
  const anchor = extract([row(source())]);
  const fresh = extract([row(source()), row(source(ACCOUNT_B, 'openai', 'api'))]);
  const base = extract([row(source()), row(source())]);
  const result = applyPeriodDelta(base, fresh, anchor);
  assert.equal(sources(result).length, 2);
  assert.equal(sources(result)[0].accessType, 'subscription');
  assert.equal(sources(result)[1].accountId, ACCOUNT_B);
  assertSameCounters(sources(result)[0], { timedOutputTokens: 80, timedDurationMs: 2000 });
  assertSameCounters(sources(result)[1], { timedOutputTokens: 40, timedDurationMs: 1000 });
  assert.equal(sources(applyPeriodDelta(anchor, emptyPeriod(), anchor)).length, 0);
  assert.equal(applyPeriodDelta(base, { ...fresh, modelSourceThroughput: undefined }, anchor).modelSourceThroughput, undefined);
});

test('untimed output never borrows a timed source clock', () => {
  const result = extract([row(source()), row(source(ACCOUNT_B), { output: 1000, performance: undefined })]);
  assert.equal(sources(result).length, 1);
  assert.equal(Object.values(result.modelUsageSources).length, 2);
  assertSameCounters(result, { timedOutputTokens: 40, timedDurationMs: 1000 });
});

test('usage transforms retain exact live source attribution when archive capture is disabled', () => {
  const period = extract([row(source())]);
  const summary = { deviceId: 'a', today: period, month: period, allTime: period };
  const transform = createUsageTransform({ getSettings: () => ({ sessionUsageArchiveEnabled: false }) });
  const visible = transform.transform(summary);
  assert.deepEqual(sources(visible.today), sources(period));
  assert.deepEqual(sources(visible.allTime), sources(period));
});

test('untimed request references distinguish historical platforms and accounts without changing native speed', () => {
  const result = extract([row(undefined, { client: 'dsh', provider: 'magpie', performance: undefined,
    usageSourceReferences: [
      { usageSource: source(), outputTokens: 10 },
      { usageSource: source(ACCOUNT_B, 'workbuddy-ai', 'api'), outputTokens: 30 }
    ]
  })]);
  const entries = Object.values(result.modelUsageSources);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].outputTokens, 10);
  assert.equal(entries[1].outputTokens, 30);
  assert.equal(entries[1].platform, 'workbuddy-ai');
  assert.equal(entries[1].accountId, ACCOUNT_B);
  assert.equal(entries[1].accessType, 'api');
  assertSameCounters(result, { timedOutputTokens: 0, timedDurationMs: 0 });
  assert.equal(result.outputTokens, 40);
});

test('reference splits leave unknown output remainder and reject impossible allocations', () => {
  const partial = extract([row(undefined, { provider: 'magpie', usageSourceReferences: [{ usageSource: source(), outputTokens: 10 }] })]);
  const entries = Object.values(partial.modelUsageSources);
  assert.equal(entries[0].outputTokens, 10);
  assert.equal(entries[1].outputTokens, 30);
  assert.equal(entries[1].platform, 'magpie');
  assert.equal(entries[1].accountId, '');
  const invalid = extract([row(undefined, { provider: 'magpie', usageSourceReferences: [{ usageSource: source(), outputTokens: 41 }] })]);
  assert.equal(Object.values(invalid.modelUsageSources).length, 1);
  assert.equal(Object.values(invalid.modelUsageSources)[0].accountId, '');
});

test('reference metadata is sanitized, capped, retained in merge/deltas/sync, and unavailable if absent', () => {
  const a = extract([row(source())]);
  const b = extract([row(source()), row(source(ACCOUNT_B))]);
  const merged = mergePeriods(a, b);
  assert.equal(Object.values(merged.modelUsageSources)[0].outputTokens, 80);
  assert.equal(Object.values(merged.modelUsageSources)[1].outputTokens, 40);
  assert.deepEqual(normalizePeriod(syncPayload({ today: merged }).today).modelUsageSources, merged.modelUsageSources);
  const delta = applyPeriodDelta(a, b, a);
  assert.deepEqual(delta.modelUsageSources, b.modelUsageSources);
  assert.equal(applyPeriodDelta(a, { ...b, modelUsageSources: undefined }, a).modelUsageSources, undefined);
  assert.equal(mergePeriods(a, { ...b, modelUsageSources: undefined }).modelUsageSources, undefined);
  assert.equal(normalizePeriod({ ...a, modelUsageSources: { bad: {} } }).modelUsageSources, undefined);
  assert.equal(Object.keys(normalizePeriod({ modelUsageSources: {} }).modelUsageSources).length, 0);
  const normalized = normalizePeriod({ ...a, modelUsageSources: { 'raw-key': {
    model: 'claude-opus-4-8', client: 'claude', platform: 'anthropic',
    accountId: 'private@example.invalid', accountLabel: 'sk-private', accessType: 'api', outputTokens: 100000
  } } });
  const [entry] = Object.values(normalized.modelUsageSources);
  assert.equal(entry.outputTokens, 40);
  assert.equal(entry.accountId, '');
  assert.equal(JSON.stringify(normalized.modelUsageSources).includes('private'), false);
});

test('collector hashes untimed request references before portable aggregation', () => {
  const entry = row(undefined, { usageSourceReferences: [
    { usageSource: { platform: 'openai', accountId: 'private@example.invalid', accessType: 'subscription' }, outputTokens: 40 }
  ] });
  applyRowUsageSource(entry);
  assert.equal(JSON.stringify(entry.usageSourceReferences).includes('private'), false);
  assert.match(entry.usageSourceReferences[0].usageSource.accountId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.values(extract([entry]).modelUsageSources)[0].outputTokens, 40);
});

test('historical source dates sanitize and retain latest observed usage across extraction, merge and deltas', () => {
  const old = '2026-10-01T12:00:00.000Z';
  const recent = '2026-10-08T12:00:00.000Z';
  const a = extract([row(source(), { lastUsedAt: old })]);
  const b = extract([row(source(), { lastUsedAt: recent })]);
  const split = extract([row(undefined, { lastUsedAt: recent, usageSourceReferences: [
    { usageSource: source(), outputTokens: 10, lastUsedAt: old },
    { usageSource: source(ACCOUNT_B), outputTokens: 30, lastUsedAt: recent }
  ] })]);
  const entries = Object.values(split.modelUsageSources);
  assert.equal(entries[0].lastUsedAt, old);
  assert.equal(entries[1].lastUsedAt, recent);
  assert.equal(Object.values(mergePeriods(a, b).modelUsageSources)[0].lastUsedAt, recent);
  assert.equal(Object.values(mergePeriods(b, a).modelUsageSources)[0].lastUsedAt, recent);
  assert.equal(Object.values(applyPeriodDelta(b, a, a).modelUsageSources)[0].lastUsedAt, recent);
  const entry = Object.values(a.modelUsageSources)[0];
  const normalized = normalizePeriod({ ...a, modelUsageSources: { bad: { ...entry, lastUsedAt: 'email@example.invalid' } } });
  assert.equal(Object.values(normalized.modelUsageSources)[0].lastUsedAt, undefined);
  assert.equal(Object.values(normalizePeriod(split).modelUsageSources)[1].lastUsedAt, recent);
});

test('source catalogs cap at 128 deterministic identities across extraction, normalization, merge and delta', () => {
  const rows = Array.from({ length: 160 }, (_, index) => row(source(`sha256:${index.toString(16).padStart(64, '0')}`)));
  const a = extract(rows);
  const b = extract(rows.toReversed());
  const canonical = (period, field) => Object.entries(period[field]).sort(([aKey], [bKey]) => aKey < bKey ? -1 : aKey > bKey ? 1 : 0);
  for (const field of ['modelUsageSources', 'modelSourceThroughput']) {
    assert.equal(Object.keys(a[field]).length, 128);
    assert.deepEqual(canonical(a, field), canonical(b, field));
    const one = extract(rows.slice(0, 80));
    const two = extract(rows.slice(80));
    assert.deepEqual(canonical(mergePeriods(one, two), field), canonical(a, field));
    assert.deepEqual(canonical(mergePeriods(two, one), field), canonical(a, field));
    assert.equal(Object.keys(applyPeriodDelta(one, two, emptyPeriod())[field]).length, 128);
    const raw = Object.assign({}, one[field], two[field]);
    const reverse = Object.fromEntries(Object.entries(raw).toReversed());
    assert.deepEqual(canonical(normalizePeriod({ ...a, [field]: raw }), field), canonical(normalizePeriod({ ...a, [field]: reverse }), field));
    assert.equal(Object.keys(normalizePeriod({ ...a, [field]: raw })[field]).length, 128);
  }
  assertSameCounters(a, { timedOutputTokens: 6400, timedDurationMs: 160000 });
  assert.equal(a.outputTokens, 6400);
});

test('payload pressure omits optional source detail without deleting source summaries or sessions', () => {
  const sourceMap = Object.fromEntries(Array.from({ length: 6000 }, (_, index) => [`key-${index}`, {
    model: `model-${index}`, client: 'claude', platform: 'anthropic', accountId: ACCOUNT_A,
    accountLabel: '账号 aaaaaaaa', accessType: 'subscription', timedOutputTokens: 1, timedDurationMs: 1
  }]));
  const today = { ...extract([row(source())]), modelSourceThroughput: sourceMap };
  const payload = serializeSyncPayload({ deviceId: 'a', today, month: today, allTime: today }).payload;
  assert.equal(payload.today.modelSourceThroughput, undefined);
  assertSameCounters(payload.today, today);
  assert.deepEqual(payload.today.sessions, syncPayload({ today }).today.sessions);
  assert.strictEqual(today.modelSourceThroughput, sourceMap);
});
