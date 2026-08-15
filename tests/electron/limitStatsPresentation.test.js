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
const { collectLimitsOnce: collectLimitsOnceRaw } = require('../../src/shared/limitCollector');
const { aggregateLimits } = require('../../src/shared/limits');
const { buildMacWidgetSnapshot } = require('../../src/shared/macWidgetSnapshot');
const { formatTrayText } = require('../../src/shared/trayText');

const projectRoot = path.join(__dirname, '..', '..');
const updatedAt = '2026-08-09T08:03:00.000Z';

// See tests/shared/limitCollector.opencode.test.js: the Go usage API needs no
// configuration, so it must be stubbed out or it reads the developer's own
// auth.json and probes opencode.ai.
const collectLimitsOnce = (options, deps = {}) => collectLimitsOnceRaw(options, {
  opencodeCollectGoApi: async () => ({ status: 'notConfigured', windows: [], identity: '' }),
  // Without this the ambient key adds a second account to every fixture here.
  opencodeReadGoApiKey: () => '',
  ...deps
});

function opencodeProvider({
  accountKey = 'shared-account',
  webAccountKey = '',
  accountKeyAliases = [],
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
    webAccountKey,
    accountKeyAliases,
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

function deviceWithProviders(deviceId, providers, extra = {}) {
  return {
    deviceId,
    updatedAt,
    limits: { updatedAt, providers },
    ...extra
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

// Snapshot of the limits fields retained by Hubs before component provenance
// was added. Collector output is already normalized, so this executable
// round-trip models the legacy schema boundary that stripped only the new
// private identity fields and windows[].source.
function roundTripThroughLegacyHub(summary) {
  return {
    ...summary,
    providers: summary.providers.map((provider) => {
      const { webAccountKey: _webAccountKey, accountKeyAliases: _accountKeyAliases, ...legacy } = provider;
      return {
        ...legacy,
        windows: provider.windows.map(({ source: _source, ...window }) => window)
      };
    })
  };
}

test('new pure-Web OpenCode quota survives a pre-provenance Hub round-trip', async () => {
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    {
      now: () => Date.parse(updatedAt),
      opencodeFetchGoWeb: async () => ({
        status: 'ok',
        workspaceId: 'workspace-web',
        windows: [{ kind: 'session', usedPercent: 30 }]
      }),
      opencodeFetchZen: async () => ({
        status: 'notConfigured',
        workspaceId: '',
        windows: [],
        balanceUsd: null
      })
    }
  );
  const legacyLimits = roundTripThroughLegacyHub(summary);
  const legacyProvider = legacyLimits.providers[0];
  assert.equal(legacyProvider.source, 'web');
  assert.equal(legacyProvider.sourceDetail, 'managed');
  assert.equal(Object.hasOwn(legacyProvider.windows[0], 'source'), false);
  assert.equal(Object.hasOwn(legacyProvider, 'webAccountKey'), false);
  assert.equal(Object.hasOwn(legacyProvider, 'accountKeyAliases'), false);

  const rawStats = statsWithDevices([
    deviceWithProviders('local-device', legacyLimits.providers)
  ]);
  const visibleStats = projectLimitStatsForDisplay(rawStats, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  });
  const visible = visibleStats.limits.providers[0];

  assert.equal(visible.status, 'ok');
  assert.equal(visible.source, 'web');
  assert.equal(visible.windows.length, 1);
  assert.equal(visible.windows[0].remainingPercent, 70);
});

test('mixed local and Web OpenCode quota fails closed through a pre-provenance Hub', async () => {
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeCookie: 'sess=1',
      opencodeLocalLimitsEnabled: true
    },
    {
      now: () => Date.parse(updatedAt),
      opencodeCollectGo: () => ({
        status: 'ok',
        identity: 'go:/local/opencode.db',
        windows: [{ kind: 'session', usedPercent: 75 }]
      }),
      opencodeFetchGoWeb: async () => ({
        status: 'unavailable',
        workspaceId: '',
        windows: []
      }),
      opencodeFetchZen: async () => ({
        status: 'ok',
        workspaceId: 'workspace-web',
        windows: [{ kind: 'weekly', usedPercent: 10 }],
        balanceUsd: 5
      })
    }
  );
  const collected = summary.providers[0];
  assert.equal(collected.source, 'local');
  assert.deepEqual(collected.windows.map((window) => window.source), ['local', 'web']);

  const legacyLimits = roundTripThroughLegacyHub(summary);
  assert.equal(legacyLimits.providers[0].source, 'local');
  assert.equal(legacyLimits.providers[0].sourceDetail, 'managed');
  assert.equal(legacyLimits.providers[0].windows.every((window) => !Object.hasOwn(window, 'source')), true);

  const rawStats = statsWithDevices([
    deviceWithProviders('local-device', legacyLimits.providers)
  ]);
  const visibleStats = projectLimitStatsForDisplay(rawStats, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  });
  const visibleDeviceProvider = visibleStats.devices[0].limits.providers[0];
  const visible = visibleStats.limits.providers[0];

  assert.equal(visibleDeviceProvider.windows.length, 0);
  assert.equal(visible.status, 'ok');
  assert.equal(visible.source, 'web');
  assert.equal(visible.windows.length, 0);
  assert.equal(visible.balanceUsd, 5);
});

