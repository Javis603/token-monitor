'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const subscriptions = require('../../src/shared/subscriptionDisplay');
const currency = require('../../src/shared/currency');

const {
  activeSubscriptions,
  bindingFromAccount,
  coverageEndDate,
  daysUntilRenewal,
  elapsedPeriods,
  firstTopUpDate,
  intervalMonths,
  isBalanceOnlyAccount,
  lastTopUp,
  matchProviderAccount,
  monthlyAmountUsd,
  monthlyTotalUsd,
  needsRebinding,
  nextRenewalDate,
  normalizeSubscription,
  normalizeSubscriptions,
  paidToDateMinor,
  providerRollup,
  subscribedMonths,
  topUpMonthMinor,
  topUpProjection,
  topUpTotalMinor,
  valueMultiple
} = subscriptions;

function subscription(overrides = {}) {
  return normalizeSubscription({
    id: 'sub_test',
    provider: 'codex',
    amountMinor: 7500,
    currency: 'HKD',
    interval: 'month',
    intervalCount: 1,
    startDate: '2026-02-01',
    ...overrides
  }, { currencyApi: currency });
}

function topUp(overrides = {}) {
  return normalizeSubscription({
    id: 'top_test',
    provider: 'openrouter',
    kind: 'topup',
    currency: 'HKD',
    topUps: [{ date: '2026-07-08', amountMinor: 10000 }],
    ...overrides
  }, { currencyApi: currency });
}

test('normalizeSubscription rejects entries without a provider or start date', () => {
  assert.equal(normalizeSubscription(null), null);
  assert.equal(normalizeSubscription({ provider: 'codex' }), null);
  assert.equal(normalizeSubscription({ startDate: '2026-02-01' }), null);
  assert.equal(normalizeSubscription({ provider: 'codex', startDate: '2026-02-30' }), null);
  assert.equal(normalizeSubscription({ provider: 'codex', startDate: '02/01/2026' }), null);
});

test('normalizeSubscription clamps and defaults its fields', () => {
  const normalized = normalizeSubscription({
    provider: '  Codex ',
    startDate: '2026-02-01',
    amountMinor: -50,
    interval: 'week',
    intervalCount: 0,
    nextRenewalOverride: 'nope'
  });
  assert.equal(normalized.provider, 'codex');
  assert.equal(normalized.amountMinor, 0);
  assert.equal(normalized.interval, 'month');
  assert.equal(normalized.intervalCount, 1);
  assert.equal(normalized.nextRenewalOverride, null);
  assert.equal(normalized.autoRenew, true);
});

test('normalizeSubscriptions drops duplicates by id', () => {
  const list = normalizeSubscriptions([
    { id: 'a', provider: 'codex', startDate: '2026-02-01' },
    { id: 'a', provider: 'claude', startDate: '2026-03-01' },
    { id: 'b', provider: 'claude', startDate: '2026-03-01' }
  ]);
  assert.deepEqual(list.map((entry) => entry.id), ['a', 'b']);
  assert.equal(list[0].provider, 'codex');
});

test('intervalMonths folds yearly and multi-count intervals into months', () => {
  assert.equal(intervalMonths(subscription({ interval: 'month', intervalCount: 1 })), 1);
  assert.equal(intervalMonths(subscription({ interval: 'month', intervalCount: 3 })), 3);
  assert.equal(intervalMonths(subscription({ interval: 'year', intervalCount: 1 })), 12);
});

// The Stripe/Apple/Google anchoring rule: clamp into a short month, then return
// to the anchor day. Rolling "previous period + 1 month" would collapse to the
// 28th permanently after February.
test('nextRenewalDate clamps short months but returns to the anchor day', () => {
  const monthly = subscription({ startDate: '2026-01-31' });
  const expected = [
    ['2026-01-31', '2026-01-31'],
    ['2026-02-01', '2026-02-28'],
    ['2026-03-01', '2026-03-31'],
    ['2026-04-01', '2026-04-30'],
    ['2026-05-01', '2026-05-31'],
    ['2026-06-01', '2026-06-30'],
    ['2026-07-01', '2026-07-31']
  ];
  for (const [today, renewal] of expected) {
    assert.equal(nextRenewalDate(monthly, today), renewal, `renewal from ${today}`);
  }
});

