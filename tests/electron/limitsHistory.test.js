'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLimitsHistoryStore } = require('../../src/electron/limits/historyStore');
const { historyAccountKey, historyRowKey } = require('../../src/electron/limits/historyIdentity');
const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers');
const { distribution, segments, trendBounds, historyReadings } = require('../../src/electron/renderer/limits/historyModel');
const { historyBounds, createLimitsHistoryController } = require('../../src/electron/limits/historyController');
const { EventEmitter } = require('node:events');
const { normalizeLimitProvider } = require('../../src/shared/limits/core');
const { mapClaudeUsageToProvider } = require('../../src/shared/providers/claude/limits');

const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const point = (time, value, reset = null) => ({ at: time, value, reset, interval: 300_000, balance: false, unit: 'pp' });
function provider(time, used = 20) {
  return { provider: 'codex', accountKey: 'account-a', accountEmail: 'private@example.com', status: 'ok', updatedAt: new Date(time).toISOString(),
    windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: used, remainingPercent: 100 - used, resetsAt: new Date(at(8, 0)).toISOString() }] };
}

const { DatabaseSync } = require('node:sqlite');
const { createHistoryDatabase, retentionStart } = require('../../src/electron/limits/historyDatabase');
const { dayKey } = require('../../src/electron/renderer/limits/historyModel');
const streamA = 'a'.repeat(64), streamB = 'b'.repeat(64);
const accountA = 'c'.repeat(64), accountB = 'd'.repeat(64);
function action(time, value = 20, { id = streamA, account = accountA, source = '', reset = null, interval = 300_000 } = {}) {
  return { account, source, windows: [{ id, point: { ...point(time, value, reset), interval } }] };
}
function databaseFixture(t, clock = at(2, 12)) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-sqlite-'));
  const file = path.join(directory, 'history.sqlite');
  const errors = [];
  let database = createHistoryDatabase(file, { onError: error => errors.push(error) });
  const inspect = new DatabaseSync(file, { readOnly: true });
  const fixture = {
    file, errors, clock,
    record(actions) { return database.record(actions, fixture.clock); },
    query(range = { grain: 'day', day: dayKey(fixture.clock) }, id = streamA) {
      return database.query([{ id, key: 'weekly', window: { kind: 'weekly' } }], range, fixture.clock);
    },
    sql(query, ...args) { return inspect.prepare(query).all(...args).map(row => ({ ...row })); },
    reopen() { database.close(); database = createHistoryDatabase(file, { onError: error => errors.push(error) }); }
  };
  t.after(() => { inspect.close(); database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return fixture;
}

test('trend axes show the complete advertised cycle regardless of when observation starts', () => {
  const weekly = { windowMinutes: 10080, resetsAt: new Date(at(6, 18)).toISOString() };
  for (const now of [at(1, 10), at(3, 11), at(6, 17)]) {
    assert.deepEqual(trendBounds(weekly, now), { start: at(6, 18) - 7 * 86400_000, end: at(6, 18), cycle: true });
  }
  assert.deepEqual(trendBounds({ windowMinutes: 300, resetsAt: new Date(at(3, 18)).toISOString() }, at(3, 14)),
    { start: at(3, 13), end: at(3, 18), cycle: true });
  const now = at(3, 11);
  assert.deepEqual(trendBounds({}, now), { start: now - 14 * 86400_000, end: now, cycle: false });
});

test('an advertised weekly cycle keeps missing early observations empty instead of fabricating a starting reading', t => {
  const f = databaseFixture(t, at(3, 12));
  f.record([action(at(3, 11), 20, { reset: at(6, 18) })]);
  const result = f.query().windows[0];
  assert.deepEqual(result.points.map(p => [p.at, p.value]), [[at(3, 11), 20]]);
  assert.equal(result.distribution.buckets.at(-1).value, null);
});

for (const source of ['oauth', 'web']) {
  test(`Claude ${source} mapped quota windows retain their true cycle bounds without explicit minutes`, () => {
    const row = mapClaudeUsageToProvider({
      five_hour: { utilization: 3, resets_at: new Date(at(3, 15)).toISOString() },
      seven_day: { utilization: 0, resets_at: new Date(at(6, 18)).toISOString() },
      limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, utilization: 4, resets_at: new Date(at(5, 18)).toISOString() }]
    }, { source, updatedAt: new Date(at(3, 11)).toISOString() });
    assert.equal(row.windows.length, 3);
    assert.ok(row.windows.every(window => window.windowMinutes === null));
    assert.deepEqual(row.windows.map(window => trendBounds(window, at(3, 11), row.provider)), [
      { start: at(3, 10), end: at(3, 15), cycle: true },
      { start: at(6, 18) - 7 * 86400_000, end: at(6, 18), cycle: true },
      { start: at(5, 18) - 7 * 86400_000, end: at(5, 18), cycle: true }
    ]);
  });
}

test('semantic cycle durations never override explicit minutes or invent another provider session length', () => {
  const reset = new Date(at(3, 15)).toISOString();
  assert.deepEqual(trendBounds({ kind: 'weekly', windowMinutes: 60, resetsAt: reset }, at(3, 11)),
    { start: at(3, 14), end: at(3, 15), cycle: true });
  assert.deepEqual(trendBounds({ kind: 'daily', resetsAt: reset }, at(3, 11)),
    { start: at(2, 15), end: at(3, 15), cycle: true });
  assert.deepEqual(trendBounds({ kind: 'session', resetsAt: reset }, at(3, 11), 'other'),
    { start: at(3, 11) - 14 * 86400_000, end: at(3, 11), cycle: false });
});

test('SQLite queries use Claude semantic session bounds and retain only actual observations inside the cycle', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-claude-cycle-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(3, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let row;
  for (const time of [at(-2, 12), at(3, 9), at(3, 11)]) {
    row = mapClaudeUsageToProvider({
      five_hour: { utilization: 3, resets_at: new Date(at(3, 15)).toISOString() },
      seven_day: { utilization: 0, resets_at: new Date(at(6, 18)).toISOString() }
    }, { accountKey: 'claude-cycle', source: 'oauth', updatedAt: new Date(time).toISOString() });
    await store.record('local', { providers: [row] });
  }
  const result = await store.query('local', row);
  assert.deepEqual(result.windows[0].points.map(p => p.at), [at(3, 11)]);
  assert.deepEqual(result.windows[1].points.map(p => p.at), [at(3, 9), at(3, 11)]);
});

test('SQLite stores one unchanged value across hours with only hourly coverage records', t => {
  const fixture = databaseFixture(t);
  const raw = [];
  const actions = [];
  for (let time = at(2, 8); time < at(2, 12); time += 60_000) {
    raw.push({ ...point(time, 20), interval: 60_000 });
    actions.push(action(time, 20, { interval: 60_000 }));
  }
  fixture.record(actions);
  assert.deepEqual(fixture.sql('SELECT at, until, value FROM runs'), [{ at: at(2, 8), until: at(2, 11, 59), value: 20 }]);
  const coverage = fixture.sql('SELECT samples, max_gap FROM coverage');
  assert.equal(coverage.length, 4);
  assert.ok(coverage.every(row => row.samples === 60 && row.max_gap === 60_000));
  for (const grain of ['hour', 'day']) {
    const range = { grain, day: dayKey(fixture.clock) };
    const result = fixture.query(range).windows[0];
    assert.deepEqual(result.distribution, distribution(raw, { ...range, now: fixture.clock }));
    assert.equal(segments(result.points).length, 1);
  }
  fixture.reopen();
  fixture.record([action(at(2, 12), 20, { interval: 60_000 })]);
  assert.equal(fixture.sql('SELECT id FROM runs').length, 1);
  fixture.clock += 60_000;
  fixture.record([action(fixture.clock, 21, { interval: 60_000 })]);
  assert.equal(fixture.sql('SELECT id FROM runs').length, 2);
});

test('mixed changes, midnight, resets, sampling cadence and outages preserve daily and hourly results', t => {
  const fixture = databaseFixture(t);
  const raw = [], actions = [];
  let value = 20, time = at(1, 22), reset = at(8, 0);
  for (let index = 0; index < 120; index++) {
    const interval = index < 65 ? 300_000 : 60_000;
    time += index === 30 ? 3600_000 : interval;
    if (index === 60) { value = 0; reset = at(9, 0); }
    else if (index % 9 === 0) value += 2;
    raw.push({ ...point(time, value, reset), interval });
    actions.push(action(time, value, { reset, interval }));
  }
  fixture.record(actions);
  for (const grain of ['day', 'hour']) {
    const range = { grain, day: dayKey(fixture.clock) };
    assert.deepEqual(fixture.query(range).windows[0].distribution, distribution(raw, { ...range, now: fixture.clock }));
  }
});

for (const scenario of [
  { name: 'unchanged deadline', values: [78, 80, 0, 3], after: 0 },
  { name: 'new deadline', values: [78, 80, 0, 3], after: 0, moved: true },
  { name: 'no advertised deadline', values: [78, 80, 0, 3], after: 0, missing: true },
  { name: 'partial refill before the deadline', values: [78, 80, 25, 28], after: 25 },
  { name: 'two unscheduled resets', values: [78, 80, 0, 3, 0, 4], after: 0, twice: true }
]) {
  test(`Codex unscheduled reset with ${scenario.name} survives restart and preserves consumption`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-reset-'));
    const file = path.join(directory, 'history.sqlite');
    const errors = [];
    const options = { now: () => at(2, 12), onError: error => errors.push(error.message) };
    let store = createLimitsHistoryStore(file, options);
    t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    let row;
    for (const [index, value] of scenario.values.entries()) {
      row = provider(at(2, 10, index * 5), value);
      row.windows[0].windowMinutes = 10080;
      row.windows[0].resetsAt = scenario.missing ? null
        : new Date(at(scenario.moved && index >= 2 ? 9 : 8, 0)).toISOString();
      await store.record('local', { refreshMs: 300_000, providers: [row] });
      if (index === 2) { await store.close(); store = createLimitsHistoryStore(file, options); }
    }
    const daily = await store.query('local', row);
    const hourly = await store.query('local', row, { grain: 'hour', day: '2026-11-02' });
    const expected = scenario.twice ? 9 : 5;
    assert.deepEqual(segments(daily.windows[0].points).map(run => run.map(p => p.value)),
      scenario.twice ? [[78, 80], [0, 3], [0, 4]] : [[78, 80], [scenario.after, scenario.after + 3]]);
    assert.equal(daily.windows[0].distribution.buckets.at(-1).value, expected);
    assert.equal(daily.windows[0].distribution.buckets.at(-1).uncertain, true);
    assert.equal(daily.windows[0].distribution.resets, scenario.twice ? 2 : 1);
    assert.equal(daily.windows[0].distribution.unallocated, 0);
    assert.equal(hourly.windows[0].distribution.buckets.find(bucket => new Date(bucket.at).getHours() === 10).value, expected);
    assert.deepEqual(errors, []);
  });
}

test('portable account identities merge devices for every provider while row handles and quota pools stay distinct', () => {
  for (const id of LIMIT_PROVIDER_IDS) {
    const a = { ...provider(at(2, 10)), provider: id, sourceDeviceId: 'mac', sourceDetail: 'MacBook' };
    const b = { ...a, sourceDeviceId: 'pc', sourceDetail: 'Desktop', accountLabel: 'Renamed plan' };
    assert.equal(historyAccountKey(a), historyAccountKey(b), id);
    assert.notEqual(historyRowKey(a), historyRowKey(b), id);
    for (const difference of [{ accountKey: 'other' }, { region: 'cn-personal' }, { workspaceKind: 'team' }, { adapterId: 'other-adapter' }]) {
      assert.notEqual(historyAccountKey(a), historyAccountKey({ ...a, ...difference }), `${id}: ${JSON.stringify(difference)}`);
      assert.notEqual(historyRowKey(a), historyRowKey({ ...a, ...difference }), id);
    }
  }
  for (const row of [
    { provider: 'codex', accountLabel: 'Pro' },
    { provider: 'antigravity', accountKey: 'local-rpc-id' },
    { provider: 'kiro', accountKey: 'default-id', source: 'cli' }
  ]) {
    assert.notEqual(historyAccountKey({ ...row, sourceDeviceId: 'a' }), historyAccountKey({ ...row, sourceDeviceId: 'b' }));
  }
  const muse = { ...provider(at(2, 10)), provider: 'muse' };
  assert.notEqual(historyAccountKey({ ...muse, source: 'cli' }), historyAccountKey({ ...muse, source: 'web' }));
});