test('pre-marker legacy mixed OpenCode record never trusts provider-level Web source', () => {
  // Shape captured from the pre-provenance collector: local Go won the quota
  // fallback, Zen added Web data, and the provider envelope became source:web.
  // The old schema has neither windows[].source nor the compatibility marker.
  const legacyMixed = {
    provider: 'opencode',
    accountKey: 'legacy-device-local-key',
    accountLabel: 'Go',
    source: 'web',
    sourceDetail: '',
    status: 'ok',
    updatedAt,
    windows: [
      { kind: 'session', usedPercent: 75 },
      { kind: 'weekly', usedPercent: 10 }
    ],
    balanceUsd: 5
  };
  const rawStats = statsWithDevices([
    deviceWithProviders('local-device', [legacyMixed])
  ]);
  const visibleStats = projectLimitStatsForDisplay(rawStats, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  });
  const visible = visibleStats.limits.providers[0];

  assert.equal(visible.status, 'ok');
  assert.equal(visible.source, 'web');
  assert.equal(visible.windows.length, 0);
  assert.equal(visible.balanceUsd, 5);
});

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
    localDeviceId: 'local-device',
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
    accountKey: 'local-db-key',
    webAccountKey: 'zen-web-key',
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
  assert.equal(visible.accountKey, 'zen-web-key');
  assert.equal(visible.balanceUsd, 5);
  assert.deepEqual(visible.windows.map((window) => [window.kind, window.source]), [['weekly', 'web']]);
});

test('mixed same-account observations merge Web balance with a remote local quota', () => {
  const local = opencodeProvider({
    accountKey: 'workspace-web-key',
    webAccountKey: 'workspace-web-key',
    accountKeyAliases: ['legacy-go-key', 'legacy-zen-key'],
    remainingPercent: 25,
    source: 'web',
    windowSource: 'local',
    providerUpdatedAt: '2026-08-09T08:02:00.000Z',
    balanceUsd: 5
  });
  local.windows.push({ kind: 'weekly', source: 'web', usedPercent: 10 });
  const remote = opencodeProvider({
    accountKey: 'legacy-go-key',
    remainingPercent: 60,
    source: 'web',
    windowSource: 'local',
    providerUpdatedAt: '2026-08-09T08:01:00.000Z',
    balanceUsd: 4
  });
  remote.windows.push({ kind: 'weekly', source: 'web', usedPercent: 20 });
  const rawStats = statsWithDevices([
    deviceWithProviders('remote-device', [remote]),
    deviceWithProviders('local-device', [local])
  ]);

  const visibleStats = projectLimitStatsForDisplay(rawStats, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  });
  const providers = visibleStats.limits.providers.filter((provider) => provider.provider === 'opencode');

  assert.equal(providers.length, 1);
  assert.equal(providers[0].accountKey, 'workspace-web-key');
  assert.equal(providers[0].balanceUsd, 5);
  assert.equal(providers[0].windows.find((window) => window.kind === 'session').remainingPercent, 60);
  assert.equal(providers[0].windows.find((window) => window.kind === 'weekly').remainingPercent, 90);
});

test('device identity stays case-sensitive so a differently-cased remote device is preserved', () => {
  const rawStats = statsWithDevices([
    deviceWithProviders('MacBook', [opencodeProvider({ accountKey: 'local', remainingPercent: 20 })]),
    deviceWithProviders('macbook', [opencodeProvider({ accountKey: 'remote', remainingPercent: 70 })])
  ]);

  const visibleStats = projectLimitStatsForDisplay(rawStats, {
    localDeviceId: 'MacBook',
    syncActive: true,
    opencodeLocalLimitsEnabled: false
  });

  assert.equal(visibleStats.devices.find((device) => device.deviceId === 'MacBook').limits.providers[0].status, 'disabled');
  assert.equal(visibleStats.devices.find((device) => device.deviceId === 'macbook').limits.providers[0].status, 'ok');
  assert.equal(visibleStats.limits.providers.find((provider) => provider.accountKey === 'remote').windows[0].remainingPercent, 70);
});

