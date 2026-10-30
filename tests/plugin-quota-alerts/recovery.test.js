'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluate } = require('../../plugins/quota-alerts/evaluator.cjs');
const { defaults, createPreferences } = require('../../plugins/quota-alerts/preferences.cjs');
const { message, deliver, deliverTest } = require('../../plugins/quota-alerts/delivery.cjs');
const { createBackend } = require('../../plugins/quota-alerts/backend.cjs');
const now = Date.parse('2026-10-30T02:00:00Z');
function row(remaining, seconds = 0, patch = {}) {
  return { provider: 'codex', providerLabel: 'Codex', accountId: 'fixture', identityAvailable: true, status: 'ok', updatedAt: new Date(now + seconds * 1000).toISOString(),
    windows: [{ kind: 'session', displayLabel: 'Session', remainingPercent: remaining }], ...patch };
}
const state = () => ({ low: new Set(), observations: new Map() });
const scan = (s, rows, seconds) => evaluate(rows, 10, s.low, now + seconds * 1000, s.observations);

test('full quota requires a real transition and never announces startup or repeated 100%', () => {
  const s = state();
  assert.equal(scan(s, [row(100)], 0).triggered.length, 0);
  assert.equal(scan(s, [row(100, 1)], 1).triggered.length, 0);
  assert.equal(scan(s, [row(70, 2)], 2).triggered.length, 0);
  assert.deepEqual(scan(s, [row(100, 3)], 3).triggered.map(a => a.event), ['full']);
  assert.equal(scan(s, [row(100, 4)], 4).triggered.length, 0);
  assert.equal(scan(s, [row(99.999, 5)], 5).triggered.length, 0);
  assert.deepEqual(scan(s, [row(100, 6)], 6).triggered.map(a => a.event), ['full']);
});

test('threshold recovery and full recovery are distinct and emitted once per transition', () => {
  const s = state();
  assert.deepEqual(scan(s, [row(7)], 0).triggered.map(a => a.event), ['low']);
  assert.deepEqual(scan(s, [row(10, 1)], 1).triggered.map(a => a.event), ['restored']);
  assert.equal(scan(s, [row(11, 2)], 2).triggered.length, 0);
  assert.deepEqual(scan(s, [row(7, 3)], 3).triggered.map(a => a.event), ['low']);
  assert.deepEqual(scan(s, [row(100, 4)], 4).triggered.map(a => a.event), ['full']);
  assert.equal(scan(s, [row(100, 5)], 5).triggered.length, 0);
});

test('duplicates and incomplete readings cannot prove recovery or full quota', () => {
  const s = state();
  scan(s, [row(7), row(90)], 0);
  assert.equal(scan(s, [row(90, 1), row(7, 1)], 1).triggered.length, 0);
  assert.equal(scan(s, [row(100, 2), row(7, 2)], 2).triggered.length, 0);
  assert.equal(scan(s, [row(100, 3), row(null, 3)], 3).triggered.length, 0);
  assert.deepEqual(scan(s, [row(100, 4)], 4).triggered.map(a => a.event), ['full']);
  assert.equal(scan(s, [row(100, 5, { accountId: 'new-account' })], 5).triggered.length, 0);
});

for (const baseline of [false, true]) for (const unknownAt of [5, 20]) {
  test(`incomplete low readings fence older recovery and replay (baseline=${baseline}, unknownAt=${unknownAt})`, () => {
    const s = state();
    if (baseline) scan(s, [row(100)], 0);
    const incomplete = [row(5, 20), row(null, unknownAt)];
    assert.deepEqual(scan(s, incomplete, 20).triggered.map(a => a.event), ['low']);
    assert.equal(scan(s, [row(100, 10)], 21).triggered.length, 0);
    assert.equal(s.low.size, 1, 'a high reading older than the known low must not rearm');
    assert.equal(scan(s, incomplete, 22).triggered.length, 0, 'the same low snapshot must not notify twice');
    scan(s, [row(100, 30)], 30);
    assert.equal(s.low.size, 0, 'a genuinely newer complete reading can rearm');
    assert.deepEqual(scan(s, [row(5, 40)], 40).triggered.map(a => a.event), ['low']);
  });
}

test('stale, unavailable, elapsed and out-of-order observations never fabricate recovery', () => {
  const s = state(); scan(s, [row(7, 10)], 10);
  for (const value of [row(100, 9), row(100, 10), row(100, 11, { status: 'unavailable' }), row(100, 11, { updatedAt: new Date(now - 16 * 60_000).toISOString() }),
    row(100, 11, { windows: [{ kind: 'session', displayLabel: 'Session', remainingPercent: 100, resetsAt: new Date(now).toISOString() }] })]) {
    assert.equal(scan(s, [value], 11).triggered.length, 0);
    assert.equal(s.low.size, 1);
  }
  assert.deepEqual(scan(s, [row(100, 12)], 12).triggered.map(a => a.event), ['full']);
});

