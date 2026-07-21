'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifySettingsChange,
  envelopeFromSettings,
  limitsConfigFromSettings,
  usageConfigFromSettings
} = require('../../src/electron/runtimeConfig');

test('runtime config keeps usage, limits credentials, and envelope in separate inputs', () => {
  const settings = {
    deviceId: 'device-1',
    clients: 'claude,cursor',
    collectionIntervalMs: 300000,
    limitsRefreshMs: 60000,
    kimiApiKey: 'secret',
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
  assert.equal(limits.kimiApiKey, 'secret');
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
