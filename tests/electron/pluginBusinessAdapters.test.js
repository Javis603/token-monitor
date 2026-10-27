'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createBusinessDataService } = require('../../src/electron/plugins/businessData');
const { buildSyncPayload } = require('../../src/shared/syncPayload');
const { aggregateDevices } = require('../../src/shared/usage');
const { mergedLocalAllTimeSessions } = require('../../src/shared/localSessions');
const { materializeActivity } = require('../../src/shared/sessionActivityProjection');
const { completeLocalSyncStats, composeLocalSyncSummary, composeLocalOnlySummary } = require('../../src/electron/syncDisplayStats');
const main = fs.readFileSync(process.env.BUSINESS_MAIN_SOURCE || path.join(__dirname, '../../src/electron/main.js'), 'utf8');
function functionSource(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return `${name === 'saveSubscriptions' ? 'async ' : ''}${main.slice(start, main.indexOf('\n}', start) + 2)}`;
}
const auth = { active: true, pluginId: 'probe' };
const deviceRef = id => `device_${require('node:crypto').createHmac('sha256', 'adapter-test').update(JSON.stringify(['probe', 'default', '1', 'device', id])).digest('base64url')}`;
const query = { version: 1, resource: 'sessions', period: 'allTime' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function device(deviceId) {
  const session = totalTokens => ({ sessionId: 's', client: 'codex', totalTokens, costUsd: 0 });
  return { deviceId, updatedAt: new Date().toISOString(), today: { totalTokens: 10, sessions: { s: session(10) } }, month: { totalTokens: 20, sessions: { s: session(20) } }, allTime: { totalTokens: 300, sessions: { s: session(100), old: { ...session(200), sessionId: 'old' } } } };
}
function sessionService(stats, captured) {
  const snapshotLocalDevices = new WeakMap();
  if (captured) snapshotLocalDevices.set(stats, captured);
  const start = main.indexOf('loadAllTime: ({ stats }) => {', main.indexOf('        businessAdapters:'));
  const end = main.indexOf('\n          },', start);
  const loadAllTime = vm.runInNewContext(`({ ${main.slice(start, end)}\n} }).loadAllTime`, { completeLocalSyncStats, snapshotLocalDevices, mergedLocalAllTimeSessions, materializeActivity });
  const service = createBusinessDataService({ loadAllTime, identitySecret: 'adapter-test' });
  service.publish(stats);
  return service;
}
test('App all-time adapter never promotes remote Month detail; scopes and mixed coverage follow provenance', async () => {
  const remote = aggregateDevices([buildSyncPayload(device('remote'))], 0);
  const local = device('local');
  for (const kind of ['remote', 'mixed', 'local']) {
    const stats = kind === 'remote' ? remote : kind === 'mixed' ? composeLocalSyncSummary(remote, local) : composeLocalOnlySummary(local, s => s);
    const service = sessionService(stats, kind === 'local' ? null : { localDevice: kind === 'mixed' ? local : null });
    try {
      const result = await service.query(query, auth);
      assert.equal(result.aggregateCoverage.kind, kind === 'remote' ? 'unavailable' : kind === 'mixed' ? 'partial' : 'authorizedCollection');
      assert.deepEqual(result.rows.map(r => r.totalTokens).sort((a, b) => a - b), kind === 'remote' ? [] : [100, 200]);
      if (kind !== 'remote') {
        const today = await service.query({ ...query, period: 'today' }, auth);
        assert.ok(today.rows.some(row => row.id === result.rows.find(row => row.totalTokens === 100).id), 'aggregate session identity is stable across periods');
      }
      const devices = await service.query({ version: 1, resource: 'devices' }, auth);
      for (const d of devices.rows) {
        const filtered = await service.query({ ...query, filter: { deviceId: d.id } }, auth);
        const isLocal = filtered.rows.length > 0;
        assert.equal(filtered.aggregateCoverage.kind, isLocal ? 'authorizedCollection' : 'unavailable');
      }
      const restricted = await service.query({ ...query, filter: { deviceId: deviceRef('remote') } }, auth);
      assert.equal(restricted.aggregateCoverage.kind, 'unavailable');
      assert.equal(restricted.rows.length, 0);
      const localOnly = await service.query({ ...query, filter: { deviceId: deviceRef('local') } }, auth);
      assert.equal(localOnly.aggregateCoverage.kind, kind === 'remote' ? 'unavailable' : 'authorizedCollection');
      if (kind !== 'remote') assert.deepEqual(localOnly.rows.map(r => r.totalTokens).sort((a, b) => a - b), [100, 200]);
    } finally { service.dispose(); }
  }
});
function subscriptionContext() {
  const context = { settings: { hubMode: 'client', subscriptions: [], subscriptionsCacheHub: 'fixture' }, hubSubscriptions: { updatedAt: 'one', subscriptions: [{ id: 'sub', provider: 'codex', amountMinor: 100 }] }, hubSubscriptionsHub: 'fixture', currentHubIdentity: () => context.settings.hubMode === 'local' ? '' : 'fixture', persistSubscriptionState: () => true, saveSettings: () => true, settingsForRenderer: () => ({}), subscriptionDisplay: { normalizeSubscriptions: list => list }, normalizeCurrency: x => x, hubChangedError: () => new Error('hub changed') };
  vm.createContext(context);
  vm.runInContext(['subscriptionsAreShared', 'subscriptionsDocumentFor', 'effectiveSubscriptions', 'cacheSharedSubscriptions', 'saveSubscriptions'].map(functionSource).join('\n'), context);
  return context;
}
for (const mode of ['remote', 'local']) test(`canonical ${mode} subscription commit republishes without stats and delivers invalidation`, async () => {
  const context = subscriptionContext();
  if (mode === 'local') { context.settings.hubMode = 'local'; context.settings.subscriptions = context.hubSubscriptions.subscriptions; }
  const service = createBusinessDataService();
  const stats = { updatedAt: new Date().toISOString() };
  let publishes = 0;
  context.pluginRuntime = { refreshBusinessData() { publishes++; service.publish(stats, { subscriptions: context.effectiveSubscriptions() }); } };
  context.pluginRuntime.refreshBusinessData();
  const q = { version: 1, resource: 'subscriptions' }, events = [];
  service.subscribe('owner', q, () => auth, event => events.push(event));
  await flush();
  const before = await service.query(q, auth);
  const next = [{ id: 'sub', provider: 'codex', amountMinor: 900 }];
  try {
    if (mode === 'remote') context.cacheSharedSubscriptions({ updatedAt: 'two', subscriptions: next }, 'fixture');
    else await context.saveSubscriptions(next, { hub: '' });
    const after = await service.query(q, auth);
    assert.equal(after.rows[0].amountMinor, 900);
    assert.equal(before.rows[0].amountMinor, 100, 'prior DTO remains immutable');
    assert.equal(after.snapshotRevision, before.snapshotRevision + 1);
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'invalidate');
    if (mode === 'remote') {
      context.cacheSharedSubscriptions({ updatedAt: 'three', subscriptions: [] }, 'other');
      assert.equal(publishes, 2, 'off-source commits cannot republish selected data');
    } else {
      context.saveSettings = () => false;
      await assert.rejects(context.saveSubscriptions([], { hub: '' }), { code: 'write_failed' });
      assert.equal(publishes, 2, 'failed local persistence cannot publish');
    }
  } finally { service.dispose(); }
});


