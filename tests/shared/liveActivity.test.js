'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLiveActivityContentState,
  normalizeLiveActivityRegistration
} = require('../../src/shared/liveActivity');

const basePreferences = {
  liveActivityEnabled: true,
  livePeriod: 'today',
  liveProviderID: 'codex',
  liveCompactLeading: 'mark',
  liveCompactTrailing: 'percent',
  liveExpandedStyle: 'quota',
  liveLockScreenStyle: 'combined',
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
      livePrimaryMetric: 'limit',
      liveIconProviderID: 'codex',
      unexpected: 'should not persist'
    }
  });

  assert.equal(registration.activityID, 'activity-1');
  assert.equal(registration.token, 'a'.repeat(64));
  assert.equal(registration.locale, 'en');
  assert.deepEqual(registration.preferences, basePreferences);
});

test('invalid layout options fall back to the documented defaults', () => {
  const registration = normalizeLiveActivityRegistration({
    activityID: 'activity-1',
    token: 'a'.repeat(64),
    preferences: {
      liveCompactLeading: 'bogus',
      liveCompactTrailing: 'primary',
      liveExpandedStyle: 'big',
      liveLockScreenStyle: 'everything',
      livePeriod: 'week',
      currencyCode: 'JPY',
      languageCode: 'fr'
    }
  });
  assert.deepEqual(registration.preferences, {
    liveActivityEnabled: true,
    livePeriod: 'today',
    liveProviderID: null,
    liveCompactLeading: 'mark',
    liveCompactTrailing: 'percent',
    liveExpandedStyle: 'quota',
    liveLockScreenStyle: 'combined',
    currencyCode: 'USD',
    languageCode: 'auto'
  });
});