test('all providers share one persisted account history when the reporting device changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-devices-'));
  const file = path.join(directory, 'history.sqlite');
  const options = { now: () => at(2, 12) };
  let store = createLimitsHistoryStore(file, options);
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const [index, value] of [20, 22, 25].entries()) {
    await store.record('hub-a', { providers: LIMIT_PROVIDER_IDS.map(id => ({
      ...provider(at(2, 10, index * 5), value), provider: id,
      sourceDeviceId: index < 2 ? 'mac' : 'pc', sourceDetail: index < 2 ? 'MacBook' : 'Desktop'
    })) });
  }
  await store.close();
  store = createLimitsHistoryStore(file, options);
  for (const id of LIMIT_PROVIDER_IDS) {
    const row = { ...provider(at(2, 10, 10), 25), provider: id, sourceDeviceId: 'mac', sourceDetail: 'MacBook' };
    const a = await store.query('hub-a', row);
    const b = await store.query('hub-a', { ...row, sourceDeviceId: 'pc', sourceDetail: 'Desktop' });
    assert.deepEqual(a, b, id);
    assert.deepEqual(a.windows[0].points.map(p => p.value), [20, 22, 25], id);
    assert.equal(a.windows[0].distribution.buckets.at(-1).value, 5, id);
    assert.equal(a.windows[0].distribution.buckets.at(-1).observations, 3, id);
    const hourly = await store.query('hub-a', row, { grain: 'hour', day: '2026-11-02' });
    assert.equal(hourly.windows[0].distribution.buckets.find(b => new Date(b.at).getHours() === 10).value, 5, id);
    assert.equal((await store.query('hub-b', row)).windows[0].points.length, 0, id);
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM streams').get().n, LIMIT_PROVIDER_IDS.length);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history_origins').get().n, LIMIT_PROVIDER_IDS.length * 2);
  } finally { db.close(); }
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.includes(Buffer.from('MacBook')), false);
  assert.equal(bytes.includes(Buffer.from('private@example.com')), false);
});

test('identical multi-device samples deduplicate without splitting a multi-hour flat run', t => {
  const f = databaseFixture(t);
  const actions = [];
  for (let time = at(2, 8); time <= at(2, 11); time += 300_000) {
    actions.push(action(time, 20, { source: 'a' }), action(time, 20, { source: 'b' }));
  }
  f.record(actions);
  f.reopen();
  f.record([action(at(2, 11), 20, { source: 'b' }), action(at(2, 11), 20, { source: 'a' })]);
  assert.equal(f.sql('SELECT COUNT(*) AS n FROM runs')[0].n, 1);
  assert.equal(f.sql('SELECT SUM(samples) AS n FROM coverage')[0].n, 37);
  assert.equal(f.sql('SELECT COUNT(*) AS n FROM history_run_sources')[0].n, 2);
  const daily = f.query().windows[0];
  assert.equal(daily.distribution.buckets.at(-1).observations, 37);
  assert.equal(daily.distribution.buckets.at(-1).value, 0);
  assert.equal(daily.distribution.buckets.at(-1).uncertain, false);
  assert.equal(segments(daily.points).length, 1);
});

test('delayed device readings and per-origin cached replays never rewrite a newer timeline', t => {
  const f = databaseFixture(t);
  f.record([action(at(2, 10), 20, { source: 'a' }), action(at(2, 10, 5), 22, { source: 'a' }),
    action(at(2, 10, 10), 25, { source: 'b' })]);
  f.reopen();
  f.record([action(at(2, 10, 5), 90, { source: 'a' }), action(at(2, 10, 8), 95, { source: 'c' }),
    action(at(2, 10, 10), 99, { source: 'b' }), action(at(2, 10, 15), 26, { source: 'b' })]);
  const result = f.query().windows[0];
  assert.deepEqual(result.points.map(p => p.value), [20, 22, 25, 26]);
  assert.equal(result.distribution.buckets.at(-1).value, 6);
  assert.equal(result.distribution.buckets.at(-1).observations, 4);
  assert.equal(result.distribution.resets, 0);
  assert.equal(result.distribution.buckets.at(-1).uncertain, false);
});

for (const conflicting of [{ value: 0, reset: null }, { value: 22, reset: at(9, 0) }]) {
  test(`same-time device disagreement ${JSON.stringify(conflicting)} is immediately uncertain without an extra measurement`, t => {
    const f = databaseFixture(t);
    f.record([action(at(2, 10), 20, { source: 'a' }), action(at(2, 10, 5), 22, { source: 'a' }),
      action(at(2, 10, 5), conflicting.value, { source: 'b', reset: conflicting.reset })]);
    f.reopen();
    for (const grain of ['day', 'hour']) {
      const data = f.query({ grain, day: dayKey(f.clock) }).windows[0].distribution;
      const bucket = grain === 'day' ? data.buckets.at(-1) : data.buckets.find(b => new Date(b.at).getHours() === 10);
      assert.equal(bucket.value, 2);
      assert.equal(bucket.observations, 2);
      assert.equal(bucket.uncertain, true);
      assert.equal(data.resets, 0);
    }
    assert.equal(f.sql('SELECT COUNT(*) AS n FROM runs')[0].n, 2);
    assert.equal(f.sql('SELECT guarded FROM streams')[0].guarded, 1);
  });
}

test('contradictory devices cannot fabricate resets or jumps during a healthy source or after guarded handoff', t => {
  const f = databaseFixture(t);
  f.record([action(at(2, 10), 78, { source: 'a' }), action(at(2, 10, 5), 80, { source: 'a' }),
    action(at(2, 10, 10), 0, { source: 'b' })]);
  assert.deepEqual(f.query().windows[0].points.map(p => p.value), [78, 80]);
  f.reopen();
  f.record([action(at(2, 10, 15), 81, { source: 'a' }),
    action(at(2, 10, 20), 3, { source: 'b' }), // Still prefer healthy A.
    action(at(2, 10, 35), 4, { source: 'b' }), // A expired; uncertain baseline.
    action(at(2, 10, 40), 7, { source: 'b' }),
    action(at(2, 10, 45), 85, { source: 'a' }), // Old observer cannot add 78 pp.
    { account: accountA, source: 'a', failed: true },
    action(at(2, 10, 45), 8, { source: 'b' })]);
  const daily = f.query().windows[0];
  const hourly = f.query({ grain: 'hour', day: dayKey(f.clock) }).windows[0];
  assert.deepEqual(daily.points.map(p => p.value), [78, 80, 81, 4, 7, 8]);
  assert.equal(daily.distribution.buckets.at(-1).value, 6);
  assert.equal(daily.distribution.buckets.at(-1).uncertain, true);
  assert.equal(daily.distribution.unallocated, 1);
  assert.equal(daily.distribution.resets, 0);
  assert.equal(daily.distribution.buckets.at(-1).observations, 6);
  assert.equal(hourly.distribution.buckets.find(b => new Date(b.at).getHours() === 10).value, 6);
  assert.equal(hourly.distribution.unallocated, 1);
  assert.equal(hourly.distribution.resets, 0);
  assert.deepEqual(segments(daily.points).map(s => s.map(p => p.value)), [[78, 80], [81], [4, 7, 8]]);
  const before = hourly.distribution;
  f.reopen();
  assert.deepEqual(f.query({ grain: 'hour', day: dayKey(f.clock) }).windows[0].distribution, before);
});

test('a compatible takeover after device disagreement keeps its conflict boundary', t => {
  const f = databaseFixture(t);
  f.record([action(at(2, 10), 78, { source: 'a' }), action(at(2, 10, 5), 80, { source: 'a' }),
    action(at(2, 10, 10), 0, { source: 'b' }), action(at(2, 10, 15), 81, { source: 'a' })]);
  f.reopen();
  f.record([action(at(2, 10, 35), 85, { source: 'b' }), action(at(2, 10, 40), 86, { source: 'b' })]);
  f.reopen();
  for (const grain of ['day', 'hour']) {
    const entry = f.query({ grain, day: dayKey(f.clock) }).windows[0];
    const bucket = entry.distribution.buckets.find(b => grain === 'day' ? b.key === dayKey(f.clock) : new Date(b.at).getHours() === 10);
    assert.equal(bucket.value, 3, 'a guarded takeover is not measured consumption');
    assert.equal(entry.distribution.unallocated, 5);
    assert.equal(entry.distribution.resets, 0);
    assert.deepEqual(segments(entry.points).map(s => s.map(p => p.value)), [[78, 80], [81], [85, 86]]);
  }
});

test('inactive device failures do not interrupt an active observer; active failures permit uncertain takeover', t => {
  const f = databaseFixture(t);
  f.record([action(at(2, 10), 20, { source: 'a' }), { account: accountA, source: 'b', failed: true },
    action(at(2, 10, 5), 22, { source: 'a' })]);
  assert.equal(f.query().windows[0].distribution.buckets.at(-1).uncertain, false);
  assert.equal(segments(f.query().windows[0].points).length, 1);
  f.record([{ account: accountA, source: 'a', failed: true }]);
  f.reopen();
  f.record([action(at(2, 10, 10), 25, { source: 'b' }), action(at(2, 10, 15), 26, { source: 'b' }),
    action(at(2, 10, 20), 90, { source: 'a' }), action(at(2, 10, 20), 27, { source: 'b' })]);
  for (const grain of ['day', 'hour']) {
    const data = f.query({ grain, day: dayKey(f.clock) }).windows[0].distribution;
    const bucket = grain === 'day' ? data.buckets.at(-1) : data.buckets.find(b => new Date(b.at).getHours() === 10);
    assert.equal(bucket.value, 7);
    assert.equal(bucket.uncertain, true);
    assert.equal(data.unallocated, 0);
    assert.equal(data.resets, 0);
  }
  assert.deepEqual(f.query().windows[0].points.map(p => p.value), [20, 22, 25, 26, 27]);
});

test('source disagreement and handoff remain independent for different quota windows', t => {
  const f = databaseFixture(t);
  for (const [minute, a, b] of [[0, 20, 70], [5, 22, 72]]) {
    f.record([action(at(2, 10, minute), a, { source: 'a' }), action(at(2, 10, minute), b, { source: 'a', id: streamB })]);
  }
  f.record([action(at(2, 10, 10), 25, { source: 'b' }), action(at(2, 10, 10), 0, { source: 'b', id: streamB })]);
  assert.equal(f.query().windows[0].distribution.buckets.at(-1).value, 5);
  assert.equal(f.query().windows[0].distribution.buckets.at(-1).uncertain, false);
  const other = f.query(undefined, streamB).windows[0].distribution;
  assert.equal(other.buckets.at(-1).value, 2);
  assert.equal(other.buckets.at(-1).uncertain, true);
  assert.equal(other.resets, 0);
});

test('cross-device balance observations count decreases once and never count a foreign refill as consumption', t => {
  const f = databaseFixture(t);
  const credit = (minute, value, source) => {
    const next = action(at(2, 10, minute), value, { source });
    Object.assign(next.windows[0].point, { balance: true, unit: 'USD' });
    return next;
  };
  f.record([credit(0, 100, 'a'), credit(5, 98, 'a'), credit(10, 95, 'b'), credit(15, 100, 'a'), credit(20, 94, 'b')]);
  const result = f.query().windows[0].distribution;
  assert.equal(result.buckets.at(-1).value, 5);
  assert.equal(result.unallocated, 1);
  assert.equal(result.resets, 0);
  assert.equal(result.buckets.at(-1).uncertain, true);
});

test('handoff across midnight leaves the intervening change unallocated and preserves daily/hourly parity', t => {
  const f = databaseFixture(t);
  f.record([action(at(1, 23, 50), 20, { source: 'a' }), action(at(1, 23, 55), 22, { source: 'a' }),
    action(at(2, 0, 30), 30, { source: 'b' }), action(at(2, 0, 35), 31, { source: 'b' }),
    action(at(2, 0, 40), 80, { source: 'a' }), action(at(2, 0, 40), 32, { source: 'b' })]);
  f.reopen();
  const daily = f.query().windows[0].distribution;
  assert.equal(daily.buckets.at(-2).value, 2);
  assert.equal(daily.buckets.at(-1).value, 2);
  assert.equal(daily.buckets.at(-1).uncertain, true);
  assert.equal(daily.unallocated, 8);
  assert.equal(daily.resets, 0);
  const hourly = f.query({ grain: 'hour', day: dayKey(f.clock) }).windows[0].distribution;
  assert.equal(hourly.buckets[0].value, 2);
  assert.equal(hourly.buckets[0].uncertain, true);
  assert.equal(hourly.unallocated, 8);
  assert.equal(hourly.resets, 0);
});

test('a device conflict at the end of a flat run does not mark earlier observed hours uncertain', t => {
  const f = databaseFixture(t);
  const actions = [];
  for (let time = at(1, 12); time <= at(2, 10, 5); time += 300_000) actions.push(action(time, 20, { source: 'a' }));
  actions.push(action(at(2, 10, 10), 0, { source: 'b' }));
  f.record(actions);
  f.reopen();
  const oldHours = f.query({ grain: 'hour', day: dayKey(at(1, 12)) }).windows[0].distribution;
  assert.ok(oldHours.buckets.every(b => !b.uncertain));
  assert.equal(oldHours.buckets.at(-1).value, 0);
  const currentHours = f.query({ grain: 'hour', day: dayKey(f.clock) }).windows[0].distribution;
  assert.equal(currentHours.buckets.find(b => new Date(b.at).getHours() === 10).uncertain, true);
});

