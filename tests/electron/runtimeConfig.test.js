'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifySettingsChange,
  diagnosticConfigurationFromSettings,
  envelopeFromSettings,
  limitsConfigFromSettings,
  normalizeAllTimeSince,
  usageConfigFromSettings
} = require('../../src/electron/runtimeConfig');

test('all-time dates are normalized before entering the usage runtime', () => {
  assert.equal(normalizeAllTimeSince('2026-02-28'), '2026-02-28');
  assert.equal(normalizeAllTimeSince('2026-02-30'), '2024-01-01');
  assert.equal(normalizeAllTimeSince('not-a-date'), '2024-01-01');
});

test('diagnostic configuration projects effective normalized values without credentials', () => {
  const configuration = diagnosticConfigurationFromSettings({
    allTimeSince: '2026-02-30',
    historyEnabled: false,
    historyIntervalMs: 'invalid',
    projectsEnabled: false,
    wslScanEnabled: false,
    syncUploadIntervalMs: 'invalid',
    limitsRefreshMs: 'invalid',
    claudeWebCookie: 'sessionKey=secret',
    deepseekApiKey: 'deepseek-secret',
    hubHostSecret: 'hub-secret'
  }, {
    usage: { historyIntervalMs: 'invalid' },
    limits: { env: {}, defaultLimitProviders: 'kimi,zai' },
    syncUploadIntervalMs: 20 * 60 * 1000
  });

  assert.deepEqual(configuration, {
    configurationSource: 'effective-normalized',
    allTimeSince: '2024-01-01',
    historyEnabled: false,
    historyIntervalMs: 15 * 60 * 1000,
    projectsEnabled: false,
    wslScanEnabled: false,
    syncUploadIntervalMs: 20 * 60 * 1000,
    limitsRefreshMs: 5 * 60 * 1000
  });
  assert.equal(JSON.stringify(configuration).includes('secret'), false);
});

test('diagnostic configuration preserves a custom all-time date and false flags', () => {
  const configuration = diagnosticConfigurationFromSettings({
    allTimeSince: '2025-06-01',
    historyEnabled: false,
    historyIntervalMs: 60 * 60 * 1000,
    projectsEnabled: false,
    wslScanEnabled: false,
    syncUploadIntervalMs: 0,
    limitsRefreshMs: 60 * 1000
  }, { limits: { env: {}, defaultLimitProviders: 'kimi' } });

  assert.equal(configuration.allTimeSince, '2025-06-01');
  assert.equal(configuration.historyEnabled, false);
  assert.equal(configuration.projectsEnabled, false);
  assert.equal(configuration.wslScanEnabled, false);
  assert.equal(configuration.historyIntervalMs, 60 * 60 * 1000);
  assert.equal(configuration.syncUploadIntervalMs, 0);
  assert.equal(configuration.limitsRefreshMs, 60 * 1000);
});

test('runtime config keeps usage, limits credentials, and envelope in separate inputs', () => {
  const settings = {
    deviceId: 'device-1',
    clients: 'claude,cursor',
    collectionIntervalMs: 300000,
    limitsRefreshMs: 60000,
    claudeWebCookie: 'sessionKey=settings-secret',
    kimiApiKey: 'secret',
    openrouterProfiles: { work: { apiKey: 'openrouter-secret', enabled: true } },
    thirdPartyProfiles: {
      relay: {
        adapter: 'newapi-account',
        baseUrl: 'https://api.example.com',
        accessToken: 'access-secret',
        userId: '42',
        enabled: true
      }
    },
    zaiApiRegion: 'bigmodel-cn'
  };
  const usage = usageConfigFromSettings(settings, {
    agentVersion: '1.2.3',
    intervalMs: 120000,
    historyIntervalMs: 900000,
    watchEnabled: true
  });
  const limits = limitsConfigFromSettings(settings, { env: {}, defaultLimitProviders: 'kimi,zai' });
  const envelope = envelopeFromSettings(settings, { agentVersion: '1.2.3' });

  assert.equal(usage.intervalMs, 120000);
  assert.equal(Object.hasOwn(usage, 'kimiApiKey'), false);
  assert.equal(limits.claudeWebCookie, 'sessionKey=settings-secret');
  assert.equal(limits.kimiApiKey, 'secret');
  assert.deepEqual(limits.openrouterProfiles, { work: { apiKey: 'openrouter-secret', enabled: true } });
  assert.deepEqual(limits.thirdPartyProfiles, {
    relay: {
      adapter: 'newapi-account',
      baseUrl: 'https://api.example.com',
      accessToken: 'access-secret',
      userId: '42',
      enabled: true
    }
  });
  assert.equal(Object.hasOwn(limits, 'clients'), false);
  assert.deepEqual(envelope, {
    deviceId: 'device-1',
    agentVersion: '1.2.3',
    agentRuntime: 'electron-widget'
  });
});

