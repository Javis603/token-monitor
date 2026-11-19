'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { emptyPeriod, extractUsageFromTokscale, normalizePeriod, mergePeriods, applyPeriodDelta } = require('../../src/shared/usage');
const { captureArchivedClientUsage, applyArchivedClientUsage } = require('../../src/shared/usage/clientUsageArchive');
const { captureSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { createSessionUsageArchiveStore, readSessionUsageArchiveSnapshot } = require('../../src/shared/usage/sessionUsageArchiveStore');
const now = new Date('2026-10-29T12:00:00Z');
const periods = ['today', 'month', 'allTime'];
const row = (model, extra = {}) => ({ client: 'codex', sessionId: 's', model, input: 30, cacheRead: 40, cacheWrite: 10, output: 20, cost: 1, ...extra });
const scan = (...entries) => extractUsageFromTokscale({ entries });
const record = period => Object.fromEntries(periods.map(name => [name, structuredClone(period)]));
const session = p => p.sessions['codex:s'];
const strip = p => { const copy = structuredClone(p); delete session(copy).modelTokenComponents; return copy; };
const replay = (kind, p) => kind === 'client'
  ? applyArchivedClientUsage(record(emptyPeriod()), captureArchivedClientUsage(null, record(p), ['codex'], now), { now, activeClients: [] }).allTime
  : applySessionUsageArchive(record(emptyPeriod()), captureSessionUsageArchive(null, record(p), now), { now }).allTime;
function exact(p) {
  assert.equal(p.totalTokens, 150); assert.equal(p.costUsd, 3);
  assert.equal(p.modelCacheReads.alpha, 40); assert.equal(p.modelCacheReads.beta || 0, 0);
  assert.equal(p.modelOutputs.alpha, 20); assert.equal(p.modelOutputs.beta, 5);
  assert.equal(p.modelUnclassifiedTokens.alpha || 0, 0); assert.equal(p.modelUnclassifiedTokens.beta || 0, 0);
}
const multi = () => scan(row('alpha'), row('beta', { input: 45, cacheRead: 0, cacheWrite: 0, output: 5, cost: 2 }));

test('scanner rows retain independent model components through normalization and both archive replays', () => {
  const p = multi();
  assert.equal(session(p).modelTokenComponents.alpha.inputTokens, 30);
  assert.equal(session(p).modelTokenComponents.beta.inputTokens, 45);
  assert.deepEqual(normalizePeriod(p), p, 'normalization is idempotent');
  for (const kind of ['client', 'session']) exact(replay(kind, p));
});

test('JSON and real SQLite reopen retain multi-model evidence without schema migration or source mutation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-model-components-'));
  const options = { databasePath: path.join(dir, 'sessions.sqlite'), path: path.join(dir, 'legacy.json') };
  let store = createSessionUsageArchiveStore(options);
  try {
    const p = multi(); const before = JSON.stringify(p);
    assert.equal(store.capture(record(p), now).error, null); store.close();
    const archive = readSessionUsageArchiveSnapshot({ ...options, strict: true });
    const visible = applySessionUsageArchive(record(emptyPeriod()), archive, { now }).allTime;
    exact(visible); assert.equal(JSON.stringify(p), before);
    store = createSessionUsageArchiveStore(options);
    const lower = scan(row('alpha', { input: 10, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 }));
    store.capture(record(lower), new Date(now.getTime() + 1000));
    const restored = applySessionUsageArchive(record(emptyPeriod()), store.read(), { now }).allTime;
    assert.equal(restored.totalTokens, 10); assert.equal(restored.costUsd, 0);
    assert.equal(restored.models.beta, undefined, 'new observation replaces whole old model decomposition');
    assert.equal(restored.modelUnclassifiedTokens.alpha || 0, 0);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy multi-model sessions remain unknown; partial evidence never allocates the remainder by ratio', () => {
  const p = multi();
  for (const kind of ['client', 'session']) {
    const legacy = replay(kind, strip(p));
    assert.equal(legacy.modelUnclassifiedTokens.alpha, 100); assert.equal(legacy.modelUnclassifiedTokens.beta, 50);
    const partial = structuredClone(p); delete session(partial).modelTokenComponents.beta;
    const result = replay(kind, normalizePeriod(partial));
    assert.equal(result.modelUnclassifiedTokens.alpha || 0, 0); assert.equal(result.modelUnclassifiedTokens.beta, 50);
  }
});