test('retention trims a long compressed handoff run without moving its uncertain boundary into recent hours', t => {
  const f = databaseFixture(t);
  const start = at(2, 0);
  f.record([action(start, 80, { source: 'a' }), action(start + 3 * 3600_000, 0, { source: 'b', interval: 3600_000 })]);
  assert.equal(f.sql('SELECT uncertain_before FROM runs ORDER BY until DESC LIMIT 1')[0].uncertain_before, 1);
  f.reopen();
  f.clock = start + 185 * 86400_000;
  const actions = [];
  for (let time = start + 4 * 3600_000; time <= f.clock; time += 3600_000) {
    actions.push(action(time, 0, { source: 'b', interval: 3600_000 }));
  }
  f.record(actions);
  assert.equal(f.sql('SELECT COUNT(*) AS n FROM runs')[0].n, 1);
  assert.equal(f.sql('SELECT uncertain_before FROM runs')[0].uncertain_before, 0);
  assert.equal(f.sql('SELECT COUNT(*) AS n FROM history_run_sources WHERE source = ?', 'a')[0].n, 0);
  const hourly = f.query({ grain: 'hour', day: dayKey(f.clock - 86400_000) }).windows[0].distribution;
  assert.ok(hourly.buckets.every(b => b.uncertain === false));
  assert.equal(hourly.resets, 0);
  const archived = f.query({ grain: 'day', day: dayKey(start) }).windows[0].distribution;
  assert.equal(archived.buckets.at(-1).uncertain, true);
  assert.equal(archived.resets, 0);
  f.clock = start + 731 * 86400_000;
  f.query();
  assert.deepEqual(f.sql('SELECT source FROM history_origins'), [{ source: 'b' }]);
  f.clock = start + (185 + 730) * 86400_000;
  f.query();
  assert.equal(f.sql('SELECT COUNT(*) AS n FROM history_origins')[0].n, 0);
});

test('a failed refresh interrupts accounting but reconnects a compatible flat trend after restarting SQLite', t => {
  const fixture = databaseFixture(t);
  const actions = [];
  for (let time = at(2, 8); time <= at(2, 10, 5); time += 300_000) actions.push(action(time));
  fixture.record([...actions, { account: accountA, failed: true }]);
  fixture.reopen();
  fixture.record([action(at(2, 10, 10)), action(at(2, 10, 15))]);
  assert.equal(fixture.sql('SELECT id FROM runs').length, 2);
  assert.equal(segments(fixture.query().windows[0].points).length, 1);
  assert.equal(fixture.query().windows[0].distribution.buckets.at(-1).uncertain, true);
});

test('180-day cleanup retains daily observations for two years without fabricating old hourly detail', t => {
  const fixture = databaseFixture(t);
  const oldDay = fixture.clock - 185 * 86400_000;
  fixture.record([action(oldDay, 20), action(oldDay + 300_000, 22),
    action(oldDay + 600_000, 0, { reset: oldDay + 86400_000 }),
    action(fixture.clock, 10)]);
  assert.equal(fixture.sql('SELECT COUNT(*) AS count FROM coverage')[0].count, 1);
  const range = { grain: 'day', day: dayKey(oldDay) };
  const archived = fixture.query(range).windows[0];
  const summary = archived.distribution.buckets.at(-1);
  assert.equal(summary.value, 2);
  assert.equal(summary.observations, 3);
  assert.equal(summary.uncertain, true);
  assert.equal(archived.distribution.resets, 1);
  assert.equal(archived.summaryOnly, true);
  assert.ok(fixture.query({ ...range, grain: 'hour' }).windows[0].distribution.buckets.every(b => b.value === null));
  fixture.reopen();
  assert.deepEqual(fixture.query(range).windows[0].distribution, archived.distribution);
});

test('late or future readings never overwrite newer data, and only cross-day changes stay unallocated', t => {
  const fixture = databaseFixture(t);
  fixture.record([action(at(1, 23, 55), 20), action(at(2, 0, 5), 25), action(at(2, 10), 30)]);
  fixture.record([action(at(2, 0), 90), action(fixture.clock + 120_000, 95)]);
  const result = fixture.query().windows[0].distribution;
  assert.equal(result.unallocated, 5);
  assert.equal(result.buckets.at(-1).value, 5);
  assert.equal(result.buckets.at(-1).observations, 2);
  assert.equal(result.buckets.at(-1).uncertain, true);
  assert.equal(fixture.sql('SELECT MAX(until) AS last FROM runs')[0].last, at(2, 10));
});

test('retention trims inside a long unchanged run and expires summaries only after 730 local days', t => {
  const fixture = databaseFixture(t);
  const start = fixture.clock;
  const actions = [];
  for (let time = start; time <= start + 185 * 86400_000; time += 300_000) actions.push(action(time));
  fixture.clock = start + 185 * 86400_000;
  fixture.record(actions);
  const runs = fixture.sql('SELECT at, until FROM runs');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].at, retentionStart(fixture.clock, 180));
  assert.equal(runs[0].until, fixture.clock);
  const before = fixture.query({ grain: 'day', day: dayKey(start) }).windows[0].distribution;
  assert.equal(before.buckets.at(-1).value, 0);
  fixture.clock = start + 730 * 86400_000;
  fixture.query(); // Maintenance also runs when the app receives no new quota reads.
  assert.equal(fixture.sql('SELECT day FROM daily WHERE day = ?', dayKey(start)).length, 0);
  assert.ok(fixture.sql('SELECT day FROM daily').every(row => row.day >= dayKey(retentionStart(fixture.clock, 730))));
});

test('more than 100,000 detail records coexist without one account evicting another', t => {
  const fixture = databaseFixture(t);
  const start = fixture.clock - 50_001 * 60_000;
  const actions = [];
  for (let index = 0; index < 50_002; index++) {
    const time = start + index * 60_000;
    for (const [id, account] of [[streamA, accountA], [streamB, accountB]]) {
      actions.push(action(time, index % 90, { id, account, interval: 60_000 }));
    }
  }
  fixture.record(actions);
  assert.equal(fixture.sql('SELECT COUNT(*) AS count FROM coverage')[0].count, 100_004);
  assert.equal(fixture.sql('SELECT COUNT(*) AS count FROM streams')[0].count, 2);
  assert.deepEqual(fixture.sql('SELECT MIN(at) AS first FROM runs GROUP BY stream').map(row => row.first), [start, start]);
});