test('nextRenewalDate returns the start date itself on the start date', () => {
  assert.equal(nextRenewalDate(subscription(), '2026-02-01'), '2026-02-01');
  assert.equal(nextRenewalDate(subscription(), '2026-01-15'), '2026-02-01');
});

test('nextRenewalDate handles leap-day yearly plans', () => {
  const yearly = subscription({ startDate: '2024-02-29', interval: 'year' });
  assert.equal(nextRenewalDate(yearly, '2025-01-01'), '2025-02-28');
  assert.equal(nextRenewalDate(yearly, '2027-01-01'), '2027-02-28');
  assert.equal(nextRenewalDate(yearly, '2028-01-01'), '2028-02-29');
});

test('nextRenewalDate handles quarterly plans', () => {
  const quarterly = subscription({ startDate: '2026-01-15', intervalCount: 3 });
  assert.equal(nextRenewalDate(quarterly, '2026-02-01'), '2026-04-15');
  assert.equal(nextRenewalDate(quarterly, '2026-04-16'), '2026-07-15');
});

test('nextRenewalOverride wins until it passes, then falls back to the anchor', () => {
  const shifted = subscription({ nextRenewalOverride: '2026-03-10' });
  assert.equal(nextRenewalDate(shifted, '2026-03-01'), '2026-03-10');
  // Once the override is behind us it is ignored rather than rolled forward, so
  // it can never become a permanently wrong fixed date.
  assert.equal(nextRenewalDate(shifted, '2026-03-11'), '2026-04-01');
});

test('daysUntilRenewal counts calendar days', () => {
  assert.equal(daysUntilRenewal(subscription(), '2026-02-20'), 9);
  assert.equal(daysUntilRenewal(subscription(), '2026-03-01'), 0);
});

test('coverageEndDate uses the end date once cancelled', () => {
  const cancelled = subscription({ autoRenew: false, endDate: '2026-09-01' });
  assert.equal(coverageEndDate(cancelled, '2026-08-01'), '2026-09-01');
});

test('elapsedPeriods counts the first charge and stops at the end date', () => {
  const monthly = subscription();
  assert.equal(elapsedPeriods(monthly, '2026-01-31'), 0);
  assert.equal(elapsedPeriods(monthly, '2026-02-01'), 1);
  assert.equal(elapsedPeriods(monthly, '2026-02-28'), 1);
  assert.equal(elapsedPeriods(monthly, '2026-03-01'), 2);
  assert.equal(elapsedPeriods(monthly, '2026-08-01'), 7);

  // The end date is a boundary, not a covered day: charges land on 02-01 and
  // 03-01, and the 04-01 renewal is precisely the one that was cancelled.
  const cancelled = subscription({ endDate: '2026-04-01' });
  assert.equal(elapsedPeriods(cancelled, '2026-08-01'), 2);
});

test('a plan that does not renew stops instead of rolling forward', () => {
  // One month bought on 2026-06-06 and never renewed, read two months later.
  const once = subscription({ startDate: '2026-06-06', autoRenew: false });
  const today = '2026-08-02';

  assert.equal(nextRenewalDate(once, today), '');
  assert.equal(coverageEndDate(once, today), '2026-07-06');
  assert.ok(daysUntilRenewal(once, today) < 0);
  // The charge that never happened is never billed: one period, once.
  assert.equal(elapsedPeriods(once, today), 1);
  assert.equal(paidToDateMinor(once, today), 7500);
  // And it stops counting against the monthly total the moment it lapses.
  assert.equal(activeSubscriptions([once], today).length, 0);
  assert.equal(activeSubscriptions([once], '2026-07-05').length, 1);

  // A yearly plan gets a year of coverage, not a month.
  const yearly = subscription({ startDate: '2026-06-06', autoRenew: false, interval: 'year' });
  assert.equal(coverageEndDate(yearly, today), '2027-06-06');
  assert.equal(elapsedPeriods(yearly, today), 1);
});

