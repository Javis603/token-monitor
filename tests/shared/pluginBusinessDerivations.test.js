'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { projectResource, normalizeQuery } = require('../../src/shared/plugins/businessData');
const { createBusinessDataService } = require('../../src/electron/plugins/businessData');
const subscriptions = require('../../src/shared/subscriptionDisplay');
const balance = require('../../src/shared/limits/balanceDisplay');
const currency = require('../../src/shared/currency');

const date = '2026-03-15';
const context = { date, rates: { USD: 1, HKD: 7.8, CNY: 7, TWD: 32 } };
const authority = (overrides = {}) => ({ active: true, pluginId: 'derivations', ...overrides });
const opaque = (kind, key) => `${kind}_${createHmac('sha256', 'fixture-secret').update(key).digest('hex')}`;
const q = (resource, options = {}) => normalizeQuery({ version: 1, resource, ...options });
function subscription(overrides = {}) {
  return subscriptions.normalizeSubscription({ id: 'private-subscription', provider: 'openrouter', kind: 'subscription',
    currency: 'USD', amountMinor: 2000, interval: 'month', intervalCount: 1,
    startDate: '2026-01-31', updatedAt: '2026-03-15T00:00:00Z',
    binding: { accountKey: 'private-account', accountEmail: 'private@example.test' }, ...overrides });
}
function topup(overrides = {}) {
  return subscription({ kind: 'topup', amountMinor: 0, topUps: [
    { id: 'private-topup-1', date: '2026-03-01', amountMinor: 10000 },
    { id: 'private-topup-2', date: '2026-02-01', amountMinor: 5000 }
  ], ...overrides });
}
function provider(overrides = {}) {
  return { provider: 'openrouter', accountKey: 'private-account', accountEmail: 'private@example.test',
    status: 'ok', updatedAt: '2026-03-14T23:00:00Z', stale: false,
    windows: [{ metric: 'credits', remaining: 30, currency: 'USD' }], ...overrides };
}
function row(record = subscription(), options = {}) {
  const stats = options.stats ?? { limits: { providers: options.providers ?? [provider()] } };
  const extras = { subscriptions: [record], subscriptionContext: context, ...options.extras };
  return projectResource(stats, extras, q('subscriptions'), options.auth ?? authority(), opaque).rows[0];
}
function sessionsFixture() {
  const sessions = {
    main: { client: 'codex', sessionId: 'private-main', title: 'PRIVATE_TITLE', totalTokens: 10 },
    child: { client: 'claude', sessionId: 'private-child', parentSessionId: 'private-main', parentClient: 'codex', sessionKind: 'background-review', title: 'PRIVATE_CHILD', transcript: 'PRIVATE_TRANSCRIPT', totalTokens: 5 },
    same: { client: 'codex', sessionId: 'private-same', parentSessionId: 'private-main', totalTokens: 2 }
  };
  const period = { totalTokens: 17, sessions };
  return { periods: { today: period, month: period }, devices: [{ deviceId: 'private-device', periods: { today: period, month: period, allTime: period }, sessionDetailAvailable: true }] };
}
function sessionRows(stats, extras = {}, options = {}, auth = authority()) {
  return projectResource(stats, extras, q('sessions', options), auth, opaque).rows;
}

test('session relations join existing row IDs across clients without synthesizing usage', () => {
  const rows = sessionRows(sessionsFixture());
  assert.equal(rows.length, 3);
  assert.equal(rows[1].parentId, rows[0].id);
  assert.equal(rows[1].parentClient, 'codex');
  assert.equal(rows[1].sessionKind, 'background-review');
  assert.equal(rows[2].parentId, rows[0].id);
  assert.equal(rows[2].parentClient, 'codex');
  assert.equal(rows.reduce((sum, r) => sum + r.totalTokens, 0), 17);
  assert.deepEqual([rows[0].parentId, rows[0].parentClient], [null, null]);
  assert.doesNotMatch(JSON.stringify(rows), /private-main|private-child|private-same|PRIVATE_TRANSCRIPT/);
});