test('SQLite compaction preserves both occurrences of a daylight-saving hour', t => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const fixture = databaseFixture(t, Date.parse('2026-11-02T05:00:00Z'));
    const actions = [];
    for (let time = Date.parse('2026-11-01T05:00:00Z'); time < Date.parse('2026-11-01T07:00:00Z'); time += 300_000) actions.push(action(time));
    fixture.record(actions);
    assert.equal(fixture.sql('SELECT id FROM runs').length, 1);
    assert.equal(fixture.sql('SELECT hour FROM coverage').length, 2);
    const buckets = fixture.query({ grain: 'hour', day: '2026-11-01' }).windows[0].distribution.buckets;
    assert.equal(buckets.length, 25);
    const repeated = buckets.filter(bucket => new Date(bucket.at).getHours() === 1);
    assert.deepEqual(repeated.map(b => [b.value, b.observations, b.uncertain]), [[0, 12, false], [0, 12, false]]);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('a failed SQLite transaction rolls back daily and detailed changes together and retries', t => {
  const fixture = databaseFixture(t);
  fixture.record([action(at(2, 10))]);
  const connection = new DatabaseSync(fixture.file);
  connection.exec("CREATE TRIGGER fail_coverage BEFORE INSERT ON coverage BEGIN SELECT RAISE(ABORT, 'disk failure fixture'); END");
  assert.throws(() => fixture.record([action(at(2, 10, 5), 21)]), /disk failure fixture/);
  assert.equal(fixture.query().persistent, false);
  assert.equal(fixture.sql('SELECT observations FROM daily')[0].observations, 1);
  assert.equal(fixture.sql('SELECT id FROM runs').length, 1);
  connection.exec('DROP TRIGGER fail_coverage');
  connection.close();
  fixture.record([action(at(2, 10, 5), 21)]);
  assert.equal(fixture.query().persistent, true);
  assert.equal(fixture.sql('SELECT observations FROM daily')[0].observations, 2);
});

test('worker SQLite persists private hashed identities, deduplicates cached reads, and separates scope and currency', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-worker-'));
  const file = path.join(directory, 'history.sqlite');
  const errors = [];
  const store = createLimitsHistoryStore(file, { now: () => at(2, 12), onError: error => errors.push(error) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const row = provider(at(2, 10));
  await store.record('local', { providers: [row] });
  await store.record('local', { providers: [row] });
  await store.record('local', { providers: [{ ...provider(at(2, 10, 5)), stale: true }] });
  await store.record('local', { providers: [provider(at(2, 10, 10))] });
  const data = await store.query('local', row);
  assert.equal(data.persistent, true);
  assert.equal(segments(data.windows[0].points).length, 1);
  assert.equal(data.windows[0].distribution.buckets.at(-1).observations, 2);
  assert.equal((await store.query('other', row)).windows[0].points.length, 0);
  assert.equal((await store.query('local', { ...row, accountKey: 'other' })).windows[0].points.length, 0);
  const credit = { ...row, windows: [{ kind: 'billing', metric: 'credits', remaining: 80, currency: 'USD' }] };
  await store.record('local', { providers: [credit] });
  assert.equal((await store.query('local', { ...credit, windows: [{ ...credit.windows[0], currency: 'CNY' }] })).windows[0].points.length, 0);
  await store.flush();
  await store.close();
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\u0000');
  assert.equal(bytes.includes(Buffer.from('private@example.com')), false);
  assert.equal(bytes.includes(Buffer.from('account-a')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reopened = createLimitsHistoryStore(file, { now: () => at(2, 12) });
  try { assert.deepEqual(await reopened.query('local', row), data); }
  finally { await reopened.close(); }
  assert.deepEqual(errors, []);
});

test('unreadable database is preserved and the worker reports a persistence error with session-only observations', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-corrupt-'));
  const file = path.join(directory, 'history.sqlite');
  fs.writeFileSync(file, 'not a database');
  const errors = [];
  const store = createLimitsHistoryStore(file, { now: () => at(2, 12), onError: error => errors.push(error) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const row = provider(at(2, 10));
  await store.record('local', { providers: [row] });
  const result = await store.query('local', row);
  assert.equal(result.persistent, false);
  assert.equal(result.windows[0].points.length, 1);
  assert.ok(errors.length > 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a database');
});

test('shutdown drains queued worker writes without taking over the native quit flow', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-shutdown-'));
  const file = path.join(directory, 'history.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createLimitsHistoryStore(file, { now: () => at(2, 12) });
  const recording = store.record('local', { providers: [provider(at(2, 10))] });
  store.closeSync();
  await recording;
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(db.prepare('SELECT SUM(samples) AS samples FROM coverage').get().samples, 1); }
  finally { db.close(); }
});

test('hourly deltas do not smear changes across hour boundaries', () => {
  const points = [point(at(2, 9, 50), 10), point(at(2, 9, 55), 12), point(at(2, 10), 15), point(at(2, 10, 5), 16), point(at(2, 11, 5), 21)];
  const hourly = distribution(points, { grain: 'hour', day: '2026-11-02', now: at(2, 12) });
  const hour9 = hourly.buckets.find(b => new Date(b.at).getHours() === 9);
  const hour10 = hourly.buckets.find(b => new Date(b.at).getHours() === 10);
  const hour8 = hourly.buckets.find(b => new Date(b.at).getHours() === 8);
  assert.equal(hour9.value, 2);
  assert.equal(hour10.value, 1);
  assert.equal(hour10.uncertain, true);
  assert.equal(hour8.value, null);
  assert.equal(hourly.unallocated, 8);
  const daily = distribution(points, { now: at(2, 12) });
  assert.equal(daily.buckets.at(-1).value, 11);
  assert.equal(daily.unallocated, 0);
});

test('resets, refills, and changing rolling deadlines break curves and consumption intervals', () => {
  const points = [point(at(2, 10), 80, at(2, 10, 5)), point(at(2, 10, 5), 0, at(3, 10, 5)), point(at(2, 10, 10), 3, at(3, 10, 5)), point(at(2, 10, 15), 1, at(3, 10, 5))];
  const result = distribution(points, { now: at(2, 12) });
  assert.equal(result.buckets.at(-1).value, 3);
  assert.equal(result.resets, 2);
  assert.equal(segments(points).length, 3);
  const rolling = [point(at(2, 10), 10, at(2, 15)), point(at(2, 10, 5), 12, at(2, 15, 5))];
  assert.equal(distribution(rolling, { now: at(2, 12) }).buckets.at(-1).value, null);
});

test('observed zero consumption differs from missing observations and future hours are omitted', () => {
  const result = distribution([point(at(2, 9), 10), point(at(2, 9, 5), 10)], { grain: 'hour', day: '2026-11-02', now: at(2, 10, 15) });
  assert.equal(result.buckets.find(b => new Date(b.at).getHours() === 9).value, 0);
  assert.equal(result.buckets.find(b => new Date(b.at).getHours() === 8).value, null);
  assert.equal(new Date(result.buckets.at(-1).at).getHours(), 10);
});

test('hourly history keeps both occurrences of a repeated daylight-saving hour', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const points = [
      point(Date.parse('2026-11-01T05:05:00Z'), 10), point(Date.parse('2026-11-01T05:10:00Z'), 11),
      point(Date.parse('2026-11-01T06:05:00Z'), 12), point(Date.parse('2026-11-01T06:10:00Z'), 13)
    ];
    const result = distribution(points, { grain: 'hour', day: '2026-11-01', now: Date.parse('2026-11-02T05:00:00Z') });
    const repeated = result.buckets.filter(b => new Date(b.at).getHours() === 1);
    assert.equal(result.buckets.length, 25);
    assert.equal(repeated.length, 2);
    assert.notEqual(repeated[0].key, repeated[1].key);
    assert.deepEqual(repeated.map(b => b.value), [1, 1]);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('the side window flips left and clamps onto the selected display', () => {
  const work = { x: -1600, y: 0, width: 1600, height: 900 };
  const owner = { x: -350, y: 700, width: 300, height: 180 };
  const bounds = historyBounds(owner, { y: 50 }, work);
  assert.equal(bounds.x, -668);
  assert.ok(bounds.y + bounds.height <= 892);
  const small = historyBounds({ x: 0, y: 0, width: 300, height: 200 }, { y: 0 }, { x: 0, y: 0, width: 340, height: 500 }, 1.5);
  assert.equal(small.width, 324);
  assert.equal(small.height, 484);
});

test('read-only history rejects date navigation, discards stale reads and closes on source changes', async () => {
  const owner = new EventEmitter();
  owner.webContents = { getZoomFactor: () => 1, send() {} };
  owner.getBounds = () => ({ x: 100, y: 100, width: 300, height: 700 });
  owner.isVisible = () => true;
  owner.isDestroyed = () => false;
  owner.isFocused = () => false;
  let ownerFocused = false;
  owner.focus = () => { ownerFocused = true; };
  const handlers = new Map();
  let window;
  let renderToken;
  class FakeWindow extends EventEmitter {
    constructor() { super(); window = this; this.destroyed = false; this.visible = false; this.webContents = new EventEmitter(); this.webContents.focus = () => {}; this.webContents.isDestroyed = () => false; this.webContents.setWindowOpenHandler = () => {}; this.webContents.setZoomFactor = () => {}; this.webContents.getZoomFactor = () => 1; this.webContents.send = (channel, payload) => { if (channel === 'limitsHistory:render') { renderToken = payload.renderToken; handlers.get('limitsHistory:resize')({ sender: this.webContents }, 420, renderToken, false, false); } }; }
    static fromWebContents(sender) { return sender === owner.webContents ? owner : null; }
    isMinimized() { return false; }
    setVibrancy() {}
    isDestroyed() { return this.destroyed; }
    loadFile() { return Promise.resolve(); }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
    isVisible() { return this.visible; }
    isFocused() { return false; }
    hide() { this.visible = false; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  let source = 'a';
  let timer = null;
  let pendingRead;
  const reads = [];
  const controller = createLimitsHistoryController({ BrowserWindow: FakeWindow, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }), getCursorScreenPoint: () => ({ x: 1500, y: 800 }) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    setTimer: fn => { timer = fn; return 1; }, clearTimer: () => { timer = null; },
    isOwner: win => win === owner, read: (_key, range) => { reads.push(range); return pendingRead || { source }; } });
  controller.register();
  const open = handlers.get('limitsHistory:open');
  const request = { key: 'account', rect: { x: 0, y: 50, width: 300, height: 100 } };
  assert.equal(await open({ sender: {} }, request), false);
  assert.equal(await open({ sender: owner.webContents }, request), true);
  window.webContents.emit('did-finish-load');
  assert.equal(window.visible, true);
  assert.equal(controller.containsPoint({ x: 420, y: 150 }), true);
  handlers.get('limitsHistory:resize')({ sender: window.webContents }, 1000, renderToken, false, false);
  assert.equal(window.bounds.height, 884);
  owner.emit('blur');
  assert.equal(window.visible, false, 'real owner blur dismisses the non-activating preview');
  await open({ sender: owner.webContents }, request);
  handlers.get('limitsHistory:close')({ sender: window.webContents });
  assert.equal(ownerFocused, false, 'closing a read-only preview never forces focus');
  await open({ sender: owner.webContents }, request);
  ownerFocused = false;
  handlers.get('limitsHistory:leave')({ sender: window.webContents });
  timer();
  assert.equal(ownerFocused, false, 'an untouched hover preview does not steal or restore focus');
  assert.equal(window.visible, false);
  await open({ sender: owner.webContents }, request);
  assert.equal(handlers.has('limitsHistory:range'), false, 'preview IPC cannot request historical dates');
  assert.equal(reads.at(-1), undefined);
  let resolveRead;
  pendingRead = new Promise(resolve => { resolveRead = resolve; });
  const staleRefresh = controller.refresh();
  pendingRead = null;
  await controller.refresh();
  resolveRead({ source: 'obsolete-source' });
  await staleRefresh;
  assert.equal(window.visible, true, 'an obsolete read cannot hide the current account');
  controller.hide();
  pendingRead = new Promise(resolve => { resolveRead = resolve; });
  const opening = open({ sender: owner.webContents }, request);
  handlers.get('limitsHistory:leave')({ sender: owner.webContents }, request.key);
  resolveRead({ source });
  assert.equal(await opening, false, 'leaving the row cancels an in-flight hover preview');
  assert.equal(window.visible, false);
  pendingRead = null;
  await open({ sender: owner.webContents }, request);
  source = 'b';
  await controller.refresh();
  assert.equal(window.visible, false);
  assert.equal(owner.listenerCount('hide'), 0);
  controller.dispose();
});

function previewFixture(t) {
  const f = { pointer: { x: 1500, y: 800 }, focused: false, ownerFocused: false, mode: 'hover', timer: null, reads: [] };
  const owner = new EventEmitter();
  owner.webContents = { getZoomFactor: () => 1, send() {} };
  owner.getBounds = () => ({ x: 100, y: 100, width: 300, height: 700 });
  owner.isVisible = () => true;
  owner.isDestroyed = () => false;
  owner.isFocused = () => f.ownerFocused;
  owner.focus = () => { f.ownerFocused = true; };
  class Preview extends EventEmitter {
    constructor(options) {
      super(); f.window = this; f.options = options; this.visible = options.show;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { focus: () => { throw new Error('preview must not take keyboard focus'); }, isDestroyed: () => false,
        setWindowOpenHandler() {}, setZoomFactor() {}, getZoomFactor: () => 1, send(channel, payload) {
          if (channel !== 'limitsHistory:render') return;
          f.lastPayload = payload;
          if (f.autoMeasure !== false) handlers.get('limitsHistory:resize')({ sender: f.window.webContents }, f.contentHeight || 420, payload.renderToken, false, false);
        } });
    }
    static fromWebContents(sender) { return sender === owner.webContents ? owner : null; }
    isMinimized() { return false; }
    setVibrancy() {}
    isDestroyed() { return false; }
    loadFile() { return Promise.resolve(); }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
    isVisible() { return this.visible; }
    isFocused() { return f.focused; }
    hide() { this.visible = false; f.focused = false; }
    show() { throw new Error('preview must use showInactive'); }
    showInactive() { this.visible = true; }
    destroy() { this.emit('closed'); }
  }
  const handlers = new Map();
  f.controller = createLimitsHistoryController({ BrowserWindow: Preview,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }), getCursorScreenPoint: () => f.pointer },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    getOpenMode: () => f.mode, now: () => f.clock || 0, setFrameTimer: fn => { f.frame = fn; return 1; }, clearFrameTimer: () => { f.frame = null; }, setTimer: fn => { f.timer = fn; return 1; }, clearTimer: () => { f.timer = null; },
    isOwner: win => win === owner, read: (key, range) => { f.reads.push({ key, range }); return f.pending || { source: 'a' }; } });
  f.controller.register();
  f.handlers = handlers;
  f.owner = owner;
  f.open = async (key = 'a', interactive = false, rect = { x: 0, y: 50, width: 300, height: 100 }) => {
    const result = await handlers.get('limitsHistory:open')({ sender: owner.webContents }, { key, interactive, rect });
    if (f.window && !f.loaded) { f.loaded = true; f.window.webContents.emit('did-finish-load'); }
    return result;
  };
  f.fromOwner = (event, key = 'a') => handlers.get(`limitsHistory:${event}`)({ sender: owner.webContents }, key);
  f.fromPanel = (event, value) => handlers.get(`limitsHistory:${event}`)({ sender: f.window.webContents }, value, f.lastPayload?.renderToken, false, false);
  f.fire = () => { const callback = f.timer; f.timer = null; assert.ok(callback); callback(); };
  t.after(() => f.controller.dispose());
  return f;
}

test('read-only previews never request focus, even for explicit opens and close', async t => {
  const f = previewFixture(t);
  await f.open('a', true);
  assert.equal(f.options.focusable, false);
  assert.equal(f.focused, false);
  f.fromOwner('leave');
  assert.equal(f.timer, null, 'explicit visibility is independent of keyboard focus');
  f.fromPanel('close');
  assert.equal(f.ownerFocused, false);
  assert.equal(f.window.visible, false);
});

test('late leave messages cannot close a read-only preview while the pointer is inside', async t => {
  const f = previewFixture(t);
  await f.open();
  f.fromPanel('enter');
  f.fromOwner('leave');
  f.pointer = { x: 420, y: 180 };
  f.fire();
  assert.equal(f.window.visible, true);
  f.fromPanel('leave');
  f.pointer = { x: 1500, y: 800 };
  f.fire();
  assert.equal(f.window.visible, false);
});

test('crossing the gap and returning to the source preserve the read-only preview without historical range IPC', async t => {
  const f = previewFixture(t);
  await f.open();
  assert.equal(f.handlers.has('limitsHistory:range'), false);
  f.fromOwner('leave');
  f.pointer = { x: 404, y: 200 };
  f.fire();
  assert.equal(f.window.visible, true);
  assert.ok(f.timer, 'the gap is checked again if the pointer stops there');
  f.pointer = { x: 200, y: 180 };
  f.fire();
  assert.equal(f.window.visible, true);
  const reads = f.reads.length;
  await f.open();
  assert.equal(f.reads.length, reads, 'returning to this account does not reset its selected quota');
  await f.controller.refresh();
  assert.equal(f.reads.at(-1).range, undefined);
  f.fromOwner('leave', 'other-account');
  assert.equal(f.timer, null, 'a different row cannot close this preview');
});

test('an explicit preview blocks automatic replacements without focus and closes when the owner loses focus', async t => {
  const f = previewFixture(t);
  await f.open('a', true);
  assert.equal(f.focused, false);
  assert.equal(await f.open('b'), false);
  assert.equal(f.reads.at(-1).key, 'a');
  f.pointer = { x: 420, y: 180 };
  f.owner.emit('blur');
  assert.equal(f.window.visible, false);
  assert.equal(f.ownerFocused, false);
});

test('leaving a pending replacement or entering the active preview cancels only that hover request', async t => {
  const f = previewFixture(t);
  await f.open();
  let resolve;
  f.pending = new Promise(done => { resolve = done; });
  let opening = f.open('b');
  f.fromOwner('leave', 'b');
  resolve({ source: 'a' });
  assert.equal(await opening, false);
  assert.equal(f.window.visible, true);
  f.pending = new Promise(done => { resolve = done; });
  opening = f.open('b');
  f.fromPanel('enter');
  resolve({ source: 'a' });
  assert.equal(await opening, false);
  assert.equal(f.window.visible, true);
});

test('click-only mode disables automatic opens, while explicit click, toggle and Escape remain available', async t => {
  const f = previewFixture(t);
  f.mode = 'click';
  assert.equal(await f.open(), false);
  assert.equal(f.reads.length, 0);
  assert.equal(await f.open('a', true), true);
  f.pointer = { x: 420, y: 180 };
  f.fromOwner('leave');
  assert.equal(f.timer, null, 'an activated preview is not dismissed on mouse leave');
  f.focused = false;
  f.pointer = { x: 1500, y: 800 };
  assert.equal(await f.open('a', true), true);
  assert.equal(f.window.visible, false, 'clicking the activated account again closes it');
  await f.open('b', true);
  f.fromPanel('close');
  assert.equal(f.window.visible, false);
});

test('switching to click-only mode also cancels an automatic open already waiting on history', async t => {
  const f = previewFixture(t);
  let resolve;
  f.pending = new Promise(done => { resolve = done; });
  const opening = f.open();
  f.mode = 'click';
  resolve({ source: 'a' });
  assert.equal(await opening, false);
  assert.equal(f.window.visible, false);
});

for (const exitCode of [0, 1]) test(`worker exit ${exitCode} during close distinguishes expected shutdown from failure`, async () => {
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const filename = path.resolve(__dirname, '../../src/electron/limits/historyStore.js');
  const localRequire = createRequire(filename);
  class ClosingWorker extends EventEmitter {
    ref() {}
    unref() {}
    postMessage({ id, method }) {
      queueMicrotask(() => {
        if (method === 'close') this.emit('exit', exitCode);
        queueMicrotask(() => this.emit('message', { id, result: true }));
      });
    }
  }
  const exported = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: exported, __dirname: path.dirname(filename),
    require: id => id === 'node:worker_threads' ? { Worker: ClosingWorker } : localRequire(id)
  }, { filename });
  const errors = [];
  const store = exported.exports.createLimitsHistoryStore(':memory:', { onError: error => errors.push(error.message) });
  await store.record('local', { providers: [provider(at(3, 11))] });
  if (exitCode === 0) {
    await store.close();
    assert.deepEqual(errors, []);
  } else {
    await assert.rejects(store.close(), /worker exited \(1\)/);
    assert.equal(errors.length, 1);
  }
});

