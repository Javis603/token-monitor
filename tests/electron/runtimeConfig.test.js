'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    limitsRefreshMode: 'fixed',
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

// The widget and the headless agent are two entry points onto one collector, so
// a setting that only one of them resolves is a documented switch that silently
// does nothing on the other. That is what happened to the auto-detected OpenCode
// account: `.env.example` offered the opt-out, the widget honoured it, and the
// agent passed nothing, so an unattended machine kept reporting the account.
test('every OpenCode limits switch the widget honours reaches the headless agent', () => {
  const root = path.resolve(__dirname, '../..');
  const agent = fs.readFileSync(path.join(root, 'src/agent/agent.js'), 'utf8');
  const start = agent.indexOf('const limitsOptions = {');
  assert.ok(start >= 0, 'agent.js should build a limitsOptions object');
  const limitsOptions = agent.slice(start, agent.indexOf('\n};', start));

  // Saved GUI accounts, which the agent has no equivalent of: its credentials
  // come from the environment, and `opencodeCookie` is how they arrive.
  const guiOnly = new Set(['opencodeProfiles']);
  const keys = Object.keys(limitsConfigFromSettings({}, { env: {} }))
    .filter((key) => key.startsWith('opencode') && !guiOnly.has(key));
  assert.ok(keys.length >= 3, 'expected the OpenCode limits options to be discoverable');
  for (const key of keys) {
    assert.match(limitsOptions, new RegExp(`\\b${key}\\b`), `${key} never reaches the agent`);
  }

  // Resolved from the variable `.env.example` documents, with the same default
  // as the widget: on, because the key needs no configuration.
  assert.match(agent, /process\.env\.TOKEN_MONITOR_OPENCODE_AMBIENT/);
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(envExample, /^TOKEN_MONITOR_OPENCODE_AMBIENT=/m);
  assert.equal(limitsConfigFromSettings({}, { env: {} }).opencodeAmbientEnabled, true);
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
