'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  isCodexLiveAccount,
  limitProviderCapabilityTags,
  limitProviderMainDeviceLabel,
  limitProviderProvenance,
  limitProviderSettingsTags
} = require('../../src/electron/renderer/limitProviderPresentation');

test('isCodexLiveAccount marks the live system login but not managed-added accounts', () => {
  assert.equal(isCodexLiveAccount({ provider: 'codex', status: 'ok', sourceDetail: 'app' }), true);
  assert.equal(isCodexLiveAccount({ provider: 'codex', status: 'ok', sourceDetail: 'cli' }), true);
  assert.equal(isCodexLiveAccount({ provider: 'codex', status: 'ok', sourceDetail: 'managed' }), false);
});

test('isCodexLiveAccount is false for other providers and unconfigured codex rows', () => {
  assert.equal(isCodexLiveAccount({ provider: 'claude', status: 'ok', sourceDetail: 'cli' }), false);
  assert.equal(isCodexLiveAccount({ provider: 'codex', status: 'notConfigured', sourceDetail: 'app' }), false);
  assert.equal(isCodexLiveAccount(null), false);
});

test('isCodexLiveAccount only marks the local live login, not a synced remote device\'s', () => {
  const liveProvider = { provider: 'codex', status: 'ok', sourceDetail: 'app' };
  assert.equal(isCodexLiveAccount(liveProvider, { selectedIsRemote: false }), true);
  assert.equal(isCodexLiveAccount(liveProvider, { selectedIsRemote: true, hasLocalCandidate: false }), false);
});

test('isCodexLiveAccount stays marked when both devices are signed in but the remote record is selected', () => {
  const liveProvider = { provider: 'codex', status: 'ok', sourceDetail: 'app' };
  assert.equal(isCodexLiveAccount(liveProvider, { selectedIsRemote: true, hasLocalCandidate: true }), true);
});

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  return source.slice(start, end);
}

test('capability tags explain how each provider is collected in settings', () => {
  assert.deepEqual(limitProviderCapabilityTags('claude'), ['Auto', 'OAuth/CLI']);
  assert.deepEqual(limitProviderCapabilityTags('codex'), ['Auto', 'App/CLI RPC']);
  assert.deepEqual(limitProviderCapabilityTags('cursor'), ['Manual login', 'Web']);
  assert.deepEqual(limitProviderCapabilityTags('antigravity'), ['App/CLI must be open', 'RPC']);
  assert.deepEqual(limitProviderCapabilityTags('opencode'), ['Local/Web', 'Manual login']);
  assert.deepEqual(limitProviderCapabilityTags('unknown'), []);
});

test('undetected settings tags include status and supported collection hints', () => {
  // Antigravity's "App/CLI must be open" capability restates the notConfigured
  // status ("Open app or CLI"), so it is dropped to avoid a duplicate tag.
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'antigravity', status: 'notConfigured', source: 'rpc' })
      .map((tag) => tag.label),
    ['Open app or CLI', 'RPC']
  );
  // Other failure states don't say "Open app or CLI", so the hint stays useful.
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'antigravity', status: 'unavailable', source: 'rpc' })
      .map((tag) => tag.label),
    ['Unavailable', 'App/CLI must be open', 'RPC']
  );
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'cursor', status: 'notConfigured', source: 'web' })
      .map((tag) => tag.label),
    ['Sign in', 'Manual login', 'Web']
  );
});

test('detected settings tags show only current source after status', () => {
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'cursor', status: 'ok', source: 'web' })
      .map((tag) => tag.label),
    ['Linked', 'Web']
  );
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'codex', status: 'ok', source: 'rpc', sourceDetail: 'app' })
      .map((tag) => tag.label),
    ['Live', 'App']
  );
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'codex', status: 'ok', source: 'rpc', sourceDetail: 'cli' })
      .map((tag) => tag.label),
    ['Live', 'CLI']
  );
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'codex', status: 'ok', source: 'rpc', sourceDetail: 'managed' })
      .map((tag) => tag.label),
    ['Live', 'Managed']
  );
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'opencode', status: 'ok', source: 'web' })
      .map((tag) => tag.label),
    ['Linked', 'Web']
  );
});