function fundedProvider(time, remaining = 80, limit = 100, id = 'commandcode', currency = 'USD') {
  return normalizeLimitProvider({ ...provider(time), provider: id, windows: [{ kind: 'billing', label: 'Monthly', metric: 'credits',
    remaining, limit, used: limit === null ? null : Math.max(0, limit - remaining), currency, resetsAt: new Date(at(19, 0)).toISOString() }] });
}

test('every provider uses the same reliable percentage versus pure balance rules, including measured zero', () => {
  for (const id of LIMIT_PROVIDER_IDS) {
    const window = fundedProvider(at(2, 10), 58.3, 70, id).windows[0];
    const { primary, raw } = historyReadings(window);
    assert.equal(primary.unit, 'pp', id);
    assert.equal(primary.balance, false, id);
    assert.equal(primary.basis, '70', id);
    assert.ok(Math.abs(primary.value - (11.7 / 70 * 100)) < 1e-10, id);
    assert.equal(raw.value, 58.3, id);
    assert.equal(raw.unit, 'USD', id);
    assert.equal(raw.balance, true, id);
    const empty = historyReadings(fundedProvider(at(2, 10), 0, 70, id).windows[0]);
    assert.equal(empty.primary.value, 100, id);
    const full = historyReadings(fundedProvider(at(2, 10), 70, 70, id).windows[0]);
    assert.equal(full.primary.value, 0, id);
    const wallet = historyReadings({ ...window, limit: null, used: null, usedPercent: null, remainingPercent: null });
    assert.equal(wallet.primary.unit, 'USD', id);
    assert.equal(wallet.primary.value, 58.3, id);
    assert.equal(wallet.raw, null, id);
    assert.equal(historyReadings({ ...window, showMeter: false }).primary.unit, 'USD', id);
  }
  assert.equal(historyReadings({ metric: 'credits', remaining: 5, limit: 0 }).primary.unit, 'credits');
  assert.equal(historyReadings({ metric: 'credits', remaining: 0 }).primary.value, 0);
  assert.equal(historyReadings({ usedPercent: 0 }).primary.value, 0);
  assert.equal(historyReadings({ remainingPercent: 25 }).primary.value, 75);
  assert.equal(historyReadings({ metric: 'credits', remaining: NaN }).primary, null);
  assert.equal(historyReadings({ metric: 'credits', remaining: Infinity }).primary, null);
  assert.equal(historyReadings({}).primary, null);
  assert.equal(historyReadings({ metric: 'spend', used: 7, limit: 10, currency: 'CNY' }).primary.value, 70);
  assert.equal(historyReadings({ metric: 'spend', used: 7, limit: 10, currency: 'CNY' }).raw.balance, false);
  assert.equal(historyReadings({ metric: 'spend', used: 7, limit: 10, currency: 'CNY', showMeter: false }).primary.unit, 'CNY');
  assert.equal(historyReadings({ metric: 'credits', remaining: 5, usedPercent: 25 }).primary.value, 25);
});

test('all provider allowances preserve raw currency history beside percentage history without duplicate observations', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-percent-catalog-'));
  const file = path.join(directory, 'history.sqlite');
  const options = { now: () => at(2, 12) };
  let store = createLimitsHistoryStore(file, options);
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const [index, remaining] of [80, 75].entries()) {
    await store.record('local', { providers: LIMIT_PROVIDER_IDS.map(id => ({ ...fundedProvider(at(2, 10, index * 5), remaining, 100, id), sourceDeviceId: index ? 'b' : 'a' })) });
  }
  await store.close();
  store = createLimitsHistoryStore(file, options);
  for (const id of LIMIT_PROVIDER_IDS) {
    const row = fundedProvider(at(2, 10, 5), 75, 100, id);
    const result = await store.query('local', row);
    const entry = result.windows[0];
    assert.equal(result.windows.length, 1, id);
    assert.equal(entry.unit, 'pp', id);
    assert.equal(entry.balance, false, id);
    assert.deepEqual(entry.points.map(p => [p.value, p.basis]), [[20, '100'], [25, '100']], id);
    assert.equal(entry.distribution.buckets.at(-1).value, 5, id);
    assert.equal(entry.distribution.buckets.at(-1).observations, 2, id);
    const rawRow = { ...row, windows: [{ ...row.windows[0], showMeter: false }] };
    const raw = (await store.query('local', rawRow)).windows[0];
    assert.equal(raw.unit, 'USD', id);
    assert.deepEqual(raw.points.map(p => p.value), [80, 75], id);
    assert.equal(raw.distribution.buckets.at(-1).value, 5, id);
    assert.equal(raw.distribution.buckets.at(-1).observations, 2, id);
    const otherCurrency = { ...row, windows: [{ ...row.windows[0], currency: 'CNY' }] };
    assert.equal((await store.query('local', otherCurrency)).windows[0].points.length, 0, id);
  }
});

test('allowance upgrades, downgrades and missing denominators break percent intervals without inventing consumption or resets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-percent-basis-'));
  const file = path.join(directory, 'history.sqlite');
  let clock = at(2, 12);
  const options = { now: () => clock };
  let store = createLimitsHistoryStore(file, options);
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let row;
  const records = [[0, 80, 100], [5, 70, 100], [10, 70, 200], [15, 60, 200], [20, 60, 100], [25, 50, 100]];
  for (const [minute, remaining, limit] of records) {
    row = fundedProvider(at(2, 10, minute), remaining, limit);
    await store.record('local', { providers: [row] });
  }
  await store.close(); store = createLimitsHistoryStore(file, options);
  const entry = (await store.query('local', row)).windows[0];
  assert.deepEqual(segments(entry.points).map(s => s.map(p => p.value)), [[20, 30], [65, 70], [40, 50]]);
  assert.equal(entry.distribution.buckets.at(-1).value, 25);
  assert.equal(entry.distribution.buckets.at(-1).uncertain, true);
  assert.equal(entry.distribution.resets, 0);
  assert.equal(entry.distribution.unallocated, 0);
  const hourly = (await store.query('local', row, { grain: 'hour', day: dayKey(clock) })).windows[0].distribution;
  assert.equal(hourly.buckets.find(b => new Date(b.at).getHours() === 10).value, 25);
  assert.equal(hourly.resets, 0);
  const differentCurrentTotal = { ...row, windows: [{ ...row.windows[0], limit: 1000 }] };
  assert.deepEqual((await store.query('local', differentCurrentTotal)).windows[0].points, entry.points);
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT DISTINCT basis FROM run_basis ORDER BY basis').all().map(r => r.basis), ['100', '200']); }
  finally { db.close(); }
  clock += 185 * 86400_000;
  const archived = (await store.query('local', row, { grain: 'day', day: '2026-11-02' })).windows[0];
  assert.equal(archived.summaryOnly, true);
  assert.equal(archived.distribution.buckets.at(-1).value, 25);
  assert.equal(archived.distribution.resets, 0);
});

test('raw-only history is never retroactively divided by a newly discovered allowance', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-percent-unknown-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const [minute, remaining] of [[0, 80], [5, 75]]) {
    await store.record('local', { providers: [fundedProvider(at(2, 10, minute), remaining, null)] });
  }
  const known = fundedProvider(at(2, 10, 10), 70, 100);
  const before = (await store.query('local', known)).windows[0];
  assert.equal(before.unit, 'pp');
  assert.deepEqual(before.points, []);
  await store.record('local', { providers: [known] });
  const after = (await store.query('local', known)).windows[0];
  assert.deepEqual(after.points.map(p => p.value), [30]);
  assert.equal(after.distribution.buckets.at(-1).value, null);
  const raw = (await store.query('local', { ...known, windows: [{ ...known.windows[0], showMeter: false }] })).windows[0];
  assert.deepEqual(raw.points.map(p => p.value), [80, 75, 70]);
});

test('percentage allowances still recognize real refills and support provider-reported percentages without a total', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-percent-refill-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let row;
  for (const [minute, remaining] of [[0, 80], [5, 75], [10, 100], [15, 95]]) {
    row = fundedProvider(at(2, 10, minute), remaining, 100);
    await store.record('local', { providers: [row] });
  }
  const result = (await store.query('local', row)).windows[0];
  assert.equal(result.distribution.buckets.at(-1).value, 10);
  assert.equal(result.distribution.resets, 1);
  const reported = { ...row, accountKey: 'reported-percent', windows: [{ ...row.windows[0], limit: null, used: null, usedPercent: 15, remainingPercent: 85 }] };
  await store.record('local', { providers: [reported] });
  assert.equal((await store.query('local', reported)).windows[0].unit, 'pp');
});

test('unknown billing durations use an explicitly recent history range rather than a fabricated billing-cycle start', () => {
  const now = at(3, 12);
  const window = { kind: 'billing', label: 'Monthly', resetsAt: new Date(at(19, 0)).toISOString() };
  assert.deepEqual(trendBounds(window, now, 'commandcode'), { start: now - 14 * 86400_000, end: now, cycle: false });
  assert.deepEqual(trendBounds({ ...window, windowMinutes: 43200 }, now), { start: at(19, 0) - 43200 * 60_000, end: at(19, 0), cycle: true });
});

test('all canonical daily, weekly and known five-hour windows have cycle bounds without relying on optional minutes', () => {
  const { FIVE_HOUR_WINDOW_PROVIDERS } = require('../../src/shared/limits/windowLabels');
  const now = at(3, 12), end = at(6, 18), resetsAt = new Date(end).toISOString();
  for (const id of LIMIT_PROVIDER_IDS) {
    for (const [kind, minutes] of [['daily', 1440], ['weekly', 10080]]) {
      assert.deepEqual(trendBounds({ kind, resetsAt }, now, id), { start: end - minutes * 60_000, end, cycle: true }, `${id}: ${kind}`);
    }
    const expected = id === 'claude' || FIVE_HOUR_WINDOW_PROVIDERS.has(id);
    const session = trendBounds({ kind: 'session', resetsAt }, now, id);
    assert.equal(session.cycle, expected, id);
    assert.equal(session.start, expected ? end - 300 * 60_000 : now - 14 * 86400_000, id);
  }
});

test('cumulative monetary spend keeps money units and counts increases, not remaining-balance decreases', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-money-spend-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const id of LIMIT_PROVIDER_IDS) {
    let row;
    for (const [minute, used] of [[0, 5], [5, 7]]) {
      row = normalizeLimitProvider({ ...provider(at(2, 10, minute)), provider: id,
        windows: [{ kind: 'billing', metric: 'spend', label: 'Usage credits', used, currency: 'CNY' }] });
      await store.record('local', { providers: [row] });
    }
    const entry = (await store.query('local', row)).windows[0];
    assert.equal(entry.unit, 'CNY', id);
    assert.equal(entry.balance, false, id);
    assert.deepEqual(entry.points.map(p => p.value), [5, 7], id);
    assert.equal(entry.distribution.buckets.at(-1).value, 2, id);
    assert.equal(entry.distribution.resets, 0, id);
  }
});

test('inferred wallet display percentages never masquerade as a measured quota percentage', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-wallet-inferred-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const row = { ...fundedProvider(at(2, 10), 80, null, 'deepseek'), balance: { amount: 80, currency: 'USD', monthSpend: 20 } };
  const { creditsMeterPercent } = require('../../src/shared/limits/balanceDisplay');
  assert.equal(creditsMeterPercent(row, row.windows[0]), 80);
  await store.record('local', { providers: [row] });
  const entry = (await store.query('local', row)).windows[0];
  assert.equal(entry.unit, 'USD');
  assert.equal(entry.balance, true);
  assert.deepEqual(entry.points.map(p => p.value), [80]);
});