test('cancelling after several renewals keeps every charge that happened', () => {
  // Monthly from 2026-02-01, cancelled with coverage running out 2026-06-01:
  // charges on 02-01 through 05-01.
  const cancelled = subscription({ autoRenew: false, endDate: '2026-06-01' });
  assert.equal(coverageEndDate(cancelled, '2026-05-20'), '2026-06-01');
  assert.equal(elapsedPeriods(cancelled, '2026-05-20'), 4);
  assert.equal(elapsedPeriods(cancelled, '2026-08-01'), 4);
  assert.equal(activeSubscriptions([cancelled], '2026-05-20').length, 1);
  assert.equal(activeSubscriptions([cancelled], '2026-06-01').length, 0);
});

test('a renewing plan still rolls its schedule forward', () => {
  const renewing = subscription();
  assert.equal(nextRenewalDate(renewing, '2026-08-02'), '2026-09-01');
  assert.equal(coverageEndDate(renewing, '2026-08-02'), '2026-09-01');
  // The renewal that falls on today was charged today, so it counts.
  assert.equal(elapsedPeriods(renewing, '2026-03-01'), 2);
});

test('paidToDateMinor multiplies the price by real charges', () => {
  assert.equal(paidToDateMinor(subscription(), '2026-08-01'), 7500 * 7);
});

test('subscribedMonths reports whole months of coverage', () => {
  assert.equal(subscribedMonths(subscription(), '2026-08-01'), 6);
  assert.equal(subscribedMonths(subscription(), '2026-07-31'), 5);
});

test('monthlyAmountUsd normalizes intervals and currencies', () => {
  const usdMonthly = subscription({ currency: 'USD', amountMinor: 2000 });
  assert.equal(monthlyAmountUsd(usdMonthly, currency), 20);

  const usdYearly = subscription({ currency: 'USD', amountMinor: 24000, interval: 'year' });
  assert.equal(monthlyAmountUsd(usdYearly, currency), 20);

  // HK$78 at the built-in 7.8 rate is US$10.
  const hkdMonthly = subscription({ currency: 'HKD', amountMinor: 7800 });
  assert.equal(Math.round(monthlyAmountUsd(hkdMonthly, currency) * 100) / 100, 10);
});

test('monthlyTotalUsd sums mixed currencies and skips ended subscriptions', () => {
  const list = [
    subscription({ id: 'a', currency: 'USD', amountMinor: 2000 }),
    subscription({ id: 'b', currency: 'HKD', amountMinor: 7800 }),
    subscription({ id: 'c', currency: 'USD', amountMinor: 5000, endDate: '2026-05-01' })
  ];
  assert.equal(activeSubscriptions(list, '2026-08-01').length, 2);
  assert.equal(Math.round(monthlyTotalUsd(list, currency, '2026-08-01') * 100) / 100, 30);
});

test('matchProviderAccount prefers a named profile over a rotated key', () => {
  const sub = subscription({
    provider: 'openrouter',
    binding: { profileName: 'work', accountKey: 'sha256:old', accountEmail: '' }
  });
  const providers = [
    { provider: 'openrouter', accountName: 'personal', accountKey: 'sha256:p' },
    { provider: 'openrouter', accountName: 'work', accountKey: 'sha256:new' }
  ];
  assert.equal(matchProviderAccount(sub, providers).accountKey, 'sha256:new');
});

test('matchProviderAccount falls back to email when the key rotated', () => {
  const sub = subscription({
    provider: 'claude',
    binding: { accountKey: 'sha256:old', accountEmail: 'JAVIS@example.com' }
  });
  const providers = [
    { provider: 'claude', accountKey: 'sha256:other', accountEmail: 'someone@example.com' },
    { provider: 'claude', accountKey: 'sha256:new', accountEmail: 'javis@example.com' }
  ];
  assert.equal(matchProviderAccount(sub, providers).accountKey, 'sha256:new');
});

