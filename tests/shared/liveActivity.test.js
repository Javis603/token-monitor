'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLiveActivityContentState,
  normalizeLiveActivityRegistration
} = require('../../src/shared/liveActivity');

const basePreferences = {
  liveActivityEnabled: true,
  livePrimaryMetric: 'limit',
  livePeriod: 'today',
  liveProviderID: 'codex',
  liveShowsSecondaryMetric: true,
  liveShowsProgress: true,
  liveIconProviderID: null,
  liveCompactTrailingField: 'primary',
  liveExpandedLeadingField: 'provider',
  liveExpandedCenterField: 'primary',
  liveExpandedTrailingField: 'secondary',
  liveExpandedBottomField: 'progress',
  liveLockScreenPrimaryField: 'primary',
  liveLockScreenSecondaryField: 'secondary',
  liveLockScreenBottomField: 'progress',
  currencyCode: 'USD',
  languageCode: 'en'
};

test('normalizes a Live Activity registration without retaining arbitrary preferences', () => {
  const registration = normalizeLiveActivityRegistration({
    activityID: 'activity-1',
    token: 'A'.repeat(64),
    locale: 'en-US',
    preferences: {
      ...basePreferences,
      unexpected: 'should not persist'
    }
  });

  assert.equal(registration.activityID, 'activity-1');
  assert.equal(registration.token, 'a'.repeat(64));
  assert.equal(registration.locale, 'en');
  assert.equal('unexpected' in registration.preferences, false);
});

test('builds an ActivityKit content state from aggregated Hub stats', () => {
  const stats = {
    updatedAt: '2026-08-01T00:00:00.000Z',
    periods: {
      today: { totalTokens: 62_800_000, costUsd: 2.5, models: { 'gpt-5': 1 } }
    },
    limits: {
      providers: [{
        provider: 'codex',
        updatedAt: '2026-08-01T00:00:00.000Z',
        windows: [{ kind: 'weekly', usedPercent: 25, remainingPercent: 75 }]
      }]
    }
  };

  const state = buildLiveActivityContentState(
    stats,
    normalizeLiveActivityRegistration({
      activityID: 'activity-1',
      token: 'a'.repeat(64),
      locale: 'en-US',
      preferences: basePreferences
    }),
    Date.parse('2026-08-01T00:00:00.000Z')
  );

  assert.deepEqual(
    {
      primaryLabel: state.primaryLabel,
      primaryValue: state.primaryValue,
      secondaryLabel: state.secondaryLabel,
      secondaryValue: state.secondaryValue,
      progress: state.progress,
      providerID: state.providerID,
      providerName: state.providerName,
      tokensValue: state.tokensValue,
      costValue: state.costValue,
      limitValue: state.limitValue
    },
    {
      primaryLabel: 'Codex',
      primaryValue: '75% left',
      secondaryLabel: 'Cost',
      secondaryValue: '$2.50',
      progress: 0.75,
      providerID: 'codex',
      providerName: 'Codex',
      tokensValue: '62.8M',
      costValue: '$2.50',
      limitValue: '75% left'
    }
  );
  assert.equal(state.updatedAt, 807235200);
});

test('registration rejects unremovable IDs and truncated or non-byte tokens', () => {
  for (const activityID of ['a/b', 'x'.repeat(129), {}, '', ['valid']]) {
    assert.throws(() => normalizeLiveActivityRegistration({ activityID, token: 'a'.repeat(64) }), /invalid_live_activity_registration/);
  }
  for (const token of ['a'.repeat(4098), 'a'.repeat(33), ['a'.repeat(64)]]) {
    assert.throws(() => normalizeLiveActivityRegistration({ activityID: 'valid', token }), /invalid_live_activity_registration/);
  }
});

test('credit meters use current shared balance display semantics without mutating wire stats', () => {
  const stats = {
    periods: { today: {} },
    limits: { providers: [{ provider: 'deepseek', balance: { amount: 30, monthSpend: 10 }, windows: [{ metric: 'credits' }] }] }
  };
  const before = JSON.stringify(stats);
  const registration = normalizeLiveActivityRegistration({
    activityID: 'credits', token: 'a'.repeat(64), preferences: { ...basePreferences, liveProviderID: 'deepseek' }
  });
  const state = buildLiveActivityContentState(stats, registration);
  assert.equal(state.primaryValue, '$30.00');
  assert.equal(state.progress, 0.75);
  assert.equal(JSON.stringify(stats), before);
});

