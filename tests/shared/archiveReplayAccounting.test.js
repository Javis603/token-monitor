'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyPeriod, extractUsageFromTokscale, normalizePeriod } = require('../../src/shared/usage');
const { captureArchivedClientUsage, applyArchivedClientUsage } = require('../../src/shared/usage/clientUsageArchive');
const { captureSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const now = new Date('2026-10-29T12:00:00Z');
const periods = ['today', 'month', 'allTime'];
const sample = (extra = {}) => ({ client: 'claude', sessionId: 'a', model: 'shared', input: 30, cacheRead: 40, cacheWrite: 10, output: 20, cost: 1, ...extra });
const record = (...rows) => {
  const p = () => extractUsageFromTokscale({ entries: rows });
  return { deviceId: 'fixture', updatedAt: now.toISOString(), today: p(), month: p(), allTime: p() };
};
const empty = () => ({ today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() });
function project(kind, source, target = empty()) {
  if (kind === 'client') return applyArchivedClientUsage(target, captureArchivedClientUsage(null, source, ['claude'], now), { now, activeClients: [] });
  return applySessionUsageArchive(target, captureSessionUsageArchive(null, source, now), { now });
}
for (const kind of ['client', 'session']) {
  test(`${kind} archive round trip retains known input at client and single-model level`, () => {
    const source = record(sample()), before = JSON.stringify(source), result = project(kind, source);
    assert.equal(JSON.stringify(source), before);
    for (const name of periods) {
      const p = result[name];
      assert.equal(p.totalTokens, 100); assert.equal(p.costUsd, 1);
      assert.equal(p.clientUnclassifiedTokens.claude || 0, 0);
      assert.equal(p.modelUnclassifiedTokens.shared || 0, 0);
      assert.equal(p.unclassifiedTokens, 0);
      assert.equal(p.cacheReadTokens, 40); assert.equal(p.cacheWriteTokens, 10); assert.equal(p.outputTokens, 20);
      assert.equal(100 - p.cacheReadTokens - p.outputTokens - p.unclassifiedTokens, 40, 'uncached includes 30 input plus 10 cache writes');
      assert.equal(p.sessions['claude:a'].inputTokens, 30);
    }
  });
  test(`${kind} archive preserves a genuine unclassified remainder and bounds an inflated input`, () => {
    const source = record(sample());
    for (const name of periods) {
      source[name].totalTokens = 120; source[name].clients.claude = 120; source[name].models.shared = 120;
      source[name].clientModels.claude.shared = 120;
      source[name].sessions['claude:a'].totalTokens = 120; source[name].sessions['claude:a'].models.shared = 120;
    }
    for (const name of periods) assert.equal(project(kind, source)[name].clientUnclassifiedTokens.claude, 20);
    for (const name of periods) source[name].sessions['claude:a'].inputTokens = 10000;
    for (const name of periods) {
      const p = project(kind, source)[name];
      assert.equal(p.clientUnclassifiedTokens.claude || 0, 0); assert.equal(p.totalTokens, 120);
      assert.equal(p.outputTokens, 20); assert.equal(p.cacheReadTokens, 40);
    }
  });
  test(`${kind} archive can classify client input in multi-model sessions without guessing model input`, () => {
    const source = record(sample());
    for (const name of periods) Object.assign(source[name], {
      models: { first: 50, second: 50 }, clientModels: { claude: { first: 50, second: 50 } },
      sessions: { 'claude:a': { ...source[name].sessions['claude:a'], models: { first: 50, second: 50 } } }
    });
    const p = project(kind, source).allTime;
    assert.equal(p.clientUnclassifiedTokens.claude || 0, 0);
    assert.equal(p.modelUnclassifiedTokens.first, 50); assert.equal(p.modelUnclassifiedTokens.second, 50);
    assert.equal(p.modelCacheReads.first || 0, 0);
  });
  test(`${kind} archive never invents missing input in a legacy session`, () => {
    const source = record(sample());
    for (const name of periods) delete source[name].sessions['claude:a'].inputTokens;
    const p = project(kind, source).allTime;
    assert.equal(p.clientUnclassifiedTokens.claude, 30); assert.equal(p.totalTokens, 100);
  });
}
test('client replay replaces matched historical sessions with lower native observations and retains unmatched usage', () => {
  const source = record(sample(), sample({ sessionId: 'b', input: 50, cacheRead: 0, cacheWrite: 0, output: 0, cost: 2 }));
  const native = record(sample({ input: 10, cacheRead: 0, cacheWrite: 0, output: 10, cost: 0.25 }));
  const archive = captureArchivedClientUsage(null, source, ['claude'], now);
  const result = applyArchivedClientUsage(native, archive, { now, activeClients: [] });
  for (const name of periods) {
    assert.equal(result[name].totalTokens, 70); assert.equal(result[name].costUsd, 2.25);
    assert.equal(result[name].sessions['claude:a'].totalTokens, 20);
    assert.equal(result[name].sessions['claude:b'].totalTokens, 50);
    assert.equal(result[name].clientUnclassifiedTokens.claude || 0, 0);
  }
});
test('zero-valued archived identity never overwrites a newer native session while unmatched usage remains', () => {
  const source = record(sample({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 }),
    sample({ sessionId: 'b', input: 50, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 }));
  const native = record(sample({ input: 10, cacheRead: 0, cacheWrite: 0, output: 10, cost: 0 }));
  // Scanner extraction omits zero-only rows; persisted normalized archives can
  // still contain this identity alongside another session with usage.
  for (const name of periods) {
    source[name].sessions['claude:a'] = normalizePeriod({ sessions: {
      'claude:a': { client: 'claude', sessionId: 'a', totalTokens: 0, costUsd: 0 }
    } }).sessions['claude:a'];
  }
  const result = project('client', source, native);
  for (const name of periods) {
    const p = result[name];
    assert.equal(p.totalTokens, 70);
    assert.equal(p.costUsd, 0);
    assert.equal(p.sessions['claude:a'].totalTokens, 20);
    assert.equal(p.sessions['claude:a'].inputTokens, 10);
    assert.equal(p.sessions['claude:a'].outputTokens, 10);
    assert.equal(p.sessions['claude:b'].totalTokens, 50);
    assert.equal(Object.values(p.sessions).reduce((sum, session) => sum + session.totalTokens, 0), p.totalTokens);
  }
});
test('equal aggregate totals with disjoint session identities are not deduplicated', () => {
  const source = record(sample({ sessionId: 'old' })), native = record(sample({ sessionId: 'different' }));
  const p = project('client', source, native).allTime;
  assert.equal(p.totalTokens, 200); assert.equal(p.costUsd, 2); assert.equal(Object.keys(p.sessions).length, 2);
});
test('aggregate-only client snapshots are not silently matched to unrelated retained sessions by amount', () => {
  const source = record(sample());
  for (const name of periods) source[name].sessions = {};
  const archive = captureArchivedClientUsage(null, source, ['claude'], now);
  const retained = captureSessionUsageArchive(null, record(sample({ sessionId: 'unknown-origin' })), now);
  const transform = createUsageTransform({ getSettings: () => ({ clients: '', projectsEnabled: false, archivedClientUsage: archive }) });
  const p = transform.project(empty(), retained, now).allTime;
  assert.equal(p.totalTokens, 200, 'no identity evidence: neither snapshot may be discarded');
  assert.equal(p.costUsd, 2); assert.equal(p.clientUnclassifiedTokens.claude, 100);
});
test('production transform counts identified client/session archive overlap once, including aliases and explicit native zeros', () => {
  const source = record(sample());
  const clients = captureArchivedClientUsage(null, source, ['claude'], now);
  const sessions = captureSessionUsageArchive(null, source, now);
  const transform = createUsageTransform({ getSettings: () => ({ clients: '', projectsEnabled: false, archivedClientUsage: clients }) });
  assert.equal(transform.project(empty(), sessions, now).allTime.totalTokens, 100);
  const zero = normalizePeriod({ sessions: { a: { client: 'claude-code', sessionId: 'a', totalTokens: 0, costUsd: 0 } } });
  const native = { today: zero, month: zero, allTime: zero };
  const result = transform.project(native, sessions, now);
  for (const name of periods) assert.equal(result[name].totalTokens, 0);
});

test('client replay is repeatable with identified snapshots and never matches another client by bare session ID', () => {
  const source = record(sample()), first = project('client', source);
  const again = project('client', source, first);
  assert.equal(again.allTime.totalTokens, 100); assert.equal(again.allTime.costUsd, 1);
  const other = record(sample({ client: 'codex' }));
  const both = project('client', source, other).allTime;
  assert.equal(both.totalTokens, 200); assert.equal(both.clients.codex, 100); assert.equal(both.clients.claude, 100);
});
test('client snapshot retains identity-free residue when a matched session is corrected to free pricing', () => {
  const source = record(sample());
  for (const name of periods) {
    source[name].totalTokens += 30; source[name].clients.claude += 30;
    source[name].models.shared += 30; source[name].clientModels.claude.shared += 30;
    source[name].costUsd += 2; source[name].clientCosts.claude += 2;
    source[name].modelCosts.shared += 2; source[name].clientModelCosts.claude.shared += 2;
  }
  const corrected = record(sample({ input: 20, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 }));
  const p = project('client', source, corrected).allTime;
  assert.equal(p.totalTokens, 50); assert.equal(p.costUsd, 2);
  assert.equal(p.modelCosts.shared, 2); assert.equal(p.clientCosts.claude, 2);
  assert.equal(p.sessions['claude:a'].totalTokens, 20);
  assert.equal(p.clientUnclassifiedTokens.claude, 30, 'missing identity-free residue is not silently removed');
});
test('real SQLite capture/reopen and production transform restore known input without changing saved observations', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createSessionUsageArchiveStore, readSessionUsageArchiveSnapshot } = require('../../src/shared/usage/sessionUsageArchiveStore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-replay-accounting-'));
  const options = { databasePath: path.join(dir, 'sessions.sqlite'), path: path.join(dir, 'legacy.json') };
  let store = createSessionUsageArchiveStore(options);
  try {
    const source = record(sample());
    const saved = store.capture(source, now); assert.equal(saved.error, null);
    store.close();
    const snapshot = readSessionUsageArchiveSnapshot({ ...options, strict: true });
    assert.equal(snapshot.sessions['claude:a'].periods.allTime.inputTokens, 30);
    const before = JSON.stringify(snapshot);
    const transform = createUsageTransform({ getSettings: () => ({ clients: 'claude', projectsEnabled: false }) });
    const restored = transform.project(empty(), snapshot, now);
    assert.equal(restored.allTime.totalTokens, 100); assert.equal(restored.allTime.costUsd, 1);
    assert.equal(restored.allTime.unclassifiedTokens, 0);
    assert.equal(JSON.stringify(snapshot), before);
    store = createSessionUsageArchiveStore(options);
    const corrected = record(sample({ input: 10, cacheRead: 0, cacheWrite: 0, output: 10, cost: 0 }));
    store.capture(corrected, new Date(now.getTime() + 1000));
    const fresh = transform.project(corrected, store.read(), now);
    assert.equal(fresh.allTime.totalTokens, 20); assert.equal(fresh.allTime.costUsd, 0);
    assert.equal(Object.keys(fresh.allTime.sessions).length, 1);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