// The self-healing case: qoder hashes the cookie, so re-pasting an expired one
// changes accountKey. With a single account there is no ambiguity to resolve.
test('matchProviderAccount claims the sole account when every candidate misses', () => {
  const sub = subscription({ provider: 'qoder', binding: { accountKey: 'sha256:stale' } });
  const providers = [{ provider: 'qoder', accountKey: 'sha256:fresh' }];
  assert.equal(matchProviderAccount(sub, providers).accountKey, 'sha256:fresh');
  assert.equal(needsRebinding(sub, providers), false);
});

test('needsRebinding only fires on a genuine ambiguity', () => {
  const sub = subscription({ provider: 'qoder', binding: { accountKey: 'sha256:stale' } });

  // Provider not configured right now — keep the data, do not call it an orphan.
  assert.equal(needsRebinding(sub, []), false);

  const twoAccounts = [
    { provider: 'qoder', accountKey: 'sha256:a' },
    { provider: 'qoder', accountKey: 'sha256:b' }
  ];
  assert.equal(matchProviderAccount(sub, twoAccounts), null);
  assert.equal(needsRebinding(sub, twoAccounts), true);
});

test('bindingFromAccount captures every ladder rung', () => {
  assert.deepEqual(
    bindingFromAccount({ accountName: 'work', accountKey: 'sha256:k', email: 'A@B.com' }),
    { profileName: 'work', accountKey: 'sha256:k', accountEmail: 'a@b.com' }
  );
});

// A subscription that also carries a prepaid balance is still a subscription.
// Claude Pro reports session and weekly quotas alongside a top-up balance, and
// hiding it from the picker would hide one of the most likely accounts to record.
test('isBalanceOnlyAccount ignores a balance attached to a real plan', () => {
  const claudePro = {
    provider: 'claude',
    windows: [
      { kind: 'session', usedPercent: 57 },
      { kind: 'weekly', usedPercent: 40 },
      { kind: 'billing', metric: 'credits', remaining: 85.72, currency: 'USD' }
    ]
  };
  assert.equal(isBalanceOnlyAccount(claudePro), false);
});

test('isBalanceOnlyAccount catches accounts whose whole quota is money', () => {
  assert.equal(isBalanceOnlyAccount({
    provider: 'openrouter',
    windows: [{ metric: 'credits', remaining: 12.5, currency: 'USD' }]
  }), true);

  // A spend meter is the mirror of the credits one, not a quota of its own.
  assert.equal(isBalanceOnlyAccount({
    provider: 'openrouter',
    windows: [
      { metric: 'credits', remaining: 12.5, currency: 'USD' },
      { metric: 'spend', used: 40 }
    ]
  }), true);
});

test('isBalanceOnlyAccount stays false without any credits window', () => {
  assert.equal(isBalanceOnlyAccount({ provider: 'codex', windows: [{ kind: 'weekly', usedPercent: 10 }] }), false);
  assert.equal(isBalanceOnlyAccount({ provider: 'codex', windows: [] }), false);
  assert.equal(isBalanceOnlyAccount(null), false);
});

// tokscale never records which signed-in account produced the tokens, so three
// Codex logins share one usage figure. The rollup has to charge that figure
// once against the combined price, not once per account.
test('providerRollup aggregates every subscription for one provider', () => {
  const list = [
    subscription({ id: 'a', provider: 'codex', currency: 'USD', amountMinor: 2000 }),
    subscription({ id: 'b', provider: 'codex', currency: 'USD', amountMinor: 2000 }),
    subscription({ id: 'c', provider: 'codex', currency: 'USD', amountMinor: 2000 }),
    subscription({ id: 'd', provider: 'claude', currency: 'USD', amountMinor: 10000 })
  ];
  const rollup = providerRollup(list, 'codex', currency, '2026-08-01');
  assert.equal(rollup.count, 3);
  assert.equal(rollup.monthlyUsd, 60);

  // One account's price would have claimed 9x; the provider total is the truth.
  assert.equal(valueMultiple(rollup.monthlyUsd, 180), 3);
  assert.equal(valueMultiple(20, 180), 9);
});

