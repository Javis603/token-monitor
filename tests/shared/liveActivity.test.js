'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLiveActivityContentState,
  normalizeLiveActivityRegistration
} = require('../../src/shared/liveActivity');

const basePreferences = {
  liveActivityEnabled: true,
  hiddenLimitProviders: [],
  providerIDs: [],
  accountKeys: []
};

test('normalizes a Live Activity registration without retaining presentation or arbitrary preferences', () => {
  const registration = normalizeLiveActivityRegistration({
    activityID: 'activity-1',
    token: 'A'.repeat(64),
    locale: 'en-US',
    preferences: {
      ...basePreferences,
      hiddenLimitProviders: ['Cursor', 'cursor', '', 42, 'opencode'],
      providerIDs: ['Claude', 'claude'],
      accountKeys: [' key-1 ', 7],
      liveProviderID: 'codex',
      liveCompactLeading: 'ring',
      languageCode: 'en',
      unexpected: 'should not persist'
    }
  });

  assert.equal(registration.activityID, 'activity-1');
  assert.equal(registration.token, 'a'.repeat(64));
  assert.equal(registration.locale, undefined);
  assert.deepEqual(registration.preferences, {
    ...basePreferences,
    hiddenLimitProviders: ['cursor', 'opencode'],
    providerIDs: ['claude'],
    accountKeys: ['key-1']
  });
});

