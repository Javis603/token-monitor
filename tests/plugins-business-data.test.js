'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessDataService } = require('../src/electron/plugins/businessData');
const { RESOURCES } = require('../src/shared/plugins/businessData');
const { normalizePeriod, aggregateDevices } = require('../src/shared/usage');
const auth = () => ({ pluginId: 'example', active: true, revision: 1 });
const q = (resource, options = {}) => ({ version: 1, resource, ...options });

test('model and tool completeness uses normalized parent zero without fabricating unknown child costs', async t => {
  const raw = { totalTokens: 100, costUsd: 1, unpricedTokens: 0, models: { m: 100 }, modelCosts: { m: 1 }, clients: { codex: 100 }, clientCosts: { codex: 1 } };
  const normalized = normalizePeriod(raw);
  assert.equal(Object.hasOwn(normalized, 'unpricedTokens'), false);
  const aggregated = aggregateDevices([{ deviceId: 'fixture', updatedAt: '2020-01-01T00:00:00Z', today: raw, month: raw, allTime: raw }], 0, Date.parse('2020-01-01T00:00:00Z'));
  const cases = [
    ['explicit-zero', { periods: { today: raw } }, 'complete', 0],
    ['normalized', { periods: { today: normalized } }, 'complete', 0],
    ['aggregated', aggregated, 'complete', 0],
    ['unattributed-positive', { periods: { today: { ...normalized, unpricedTokens: 10 } } }, 'unknown', null],
    ['missing-child-cost', { periods: { today: { ...normalized, modelCosts: {}, clientCosts: {} } } }, 'unknown', null],
    ['missing-parent-cost', { periods: { today: { ...raw, costUsd: undefined, unpricedTokens: undefined } } }, 'unknown', null],
    ['explicit-positive-child', { periods: { today: { ...normalized, modelUnpricedTokens: { m: 5 }, clientUnpricedTokens: { codex: 5 } } } }, 'partial', 5]
  ];
  for (const [label, stats, completeness, unpricedTokens] of cases) await t.test(label, async () => {
    const service = createBusinessDataService();
    try {
      service.publish(stats);
      for (const resource of ['models', 'tools']) {
        const result = await service.query(q(resource), auth);
        assert.equal(result.availability, 'available');
        assert.equal(result.rows[0].cost.completeness, completeness);
        assert.equal(result.rows[0].cost.unpricedTokens, unpricedTokens);
        assert.equal(result.rows[0].cost.knownUsd, label === 'missing-child-cost' ? null : 1);
      }
    } finally { service.dispose(); }
  });
});