test('merging an observed and legacy contribution preserves only observed components', () => {
  const observed = multi();
  const legacy = strip(scan(row('alpha')));
  const combined = mergePeriods(observed, legacy);
  assert.equal(session(combined).modelTokenComponents.alpha.totalTokens, 100);
  for (const kind of ['client', 'session']) {
    const p = replay(kind, combined);
    assert.equal(p.totalTokens, 250); assert.equal(p.modelCacheReads.alpha, 40);
    assert.equal(p.modelUnclassifiedTokens.alpha, 100);
  }
});

test('invalid persisted evidence fails closed at normalization', () => {
  const p = multi();
  for (const change of [
    map => { map.alpha.inputTokens = -1; },
    map => { map.alpha.outputTokens = 0.5; },
    map => { map.alpha.inputTokens = 999; },
    map => { map.alpha.totalTokens = 101; },
    map => { map.alpha.cacheReadTokens = 41; map.alpha.inputTokens = 29; },
    map => { map.alpha.inputTokens = '30'; },
    map => { delete map.alpha.outputTokens; }
  ]) {
    const copy = structuredClone(p); change(session(copy).modelTokenComponents);
    assert.equal(session(normalizePeriod(copy)).modelTokenComponents, undefined);
    assert.equal(replay('session', copy).modelUnclassifiedTokens.alpha, 100);
  }
});

test('watch delta preserves exact model components and rejects mixed legacy or partial anchors', () => {
  const base = multi(), anchor = multi();
  const fresh = multi();
  // One additional alpha row in Today and therefore in broader periods.
  const newer = mergePeriods(fresh, scan(row('alpha', { input: 5, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 })));
  const delta = normalizePeriod(applyPeriodDelta(base, newer, anchor));
  assert.equal(session(delta).modelTokenComponents.alpha.inputTokens, 35);
  assert.equal(replay('session', delta).modelUnclassifiedTokens.alpha || 0, 0);
  for (const index of [0, 1, 2]) {
    const args = [base, newer, anchor].map(p => structuredClone(p));
    delete session(args[index]).modelTokenComponents;
    assert.equal(session(applyPeriodDelta(...args)).modelTokenComponents, undefined);
  }
  const partial = structuredClone(anchor); delete session(partial).modelTokenComponents.beta;
  assert.equal(session(applyPeriodDelta(base, newer, partial)).modelTokenComponents, undefined);
});

test('unreported raw components remain unknown instead of becoming input', () => {
  const p = scan(row('alpha', { totalTokens: 125 }), row('beta', { totalTokens: 40, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }));
  for (const kind of ['client', 'session']) {
    const result = replay(kind, p);
    assert.equal(result.totalTokens, 165);
    assert.equal(result.modelUnclassifiedTokens.alpha, 25);
    assert.equal(result.modelUnclassifiedTokens.beta, 40);
  }
});

test('sync JSON roundtrip retains optional detail only in transmitted sessions', () => {
  const { buildSyncPayload } = require('../../src/shared/syncPayload');
  const { normalizeDeviceRecord, mergeSyncDeviceRecord } = require('../../src/shared/usage');
  const p = multi();
  const source = { deviceId: 'fixture', updatedAt: now.toISOString(), ...record(p) };
  const payload = JSON.parse(JSON.stringify(buildSyncPayload(source)));
  assert.equal(payload.allTime.sessions, undefined);
  const received = normalizeDeviceRecord(payload);
  assert.ok(session(received.periods.today).modelTokenComponents, 'transmitted evidence must survive ingest');
  assert.deepEqual(session(received.periods.today).modelTokenComponents, session(p).modelTokenComponents);
  const merged = mergeSyncDeviceRecord(source, payload);
  assert.equal(merged.periods.allTime.totalTokens, p.totalTokens);
  assert.deepEqual(session(merged.periods.today).modelTokenComponents, session(p).modelTokenComponents);
});


test('a non-append correction never publishes clamped model-component deltas', () => {
  const base = multi(), anchor = multi();
  const fresh = scan(row('alpha', { input: 0, cacheRead: 100, cacheWrite: 0, output: 0 }),
    row('beta', { input: 45, cacheRead: 0, cacheWrite: 0, output: 5, cost: 2 }));
  // Broader retained coverage smaller than the anchor makes subtraction invalid.
  const smaller = scan(row('alpha', { input: 0, cacheRead: 10, cacheWrite: 0, output: 0 }),
    row('beta', { input: 45, cacheRead: 0, cacheWrite: 0, output: 5, cost: 2 }));
  assert.equal(session(applyPeriodDelta(smaller, fresh, anchor)).modelTokenComponents, undefined);
  const untouched = applyPeriodDelta(base, emptyPeriod(), emptyPeriod());
  assert.deepEqual(session(untouched).modelTokenComponents, session(base).modelTokenComponents);
});