test('builds a compact ContentState v4 — data only, null fields omitted', () => {
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
        windows: [{ kind: 'weekly', usedPercent: 25, remainingPercent: 75, windowMinutes: 10080 }]
      }]
    }
  };

  const state = buildLiveActivityContentState(
    stats,
    normalizeLiveActivityRegistration({
      activityID: 'activity-1',
      token: 'a'.repeat(64),
      preferences: basePreferences
    }),
    Date.parse('2026-08-01T00:00:00.000Z')
  );

  assert.deepEqual(state, {
    updatedAt: 807235200,
    sourceStale: false,
    usage: {
      today: { tokens: 62_800_000, costUSD: 2.5 },
      month: {}
    },
    quotas: [{
      providerID: 'codex',
      planLabel: 'Plus',
      updatedAt: 807235200,
      windows: [{
        label: 'Weekly',
        kind: 'weekly',
        remainingPercent: 75,
        windowMinutes: 10080
      }]
    }],
    agents: { running: 0, clients: [] }
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
    preferences: { ...basePreferences, ...preferences }
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
      assert.equal(state.usage.today.tokens, undefined);
      assert.equal(state.usage.today.costUSD, undefined);
    }
    for (const value of [0, '0']) {
      const state = api.buildLiveActivityContentState({ periods: { today: { totalTokens: value, costUsd: value } } }, registration(), now);
      assert.equal(state.usage.today.tokens, 0);
      assert.equal(state.usage.today.costUSD, 0);
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
    assert.equal(state.quotas[0].providerID, 'codex');
    assert.equal(state.quotas[0].updatedAt, appleSeconds('2026-10-03T00:00:00Z'));
    assert.equal(state.updatedAt, now / 1000 - 978307200);
    stats.limits.providers[0].stale = true;
    assert.equal(api.buildLiveActivityContentState(stats, registration(), now).quotas[0].stale, true);
    for (const updatedAt of [undefined, 'invalid', '2099-01-01T00:00:00Z']) {
      stats.limits.providers[0].updatedAt = updatedAt;
      assert.equal(api.buildLiveActivityContentState(stats, registration(), now).quotas[0].updatedAt, undefined);
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
    assert.equal(state.quotas[0].providerID, 'codex');
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
    assert.equal(state.quotas[0].providerID, 'claude');
    const none = api.buildLiveActivityContentState(
      { limits: { providers: [{ provider: 'cursor', status: 'notConfigured' }] } },
      registration(), now
    );
    assert.equal(none.quotas[0].providerID, 'cursor');
  });

  test(`${runtime} named providers and accounts ride along with the ranked records`, () => {
    const stats = {
      limits: { providers: [
        { provider: 'codex', accountKey: 'a', windows: [{ remainingPercent: 90 }] },
        { provider: 'codex', accountKey: 'b', windows: [{ remainingPercent: 30 }] },
        { provider: 'claude', windows: [{ remainingPercent: 10 }] },
        { provider: 'kiro', windows: [{ remainingPercent: 20 }] },
        { provider: 'cursor', windows: [{ remainingPercent: 95 }] },
        { provider: 'zai', accountKey: 'z', windows: [{ remainingPercent: 99 }] }
      ] }
    };
    const ranked = api.buildLiveActivityContentState(stats, registration(), now);
    assert.deepEqual(ranked.quotas.map((quota) => quota.providerID), ['claude', 'kiro', 'codex']);
    assert.equal(ranked.quotas[2].accountKey, 'b');
    const named = api.buildLiveActivityContentState(
      stats, registration({ providerIDs: ['cursor', 'codex'], accountKeys: ['z'] }), now
    );
    assert.deepEqual(
      named.quotas.map((quota) => `${quota.providerID}:${quota.accountKey || ''}`),
      ['claude:', 'kiro:', 'codex:b', 'cursor:', 'codex:a', 'zai:z']
    );
  });

  test(`${runtime} quota windows are canonical, capped at three and carry structured fields`, () => {
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
    const state = api.buildLiveActivityContentState(stats, registration(), now);
    assert.equal(state.quotas[0].planLabel, 'GOAT');
    assert.deepEqual(state.quotas[0].windows, [
      { label: '5-hour', kind: 'session', remainingPercent: 70, resetsAt: appleSeconds('2026-10-05T05:00:00Z') },
      { label: 'Weekly', kind: 'weekly', remainingPercent: 50 },
      { label: 'Daily', kind: 'daily', remainingPercent: 10 }
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
      stats, registration(), now
    );
    assert.equal(state.quotas[0].windows[0].creditsAmount, 30);
    assert.equal(state.quotas[0].windows[0].creditsCurrency, 'USD');
    assert.equal(state.quotas[0].windows[0].remainingPercent, 75);
    assert.deepEqual(stats, before);
    stats.limits.providers[0].windows[0] = { metric: 'credits', remaining: 0, currency: 'CNY' };
    const zero = api.buildLiveActivityContentState(
      stats, registration(), now
    );
    assert.equal(zero.quotas[0].windows[0].creditsAmount, 0);
    assert.equal(zero.quotas[0].windows[0].creditsCurrency, 'CNY');
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

  test(`${runtime} ranks three quotas with hidden providers out`, () => {
    const stats = {
      limits: { providers: [
        { provider: 'cursor', status: 'ok', windows: [{ remainingPercent: 1 }] },
        { provider: 'claude', status: 'ok', windows: [{ remainingPercent: 40 }] },
        { provider: 'codex', status: 'ok', windows: [{ remainingPercent: 10 }] },
        { provider: 'opencode', status: 'ok', stale: true, windows: [{ remainingPercent: 2 }] },
        { provider: 'kiro', status: 'ok', windows: [{ remainingPercent: 60 }] }
      ] }
    };
    const auto = api.buildLiveActivityContentState(
      stats, registration({ hiddenLimitProviders: ['cursor'] }), now
    );
    assert.deepEqual(auto.quotas.map((quota) => quota.providerID), ['codex', 'claude', 'kiro']);
  });

  test(`${runtime} the most recent client carries its own share of usage and its quota`, () => {
    const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
    const stats = {
      periods: {
        today: {
          clients: { cursor: 400, claude: 900 },
          clientCosts: { cursor: 1.25 },
          sessions: {
            'claude:a': { client: 'claude', lastUsedAt: at(30) },
            'cursor:b': { client: 'cursor', lastUsedAt: at(2), turnEnded: true }
          }
        },
        month: { clients: { cursor: 4000 } }
      },
      limits: { providers: [
        { provider: 'claude', windows: [{ remainingPercent: 10 }] },
        { provider: 'codex', windows: [{ remainingPercent: 20 }] },
        { provider: 'kiro', windows: [{ remainingPercent: 30 }] },
        { provider: 'cursor', windows: [{ remainingPercent: 90 }] }
      ] }
    };
    const state = api.buildLiveActivityContentState(stats, registration(), now);
    assert.deepEqual(state.recent, {
      client: 'cursor',
      today: { tokens: 400, costUSD: 1.25 },
      month: { tokens: 4000 }
    });
    assert.deepEqual(state.quotas.map((quota) => quota.providerID), ['claude', 'codex', 'kiro', 'cursor']);
    assert.equal(api.buildLiveActivityContentState({}, registration(), now).recent, undefined);
  });

  test(`${runtime} output speed only counts timed output, capped at the period output`, () => {
    const period = { timedOutputTokens: 1000, timedDurationMs: 20_000, outputTokens: 500 };
    let state = api.buildLiveActivityContentState({ periods: { today: period } }, registration(), now);
    assert.equal(state.usage.today.outputTPS, 25);
    for (const changes of [{ timedDurationMs: 0 }, { timedOutputTokens: 0 }, { capabilities: { throughput: false } }]) {
      state = api.buildLiveActivityContentState({ periods: { today: { ...period, ...changes } } }, registration(), now);
      assert.equal(state.usage.today.outputTPS, undefined);
    }
  });

  test(`${runtime} counts running sessions once and schedules the refresh at the earliest expiry`, () => {
    const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
    const stats = {
      periods: {
        today: { sessions: {
          'claude:a': { client: 'claude', lastUsedAt: at(1) },
          'codex:b': { client: 'codex', lastUsedAt: at(4) },
          'claude:c': { client: 'claude', lastUsedAt: at(2) },
          'claude:done': { client: 'claude', lastUsedAt: at(1), turnEnded: true },
          'cursor:old': { client: 'cursor', lastUsedAt: at(30) },
          'codex:gone': { client: 'codex', lastUsedAt: at(1), archived: true }
        } },
        month: { sessions: { 'claude:a': { client: 'claude', lastUsedAt: at(1) } } }
      }
    };
    const state = api.buildLiveActivityContentState(stats, registration(), now);
    assert.deepEqual(state.agents, { running: 3, clients: ['claude', 'codex'] });
    assert.equal(api.liveActivityRefreshAt(stats, now), now - 4 * 60_000 + 10 * 60_000 + 1);
    assert.equal(api.liveActivityRefreshAt({ periods: {} }, now), null);
  });
}