test('losing and recovering an allowance denominator cannot turn a reported percent jump into consumption', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-percent-availability-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let row;
  for (const [minute, remaining, limit, usedPercent] of [[0, 80, 100, 20], [5, 80, null, 50], [10, 75, null, 55], [15, 75, 100, 25], [20, 70, 100, 30]]) {
    row = fundedProvider(at(2, 10, minute), remaining, limit);
    Object.assign(row.windows[0], { usedPercent, remainingPercent: 100 - usedPercent });
    await store.record('local', { providers: [row] });
  }
  const entry = (await store.query('local', row)).windows[0];
  assert.deepEqual(segments(entry.points).map(s => s.map(p => p.value)), [[20], [50, 55], [25, 30]]);
  assert.equal(entry.distribution.buckets.at(-1).value, 10);
  assert.equal(entry.distribution.buckets.at(-1).uncertain, true);
  assert.equal(entry.distribution.resets, 0);
});

test('a raw-money write failure rolls back percentage history and both summaries before retry', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-percent-atomic-'));
  const file = path.join(directory, 'history.sqlite');
  const errors = [];
  const store = createLimitsHistoryStore(file, { now: () => at(2, 12), onError: e => errors.push(e.message) });
  let db;
  t.after(async () => { db?.close(); await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await store.record('local', { providers: [fundedProvider(at(2, 10))] });
  db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER fail_raw BEFORE INSERT ON coverage WHEN (SELECT unit FROM runs WHERE id = NEW.run) = 'USD' BEGIN SELECT RAISE(ABORT, 'raw write fixture'); END");
  const next = fundedProvider(at(2, 10, 5), 75);
  await store.record('local', { providers: [next] });
  assert.ok(errors.some(e => e.includes('raw write fixture')));
  assert.deepEqual(db.prepare('SELECT observations FROM daily ORDER BY stream').all().map(r => r.observations), [1, 1]);
  assert.deepEqual((await store.query('local', next)).windows[0].points.map(p => p.value), [20]);
  db.exec('DROP TRIGGER fail_raw');
  await store.record('local', { providers: [next] });
  assert.deepEqual(db.prepare('SELECT observations FROM daily ORDER BY stream').all().map(r => r.observations), [2, 2]);
  assert.equal((await store.query('local', next)).windows[0].distribution.buckets.at(-1).value, 5);
});

test('owner focus loss while a preview read is pending prevents a late non-activating window from appearing', async t => {
  const f = previewFixture(t);
  let resolve;
  f.pending = new Promise(done => { resolve = done; });
  const opening = f.open();
  f.owner.emit('blur');
  resolve({ source: 'a' });
  assert.equal(await opening, false);
  assert.equal(f.window.visible, false);
  assert.equal(f.owner.listenerCount('blur'), 0);
});

test('same-labelled currency pools retain distinct preview selection keys across percent and raw modes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-preview-currencies-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const row = fundedProvider(at(2, 10));
  row.windows.push({ ...row.windows[0], currency: 'CNY', remaining: 60, used: 40, usedPercent: 40, remainingPercent: 60 });
  await store.record('local', { providers: [row] });
  const result = await store.query('local', row);
  assert.notEqual(result.windows[0].key, result.windows[1].key);
  assert.deepEqual(result.windows.map(w => w.points[0].value), [20, 40]);
  const raw = await store.query('local', { ...row, windows: row.windows.map(w => ({ ...w, showMeter: false })) });
  assert.deepEqual(raw.windows.map(w => w.key), result.windows.map(w => w.key));
  assert.deepEqual(raw.windows.map(w => w.points[0].value), [80, 60]);
});

test('Command Code billing boundaries survive normalization and history queries before observation starts', async t => {
  const { fetchCommandcodeLimits } = require('../../src/shared/providers/commandcode/limits');
  const start = Date.parse('2026-10-19T08:00:00Z'), end = Date.parse('2026-11-19T08:00:00Z');
  const now = Date.parse('2026-11-03T08:00:00Z');
  const row = await fetchCommandcodeLimits({ commandcodeCookie: ['__Secure-commandcode_prod_.session_token', 'synthetic'].join('=') }, {
    env: {}, now: () => now,
    fetch: async url => ({ ok: true, status: 200, json: async () => url.endsWith('/credits')
      ? { credits: { monthlyCredits: 58.3, purchasedCredits: 0 } }
      : { success: true, data: { planId: 'individual-goat', userId: 'synthetic', currentPeriodStart: new Date(start).toISOString(), currentPeriodEnd: new Date(end).toISOString() } } })
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-monthly-cycle-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => now });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const before = (await store.query('test', row)).windows.find(entry => entry.window.label === 'Monthly');
  assert.deepEqual(trendBounds(before.window, now, row.provider), { start, end, cycle: true });
  assert.deepEqual(before.points, []);
  await store.record('test', { providers: [row] });
  const after = (await store.query('test', row)).windows.find(entry => entry.window.label === 'Monthly');
  assert.deepEqual(trendBounds(after.window, now, row.provider), { start, end, cycle: true });
  assert.deepEqual(after.points.map(point => point.at), [now]);
});

test('cold preview loads alongside its read and reuses that payload without a second query', async t => {
  const f = previewFixture(t);
  let resolve;
  f.pending = new Promise(done => { resolve = done; });
  const opening = f.open();
  assert.ok(f.window, 'renderer is being prepared while SQLite is still pending');
  assert.equal(f.window.visible, false);
  f.loaded = true;
  f.window.webContents.emit('did-finish-load');
  assert.equal(f.window.visible, false, 'an empty page never opens before the payload');
  resolve({ source: 'a' });
  assert.equal(await opening, true);
  assert.equal(f.window.visible, true);
  assert.equal(f.reads.length, 1);
});

test('cold preview keeps its successful read until the renderer is loaded', async t => {
  const f = previewFixture(t);
  const request = { key: 'a', rect: { x: 0, y: 50, width: 300, height: 100 } };
  await f.handlers.get('limitsHistory:open')({ sender: f.owner.webContents }, request);
  assert.equal(f.window.visible, false);
  f.window.webContents.emit('did-finish-load');
  assert.equal(f.window.visible, true);
  assert.equal(f.reads.length, 1, 'load completion must not repeat the initial query');
});

test('off mode blocks hover and explicit opens before loading history or creating a window', async t => {
  const f = previewFixture(t);
  f.mode = 'off';
  assert.equal(await f.open('a'), false);
  assert.equal(await f.open('a', true), false);
  assert.equal(f.reads.length, 0);
  assert.equal(f.window, undefined);
});

for (const interactive of [false, true]) test(`off mode cancels an in-flight ${interactive ? 'explicit' : 'hover'} open`, async t => {
  const f = previewFixture(t);
  let resolve;
  f.pending = new Promise(done => { resolve = done; });
  const opening = f.open('a', interactive);
  f.mode = 'off';
  resolve({ source: 'a' });
  assert.equal(await opening, false);
  assert.equal(f.window.visible, false);
});

test('turning previews off dismisses the current card without another history query', async t => {
  const f = previewFixture(t);
  await f.open('a', true);
  const reads = f.reads.length;
  f.mode = 'off';
  await f.controller.refresh();
  assert.equal(f.window.visible, false);
  assert.equal(f.reads.length, reads);
  f.mode = 'hover';
  assert.equal(await f.open(), true);
  assert.equal(f.window.visible, true);
});

test('preview render messages distinguish opening, account switches and background updates', async t => {
  const f = previewFixture(t);
  await f.open();
  const renders = [];
  f.window.webContents.send = (channel, payload) => { if (channel === 'limitsHistory:render') renders.push(payload); };
  await f.controller.refresh();
  assert.equal(renders.at(-1).opening, false);
  await f.open('b');
  assert.equal(renders.at(-1).opening, false, 'switching the visible card is a content transition');
  f.fromPanel('close');
  await f.open('b');
  assert.equal(renders.at(-1).opening, true, 'reopening the hidden window plays its entrance');
});

test('a preview waits for a current rendered size before its first native reveal', async t => {
  const f = previewFixture(t);
  f.autoMeasure = false;
  await f.open();
  assert.equal(f.window.visible, false);
  f.fromPanel('resize', 360);
  assert.equal(f.window.visible, true);
  assert.equal(f.window.bounds.height, 360);
});

test('refreshing before the first size acknowledgement keeps hidden renders opening', async t => {
  const f = previewFixture(t);
  f.autoMeasure = false;
  await f.open();
  const firstToken = f.lastPayload.renderToken;
  await f.controller.refresh();
  assert.equal(f.window.visible, false);
  assert.equal(f.lastPayload.opening, true, 'a hidden refresh must not wait for animation frames');
  assert.notEqual(f.lastPayload.renderToken, firstToken);
  f.handlers.get('limitsHistory:resize')({ sender: f.window.webContents }, 360, firstToken, false, false);
  assert.equal(f.window.visible, false, 'the superseded opening cannot reveal stale content');
  f.fromPanel('resize', 420);
  assert.equal(f.window.visible, true);
  await f.controller.refresh();
  assert.equal(f.lastPayload.opening, false, 'visible refreshes retain their paint handoff');
});

test('account changes use the sidebar frame spring and retarget from the current frame', async t => {
  const f = previewFixture(t);
  await f.open();
  const start = { ...f.window.bounds };
  f.contentHeight = 520;
  await f.open('b', false, { x: 0, y: 350, width: 300, height: 100 });
  assert.deepEqual(f.window.bounds, start, 'the old frame must not jump to the destination');
  f.clock = 120; f.frame();
  const intermediate = { ...f.window.bounds };
  assert.ok(intermediate.y > start.y && intermediate.y < 372);
  assert.ok(intermediate.height > 420 && intermediate.height < 520);
  await f.open('c', false, { x: 0, y: 150, width: 300, height: 100 });
  assert.deepEqual(f.window.bounds, intermediate, 'a new selection starts from the painted frame');
  f.clock = 800; f.frame();
  assert.equal(f.window.bounds.y, 228);
  assert.equal(f.window.bounds.height, 520);
  assert.equal(f.frame, null);
});

test('a stale size acknowledgement cannot move a newer preview', async t => {
  const f = previewFixture(t);
  await f.open();
  const oldToken = f.lastPayload.renderToken;
  await f.open('b');
  const bounds = { ...f.window.bounds };
  f.handlers.get('limitsHistory:resize')({ sender: f.window.webContents }, 700, oldToken, true, false);
  assert.deepEqual(f.window.bounds, bounds);
  assert.equal(f.frame, null);
});

test('enabling reduced motion or closing cancels native frame playback', async t => {
  const f = previewFixture(t);
  await f.open();
  await f.open('b', false, { x: 0, y: 350, width: 300, height: 100 });
  assert.ok(f.frame);
  f.handlers.get('limitsHistory:resize')({ sender: f.window.webContents }, 420, f.lastPayload.renderToken, false, true);
  assert.equal(f.frame, null);
  assert.equal(f.window.bounds.y, 428);
  await f.open('c', false, { x: 0, y: 150, width: 300, height: 100 });
  assert.ok(f.frame);
  const tick = f.frame;
  f.fromPanel('close');
  assert.equal(f.frame, null);
  const bounds = { ...f.window.bounds };
  f.clock = 1000; tick();
  assert.deepEqual(f.window.bounds, bounds);
  assert.equal(f.window.visible, false);
});

for (const sourceChange of [false, true]) test(`raw-only observations interrupt an existing percent stream across restart (source change: ${sourceChange})`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-missing-percent-'));
  const file = path.join(directory, 'history.sqlite');
  const options = { now: () => at(2, 12) };
  let store = createLimitsHistoryStore(file, options);
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const row = (minute, remaining, limit, source = 'a') => ({
    ...fundedProvider(at(2, 10, minute), remaining, limit), sourceDeviceId: source
  });
  await store.record('local', { providers: [row(0, 80, 100)] });
  await store.record('local', { providers: [row(5, 70, null, sourceChange ? 'b' : 'a')] });
  await store.close();
  store = createLimitsHistoryStore(file, options);
  await store.record('local', { providers: [row(10, 60, 100, sourceChange ? 'b' : 'a')] });
  let entry = (await store.query('local', row(10, 60, 100))).windows[0];
  assert.equal(entry.distribution.buckets.at(-1).value, 20, 'matching same-day endpoints contribute their observed net quota change');
  assert.equal(entry.distribution.unallocated, 0);
  assert.equal(entry.distribution.buckets.at(-1).uncertain, !sourceChange);
  assert.equal(segments(entry.points).length, 1, 'the trend connects valid percentages across the raw-only observation');
  assert.deepEqual(segments(entry.points)[0].map(p => p.value), [20, 40]);
  await store.record('local', { providers: [row(15, 50, 100, sourceChange ? 'b' : 'a')] });
  entry = (await store.query('local', row(15, 50, 100))).windows[0];
  assert.equal(entry.distribution.buckets.at(-1).value, 30, 'the net change and later fully observed increment both count');
  assert.equal(entry.distribution.resets, 0);
  const hourly = (await store.query('local', row(15, 50, 100), { grain: 'hour', day: dayKey(at(2, 12)) })).windows[0];
  assert.equal(hourly.distribution.buckets.find(bucket => new Date(bucket.at).getHours() === 10).value, 30);
  if (!sourceChange) {
    const raw = row(15, 50, 100); raw.windows[0].showMeter = false;
    assert.deepEqual((await store.query('local', raw)).windows[0].points.map(point => point.value), [80, 70, 60, 50]);
  }
});

