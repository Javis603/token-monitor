'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluate, formatResetsIn } = require('../../plugins/quota-alerts/evaluator.cjs');
const { deliver } = require('../../plugins/quota-alerts/delivery.cjs');
const { createBackend } = require('../../plugins/quota-alerts/backend.cjs');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const manifest = require('../../plugins/quota-alerts/manifest.json');
const now = Date.parse('2026-10-28T10:00:00Z');
let sequence = 0;
const row = (remaining = 5, overrides = {}) => ({ provider: 'codex', providerLabel: overrides.provider || 'Codex', accountId: 'account-fixture', identityAvailable: true,
  status: 'ok', updatedAt: new Date(now + ++sequence).toISOString(), windows: [{ kind: 'session', displayLabel: 'Session', remainingPercent: remaining,
    resetsAt: new Date(now + 3600000).toISOString() }, { kind: 'weekly', displayLabel: 'Weekly', remainingPercent: 80 }], ...overrides });
const envelope = rows => ({ availability: 'available', freshness: { state: 'fresh' }, rows,
  aggregateCoverage: { kind: 'authorizedCollection' }, pageInfo: { hasMore: false, nextCursor: null } });
const { defaults } = require('../../plugins/quota-alerts/preferences.cjs');

test('manifest declares background capability with monitoring and notification channels off', () => {
  const normalized = normalizeManifest(manifest);
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  assert.equal(normalized.manifest.apiMajor, 1);
  assert.equal(manifest.background, true);
  assert.deepEqual([defaults.lowQuota, defaults.recovery], [false, false]);
  assert.equal(manifest.views.some(v => v.targets), false);
});

test('threshold, repeated snapshots, equality recovery and next crossing', () => {
  const state = new Set();
  assert.equal(evaluate([row(10)], 10, state, now, new Map()).triggered.length, 0);
  assert.equal(evaluate([row(9.9)], 10, state, now, new Map()).triggered.length, 1);
  assert.equal(evaluate([row(0)], 10, state, now, new Map()).triggered.length, 0);
  assert.equal(evaluate([row(10)], 10, state, now, new Map()).active.length, 0);
  assert.equal(evaluate([row(2)], 10, state, now, new Map()).triggered.length, 1);
});

test('provider/account dedup, reordered duplicates and several session windows', () => {
  const state = new Set();
  const low = row(5), high = row(90), otherAccount = row(4, { accountId: 'second' }), otherProvider = row(3, { provider: 'claude' });
  assert.equal(evaluate([low, high, otherAccount, otherProvider], 10, state, now, new Map()).triggered.length, 3);
  assert.equal(evaluate([high, low, otherProvider, otherAccount], 10, state, now, new Map()).triggered.length, 0);
  assert.equal(evaluate([row(90), row(null)], 10, state, now, new Map()).triggered.length, 0);
  assert.equal(evaluate([low], 10, state, now, new Map()).triggered.length, 0, 'unknown duplicate prevented recovery');
  const two = row(90); two.windows.push({ kind: 'session', displayLabel: 'Session', remainingPercent: 2 });
  assert.equal(evaluate([two], 10, new Set(), now, new Map()).active[0].remaining, 2);
});

test('unknown, stale, errored, unidentified and expired windows never become exhausted', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, 101, '5']) {
    const unknown = row(); unknown.windows[0].remainingPercent = value;
    assert.equal(evaluate([unknown], 10, new Set(), now, new Map()).triggered.length, 0);
  }
  for (const overrides of [{ identityAvailable: false }, { accountId: null }, { status: 'unavailable' },
    { updatedAt: null }, { updatedAt: new Date(now - 16 * 60_000).toISOString() },
    { windows: [{ kind: 'session', displayLabel: 'Session', remainingPercent: 0, resetsAt: new Date(now - 1).toISOString() }] },
    { windows: [{ kind: 'weekly', displayLabel: 'Weekly', remainingPercent: 0 }] }]) {
    assert.equal(evaluate([row(0, overrides)], 10, new Set(), now, new Map()).triggered.length, 0);
  }
  const state = new Set(); evaluate([row()], 10, state, now, new Map());
  evaluate([], 10, state, now, new Map()); evaluate([row(null)], 10, state, now, new Map());
  assert.equal(evaluate([row()], 10, state, now, new Map()).triggered.length, 0);
});

test('reset formatting from original evaluator', () => {
  assert.equal(formatResetsIn(new Date(now + 65 * 60_000).toISOString(), now, new Map()), 'resets in 1h 5m');
  assert.equal(formatResetsIn(null, now, new Map()), '');
});