test('valueMultiple refuses to divide by nothing', () => {
  assert.equal(valueMultiple(0, 180), null);
  assert.equal(valueMultiple(20, 0), null);
  assert.equal(valueMultiple(20, null), null);
});

test('a top-up record needs a ledger, and a subscription needs a start date', () => {
  assert.equal(normalizeSubscription({ provider: 'openrouter', kind: 'topup' }), null);
  assert.equal(normalizeSubscription({ provider: 'openrouter', kind: 'topup', topUps: [] }), null);
  // A start date is not what anchors a ledger, so it is not required for one.
  const ledger = topUp();
  assert.equal(ledger.kind, 'topup');
  assert.equal(ledger.startDate, null);
  // An unknown kind is a subscription, which is what every stored record from
  // before this field existed is.
  assert.equal(normalizeSubscription({ provider: 'codex', startDate: '2026-02-01', kind: 'nope' }).kind, 'subscription');
});

test('a ledger is stored newest first whatever order it arrives in', () => {
  const ledger = topUp({
    topUps: [
      { date: '2026-07-08', amountMinor: 10000 },
      { date: '2026-08-30', amountMinor: 5000 },
      { date: '2026-08-02', amountMinor: 2500 },
      { date: 'not a date', amountMinor: 999 }
    ]
  });
  assert.deepEqual(ledger.topUps.map((entry) => entry.date), ['2026-08-30', '2026-08-02', '2026-07-08']);
  assert.equal(lastTopUp(ledger).date, '2026-08-30');
  assert.equal(firstTopUpDate(ledger), '2026-07-08');
  assert.equal(topUpTotalMinor(ledger), 17500);
  // Only what landed in this calendar month, which is what a month's usage is
  // compared against.
  assert.equal(topUpMonthMinor(ledger, '2026-08-15'), 7500);
  assert.equal(topUpMonthMinor(ledger, '2026-07-15'), 10000);
  assert.equal(topUpMonthMinor(ledger, '2026-09-15'), 0);
});

test('a ledger contributes this month to the monthly total, a plan its cadence', () => {
  const list = [
    subscription({ id: 'plan', provider: 'codex', currency: 'USD', amountMinor: 2400, interval: 'year' }),
    topUp({ id: 'ledger', currency: 'USD', topUps: [{ date: '2026-08-02', amountMinor: 5000 }] })
  ];
  // US$24/year is US$2/month, plus US$50 put in during August.
  assert.equal(monthlyTotalUsd(list, currency, '2026-08-15'), 52);
  // Nothing was topped up in September, so only the plan is still costing.
  assert.equal(monthlyTotalUsd(list, currency, '2026-09-15'), 2);
});

test('a ledger has no renewal schedule to project', () => {
  const ledger = topUp();
  assert.equal(nextRenewalDate(ledger, '2026-08-15'), '');
  assert.equal(daysUntilRenewal(ledger, '2026-08-15'), null);
  assert.equal(elapsedPeriods(ledger, '2026-08-15'), 0);
  assert.equal(subscribedMonths(ledger, '2026-08-15'), 0);
});

test('topUpProjection measures burn across the whole ledger', () => {
  // US$200 in on 1 August, US$150 left ten days later: US$5/day, 30 days to go.
  const single = topUp({ currency: 'USD', topUps: [{ date: '2026-08-01', amountMinor: 20000 }] });
  const projection = topUpProjection(single, 150, '2026-08-11');
  assert.equal(projection.dailyBurn, 5);
  assert.equal(projection.daysRemaining, 30);
  assert.equal(projection.exhaustDate, '2026-09-10');

  // A second top-up used to break this: US$150 left is MORE than the US$100 last
  // put in, so "last top-up minus balance" went negative and reported no burn.
  const twice = topUp({
    currency: 'USD',
    topUps: [
      { date: '2026-08-01', amountMinor: 20000 },
      { date: '2026-08-06', amountMinor: 10000 }
    ]
  });
  const both = topUpProjection(twice, 150, '2026-08-11');
  // US$300 in, US$150 left, ten days since the first entry.
  assert.equal(both.dailyBurn, 15);
  assert.equal(both.daysRemaining, 10);
});