for (const resource of ['models', 'tools']) test(`${resource} completeness invalidates when parent cost becomes known`, async t => {
  const service = createBusinessDataService(); t.after(() => service.dispose());
  const period = { models: { m: 10 }, modelCosts: { m: 1 }, clients: { codex: 10 }, clientCosts: { codex: 1 } };
  service.publish({ periods: { today: period } });
  assert.equal((await service.query(q(resource), auth)).rows[0].cost.completeness, 'unknown');
  service.publish({ periods: { today: { ...period, costUsd: 1 } } });
  const fresh = await service.query(q(resource), auth);
  assert.equal(fresh.snapshotRevision, 2);
  assert.equal(fresh.rows[0].cost.completeness, 'complete');
});
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(count = 3) {
  const sessions = Object.fromEntries(Array.from({ length: count }, (_, n) => [`raw-path-${n}`, { sessionId: `private-session-${n}`, client: 'codex', title: `Session ${n}`, projectId: '/private/work/project', projectLabel: 'Project', totalTokens: n + 1, costUsd: 0, unpricedTokens: n === 0 ? 1 : 0, contextTokens: 100, contextWindow: 200, promptCache: { observedAt: '2026-10-23T00:00:00Z', ttlSeconds: 1800 }, liveActivity: { state: 'running', observedAt: '2026-10-23T00:00:00Z' }, models: { unknown: n + 1 }, secret: 'NEVER_EXPOSE', token: 'NEVER_EXPOSE' }]));
  const period = { totalTokens: 100, costUsd: 0, unpricedTokens: 10, models: { unknown: 100 }, modelCosts: { unknown: 0 }, clients: { codex: 100 }, clientCosts: { codex: 0 }, sessions, projects: { project: { label: 'Project', tokens: 100, costUsd: 0, clients: { codex: 100 }, models: { unknown: 100 } } } };
  const provider = { provider: 'codex', accountKey: 'secret-fingerprint', accountEmail: 'private@example.test', status: 'ok', windows: [{ kind: 'session', usedPercent: 25, remainingPercent: 75, authorization: 'NEVER_EXPOSE' }], token: 'NEVER_EXPOSE', balance: { amount: 3, currency: 'USD', tranches: [{ amount: 1, currency: 'USD', expiresAt: '2027-01-01' }] } };
  return { updatedAt: '2026-10-23T00:00:00Z', periods: { today: period, month: period }, devices: [{ deviceId: 'raw-device', hostname: 'workstation', periods: { today: period }, clientHealth: { clients: { codex: { overall: 'healthy', source: { state: 'detected', checkedCount: 1, detectedCount: 1 }, collection: { state: 'direct' }, data: { liveTokens: 10 } } } }, limits: { providers: [provider] } }], limits: { providers: [provider] } };
}
test('all business domains project actual normalized structures and strip credentials', async () => {
  const service = createBusinessDataService();
  service.publish(fixture(), { sourceId: 'local', history: { daily: [{ date: '2026-10-23', tokens: 4, cost: 0, unpricedTokens: 4, perModel: { unknown: { tokens: 4, cost: 0, unpricedTokens: 4 } } }], monthly: [], summary: { totalTokens: 4, totalCost: 0 } }, subscriptions: { subscriptions: [{ id: 'sub-raw', provider: 'codex', binding: { accountKey: 'secret-fingerprint' }, amountMinor: 2000, currency: 'USD', token: 'NEVER_EXPOSE', topUps: [] }] } });
  for (const resource of Object.keys(RESOURCES)) {
    const result = await service.query(q(resource), auth);
    assert.equal(result.availability, 'available', resource);
    assert.ok(result.rows.length, resource);
    assert.doesNotMatch(JSON.stringify(result), /NEVER_EXPOSE|secret-fingerprint|private-session-|raw-path-|raw-device|sub-raw/);
  }
  const sessions = await service.query(q('sessions'), auth), projects = await service.query(q('projects'), auth);
  assert.equal(sessions.rows[0].projectId, projects.rows[0].id);
  assert.equal(sessions.rows[0].promptCache.ttlSeconds, 1800);
  assert.equal(sessions.rows[0].liveActivity.state, 'running');
  const limits = await service.query(q('limits'), auth), subscriptions = await service.query(q('subscriptions'), auth);
  assert.equal(limits.rows[0].id, subscriptions.rows[0].accountId);
  assert.equal(limits.rows[0].balanceTranches[0].amount, 1);
  service.dispose();
});
test('pagination reaches every row beyond 500, sorts globally and binds cursor to authority/query/source', async () => {
  const service = createBusinessDataService(); service.publish(fixture(1201));
  const query = q('sessions', { sort: { field: 'totalTokens', direction: 'desc' }, page: { limit: 500 } });
  const first = await service.query(query, auth);
  assert.ok(first.rows.length < 500, 'byte budget also bounds page');
  assert.equal(first.rows[0].totalTokens, 1201);
  let result = first; const all = [];
  do { all.push(...result.rows); result = result.pageInfo.hasMore ? await service.query({ ...query, page: { limit: 500, cursor: result.pageInfo.nextCursor } }, auth) : null; } while (result);
  assert.equal(all.length, 1201); assert.equal(new Set(all.map(r => r.id)).size, 1201);
  const cursorQuery = { ...query, page: { limit: 500, cursor: first.pageInfo.nextCursor } };
  assert.equal((await service.query({ ...cursorQuery, sort: { field: 'id' } }, auth)).availability, 'invalidCursor');
  assert.equal((await service.query(cursorQuery, { ...auth(), pluginId: 'other' })).availability, 'invalidCursor');
  assert.equal((await service.query(cursorQuery, { ...auth(), revision: 2 })).availability, 'invalidCursor');
  service.publish(fixture(1201));
  assert.equal((await service.query(cursorQuery, auth)).availability, 'available', 'same-source refresh retains immutable traversal');
  service.publish(fixture(1201), { sourceId: 'other-backend' });
  assert.equal((await service.query(cursorQuery, auth)).availability, 'snapshotExpired');
  service.dispose();
});
test('IDs survive label, insertion order, sort and publish changes and are isolated by plugin/source', async () => {
  const service = createBusinessDataService({ identitySecret: 'test secret' }); const stats = fixture();
  service.publish(stats, { sourceId: 'one' });
  const first = await service.query(q('sessions'), auth);
  const changed = fixture(); changed.periods.today.sessions = Object.fromEntries(Object.entries(changed.periods.today.sessions).reverse());
  for (const s of Object.values(changed.periods.today.sessions)) s.title = 'Renamed';
  service.publish(changed, { sourceId: 'one' });
  const next = await service.query(q('sessions'), auth);
  assert.deepEqual(next.rows.map(r => r.id), first.rows.map(r => r.id));
  const other = await service.query(q('sessions'), { ...auth(), pluginId: 'other' });
  assert.notEqual(other.rows[0].id, first.rows[0].id);
  service.publish(changed, { sourceId: 'two' });
  assert.notEqual((await service.query(q('sessions'), auth)).rows[0].id, first.rows[0].id);
  service.dispose();
});
test('active trusted plugins query identities without grants; disabled plugins and invalid filters are rejected', async t => {
  const service = createBusinessDataService(); t.after(() => service.dispose()); service.publish(fixture());
  const result = await service.query(q('sessions', { filter: { search: 'Session' } }), auth);
  assert.equal(result.availability, 'available');
  assert.deepEqual(result.rows.map(row => row.title).sort(), ['Session 0', 'Session 1', 'Session 2']); assert.equal(result.rows[0].projectPath, '/private/work/project');
  assert.equal((await service.query(q('sessions'), { ...auth(), active: false })).availability, 'denied');
  assert.throws(() => service.subscribe('owner', q('sessions'), { ...auth(), active: false }, () => {}), /denied/);
  assert.equal((await service.query(q('sessions', { filter: { rawPath: 'anything' } }), auth)).availability, 'invalidFilter');
  assert.equal((await service.query(q('sessions', { filter: { deviceId: 'missing' } }), auth)).rows.length, 0);
});
test('unknown cost is not free and missing components are not fabricated', async () => {
  const service = createBusinessDataService(); service.publish(fixture());
  const total = (await service.query(q('usage'), auth)).rows[0];
  assert.deepEqual(total.cost, { knownUsd: 0, unpricedTokens: 10, currency: 'USD', completeness: 'partial' });
  const model = (await service.query(q('models'), auth)).rows[0];
  assert.equal(model.cost.completeness, 'unknown'); assert.equal(model.cost.unpricedTokens, null); assert.equal(model.inputTokens, null);
  const rows = (await service.query(q('sessions'), auth)).rows;
  assert.ok(rows.some(r => r.cost.completeness === 'complete' && r.cost.knownUsd === 0));
  assert.ok(rows.some(r => r.cost.completeness === 'partial'));
  service.dispose();
});
test('lazy caches deduplicate, never run at publish, and recheck authority after await', async () => {
  let calls = 0, resolve;
  const service = createBusinessDataService({ loadHistory: () => { calls++; return new Promise(r => { resolve = r; }); } });
  service.publish(fixture()); await flush(); assert.equal(calls, 0);
  let active = true; const getAuth = () => ({ ...auth(), active });
  const one = service.query(q('history'), getAuth), two = service.query(q('history'), getAuth);
  await flush(); assert.equal(calls, 1); active = false;
  resolve({ daily: [] });
  assert.equal((await one).availability, 'denied'); assert.equal((await two).availability, 'denied');
  service.dispose();
});
test('late source loader cannot overwrite next publication', async () => {
  let resolve;
  const service = createBusinessDataService({ loadAllTime: () => new Promise(r => { resolve = r; }) });
  service.publish(fixture(), { sourceId: 'old' });
  const pending = service.query(q('usage', { period: 'allTime' }), auth); await flush();
  service.publish(fixture(), { sourceId: 'new', allTime: { totalTokens: 22, costUsd: 0 } });
  resolve({ totalTokens: 999, costUsd: 0 });
  assert.equal((await pending).availability, 'snapshotExpired');
  assert.equal((await service.query(q('usage', { period: 'allTime' }), auth)).rows[0].totalTokens, 22);
  service.dispose();
});
test('subscription registration precedes initial event; owner release/revoke cancel pending delivery', async () => {
  const service = createBusinessDataService(); service.publish(fixture()); const a = [], b = [];
  const id = service.subscribe('window-a', q('usage'), auth, v => a.push(v), 'client-a');
  service.subscribe('window-b', q('usage'), auth, v => b.push(v), 'client-b');
  assert.equal(id, 'client-a'); assert.equal(a.length, 0);
  service.releaseOwner('window-a'); await flush();
  assert.equal(a.length, 0); assert.equal(b[0].type, 'snapshot'); assert.equal(b[0].value.availability, 'available'); assert.equal(b[0].value.rows[0].totalTokens, 100);
  assert.equal(service.unsubscribe('wrong-owner', 'client-b'), false);
  const changed = fixture(); changed.periods.today.totalTokens += 1;
  service.publish(changed); service.publish(fixture());
  await new Promise(r => setTimeout(r, 130));
  assert.equal(b.length, 2); assert.equal(b[1].type, 'invalidate'); assert.equal(b[1].snapshotRevision, 3);
  service.publish(fixture()); service.revoke('example');
  await new Promise(r => setTimeout(r, 130)); assert.equal(b.length, 2);
  service.dispose();
});
test('expired cursors and oversized individual rows fail explicitly; responses are detached', async () => {
  let now = 1000; const service = createBusinessDataService({ now: () => now, snapshotTtlMs: 20 });
  service.publish(fixture(100)); const first = await service.query(q('sessions', { page: { limit: 1 } }), auth);
  first.rows[0].cost.knownUsd = 999;
  assert.notEqual((await service.query(q('sessions', { page: { limit: 1 } }), auth)).rows[0].cost.knownUsd, 999);
  now += 21;
  assert.equal((await service.query(q('sessions', { page: { limit: 1, cursor: first.pageInfo.nextCursor } }), auth)).availability, 'snapshotExpired');
  const big = fixture(1); big.periods.today.sessions['raw-path-0'].models = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`model-${i}`, 1]));
  service.publish(big);
  assert.equal((await service.query(q('sessions'), auth)).availability, 'payloadTooLarge');
  service.dispose();
});
test('allTime detail cache overrides an existing summary and relation filters inspect DTOs', async () => {
  let calls = 0;
  const detailed = fixture().periods.today;
  const service = createBusinessDataService({ loadAllTime: () => { calls++; return detailed; } });
  const stats = fixture(); stats.periods.allTime = { totalTokens: 100, costUsd: 0, sessions: {} };
  service.publish(stats);
  const sessions = await service.query(q('sessions', { period: 'allTime', filter: { model: 'unknown' } }), auth);
  assert.equal(sessions.rows.length, 3); assert.equal(calls, 1);
  await service.query(q('usage', { period: 'allTime' }), auth); assert.equal(calls, 1);
  assert.equal((await service.query(q('usage', { filter: { client: 'codex' } }), auth)).availability, 'invalidFilter');
  service.dispose();
});
test('payload stays below transport budget and scope/loader failures are explicit', async () => {
  let calls = 0;
  const service = createBusinessDataService({ loadHistory: () => { calls++; throw new Error('credential-bearing-private-error'); } });
  service.publish(fixture(700));
  const result = await service.query(q('sessions', { page: { limit: 500 } }), auth);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 56 * 1024);
  assert.equal((await service.query(q('history', { filter: { deviceId: 'missing' } }), auth)).availability, 'scopeUnavailable');
  assert.equal(calls, 0);
  const failed = await service.query(q('history'), auth);
  assert.equal(failed.availability, 'temporarilyUnavailable');
  assert.doesNotMatch(JSON.stringify(failed), /credential-bearing/);
  service.dispose();
});
test('closing the only owner before initial delivery does not start its lazy cache loader', async () => {
  let calls = 0;
  const service = createBusinessDataService({ loadHistory: () => { calls++; return { daily: [] }; } });
  service.publish(fixture());
  service.subscribe('closing', q('history'), auth, () => assert.fail('closed owner delivered'));
  service.releaseOwner('closing'); await flush();
  assert.equal(calls, 0); service.dispose();
});