test('limits config resolves managed credentials at dispatch time through context', () => {
  const limits = limitsConfigFromSettings({ codexManagedAccounts: [{ id: 'stale' }] }, {
    env: {},
    codexManagedAccounts: [{ id: 'live', homePath: '/tmp/live' }],
    mimoManagedAccounts: [{ id: 'mimo', cookieHeader: 'allowlisted' }]
  });
  assert.deepEqual(limits.codexManagedAccounts, [{ id: 'live', homePath: '/tmp/live' }]);
  assert.deepEqual(limits.mimoManagedAccounts, [{ id: 'mimo', cookieHeader: 'allowlisted' }]);
});

test('desktop WorkBuddy Local App monitoring is opt-in by default', () => {
  const limits = limitsConfigFromSettings({}, { env: {}, workbuddyDesktopSessionOnly: true });
  assert.equal(limits.workbuddyLocalAppEnabled, false);
  assert.equal(limits.workbuddyAccessToken, '');
  assert.equal(Object.hasOwn(limits, 'workbuddyEndpoint'), false);
});

test('desktop WorkBuddy Local App monitoring resolves session metadata only when enabled', () => {
  const limits = limitsConfigFromSettings({}, {
    env: {},
    workbuddyDesktopSessionOnly: true,
    workbuddyLocalAppEnabled: true,
    workbuddyLocalSession: {
      userId: 'local-user',
      enterpriseId: 'local-enterprise',
      accountType: 'enterprise'
    }
  });
  assert.equal(limits.workbuddyLocalAppEnabled, true);
  assert.equal(limits.workbuddyUserId, 'local-user');
  assert.equal(limits.workbuddyEnterpriseId, 'local-enterprise');
  assert.equal(limits.workbuddyAccountType, 'enterprise');
  assert.equal(limits.workbuddyAccessToken, '');
});

test('desktop WorkBuddy auth reads can be disabled without enabling fallback credentials', () => {
  const limits = limitsConfigFromSettings({
    workbuddyAccessToken: 'legacy-settings-token',
    workbuddyUserId: 'legacy-user'
  }, {
    env: {
      TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN: 'env-token',
      TOKEN_MONITOR_WORKBUDDY_USER_ID: 'env-user'
    },
    workbuddyDesktopSessionOnly: true,
    workbuddyLocalAppEnabled: false,
    workbuddyLocalSession: { userId: 'local-user', accountType: 'personal' }
  });
  assert.equal(limits.workbuddyLocalAppEnabled, false);
  assert.equal(limits.workbuddyAccessToken, '');
  assert.equal(limits.workbuddyUserId, '');
  assert.equal(limits.workbuddyAccountType, '');
});

test('desktop WorkBuddy config ignores legacy settings and environment credentials', () => {
  const limits = limitsConfigFromSettings({
    workbuddyAccessToken: 'legacy-settings-token',
    workbuddyUserId: 'legacy-user',
  }, {
    env: {
      TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN: 'env-token',
      TOKEN_MONITOR_WORKBUDDY_USER_ID: 'env-user'
    },
    workbuddyDesktopSessionOnly: true,
    workbuddyLocalAppEnabled: false
  });
  assert.equal(limits.workbuddyAccessToken, '');
  assert.equal(limits.workbuddyUserId, '');
  assert.equal(limits.workbuddyLocalAppEnabled, false);
});