test('legacy Hub projection keeps default-threshold OpenCode fresh without an upload interval', () => {
  const nowMs = Date.parse('2026-08-09T08:40:00.000Z');
  const remoteUpdatedAt = '2026-08-09T08:35:00.000Z';
  const devices = [
    deviceWithProviders('remote-device', [opencodeProvider({
      accountKey: 'remote',
      remainingPercent: 60,
      providerUpdatedAt: remoteUpdatedAt
    })], {
      updatedAt: remoteUpdatedAt,
      receivedAt: remoteUpdatedAt
    }),
    deviceWithProviders('local-device', [opencodeProvider({
      accountKey: 'local',
      remainingPercent: 20,
      providerUpdatedAt: new Date(nowMs).toISOString()
    })], {
      updatedAt: new Date(nowMs).toISOString(),
      receivedAt: new Date(nowMs).toISOString()
    })
  ];
  devices[0].limits.refreshMs = 60 * 1000;
  const rawStats = statsWithDevices(devices);
  rawStats.limits = aggregateLimits(devices, 10 * 60 * 1000, nowMs);
  delete rawStats.staleAfterMs;

  const visibleStats = projectLimitStatsForDisplay(rawStats, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: false,
    nowMs
  });

  const remote = visibleStats.limits.providers.find((provider) => provider.accountKey === 'remote');
  assert.equal(remote?.stale, false);
  assert.equal(remote?.windows[0].remainingPercent, 60);
});

test('legacy Hub projection keeps interval-synced OpenCode fresh and preserves other provider aggregates', () => {
  const nowMs = Date.parse('2026-08-09T08:40:00.000Z');
  const remoteOpenCode = opencodeProvider({
    accountKey: 'remote',
    remainingPercent: 60,
    providerUpdatedAt: '2026-08-09T08:15:00.000Z'
  });
  const devices = [
    deviceWithProviders('remote-device', [remoteOpenCode], {
      updatedAt: '2026-08-09T08:15:00.000Z',
      receivedAt: '2026-08-09T08:15:00.000Z',
      syncUploadIntervalMs: 20 * 60 * 1000
    }),
    deviceWithProviders('local-device', [opencodeProvider({ accountKey: 'local', remainingPercent: 20 })])
  ];
  const rawStats = statsWithDevices(devices);
  rawStats.limits = aggregateLimits(devices, 10 * 60 * 1000, nowMs);
  rawStats.limits.providers.push({ provider: 'codex', status: 'ok', source: 'rpc', accountKey: 'unchanged' });
  delete rawStats.staleAfterMs;
  const originalCodex = rawStats.limits.providers.find((provider) => provider.provider === 'codex');

  const visibleStats = projectLimitStatsForDisplay(rawStats, {
    localDeviceId: 'local-device',
    syncActive: true,
    opencodeLocalLimitsEnabled: false,
    nowMs
  });

  assert.equal(visibleStats.limits.providers.find((provider) => provider.accountKey === 'remote').stale, false);
  assert.equal(visibleStats.limits.providers.find((provider) => provider.provider === 'codex'), originalCodex);
});

test('legacy untagged windows fall back to provider source only for the local device record', () => {
  const localLegacy = opencodeProvider({ remainingPercent: 25, source: 'local', windowSource: 'local' });
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
  assert.match(
    main,
    /const visibleStats = electronPresentationStats\(latestStats\);[\s\S]*scheduleMacWidgetSnapshot\(visibleStats, options\.widgetProducerOwner\)/
  );
  assert.match(main, /function updateTrayDisplay\(\)[\s\S]*formatTrayText\(visibleStats, mode/);
  assert.match(main, /function refreshLimitStatsPresentation\(\)[\s\S]*reason: 'presentation'/);
  assert.match(main, /ipcMain\.handle\('stats:get'[\s\S]*return electronPresentationStats\(stats\)/);
  assert.doesNotMatch(renderer, /function displayLimitProvider\(/);
  assert.match(renderer, /reason !== 'local' && payload\.data\?\.reason !== 'presentation'/);
});