test('remote synced provider tags show the selected source device and local availability', () => {
  const provider = { provider: 'codex', status: 'ok', source: 'rpc', sourceDetail: 'app', sourceDeviceId: 'work-mac' };
  const provenance = limitProviderProvenance(provider, {
    localDeviceId: 'local-mac',
    syncActive: true,
    devices: [
      {
        deviceId: 'local-mac',
        hostname: 'local.local',
        limits: { providers: [{ provider: 'codex', status: 'ok', source: 'rpc', sourceDetail: 'app', accountKey: 'same' }] }
      },
      {
        deviceId: 'work-mac',
        hostname: 'work.local',
        limits: { providers: [{ provider: 'codex', status: 'ok', source: 'rpc', sourceDetail: 'app', accountKey: 'same' }] }
      }
    ]
  });

  assert.deepEqual(
    limitProviderSettingsTags(provider, provenance).map((tag) => tag.key || tag.label),
    ['Live', 'App', 'settings.limits.device.from', 'settings.limits.device.localAlso']
  );
  assert.equal(provenance.selectedDeviceLabel, 'work-mac');
  assert.equal(limitProviderMainDeviceLabel(provenance, { showSource: false }), '');
  assert.equal(limitProviderMainDeviceLabel(provenance, { showSource: true }), 'work-mac');
});

test('local provider tags show when synced devices also have provider data', () => {
  const provider = { provider: 'cursor', status: 'ok', source: 'web', sourceDeviceId: 'local-mac' };
  const provenance = limitProviderProvenance(provider, {
    localDeviceId: 'local-mac',
    syncActive: true,
    devices: [
      {
        deviceId: 'local-mac',
        limits: { providers: [{ provider: 'cursor', status: 'ok', source: 'web', accountKey: 'cursor' }] }
      },
      {
        deviceId: 'office-pc',
        limits: { providers: [{ provider: 'cursor', status: 'ok', source: 'web', accountKey: 'cursor' }] }
      }
    ]
  });

  assert.deepEqual(
    limitProviderSettingsTags(provider, provenance).map((tag) => tag.key || tag.label),
    ['Linked', 'Web', 'settings.limits.device.localAndSynced']
  );
  assert.equal(limitProviderSettingsTags(provider, provenance)[2].count, 1);
  assert.equal(limitProviderMainDeviceLabel(provenance), '');
});

test('multi-account Codex provenance matches synced candidates by account key', () => {
  const provider = {
    provider: 'codex',
    status: 'ok',
    source: 'rpc',
    sourceDetail: 'managed',
    accountKey: 'sha256:remote-account',
    sourceDeviceId: 'work-mac'
  };
  const provenance = limitProviderProvenance(provider, {
    localDeviceId: 'local-mac',
    syncActive: true,
    devices: [
      {
        deviceId: 'local-mac',
        limits: { providers: [{ provider: 'codex', status: 'ok', source: 'rpc', sourceDetail: 'managed', accountKey: 'sha256:local-account' }] }
      },
      {
        deviceId: 'work-mac',
        limits: { providers: [{ provider: 'codex', status: 'ok', source: 'rpc', sourceDetail: 'managed', accountKey: 'sha256:remote-account' }] }
      }
    ]
  });

  assert.equal(provenance.hasLocalCandidate, false);
  assert.equal(provenance.remoteCount, 1);
  assert.deepEqual(
    limitProviderSettingsTags(provider, provenance).map((tag) => tag.key || tag.label),
    ['Live', 'Managed', 'settings.limits.device.from']
  );
});

test('single local synced provider tags identify local provenance without main panel noise', () => {
  const provider = { provider: 'opencode', status: 'ok', source: 'web', sourceDeviceId: 'local-mac' };
  const provenance = limitProviderProvenance(provider, {
    localDeviceId: 'local-mac',
    syncActive: true,
    devices: [
      {
        deviceId: 'local-mac',
        limits: { providers: [{ provider: 'opencode', status: 'ok', source: 'web', accountKey: 'zen' }] }
      }
    ]
  });

  assert.deepEqual(
    limitProviderSettingsTags(provider, provenance).map((tag) => tag.key || tag.label),
    ['Linked', 'Web', 'settings.limits.device.local']
  );
  assert.equal(limitProviderMainDeviceLabel(provenance), '');
});