test('invalid and self links are null; dangling and cross-client same-ID parents stay opaque', () => {
  for (const parentSessionId of [null, '', 3, {}, ' ', ' invalid ', 'bad\nvalue', 'private-main']) {
    const stats = sessionsFixture();
    stats.periods.today.sessions.main.parentSessionId = parentSessionId;
    assert.deepEqual([sessionRows(stats)[0].parentId, sessionRows(stats)[0].parentClient], [null, null]);
  }
  for (const parentClient of ['', 4, {}, ' bad ']) {
    const stats = sessionsFixture();
    Object.assign(stats.periods.today.sessions.main, { parentSessionId: 'unseen', parentClient });
    assert.equal(sessionRows(stats)[0].parentId, null);
  }
  const stats = sessionsFixture();
  Object.assign(stats.periods.today.sessions.main, { parentSessionId: 'private-main', parentClient: 'claude' });
  assert.equal(sessionRows(stats)[0].parentId, opaque('session', 'aggregate:claude:private-main'));
  stats.periods.today.sessions.main.parentSessionId = 'private-absent';
  const rows = sessionRows(stats);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].parentId, opaque('session', 'aggregate:claude:private-absent'));
});

test('long host session identifiers are hashed in full for both ends of a relation', () => {
  const stats = sessionsFixture(), parent = 'private-long-'.repeat(100);
  stats.periods.today.sessions.main.sessionId = parent;
  stats.periods.today.sessions.child.parentSessionId = parent;
  const rows = sessionRows(stats);
  assert.equal(rows[1].parentId, rows[0].id);
  assert.doesNotMatch(JSON.stringify(rows), /private-long-/);
});

test('parent IDs agree for aggregate/device/allTime provenance and keep titles hidden by host preference', () => {
  const stats = sessionsFixture(), extras = { allTime: { sessionSources: stats.devices }, preferences: { sessionTitlesEnabled: false } };
  const aggregate = sessionRows(stats, extras);
  const lifetime = sessionRows(stats, extras, { period: 'allTime' });
  const month = sessionRows(stats, extras, { period: 'month' });
  assert.deepEqual(lifetime.map(r => [r.id, r.parentId]), aggregate.map(r => [r.id, r.parentId]));
  assert.deepEqual(month.map(r => [r.id, r.parentId]), aggregate.map(r => [r.id, r.parentId]));
  const filter = { deviceId: opaque('device', 'private-device') };
  const device = sessionRows(stats, extras, { filter });
  const deviceLifetime = sessionRows(stats, extras, { period: 'allTime', filter });
  assert.deepEqual(deviceLifetime.map(r => [r.id, r.parentId]), device.map(r => [r.id, r.parentId]));
  assert.equal(device[1].parentId, device[0].id);
  assert.notEqual(device[0].id, aggregate[0].id);
  assert.equal(device[1].deviceId, opaque('device', 'private-device'));
  assert.doesNotMatch(JSON.stringify([...aggregate, ...device]), /PRIVATE_TITLE|PRIVATE_CHILD|private-device/);
});

test('real service isolates parent HMAC namespace by plugin and source', async () => {
  const service = createBusinessDataService({ identitySecret: 'fixture-secret' });
  try {
    service.publish(sessionsFixture(), { sourceId: 'source-a' });
    const first = (await service.query(q('sessions'), authority())).rows;
    const sibling = (await service.query(q('sessions'), authority({ pluginId: 'another' }))).rows;
    const child = rows => rows.find(r => r.client === 'claude');
    assert.ok(first.some(r => r.id === child(first).parentId));
    assert.ok(sibling.some(r => r.id === child(sibling).parentId));
    assert.notEqual(child(first).parentId, child(sibling).parentId);
    service.publish(sessionsFixture(), { sourceId: 'source-b' });
    const changed = (await service.query(q('sessions'), authority())).rows;
    assert.notEqual(child(first).parentId, child(changed).parentId);
    assert.ok(changed.some(r => r.id === child(changed).parentId));
  } finally { service.dispose(); }
});