test('builds a structured ContentState v2 — numbers, not formatted strings', () => {
  const stats = {
    updatedAt: '2026-08-01T00:00:00.000Z',
    periods: {
      today: { totalTokens: 62_800_000, costUsd: 2.5, models: { 'gpt-5': 1 } }
    },
    limits: {
      providers: [{
        provider: 'codex',
        status: 'ok',
        accountLabel: 'Plus',
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

  assert.deepEqual(state, {
    updatedAt: 807235200,
    sourceStale: false,
    period: 'today',
    tokens: 62_800_000,
    costUSD: 2.5,
    quota: {
      providerID: 'codex',
      planLabel: 'Plus',
      updatedAt: 807235200,
      stale: null,
      windows: [{
        label: 'Weekly',
        remainingPercent: 75,
        resetsAt: null,
        creditsAmount: null,
        creditsCurrency: null
      }]
    },
    layout: {
      compactLeading: 'mark',
      compactTrailing: 'percent',
      expanded: 'quota',
      lockScreen: 'combined',
      currencyCode: 'USD',
      languageCode: 'en'
    }
  });
});

test('registration rejects unremovable IDs and truncated or non-byte tokens', () => {
  for (const activityID of ['a/b', 'x'.repeat(129), {}, '', ['valid']]) {
    assert.throws(() => normalizeLiveActivityRegistration({ activityID, token: 'a'.repeat(64) }), /invalid_live_activity_registration/);
  }
  for (const token of ['a'.repeat(4098), 'a'.repeat(33), ['a'.repeat(64)]]) {
    assert.throws(() => normalizeLiveActivityRegistration({ activityID: 'valid', token }), /invalid_live_activity_registration/);
  }
});

for (const [runtime, api] of [
  ['Node', require('../../src/shared/liveActivity')],
  ['Worker', require('../../worker/src/shared/liveActivity')]
]) {
  const now = Date.parse('2026-10-05T00:00:00Z');
  const appleSeconds = (iso) => Date.parse(iso) / 1000 - 978307200;
  const registration = (preferences = {}) => ({
    locale: 'en', preferences: { ...basePreferences, liveProviderID: null, ...preferences }
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

  test(`${runtime} fifteen-minute age marks the source stale and sets stale-date`, () => {
    const stats = { updatedAt: '2026-10-04T23:40:00Z' }; // 20 minutes before now
    const state = api.buildLiveActivityContentState(stats, registration(), now);
    assert.equal(state.sourceStale, true);
    const fresh = api.buildLiveActivityContentState(
      { updatedAt: '2026-10-04T23:55:00Z' }, registration(), now
    );
    assert.equal(fresh.sourceStale, false);
    assert.equal(
      api.liveActivityStaleDate(fresh, now / 1000),
      Date.parse('2026-10-04T23:55:00Z') / 1000 + 900
    );
  });

  test(`${runtime} keeps reported zero separate from unknown tokens and cost`, () => {
    for (const value of [undefined, null, '', ' ', NaN, Infinity, 'invalid']) {
      const stats = { periods: { today: { totalTokens: value, costUsd: value } } };
      const state = api.buildLiveActivityContentState(stats, registration(), now);
      assert.equal(state.tokens, null);
      assert.equal(state.costUSD, null);
    }
    for (const value of [0, '0']) {
      const state = api.buildLiveActivityContentState({ periods: { today: { totalTokens: value, costUsd: value } } }, registration(), now);
      assert.equal(state.tokens, 0);
      assert.equal(state.costUSD, 0);
    }
  });

  test(`${runtime} quota carries its own freshness, never borrowing the usage source`, () => {
    const stats = {
      updatedAt: new Date(now).toISOString(),
      devices: [{ updatedAt: new Date(now).toISOString(), stale: false }],
      limits: { providers: [{
        provider: 'codex',
        status: 'ok',
        updatedAt: '2026-10-03T00:00:00Z',
        windows: [{ remainingPercent: 75 }]
      }] }
    };
    const state = api.buildLiveActivityContentState(stats, registration(), now);
    assert.equal(state.quota.providerID, 'codex');
    assert.equal(state.quota.updatedAt, appleSeconds('2026-10-03T00:00:00Z'));
    assert.equal(state.updatedAt, now / 1000 - 978307200);
    stats.limits.providers[0].stale = true;
    assert.equal(api.buildLiveActivityContentState(stats, registration(), now).quota.stale, true);
    for (const updatedAt of [undefined, 'invalid', '2099-01-01T00:00:00Z']) {
      stats.limits.providers[0].updatedAt = updatedAt;
      assert.equal(api.buildLiveActivityContentState(stats, registration(), now).quota.updatedAt, null);
    }
  });

  test(`${runtime} auto selection picks the lowest remaining among ok, non-stale providers`, () => {
    const stats = {
      limits: { providers: [
        { provider: 'cursor', status: 'notConfigured', windows: [{ remainingPercent: 5 }] },
        { provider: 'claude', status: 'ok', updatedAt: new Date(now).toISOString(), windows: [{ remainingPercent: 40 }] },
        { provider: 'codex', status: 'ok', updatedAt: new Date(now).toISOString(), windows: [{ remainingPercent: 10 }] },
        { provider: 'opencode', status: 'ok', stale: true, windows: [{ remainingPercent: 2 }] }
      ] }
    };
    const state = api.buildLiveActivityContentState(stats, registration(), now);
    // Cursor (notConfigured) and OpenCode (stale) are skipped despite lower usage.
    assert.equal(state.quota.providerID, 'codex');
  });

  test(`${runtime} auto selection ties and empty quota fall back to catalog order`, () => {
    const stats = {
      limits: { providers: [
        { provider: 'cursor', status: 'ok', windows: [] },
        { provider: 'codex', status: 'ok', windows: [{ remainingPercent: 50 }] },
        { provider: 'claude', status: 'ok', windows: [{ remainingPercent: 50 }] }
      ] }
    };
    const state = api.buildLiveActivityContentState(stats, registration(), now);
    assert.equal(state.quota.providerID, 'claude');
    const none = api.buildLiveActivityContentState(
      { limits: { providers: [{ provider: 'cursor', status: 'notConfigured' }] } },
      registration(), now
    );
    assert.equal(none.quota.providerID, 'cursor');
  });

  test(`${runtime} a specific provider id picks its lowest-remaining account`, () => {
    const stats = {
      limits: { providers: [
        { provider: 'codex', accountKey: 'a', windows: [{ remainingPercent: 90 }] },
        { provider: 'codex', accountKey: 'b', windows: [{ remainingPercent: 30 }] }
      ] }
    };
    const state = api.buildLiveActivityContentState(
      stats, registration({ liveProviderID: 'codex' }), now
    );
    assert.equal(state.quota.windows[0].remainingPercent, 30);
    const missing = api.buildLiveActivityContentState(
      stats, registration({ liveProviderID: 'cursor' }), now
    );
    assert.equal(missing.quota, null);
  });

  test(`${runtime} quota windows are canonical, capped at two and carry structured fields`, () => {
    const stats = {
      limits: { providers: [{
        provider: 'commandcode',
        planLabel: '',
        accountLabel: 'GOAT',
        windows: [
          { kind: 'session', remainingPercent: 70, resetsAt: '2026-10-05T05:00:00Z' },
          { kind: 'weekly', usedPercent: 50 },
          { kind: 'weekly', label: 'Promo', remainingPercent: 99, additional: true },
          { kind: 'daily', remainingPercent: 10 }
        ]
      }] }
    };
    const state = api.buildLiveActivityContentState(
      stats, registration({ liveProviderID: 'commandcode' }), now
    );
    assert.equal(state.quota.planLabel, 'GOAT');
    assert.deepEqual(state.quota.windows, [
      { label: '5-hour', remainingPercent: 70, resetsAt: appleSeconds('2026-10-05T05:00:00Z'), creditsAmount: null, creditsCurrency: null },
      { label: 'Weekly', remainingPercent: 50, resetsAt: null, creditsAmount: null, creditsCurrency: null }
    ]);
  });

  test(`${runtime} credits windows expose amount and currency without display-only meters`, () => {
    const stats = {
      limits: { providers: [{
        provider: 'deepseek',
        balance: { amount: 30, currency: 'USD', monthSpend: 10 },
        windows: [{ metric: 'credits' }]
      }] }
    };
    const before = structuredClone(stats);
    const state = api.buildLiveActivityContentState(
      stats, registration({ liveProviderID: 'deepseek', currencyCode: 'HKD' }), now
    );
    assert.equal(state.quota.windows[0].creditsAmount, 30);
    assert.equal(state.quota.windows[0].creditsCurrency, 'USD');
    assert.equal(state.quota.windows[0].remainingPercent, 75);
    assert.equal(state.layout.currencyCode, 'HKD');
    assert.deepEqual(stats, before);
    stats.limits.providers[0].windows[0] = { metric: 'credits', remaining: 0, currency: 'CNY' };
    const zero = api.buildLiveActivityContentState(
      stats, registration({ liveProviderID: 'deepseek' }), now
    );
    assert.equal(zero.quota.windows[0].creditsAmount, 0);
    assert.equal(zero.quota.windows[0].creditsCurrency, 'CNY');
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
}