test('capability tags are settings-only and do not alter the main Limits panel', () => {
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  const renderLimits = functionBody(app, 'renderLimits', 'serviceStatusLabel');
  const renderHead = functionBody(app, 'renderLimitProviderHead', 'renderProviderWindows');
  const renderMeta = functionBody(app, 'limitProviderMeta', 'limitProviderPlan');
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'onToolTrackingToggle');

  assert.doesNotMatch(renderLimits, /limitProviderCapabilityTags|limit-status|limitProviderStatus/);
  assert.match(renderHead, /const provenance = limitProviderProvenance\(provider\);/);
  assert.match(renderHead, /limitProviderMeta\(provider, provenance\)/);
  assert.match(renderMeta, /limitProviderMainDeviceLabel\(provenance, \{ showSource: Boolean\(state\.settings\?\.showLimitSource\) \}\)/);
  assert.doesNotMatch(renderLimits, /limitProviderSettingsTags/);
  assert.match(renderHead, /head\.append\(titleBlock, plan\);/);
  assert.match(renderSettings, /limitProviderSettingsTags\(provider, provenance/);
  assert.doesNotMatch(styles, /\.limit-status\b/);
});

test('Codex limits render as one provider group with account subrows', () => {
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  const renderLimits = functionBody(app, 'renderLimits', 'serviceStatusLabel');

  assert.match(renderLimits, /providersByLimitProviderId\(state\.stats\?\.limits\?\.providers \|\| \[\]\)/);
  assert.match(renderLimits, /renderCodexAccountGroup\(/);
  assert.doesNotMatch(renderLimits, /new Map\(\(state\.stats\?\.limits\?\.providers \|\| \[\]\)\.map\(\(provider\) => \[provider\.provider, provider\]\)\)/);
  assert.match(styles, /\.limit-account-list\s*\{/);
  assert.match(styles, /\.limit-account-row\s*\{/);
});

test('tray all-sessions mode can consider multiple providers for one configured id', () => {
  const app = readRendererFile('app.js');
  const pickConfigured = functionBody(app, 'pickConfiguredSessionProviders', 'renderAllSessionsIcon');

  assert.match(pickConfigured, /providersByLimitProviderId\(providers\)/);
  assert.doesNotMatch(pickConfigured, /new Map\(providers\.map\(\(p\) => \[String\(p\.provider\)\.toLowerCase\(\), p\]\)\)/);
});

test('DeepSeek main Limits row uses a balance meter without since-tracking copy', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');
  const balanceWindow = functionBody(app, 'balanceRemainingWindow', 'limitWindowNode');
  const styles = readRendererFile('styles.css');

  assert.match(renderProviderWindows, /const balanceNode = limitWindowNode\('Balance', balanceRemainingWindow\(balance\), color, 0\.95,/);
  assert.match(renderProviderWindows, /balanceNode\.classList\.add\('limit-window-wide', 'limit-window-no-reset'\);/);
  assert.match(renderProviderWindows, /const spendNode = limitWindowNode\('Spend', \{ showMeter: false \}, color, 0\.6,/);
  assert.doesNotMatch(renderProviderWindows, /Month \(since tracking\)/);
  assert.doesNotMatch(renderProviderWindows, /monthSinceTracking \? 'Month \(since tracking\)' : 'Month'/);
  assert.match(balanceWindow, /remainingPercent/);
  assert.match(balanceWindow, /amount \+ spend/);
  assert.match(styles, /\.limit-window-no-reset \.limit-reset\s*\{/);
});

test('settings provider status waits for stats and refreshes when stats arrive', () => {
  const app = readRendererFile('app.js');
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'onToolTrackingToggle');
  const refreshStats = functionBody(app, 'refreshStats', 'publishViewState');
  const statsPush = app.match(/window\.tokenMonitor\.onStatsPush\?\.\(\(payload\) => \{[\s\S]*?\n\}\);/)?.[0] || '';

  assert.doesNotMatch(renderSettings, /state\.stats \? missingLimitProviderStatus\(\) : 'unavailable'/);
  assert.match(refreshStats, /renderLimitProviderCheckboxes\(\);/);
  assert.match(statsPush, /renderLimitProviderCheckboxes\(\);/);
});

const presentation = require('../../src/electron/renderer/limitProviderPresentation');

test('deepseek source label and capability tags', () => {
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'deepseek', source: 'api' }), 'API');
  assert.deepEqual(presentation.limitProviderCapabilityTags('deepseek'), ['Pay-as-you-go', 'API key']);
});

test('deepseek status copy: notConfigured -> Add API key, unauthorized -> Update API key', () => {
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'deepseek', status: 'notConfigured' }),
    { label: 'Add API key', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'deepseek', status: 'unauthorized' }),
    { label: 'Update API key', tone: 'setup' }
  );
});