const calendarCases = [
  ['month end', {}, '2026-02-28'],
  ['restored anchor', {}, '2026-03-01'],
  ['renewal day', {}, '2026-03-31'],
  ['cancelled', { autoRenew: false }, '2026-03-01'],
  ['end boundary', { endDate: '2026-03-31' }, '2026-03-31'],
  ['future start', { startDate: '2027-01-31' }, date],
  ['override', { nextRenewalOverride: '2026-04-02' }, date],
  ['expired override', { nextRenewalOverride: '2026-02-02' }, date],
  ['leap yearly', { startDate: '2024-02-29', interval: 'year' }, '2026-02-28']
];
for (const [name, overrides, asOfDate] of calendarCases) test(`subscription calendar follows shared derivations: ${name}`, () => {
  const record = subscription(overrides), derived = row(record, { extras: { subscriptionContext: { ...context, date: asOfDate } } }).derived;
  assert.equal(derived.status, 'available');
  assert.equal(derived.reason, null);
  assert.equal(derived.asOfDate, asOfDate);
  assert.equal(derived.active, subscriptions.activeSubscriptions([record], asOfDate).length > 0);
  assert.equal(derived.nextRenewalDate, subscriptions.nextRenewalDate(record, asOfDate) || null);
  assert.equal(derived.coverageEndDate, subscriptions.coverageEndDate(record, asOfDate) || null);
  assert.equal(derived.daysUntilRenewal, subscriptions.daysUntilRenewal(record, asOfDate));
  assert.equal(derived.paidToDateMinor, subscriptions.paidToDateMinor(record, asOfDate));
  assert.equal(derived.monthlyAmountUsd, subscriptions.monthlyAmountUsd(record, currency, asOfDate));
  assert.equal(derived.forecast.status, 'notApplicable');
});

test('month-end and stop boundary retain specific shared accounting meanings', () => {
  const march = row(subscription()).derived;
  assert.equal(march.nextRenewalDate, '2026-03-31');
  assert.equal(march.paidToDateMinor, 4000);
  const stopped = row(subscription({ endDate: '2026-02-28' })).derived;
  assert.equal(stopped.active, false);
  assert.equal(stopped.paidToDateMinor, 2000);
  assert.equal(stopped.monthlyAmountUsd, 20, 'per-record amount is not active-only total');
  assert.equal(stopped.nextRenewalDate, '2026-03-31', 'shared next renewal does not consult endDate');
  assert.equal(stopped.coverageEndDate, '2026-02-28');
  assert.equal(stopped.daysUntilRenewal, -15);
});

test('top-up ledger and captured currency match shared accounting and forecast functions', () => {
  currency.configureRates(context.rates);
  try {
    const record = topup({ currency: 'HKD' }), account = provider();
    const derived = row(record, { providers: [account] }).derived;
    assert.equal(derived.paidToDateMinor, subscriptions.paidToDateMinor(record, date));
    assert.equal(derived.paidToDateMinor, 0);
    assert.equal(derived.topUpTotalMinor, 15000);
    assert.equal(derived.topUpMonthMinor, 10000);
    assert.equal(derived.monthlyAmountUsd, subscriptions.monthlyAmountUsd(record, currency, date));
    assert.equal(derived.nextRenewalDate, null);
    assert.equal(derived.coverageEndDate, null);
    assert.equal(derived.daysUntilRenewal, null);
    const forecast = subscriptions.topUpProjection(record, balance.creditsAmount(account, account.windows[0]), date,
      { currencyApi: currency, balanceCurrency: balance.creditsCurrency(account, account.windows[0]) });
    assert.deepEqual({ dailyBurn: derived.forecast.dailyBurn, daysRemaining: derived.forecast.daysRemaining, exhaustDate: derived.forecast.exhaustDate },
      { ...forecast, exhaustDate: forecast.exhaustDate || null });
    assert.equal(derived.forecast.currency, 'USD');
    assert.equal(derived.forecast.balanceAmount, 30);
    assert.equal(derived.forecast.balanceUpdatedAt, account.updatedAt);
    assert.equal(derived.forecast.accountId, opaque('account', 'openrouter:private-account'));
  } finally { currency.configureRates(); }
});