test('settings classifier separates structural, limits reconfigure, sink, and provider invalidation changes', () => {
  const previous = {
    hubMode: 'local',
    clients: 'claude',
    limitsRefreshMs: 300000,
    syncUploadIntervalMs: 0,
    kimiApiKey: 'old'
  };
  const next = {
    ...previous,
    clients: 'claude,cursor',
    limitsRefreshMs: 60000,
    syncUploadIntervalMs: 600000,
    kimiApiKey: 'new'
  };
  const classification = classifySettingsChange(previous, next);
  assert.equal(classification.modeStructural, false);
  assert.equal(classification.usageStructural, true);
  assert.equal(classification.limitsReconfigure, true);
  assert.equal(classification.sinkStructural, true);
  assert.deepEqual(classification.limitScopes, [{ provider: 'kimi' }]);
});

test('display-only settings do not restart producers or probe providers', () => {
  const classification = classifySettingsChange(
    { currency: 'USD', theme: 'dark' },
    { currency: 'HKD', theme: 'light' }
  );
  assert.equal(classification.modeStructural, false);
  assert.equal(classification.usageStructural, false);
  assert.equal(classification.limitsReconfigure, false);
  assert.equal(classification.sinkStructural, false);
  assert.deepEqual(classification.limitScopes, []);
});

test('OpenRouter profile changes invalidate only the OpenRouter limits lane', () => {
  const classification = classifySettingsChange(
    { openrouterProfiles: { work: { apiKey: 'old', enabled: true } } },
    { openrouterProfiles: { work: { apiKey: 'new', enabled: true } } }
  );
  assert.deepEqual(classification.limitScopes, [{ provider: 'openrouter' }]);
});

test('WorkBuddy Local App opt-in changes invalidate only the WorkBuddy limits lane', () => {
  const classification = classifySettingsChange(
    { workbuddyLocalAppEnabled: false },
    { workbuddyLocalAppEnabled: true }
  );
  assert.deepEqual(classification.limitScopes, [{ provider: 'workbuddy' }]);
});

test('Claude Web cookie falls back to env and invalidates only the Claude limits lane', () => {
  const limits = limitsConfigFromSettings({}, {
    env: { CLAUDE_WEB_COOKIE: 'sessionKey=env-secret' }
  });
  assert.equal(limits.claudeWebCookie, 'sessionKey=env-secret');

  const classification = classifySettingsChange(
    { claudeWebCookie: '' },
    { claudeWebCookie: 'sessionKey=settings-secret' }
  );
  assert.deepEqual(classification.limitScopes, [{ provider: 'claude' }]);
  assert.equal(classification.limitsReconfigure, false);
});

test('OpenCode local limits are explicit and invalidate the OpenCode lane', () => {
  assert.equal(limitsConfigFromSettings({}, { env: {} }).opencodeLocalLimitsEnabled, false);
  const limits = limitsConfigFromSettings({ opencodeLocalLimitsEnabled: false }, { env: {} });
  assert.equal(limits.opencodeLocalLimitsEnabled, false);

  const classification = classifySettingsChange(
    { opencodeLocalLimitsEnabled: false },
    { opencodeLocalLimitsEnabled: true }
  );
  assert.equal(classification.limitsReconfigure, true);
  assert.deepEqual(classification.limitScopes, [{ provider: 'opencode' }]);
});

test('third-party profile changes invalidate only the third-party limits lane', () => {
  const classification = classifySettingsChange(
    {
      thirdPartyProfiles: {
        work: { adapter: 'newapi-token', baseUrl: 'https://old.example', apiKey: 'old', enabled: true }
      }
    },
    {
      thirdPartyProfiles: {
        work: { adapter: 'newapi-token', baseUrl: 'https://new.example', apiKey: 'new', enabled: true }
      }
    }
  );
  assert.deepEqual(classification.limitScopes, [{ provider: 'thirdparty' }]);
});