test('topUpProjection converts a ledger into the currency the balance is quoted in', () => {
  const ledger = topUp({ currency: 'HKD', topUps: [{ date: '2026-08-01', amountMinor: 78000 }] });
  // HK$780 is about US$100; against a US$50 balance that is US$5/day over ten days.
  const projection = topUpProjection(ledger, 50, '2026-08-11', {
    currencyApi: currency,
    balanceCurrency: 'USD'
  });
  assert.ok(Math.abs(projection.dailyBurn - 5) < 0.2, `dailyBurn was ${projection.dailyBurn}`);
  // Without the conversion the raw 780 − 50 would claim a burn 15x too large.
  assert.ok(projection.dailyBurn < 10);
});

test('topUpProjection stays quiet without enough information', () => {
  const ledger = topUp({ currency: 'USD', topUps: [{ date: '2026-08-01', amountMinor: 20000 }] });
  assert.equal(topUpProjection(ledger, null, '2026-08-11'), null);
  assert.equal(topUpProjection(ledger, 150, '2026-02-01'), null);
  assert.equal(topUpProjection(subscription(), 150, '2026-08-11'), null);
  // Untouched balance: no spend observed, so no forecast to make.
  const untouched = topUpProjection(ledger, 200, '2026-08-11');
  assert.equal(untouched.dailyBurn, 0);
  assert.equal(untouched.exhaustDate, '');
});