test('every session window must be full; recovery copies keep host labels and unrounded truth', async () => {
  const s = state(); scan(s, [row(7)], 0);
  const restored = scan(s, [row(99.999, 1)], 1).triggered[0];
  assert.equal(restored.event, 'restored');
  const payload = await message(restored, now + 1000, 'zh-TW');
  assert.equal(payload.title, 'Codex 配額已恢復');
  assert.match(payload.body, /Session: 剩餘 99\.99%/);
  assert.doesNotMatch(payload.body, /100%/);
  const windows = remaining => [{ kind: 'session', displayLabel: '5-hour', remainingPercent: 100 }, { kind: 'session', displayLabel: 'Named pool', remainingPercent: remaining }, { kind: 'weekly', displayLabel: 'Weekly', remainingPercent: 20 }];
  assert.equal(scan(s, [row(100, 2, { windows: windows(50) })], 2).triggered.length, 0);
  const full = scan(s, [row(100, 3, { windows: windows(100) })], 3).triggered[0];
  const copy = await message(full, now + 3000, 'zh-TW');
  assert.equal(copy.title, 'Codex 配額已回滿');
  assert.match(copy.body, /5-hour: 剩餘 100%/);
  assert.match(copy.body, /Named pool: 剩餘 100%/);
  assert.doesNotMatch(copy.body, /Weekly/);
});

test('initial schema rejects retired preview fields rather than migrating them', t => {
  assert.deepEqual(defaults, { lowQuota: false, threshold: 10, recovery: false });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-initial-schema-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'preferences.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 0, values: { enabled: true, os: true, threshold: 10 } }));
  assert.throws(() => createPreferences(directory), /Cannot load preferences/);
});

test('low and recovery opt-ins are independent and manual tests keep their boundaries', async () => {
  const sent = [], options = { host: { call: async (method, payload) => { assert.equal(method, 'notify'); sent.push(payload); } }, signal: new AbortController().signal, locale: 'zh-TW' };
  const base = { provider: 'codex', providerLabel: 'Codex', remaining: 100, windows: [{ kind: 'session', displayLabel: 'Session', remainingPercent: 100 }] };
  assert.deepEqual(await deliver({ ...base, event: 'full' }, { ...defaults, lowQuota: true }, options), []);
  assert.deepEqual(await deliver({ ...base, event: 'low' }, { ...defaults, recovery: true }, options), []);
  await deliver({ ...base, event: 'full' }, { ...defaults, recovery: true }, options);
  assert.equal(sent[0].title, 'Codex 配額已回滿');
  await deliverTest(options);
  assert.equal(sent[1].title, '測試通知');
  assert.equal(sent[1].body, '這是配額提醒測試，不代表實際配額不足。');
});

function backendFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-recovery-backend-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let seconds = 0, rows = [row(100)], unavailable = false;
  const notices = [], queries = [];
  const host = { async call(method, args) {
    if (method === 'app.settings') return { language: 'zh-TW' };
    if (method === 'notify') { notices.push(args); return true; }
    if (method === 'data.query') {
      queries.push(args);
      return unavailable ? { availability: 'denied' } : { availability: 'available', freshness: { state: 'fresh' }, aggregateCoverage: { kind: 'authorizedCollection' }, rows, pageInfo: { hasMore: false } };
    }
    assert.fail(`Unexpected operation: ${method}`);
  } };
  const preferences = createPreferences(directory);
  preferences.update({ expectedRevision: 0, patch: { recovery: true } });
  const create = () => createBackend({ dataDirectory: directory, publish() {}, host }, { now: () => now + seconds * 1000, intervalMs: 0 });
  return { directory, notices, queries, create, set(percent, time) { seconds = time; rows = [row(percent, time)]; }, unavailable(value) { unavailable = value; } };
}

test('backend recovery-only monitoring is quiet at startup, deduplicates, resets on source changes and restart', async t => {
  const f = backendFixture(t); let backend = f.create(); t.after(() => backend.dispose());
  await backend.start(); await backend.update({ source: 'A' });
  assert.equal(f.notices.length, 0);
  f.set(7, 1); await backend.call('refresh'); assert.equal(f.notices.length, 0);
  f.set(99, 2); await backend.call('refresh'); await backend.call('refresh');
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].title, 'Codex 配額已恢復');
  f.set(100, 3); await backend.call('refresh'); await backend.call('refresh');
  assert.equal(f.notices.length, 2); assert.equal(f.notices[1].title, 'Codex 配額已回滿');
  f.set(7, 4); await backend.call('refresh');
  f.set(100, 5); await backend.update({ source: 'B' }); assert.equal(f.notices.length, 2);
  f.set(7, 6); await backend.call('refresh');
  await backend.dispose(); backend = f.create();
  f.set(100, 7); await backend.start(); assert.equal(f.notices.length, 2);
  const before = f.queries.length, preferences = backend.call('preferences.get');
  await backend.call('preferences.update', { expectedRevision: preferences.revision, patch: { recovery: false } });
  assert.equal(backend.call('status').state, 'off'); assert.equal(f.queries.length, before);
});

test('unavailable snapshots and failed state writes cannot announce or consume recovery', async t => {
  const f = backendFixture(t), backend = f.create(); t.after(() => backend.dispose());
  f.set(7, 0); await backend.start();
  f.unavailable(true); f.set(100, 1); await backend.call('refresh'); assert.equal(f.notices.length, 0);
  f.unavailable(false);
  const ledger = path.join(f.directory, 'crossings.json');
  fs.unlinkSync(ledger); fs.mkdirSync(ledger);
  await backend.call('refresh'); assert.equal(backend.call('status').state, 'error'); assert.equal(f.notices.length, 0);
  fs.rmdirSync(ledger);
  await backend.call('refresh'); assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].title, 'Codex 配額已回滿');
});
