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
const { aggregateLimits } = require('../../src/shared/limits');
const { buildMacWidgetSnapshot } = require('../../src/shared/macWidgetSnapshot');
const { formatTrayText } = require('../../src/shared/trayText');

const projectRoot = path.join(__dirname, '..', '..');
const updatedAt = '2026-08-09T08:03:00.000Z';

function opencodeProvider({
  accountKey = 'shared-account',
  remainingPercent,
  source = 'local',
  windowSource = source,
  status = 'ok',
  providerUpdatedAt = updatedAt,
  balanceUsd = null
}) {
  return {
    provider: 'opencode',
    source,
    accountKey,
    status,
    updatedAt: providerUpdatedAt,
    windows: remainingPercent === null ? [] : [{
      kind: 'session',
      source: windowSource,
      usedPercent: 100 - remainingPercent
    }],
    balanceUsd
  };
}

function deviceWithProviders(deviceId, providers) {
  return {
    deviceId,
    updatedAt,
    limits: { updatedAt, providers }
  };
}

function statsWithDevices(devices) {
  const emptyPeriod = { totalTokens: 0, costUsd: 0, clients: {}, clientCosts: {}, models: {}, modelCosts: {} };
  return {
    updatedAt,
    staleAfterMs: 0,
    periods: {
      today: { ...emptyPeriod },
      month: { ...emptyPeriod },
      allTime: { ...emptyPeriod }
    },
    devices,
    limits: aggregateLimits(devices, 0, Date.parse(updatedAt))
  };
}

test('offline Hub cache filters local candidates before aggregation so a same-account remote estimate survives everywhere', () => {
  const remote = deviceWithProviders('remote-device', [opencodeProvider({
    remainingPercent: 60,
    providerUpdatedAt: '2026-08-09T08:01:00.000Z'
  })]);
  const local = deviceWithProviders('local-device', [opencodeProvider({
    remainingPercent: 20,
    providerUpdatedAt: '2026-08-09T08:02:00.000Z'
  })]);
  const cachedHubStats = statsWithDevices([remote, local]);

  assert.equal(cachedHubStats.limits.providers.length, 1);
  assert.equal(cachedHubStats.limits.providers[0].sourceDeviceId, 'local-device');
  assert.equal(cachedHubStats.limits.providers[0].windows[0].remainingPercent, 20);

  const visibleStats = projectLimitStatsForDisplay(cachedHubStats, {
    localDeviceId: 'LOCAL-DEVICE',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  });

  assert.notEqual(visibleStats, cachedHubStats);
  assert.equal(cachedHubStats.devices[1].limits.providers[0].status, 'ok');
  assert.equal(cachedHubStats.devices[1].limits.providers[0].windows.length, 1);
  assert.equal(visibleStats.devices[1].limits.providers[0].status, 'disabled');
  assert.equal(visibleStats.devices[1].limits.providers[0].windows.length, 0);
  assert.equal(visibleStats.limits.providers.length, 1);
  assert.equal(visibleStats.limits.providers[0].sourceDeviceId, 'remote-device');
  assert.equal(visibleStats.limits.providers[0].windows[0].remainingPercent, 60);

  const homeRows = homeLimitAccountsForProviders({
    providers: visibleStats.limits.providers,
    providerOptions: [{ id: 'opencode', label: 'OpenCode' }],
    enabledProviderIds: ['opencode'],
    colors: { opencode: '#9aa0aa' },
    limit: 5
  });
  assert.equal(homeRows.length, 1);
  assert.equal(homeRows[0].lowestRemaining, 60);

  assert.equal(formatTrayText(visibleStats, 'limitsAllSessions', 'USD', {
    limitProviderOrder: 'opencode',
    limitProviders: 'opencode',
    showLimitUsed: false
  }), '60%');

  const snapshot = buildMacWidgetSnapshot(visibleStats, {
    now: '2026-08-09T08:03:01.000Z'
  });
  const widgetWindows = snapshot.quota
    .filter((provider) => provider.provider === 'opencode')
    .flatMap((provider) => provider.windows);
  assert.deepEqual(widgetWindows.map((window) => window.remainingPercent), [60]);
});

test('mixed local and Web OpenCode provider removes only local windows and keeps Web status actionable', () => {
  const mixed = opencodeProvider({
    remainingPercent: 25,
    source: 'web',
    windowSource: 'local',
    balanceUsd: 5
  });
  mixed.windows.push({ kind: 'weekly', source: 'web', usedPercent: 10 });
  const rawStats = statsWithDevices([deviceWithProviders('local-device', [mixed])]);

  const visibleStats = projectLimitStatsForDisplay(rawStats, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  });
  const visible = visibleStats.limits.providers[0];

  assert.equal(rawStats.devices[0].limits.providers[0].windows.length, 2);
  assert.equal(visible.status, 'ok');
  assert.equal(visible.source, 'web');
  assert.equal(visible.balanceUsd, 5);
  assert.deepEqual(visible.windows.map((window) => [window.kind, window.source]), [['weekly', 'web']]);
});

test('legacy untagged windows fail closed only for the local device record', () => {
  const localLegacy = opencodeProvider({ remainingPercent: 25, source: 'web', windowSource: 'web' });
  const remoteLegacy = opencodeProvider({
    accountKey: 'remote-account',
    remainingPercent: 70,
    source: 'web',
    windowSource: 'web'
  });
  delete localLegacy.windows[0].source;
  delete remoteLegacy.windows[0].source;
  const rawStats = statsWithDevices([
    deviceWithProviders('local-device', [localLegacy]),
    deviceWithProviders('remote-device', [remoteLegacy])
  ]);

  const visibleStats = projectLimitStatsForDisplay(rawStats, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  });

  assert.equal(visibleStats.devices[0].limits.providers[0].status, 'disabled');
  assert.equal(visibleStats.devices[1], rawStats.devices[1]);
  assert.equal(visibleStats.limits.providers.some((provider) => provider.accountKey === 'remote-account'), true);
});

test('empty local notConfigured sentinel stays actionable instead of becoming Disabled', () => {
  const provider = opencodeProvider({ remainingPercent: null, status: 'notConfigured' });

  assert.equal(projectLimitProviderForDisplay(provider, {
    localDeviceProvider: true,
    opencodeLocalLimitsEnabled: false
  }), provider);
});

test('legacy aggregate provenance is conservative in sync mode and local in standalone mode', () => {
  const provider = opencodeProvider({ remainingPercent: 62 });

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
  const stats = statsWithDevices([deviceWithProviders('local-device', [opencodeProvider({
    remainingPercent: 75
  })])]);
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