test('the shared document normalizes what it stores and dates every write', () => {
  const empty = subscriptions.emptySubscriptionDocument();
  assert.deepEqual(empty, { version: 1, updatedAt: '', subscriptions: [] });
  // A fresh object each call: both hubs assign it into a mutable store.
  assert.notEqual(subscriptions.emptySubscriptionDocument(), empty);

  const doc = subscriptions.subscriptionDocument([
    { id: 'a', provider: 'codex', startDate: '2026-05-31', amountMinor: 9000 },
    { provider: '' },
    null,
    'nope',
    { id: 'a', provider: 'claude', startDate: '2026-01-01' }
  ]);
  assert.equal(doc.version, 1);
  assert.match(doc.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  // Malformed records are dropped and duplicate ids collapse: this list arrived
  // over the network from another device.
  assert.deepEqual(doc.subscriptions.map((entry) => entry.provider), ['codex']);
  assert.equal(subscriptions.subscriptionDocument(null).subscriptions.length, 0);
});

test('a write from a stale copy is refused, and the first write never is', () => {
  const stored = subscriptions.subscriptionDocument([
    { id: 'a', provider: 'codex', startDate: '2026-05-31' }
  ]);
  // The device wrote from the copy it is holding.
  assert.equal(subscriptions.isStaleSubscriptionWrite(stored, stored.updatedAt), false);
  // It is holding an older copy, and blindly writing would erase whatever was
  // added elsewhere in between — records that exist nowhere else.
  assert.equal(subscriptions.isStaleSubscriptionWrite(stored, '2026-01-01T00:00:00.000Z'), true);
  assert.equal(subscriptions.isStaleSubscriptionWrite(stored, ''), true);
  assert.equal(subscriptions.isStaleSubscriptionWrite(stored, undefined), true);
  // Nothing stored yet: the first write cannot clobber anything.
  const empty = subscriptions.emptySubscriptionDocument();
  assert.equal(subscriptions.isStaleSubscriptionWrite(empty, ''), false);
  assert.equal(subscriptions.isStaleSubscriptionWrite(null, ''), false);
});

test('an exact identifier beats a shared profile name', () => {
  const accounts = [
    { provider: 'opencode', accountKey: 'k1', accountName: 'work', accountEmail: 'one@example.com' },
    { provider: 'opencode', accountKey: 'k2', accountName: 'work', accountEmail: 'two@example.com' }
  ];
  // Two accounts the user labelled the same. The binding names one of them
  // exactly, so the cost must land on that row and not on whichever came first.
  const byKey = subscriptions.matchProviderAccount(
    { provider: 'opencode', binding: { profileName: 'work', accountKey: 'k2' } }, accounts
  );
  assert.equal(byKey.accountKey, 'k2');
  const byEmail = subscriptions.matchProviderAccount(
    { provider: 'opencode', binding: { profileName: 'work', accountEmail: 'two@example.com' } }, accounts
  );
  assert.equal(byEmail.accountKey, 'k2');

  // Nothing but the ambiguous name: guessing would put the money on the wrong
  // account, so it stays unmatched and the rebind prompt asks.
  assert.equal(
    subscriptions.matchProviderAccount({ provider: 'opencode', binding: { profileName: 'work' } }, accounts),
    null
  );
  // A unique name still matches, which is the rung that survives a rotated key.
  assert.equal(
    subscriptions.matchProviderAccount(
      { provider: 'opencode', binding: { profileName: 'work', accountKey: 'expired' } },
      [accounts[0], { provider: 'opencode', accountKey: 'k9', accountName: 'personal' }]
    ).accountKey,
    'k1'
  );
});

test('an OpenCode subscription bound to a legacy account key follows its canonical workspace account', () => {
  const accounts = [
    {
      provider: 'opencode',
      accountKey: 'sha256:canonical',
      accountKeyAliases: ['sha256:legacy-go', 'sha256:legacy-zen'],
      accountName: 'work'
    },
    { provider: 'opencode', accountKey: 'sha256:other', accountName: 'personal' }
  ];
  const subscription = {
    provider: 'opencode',
    binding: { accountKey: 'sha256:legacy-go' }
  };

  assert.equal(subscriptions.matchProviderAccount(subscription, accounts).accountKey, 'sha256:canonical');
  assert.equal(subscriptions.needsRebinding(subscription, accounts), false);
});

test('two writes in the same millisecond cannot share a concurrency token', () => {
  const first = subscriptions.subscriptionDocument([], { updatedAt: '2026-08-02T09:00:00.000Z' });
  // updatedAt IS the token, so a second write landing in the same millisecond
  // must not reproduce it — the third write would then pass the staleness check
  // against a document it never read.
  const second = subscriptions.subscriptionDocument([], { previousUpdatedAt: first.updatedAt });
  assert.ok(second.updatedAt > first.updatedAt, `${second.updatedAt} should follow ${first.updatedAt}`);
  assert.equal(subscriptions.isStaleSubscriptionWrite(second, first.updatedAt), true);

  // A clock that has genuinely moved on is left alone.
  const later = subscriptions.subscriptionDocument([], { previousUpdatedAt: '2020-01-01T00:00:00.000Z' });
  assert.ok(later.updatedAt > '2020-01-01T00:00:00.000Z');
});

test('a currency with no exchange rate is not silently reinterpreted as USD', () => {
  const currencyApi = require('../../src/shared/currency');
  // The hubs validate against the same set the app can actually convert; storing
  // EUR and later valuing it as USD would misreport the recorded cost.
  const stored = subscriptions.subscriptionDocument(
    [{ id: 'a', provider: 'codex', startDate: '2026-05-31', amountMinor: 1000, currency: 'EUR' }],
    { currencyApi }
  );
  assert.equal(stored.subscriptions[0].currency, 'USD');
  assert.equal(
    subscriptions.subscriptionDocument(
      [{ id: 'a', provider: 'codex', startDate: '2026-05-31', currency: 'HKD' }],
      { currencyApi }
    ).subscriptions[0].currency,
    'HKD'
  );
});