test('desktop delivery sends immediately after opt-in, with Unicode payloads and cancellation', async () => {
  const calls = [], abort = new AbortController();
  const adapters = { host: { call: async (...args) => calls.push(args) }, signal: abort.signal, now };
  const alert = evaluate([row(5, { provider: '測試' })], 10, new Set(), now, new Map()).active[0];
  assert.deepEqual(await deliver(alert, defaults, adapters), []);
  const opted = { ...defaults, lowQuota: true };
  assert.deepEqual(await deliver(alert, { ...opted }, adapters), [{ channel: 'os', status: 'submitted' }]);
  assert.equal(calls[0][0], 'notify');
  assert.match(calls[0][1].title, /測試/); assert.match(calls[0][1].body, /Weekly: 80%/);
  abort.abort(); assert.deepEqual(await deliver(alert, { ...opted }, adapters), []);
  assert.equal(calls.length, 1);
});

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-alerts-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let values = { ...defaults }, result = envelope([row()]), language = 'zh-TW';
  const sent = [], queries = [], outputs = [];
  const host = { call: async (method, args) => {
    if (method === 'app.settings') return { language };
    if (method === 'data.query') { queries.push(args); return typeof result === 'function' ? result(args) : result; }
    if (method === 'notify') { sent.push(args); return true; }
    throw Error('Unexpected host call');
  } };
  const create = () => createBackend({ dataDirectory: dir, host, publish: value => outputs.push(value) }, { now: () => now, intervalMs: 0, preferences: { get: () => ({ status: 'ready', values }) } });
  return { create, sent, queries, outputs, settings: v => { values = { ...values, ...v }; },
    language: v => { language = v; }, data: v => { result = v; } };
}

test('backend no data work while off, saved dedup across restart and recovery', async t => {
  const h = harness(t); let backend = h.create();
  await backend.start(); assert.equal(h.queries.length, 0);
  h.settings({ lowQuota: true });
  await backend.call('refresh'); await backend.call('refresh');
  assert.equal(h.sent.length, 1);
  await backend.dispose(); backend = h.create(); await backend.start();
  assert.equal(h.sent.length, 1);
  h.data(envelope([row(10)])); await backend.call('refresh');
  h.data(envelope([row(2)])); await backend.call('refresh');
  assert.equal(h.sent.length, 2);
  h.settings({ lowQuota: false }); await backend.update({ settings: { values: { lowQuota: false } } });
  assert.equal(backend.call('status').active.length, 0);
  await backend.dispose();
});

test('backend consumes all pages atomically and discards stale/unavailable traversals', async t => {
  const h = harness(t), backend = h.create(); h.settings({ lowQuota: true });
  h.data(q => q.page.cursor ? envelope([row(5)]) : { ...envelope([row(90)]), pageInfo: { hasMore: true, nextCursor: 'second' } });
  await backend.start(); assert.equal(h.sent.length, 1); assert.equal(h.queries[1].page.cursor, 'second');
  h.data({ ...envelope([row(90)]), freshness: { state: 'stale' } }); await backend.call('refresh');
  h.data(envelope([row(5)])); await backend.call('refresh'); assert.equal(h.sent.length, 1, 'stale recovery did not rearm');
  h.settings({ threshold: 20 });
  h.data(q => q.page.cursor ? { availability: 'snapshotExpired' } : { ...envelope([row(1)]), pageInfo: { hasMore: true, nextCursor: 'expired' } });
  await backend.call('refresh'); assert.equal(h.sent.length, 1, 'partial traversal never delivers');
  await backend.dispose();
});

test('in-flight query cannot send after settings change or dispose', async t => {
  const h = harness(t), backend = h.create(); h.settings({ lowQuota: true });
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  h.data(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const pending = backend.start(); await started;
  h.settings({ lowQuota: false }); const updated = backend.update({ settings: { values: { lowQuota: false } } });
  finish(envelope([row()])); await pending; await updated;
  assert.equal(h.sent.length, 0); assert.equal(backend.call('status').state, 'off');
  await backend.dispose();
  await backend.call('refresh'); assert.equal(h.sent.length, 0);
});

test('desktop delivery reports host failures and cancellation', async () => {
  const alert = evaluate([row()], 10, new Set(), now, new Map()).active[0];
  const controller = new AbortController(); let attempts = 0;
  const prefs = { ...defaults, lowQuota: true };
  const deps = { signal: controller.signal, host: { call: async () => { attempts++; throw Error('Fixture OS failure'); } } };
  assert.deepEqual(await deliver(alert, prefs, deps), [{ channel: 'os', status: 'failed' }]);
  assert.equal(attempts, 1);
  deps.host.call = async () => { controller.abort(); throw Error('Fixture cancelled'); };
  assert.deepEqual(await deliver(alert, prefs, deps), [{ channel: 'os', status: 'cancelled' }]);
});

test('disposal fences a pending read and cancels further scheduling', async t => {
  const h = harness(t), backend = h.create(); h.settings({ lowQuota: true });
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  h.data(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const pending = backend.start(); await started;
  const disposed = backend.dispose(); finish(envelope([row()]));
  await pending; await disposed; assert.equal(h.sent.length, 0);
});

test('notification language follows public App settings without rearming low accounts', async t => {
  const h = harness(t), backend = h.create(); h.settings({ lowQuota: true });
  await backend.start();
  assert.match(h.sent[0].title, /配額不足/);
  h.language('ja'); await backend.call('refresh');
  assert.equal(h.sent.length, 1, 'language change must not duplicate a notification');
  h.data(envelope([row(10)])); await backend.call('refresh');
  h.data(envelope([row(5)])); await backend.call('refresh');
  assert.match(h.sent[1].title, /残量不足/);
  await backend.dispose();
});