test('missing/invalid captured calendar is explicit, and missing rates never imply USD', () => {
  for (const subscriptionContext of [undefined, null, {}, { date: '2026-02-30' }, { date: ' 2026-03-15' }, { date: '2026-03-15T00:00:00Z' }]) {
    const derived = row(topup(), { extras: { subscriptionContext } }).derived;
    assert.equal(derived.status, 'unavailable');
    assert.equal(derived.reason, 'missingContext');
    for (const key of ['asOfDate', 'active', 'nextRenewalDate', 'coverageEndDate', 'daysUntilRenewal', 'paidToDateMinor', 'monthlyAmountUsd', 'topUpTotalMinor', 'topUpMonthMinor']) assert.equal(derived[key], null, key);
    assert.equal(derived.forecast.reason, 'missingContext');
  }
  for (const rates of [undefined, {}, { HKD: 0 }, { HKD: -1 }, { HKD: Infinity }, { HKD: '7.8' }]) {
    const derived = row(topup({ currency: 'HKD' }), { extras: { subscriptionContext: { date, rates } } }).derived;
    assert.equal(derived.status, 'available');
    assert.equal(derived.monthlyAmountUsd, null);
    assert.equal(derived.monthlyAmountUsdReason, 'missingRate');
    assert.equal(derived.forecast.reason, 'missingRate');
  }
});

test('unknown currencies including CREDITS never pass through a USD fallback', () => {
  for (const code of ['CREDITS', 'EUR', '', null]) {
    const record = { ...topup(), currency: code };
    const derived = row(record).derived;
    assert.equal(derived.monthlyAmountUsd, null);
    assert.equal(derived.monthlyAmountUsdReason, 'unsupportedCurrency');
    assert.equal(derived.forecast.status, 'unavailable');
    assert.equal(derived.forecast.reason, 'unsupportedCurrency');
    const forecast = row(topup(), { providers: [provider({ windows: [{ metric: 'credits', remaining: 30, currency: code }] })] }).derived.forecast;
    assert.equal(forecast.status, 'unavailable');
    assert.equal(forecast.reason, 'unsupportedCurrency');
    assert.equal(forecast.currency, null);
  }
});

test('projection does not read clock/random/global mutable rates or repair malformed host records', () => {
  const record = topup({ currency: 'HKD' });
  const baseline = row(record);
  const originalDate = global.Date, random = Math.random;
  currency.configureRates({ HKD: 200 });
  global.Date = class extends originalDate {
    constructor(...args) { assert.ok(args.length > 0, 'wall clock access'); super(...args); }
    static now() { assert.fail('Date.now access'); }
  };
  Math.random = () => assert.fail('random identity generation');
  try {
    assert.deepEqual(row(record), baseline);
    for (const invalid of [
      { ...record, topUps: [{ date: '2026-03-01', amountMinor: 100 }] },
      { ...record, topUps: [{ id: 'bad', date: '2026-02-30', amountMinor: 100 }] },
      { ...record, amountMinor: NaN },
      { ...record, topUps: [{ id: 'bad', date, amountMinor: Infinity }] }
    ]) {
      const derived = row(invalid).derived;
      assert.equal(derived.status, 'unavailable');
      assert.equal(derived.reason, 'invalidRecord');
      assert.equal(derived.monthlyAmountUsd, null);
    }
  } finally { global.Date = originalDate; Math.random = random; currency.configureRates(); }
});

test('forecast matches the complete provider set and preserves rotated account aliases', () => {
  const record = topup({ binding: { accountKey: 'rotated-key' } });
  const providers = [provider({ accountKey: 'rotated-key' }), provider({ accountKey: 'another-key' })];
  const ambiguous = row(record, { providers: providers.map(p => ({ ...p, accountKey: p.accountKey === 'rotated-key' ? 'current-key' : p.accountKey })) });
  assert.equal(ambiguous.derived.forecast.status, 'ambiguous');
  assert.equal(ambiguous.derived.forecast.accountId, null);
  const allowed = row(record, { providers: [provider({ accountKey: 'current-key', accountKeyAliases: ['rotated-key'] })] }).derived.forecast;
  assert.equal(allowed.status, 'available');
  assert.equal(allowed.accountId, opaque('account', 'openrouter:current-key'));
});