test('App all-time adapter reports absent accounting as unavailable, not an empty lifetime', async () => {
  const stats = { periods: { today: { totalTokens: 12 } }, devices: [] };
  const service = sessionService(stats);
  try {
    for (const resource of ['usage', 'models', 'tools', 'sessions', 'projects']) {
      const result = await service.query({ version: 1, resource, period: 'allTime' }, {
        active: true, pluginId: 'probe'
      });
      assert.equal(result.availability, 'notCollected', resource);
      assert.equal(result.aggregateCoverage.kind, 'unavailable', resource);
      assert.deepEqual(result.rows, [], resource);
    }
  } finally { service.dispose(); }
});

test('business identities never override hidden session titles in any period or device scope', async () => {
  const period = { totalTokens: 1, sessions: { s: { sessionId: 's', client: 'codex', totalTokens: 1, title: 'PRIVATE TITLE', projectId: '/project', projectLabel: 'project' } } };
  const stats = { periods: { today: period, month: period, allTime: period }, devices: [{ deviceId: 'd', periods: { today: period, month: period, allTime: period } }] };
  const service = createBusinessDataService({ loadAllTime: async () => period });
  try {
    for (const enabled of [true, false]) {
      service.publish(stats, { preferences: { sessionTitlesEnabled: enabled } });
      for (const period of ['today', 'month', 'allTime']) for (const deviceFiltered of [false, true]) {
        const devices = await service.query({ version: 1, resource: 'devices' }, auth);
        const filter = deviceFiltered ? { deviceId: devices.rows[0].id } : {};
        const result = await service.query({ version: 1, resource: 'sessions', period, filter }, auth);
        assert.equal(result.rows[0].title, enabled ? 'PRIVATE TITLE' : null);
        assert.equal(result.rows[0].projectPath, '/project', 'project path remains available');
        if (!enabled) assert.doesNotMatch(JSON.stringify(result), /PRIVATE TITLE/);
      }
    }
  } finally { service.dispose(); }
});

test('App business context captures host calendar/rates and rate changes republish without a probe', () => {
  const currency = require('../../src/shared/currency');
  let publishes = 0;
  const context = { settings: { currencyRates: { HKD: 8 } }, rateCache: null, effectiveRates: null,
    CURRENCY_CODES: currency.CURRENCY_CODES, resolveEffectiveRates: currency.resolveEffectiveRates,
    configureRates: () => {}, pluginRuntime: { refreshBusinessData() { publishes++; } },
    subscriptionDisplay: { todayString: () => '2026-10-23' }, effectiveSubscriptions: () => [],
    statsHistoryRevision: stats => stats.historyRevision, trayMenuLocale: () => 'en', Intl };
  vm.createContext(context);
  vm.runInContext(functionSource('applyEffectiveRates'), context);
  const start = main.indexOf('extras: stats =>', main.indexOf('        businessAdapters:'));
  const end = main.indexOf('\n          loadAllTime:', start);
  const extras = vm.runInContext(`({ ${main.slice(start, end)} }).extras`, context);
  context.applyEffectiveRates();
  assert.equal(publishes, 1);
  const first = extras({ historyRevision: 'h1' });
  assert.equal(first.subscriptionContext.date, '2026-10-23');
  assert.equal(first.subscriptionContext.rates.HKD, 8);
  assert.notEqual(first.subscriptionContext.rates, context.effectiveRates);
  context.applyEffectiveRates(); assert.equal(publishes, 1, 'unchanged rates do not create invalidation work');
  context.settings.currencyRates.HKD = 10;
  context.applyEffectiveRates(); assert.equal(publishes, 2, 'host rate update republishes existing data only');
  assert.equal(first.subscriptionContext.rates.HKD, 8, 'prior captured conversion remains immutable');
  assert.equal(extras({}).subscriptionContext.rates.HKD, 10);
});