for (const change of ['activity', 'quota', 'removed', 'backend']) test(`a pending history read distinguishes ${change} publications`, async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf('async function limitsHistoryPayload(');
  const end = source.indexOf('\nfunction getLimitsHistoryController(', start);
  const row = provider(at(2, 10));
  let complete;
  const context = {
    latestStats: { limits: { providers: [row] } }, statsPushSource: null, hubModeGeneration: 0, scope: 'local',
    currentHubStatsIdentity: () => context.scope, electronPresentationStats: stats => stats,
    historyRowKey, getLimitsHistoryStore: () => ({ query: () => new Promise(resolve => { complete = resolve; }) }),
    settings: {}, historyWindowHidden: () => false, historyMaskEmail: value => value,
    historyProviderCatalog: [], historyVendorColors: () => ({}),
    fontSettingsApi: { textScaleForSize: () => 1, resolveEffectiveFontSettings: () => ({ interfaceFont: 'monospace' }) },
    trayMenuLocale: () => 'en', crypto: require('node:crypto'), systemPreferences: {}
  };
  const read = vm.runInNewContext(source.slice(start, end) + '; limitsHistoryPayload;', context);
  const pending = read(historyRowKey(row));
  if (change === 'activity') {
    const previous = context.latestStats;
    context.latestStats = require('../../src/electron/syncDisplayStats').projectLocalActivity(previous, { observations: [], nativeSessions: {} });
    assert.notEqual(context.latestStats, previous, 'the real activity publisher produces another stats object');
  }
  if (change === 'quota') context.latestStats = { ...context.latestStats, limits: { providers: [provider(at(2, 10, 5), 25)] } };
  if (change === 'removed') context.latestStats = { ...context.latestStats, limits: { providers: [] } };
  if (change === 'backend') context.scope = 'other-backend';
  complete({ windows: [{ key: 'weekly', window: row.windows[0] }] });
  const result = await pending;
  if (change === 'activity') {
    assert.ok(result, 'unrelated activity cannot cancel or close a quota preview');
    assert.equal(result.windows.length, 1);
  } else assert.equal(result, change === 'quota' ? undefined : null, 'a changed quota is superseded; a changed backend invalidates the card');
});

for (const interruption of ['allowance', 'reset', 'refill', 'failure', 'conflict']) {
  test(`a missing allowance does not hide a later ${interruption} boundary`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-allowance-boundary-'));
    const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
    t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const first = fundedProvider(at(2, 10), 80, 100);
    const missing = fundedProvider(at(2, 10, 5), 70, null);
    await store.record('local', { providers: [first] });
    await store.record('local', { providers: [missing] });
    if (interruption === 'failure') await store.record('local', { providers: [{ ...missing, status: 'error' }] });
    if (interruption === 'conflict') await store.record('local', { providers: [{ ...fundedProvider(at(2, 10), 50, 100), sourceDeviceId: 'other' }] });
    const recovered = fundedProvider(at(2, 10, 10), interruption === 'refill' ? 90 : 60, interruption === 'allowance' ? 200 : 100);
    if (interruption === 'reset') recovered.windows[0].resetsAt = new Date(at(10, 0)).toISOString();
    await store.record('local', { providers: [recovered] });
    const entry = (await store.query('local', recovered)).windows[0];
    assert.equal(segments(entry.points).length, 2, 'other discontinuities still split the trend');
    assert.equal(entry.distribution.buckets.at(-1).value, null, 'the boundary contributes no measured consumption');
    assert.equal(entry.distribution.buckets.at(-1).uncertain, true);
  });
}

for (const crossDay of [false, true]) test(`recovered allowance net changes are assigned only within their time bucket (cross day: ${crossDay})`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-net-buckets-'));
  const clock = at(3, 12);
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => clock });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const firstAt = crossDay ? at(2, 23, 50) : at(3, 10, 50);
  const recoveredAt = firstAt + 15 * 60000;
  const first = fundedProvider(firstAt, 80, 100);
  const missing = fundedProvider(firstAt + 5 * 60000, 70, null);
  const recovered = fundedProvider(recoveredAt, 60, 100);
  const next = fundedProvider(recoveredAt + 5 * 60000, 50, 100);
  for (const row of [first, missing, recovered, recovered, next]) await store.record('local', { providers: [row] });
  const daily = (await store.query('local', next)).windows[0].distribution;
  assert.equal(daily.buckets.at(-1).value, crossDay ? 10 : 30);
  assert.equal(daily.unallocated, crossDay ? 20 : 0);
  assert.equal(daily.buckets.at(-1).uncertain, true);
  assert.equal(daily.resets, 0);
  const hourly = (await store.query('local', next, { grain: 'hour', day: dayKey(clock) })).windows[0].distribution;
  assert.equal(hourly.buckets.find(b => new Date(b.at).getHours() === new Date(recoveredAt).getHours()).value, 10);
  assert.equal(hourly.unallocated, 20, 'an hourly view cannot assign a change that crosses hours even when the daily view can');
  assert.equal(hourly.resets, 0);
});

test('an unchanged percentage around a missing allowance is an observed net zero', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-net-zero-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const recovered = fundedProvider(at(2, 10, 10), 80, 100);
  for (const row of [fundedProvider(at(2, 10), 80, 100), fundedProvider(at(2, 10, 5), 80, null), recovered]) {
    await store.record('local', { providers: [row] });
  }
  for (const grain of ['day', 'hour']) {
    const distribution = (await store.query('local', recovered, { grain, day: dayKey(at(2, 12)) })).windows[0].distribution;
    const bucket = distribution.buckets.find(b => grain === 'day' ? b.key === dayKey(at(2, 12)) : new Date(b.at).getHours() === 10);
    assert.equal(bucket.value, 0);
    assert.equal(bucket.uncertain, true);
    assert.equal(distribution.unallocated, 0);
    assert.equal(distribution.resets, 0);
  }
});

for (const missingKind of ['absent window', 'empty percentage', 'empty monetary']) {
  test(`successful snapshots mark ${missingKind} coverage missing without affecting later valid intervals`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-empty-snapshot-'));
    const file = path.join(directory, 'history.sqlite');
    const options = { now: () => at(2, 12) };
    let store = createLimitsHistoryStore(file, options);
    t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const reading = (minute, used) => ({ ...(missingKind === 'empty monetary'
      ? fundedProvider(at(2, 10, minute), 100 - used, 100) : provider(at(2, 10, minute), used)), sourceDeviceId: 'a' });
    const first = reading(0, 20);
    const missing = { ...reading(5, 20), windows: missingKind === 'absent window' ? [] : first.windows.map(w => ({
      ...w, usedPercent: null, remainingPercent: null, remaining: null, used: null
    })) };
    await store.record('local', { providers: [first] });
    await store.record('local', { providers: [missing] });
    assert.equal((await store.query('local', first)).windows[0].distribution.buckets.at(-1).uncertain, true,
      'a known missing observation is visible before the next valid reading');
    await store.record('local', { providers: [{ ...missing, updatedAt: new Date(at(2, 10, 3)).toISOString() }] });
    await store.record('local', { providers: [reading(4, 22)] });
    assert.deepEqual((await store.query('local', first)).windows[0].points.map(p => p.value), [20], 'older missing snapshots cannot roll back the observation fence');
    await store.close(); store = createLimitsHistoryStore(file, options);
    await store.record('local', { providers: [reading(10, 30)] });
    const recovered = (await store.query('local', reading(10, 30))).windows[0];
    assert.equal(recovered.distribution.buckets.at(-1).value, null);
    assert.equal(recovered.distribution.unallocated, 10);
    assert.equal(segments(recovered.points).length, 2);
    await store.record('local', { providers: [missing] });
    await store.record('local', { providers: [reading(15, 35)] });
    for (const grain of ['day', 'hour']) {
      const entry = (await store.query('local', reading(15, 35), { grain, day: dayKey(at(2, 12)) })).windows[0];
      const bucket = entry.distribution.buckets.find(b => grain === 'day' ? b.key === dayKey(at(2, 12)) : new Date(b.at).getHours() === 10);
      assert.equal(bucket.value, 5, 'a cached old missing snapshot cannot interrupt the recovered source');
      assert.equal(bucket.uncertain, true);
      assert.equal(entry.distribution.unallocated, 10);
      assert.equal(entry.distribution.resets, 0);
    }
  });
}

test('an omitted quota does not interrupt other windows still present in the same successful snapshot', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-partial-snapshot-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const first = provider(at(2, 10), 20);
  const session = { kind: 'session', usedPercent: 40, windowMinutes: 300, resetsAt: new Date(at(2, 14)).toISOString() };
  await store.record('local', { providers: [{ ...first, windows: [...first.windows, session] }] });
  await store.record('local', { providers: [provider(at(2, 10, 5), 25)] });
  const returned = { ...provider(at(2, 10, 10), 30), windows: [...provider(at(2, 10, 10), 30).windows, { ...session, usedPercent: 50 }] };
  await store.record('local', { providers: [returned] });
  const [weekly, restored] = (await store.query('local', returned)).windows;
  assert.equal(weekly.distribution.buckets.at(-1).value, 10);
  assert.equal(weekly.distribution.buckets.at(-1).uncertain, false);
  assert.equal(restored.distribution.buckets.at(-1).value, null);
  assert.equal(restored.distribution.unallocated, 10);
  assert.equal(restored.distribution.buckets.at(-1).uncertain, true);
});

test('an inactive source missing its allowance cannot guard a healthy observer or block later consistent reports', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-foreign-missing-'));
  const file = path.join(directory, 'history.sqlite');
  const options = { now: () => at(2, 12) };
  let store = createLimitsHistoryStore(file, options);
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const reading = (minute, remaining, limit, source) => ({ ...fundedProvider(at(2, 10, minute), remaining, limit), sourceDeviceId: source });
  await store.record('local', { providers: [reading(0, 80, 100, 'a')] });
  await store.record('local', { providers: [reading(5, 75, null, 'b')] });
  await store.close(); store = createLimitsHistoryStore(file, options);
  await store.record('local', { providers: [reading(10, 70, 100, 'a')] });
  const latest = reading(15, 65, 100, 'b');
  await store.record('local', { providers: [latest] });
  for (const raw of [false, true]) {
    const selected = raw ? { ...latest, windows: latest.windows.map(w => ({ ...w, showMeter: false })) } : latest;
    const entry = (await store.query('local', selected)).windows[0];
    assert.deepEqual(entry.points.map(p => p.value), raw ? [80, 70, 65] : [20, 30, 35]);
    assert.equal(entry.distribution.buckets.at(-1).value, 15);
    assert.equal(entry.distribution.buckets.at(-1).uncertain, false);
    assert.equal(entry.distribution.unallocated, 0);
  }
});

test('missing allowance from a replacement source still marks a gap when the previous observer expired', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-expired-observer-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const reading = (minute, remaining, limit, source) => ({ ...fundedProvider(at(2, 10, minute), remaining, limit), sourceDeviceId: source });
  for (const row of [reading(0, 80, 100, 'a'), reading(30, 70, null, 'b'), reading(35, 60, 100, 'b')]) await store.record('local', { providers: [row] });
  const entry = (await store.query('local', reading(35, 60, 100, 'b'))).windows[0];
  assert.equal(entry.distribution.buckets.at(-1).value, 20);
  assert.equal(entry.distribution.buckets.at(-1).uncertain, true);
});

for (const identified of [false, true]) test(`Claude CLI history scopes only the unidentified fallback to its device (identified: ${identified})`, async t => {
  const { mapClaudeCliUsageToProvider } = require('../../src/shared/providers/claude/limits');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cli-identity-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => at(2, 12) });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const rows = [20, 50].map((used, index) => ({ ...mapClaudeCliUsageToProvider(`Current session\n${used}% used`, {
    now: new Date(at(2, 10, index * 5)), updatedAt: new Date(at(2, 10, index * 5)).toISOString()
  }), ...(identified ? { accountKey: 'verified-oauth-account-key' } : {}), sourceDeviceId: index ? 'b' : 'a' }));
  assert.equal(rows[0].accountEmail, '', 'a verified UUID may have no email');
  assert.equal(historyAccountKey(rows[0]) === historyAccountKey(rows[1]), identified);
  const context = {};
  vmForIdentity(context);
  for (const row of rows) assert.equal(context.TokenMonitorLimitsHistoryIdentity.historyRowKey(row), historyRowKey(row), 'main and browser agree on identity');
  for (const row of rows) await store.record('local', { providers: [row] });
  for (const [index, row] of rows.entries()) {
    const entry = (await store.query('local', row)).windows[0];
    assert.deepEqual(entry.points.map(p => p.value), identified ? [20, 50] : [index ? 50 : 20]);
    assert.equal(entry.distribution.buckets.at(-1).value, identified ? 30 : null);
    assert.equal(entry.distribution.buckets.at(-1).uncertain, false);
  }
});