test('duplicate key/email, unmatched and unbound multi-account forecasts remain explicit', () => {
  for (const providers of [
    [provider(), provider({ windows: [{ metric: 'credits', currency: 'USD', remaining: 2 }] })],
    [provider({ accountKey: 'rotated-a' }), provider({ accountKey: 'rotated-b' })]
  ]) {
    const forecast = row(topup(), { providers }).derived.forecast;
    assert.equal(forecast.status, 'ambiguous');
    assert.equal(forecast.accountId, null);
  }
  assert.equal(row(topup(), { providers: [] }).derived.forecast.status, 'unmatched');
  assert.equal(row(topup({ provider: 'workbuddy' }), { providers: [provider({ provider: 'workbuddy', accountKey: 'different' })] }).derived.forecast.status, 'unmatched');
  const noBinding = topup({ binding: {} });
  assert.equal(row(noBinding, { providers: [provider(), provider({ accountKey: 'b' })] }).derived.forecast.status, 'ambiguous');
  const healed = row(noBinding).derived.forecast;
  assert.equal(healed.status, 'available');
  assert.equal(healed.accountId, opaque('account', 'openrouter:private-account'));
});

test('forecast rejects marked stale/unusable/missing balances but invents no age threshold', () => {
  for (const stats of [
    { stale: true, limits: { providers: [provider()] } },
    { limits: { stale: true, providers: [provider()] } },
    { limits: { providers: [provider({ stale: true })] } },
    { limits: { providers: [provider({ status: 'stale' })] } }
  ]) {
    const forecast = row(topup(), { stats }).derived.forecast;
    assert.equal(forecast.status, 'stale');
    assert.equal(forecast.reason, 'markedStale');
    assert.equal(forecast.dailyBurn, null);
    assert.equal(forecast.balanceUpdatedAt, '2026-03-14T23:00:00Z');
  }
  for (const status of ['error', 'rateLimited', 'unavailable', 'unauthorized', 'disabled', null]) {
    const forecast = row(topup(), { providers: [provider({ status })] }).derived.forecast;
    assert.equal(forecast.status, 'unavailable');
    assert.equal(forecast.reason, 'providerStatus');
  }
  assert.equal(row(topup(), { stats: {} }).derived.forecast.reason, 'missingLimits');
  assert.equal(row(topup(), { providers: [provider({ windows: [] })] }).derived.forecast.reason, 'missingBalance');
  for (const updatedAt of [null, undefined, '2001-01-01T00:00:00Z']) {
    const forecast = row(topup(), { providers: [provider({ updatedAt })] }).derived.forecast;
    assert.equal(forecast.status, 'available');
    assert.equal(forecast.balanceUpdatedAt, updatedAt ?? null);
  }
});

test('forecast follows balance helper fallbacks and finite no-burn/exhaustion semantics', () => {
  const account = provider({ windows: [], balance: { amount: 0, currency: 'CNY' } });
  const forecast = row(topup(), { providers: [account] }).derived.forecast;
  assert.equal(forecast.status, 'available');
  assert.equal(forecast.currency, 'CNY');
  assert.equal(forecast.daysRemaining, 0);
  assert.equal(forecast.exhaustDate, date);
  assert.equal(forecast.balanceAmount, 0);
  const noBurn = row(topup(), { providers: [provider({ windows: [{ metric: 'credits', remaining: 200, currency: 'USD' }] })] }).derived.forecast;
  assert.equal(noBurn.status, 'available');
  assert.equal(noBurn.dailyBurn, 0);
  assert.equal(noBurn.daysRemaining, null);
  assert.equal(noBurn.exhaustDate, null);
  const todayOnly = topup({ topUps: [{ id: 'today', date, amountMinor: 10000 }] });
  assert.equal(row(todayOnly).derived.forecast.reason, 'insufficientHistory');
});


test('repeated subscription matching bounds nested alias traversal', () => {
  const account = provider({ accountKeyAliases: Array.from({ length: 1000 }, (_, index) => `alias-${index}`) });
  const record = topup();
  assert.throws(() => projectResource({ limits: { providers: [account] } },
    { subscriptionContext: context, subscriptions: Array.from({ length: 500 }, (_, index) => ({ ...record, id: `sub-${index}` })) },
    q('subscriptions'), authority(), opaque), { code: 'budgetExceeded' });
});
