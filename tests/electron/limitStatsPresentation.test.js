'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  projectLimitProviderForDisplay,
  projectLimitStatsForDisplay
} = require('../../src/electron/limitStatsPresentation');
const { homeLimitAccountsForProviders } = require('../../src/electron/renderer/homeOverview');
const { formatTrayText } = require('../../src/shared/trayText');
const { buildMacWidgetSnapshot } = require('../../src/shared/macWidgetSnapshot');

const projectRoot = path.join(__dirname, '..', '..');

function statsWithProviders(providers) {
  const updatedAt = '2026-08-09T08:00:00.000Z';
  const emptyPeriod = { totalTokens: 0, costUsd: 0, clients: {}, clientCosts: {}, models: {}, modelCosts: {} };
  return {
    updatedAt,
    periods: {
      today: { ...emptyPeriod },
      month: { ...emptyPeriod },
      allTime: { ...emptyPeriod }
    },
    limits: { updatedAt, providers }
  };
}

function opencodeProvider({ deviceId, accountKey, remainingPercent, status = 'ok', stale = false }) {
  return {
    provider: 'opencode',
    source: 'local',
    sourceDeviceId: deviceId,
    accountKey,
    status,
    stale,
    windows: remainingPercent === null ? [] : [{
      kind: 'session',
      remainingPercent,
      usedPercent: 100 - remainingPercent
    }]
  };
}

test('offline Hub cache hides only this device local estimate across every Electron surface', () => {
  const local = opencodeProvider({
    deviceId: 'local-device',
    accountKey: 'local-account',
    remainingPercent: 75,
    stale: true
  });
  const remote = opencodeProvider({
    deviceId: 'remote-device',
    accountKey: 'remote-account',
    remainingPercent: 40
  });
  const cachedHubStats = statsWithProviders([local, remote]);

  const visibleStats = projectLimitStatsForDisplay(cachedHubStats, {
    localDeviceId: 'LOCAL-DEVICE',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  });

  assert.notEqual(visibleStats, cachedHubStats);
  assert.equal(cachedHubStats.limits.providers[0].status, 'ok');
  assert.equal(cachedHubStats.limits.providers[0].windows[0].remainingPercent, 75);
  assert.deepEqual(visibleStats.limits.providers[0], {
    ...local,
    status: 'disabled',
    stale: false,
    windows: [],
    balance: null,
    balanceUsd: null
  });
  assert.equal(visibleStats.limits.providers[1], remote);

  const homeRows = homeLimitAccountsForProviders({
    providers: visibleStats.limits.providers,
    providerOptions: [{ id: 'opencode', label: 'OpenCode' }],
    enabledProviderIds: ['opencode'],
    colors: { opencode: '#9aa0aa' },
    limit: 5
  });
  assert.equal(homeRows.length, 1);
  assert.equal(homeRows[0].providerId, 'opencode');
  assert.equal(homeRows[0].lowestRemaining, 40);

  assert.equal(formatTrayText(visibleStats, 'limitsAllSessions', 'USD', {
    limitProviderOrder: 'opencode',
    limitProviders: 'opencode',
    showLimitUsed: false
  }), '40%');

  const snapshot = buildMacWidgetSnapshot(visibleStats, {
    now: '2026-08-09T08:00:01.000Z'
  });
  const widgetWindows = snapshot.quota
    .filter((provider) => provider.provider === 'opencode')
    .flatMap((provider) => provider.windows);
  assert.deepEqual(widgetWindows.map((window) => window.remainingPercent), [40]);
  assert.equal(snapshot.quota.some((provider) => provider.status === 'disabled'), true);
});

test('empty local notConfigured sentinel stays actionable instead of becoming Disabled', () => {
  const provider = opencodeProvider({
    deviceId: 'local-device',
    accountKey: 'local-account',
    remainingPercent: null,
    status: 'notConfigured'
  });

  assert.equal(projectLimitProviderForDisplay(provider, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  }), provider);
});

test('legacy provenance is conservative in sync mode and local in standalone mode', () => {
  const provider = opencodeProvider({
    deviceId: '',
    accountKey: 'legacy-account',
    remainingPercent: 62
  });
  delete provider.sourceDeviceId;

  assert.equal(projectLimitProviderForDisplay(provider, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  }), provider);
  assert.equal(projectLimitProviderForDisplay(provider, {
    localDeviceId: 'local-device',
    syncActive: false,
    opencodeLocalLimitsEnabled: false
  }).status, 'disabled');
});

test('enabled fallback returns the original stats object without cloning', () => {
  const stats = statsWithProviders([opencodeProvider({
    deviceId: 'local-device',
    accountKey: 'local-account',
    remainingPercent: 75
  })]);
  assert.equal(projectLimitStatsForDisplay(stats, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: true
  }), stats);
});

test('Electron routes cached stats through the presentation projection', () => {
  const main = fs.readFileSync(path.join(projectRoot, 'src', 'electron', 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'electron', 'renderer', 'app.js'), 'utf8');

  assert.match(main, /function electronPresentationStats\(stats\)[\s\S]*projectLimitStatsForDisplay/);
  assert.match(main, /const visibleStats = electronPresentationStats\(latestStats\);[\s\S]*scheduleMacWidgetSnapshot\(visibleStats\)/);
  assert.match(main, /function updateTrayDisplay\(\)[\s\S]*formatTrayText\(visibleStats, mode/);
  assert.match(main, /function refreshLimitStatsPresentation\(\)[\s\S]*reason: 'presentation'/);
  assert.match(main, /ipcMain\.handle\('stats:get'[\s\S]*return electronPresentationStats\(stats\)/);
  assert.doesNotMatch(renderer, /function displayLimitProvider\(/);
  assert.match(renderer, /reason !== 'local' && payload\.data\?\.reason !== 'presentation'/);
});