function vmForIdentity(context) {
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/electron/limits/historyIdentity.js'), 'utf8'), context);
}

for (const snapshotAt of [at(2, 13), at(2, 12) - 731 * 86400_000]) {
  test(`out-of-horizon successful snapshots cannot interrupt current history (${snapshotAt})`, t => {
    const f = databaseFixture(t);
    f.record([action(at(2, 10), 20)]);
    f.record([{ account: accountA, snapshotAt, windows: [] }]);
    f.record([action(at(2, 10, 10), 30)]);
    const entry = f.query().windows[0];
    assert.equal(entry.distribution.buckets.at(-1).value, 10);
    assert.equal(entry.distribution.buckets.at(-1).uncertain, false);
    assert.equal(segments(entry.points).length, 1);
  });
}

for (const change of ['metadata only', 'reset', 'refill']) {
  test(`a foreign raw reading missing allowance preserves ${change === 'metadata only' ? 'healthy continuity' : `a genuine ${change} conflict`}`, t => {
    const f = databaseFixture(t);
    const raw = (minute, value, source, basis = null, reset = at(8, 0)) => {
      const entry = action(at(2, 10, minute), value, { source, reset });
      Object.assign(entry.windows[0].point, { unit: 'USD', balance: true, ...(basis ? { basis } : {}) });
      return entry;
    };
    f.record([raw(0, 80, 'a', '100')]);
    f.record([raw(change === 'metadata only' ? 0 : 5, change === 'refill' ? 90 : 80, 'b', null,
      change === 'reset' ? at(9, 0) : at(8, 0))]);
    f.record([raw(10, 70, 'a', '100')]);
    f.record([raw(15, 65, 'b', '100')]);
    const entry = f.query().windows[0];
    assert.deepEqual(entry.points.map(p => p.value), change === 'metadata only' ? [80, 70, 65] : [80, 70]);
    assert.equal(entry.distribution.buckets.at(-1).uncertain, change !== 'metadata only');
  });
}

for (const missing of ['empty snapshot', 'unreadable window', 'failure']) {
  test(`a replacement observer's ${missing} interrupts an earlier allowance-only gap across restart`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-replacement-gap-'));
    const file = path.join(directory, 'history.sqlite');
    const options = { now: () => at(2, 12) };
    let store = createLimitsHistoryStore(file, options);
    t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const reading = (minute, remaining, limit, source) => ({ ...normalizeLimitProvider(fundedProvider(at(2, 10, minute), remaining, limit)), sourceDeviceId: source });
    await store.record('local', { providers: [reading(0, 80, 100, 'a')] });
    await store.record('local', { providers: [reading(30, 70, null, 'b')] });
    await store.close(); store = createLimitsHistoryStore(file, options);
    const absent = reading(35, null, null, 'b');
    if (missing === 'empty snapshot') absent.windows = [];
    if (missing === 'failure') absent.status = 'error';
    await store.record('local', { providers: [absent] });
    const recovered = reading(40, 60, 100, 'b');
    await store.record('local', { providers: [recovered] });
    const entry = (await store.query('local', recovered)).windows[0];
    assert.equal(entry.distribution.buckets.at(-1).value, null, 'a missing observation cannot qualify as allowance-only');
    assert.equal(entry.distribution.unallocated, 20);
    assert.equal(entry.distribution.resets, 0);
    assert.equal(segments(entry.points).length, 2);
    await store.record('local', { providers: [reading(45, 50, 100, 'b')] });
    assert.equal((await store.query('local', recovered)).windows[0].distribution.buckets.at(-1).value, 10);
  });
}

for (const flat of [false, true]) for (const switched of [false, true]) {
  test(`compatible same-bucket endpoints count their net change across a sampling gap (flat: ${flat}, switched: ${switched})`, t => {
    const f = databaseFixture(t);
    const value = n => flat ? 0 : n;
    f.record([action(at(2, 10), value(20), { source: 'a' }), action(at(2, 10, 5), value(22), { source: 'a' })]);
    f.reopen();
    const source = switched ? 'b' : 'a';
    f.record([action(at(2, 10, 50), value(25), { source }), action(at(2, 10, 55), value(27), { source })]);
    f.reopen();
    for (const grain of ['day', 'hour']) {
      const entry = f.query({ grain, day: dayKey(f.clock) }).windows[0];
      assert.equal(segments(entry.points).length, 1, 'elapsed time or a compatible observer handoff alone cannot cut the visible line');
      const bucket = entry.distribution.buckets.find(b => grain === 'day' ? b.key === dayKey(f.clock) : new Date(b.at).getHours() === 10);
      assert.equal(bucket.value, flat ? 0 : 7, 'same-bucket compatible endpoints establish the net change');
      assert.equal(bucket.uncertain, true);
      assert.equal(entry.distribution.unallocated, 0, 'the same-bucket gap delta is attributed');
      assert.equal(entry.distribution.resets, 0);
    }
  });
}

test('connecting observed trend endpoints does not extrapolate before or after them', () => {
  const points = [point(at(2, 10), 20), { ...point(at(2, 10, 45), 25), uncertainBefore: true }];
  assert.deepEqual(segments(points), [points]);
  assert.equal(segments(points)[0][0].at, at(2, 10));
  assert.equal(segments(points)[0].at(-1).at, at(2, 10, 45));
  const result = distribution(points, { now: at(2, 12) });
  assert.equal(result.buckets.at(-1).value, 5);
  assert.equal(result.unallocated, 0);
});

for (const unit of ['percent', 'balance', 'spend']) {
  test(`every provider attributes compatible same-day ${unit} changes after a failed refresh`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-recovered-curve-'));
    const file = path.join(directory, 'history.sqlite');
    const options = { now: () => at(2, 12) };
    let store = createLimitsHistoryStore(file, options);
    t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const reading = (id, minute, value, source) => {
      const used = id === 'codex' ? 100 : value;
      let row = unit === 'percent' ? { ...provider(at(2, 10, minute), used), provider: id }
        : unit === 'balance' ? fundedProvider(at(2, 10, minute), 100 - used, 100, id)
          : { ...provider(at(2, 10, minute), used), provider: id,
            windows: [{ kind: 'billing', metric: 'spend', used, currency: 'CNY', showMeter: false }] };
      if (unit === 'balance') row.windows[0].showMeter = false;
      return { ...normalizeLimitProvider(row), sourceDeviceId: source };
    };
    for (const [minute, used] of [[0, 20], [5, 22]]) {
      await store.record('local', { providers: LIMIT_PROVIDER_IDS.map(id => reading(id, minute, used, 'a')) });
    }
    await store.record('local', { providers: LIMIT_PROVIDER_IDS.map(id => ({ ...reading(id, 10, 22, 'a'), status: 'error', windows: [] })) });
    await store.close(); store = createLimitsHistoryStore(file, options);
    const returned = LIMIT_PROVIDER_IDS.map(id => reading(id, 15, 25, 'b'));
    await store.record('local', { providers: returned });
    for (const row of returned) {
      const entry = (await store.query('local', row)).windows[0];
      assert.equal(segments(entry.points).length, 1, row.provider);
      assert.equal(entry.distribution.buckets.at(-1).value, row.provider === 'codex' ? 0 : 5, row.provider);
      assert.equal(entry.distribution.unallocated, 0, row.provider);
      assert.equal(entry.distribution.buckets.at(-1).uncertain, true, row.provider);
    }
  });
}

for (const jitter of [-1001, -1000, 1000, 1001]) {
  test(`trend and accounting share the reset timestamp tolerance for ${jitter} milliseconds`, () => {
    const points = [point(at(2, 10), 100, at(8, 0)), point(at(2, 10, 5), 100, at(8, 0) + jitter)];
    assert.equal(segments(points).length, Math.abs(jitter) <= 1000 ? 1 : 2);
    assert.equal(require('../../src/electron/renderer/limits/historyModel').sameCycle(...points), Math.abs(jitter) <= 1000, 'accounting shares the same rounding boundary');
  });
}

test('trend deadline rounding never joins a crossed reset or an unknown deadline', () => {
  const previous = point(at(2, 10), 20, at(2, 10, 5));
  assert.equal(segments([previous, point(at(2, 10, 5), 20, at(2, 10, 5) + 1000)]).length, 2);
  assert.equal(segments([previous, point(at(2, 10, 1), 20, null)]).length, 2);
  assert.equal(segments([point(at(2, 10), 20, at(2, 10, 5) + 1000), point(at(2, 10, 5), 20, at(2, 10, 5))]).length, 2);
});


test('a superseded quota refresh keeps the visible history card and its frame until the next valid payload', async t => {
  const f = previewFixture(t);
  await f.open('a', true);
  const payload = f.lastPayload;
  const bounds = f.window.getBounds();
  f.pending = Promise.resolve(undefined);
  await f.controller.refresh();
  assert.equal(f.window.visible, true);
  assert.equal(f.lastPayload, payload);
  assert.deepEqual(f.window.getBounds(), bounds);
  f.pending = Promise.resolve({ source: 'a', updatedAt: 'new' });
  await f.controller.refresh();
  assert.equal(f.lastPayload.updatedAt, 'new');
  f.pending = Promise.resolve(null);
  await f.controller.refresh();
  assert.equal(f.window.visible, false, 'a genuinely removed account still closes its history');
});

for (const failed of [false, true]) test(`same-day compatible net changes belong to today despite a sampling interruption (failed: ${failed})`, t => {
  const f = databaseFixture(t);
  f.record([action(at(2, 10), 20), action(at(2, 10, 5), 29)]);
  if (failed) {
    f.record([{ account: accountA, source: '', failed: true }]);
    assert.equal(f.sql('SELECT break_after FROM runs ORDER BY until DESC LIMIT 1')[0].break_after, 1, 'the failed refresh interrupts the recorded stream');
  }
  f.record([action(at(2, 10, 50), 30)]);
  f.reopen();
  const entry = f.query().windows[0];
  assert.equal(entry.distribution.buckets.at(-1).value, 10);
  assert.equal(entry.distribution.unallocated, 0);
  assert.equal(entry.distribution.buckets.at(-1).uncertain, true);
  assert.equal(segments(entry.points).length, 1);
});

test('same-day net changes stay in the stored daily summary after detailed retention expires', t => {
  const f = databaseFixture(t);
  f.record([action(at(2, 10), 20), action(at(2, 10, 5), 29), action(at(2, 10, 50), 30)]);
  const originalDay = dayKey(f.clock);
  assert.equal(f.sql('SELECT value, unallocated FROM daily').at(-1).value, 10);
  f.clock += 181 * 86400_000;
  f.reopen();
  const result = f.query({ grain: 'day', day: originalDay }).windows[0];
  assert.equal(result.summaryOnly, true);
  assert.equal(result.distribution.buckets.at(-1).value, 10);
  assert.equal(result.distribution.unallocated, 0);
});

for (const drift of [-1000, 1000]) for (const source of ['a', 'b']) test(`reset rounding retains daily/hourly consumption (drift: ${drift}, source: ${source})`, t => {
  const f = databaseFixture(t);
  const reset = at(8, 10);
  f.record([action(at(2, 10), 20, { source: 'a', reset }), action(at(2, 10, 5), 21, { source, reset: reset + drift })]);
  f.reopen();
  for (const grain of ['day', 'hour']) {
    const result = f.query({ grain, day: dayKey(f.clock) }).windows[0].distribution;
    const bucket = grain === 'day' ? result.buckets.at(-1) : result.buckets.find(b => new Date(b.at).getHours() === 10);
    assert.equal(bucket.value, 1);
    assert.equal(result.unallocated, 0);
    assert.equal(result.resets, 0);
  }
});

for (const drift of [-1000, 1000]) test(`rounding cannot count through either crossed reset deadline (drift: ${drift})`, t => {
  const f = databaseFixture(t);
  const first = at(2, 10), second = at(2, 10, 5);
  const reset = second + (drift < 0 ? 1000 : 0);
  f.record([action(first, 20, { reset }), action(second, 21, { reset: reset + drift })]);
  assert.equal(f.query().windows[0].distribution.buckets.at(-1).value, null);
  assert.equal(f.query().windows[0].distribution.resets, 1);
});

test('daily summaries keep the collection date when the device changes timezone', t => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Hong_Kong';
    const start = Date.parse('2026-11-02T00:10:00+08:00');
    const f = databaseFixture(t, start + 3600_000);
    f.record([action(start, 20), action(start + 300000, 25)]);
    process.env.TZ = 'America/Los_Angeles';
    f.reopen();
    f.clock = Date.parse('2026-11-02T12:00:00-08:00');
    const result = f.query({ grain: 'day', day: '2026-11-02' }).windows[0].distribution;
    assert.equal(result.buckets.find(b => b.key === '2026-11-02').value, 5);
    assert.equal(result.buckets.find(b => b.key === '2026-11-01').value, null);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