for (const [runtime, api] of [
  ['Node', require('../../src/shared/liveActivity')],
  ['Worker', require('../../worker/src/shared/liveActivity')]
]) {
  const now = Date.parse('2026-10-05T00:00:00Z');
  const appleSeconds = (iso) => Date.parse(iso) / 1000 - 978307200;
  const registration = (preferences = {}) => ({
    locale: 'en', preferences: { ...basePreferences, livePrimaryMetric: 'tokens', ...preferences }
  });

  test(`${runtime} uses the newest valid device source, never the transport timestamp`, () => {
    const stats = {
      updatedAt: new Date(now).toISOString(),
      devices: [
        { updatedAt: '2026-10-01T00:00:00Z', stale: true },
        { updatedAt: '2026-10-03T00:00:00Z', stale: true },
        { updatedAt: '2099-01-01T00:00:00Z' },
        { updatedAt: 'invalid' }
      ]
    };
    const before = structuredClone(stats);
    const state = api.buildLiveActivityContentState(stats, registration(), now);
    assert.equal(state.updatedAt, appleSeconds('2026-10-03T00:00:00Z'));
    assert.equal(state.sourceStale, true);
    assert.deepEqual(stats, before);
    assert.ok(api.liveActivityStaleDate(state, now / 1000) < now / 1000);
  });

  test(`${runtime} only falls back to stats time when devices are absent or empty`, () => {
    for (const devices of [undefined, []]) {
      const state = api.buildLiveActivityContentState({ updatedAt: new Date(now).toISOString(), devices }, registration(), now);
      assert.equal(state.updatedAt, now / 1000 - 978307200);
      assert.equal(state.sourceStale, false);
    }
    for (const stats of [
      {}, { updatedAt: 'invalid' }, { updatedAt: '2099-01-01T00:00:00Z' },
      { updatedAt: new Date(now).toISOString(), devices: [{ updatedAt: 'invalid' }] },
      { updatedAt: new Date(now).toISOString(), devices: [{ updatedAt: '2099-01-01T00:00:00Z' }] }
    ]) {
      const state = api.buildLiveActivityContentState(stats, registration(), now);
      assert.equal(state.sourceStale, true);
      assert.ok(api.liveActivityStaleDate(state, now / 1000) <= now / 1000);
    }
  });

  test(`${runtime} keeps reported zero separate from unknown tokens and cost`, () => {
    for (const value of [undefined, null, '', ' ', NaN, Infinity, 'invalid']) {
      const stats = { periods: { today: { totalTokens: value, costUsd: value } } };
      const tokens = api.buildLiveActivityContentState(stats, registration(), now);
      const cost = api.buildLiveActivityContentState(stats, registration({ livePrimaryMetric: 'cost' }), now);
      assert.equal(tokens.tokensValue, '—');
      assert.equal(tokens.costValue, '—');
      assert.equal(tokens.primaryValue, '—');
      assert.equal(cost.primaryValue, '—');
    }
    for (const value of [0, '0']) {
      const state = api.buildLiveActivityContentState({ periods: { today: { totalTokens: value, costUsd: value } } }, registration(), now);
      assert.equal(state.tokensValue, '0');
      assert.equal(state.costValue, '$0.00');
    }
  });

  test(`${runtime} limit freshness follows the chosen provider including explicit stale status`, () => {
    const stats = {
      updatedAt: new Date(now).toISOString(),
      devices: [{ updatedAt: new Date(now).toISOString(), stale: false }],
      limits: { providers: [
        { provider: 'claude', updatedAt: new Date(now).toISOString(), windows: [{ remainingPercent: 10 }] },
        { provider: 'codex', updatedAt: '2026-10-03T00:00:00Z', windows: [{ remainingPercent: 75 }] }
      ] }
    };
    const preferences = registration({ livePrimaryMetric: 'limit' });
    const state = api.buildLiveActivityContentState(stats, preferences, now);
    assert.equal(state.primaryValue, '75% left');
    assert.equal(state.updatedAt, appleSeconds('2026-10-03T00:00:00Z'));
    assert.equal(state.sourceStale, true);
    const provider = stats.limits.providers[1];
    provider.updatedAt = new Date(now).toISOString();
    provider.stale = true;
    const stale = api.buildLiveActivityContentState(stats, preferences, now);
    assert.equal(stale.updatedAt, now / 1000 - 978307200);
    assert.equal(stale.sourceStale, true);
    assert.equal(api.liveActivityStaleDate(stale, now / 1000), now / 1000);
    provider.stale = false;
    assert.equal(api.buildLiveActivityContentState(stats, preferences, now).sourceStale, false);
    for (const updatedAt of [undefined, 'invalid', '2099-01-01T00:00:00Z']) {
      provider.updatedAt = updatedAt;
      assert.equal(api.buildLiveActivityContentState(stats, preferences, now).sourceStale, true);
    }
    stats.limits.providers = [];
    const missing = api.buildLiveActivityContentState(stats, preferences, now);
    assert.equal(missing.primaryValue, '—');
    assert.equal(missing.progress, null);
    assert.equal(missing.sourceStale, true);
  });

  test(`${runtime} all stale devices override a recent source without rewriting its date`, () => {
    const stats = { devices: [{ updatedAt: new Date(now).toISOString(), stale: true }] };
    const state = api.buildLiveActivityContentState(stats, registration(), now);
    assert.equal(state.updatedAt, now / 1000 - 978307200);
    assert.equal(state.sourceStale, true);
    assert.equal(api.liveActivityStaleDate(state, now / 1000), now / 1000);
    stats.devices.push({ updatedAt: new Date(now).toISOString(), stale: false });
    assert.equal(api.buildLiveActivityContentState(stats, registration(), now).sourceStale, false);
  });

  test(`${runtime} absent selected provider never falls back to another account`, () => {
    const stats = { limits: { providers: [{ provider: 'claude', windows: [{ remainingPercent: 80 }] }] } };
    const state = api.buildLiveActivityContentState(stats, registration({ livePrimaryMetric: 'limit', liveProviderID: 'codex' }), now);
    assert.equal(state.primaryValue, '—');
    assert.equal(state.providerID, 'codex');
    assert.equal(state.progress, null);
  });

  test(`${runtime} tokens and cost activities provide independent quota progress`, () => {
    const stats = { limits: { providers: [{ provider: 'codex', windows: [{ remainingPercent: 80 }] }] } };
    for (const primary of ['tokens', 'cost']) {
      const state = api.buildLiveActivityContentState(stats, registration({ livePrimaryMetric: primary, liveShowsProgress: true }), now);
      assert.equal(state.progress, 0.8);
    }
  });

  test(`${runtime} credits show original currency amounts, preserve zero and keep meters display-only`, () => {
    const provider = { provider: 'deepseek', balance: { amount: 30, currency: 'USD', monthSpend: 10 }, windows: [{ metric: 'credits' }] };
    const stats = { limits: { providers: [provider] } };
    const preferences = registration({ livePrimaryMetric: 'limit', liveProviderID: 'deepseek', currencyCode: 'HKD' });
    let state = api.buildLiveActivityContentState(stats, preferences, now);
    assert.equal(state.primaryValue, '$30.00');
    assert.equal(state.limitValue, '$30.00');
    assert.equal(state.progress, 0.75);
    provider.windows[0].remaining = 0;
    provider.windows[0].currency = 'CNY';
    const before = structuredClone(stats);
    state = api.buildLiveActivityContentState(stats, preferences, now);
    assert.equal(state.primaryValue, '¥0.00');
    assert.equal(state.progress, 0);
    assert.deepEqual(stats, before);
    state = api.buildLiveActivityContentState(stats, registration({ liveProviderID: 'deepseek' }), now);
    assert.equal(state.secondaryValue, '¥0.00');
    delete provider.balance;
    delete provider.windows[0].remaining;
    state = api.buildLiveActivityContentState(stats, preferences, now);
    assert.equal(state.primaryValue, '—');
    assert.equal(state.progress, null);
    provider.windows[0] = { metric: 'credits', remaining: 680, currency: 'CREDITS' };
    assert.equal(api.buildLiveActivityContentState(stats, preferences, now).primaryValue, '680.00');
  });
}
