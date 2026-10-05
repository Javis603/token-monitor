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
