'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const accountIdentityApi = require('../../src/electron/renderer/accountIdentity');

const {
  antigravityQuotaWindow,
  apiKeyAccountStatus,
  isCodexLiveAccount,
  limitProviderDisplayLabel,
  limitProviderCapabilityTags,
  limitProviderCompactWindowLabel,
  limitProviderCompactWindowPeriodLabel,
  limitProviderCompactWindows,
  limitProviderMainDeviceLabel,
  namedApiProfileStatus,
  limitProviderProvenance,
  limitResetRemainingMs,
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

test('limitProviderDisplayLabel normalizes short account labels without rewriting identifiers', () => {
  assert.equal(limitProviderDisplayLabel('plus'), 'Plus');
  assert.equal(limitProviderDisplayLabel('pro'), 'Pro');
  assert.equal(limitProviderDisplayLabel('go'), 'Go');
  assert.equal(limitProviderDisplayLabel('Team'), 'Team');
  assert.equal(limitProviderDisplayLabel('primary.user@example.com'), 'primary.user@example.com');
  assert.equal(limitProviderDisplayLabel(''), '');
});

test('compact Antigravity labels distinguish duplicate periods by model group', () => {
  const windows = [
    { kind: 'session', label: 'Gemini 5-hour' },
    { kind: 'session', label: 'Claude/GPT 5-hour' }
  ];

  assert.equal(limitProviderCompactWindowLabel('antigravity', windows[0], windows), 'Gemini');
  assert.equal(limitProviderCompactWindowLabel('antigravity', windows[1], windows), 'Claude/GPT');
  assert.equal(limitProviderCompactWindowLabel('codex', windows[0], windows), '');
});

test('Antigravity quota presentation parses grouped period labels once', () => {
  assert.deepEqual(antigravityQuotaWindow({ kind: 'session', label: 'Gemini 5-hour' }), {
    groupLabel: 'Gemini',
    windowLabel: '5-hour'
  });
  assert.deepEqual(antigravityQuotaWindow({ kind: 'weekly', label: 'Future Group weekly' }), {
    groupLabel: 'Future Group',
    windowLabel: 'Weekly'
  });
  assert.equal(antigravityQuotaWindow({ kind: 'weekly', label: 'Gemini Pro' }), null);
});

test('compact Antigravity windows surface critical weekly quotas per model group', () => {
  const windows = [
    { kind: 'session', label: 'Gemini 5-hour', remainingPercent: 100 },
    { kind: 'weekly', label: 'Gemini weekly', remainingPercent: 0 },
    { kind: 'session', label: 'Claude/GPT 5-hour', remainingPercent: 20 },
    { kind: 'weekly', label: 'Claude/GPT weekly', remainingPercent: 80 }
  ];

  assert.deepEqual(limitProviderCompactWindows('antigravity', windows), [windows[1], windows[2]]);
  const selected = limitProviderCompactWindows('antigravity', windows);
  assert.equal(limitProviderCompactWindowPeriodLabel('antigravity', selected[0], selected), 'Weekly');
  assert.equal(limitProviderCompactWindowPeriodLabel('antigravity', selected[1], selected), '5-hour');
});

test('compact Antigravity windows keep 5-hour primary until weekly is critical', () => {
  const aboveCritical = [
    { kind: 'session', label: 'Gemini 5-hour', remainingPercent: 60 },
    { kind: 'weekly', label: 'Gemini weekly', remainingPercent: 30 }
  ];
  const critical = [
    { kind: 'session', label: 'Gemini 5-hour', remainingPercent: 60 },
    { kind: 'weekly', label: 'Gemini weekly', remainingPercent: 10 }
  ];

  assert.deepEqual(limitProviderCompactWindows('antigravity', aboveCritical), [aboveCritical[0]]);
  assert.deepEqual(limitProviderCompactWindows('antigravity', critical), [critical[1]]);
});

test('compact Antigravity windows prefer 5-hour on ties and preserve legacy pools', () => {
  const grouped = [
    { kind: 'session', label: 'Gemini 5-hour', remainingPercent: 100 },
    { kind: 'weekly', label: 'Gemini weekly', remainingPercent: 100 },
    { kind: 'session', label: 'Claude/GPT 5-hour', remainingPercent: 100 },
    { kind: 'weekly', label: 'Claude/GPT weekly', remainingPercent: 100 }
  ];
  const legacy = [
    { kind: 'session', label: 'Gemini Pro', remainingPercent: 50 },
    { kind: 'session', label: 'Gemini Flash', remainingPercent: 40 }
  ];

  assert.deepEqual(limitProviderCompactWindows('antigravity', grouped), [grouped[0], grouped[2]]);
  assert.equal(limitProviderCompactWindows('antigravity', legacy), legacy);
});

test('compact Antigravity labels preserve period fallback when groups are not distinct', () => {
  const differentPeriods = [
    { kind: 'session', label: 'Gemini 5-hour' },
    { kind: 'weekly', label: 'Gemini weekly' }
  ];
  const legacy = [
    { kind: 'session', label: 'Gemini Pro' },
    { kind: 'session', label: 'Gemini Flash' }
  ];

  assert.equal(limitProviderCompactWindowLabel('antigravity', differentPeriods[0], differentPeriods), '');
  assert.equal(limitProviderCompactWindowLabel('antigravity', legacy[0], legacy), '');
});

test('limitResetRemainingMs keeps future resets, briefly marks reset time, and expires old timestamps', () => {
  const now = Date.parse('2026-07-10T03:00:00.000Z');

  assert.equal(limitResetRemainingMs('2026-07-10T04:30:00.000Z', now), 90 * 60 * 1000);
  assert.equal(limitResetRemainingMs('2026-07-10T02:59:30.000Z', now), 0);
  assert.equal(limitResetRemainingMs('2026-07-10T02:58:59.000Z', now), null);
  assert.equal(limitResetRemainingMs('not-a-date', now), null);
  assert.equal(limitResetRemainingMs(null, now), null);
});

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

function readSharedFile(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', name), 'utf8');
}

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  const endLineStart = source.lastIndexOf('\n', end) + 1;
  return source.slice(start, endLineStart);
}

function runLocalProviderStatus(source, state, providerName) {
  const localDeviceHelper = functionBody(source, 'localDeviceLimitsProviders', 'localProviderStatus');
  const localProviderHelper = functionBody(source, 'localProviderStatus', 'deepseekAccountLinked');
  return vm.runInNewContext(
    `${localDeviceHelper}\n${localProviderHelper}\nlocalProviderStatus(${JSON.stringify(providerName)});`,
    { accountIdentityApi, state }
  );
}

function runLocalLiveCodexProvider(source, state) {
  const liveHelper = functionBody(source, 'localLiveCodexProvider', 'codexActiveAccountFromStats');
  return vm.runInNewContext(
    `${liveHelper}\nlocalLiveCodexProvider();`,
    { accountIdentityApi, state }
  );
}

function runProviderSpendNode(source, balance) {
  const optionalNumber = functionBody(source, 'optionalFiniteNumber', 'formatLimitWindowValue');
  const spendEntries = functionBody(source, 'providerSpendEntries', 'limitNoteRowNode');
  const spendNode = functionBody(source, 'providerSpendNode', 'thirdPartySpendNode');
  const context = {
    formatMoney: (value, currency) => `${currency} ${Number(value).toFixed(2)}`,
    limitNoteRowNode: (options) => options
  };
  vm.runInNewContext(
    `${optionalNumber}\n${spendEntries}\n${spendNode}\n`
      + `result = providerSpendNode(${JSON.stringify(balance)});`,
    context
  );
  return JSON.parse(JSON.stringify(context.result));
}

function runHomeLimitModule(rows, resetLabels = {}) {
  const app = readRendererFile('app.js');
  const homeLimits = functionBody(app, 'renderHomeLimitModule', 'renderHomeModelModule');
  function createNode(tagName) {
    return {
      tagName,
      className: '',
      textContent: '',
      children: [],
      classList: { add() {} },
      style: { setProperty() {} },
      append(...children) { this.children.push(...children); }
    };
  }
  const body = createNode('body');
  const context = {
    document: { createElement: createNode },
    homeModuleShell: () => ({ module: createNode('section'), body }),
    homeLimitRows: () => rows,
    applyHomeListMark() {},
    iconKindFor: () => 'limits',
    homeLimitWindowLabel: (window) => window.label,
    formatHomeLimitWindowValue: () => '',
    formatReset: (value) => resetLabels[value] || '',
    limitProviderPresentationApi: { limitProviderCompactWindowPeriodLabel: () => '' },
    state: { settings: {} },
    t: (key, values) => key === 'home.reset' ? `Reset ${values.value}` : key
  };
  vm.runInNewContext(`${homeLimits}\nresult = renderHomeLimitModule();`, context);
  return body;
}

test('Limits and Home share reset expiry while preserving the existing reset copy', () => {
  const app = readRendererFile('app.js');
  const formatReset = functionBody(app, 'formatReset', 'formatDuration');
  const limitWindow = functionBody(app, 'limitWindowNode', 'providersByLimitProviderId');
  const homeLimits = functionBody(app, 'renderHomeLimitModule', 'renderHomeModelModule');

  assert.match(formatReset, /limitResetRemainingMs\(value\)/);
  assert.match(formatReset, /diffMs === 0\) return 'Reset now'/);
  assert.match(formatReset, /return `Reset \$\{formatDuration\(diffMs\)\}`/);
  assert.match(limitWindow, /window\?\.resetsAt\s*\? formatReset\(window\.resetsAt\)/);
  assert.doesNotMatch(limitWindow, /formatReset\(window\?\.resetsAt\) \|\| window\?\.resetDescription/);
  assert.match(homeLimits, /window\.resetsAt\s*\? resetAt \|\|/);
  assert.doesNotMatch(app, /noActiveLimitWindow|formatResetDuration/);
});

test('Home omits reset rows that have no visible reset content', () => {
  const body = runHomeLimitModule([
    {
      providerId: 'deepseek',
      key: 'deepseek',
      name: 'DeepSeek',
      windows: [
        { label: 'Balance', value: '$4.00' },
        { label: 'Expired', value: '0% left', resetsAt: 'expired' },
        { label: 'Weekly', value: '88% left', resetsAt: 'future' },
        { label: 'Monthly', value: '50% left', resetDescription: '6d 23h' }
      ]
    }
  ], { future: 'Reset 1h' });

  const metrics = body.children[0].children[1].children;
  assert.equal(metrics[0].children.length, 1);
  assert.equal(metrics[1].children.length, 1);
  assert.equal(metrics[2].children.length, 2);
  assert.equal(metrics[2].children[1].textContent, 'Reset 1h');
  assert.equal(metrics[3].children.length, 2);
  assert.equal(metrics[3].children[1].textContent, 'Reset 6d 23h');
});

test('capability tags explain how each provider is collected in settings', () => {
  assert.deepEqual(limitProviderCapabilityTags('claude'), ['Auto', 'OAuth/CLI', 'Web']);
  assert.deepEqual(limitProviderCapabilityTags('codex'), ['Auto', 'App/CLI RPC']);
  assert.deepEqual(limitProviderCapabilityTags('cursor'), ['Manual login', 'Web']);
  assert.deepEqual(limitProviderCapabilityTags('antigravity'), ['App/CLI must be open', 'RPC']);
  assert.deepEqual(limitProviderCapabilityTags('opencode'), ['Auto', 'API/Web']);
  assert.deepEqual(limitProviderCapabilityTags('minimax'), ['Token Plan', 'API key']);
  assert.deepEqual(limitProviderCapabilityTags('grok'), ['Auto', 'CLI/Web']);
  assert.deepEqual(limitProviderCapabilityTags('copilot'), ['Manual login', 'API']);
  assert.deepEqual(limitProviderCapabilityTags('unknown'), []);
});

test('Minimax capability tags are localized in settings', () => {
  const app = readRendererFile('app.js');
  const i18n = readRendererFile('i18n.js');

  assert.match(app, /'Token Plan': 'settings\.limits\.capability\.tokenPlan'/);
  assert.match(i18n, /'settings\.limits\.capability\.tokenPlan': 'Token Plan'/);
  assert.match(i18n, /'settings\.limits\.capability\.apiKey': 'API key'/);
  assert.match(i18n, /'settings\.limits\.capability\.apiKey': 'API 金鑰'/);
  assert.match(i18n, /'settings\.limits\.capability\.apiKey': 'API 密钥'/);
});

test('Coding Plan capability tags are localized in settings', () => {
  const app = readRendererFile('app.js');
  const i18n = readRendererFile('i18n.js');

  assert.match(app, /'Coding Plan': 'settings\.limits\.capability\.codingPlan'/);
  assert.match(app, /'AK\/SK': 'settings\.limits\.capability\.akSk'/);
  assert.match(i18n, /'settings\.limits\.capability\.codingPlan': 'Coding Plan'/);
  assert.match(i18n, /'settings\.limits\.capability\.akSk': 'AK\/SK'/);
});

test('Grok CLI/Web capability tag is localized in settings', () => {
  const app = readRendererFile('app.js');
  const i18n = readRendererFile('i18n.js');

  assert.doesNotMatch(app, /cliAuth/);
  assert.doesNotMatch(i18n, /cliAuth/);
  assert.match(app, /'CLI\/Web': 'settings\.limits\.capability\.cliWeb'/);
  assert.match(i18n, /'settings\.limits\.capability\.cliWeb': 'CLI\/Web'/);
});

test('API key account status distinguishes pending checks from completed failures', () => {
  assert.equal(apiKeyAccountStatus(null, false), 'notConfigured');
  assert.equal(apiKeyAccountStatus(null, false, false), 'notConfigured');
  assert.equal(apiKeyAccountStatus(null, true), 'checking');
  assert.equal(apiKeyAccountStatus(null, true, false), 'disabled');
  assert.equal(apiKeyAccountStatus({ status: 'ok' }, true), 'linked');
  assert.equal(apiKeyAccountStatus({ status: 'unauthorized' }, true), 'invalid');
  assert.equal(apiKeyAccountStatus({ status: 'rateLimited' }, true), 'limited');
  assert.equal(apiKeyAccountStatus({ status: 'sourceRateLimited' }, true), 'limited');
  assert.equal(apiKeyAccountStatus({ status: 'unavailable' }, true), 'unavailable');
  assert.equal(apiKeyAccountStatus({ status: 'error' }, true), 'error');
  assert.equal(apiKeyAccountStatus({ status: 'disabled' }, true), 'notChecked');
});

test('named API profile status prioritizes provider and profile disablement over pending checks', () => {
  assert.equal(namedApiProfileStatus(null), 'checking');
  assert.equal(namedApiProfileStatus(null, { providerEnabled: false }), 'hidden');
  assert.equal(namedApiProfileStatus(null, { profileEnabled: false }), 'disabled');
  assert.equal(namedApiProfileStatus({ status: 'ok' }), 'linked');
  assert.equal(namedApiProfileStatus({ status: 'ok' }, { providerEnabled: false }), 'hidden');
  assert.equal(namedApiProfileStatus({ status: 'ok' }, { profileEnabled: false }), 'disabled');
  assert.equal(
    namedApiProfileStatus({ status: 'ok' }, { providerEnabled: false, profileEnabled: false }),
    'disabled'
  );
  assert.equal(namedApiProfileStatus({ status: 'unauthorized' }), 'invalid');
});

test('named API profile rows hide global disablement while the group preserves configured account count', () => {
  const app = readRendererFile('app.js');
  const updater = functionBody(app, 'updateNamedApiProfilesStatus', 'updateOpenRouterProfilesStatus');

  assert.match(app, /if \(status === 'hidden'\) return '';/);
  assert.match(updater, /const providerEnabled = limitProviderEnabled\(providerId\)/);
  assert.match(updater, /statusText\(byName\.get\(name\), \{\s*providerEnabled,\s*profileEnabled: profile\?\.enabled !== false\s*\}\)/);
  assert.match(updater, /statusText\(byName\.get\('environment'\), \{ providerEnabled \}\)/);
  assert.match(updater, /!providerEnabled\s*\? t\(`settings\.\$\{providerId\}\.nAccounts`, \{ count: total \}\)/);
  assert.match(updater, /: t\(`settings\.\$\{providerId\}\.connected`, \{ linked, total \}\)/);
});

test('named API profile toggles update immediately and roll back failed persistence', () => {
  const app = readRendererFile('app.js');
  const row = functionBody(app, 'appendNamedApiProfileRow', 'renderNamedApiProfiles');
  const optimisticUpdate = row.indexOf('profile.enabled = toggle.checked;');
  const save = row.indexOf('await api.setProfileEnabled(name, toggle.checked);');

  assert.ok(optimisticUpdate >= 0 && optimisticUpdate < save);
  assert.match(row, /profile\.enabled = toggle\.checked;\s*toggle\.disabled = true;\s*updateStatus\(\)/);
  assert.match(row, /toggle\.checked = previousEnabled;\s*profile\.enabled = previousEnabled;\s*updateStatus\(\)/);
  assert.match(row, /finally \{\s*toggle\.disabled = false;\s*renderSettingsSummaries\(\)/);
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
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'grok', status: 'notConfigured', source: 'web' })
      .map((tag) => tag.label),
    ['Run grok login', 'Auto', 'CLI/Web']
  );
});

test('detected settings tags show only current source after status', () => {
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'claude', status: 'ok', source: 'web' })
      .map((tag) => tag.label),
    ['Linked', 'Web']
  );
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
    limitProviderSettingsTags({ provider: 'grok', status: 'ok', source: 'rpc', sourceDetail: 'cli' })
      .map((tag) => tag.label),
    ['Live', 'CLI']
  );
  assert.deepEqual(
    limitProviderSettingsTags({ provider: 'grok', status: 'ok', source: 'web' })
      .map((tag) => tag.label),
    ['Live', 'Web']
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

test('device provenance uses exact case-sensitive device identity', () => {
  const provider = {
    provider: 'opencode',
    status: 'ok',
    source: 'local',
    accountKey: 'shared',
    sourceDeviceId: 'macbook'
  };
  const provenance = limitProviderProvenance(provider, {
    localDeviceId: 'MacBook',
    syncActive: true,
    devices: [
      { deviceId: 'MacBook', limits: { providers: [{ ...provider, sourceDeviceId: undefined }] } },
      { deviceId: 'macbook', limits: { providers: [{ ...provider, sourceDeviceId: undefined }] } }
    ]
  });

  assert.equal(provenance.selectedIsLocal, false);
  assert.equal(provenance.selectedIsRemote, true);
  assert.equal(provenance.selectedDeviceLabel, 'macbook');
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

test('OpenCode provenance matches a legacy device through canonical account aliases', () => {
  const provider = {
    provider: 'opencode',
    status: 'ok',
    source: 'web',
    accountKey: 'sha256:canonical',
    accountKeyAliases: ['sha256:legacy-go'],
    sourceDeviceId: 'current-device'
  };
  const provenance = limitProviderProvenance(provider, {
    localDeviceId: 'current-device',
    syncActive: true,
    devices: [
      { deviceId: 'current-device', limits: { providers: [provider] } },
      {
        deviceId: 'legacy-device',
        limits: { providers: [{ provider: 'opencode', status: 'ok', source: 'web', accountKey: 'sha256:legacy-go' }] }
      }
    ]
  });

  assert.equal(provenance.hasLocalCandidate, true);
  assert.equal(provenance.remoteCount, 1);
  assert.equal(provenance.candidateCount, 2);
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
  // The head still carries exactly the title block and the plan label. The plan
  // is wrapped so hovering it can reveal manual subscription details, which adds
  // no tag and no status of its own.
  assert.match(renderHead, /head\.append\(titleBlock, decoratePlanWithSubscription\(plan, provider\)\);/);
  assert.match(renderSettings, /limitProviderSettingsTags\(provider, provenance/);
  assert.doesNotMatch(styles, /\.limit-status\b/);
});

test('Codex limits render as one provider group with account subrows', () => {
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  const renderLimits = functionBody(app, 'renderLimits', 'serviceStatusLabel');
  const renderGroup = functionBody(app, 'renderCodexAccountGroup', 'renderClaudeAccountGroup');

  assert.match(renderLimits, /providersByLimitProviderId\(state\.stats\?\.limits\?\.providers \|\| \[\]\)/);
  assert.match(renderLimits, /renderCodexAccountGroup\(/);
  assert.match(renderGroup, /planText: t\('settings\.codex\.nAccounts', \{ count: providers\.length \}\)/);
  assert.doesNotMatch(renderLimits, /new Map\(\(state\.stats\?\.limits\?\.providers \|\| \[\]\)\.map\(\(provider\) => \[provider\.provider, provider\]\)\)/);
  assert.match(styles, /\.limit-account-list\s*\{/);
  assert.match(styles, /\.limit-account-row\s*\{/);
});

test('Claude limits render as one provider group with account subrows', () => {
  const app = readRendererFile('app.js');
  const renderLimits = functionBody(app, 'renderLimits', 'serviceStatusLabel');
  const renderGroup = functionBody(app, 'renderClaudeAccountGroup', 'mimoSettingsAccountTitle');

  assert.match(renderLimits, /renderClaudeAccountGroup\(/);
  assert.match(renderGroup, /limitAccountTitle\('claude', provider, index, providers\)/);
  assert.match(renderGroup, /planText: t\('settings\.claude\.nAccounts', \{ count: providers\.length \}\)/);
  assert.match(renderGroup, /accountRow: true/);
  assert.match(renderGroup, /showIcon: false/);
});

test('every multi-account Limits group uses its provider-localized account count', () => {
  const app = readRendererFile('app.js');
  for (const provider of ['claude', 'codex', 'mimo', 'opencode', 'openrouter', 'thirdparty']) {
    assert.match(
      app,
      new RegExp(`settings\\.${provider}\\.nAccounts`)
    );
  }
  assert.doesNotMatch(app, /settings\.limits\.nAccounts|accountCountText/);
});

test('tray primary-limit modes use the shared provider-aware resolver', () => {
  const app = readRendererFile('app.js');
  const pickConfigured = functionBody(app, 'pickConfiguredSessionProviders', 'renderAllSessionsIcon');
  const renderAllSessions = functionBody(app, 'renderAllSessionsIcon', 'renderLimitSessionsIcon');
  const renderBars = functionBody(app, 'renderBarsIcon', 'pickConfiguredSessionProviders');
  const pickSession = functionBody(app, 'pickWorstSessionProvider', 'pickWorstWeeklyProvider');

  assert.match(pickConfigured, /pickConfiguredLimitProviders\(stats/);
  assert.match(pickSession, /pickLimitProviderByKindPriority\(stats, \['session', 'weekly'\]\)/);
  assert.match(renderBars, /selection\.primaryPercent/);
  assert.match(renderBars, /selection\.secondaryPercent/);
  assert.doesNotMatch(renderBars, /\.find\(\(w\) => w\.kind/);
  assert.match(renderAllSessions, /trayBarsLayout\(height, \{ contentOnly: true \}\)/);
  assert.match(renderAllSessions, /function renderAllSessionsIcon\(stats, height = 44, configOrder, colors = \{\}, options = \{\}\)/);
  assert.match(renderAllSessions, /picks\.length === 1\) return renderBarsIcon\(stats, height, \(\) => picks\[0\], colors, options\)/);
});

test('limit percent tray mode renders provider icons into a generated tray image', () => {
  const app = readRendererFile('app.js');
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const renderLimitSessionsIcon = functionBody(app, 'renderLimitSessionsIcon', 'barsDataUrlForMode');
  const drawProviderImage = functionBody(app, 'drawProviderImage', 'renderBarsIcon');
  const maybeUpdateBarsIcon = functionBody(app, 'maybeUpdateBarsIcon', 'loadImage');
  const updateTrayDisplay = functionBody(main, 'updateTrayDisplay', 'sendStatus');

  assert.match(renderLimitSessionsIcon, /pickConfiguredSessionProviders\(stats, configOrder\)/);
  assert.match(renderLimitSessionsIcon, /trayBarsLayout\(height/);
  assert.match(renderLimitSessionsIcon, /layout\.iconSize/);
  assert.match(renderLimitSessionsIcon, /picks\.length === 1/);
  assert.match(renderLimitSessionsIcon, /picks\[0\]\.percent/);
  assert.match(renderLimitSessionsIcon, /picks\[0\]\.secondaryPercent/);
  assert.match(renderLimitSessionsIcon, /trayProviderImages\[pick\.providerRecord\.provider\]/);
  assert.match(renderLimitSessionsIcon, /drawProviderImage\(ctx, entry\.image/);
  assert.match(drawProviderImage, /shadowColor/);
  assert.match(drawProviderImage, /shadowBlur/);
  assert.doesNotMatch(drawProviderImage, /fillRect|\.fill\(/);
  assert.match(app, /providerContrastHalo:\s*true/);
  assert.match(app, /function floatingBubbleGeneratedColors\(\)/);
  assert.match(app, /resolvedThemeColor\('text'\)/);
  assert.match(app, /appliedThemeOverrides = themePresetsApi\.normalizeOverrides\(overrides/);
  assert.match(app, /function applyThemeColors\(overrides\)[\s\S]*renderFloatingBubbleContent\(\);/);
  assert.match(app, /function resolvedThemeColor\(key\)[\s\S]*appliedThemeOverrides\[key\]/);
  assert.match(renderLimitSessionsIcon, /`500 \$\{fontSize\}px/);
  // The picker already resolved and mode-adjusted these, including for balance
  // windows that carry no wire percentage of their own.
  assert.match(renderLimitSessionsIcon, /formatPercent\(pick\.percent\)/);
  assert.doesNotMatch(renderLimitSessionsIcon, /limitFillPercent/);
  assert.match(renderLimitSessionsIcon, /·/);
  assert.match(maybeUpdateBarsIcon, /TokenMonitorTrayText\.isGeneratedTrayIconMode\(mode\)/);
  assert.match(maybeUpdateBarsIcon, /trayDataUrlForMode\(mode, 44, colors, \{ trayInk: true \}\)/);
  // The tray ink must come from the platform-aware helper, not the app theme:
  // macOS needs the black its template inversion expects, while a dark Windows
  // taskbar needs light ink or the icon disappears into it.
  assert.match(
    maybeUpdateBarsIcon,
    /const colors = window\.TokenMonitorTrayText\.trayGeneratedIconColors\(state\.appInfo\?\.platform, state\.systemDarkUi\)/
  );
  assert.match(maybeUpdateBarsIcon, /\{ \[mode\]: dataUrl \|\| null \}/);
  assert.match(updateTrayDisplay, /mode === 'limitsAllSessions'/);
  assert.match(updateTrayDisplay, /const barsImageMode = isBarsTrayIconMode\(mode\) && !limitText && providerTrayIcons\[mode\]/);
  assert.match(updateTrayDisplay, /Boolean\(limitText\)/);
  assert.match(updateTrayDisplay, /const limitText = formatTrayText/);
  assert.match(updateTrayDisplay, /trayImageMode[\s\S]*?\? '' : limitText/);
  assert.match(main, /if \(dataUrl === null\) \{[\s\S]*?delete providerTrayIcons\[id\]/);
  assert.match(main, /if \(shouldUseTemplateTrayIcon\(id, process\.platform, settings\?\.showTrayProviderBadge\)\) sized\.setTemplateImage\(true\)/);
  assert.doesNotMatch(main, /process\.platform === 'darwin'\) sized\.setTemplateImage\(true\)/);
});

test('provider tray badges are opt-in and keep monochrome assets visible', () => {
  const app = readRendererFile('app.js');
  const html = readRendererFile('index.html');
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const defaults = functionBody(main, 'defaultSettings', 'normalizeCollectionMode');
  const providerImage = functionBody(app, 'providerImageToPngDataUrl', 'deliverTrayProviderIcons');

  assert.match(defaults, /showTrayProviderBadge:\s*false/);
  assert.match(html, /<input id="showTrayProviderBadgeInput" type="checkbox" \/>/);
  assert.match(html, /data-i18n="settings\.display\.trayProviderBadge"/);
  assert.match(app, /showTrayProviderBadgeInput: document\.getElementById\('showTrayProviderBadgeInput'\)/);
  assert.match(app, /saveSettings\(\{ showTrayProviderBadge: els\.showTrayProviderBadgeInput\.checked \}\)/);
  assert.match(app, /deliverTrayProviderIcons\(patch\.showTrayProviderBadge === true\)/);
  // `trayInk` is what lets a flat-ink mark be re-inked for the taskbar it will sit on.
  assert.match(app, /providerImageToPngDataUrl\(img, 44, showBadge, \{ trayInk: true \}\)/);
  // A system-theme flip invalidates BOTH tray bitmap caches. Repainting only the
  // generated one leaves the usage modes showing the provider icon main cached
  // under the old ink, which is the whole bug on a taskbar that just went dark.
  assert.match(
    app,
    /const applySystemUiTheme = \(dark\) => \{[\s\S]*?void maybeUpdateBarsIcon\(\);[\s\S]*?void deliverTrayProviderIcons\(\);[\s\S]*?\};/
  );
  // Subscribing before the app-info round trip is what keeps a theme flipped
  // mid-call from being lost until the next flip.
  assert.match(
    app,
    /onSystemUiThemePush\?\.\(\(payload\) => applySystemUiTheme\(payload\?\.dark === true\)\);\n\s*try \{ state\.appInfo = await/
  );
  assert.match(app, /if \(!trayProviderIconDeliveryGuard\.isCurrent\(deliveryId\)\) return;/);
  // The badge must not decide the ink. Full-colour artwork is already protected
  // by the classifier, which answers '' for it, so the old showBadge bypass only
  // ever kept a white-authored mark white on a light taskbar — where its white
  // contrast halo cannot save it either.
  assert.match(providerImage, /trayGlyphInk\(\{ templateIconColor: options\.templateColor, trayInk: options\.trayInk \}, img\)/);
  assert.doesNotMatch(providerImage, /showBadge\s*\?\s*''\s*:\s*trayGlyphInk/);
  assert.match(providerImage, /if \(!showBadge\) return canvas\.toDataURL\('image\/png'\)/);
  assert.match(providerImage, /shadowColor = 'rgba\(255, 255, 255, 0\.95\)'/);
  assert.match(providerImage, /shadowBlur = Math\.max/);
  assert.match(app, /function drawCustomTrayProviderImage/);
  assert.match(app, /showProviderBadge: state\.settings\?\.showTrayProviderBadge === true/);
  assert.match(app, /globalCompositeOperation = 'destination-out'/);
});

test('Grok renders its single Monthly billing window full-width instead of an empty session/weekly pair', () => {
  // Grok only exposes a billing window. The default render branch draws
  // session+weekly, which would leave Grok with no visible bar. A dedicated
  // grok branch must surface the billing window as a wide row.
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');

  assert.match(renderProviderWindows, /provider\.provider === 'grok'/);
  assert.match(renderProviderWindows, /windowForKind\(provider, 'billing'\)/);
  assert.match(renderProviderWindows, /limitWindowNode\(monthly\.label \|\| 'Monthly', monthly, color, 0\.68\)/);
  assert.match(renderProviderWindows, /limit-window-wide/);
});

test('Antigravity groups returned quota windows under dynamic model-family headings', () => {
  const app = readRendererFile('app.js');
  const quotaGroups = functionBody(app, 'antigravityQuotaGroups', 'formatLimitAmount');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');
  const css = readRendererFile('styles.css');

  const context = { limitProviderPresentationApi: { antigravityQuotaWindow } };
  const grouped = vm.runInNewContext(`${quotaGroups}\nantigravityQuotaGroups({ windows: [
    { kind: 'session', label: 'Gemini 5-hour' },
    { kind: 'weekly', label: 'Gemini weekly' },
    { kind: 'weekly', label: 'Future Group weekly' }
  ] });`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(grouped)), [
    {
      label: 'Gemini',
      windows: [
        { groupLabel: 'Gemini', windowLabel: '5-hour', window: { kind: 'session', label: 'Gemini 5-hour' } },
        { groupLabel: 'Gemini', windowLabel: 'Weekly', window: { kind: 'weekly', label: 'Gemini weekly' } }
      ]
    },
    {
      label: 'Future Group',
      windows: [
        { groupLabel: 'Future Group', windowLabel: 'Weekly', window: { kind: 'weekly', label: 'Future Group weekly' } }
      ]
    }
  ]);
  const legacy = vm.runInNewContext(`${quotaGroups}\nantigravityQuotaGroups({ windows: [
    { kind: 'weekly', label: 'Gemini Pro' },
    { kind: 'weekly', label: 'Claude' }
  ] });`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(legacy)), []);

  assert.match(quotaGroups, /limitProviderPresentationApi\.antigravityQuotaWindow\(window\)/);
  assert.match(quotaGroups, /groups\.set\(entry\.groupLabel, \[\]\)/);
  assert.match(quotaGroups, /entries\.some\(\(entry\) => entry === null\)/);
  assert.match(renderProviderWindows, /provider\.provider === 'antigravity'/);
  assert.match(renderProviderWindows, /const quotaGroups = antigravityQuotaGroups\(provider\)/);
  assert.match(renderProviderWindows, /title\.textContent = group\.label/);
  assert.match(renderProviderWindows, /entry\.windowLabel/);
  assert.match(css, /\.limit-windows-antigravity-grouped \{[\s\S]*grid-template-columns: 1fr;[\s\S]*gap: 10px;/);
  assert.match(css, /\.limit-window-group-items \{[\s\S]*grid-template-columns: 1fr 1fr;/);
  assert.match(css, /\.limit-window-group-title \{[\s\S]*font-weight: 400;/);
  assert.doesNotMatch(css, /\.limit-window-group \+ \.limit-window-group/);
});

test('Qoder renders its single Credits billing window full-width', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');

  assert.match(renderProviderWindows, /provider\.provider === 'qoder'/);
  assert.match(renderProviderWindows, /const credits = windowForKind\(provider, 'billing'\);/);
  assert.match(renderProviderWindows, /formatLimitCount\(credits, Boolean\(state\.settings\?\.showLimitUsed\)\)/);
  assert.match(renderProviderWindows, /limit-window-wide/);
});

test('Kimi renders 5-hour and Weekly above one full-width Monthly window', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');

  assert.match(renderProviderWindows, /provider\.provider === 'kimi'/);
  assert.match(renderProviderWindows, /const fiveHour = windowForKind\(provider, 'session'\);/);
  assert.match(renderProviderWindows, /const weekly = windowForKind\(provider, 'weekly'\);/);
  assert.match(renderProviderWindows, /const monthly = windowForKind\(provider, 'billing'\);/);
  assert.match(renderProviderWindows, /monthly\.detail \|\| ''/);
  assert.match(renderProviderWindows, /node\.classList\.add\('limit-window-wide'\);/);
});

test('Command Code renders 5-hour and Weekly above full-width credit windows', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');

  assert.match(renderProviderWindows, /provider\.provider === 'commandcode'/);
  assert.match(renderProviderWindows, /const fiveHour = windowForKind\(provider, 'session'\);/);
  assert.match(renderProviderWindows, /const weekly = windowForKind\(provider, 'weekly'\);/);
  // The monthly grant and any rollover top-up are both billing windows, so the
  // branch loops rather than picking one.
  assert.match(renderProviderWindows, /for \(const credits of windowsForKind\(provider, 'billing'\)\)/);
  assert.match(renderProviderWindows, /formatCommandcodeCreditsDetail\(credits\)/);
  assert.match(renderProviderWindows, /if \(credits\.showMeter === false\) node\.classList\.add\('limit-window-no-reset'\);/);

  // Money, not raw credit counts: the detail under the bar is currency-formatted.
  const detail = functionBody(app, 'formatCommandcodeCreditsDetail', 'formatKiroOverageValue');
  assert.match(detail, /formatMoney\(value, window\?\.currency\)/);
  assert.match(detail, /formatMoney\(limit, window\?\.currency\)/);
  assert.match(detail, /state\.settings\?\.showLimitUsed/);
});

test('Ollama renders Session and Weekly usage windows', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');
  assert.match(renderProviderWindows, /provider\.provider === 'ollama'/);
  assert.match(renderProviderWindows, /windowForKind\(provider, 'session'\)/);
  assert.match(renderProviderWindows, /windowForKind\(provider, 'weekly'\)/);
  assert.match(renderProviderWindows, /limitWindowNode\('Session', session/);
  assert.match(renderProviderWindows, /limitWindowNode\('Weekly', weekly/);
});

test('Volcengine renders 5-hour, Weekly, and Monthly quota windows', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');

  assert.match(renderProviderWindows, /provider\.provider === 'volcengine'/);
  assert.match(renderProviderWindows, /const session = windowForKind\(provider, 'session'\);/);
  assert.match(renderProviderWindows, /const weekly = windowForKind\(provider, 'weekly'\);/);
  assert.match(renderProviderWindows, /const monthly = windowForKind\(provider, 'billing'\);/);
  assert.match(renderProviderWindows, /limitWindowNode\(session\.label \|\| '5-hour', session, color, 0\.95\)/);
  assert.match(renderProviderWindows, /limitWindowNode\('Weekly', weekly, color, 0\.68\)/);
  assert.match(renderProviderWindows, /limitWindowNode\('Monthly', monthly, color, 0\.68\)/);
  assert.match(renderProviderWindows, /monthlyNode\.classList\.add\('limit-window-wide'\)/);
});

test('Z.ai renders 5-hour and Weekly first, then MCP full-width', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');

  assert.match(renderProviderWindows, /provider\.provider === 'zai'/);
  assert.match(renderProviderWindows, /const fiveHour = windowForKind\(provider, 'session'\);/);
  assert.match(renderProviderWindows, /const weekly = windowForKind\(provider, 'weekly'\);/);
  assert.match(renderProviderWindows, /const mcp = windowForKind\(provider, 'billing'\);/);
  assert.match(renderProviderWindows, /const fiveHourNode = limitWindowNode\('5-hour', fiveHour, color, 0\.95\)/);
  assert.match(renderProviderWindows, /if \(!weekly\) fiveHourNode\.classList\.add\('limit-window-wide'\)/);
  assert.match(renderProviderWindows, /limitWindowNode\('Weekly', weekly, color, 0\.68\)/);
  assert.match(renderProviderWindows, /const mcpNode = limitWindowNode\('MCP', mcp, color, 0\.68\)/);
  assert.match(renderProviderWindows, /mcpNode\.classList\.add\('limit-window-wide'\)/);
});

test('Copilot renders monthly Premium and Chat quotas as billing windows', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');

  assert.match(renderProviderWindows, /provider\.provider === 'copilot'/);
  assert.match(renderProviderWindows, /const billingWindows = windowsForKind\(provider, 'billing'\);/);
  assert.match(renderProviderWindows, /for \(const billing of billingWindows\)/);
  assert.match(renderProviderWindows, /limitWindowNode\(billing\?\.label \|\| 'Monthly', billing, color, 0\.68\)/);
});

test('Codex renders Monthly quota and manual reset credits below rolling windows', () => {
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');
  const resetCreditsValue = functionBody(app, 'formatCodexResetCreditsValue', 'codexResetCreditExpirationDates');
  const resetCreditExpirationDates = functionBody(app, 'codexResetCreditExpirationDates', 'codexResetCreditExpiryLabel');
  const resetCreditExpiryLabel = functionBody(app, 'codexResetCreditExpiryLabel', 'codexResetCreditExpiryDetailLabel');
  const resetCreditExpiryDetailLabel = functionBody(app, 'codexResetCreditExpiryDetailLabel', 'expiryDateLabel');
  const resetCreditExpiryDateLabel = functionBody(app, 'expiryDateLabel', 'limitDetailTooltipShouldHoldRender');
  // Sliced to the next function, not to `renderLimitProviderHead`: the wider slice
  // swept in the shared tooltip builder, so these assertions passed on code that
  // isn't Codex's.
  const codexResetCreditsNode = functionBody(app, 'codexResetCreditsNode', 'providerSpendEntries');
  const limitDetailTooltipShouldHoldRender = functionBody(app, 'limitDetailTooltipShouldHoldRender', 'flushPendingLimitDetailTooltipRender');
  const renderLimits = functionBody(app, 'renderLimits', 'serviceStatusLabel');

  assert.match(renderProviderWindows, /provider\.provider === 'codex'/);
  assert.match(renderProviderWindows, /const monthly = windowForKind\(provider, 'billing'\);/);
  assert.match(renderProviderWindows, /if \(!weekly && !monthly\) sessionNode\.classList\.add\('limit-window-wide'\);/);
  assert.match(renderProviderWindows, /if \(!session && !monthly\) weeklyNode\.classList\.add\('limit-window-wide'\);/);
  assert.match(renderProviderWindows, /limitWindowNode\(monthly\.label \|\| 'Monthly', monthly, color, 0\.68\)/);
  assert.match(renderProviderWindows, /monthlyNode\.classList\.add\('limit-window-wide'\);/);
  assert.match(renderProviderWindows, /const resetNode = codexResetCreditsNode\(provider\.resetCredits\);/);
  assert.doesNotMatch(renderProviderWindows, /limitWindowNode\('Reset credits'/);
  assert.match(resetCreditsValue, /if \(count <= 0\) return '';/);
  assert.match(resetCreditsValue, /return `\$\{count\} reset\$\{count === 1 \? '' : 's'\}`;/);
  assert.match(resetCreditExpirationDates, /resetCredits\?\.expirations/);
  assert.match(resetCreditExpirationDates, /\.sort\(\(a, b\) => a\.getTime\(\) - b\.getTime\(\)\)/);
  assert.match(resetCreditExpirationDates, /resetCredits\?\.nextExpiresAt/);
  assert.match(resetCreditExpiryLabel, /diffMs <= 0 \? 'now'/);
  assert.match(resetCreditExpiryLabel, /formatDuration\(diffMs\)/);
  assert.match(resetCreditExpiryDetailLabel, /`Expires in \$\{formatDuration\(diffMs\)\}`/);
  assert.match(
    resetCreditExpiryDateLabel,
    /Intl\.DateTimeFormat\(currentLocale\(\), \{\s*month: 'numeric',\s*day: 'numeric',\s*hour: 'numeric',\s*minute: '2-digit'\s*\}\)/
  );
  assert.match(codexResetCreditsNode, /limit-reset-credits/);
  assert.match(codexResetCreditsNode, /limit-reset-credits-line/);
  assert.match(codexResetCreditsNode, /limit-reset-credits-timeline/);
  assert.match(codexResetCreditsNode, /limit-reset-credits-time/);
  assert.match(codexResetCreditsNode, /limit-reset-credits-separator/);
  assert.match(codexResetCreditsNode, /separator\.textContent = '·'/);
  assert.match(codexResetCreditsNode, /expirationDates\.slice\(0, 3\)\.map\(codexResetCreditExpiryLabel\)/);
  assert.match(codexResetCreditsNode, /hiddenExpirationCount = expirationDates\.length - summaryParts\.length/);
  assert.match(codexResetCreditsNode, /summaryParts\.push\(`\+\$\{hiddenExpirationCount\}`\)/);
  // The expiry tooltip is the shared builder, not a second copy of its
  // hover/focus wiring that has to be kept in step by hand. It is useful for a
  // single reset too, not only when several dates are present.
  assert.match(codexResetCreditsNode, /expiryGroup\.append\(timeline\);\s*if \(expirationDates\.length > 0\) \{/);
  assert.match(
    codexResetCreditsNode,
    /expirationDates\.map\(\(date\) => \[expiryDateLabel\(date\), codexResetCreditExpiryLabel\(date\)\]\)/
  );
  assert.match(codexResetCreditsNode, /`Reset \$\{index \+ 1\}: \$\{codexResetCreditExpiryDetailLabel\(date\)\}`/);
  assert.doesNotMatch(codexResetCreditsNode, /addEventListener/);
  assert.doesNotMatch(codexResetCreditsNode, /state\.limitDetailTooltip/);
  assert.match(codexResetCreditsNode, /formatCodexResetCreditsValue\(resetCredits\)/);
  assert.match(codexResetCreditsNode, /aria-label/);
  assert.match(limitDetailTooltipShouldHoldRender, /state\.limitDetailTooltipActive/);
  assert.match(renderLimits, /const holdLimitDetailTooltipRender = limitDetailTooltipShouldHoldRender\(\);/);
  assert.match(renderLimits, /if \(holdLimitDetailTooltipRender \|\| holdCodexSwitchPopoverRender\)/);
  assert.match(styles, /\.limit-reset-credits\s*\{[^}]*min-height: 11px;[^}]*font-size: 9px;/s);
  assert.match(styles, /\.limit-reset-credits-line\s*\{[^}]*justify-content: space-between;/s);
  assert.match(styles, /\.limit-reset-credits-expiry-group\s*\{[^}]*flex: 0 0 auto;/s);
  assert.match(styles, /\.limit-reset-credits-timeline\s*\{[^}]*opacity: 0\.66;/s);
  assert.match(styles, /\.limit-reset-credits-time\s*\{[^}]*gap: 3px;/s);
  assert.match(styles, /\.limit-detail-tooltip-wrap\s*\{[^}]*position: relative;/s);
  assert.match(styles, /\.limit-detail-tooltip\s*\{[^}]*position: absolute;[^}]*width: max-content;[^}]*grid-template-columns: max-content max-content;/s);
  assert.match(styles, /\.limit-detail-tooltip-row\s*\{[^}]*display: contents;/s);
  assert.match(styles, /\.limit-detail-tooltip-row span:last-child\s*\{[^}]*text-align: right;/s);
  assert.doesNotMatch(styles, /\.limit-reset-credits-clock/);
});

function runClaudePrepaidGrantRows(app, tranches, currency, now) {
  const optionalNumber = functionBody(app, 'optionalFiniteNumber', 'formatLimitWindowValue');
  const duration = functionBody(app, 'formatDuration', 'formatActiveDuration');
  const dateLabel = functionBody(app, 'expiryDateLabel', 'limitDetailTooltipShouldHoldRender');
  const grantRows = functionBody(app, 'claudePrepaidGrantRows', 'claudeBalanceNode');
  const context = {
    Date: class FrozenDate extends Date {
      constructor(...args) {
        super(...(args.length === 0 ? [now] : args));
      }

      static now() {
        return now;
      }
    },
    Intl,
    currentLocale: () => 'en-US',
    formatMoney: (value, code) => `${code === 'USD' ? '$' : `${code} `}${Number(value).toFixed(2)}`
  };
  vm.runInNewContext(
    `${optionalNumber}\n${duration}\n${dateLabel}\n${grantRows}\n`
      + `result = claudePrepaidGrantRows(${JSON.stringify(tranches)}, ${JSON.stringify(currency)});`,
    context
  );
  // The rows come back with the sandbox's own prototypes, which deepEqual rejects.
  return JSON.parse(JSON.stringify(context.result));
}

// Expiries are rendered in local time, so the fixtures are built from local
// dates rather than fixed UTC instants. Both land in August, which no time zone
// splits with a DST transition from late July.
function localIso(year, month, day, hour = 0) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).toISOString();
}

test('Claude prepaid grants list amount, expiry date and time left in separate columns', () => {
  const app = readRendererFile('app.js');
  const now = new Date(2026, 6, 28, 0, 0, 0, 0).getTime();
  const rows = runClaudePrepaidGrantRows(app, [
    { amount: 13.43, currency: 'USD', expiresAt: localIso(2026, 8, 8, 17) },
    { amount: 100, currency: 'USD', expiresAt: localIso(2026, 8, 20, 17) }
  ], 'USD', now);

  assert.deepEqual(rows.map((row) => row.cells), [
    ['$13.43', '8/8, 5:00 PM', '11d 17h'],
    ['$100.00', '8/20, 5:00 PM', '23d 17h']
  ]);
  // The columns dropped the wording, so only the spoken label still carries it.
  assert.deepEqual(rows.map((row) => row.aria), [
    '$13.43 expires in 11d 17h',
    '$100.00 expires in 23d 17h'
  ]);
});

test('Claude prepaid grants keep three cells when a grant has no usable expiry', () => {
  const app = readRendererFile('app.js');
  const now = new Date(2026, 6, 28, 0, 0, 0, 0).getTime();
  const rows = runClaudePrepaidGrantRows(app, [
    { amount: 5, currency: 'USD', expiresAt: null },
    { amount: 6, currency: 'USD', expiresAt: 'not-a-date' },
    { amount: 7, currency: 'USD', expiresAt: localIso(2026, 7, 1, 12) },
    { amount: null, currency: 'USD', expiresAt: localIso(2026, 8, 8, 17) }
  ], 'USD', now);

  // Rows are grid cells, so a short row would slide into the next row's columns.
  assert.deepEqual(rows.map((row) => row.cells.length), [3, 3, 3]);
  assert.deepEqual(rows.map((row) => row.cells[2]), ['No expiry', 'No expiry', 'Expired']);
  assert.deepEqual(rows.map((row) => row.cells[1]), ['', '', '7/1, 12:00 PM']);
});

test('The detail tooltip widens its grid and pads short rows for three-column entries', () => {
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  const infoNode = functionBody(app, 'limitDetailInfoNode', 'providerSpendNode');
  const grantRows = functionBody(app, 'claudePrepaidGrantRows', 'claudeBalanceNode');
  const balanceNode = functionBody(app, 'claudeBalanceNode', 'optionalFiniteNumber');

  assert.match(infoNode, /const columns = entries\.reduce\(\(widest, entry\) => Math\.max\(widest, entry\.length\), 0\);/);
  assert.match(infoNode, /columns > 2 \? 'limit-detail-tooltip-triple' : ''/);
  assert.match(infoNode, /for \(let column = 0; column < columns; column \+= 1\)/);
  assert.match(infoNode, /cell\.textContent = entry\[column\] \?\? '';/);
  assert.match(infoNode, /entries\.map\(\(\[entryLabel, \.\.\.rest\]\) => `\$\{entryLabel\}: \$\{rest\.filter\(Boolean\)\.join\(' '\)\}`\)/);
  assert.match(balanceNode, /const grants = claudePrepaidGrantRows\(tranches, currency\);/);
  assert.match(balanceNode, /\.\.\.grants\.map\(\(grant\) => grant\.aria\)/);
  // The wording belongs to the spoken label now, never to a rendered cell.
  assert.doesNotMatch(grantRows, /cells: \[[^\]]*Expires in/);
  assert.match(styles, /\.limit-detail-tooltip-triple\s*\{[^}]*grid-template-columns: max-content max-content max-content;/s);
  assert.match(styles, /\.limit-detail-tooltip-row span:nth-child\(2\):not\(:last-child\)\s*\{[^}]*text-align: right;/s);
});

test('Home uses explicit billing labels so Copilot Premium and Chat stay distinct', () => {
  const app = readRendererFile('app.js');
  const i18n = readRendererFile('i18n.js');
  const homeLabel = functionBody(app, 'homeLimitWindowLabel', 'renderHomeLimitModule');
  const homeRows = functionBody(app, 'homeLimitRows', 'homeLimitWindowLabel');
  const homeModule = functionBody(app, 'renderHomeLimitModule', 'renderHomeModelModule');
  const valueFormatter = functionBody(app, 'formatHomeLimitWindowValue', 'mimoTokenPlanWindowFromBalance');

  assert.match(homeLabel, /if \(window\?\.kind === 'billing'\) \{/);
  assert.match(homeLabel, /limitProviderCompactWindowLabel\(providerId, window, visibleWindows\)/);
  assert.match(homeRows, /limitProviderCompactWindows\(provider, provider\.windows\)/);
  assert.match(homeLabel, /const label = String\(window\?\.label \|\| ''\)\.trim\(\);/);
  assert.match(homeLabel, /if \(label\) return label;/);
  assert.match(homeLabel, /billing: 'home\.limit\.billing'/);
  // Balance windows arrive as real `billing` windows carrying their own label
  // ('Balance' / 'Token quota'), so the label branch above already covers them
  // and no synthesized 'balance' kind is left to special-case.
  assert.doesNotMatch(homeLabel, /kind === 'balance'/);
  assert.match(homeModule, /const showUsed = Boolean\(state\.settings\?\.showLimitUsed\);/);
  assert.match(homeModule, /value\.textContent = window\.value \|\| formatHomeLimitWindowValue\(window, showUsed\);/);
  assert.match(homeModule, /limitProviderCompactWindowPeriodLabel\(row\.providerId, window, row\.windows\)/);
  assert.match(homeModule, /`\$\{periodLabel\} · \$\{resetLabel\}`/);
  assert.match(valueFormatter, /if \(window\?\.metric === 'credits'\) \{/);
  assert.match(valueFormatter, /return formatCompactMoney\(window\.remaining, window\.currency\);/);
  assert.match(valueFormatter, /`\$\{formatPercent\(percent\)\} \$\{limitModeSuffix\(showUsed\)\}`/);
  assert.doesNotMatch(i18n, /home\.limit\.(balance|leftPercent|leftAmount)/);
});

test('tray bars draw the resolved primary window on top and preserve an empty lower track', () => {
  const app = readRendererFile('app.js');
  const renderBarsIcon = functionBody(app, 'renderBarsIcon', 'renderAllSessionsIcon');

  // Resolved percentages, not raw windows: a balance window carries no wire
  // percentage and re-deriving from it draws a fabricated empty bar.
  assert.match(renderBarsIcon, /drawBar\(layout\.barsStartY, selection\.primaryPercent\)/);
  assert.match(renderBarsIcon, /selection\.secondaryPercent\)/);
  assert.doesNotMatch(renderBarsIcon, /Window\?\.remainingPercent/);
  assert.equal((renderBarsIcon.match(/drawBar\(/g) || []).length, 3);
  assert.doesNotMatch(renderBarsIcon, /\.find\(\(w\) => w\.kind/);
});

test('DeepSeek main Limits row preserves the intentional month-spend balance meter', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');
  const balanceWindow = readSharedFile('limitBalanceDisplay.js');
  const styles = readRendererFile('styles.css');

  assert.match(renderProviderWindows, /\{ remainingPercent: creditsMeterPercent\(provider, null\) \},/);
  assert.match(renderProviderWindows, /balanceNode\.classList\.add\('limit-window-wide', 'limit-window-no-reset'\);/);
  assert.match(renderProviderWindows, /const spendNode = providerSpendNode\(balance\);/);
  assert.match(app, /\['Week', optionalFiniteNumber\(balance\?\.weekSpend\)\]/);
  assert.match(app, /\['All time', optionalFiniteNumber\(balance\?\.allTimeSpend\)\]/);
  assert.doesNotMatch(renderProviderWindows, /Month \(since tracking\)/);
  assert.doesNotMatch(renderProviderWindows, /monthSinceTracking \? 'Month \(since tracking\)' : 'Month'/);
  // The month-spend denominator now lives in the shared balance module.
  assert.match(balanceWindow, /funds \+ spend/);
  assert.match(balanceWindow, /provider\?\.balance\?\.monthSpend/);
  assert.doesNotMatch(renderProviderWindows, /formatMoney\(balance\.amount, currency\)\} left/);
  assert.match(styles, /\.limit-window-no-reset \.limit-reset\s*\{/);
});

test('shared spend presentation preserves zeroes and omits missing periods', () => {
  const app = readRendererFile('app.js');
  const complete = runProviderSpendNode(app, {
    currency: 'CNY',
    todaySpend: 0,
    weekSpend: 1.25,
    monthSpend: 2.5,
    allTimeSpend: 3.75
  });

  assert.equal(complete.label, 'Spend');
  assert.equal(complete.summary, 'Today CNY 0.00 · Month CNY 2.50');
  assert.deepEqual(complete.detailEntries, [
    ['Today', 'CNY 0.00'],
    ['Week', 'CNY 1.25'],
    ['Month', 'CNY 2.50'],
    ['All time', 'CNY 3.75']
  ]);
  assert.deepEqual(complete.ariaParts, [
    'Today CNY 0.00',
    'Week CNY 1.25',
    'Month CNY 2.50',
    'All time CNY 3.75'
  ]);

  const missingWeek = runProviderSpendNode(app, {
    currency: 'CNY',
    todaySpend: 0,
    weekSpend: null,
    monthSpend: 2.5,
    allTimeSpend: 3.75
  });
  assert.equal(missingWeek.summary, 'Today CNY 0.00 · Month CNY 2.50');
  assert.deepEqual(missingWeek.detailEntries.map(([label]) => label), ['Today', 'Month', 'All time']);
  assert.equal(missingWeek.ariaParts.some((part) => part.startsWith('Week ')), false);
});

test('Balance and token quota values omit the redundant left suffix', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');

  assert.match(renderProviderWindows, /'Balance',\s*\{ \.\.\.balanceWindow, label: 'Balance' \},\s*color,\s*0\.95,\s*formatMoney\(balanceAmount, currency\)/);
  assert.match(renderProviderWindows, /\{ \.\.\.\(quotaWindow \|\| \{ showMeter: false \}\), label: balanceLabel \},\s*color,\s*0\.95,\s*balanceValue/);
  assert.doesNotMatch(renderProviderWindows, /`\$\{formatMoney\(balanceAmount, currency\)\} left`/);
  assert.doesNotMatch(renderProviderWindows, /`\$\{balanceValue\} left`/);
});

test('MiMo main Limits row falls back to balance plan fields for Token Plan', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');
  const tokenPlanFallback = functionBody(app, 'mimoTokenPlanWindowFromBalance', 'limitWindowNode');

  assert.match(renderProviderWindows, /const balance = provider\.balance \|\| null;/);
  assert.match(renderProviderWindows, /const tokenPlan = windowForKind\(provider, 'billing'\) \|\| mimoTokenPlanWindowFromBalance\(balance\);/);
  assert.match(renderProviderWindows, /limitWindowNode\(tokenPlan\.label \|\| 'Token Plan', tokenPlan, color, 0\.68\)/);
  assert.match(renderProviderWindows, /const giftBalance = optionalFiniteNumber\(balance\?\.giftBalance\);/);
  assert.match(renderProviderWindows, /const cashBalance = optionalFiniteNumber\(balance\?\.cashBalance\);/);
  assert.match(renderProviderWindows, /const balanceNode = limitWindowNode\(\s*'Balance',\s*\{ showMeter: false \},\s*color,\s*0\.68,\s*balanceText,\s*detailParts\.join\(' · '\)\s*\);/);
  assert.match(renderProviderWindows, /balanceNode\.classList\.add\('limit-window-wide', 'limit-window-no-reset'\);/);
  assert.match(tokenPlanFallback, /const used = optionalFiniteNumber\(balance\.planUsed\);/);
  assert.match(tokenPlanFallback, /const limit = optionalFiniteNumber\(balance\.planLimit\);/);
  assert.match(tokenPlanFallback, /const percent = optionalFiniteNumber\(balance\.planPercent\);/);
  assert.match(tokenPlanFallback, /if \(!hasUsed && !hasLimit && !hasPercent\) return null;/);
  assert.match(tokenPlanFallback, /usedPercent: resolvedPercent/);
  assert.match(tokenPlanFallback, /remainingPercent: resolvedPercent == null \? null : Math\.max\(0, Math\.min\(100, 100 - resolvedPercent\)\)/);
});

test('MiMo balance-only accounts do not synthesize an empty Token Plan meter', () => {
  const app = readRendererFile('app.js');
  const optionalNumber = functionBody(app, 'optionalFiniteNumber', 'formatLimitWindowValue');
  const tokenPlanFallback = functionBody(app, 'mimoTokenPlanWindowFromBalance', 'limitWindowNode');
  const context = {};
  vm.runInNewContext(`${optionalNumber}\n${tokenPlanFallback}\nresult = mimoTokenPlanWindowFromBalance({
    planUsed: null,
    planLimit: null,
    planPercent: null,
    planStatus: null
  });`, context);
  assert.equal(context.result, null);
});

test('MiMo expired Token Plan renders a localized status without a meter', () => {
  const app = readRendererFile('app.js');
  const i18n = readRendererFile('i18n.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');
  const tokenPlanFallback = functionBody(app, 'mimoTokenPlanWindowFromBalance', 'limitWindowNode');

  assert.match(renderProviderWindows, /balance\?\.planStatus === 'expired'/);
  assert.match(renderProviderWindows, /\{ showMeter: false \}, color, 0\.68, t\('limits\.mimo\.planExpired'\)/);
  assert.match(tokenPlanFallback, /if \(balance\.planStatus === 'expired'\) return null;/);
  assert.match(i18n, /'limits\.mimo\.planExpired': 'Expired'/);
  assert.match(i18n, /'limits\.mimo\.planExpired': '已过期'/);
  assert.match(i18n, /'limits\.mimo\.planExpired': '만료됨'/);
  assert.match(i18n, /'limits\.mimo\.planExpired': '期限切れ'/);
});

test('main Limits plan text shows failure status before account labels', () => {
  const app = readRendererFile('app.js');
  const planBody = functionBody(app, 'limitProviderPlan', 'configuredLimitProviderOrder');

  assert.match(planBody, /if \(provider\?\.status && provider\.status !== 'ok' && !provider\.stale\) return limitStatusLabel\(provider\.status, false\);/);
  assert.match(planBody, /const label = String\(provider\?\.planLabel \|\| provider\?\.accountLabel \|\| ''\)\.trim\(\);/);
});

test('settings provider status waits for stats and refreshes when stats arrive', () => {
  const app = readRendererFile('app.js');
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'onToolTrackingToggle');
  const refreshStats = functionBody(app, 'refreshStats', 'publishViewState');
  const statsPush = app.match(/window\.tokenMonitor\.onStatsPush\?\.\(\(payload\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  const statsRender = app.slice(
    app.indexOf('function renderStatsUpdate()'),
    app.indexOf('const statsRenderScheduler =')
  );
  const settingsPush = app.match(/window\.tokenMonitor\.onSettingsPush\?\.\(\(next\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  const syncSettings = functionBody(app, 'syncSettingsForm', 'enabledClientSet');

  assert.doesNotMatch(renderSettings, /state\.stats \? missingLimitProviderStatus\(\) : 'unavailable'/);
  assert.match(refreshStats, /statsRenderScheduler\.request\(\);/);
  assert.match(refreshStats, /applyCodexActiveAccountFromStats\(\);/);
  assert.doesNotMatch(refreshStats, /state\.codexActiveAccount = codexActiveAccountFromStats\(\);/);
  assert.match(statsPush, /applyCodexActiveAccountFromStats\(\);/);
  assert.match(statsPush, /statsRenderScheduler\.request\(\);/);
  assert.match(statsRender, /renderLimitProviderCheckboxes\(\);/);
  assert.match(statsRender, /renderCodexAccounts\(\);/);
  // Account cards read state.stats, so every path that refreshes stats must
  // re-render them. Grok is automatic and belongs only to the generic provider
  // list, so it must not retain a separate account-card renderer.
  // Settings pushes route through syncSettingsForm (which init() also calls), so
  // the two cards are re-rendered there and
  // onSettingsPush itself does not duplicate the calls.
  for (const fn of ['renderDeepseekStatus', 'renderMinimaxStatus']) {
    assert.match(statsRender, new RegExp(`${fn}\\(\\);`), `${fn} missing from renderStatsUpdate`);
    assert.match(syncSettings, new RegExp(`${fn}\\(\\);`), `${fn} missing from syncSettingsForm`);
  }
  for (const provider of ['claude', 'zai', 'volcengine', 'qoder', 'commandcode', 'kimi', 'ollama']) {
    assert.match(statsRender, new RegExp(`renderExternalProviderStatus\\('${provider}'\\);`), `${provider} missing from renderStatsUpdate`);
    assert.match(syncSettings, new RegExp(`renderExternalProviderStatus\\('${provider}'\\);`), `${provider} missing from syncSettingsForm`);
  }
  for (const fn of ['renderDeepseekStatus', 'renderMinimaxStatus']) {
    assert.doesNotMatch(settingsPush, new RegExp(`${fn}\\(\\);`), `${fn} should not be duplicated in onSettingsPush (syncSettingsForm covers it)`);
  }
  assert.doesNotMatch(app, /renderGrokStatus|grokAccountLinked|grokAccountExpanded/);
});

test('saving Ollama credentials enables its provider and always settles validation', () => {
  const app = readRendererFile('app.js');
  const renderExternalStatus = functionBody(app, 'renderExternalProviderStatus', 'setMinimaxAccountExpanded');
  const selection = functionBody(app, 'limitProviderSelectionIncluding', 'missingLimitProviderStatus');
  const setup = functionBody(app, 'setupCursorAccountUI', 'initSettingsAnimationWrappers');
  const ollamaSetup = setup.slice(
    setup.indexOf("document.getElementById('ollamaCookieSubmit')"),
    setup.indexOf('const kimiToggle')
  );
  assert.match(selection, /selected\.add\(providerName\)/);
  assert.match(selection, /\.filter\(\(id\) => selected\.has\(id\)\)/);
  assert.match(ollamaSetup, /limitProviders: limitProviderSelectionIncluding\('ollama'\)/);
  assert.match(ollamaSetup, /limitsEnabled: true/);
  assert.match(ollamaSetup, /await window\.tokenMonitor\.ollama\.validateCookie\(input\.value\)/);
  assert.match(ollamaSetup, /if \(!validation\?\.ok\)/);
  assert.doesNotMatch(ollamaSetup, /await refreshStats\(\{ force: true \}\);/);
  assert.match(ollamaSetup, /clearExternalProviderCheckPending\('ollama'\);/);
  assert.match(renderExternalStatus, /pending \? t\('settings\.common\.checking'\)/);
  assert.match(
    renderExternalStatus,
    /providerName === 'ollama' && wasPending && !pending && linked[\s\S]*?setExternalAccountExpanded\('ollama', false\)/,
    'Ollama should collapse only after a fresh provider confirms the account is linked'
  );
  assert.doesNotMatch(
    ollamaSetup,
    /input\.value = '';[\s\S]*?clearExternalProviderCheckPending\('ollama'\);[\s\S]*?setExternalAccountExpanded\('ollama', false\);/,
    'a successful save must stay pending until the collector publishes a fresh provider'
  );
  assert.doesNotMatch(
    ollamaSetup,
    /input\.value = '';[\s\S]*?setExternalAccountExpanded\('ollama', false\);/,
    'the setup panel must remain open while validation is pending'
  );
  assert.match(ollamaSetup, /catch \(err\) \{[\s\S]*?clearExternalProviderCheckPending\('ollama'\);[\s\S]*?renderExternalProviderStatus\('ollama'\);/);
  assert.match(ollamaSetup, /ollamaValidationError\(validation\)/);
});

test('account validation reads the local device raw limits, not the collapsed aggregate', () => {
  const app = readRendererFile('app.js');
  const rawHelper = functionBody(app, 'localDeviceLimitsProviders', 'localProviderStatus');
  const helper = functionBody(app, 'localProviderStatus', 'deepseekAccountLinked');
  // Sync-mode aggregateLimits() collapses a local `unauthorized` row out in favor
  // of a remote `ok` (providerCollapseKey for deepseek/minimax/grok is just the
  // provider name; pickBetterProvider keeps the higher statusRank). So the account
  // card must read the LOCAL device's RAW limits from state.stats.devices, where
  // the local unauthorized row still lives — not state.stats.limits.providers,
  // where it has already been dropped. Searching the aggregate would miss the
  // local row and fall back to the remote `ok`, falsely reporting an invalid
  // local key as Linked.
  assert.match(rawHelper, /accountIdentityApi\.localDeviceLimitsProviders/);
  assert.match(rawHelper, /state\.stats/);
  assert.match(rawHelper, /state\.settings\?\.deviceId/);
  assert.match(helper, /localDeviceLimitsProviders\(\)/);
  assert.match(helper, /localProviders !== null/);
  // Falls back to the aggregate only for legacy/non-aggregated stats that do
  // not expose raw device rows at all.
  assert.match(helper, /state\.stats\?\.limits\?\.providers/);
  assert.match(functionBody(app, 'deepseekProviderStatus', 'deepseekProviderForAccount'), /return localProviderStatus\('deepseek'\);/);
  assert.match(functionBody(app, 'minimaxProviderStatus', 'minimaxAccountLinked'), /return localProviderStatus\('minimax'\);/);
});

test('account validation does not treat a sole remote synced device as local', () => {
  const app = readRendererFile('app.js');
  const remoteOk = { provider: 'deepseek', status: 'ok', sourceDeviceId: 'office-pc' };
  const provider = runLocalProviderStatus(app, {
    settings: { deviceId: 'this-mac', deepseekApiKeyConfigured: true },
    stats: {
      devices: [{ deviceId: 'office-pc', limits: { providers: [remoteOk] } }],
      limits: { providers: [remoteOk] }
    }
  }, 'deepseek');

  assert.equal(provider, null);
});

test('Grok is automatic provider UI, while env token remains documented for headless use', () => {
  const html = readRendererFile('index.html');
  const app = readRendererFile('app.js');
  const i18n = readRendererFile('i18n.js');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const envExample = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  const grokLimits = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', 'grokLimits.js'), 'utf8');
  const rendererSettings = main.slice(
    main.indexOf('function settingsForRenderer'),
    main.indexOf('function pushSettingsToRenderer')
  );

  assert.doesNotMatch(html, /grokAccountGroup|grokSettingsToggle|settings\.grok\./);
  assert.doesNotMatch(app, /grokAccountExpanded|renderGrokStatus|grokAccountLinked|grokCookieConfigured/);
  assert.doesNotMatch(rendererSettings, /grokCookieConfigured|grokCookieSource|grokAuthJsonPath/);
  assert.match(envExample, /GROK_BEARER_TOKEN=/);
  assert.match(grokLimits, /GROK_BEARER_TOKEN/);
  assert.match(app, /'Run grok login': 'settings\.limits\.status\.runGrokLogin'/);
  assert.match(app, /'Re-login': 'settings\.limits\.status\.relogin'/);
  assert.match(i18n, /'settings\.limits\.status\.runGrokLogin': 'Run grok login'/);
  assert.match(i18n, /'settings\.limits\.status\.runGrokLogin': '執行 grok login'/);
  assert.match(i18n, /'settings\.limits\.status\.runGrokLogin': '运行 grok login'/);
});

test('Copilot env token is documented in env example, not the README overview', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  const readmeCn = fs.readFileSync(path.join(__dirname, '..', '..', 'README.zh-CN.md'), 'utf8');
  const readmeTw = fs.readFileSync(path.join(__dirname, '..', '..', 'README.zh-TW.md'), 'utf8');

  assert.match(envExample, /COPILOT_API_TOKEN=/);
  assert.match(envExample, /GITHUB_COPILOT_TOKEN/);
  assert.doesNotMatch(readme, /COPILOT_API_TOKEN|GITHUB_COPILOT_TOKEN/);
  assert.doesNotMatch(readmeCn, /COPILOT_API_TOKEN|GITHUB_COPILOT_TOKEN/);
  assert.doesNotMatch(readmeTw, /COPILOT_API_TOKEN|GITHUB_COPILOT_TOKEN/);
});

test('AI Tool Limits owns every live account group and its status pill', () => {
  const app = readRendererFile('app.js');
  const html = readRendererFile('index.html');
  const groupMap = app.slice(
    app.indexOf('const LIMIT_PROVIDER_ACCOUNT_GROUP_IDS = {'),
    app.indexOf('const LIMIT_PROVIDER_ACCOUNT_STATUS_IDS = {')
  );
  const statusMap = app.slice(
    app.indexOf('const LIMIT_PROVIDER_ACCOUNT_STATUS_IDS = {'),
    app.indexOf('const LIMIT_PROVIDER_CONNECTION_DETAIL_KEYS = {')
  );
  const providers = [
    ['claude', 'claudeAccountGroup', 'claudeAccountStatus'],
    ['codex', 'codexAccountGroup', 'codexAccountStatus'],
    ['opencode', 'opencodeCookieGroup', 'opencodeCookieStatus'],
    ['cursor', 'cursorAccountGroup', 'cursorAccountStatus'],
    ['kimi', 'kimiAccountGroup', 'kimiAccountStatus'],
    ['copilot', 'copilotAccountGroup', 'copilotApiTokenStatus'],
    ['mimo', 'mimoAccountGroup', 'mimoAccountStatus'],
    ['zai', 'zaiAccountGroup', 'zaiAccountStatus'],
    ['zaiteam', 'zaiteamAccountGroup', 'zaiteamAccountStatus'],
    ['deepseek', 'deepseekAccountGroup', 'deepseekApiKeyStatus'],
    ['openrouter', 'openrouterAccountGroup', 'openrouterStatus'],
    ['minimax', 'minimaxAccountGroup', 'minimaxApiKeyStatus'],
    ['volcengine', 'volcengineAccountGroup', 'volcengineAccountStatus'],
    ['qoder', 'qoderAccountGroup', 'qoderAccountStatus'],
    ['ollama', 'ollamaAccountGroup', 'ollamaAccountStatus'],
    ['thirdparty', 'thirdpartyAccountGroup', 'thirdpartyStatus']
  ];

  for (const [provider, groupId, statusId] of providers) {
    assert.match(groupMap, new RegExp(`${provider}: '${groupId}'`));
    assert.match(statusMap, new RegExp(`${provider}: '${statusId}'`));
    assert.match(html, new RegExp(`id="${groupId}"`));
    assert.match(html, new RegExp(`id="${statusId}"[^>]*class="cursor-status-pill`));
  }
  assert.match(html, /id="accountsSettingsDetails" class="hidden" aria-hidden="true"/);
  assert.doesNotMatch(html, /data-settings-section="accounts"/);
});

test('provider rerenders preserve live account nodes and focused controls', () => {
  const app = readRendererFile('app.js');
  const moveLiveNode = functionBody(app, 'moveLimitProviderLiveNode', 'renderLimitProviderCheckboxes');
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'limitProviderAccountGroup');
  const focusedInput = { id: 'deepseekApiKeyInput', isConnected: true };
  const oldParent = { isConnected: true };
  const disclosureIcon = { id: 'disclosureIcon' };
  const connectedParent = {
    isConnected: true,
    children: [disclosureIcon],
    moveBefore(node, before) {
      assert.equal(this.isConnected, true);
      assert.equal(node.isConnected, true);
      assert.equal(before, disclosureIcon);
      this.children.splice(this.children.indexOf(before), 0, node);
      node.parentElement = this;
    }
  };
  focusedInput.parentElement = oldParent;

  vm.runInNewContext(
    `${moveLiveNode}\nmoveLimitProviderLiveNode(connectedParent, focusedInput, disclosureIcon);`,
    { connectedParent, disclosureIcon, focusedInput }
  );

  assert.equal(focusedInput.parentElement, connectedParent);
  assert.deepEqual(connectedParent.children, [focusedInput, disclosureIcon]);
  assert.doesNotMatch(renderSettings, /replaceChildren|restoreLimitProviderAccountGroups/);
  assert.ok(
    renderSettings.indexOf('els.limitProviderCheckboxes.appendChild(row);')
      < renderSettings.indexOf('moveLimitProviderLiveNode(optionsInner, accountGroup);')
  );
  assert.ok(
    renderSettings.indexOf('moveLimitProviderLiveNode(optionsInner, accountGroup);')
      < renderSettings.indexOf('for (const row of previousRows) row.remove();')
  );
  assert.match(renderSettings, /accountGroup\.classList\.add\('limit-provider-account-group'\)/);
  assert.match(renderSettings, /document\.getElementById\(focusedId\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(app, /function restoreLimitProviderAccountGroups/);
});

test('background provider rerenders preserve settings scroll without a focused control', () => {
  const app = readRendererFile('app.js');
  const interactionStart = app.indexOf('const SETTINGS_SCROLL_ANCHOR_MS');
  const interactionEnd = app.indexOf('function shouldAnchorSettingsScroll', interactionStart);
  const scrollInteraction = app.slice(interactionStart, interactionEnd);
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'renderLimitProviderCheckboxesNow');
  const preserveScroll = functionBody(app, 'preserveSettingsPanelScroll', 'saveSettings');
  const panel = {
    scrollTop: 684,
    scrollLeft: 9,
    classList: { contains: () => false }
  };
  const frames = [];
  const els = {
    limitProviderCheckboxes: {},
    settingsPanel: panel
  };
  const renderLimitProviderCheckboxesNow = () => {
    // Removing the visible anchor rows can make Chromium clamp both axes while
    // the replacement list is being committed.
    panel.scrollTop = 112;
    panel.scrollLeft = 0;
  };

  vm.runInNewContext(
    `${scrollInteraction}\n${preserveScroll}\n${renderSettings}\nrenderLimitProviderCheckboxes();`,
    {
      cancelAnimationFrame: () => {},
      els,
      limitProviderRowDrag: { deferRender: () => false },
      renderLimitProviderCheckboxesNow,
      requestAnimationFrame: (callback) => frames.push(callback)
    }
  );

  assert.equal(panel.scrollTop, 684);
  assert.equal(panel.scrollLeft, 9);
  assert.equal(frames.length, 1);

  // A post-layout anchor adjustment must be corrected as well.
  panel.scrollTop = 112;
  panel.scrollLeft = 0;
  frames[0]();
  assert.equal(panel.scrollTop, 684);
  assert.equal(panel.scrollLeft, 9);
});

test('user scrolling wins over a pending provider scroll restore', () => {
  const app = readRendererFile('app.js');
  const interactionStart = app.indexOf('const SETTINGS_SCROLL_ANCHOR_MS');
  const interactionEnd = app.indexOf('function shouldAnchorSettingsScroll', interactionStart);
  const scrollInteraction = app.slice(interactionStart, interactionEnd);
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'renderLimitProviderCheckboxesNow');
  const preserveScroll = functionBody(app, 'preserveSettingsPanelScroll', 'saveSettings');
  const setupSections = functionBody(app, 'setupSettingsSections', 'refreshIntervalLabel');
  const listeners = new Map();
  const panel = {
    scrollTop: 200,
    scrollLeft: 0,
    classList: { contains: () => false },
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
  const frames = [];
  const els = {
    limitProviderCheckboxes: {},
    settingsPanel: panel
  };
  const renderLimitProviderCheckboxesNow = () => {};

  vm.runInNewContext(
    `${scrollInteraction}
${setupSections}
${preserveScroll}
${renderSettings}
setupSettingsSections();
renderLimitProviderCheckboxes();`,
    {
      cancelAnimationFrame: () => {},
      document: { querySelectorAll: () => [] },
      els,
      limitProviderRowDrag: { deferRender: () => false },
      renderLimitProviderCheckboxesNow,
      requestAnimationFrame: (callback) => frames.push(callback)
    }
  );

  panel.dispatch('wheel');
  panel.scrollTop = 240;
  frames[0]();
  assert.equal(panel.scrollTop, 240);
});

test('dynamic account summaries are never reset by the static translation pass', () => {
  const html = readRendererFile('index.html');
  const statusIds = [
    'claudeAccountStatus',
    'codexAccountStatus',
    'cursorAccountStatus',
    'opencodeCookieStatus',
    'openrouterStatus',
    'deepseekApiKeyStatus',
    'minimaxApiKeyStatus',
    'zaiAccountStatus',
    'zaiteamAccountStatus',
    'volcengineAccountStatus',
    'qoderAccountStatus',
    'ollamaAccountStatus',
    'kimiAccountStatus',
    'mimoAccountStatus',
    'copilotApiTokenStatus',
    'thirdpartyStatus'
  ];

  for (const id of statusIds) {
    const tag = html.match(new RegExp(`<span id="${id}"[^>]*>`))?.[0] || '';
    assert.ok(tag, `${id} should exist`);
    assert.doesNotMatch(tag, /data-i18n=/, `${id} is owned by its runtime status renderer`);
  }
});

test('provider toggles converge through the limits push without a forced refresh', () => {
  const app = readRendererFile('app.js');
  const body = functionBody(app, 'onLimitProviderToggle', 'onLimitProviderMove');

  assert.match(body, /saveSettings\(\{ limitProviders: checked\.join\(','\), limitsEnabled: checked\.length > 0 \}\)/);
  assert.match(body, /clearDisabledLimitProviderPendingChecks\(new Set\(checked\)\)/);
  assert.doesNotMatch(body, /refreshStats\(/);
});

test('empty OpenCode profiles render a localized summary before returning', () => {
  const app = readRendererFile('app.js');
  const renderProfiles = functionBody(app, 'renderOpenCodeProfiles', 'updateOpenCodeProfilesStatus');
  const renderSummary = functionBody(app, 'renderOpenCodeProfilesStatusSummary', 'openrouterProfileStatusText');
  const totalEl = { textContent: 'Not configured' };
  const context = {
    document: {
      getElementById(id) {
        return id === 'opencodeCookieStatus' ? totalEl : null;
      }
    },
    state: { opencodeProfileCount: 0 },
    t: (key, params) => params ? `${key}:${params.linked}/${params.total}` : `localized:${key}`
  };

  vm.runInNewContext(`${renderSummary}\nrenderOpenCodeProfilesStatusSummary({});`, context);

  assert.equal(totalEl.textContent, 'localized:settings.opencode.statusNotSet');
  assert.match(
    renderProfiles,
    /state\.opencodeProfileCount = 0;\s*renderOpenCodeProfilesStatusSummary\(\{\}\);\s*renderSettingsSummaries\(\);\s*return;/
  );
});

test('expanded provider options use the full row width without nested indentation', () => {
  const css = readRendererFile('styles.css');

  assert.match(css, /\.settings-panel \.limit-provider-settings-list\s*\{[^}]*margin: 0;[^}]*padding-left: 0;[^}]*border-left: 0;/);
  assert.match(css, /\.limit-provider-account-group\s*\{[^}]*margin-left: 0;/);
  assert.match(css, /\.limit-provider-account-group > \.cursor-settings-details\s*\{[^}]*margin-top: 0;/);
  assert.match(css, /\.limit-provider-connection-detail\s*\{[^}]*padding: 4px 0 2px;/);
});

test('Claude prepaid balance stays off and disabled until Web login is configured', () => {
  const app = readRendererFile('app.js');
  const renderList = functionBody(app, 'limitProviderSettingsList', 'onToolTrackingToggle');
  const settings = [{
    key: 'claudePrepaidBalanceEnabled',
    titleKey: 'settings.limits.prepaidBalance',
    descKey: 'settings.limits.prepaidBalanceDesc',
    requiresConfiguredKey: 'claudeWebCookieConfigured'
  }];

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.className = '';
      this.classList = {
        toggle: (name, enabled) => {
          if (enabled) this.className = `${this.className} ${name}`.trim();
        }
      };
    }
    append(...children) { this.children.push(...children); }
    addEventListener() {}
  }

  const context = {
    document: { createElement: (tagName) => new FakeElement(tagName) },
    state: {
      settings: {
        claudePrepaidBalanceEnabled: true,
        claudeWebCookieConfigured: false
      }
    },
    t: (key) => key
  };
  const loggedOutContext = { ...context, settings };
  vm.runInNewContext(
    `${renderList}\nresult = limitProviderSettingsList('claude', settings);`,
    loggedOutContext
  );
  const loggedOutInput = loggedOutContext.result?.children?.[0]?.children?.[1];
  assert.equal(loggedOutInput?.checked, false);
  assert.equal(loggedOutInput?.disabled, true);

  context.state.settings.claudeWebCookieConfigured = true;
  const loggedInContext = { ...context, settings };
  vm.runInNewContext(
    `${renderList}\nresult = limitProviderSettingsList('claude', settings);`,
    loggedInContext
  );
  const loggedInInput = loggedInContext.result?.children?.[0]?.children?.[1];
  assert.equal(loggedInInput?.checked, true);
  assert.equal(loggedInInput?.disabled, false);
});

test('OpenCode local DB fallback is off by default', () => {
  const app = readRendererFile('app.js');
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const renderList = functionBody(app, 'limitProviderSettingsList', 'onToolTrackingToggle');
  const defaults = functionBody(main, 'defaultSettings', 'normalizeCollectionMode');
  const updateHandler = main.slice(
    main.indexOf("ipcMain.handle('settings:update'"),
    main.indexOf("ipcMain.handle('settings:openConfig'")
  );
  const settings = [{
    key: 'opencodeLocalLimitsEnabled',
    titleKey: 'settings.limits.opencodeLocalLimits',
    descKey: 'settings.limits.opencodeLocalLimitsDesc',
    defaultValue: false
  }];

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.className = '';
      this.classList = {
        toggle: (name, enabled) => {
          if (enabled) this.className = `${this.className} ${name}`.trim();
        }
      };
    }
    append(...children) { this.children.push(...children); }
    addEventListener() {}
  }

  const context = {
    document: { createElement: (tagName) => new FakeElement(tagName) },
    state: { settings: {} },
    t: (key) => key
  };
  const settingsContext = { ...context, settings };
  vm.runInNewContext(
    `${renderList}\nresult = limitProviderSettingsList('opencode', settings);`,
    settingsContext
  );
  const input = settingsContext.result?.children?.[0]?.children?.[1];
  assert.equal(input?.checked, false);

  assert.match(defaults, /opencodeLocalLimitsEnabled:\s*false/);
  assert.match(updateHandler, /opencodeLocalLimitsEnabled:\s*parseBoolean\(patch\.opencodeLocalLimitsEnabled \?\? settings\.opencodeLocalLimitsEnabled, false\)/);
});

test('provider option rerenders reuse the existing switch DOM', () => {
  const app = readRendererFile('app.js');
  const renderRows = functionBody(app, 'renderLimitProviderCheckboxesNow', 'limitProviderAccountGroup');
  const renderList = functionBody(app, 'limitProviderSettingsList', 'onToolTrackingToggle');

  assert.match(renderRows, /const reusableSettingInputs = new Map\(\);/);
  assert.match(renderRows, /state\.limitProviderRenderSignature === renderSignature/);
  assert.match(renderRows, /row\.querySelectorAll\?\.\(/);
  assert.match(renderRows, /limitProviderSettingsList\(id, settings, reusableSettingInputs\)/);
  assert.match(renderList, /const existingInput = reusableInputs\?\.get\(inputKey\);/);
  assert.match(renderList, /if \(!existingInput\) \{\s*input\.addEventListener\('change'/);
  assert.doesNotMatch(renderList, /renderLimits\(\);/);
});

test('settings pushes do not trigger a second full settings sync after save', () => {
  const app = readRendererFile('app.js');
  const save = functionBody(app, 'saveSettings', 'renderHomeIfVisible');
  const settingsPush = app.match(/window\.tokenMonitor\.onSettingsPush\?\.\(\(next\) => \{[\s\S]*?\n\}\);/)?.[0] || '';

  assert.match(save, /const settingsPushRevision = state\.settingsPushRevision;/);
  assert.match(save, /if \(state\.settingsPushRevision === settingsPushRevision\) \{\s*preserveSettingsPanelScroll\(syncSettingsForm\);/);
  assert.match(settingsPush, /state\.settingsPushRevision \+= 1;/);
});

test('main limits rerenders coalesce identical visible provider data', () => {
  const app = readRendererFile('app.js');
  const renderLimits = functionBody(app, 'renderLimits', 'serviceStatusLabel');

  assert.match(renderLimits, /const renderSignature = JSON\.stringify\(\{/);
  assert.match(renderLimits, /state\.limitPanelRenderSignature === renderSignature/);
  assert.match(renderLimits, /els\.limitsPanel\.children\.length === orderedProviders\.length/);
  assert.match(renderLimits, /state\.limitPanelRenderSignature = renderSignature;/);
});

test('successful providers use a green dot while preserving source and account labels', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'limitProviderAccountGroup');

  assert.match(renderSettings, /const detected = provider\.status === 'ok' && !provider\.stale/);
  assert.match(renderSettings, /dot\.className = 'limit-provider-status-dot'/);
  assert.match(renderSettings, /if \(\(detected \|\| !isEnabled\) && tagInfo\.kind === 'status'\) continue/);
  assert.match(renderSettings, /tag\.className = `limit-provider-tag limit-provider-tag-\$\{tagInfo\.kind\}`/);
  assert.match(renderSettings, /moveLimitProviderLiveNode\(actions, accountStatus, disclosureIcon\)/);
  assert.match(css, /\.limit-provider-status-dot\s*\{[\s\S]*?background: var\(--success\)/);
});

test('account and automatic provider panels reuse the original account summary geometry', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const i18n = readRendererFile('i18n.js');
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'limitProviderAccountGroup');

  assert.match(renderSettings, /main\.className = 'limit-provider-main'/);
  assert.match(renderSettings, /disclosureIcon\.className = 'cursor-disclosure-icon'/);
  assert.match(renderSettings, /actions\.append\(disclosureIcon\)/);
  assert.match(renderSettings, /moveLimitProviderLiveNode\(actions, accountStatus, disclosureIcon\)/);
  assert.match(renderSettings, /mode\.className = 'cursor-status-pill limit-provider-mode-pill'/);
  assert.match(renderSettings, /mode\.textContent = t\('settings\.limits\.connection\.autoDetect'\)/);
  assert.match(renderSettings, /connectionDetailKey && tagInfo\.label === 'Auto'/);
  assert.match(renderSettings, /accountGroup && tagInfo\.label === 'Manual login'/);
  assert.match(renderSettings, /if \(duplicatesInlineSetup\) continue/);
  assert.match(renderSettings, /main\.append\(copy, actions\)/);
  assert.doesNotMatch(renderSettings, /limit-provider-disclosure/);
  assert.doesNotMatch(renderSettings, /view-subgroup-toggle|view-subgroup-icon/);
  assert.match(app, /antigravity: 'settings\.limits\.connection\.antigravity'/);
  assert.match(app, /grok: 'settings\.limits\.connection\.grok'/);
  assert.match(app, /kiro: 'settings\.limits\.connection\.kiro'/);
  assert.equal((i18n.match(/'settings\.limits\.connection\.title':/g) || []).length, 5);
  assert.equal((i18n.match(/'settings\.limits\.connection\.autoDetect':/g) || []).length, 5);
  assert.equal((i18n.match(/'settings\.limits\.connection\.antigravity':/g) || []).length, 5);
  assert.equal((i18n.match(/'settings\.limits\.connection\.grok':/g) || []).length, 5);
  assert.equal((i18n.match(/'settings\.limits\.connection\.kiro':/g) || []).length, 5);
  assert.match(css, /\.limit-provider-main\s*\{[\s\S]*?display: flex;[\s\S]*?justify-content: space-between/);
  assert.match(css, /\.limit-provider-actions\s*\{[\s\S]*?flex: 0 1 auto;[\s\S]*?max-width: 58%;[\s\S]*?gap: 4px/);
  assert.doesNotMatch(css, /\.limit-provider-actions > \.cursor-status-pill\s*\{[^}]*min-width:/);
  assert.match(css, /\.limit-provider-row\.expanded > \.limit-provider-main \.cursor-disclosure-icon/);
});

test('disabled providers use checkbox state instead of a redundant status tag', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'limitProviderAccountGroup');

  assert.match(renderSettings, /row\.className = `limit-provider-row\$\{isEnabled \? '' : ' is-disabled'\}`/);
  assert.match(renderSettings, /if \(\(detected \|\| !isEnabled\) && tagInfo\.kind === 'status'\) continue/);
  assert.match(css, /\.limit-provider-row\.is-disabled \.limit-provider-main\s*\{[^}]*color: var\(--muted\)/);
  assert.match(css, /\.limit-provider-row\.is-disabled \.limit-provider-tag\s*\{[^}]*color: var\(--muted\)/);
});

test('provider checkboxes are named by their visible provider name', () => {
  const app = readRendererFile('app.js');
  const connectName = functionBody(app, 'connectLimitProviderCheckboxName', 'renderLimitProviderCheckboxes');
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'limitProviderAccountGroup');
  const checkbox = {
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  };
  const nameNode = { id: '', textContent: 'Codex' };

  vm.runInNewContext(
    `${connectName}\nconnectLimitProviderCheckboxName(checkbox, nameNode, 'codex');`,
    { checkbox, nameNode }
  );

  assert.equal(nameNode.id, 'limitProviderName-codex');
  assert.equal(checkbox.attributes['aria-labelledby'], nameNode.id);
  assert.equal(nameNode.textContent, 'Codex');
  assert.match(renderSettings, /connectLimitProviderCheckboxName\(cb, text, id\)/);
});

test('account validation does not use a remote aggregate when the local device lacks the provider', () => {
  const app = readRendererFile('app.js');
  const remoteOk = { provider: 'minimax', status: 'ok', sourceDeviceId: 'office-pc' };
  const provider = runLocalProviderStatus(app, {
    settings: { deviceId: 'this-mac', minimaxApiKeyConfigured: true },
    stats: {
      devices: [
        { deviceId: 'this-mac', limits: { providers: [] } },
        { deviceId: 'office-pc', limits: { providers: [remoteOk] } }
      ],
      limits: { providers: [remoteOk] }
    }
  }, 'minimax');

  assert.equal(provider, null);
});

test('active Codex account follows the local login, not a remote device signed into a different account', () => {
  // Local machine is signed into account C (App) and only manages the other two.
  // A synced device is signed into account A, so aggregateLimits() picks its live
  // App record for the account A row — which sorts first. Reading the aggregate
  // would move the ✓ onto account A; the marker must instead track this device's
  // own live login (account C).
  const app = readRendererFile('app.js');
  const localProviders = [
    { provider: 'codex', status: 'ok', sourceDetail: 'managed', accountKey: 'sha256:account-a', accountEmail: 'primary@example.com' },
    { provider: 'codex', status: 'ok', sourceDetail: 'managed', accountKey: 'sha256:account-b', accountEmail: 'secondary@example.com' },
    { provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'sha256:account-c', accountEmail: 'tertiary@example.com' }
  ];
  const remoteAccountALive = { provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'sha256:account-a', accountEmail: 'primary@example.com', sourceDeviceId: 'remote-device' };
  const provider = runLocalLiveCodexProvider(app, {
    settings: { deviceId: 'this-mac' },
    stats: {
      devices: [
        { deviceId: 'this-mac', limits: { providers: localProviders } },
        { deviceId: 'remote-device', limits: { providers: [remoteAccountALive] } }
      ],
      limits: { providers: [remoteAccountALive, localProviders[1], localProviders[2]] }
    }
  });

  assert.equal(provider.accountKey, 'sha256:account-c');
});

test('no active Codex account when this device is signed out, even if a synced device is live', () => {
  const app = readRendererFile('app.js');
  const remoteLive = { provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'sha256:account-a', sourceDeviceId: 'remote-device' };
  const provider = runLocalLiveCodexProvider(app, {
    settings: { deviceId: 'this-mac' },
    stats: {
      devices: [
        { deviceId: 'this-mac', limits: { providers: [{ provider: 'codex', status: 'ok', sourceDetail: 'managed', accountKey: 'sha256:account-a' }] } },
        { deviceId: 'remote-device', limits: { providers: [remoteLive] } }
      ],
      limits: { providers: [remoteLive] }
    }
  });

  assert.equal(provider, null);
});

test('active Codex account falls back to the aggregate for legacy stats without device rows', () => {
  const app = readRendererFile('app.js');
  const live = { provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'sha256:solo' };
  const provider = runLocalLiveCodexProvider(app, {
    settings: { deviceId: 'this-mac' },
    stats: { limits: { providers: [live] } }
  });

  assert.equal(provider.accountKey, 'sha256:solo');
});

test('account validation keeps aggregate fallback for legacy stats without device rows', () => {
  const app = readRendererFile('app.js');
  const aggregateOk = { provider: 'deepseek', status: 'ok', sourceDeviceId: 'this-mac' };
  const provider = runLocalProviderStatus(app, {
    settings: { deviceId: 'this-mac', deepseekApiKeyConfigured: true },
    stats: { limits: { providers: [aggregateOk] } }
  }, 'deepseek');

  assert.equal(provider.status, 'ok');
  assert.equal(provider.sourceDeviceId, 'this-mac');
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

test('OpenRouter uses API-key setup copy and pay-as-you-go capability tags', () => {
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'openrouter', source: 'api' }), 'API');
  assert.deepEqual(presentation.limitProviderCapabilityTags('openrouter'), ['Pay-as-you-go', 'API key']);
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'openrouter', status: 'notConfigured' }),
    { label: 'Add API key', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'openrouter', status: 'unauthorized' }),
    { label: 'Update API key', tone: 'setup' }
  );
});

test('third-party API uses credential setup copy and relay capability tags', () => {
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'thirdparty', source: 'api' }), 'API');
  assert.deepEqual(presentation.limitProviderCapabilityTags('thirdparty'), ['Relay', 'API']);
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'thirdparty', status: 'notConfigured' }),
    { label: 'Add credential', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'thirdparty', status: 'unauthorized' }),
    { label: 'Update credential', tone: 'setup' }
  );
});

test('minimax status copy uses the same API key wording as CodexBar', () => {
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'minimax', status: 'notConfigured' }),
    { label: 'Add API key', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'minimax', status: 'unauthorized' }),
    { label: 'Update API key', tone: 'setup' }
  );
});

test('mimo setup status uses the generic not configured and sign-in-again copy', () => {
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'mimo', status: 'notConfigured' }),
    { label: 'Not set up', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'mimo', status: 'unauthorized' }),
    { label: 'Sign in again', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'mimo', status: 'error' }),
    { label: 'Unavailable', tone: 'warn' }
  );
});

test('copilot setup status asks for sign-in instead of an API key', () => {
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'copilot', status: 'notConfigured' }),
    { label: 'Sign in', tone: 'setup' }
  );
});

test('Z.ai, Volcengine, Qoder, and Ollama source labels and setup statuses', () => {
  assert.deepEqual(presentation.limitProviderCapabilityTags('zai'), ['Coding Plan', 'API key']);
  assert.deepEqual(presentation.limitProviderCapabilityTags('volcengine'), ['Coding Plan', 'API key']);
  assert.deepEqual(presentation.limitProviderCapabilityTags('qoder'), ['Manual login', 'Web']);
  assert.deepEqual(presentation.limitProviderCapabilityTags('ollama'), ['Manual login', 'Web']);
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'zai', source: 'api' }), 'API');
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'volcengine', source: 'api' }), 'API');
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'qoder', source: 'web' }), 'Web');
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'ollama', source: 'web' }), 'Web');
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'zai', status: 'notConfigured' }),
    { label: 'Add API key', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'volcengine', status: 'unauthorized' }),
    { label: 'Update API key', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'qoder', status: 'notConfigured' }),
    { label: 'Sign in', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'qoder', status: 'unauthorized' }),
    { label: 'Sign in again', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'ollama', status: 'notConfigured' }),
    { label: 'Sign in', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'ollama', status: 'unauthorized' }),
    { label: 'Sign in again', tone: 'setup' }
  );
});

test('Kimi capability tags and source label', () => {
  assert.deepEqual(presentation.limitProviderCapabilityTags('kimi'), ['Coding Plan', 'Web/API']);
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'kimi', source: 'api' }), 'API');
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'kimi', source: 'web' }), 'Web');
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'kimi', status: 'notConfigured' }),
    { label: 'Add credential', tone: 'setup' }
  );
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'kimi', status: 'unauthorized' }),
    { label: 'Update credential', tone: 'setup' }
  );
});

test('Kimi credential statuses are localized in settings', () => {
  const app = readRendererFile('app.js');
  const i18n = readRendererFile('i18n.js');
  assert.match(app, /'Add credential': 'settings\.limits\.status\.addCredential'/);
  assert.match(app, /'Update credential': 'settings\.limits\.status\.updateCredential'/);
  assert.match(i18n, /'settings\.limits\.status\.addCredential': '新增憑證'/);
  assert.match(i18n, /'settings\.limits\.status\.updateCredential': '更新憑證'/);
});

test('Kimi usage and limits share the canonical provider id and vendor color', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /\{ id: 'kimi', label: 'Kimi' \}/);
  assert.match(app, /const color = id === 'mimo' \? clientColors\.xiaomi : \(clientColors\[id\] \|\| clientColors\.default\)/);
});

// A value produced inside a vm realm carries that realm's prototypes, which
// deepStrictEqual rejects as "same structure but not reference-equal".
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function cssBlock(styles, selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} rule should exist`);
  const end = styles.indexOf('}', start);
  assert.notEqual(end, -1, `${selector} rule should close`);
  return styles.slice(start, end + 1);
}

test('the subscription tooltip escapes both the plan label and the scrolling panel', () => {
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  const decorate = functionBody(app, 'decoratePlanWithSubscription', 'subscriptionRowTitle');
  const position = functionBody(app, 'positionSubscriptionTooltip', 'decoratePlanWithSubscription');

  // The wrap also carries .limit-plan, whose overflow:hidden clips the card away
  // entirely — the card sits above the label, outside that 10px-tall box.
  assert.match(cssBlock(styles, '.subscription-plan-wrap'), /overflow: visible;/);
  // And .limits-panel clips its own overflow, so on the topmost row the upward
  // card lands outside the panel. It flips below when there is no room above.
  assert.match(decorate, /positionSubscriptionTooltip\(wrap, card\);/);
  assert.match(position, /closest\('\.limits-panel'\)/);
  assert.match(position, /classList\.toggle\('is-below'/);
  assert.match(styles, /\.subscription-tooltip\.is-below \{/);
});

test('an attached subscription adds no resting decoration to the plan label', () => {
  const styles = readRendererFile('styles.css');
  assert.doesNotMatch(cssBlock(styles, '.subscription-plan-trigger'), /border-bottom/);
});

test('subscription form controls stay shrinkable so a long option cannot overflow the panel', () => {
  const styles = readRendererFile('styles.css');
  const block = cssBlock(styles, '.subscription-add-body .settings-row > :is(input, select)');
  assert.match(block, /flex: 1 1 0;/);
  assert.match(block, /min-width: 0;/);
  // Descendant, not child: each kind of record wraps its own rows, so a child
  // selector would stop reaching most of the form.
  assert.doesNotMatch(styles, /\.subscription-add-body > \.settings-row/);
});

test('subscription field groups keep their rows separated', () => {
  const styles = readRendererFile('styles.css');
  const fields = cssBlock(styles, '.subscription-add-body .subscription-kind-fields');
  assert.match(fields, /display: flex;/);
  assert.match(fields, /flex-direction: column;/);
  assert.match(fields, /gap: 8px;/);
  assert.doesNotMatch(cssBlock(styles, '.subscription-topup-heading-row'), /margin-bottom/);
  assert.doesNotMatch(styles, /\.subscription-topup-add-row\s*\{\s*margin-top/);
});

test('subscription validation errors stay inside the active editor', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /id="subscriptionErrorMessage" class="settings-note error subscription-form-error hidden" role="alert"/);
  assert.match(html, /subscriptionErrorMessage[\s\S]*subscriptionSubmit/);
  assert.doesNotMatch(html, /subscriptionTotalRow[\s\S]*subscriptionErrorMessage/);
});

test('the add action switches directly from editing to a new editor', () => {
  const app = readRendererFile('app.js');
  const beginAdd = functionBody(app, 'beginSubscriptionAdd', 'beginSubscriptionEdit');

  assert.match(beginAdd, /resetSubscriptionForm\(\);/);
  assert.match(beginAdd, /renderSubscriptionRows\(\);/);
  assert.match(beginAdd, /openSubscriptionAddEditor\(\);/);
  assert.match(app, /if \(state\.subscriptionEditingId\) \{\s*closeSubscriptionEditor\(\{ onClosed: openSubscriptionAddEditor \}\);/);
});

test('subscription editor captures its version before the opening animation', () => {
  const app = readRendererFile('app.js');
  const open = functionBody(app, 'openSubscriptionEditor', 'closeSubscriptionEditor');
  const setOpen = functionBody(app, 'setSubscriptionFormOpen', 'seedSubscriptionPlanName');
  const frames = [];
  const details = {
    classList: { add() {} },
    getBoundingClientRect() {}
  };
  const state = {
    settings: { subscriptionsHub: 'hub-a', subscriptionsUpdatedAt: 'version-a' },
    subscriptionEditorTransitionId: 0,
    subscriptionFormBase: null
  };
  const els = { subscriptionAddDetails: details };
  const subscriptionSettingsVersion = () => ({
    hub: state.settings.subscriptionsHub,
    updatedAt: state.settings.subscriptionsUpdatedAt
  });

  vm.runInNewContext(
    `${open}\nopenSubscriptionEditor();`,
    {
      cancelSubscriptionEditorClose() {},
      els,
      requestAnimationFrame: (callback) => frames.push(callback),
      setSubscriptionFormOpen(open, formBase) {
        state.subscriptionFormBase = formBase;
      },
      state,
      subscriptionSettingsVersion
    }
  );

  state.settings.subscriptionsUpdatedAt = 'version-b';
  frames[0]();
  assert.deepEqual(state.subscriptionFormBase, { hub: 'hub-a', updatedAt: 'version-a' });
  assert.doesNotMatch(setOpen, /formBase \|\| state\.subscriptionFormBase/);
});

test('closing the subscription editor restores focus to the rebuilt row action', () => {
  const app = readRendererFile('app.js');
  const close = functionBody(app, 'closeSubscriptionEditor', 'setSubscriptionDateBound');
  const input = {};
  const oldEdit = { focus() {} };
  const newEdit = { focused: false, focus() { this.focused = true; } };
  const finalEdit = { focused: false, focus() { this.focused = true; } };
  const rowFor = (edit) => ({
    dataset: { subscriptionId: 'subscription-1' },
    querySelector: (selector) => selector === '.subscription-row-edit' ? edit : null
  });
  const dom = { rows: [rowFor(oldEdit)] };
  let finish;
  const list = { querySelectorAll: () => dom.rows };
  const details = {
    classList: { contains: () => false },
    contains: (node) => node === input,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const state = { subscriptionEditingId: 'subscription-1', subscriptionEditorTransitionId: 0 };
  const context = vm.createContext({
    document: { activeElement: oldEdit },
    els: { subscriptionAddDetails: details, subscriptionList: list },
    state,
    dom,
    rowFor,
    finalEdit,
    cancelSubscriptionEditorClose() {},
    setSubscriptionFormOpen() {},
    resetSubscriptionForm() { state.subscriptionEditingId = ''; },
    renderSubscriptionRows() { dom.rows = [rowFor(newEdit)]; },
    clearTimeout() {},
    setTimeout(callback) { finish = callback; return 1; }
  });

  vm.runInContext(
    `const SUBSCRIPTION_EDITOR_TRANSITION_MS = 250;\nlet subscriptionEditorCloseCleanup = null;\n${close}\ncloseSubscriptionEditor({ onClosed: () => { dom.rows = [rowFor(finalEdit)]; } });`,
    context
  );
  assert.equal(finalEdit.focused, false);
  finish();

  assert.equal(newEdit.focused, false);
  assert.equal(finalEdit.focused, true);
});

test('closing the subscription editor does not steal focus moved to another control', () => {
  const app = readRendererFile('app.js');
  const close = functionBody(app, 'closeSubscriptionEditor', 'setSubscriptionDateBound');
  const oldEdit = { focus() {} };
  const otherControl = {};
  const finalEdit = { focused: false, focus() { this.focused = true; } };
  const rowFor = (edit) => ({
    dataset: { subscriptionId: 'subscription-1' },
    querySelector: (selector) => selector === '.subscription-row-edit' ? edit : null
  });
  const dom = { rows: [rowFor(oldEdit)] };
  const documentState = { activeElement: oldEdit, body: {} };
  let finish;
  const list = { querySelectorAll: () => dom.rows };
  const details = {
    classList: { contains: () => false },
    contains: () => false,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const state = { subscriptionEditingId: 'subscription-1', subscriptionEditorTransitionId: 0 };
  const context = vm.createContext({
    document: documentState,
    els: { subscriptionAddDetails: details, subscriptionList: list },
    state,
    dom,
    rowFor,
    finalEdit,
    cancelSubscriptionEditorClose() {},
    setSubscriptionFormOpen() {},
    resetSubscriptionForm() { state.subscriptionEditingId = ''; },
    renderSubscriptionRows() { dom.rows = [rowFor(finalEdit)]; },
    clearTimeout() {},
    setTimeout(callback) { finish = callback; return 1; }
  });

  vm.runInContext(
    `const SUBSCRIPTION_EDITOR_TRANSITION_MS = 250;\nlet subscriptionEditorCloseCleanup = null;\n${close}\ncloseSubscriptionEditor();`,
    context
  );
  documentState.activeElement = otherControl;
  finish();

  assert.equal(documentState.activeElement, otherControl);
  assert.equal(finalEdit.focused, false);
});

test('closing a new subscription editor restores focus to the Add action', () => {
  const app = readRendererFile('app.js');
  const close = functionBody(app, 'closeSubscriptionEditor', 'setSubscriptionDateBound');
  const input = {};
  const addToggle = { focused: false, focus() { this.focused = true; } };
  const documentState = { activeElement: input, body: {} };
  const details = {
    classList: { contains: () => false },
    contains: (node) => node === input,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const state = { subscriptionEditingId: '', subscriptionEditorTransitionId: 0 };
  let finish;
  const context = vm.createContext({
    document: documentState,
    els: { subscriptionAddDetails: details, subscriptionAddToggle: addToggle },
    state,
    cancelSubscriptionEditorClose() {},
    setSubscriptionFormOpen() {},
    resetSubscriptionForm() {},
    renderSubscriptionRows() {},
    clearTimeout() {},
    setTimeout(callback) { finish = callback; return 1; }
  });

  vm.runInContext(
    `const SUBSCRIPTION_EDITOR_TRANSITION_MS = 250;\nlet subscriptionEditorCloseCleanup = null;\n${close}\ncloseSubscriptionEditor();`,
    context
  );
  finish();

  assert.equal(addToggle.focused, true);
});

test('canceling a close settles its deferred render exactly once', () => {
  const app = readRendererFile('app.js');
  const cancel = functionBody(app, 'cancelSubscriptionEditorClose', 'openSubscriptionEditor');
  const close = functionBody(app, 'closeSubscriptionEditor', 'setSubscriptionDateBound');
  const details = {
    classList: { contains: () => false },
    contains: () => false,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const state = { subscriptionEditingId: '', subscriptionEditorTransitionId: 0 };
  const context = vm.createContext({
    document: { activeElement: null, body: {} },
    els: { subscriptionAddDetails: details },
    state,
    setSubscriptionFormOpen() {},
    resetSubscriptionForm() {},
    renderSubscriptionRows() {},
    clearTimeout() {},
    setTimeout() { return 1; },
    renderCount: 0
  });

  vm.runInContext(
    `const SUBSCRIPTION_EDITOR_TRANSITION_MS = 250;\nlet subscriptionEditorCloseCleanup = null;\nlet subscriptionEditorCloseOnCanceled = null;\n${cancel}\n${close}\ncloseSubscriptionEditor({ onCanceled: () => { renderCount += 1; } });`,
    context
  );
  assert.equal(context.renderCount, 0);
  vm.runInContext('cancelSubscriptionEditorClose();', context);

  assert.equal(context.renderCount, 1);
});

test('canceling an edit-to-add close does not run its stale onClosed callback', () => {
  const app = readRendererFile('app.js');
  const cancel = functionBody(app, 'cancelSubscriptionEditorClose', 'openSubscriptionEditor');
  const close = functionBody(app, 'closeSubscriptionEditor', 'setSubscriptionDateBound');
  const details = {
    classList: { contains: () => false },
    contains: () => false,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const state = { subscriptionEditingId: 'subscription-a', subscriptionEditorTransitionId: 0 };
  const context = vm.createContext({
    document: { activeElement: null, body: {} },
    els: { subscriptionAddDetails: details },
    state,
    cancelSubscriptionEditorClose() {},
    setSubscriptionFormOpen() {},
    resetSubscriptionForm() {},
    renderSubscriptionRows() {},
    clearTimeout() {},
    setTimeout() { return 1; },
    staleCallbackCalls: 0,
    canceledCallbackCalls: 0
  });

  vm.runInContext(
    `const SUBSCRIPTION_EDITOR_TRANSITION_MS = 250;\nlet subscriptionEditorCloseCleanup = null;\nlet subscriptionEditorCloseOnCanceled = null;\n${cancel}\n${close}\ncloseSubscriptionEditor({ onClosed: () => { staleCallbackCalls += 1; }, onCanceled: () => { canceledCallbackCalls += 1; } });`,
    context
  );
  vm.runInContext('cancelSubscriptionEditorClose();', context);

  assert.equal(context.staleCallbackCalls, 0);
  assert.equal(context.canceledCallbackCalls, 1);
});

test('switching to another edit preserves its form values during a canceled close', () => {
  const app = readRendererFile('app.js');
  const cancel = functionBody(app, 'cancelSubscriptionEditorClose', 'openSubscriptionEditor');
  const close = functionBody(app, 'closeSubscriptionEditor', 'setSubscriptionDateBound');
  const beginEdit = functionBody(app, 'beginSubscriptionEdit', 'submitSubscription');
  const details = {
    classList: { contains: () => false },
    contains: () => false,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const fields = {
    provider: { value: '' },
    account: { value: '' },
    kind: '',
    plan: { value: '' },
    amount: { value: '' },
    currency: { value: '' },
    intervalCount: { value: '' },
    interval: { value: '' },
    startDate: { value: '' },
    nextRenewal: { value: '' },
    autoRenew: { checked: false },
    submit: { textContent: '' },
    cancel: { classList: { add() {}, remove() {} } }
  };
  const kindInputs = [
    { value: 'subscription', checked: false },
    { value: 'topup', checked: false }
  ];
  const account = { provider: 'codex', accountKey: 'acct-b', accountName: 'B' };
  const records = [
    { id: 'subscription-a', provider: 'codex', kind: 'subscription', planName: 'A plan', amountMinor: 1000, currency: 'USD', intervalCount: 1, interval: 'month', startDate: '2026-01-01', autoRenew: true, nextRenewalOverride: '', endDate: null, topUps: [] },
    { id: 'subscription-b', provider: 'codex', kind: 'topup', planName: 'B plan', amountMinor: 2000, currency: 'HKD', intervalCount: 1, interval: 'month', startDate: '2026-02-01', autoRenew: true, nextRenewalOverride: '2026-03-01', endDate: null, topUps: [{ id: 'topup-b', date: '2026-02-01', amountMinor: 2000 }] }
  ];
  const state = { subscriptionEditingId: 'subscription-a', subscriptionEditorTransitionId: 0, subscriptionTopUps: [] };
  const context = vm.createContext({
    document: { activeElement: null, body: {} },
    els: {
      subscriptionAddDetails: details,
      subscriptionList: { querySelectorAll: () => [] },
      subscriptionProviderInput: fields.provider,
      subscriptionAccountInput: fields.account,
      subscriptionPlanNameInput: fields.plan,
      subscriptionAmountInput: fields.amount,
      subscriptionCurrencyInput: fields.currency,
      subscriptionIntervalCountInput: fields.intervalCount,
      subscriptionIntervalInput: fields.interval,
      subscriptionStartDateInput: fields.startDate,
      subscriptionNextRenewalInput: fields.nextRenewal,
      subscriptionAutoRenewInput: fields.autoRenew,
      subscriptionSubmit: fields.submit,
      subscriptionCancelEdit: fields.cancel,
      subscriptionKindInputs: kindInputs
    },
    fields,
    kindInputs,
    state,
    subscriptionList: () => records,
    subscriptionApi: {
      matchProviderAccount: () => account,
      amountUnits: (subscription) => subscription.amountMinor / 100
    },
    limitProvidersForSubscriptions: () => [],
    subscriptionAccountValue: () => 'acct-b',
    renderSubscriptionPickers() {},
    setSubscriptionFormMode: () => {},
    syncSubscriptionDateBounds: () => {},
    positionSubscriptionEditor: () => {},
    setSubscriptionError: () => {},
    t: () => 'Update subscription',
    setSubscriptionFormOpen() {},
    resetSubscriptionForm() {},
    renderSubscriptionRows() {},
    clearTimeout() {},
    setTimeout() { return 1; },
    staleCallbackCalls: 0
  });

  vm.runInContext(
    `const SUBSCRIPTION_EDITOR_TRANSITION_MS = 250;\nlet subscriptionEditorCloseCleanup = null;\nlet subscriptionEditorCloseOnCanceled = null;\n${cancel}\n${close}\nfunction openSubscriptionEditor() { cancelSubscriptionEditorClose(); }\n${beginEdit}\ncloseSubscriptionEditor({ onClosed: () => { staleCallbackCalls += 1; fields.plan.value = 'Add default'; kindInputs[0].checked = true; kindInputs[1].checked = false; } });\nbeginSubscriptionEdit('subscription-b');`,
    context
  );

  assert.equal(context.staleCallbackCalls, 0);
  assert.equal(context.fields.plan.value, 'B plan');
  assert.equal(context.kindInputs[0].checked, false);
  assert.equal(context.kindInputs[1].checked, true);
  assert.equal(context.fields.amount.value, '20');
});

test('a successful subscription save defers the full render until close completes', async () => {
  const app = readRendererFile('app.js');
  const submit = functionBody(app, 'submitSubscription', 'configuredLimitProviderOrder');
  const account = { provider: 'codex', accountKey: 'acct-1', accountName: 'acct' };
  const list = [{
    id: 'subscription-1',
    provider: 'codex',
    binding: { accountKey: 'acct-1', accountEmail: 'acct@example.com' },
    planName: 'Old plan',
    amountMinor: 1000,
    currency: 'USD',
    interval: 'month',
    intervalCount: 1,
    startDate: '2026-01-01',
    topUps: [],
    autoRenew: true,
    nextRenewalOverride: null,
    endDate: null
  }];
  const els = {
    subscriptionProviderInput: { value: 'codex' },
    subscriptionAccountInput: { value: 'acct-1' },
    subscriptionAmountInput: { value: '10' },
    subscriptionStartDateInput: { value: '2026-01-01' },
    subscriptionAutoRenewInput: { checked: true },
    subscriptionNextRenewalInput: { value: '' },
    subscriptionPlanNameInput: { value: 'Updated plan' },
    subscriptionCurrencyInput: { value: 'USD' },
    subscriptionIntervalInput: { value: 'month' },
    subscriptionIntervalCountInput: { value: '1' }
  };
  const state = { subscriptionEditingId: 'subscription-1', subscriptionFormBase: { updatedAt: 'v1' } };
  const context = vm.createContext({
    els,
    state,
    subscriptionApi: {
      todayString: () => '2026-02-01',
      bindingFromAccount: () => ({ accountKey: 'acct-1' }),
      normalizeSubscription: (value) => value
    },
    currencyApi: {},
    subscriptionFormTopUps: () => [],
    subscriptionFormIsTopUp: () => false,
    subscriptionAccountChoices: () => [{ value: 'acct-1', provider: account }],
    subscriptionList: () => list,
    subscriptionForAccountValue: () => false,
    saveCompleted: false,
    saveOptions: null,
    closeOptions: null,
    renderCount: 0,
    saveSubscriptions: async (updated, base, options) => {
      context.saveOptions = options;
      context.saveCompleted = true;
      return true;
    },
    closeSubscriptionEditor: (options) => {
      assert.equal(context.saveCompleted, true);
      context.closeOptions = options;
    },
    renderSubscriptionSettings() { context.renderCount += 1; },
    setSubscriptionError() {},
    Promise
  });

  await vm.runInContext(`async ${submit}\nsubmitSubscription();`, context);

  assert.equal(context.saveOptions?.render, false);
  assert.equal(context.renderCount, 0);
  assert.equal(typeof context.closeOptions?.onClosed, 'function');
  context.closeOptions.onClosed();
  assert.equal(context.renderCount, 1);
});

test('subscription row rerenders keep the live editor node attached', () => {
  const app = readRendererFile('app.js');
  const clear = functionBody(app, 'clearSubscriptionListChildren', 'positionSubscriptionEditor');
  const editor = { removed: false, remove() { this.removed = true; } };
  const row = { removed: false, remove() { this.removed = true; } };
  const empty = { removed: false, remove() { this.removed = true; } };
  const list = { children: [row, editor, empty] };

  vm.runInNewContext(
    `${clear}\nclearSubscriptionListChildren(list, editor);`,
    { list, editor }
  );

  assert.equal(row.removed, true);
  assert.equal(empty.removed, true);
  assert.equal(editor.removed, false);
});

test('the add control is a disclosure only in add mode', () => {
  const app = readRendererFile('app.js');
  const control = functionBody(app, 'syncSubscriptionAddControl', 'clearSubscriptionListChildren');
  const attrs = new Map();
  const toggle = {
    removeAttribute(name) { attrs.delete(name); },
    setAttribute(name, value) { attrs.set(name, value); }
  };
  const form = {
    classList: {
      expanded: false,
      remove(name) { if (name === 'expanded') this.expanded = false; },
      toggle(name, value) { if (name === 'expanded') this.expanded = value; }
    }
  };
  const details = { classList: { contains: () => false } };
  const state = { subscriptionEditingId: 'subscription-1' };
  const els = { subscriptionAddToggle: toggle, subscriptionAddForm: form, subscriptionAddDetails: details };

  vm.runInNewContext(`${control}\nsyncSubscriptionAddControl();`, { els, state });
  assert.equal(attrs.has('aria-expanded'), false);
  assert.equal(attrs.has('aria-controls'), false);
  assert.equal(form.classList.expanded, false);

  state.subscriptionEditingId = '';
  vm.runInNewContext(`${control}\nsyncSubscriptionAddControl();`, { els, state });
  assert.equal(attrs.get('aria-expanded'), 'true');
  assert.equal(attrs.get('aria-controls'), 'subscriptionAddDetails');
  assert.equal(form.classList.expanded, true);
});

test('subscription rows carry the glyph actions the profile rows above them use', () => {
  const app = readRendererFile('app.js');
  const rows = functionBody(app, 'renderSubscriptionRows', 'renderSubscriptionPickers');
  assert.match(rows, /edit\.textContent = editOpen \? '×' : '✎';/);
  assert.match(rows, /edit\.setAttribute\('aria-expanded', editOpen \? 'true' : 'false'\);/);
  assert.match(rows, /remove\.textContent = '✕';/);
  assert.match(rows, /remove\.textContent = '✓';/);
});

test('deleting a subscription preserves the settings scroll position and renders once', () => {
  const app = readRendererFile('app.js');
  const rows = functionBody(app, 'renderSubscriptionRows', 'renderSubscriptionPickers');
  const settingsPush = app.match(/window\.tokenMonitor\.onSettingsPush\?\.\(\(next\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  const preserve = functionBody(app, 'preserveSettingsPanelScroll', 'saveSettings');

  assert.match(rows, /subscriptionSettingsVersion\(\),\s*\{ render: false \}\s*\)\)/);
  assert.match(rows, /preserveSettingsPanelScroll\(renderSubscriptionSettings\);/);
  assert.match(settingsPush, /preserveSettingsPanelScroll\(syncSettingsForm\);/);

  const frames = [];
  const panel = {
    scrollTop: 240,
    scrollLeft: 0,
    classList: { contains: () => false }
  };
  const context = vm.createContext({
    els: { settingsPanel: panel },
    panel,
    settingsScrollInteractionRevision: 0,
    requestAnimationFrame(callback) {
      frames.push(callback);
    }
  });

  vm.runInContext(
    `${preserve}\npreserveSettingsPanelScroll(() => { panel.scrollTop = 0; });`,
    context
  );
  assert.equal(panel.scrollTop, 240);
  panel.scrollTop = 0;
  frames[0]();
  assert.equal(panel.scrollTop, 240);
});

test('editing a subscription moves only the editor beneath its row', () => {
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  const rows = functionBody(app, 'renderSubscriptionRows', 'renderSubscriptionPickers');
  const beginEdit = functionBody(app, 'beginSubscriptionEdit', 'submitSubscription');
  const submit = functionBody(app, 'submitSubscription', 'configuredLimitProviderOrder');
  const reset = functionBody(app, 'resetSubscriptionForm', 'beginSubscriptionEdit');

  assert.match(rows, /row\.dataset\.subscriptionId = subscription\.id;/);
  assert.match(rows, /positionSubscriptionEditor\(\);/);
  assert.match(beginEdit, /positionSubscriptionEditor\(\);\s*openSubscriptionEditor\(\);/);
  assert.match(reset, /positionSubscriptionEditor\(\);/);
  assert.match(app, /editingRow\.after\(details\);/);
  assert.match(app, /else form\.append\(details\);/);
  assert.doesNotMatch(app, /editingRow\.after\(form\)/);
  assert.match(app, /details\.getBoundingClientRect\(\);/);
  assert.match(app, /setSubscriptionFormOpen\(false\);[\s\S]*resetSubscriptionForm\(\);/);
  assert.match(app, /state\.subscriptionEditingId === subscription\.id[\s\S]*closeSubscriptionEditor\(\);/);
  assert.match(app, /els\.subscriptionCancelEdit\?\.addEventListener\('click', \(\) => closeSubscriptionEditor\(\)\);/);
  assert.match(submit, /saveSubscriptions\(updated, state\.subscriptionFormBase, \{ render: false \}\)/);
  assert.match(submit, /closeSubscriptionEditor\(\{\s*onClosed: renderSubscriptionSettings,\s*onCanceled: renderSubscriptionSettings\s*\}\);/);
  assert.match(cssBlock(styles, '.subscription-row.is-editing'), /border-color/);
  assert.match(styles, /\.subscription-row\.is-editing \.subscription-row-edit/);
  assert.match(styles, /#subscriptionList > #subscriptionAddDetails/);
});

test('the plan-name seed never runs from a render, so it cannot wipe what is being typed', () => {
  const app = readRendererFile('app.js');
  const renderPickers = functionBody(app, 'renderSubscriptionPickers', 'renderSubscriptionTotal');
  const renderSettings = functionBody(app, 'renderSubscriptionSettings', 'setSubscriptionError');
  const beginEdit = functionBody(app, 'beginSubscriptionEdit', 'submitSubscription');

  assert.doesNotMatch(renderPickers, /seedSubscriptionPlanName|applySubscriptionAccountSelection/);
  assert.doesNotMatch(renderSettings, /seedSubscriptionPlanName|applySubscriptionAccountSelection/);
  // Opening an edit assigns the selects programmatically, which fires no change
  // event — that is what preserves the saved plan name without a mode guard.
  assert.doesNotMatch(beginEdit, /seedSubscriptionPlanName|applySubscriptionAccountSelection/);
  assert.match(beginEdit, /els\.subscriptionPlanNameInput\.value = subscription\.planName;/);
});

test('switching the account mid-edit re-seeds the plan name and relabels the form', () => {
  const app = readRendererFile('app.js');
  const apply = functionBody(app, 'applySubscriptionAccountSelection', 'syncSubscriptionDateBounds');

  assert.match(apply, /seedSubscriptionPlanName\(\);/);
  assert.match(apply, /setSubscriptionFormMode\(\);/);
  assert.match(app, /els\.subscriptionAccountInput\?\.addEventListener\('change', applySubscriptionAccountSelection\);/);
});

test('the subscription list shrinks with the panel instead of widening its section', () => {
  const styles = readRendererFile('styles.css');
  // `min-width: 0` on a flex child only lets it shrink during layout — the row's
  // min-content contribution stays as wide as the longest account label, and
  // that contribution sizes the settings section's grid column. On a narrow
  // window the whole section was laid out around an email address. The profile
  // rows above them never had the problem because they are grids.
  const row = cssBlock(styles, '.subscription-row');
  assert.match(row, /display: grid;/);
  assert.match(row, /grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(cssBlock(styles, '.subscription-topup-row'), /grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  assert.match(cssBlock(styles, '.opencode-profile-item'), /minmax\(0, 1fr\)/);
});

test('every account is offered, and one record keeps one currency', () => {
  const app = readRendererFile('app.js');
  const html = readRendererFile('index.html');
  const choices = functionBody(app, 'subscriptionAccountChoices', 'subscriptionAccountValue');
  const mode = functionBody(app, 'setSubscriptionFormMode', 'subscriptionFormIsTopUp');

  // The record kind made "include balance accounts" redundant: the form can
  // describe either shape now, so hiding the accounts only hid them.
  assert.doesNotMatch(choices, /isCreditsProvider/);
  assert.doesNotMatch(app, /subscriptionShowAllAccounts/);
  assert.doesNotMatch(html, /subscriptionShowAllAccountsInput/);
  assert.doesNotMatch(readRendererFile('i18n.js'), /settings\.subscriptions\.showAllAccounts/);

  // The select moves between the two money fields rather than being duplicated
  // or taking a labelled row of its own.
  assert.match(mode, /slot\.append\(els\.subscriptionCurrencyInput\)/);
  assert.equal((html.match(/id="subscriptionCurrencyInput"/g) || []).length, 1);
  assert.match(html, /id="subscriptionAmountRow"/);
  assert.match(html, /id="subscriptionTopUpHeadingRow"/);

  // A bare <button> falls outside this stylesheet's button allow-list and lands
  // on the unstyled UA control.
  assert.match(html, /id="subscriptionTopUpAddButton"[^>]*class="icon-button subscription-topup-add"/);
  assert.match(readRendererFile('styles.css'), /\.icon-button, \.refresh-button, \.settings-actions button/);
});

test('the record kind swaps whole field groups, and the user has the last word', () => {
  const app = readRendererFile('app.js');
  const html = readRendererFile('index.html');
  const mode = functionBody(app, 'setSubscriptionFormMode', 'subscriptionFormIsTopUp');
  const isTopUp = functionBody(app, 'subscriptionFormIsTopUp', 'setSubscriptionFormKind');
  const apply = functionBody(app, 'applySubscriptionAccountSelection', 'subscriptionFormTopUps');

  // The kind is read from the radio the user can change, never re-derived from
  // the account at render time.
  assert.match(isTopUp, /els\.subscriptionKindInputs/);
  assert.doesNotMatch(isTopUp, /isCreditsProvider/);
  // The balance marker only seeds it, on an explicit account change.
  assert.match(apply, /setSubscriptionFormKind\(isCreditsProvider\(subscriptionSelectedAccount\(\)\) \? 'topup' : 'subscription'\)/);
  assert.match(mode, /els\.subscriptionPlanFields\?\.classList\.toggle\('hidden', topUp\)/);
  assert.match(mode, /els\.subscriptionTopUpFields\?\.classList\.toggle\('hidden', !topUp\)/);
  // This stylesheet has no blanket `.hidden` rule, so toggling the class only
  // hides anything because these wrappers declare one.
  const styles = readRendererFile('styles.css');
  assert.match(cssBlock(styles, '.subscription-kind-fields.hidden'), /display: none;/);
  assert.match(html, /id="subscriptionPlanFields" class="subscription-kind-fields"/);
  assert.match(html, /id="subscriptionTopUpFields" class="subscription-kind-fields hidden"/);

  // Both groups carry their own data-i18n now that neither is relabelled, which
  // is what keeps them correct across a language change.
  assert.match(html, /id="subscriptionStartDateInput"/);
  assert.match(html, /data-i18n="settings\.subscriptions\.startDateNote"/);
  assert.match(html, /data-i18n="settings\.subscriptions\.topUpEntriesNote"/);
  // The wording the old single-shape form needed is gone from every locale.
  const i18n = readRendererFile('i18n.js');
  for (const key of ['topUpInterval', 'topUpRecurring', 'topUpNext', 'topUpNextNote', 'topsUpOn']) {
    assert.doesNotMatch(i18n, new RegExp(`settings\\.subscriptions\\.${key}'`), `${key} should be gone`);
  }
});

test('a top-up record keeps a ledger, and the tooltip reads from it', () => {
  const app = readRendererFile('app.js');
  const subscriptionApi = require('../../src/shared/subscriptionDisplay');
  const rows = functionBody(app, 'topUpTooltipRows', 'topUpRollupRows');
  const meta = functionBody(app, 'subscriptionRowMeta', 'renderSubscriptionRows');
  const submit = functionBody(app, 'submitSubscription', 'configuredLimitProviderOrder');

  const ledger = subscriptionApi.normalizeSubscription({
    provider: 'openrouter',
    kind: 'topup',
    currency: 'USD',
    topUps: [
      { date: '2026-08-01', amountMinor: 20000 },
      { date: '2026-08-06', amountMinor: 10000 }
    ]
  });
  const labels = Array.from(vm.runInNewContext(
    `${rows}\ntopUpTooltipRows(subscription, provider, today, false).map((row) => row.label);`,
    {
      subscription: ledger,
      provider: { windows: [{ metric: 'credits', amount: 150, currency: 'USD' }] },
      today: '2026-08-11',
      subscriptionApi,
      t: (key) => key,
      topUpMinorText: (record, minor) => `$${(minor / 100).toFixed(2)}`,
      subscriptionDateText: (date) => date,
      subscriptionDaysText: (days) => `${days}d`,
      isCreditsWindow: (window) => window?.metric === 'credits',
      creditsAmount: (_provider, window) => window?.amount ?? null,
      formatMoney: (value) => `${value}`,
      currencyApi: require('../../src/shared/currency'),
      topUpRollupRows: (built) => built
    }
  ));
  assert.deepEqual(labels, [
    'subscription.tooltip.lastTopUp',
    'subscription.tooltip.topUpMonth',
    'subscription.tooltip.topUpTotal',
    'subscription.tooltip.balance',
    'subscription.tooltip.burnRate',
    'subscription.tooltip.exhausts'
  ]);

  // The settings row summarises the same ledger, and a ledger with nothing in it
  // never saves.
  assert.match(meta, /subscriptionApi\.isTopUp\(subscription\)/);
  assert.match(meta, /settings\.subscriptions\.topUpMonthMeta/);
  assert.match(submit, /topUps\.length === 0/);
  assert.match(submit, /settings\.subscriptions\.errorTopUpEntries/);

  // Entries are normalized as they enter form state. normalizeTopUps() mints an
  // id for anything lacking one, so raw entries would be re-identified on every
  // render and the delete button would never match its own row.
  const add = functionBody(app, 'addSubscriptionTopUpEntry', 'setSubscriptionDateBound');
  assert.match(add, /state\.subscriptionTopUps = subscriptionApi\.normalizeTopUps\(\[/);
  const raw = subscriptionApi.normalizeTopUps([
    { date: '2026-07-08', amountMinor: 10000 },
    { date: '2026-08-01', amountMinor: 9996 }
  ]);
  assert.match(raw[0].id, /^top_/);
  // Re-normalizing keeps the ids, which is the only reason a delete button
  // captured on one render still matches its row on the next.
  assert.deepEqual(
    subscriptionApi.normalizeTopUps(raw).map((entry) => entry.id),
    raw.map((entry) => entry.id)
  );
});

test('the settings row is titled by account and carries the plan name in its meta', () => {
  const app = readRendererFile('app.js');
  const title = functionBody(app, 'subscriptionRowTitle', 'subscriptionRowMeta');
  const meta = functionBody(app, 'subscriptionRowMeta', 'renderSubscriptionRows');

  const run = (subscription, account) => vm.runInNewContext(
    `${title}\nsubscriptionRowTitle(subscription, account);`,
    {
      subscription,
      account,
      state: { settings: {} },
      subscriptionProviderLabel: (id) => id,
      accountIdentityApi: {
        accountTitleLabel: (entry) => entry?.accountName || entry?.accountEmail || ''
      }
    }
  );

  const record = { provider: 'codex', planName: 'Plus', binding: { accountEmail: 'b@example.com' } };
  assert.equal(run(record, { provider: 'codex', accountEmail: 'live@example.com' }), 'codex · live@example.com');
  // No live account yet — the record's own binding still tells the rows apart,
  // where the plan name would have made all three of them read "codex · Plus".
  assert.equal(run(record, null), 'codex · b@example.com');
  assert.equal(run({ provider: 'codex', planName: 'Plus', binding: {} }, null), 'codex · Plus');

  // Which leaves the plan name a place of its own — except on the row where the
  // title already spent itself on it. The second line is the one that runs out of
  // room, so it never repeats what the first line just said.
  const metaFor = (subscription, account) => vm.runInNewContext(
    `${title}\n${meta}\nsubscriptionRowMeta(subscription, account);`,
    {
      subscription,
      account,
      state: { settings: {} },
      subscriptionProviderLabel: (id) => id,
      accountIdentityApi: {
        accountTitleLabel: (entry) => entry?.accountName || entry?.accountEmail || ''
      },
      subscriptionApi: require('../../src/shared/subscriptionDisplay'),
      t: (key, vars) => `${key}(${vars?.date || ''})`,
      subscriptionPriceText: () => '$20.00 / mo',
      subscriptionShortDateText: (date) => date,
      topUpMinorText: (_record, minor) => `$${minor / 100}`
    }
  );
  const named = { provider: 'codex', planName: 'Plus', startDate: '2026-06-08', autoRenew: true, binding: { accountEmail: 'b@example.com' } };
  assert.match(metaFor(named, null), /^Plus · \$20\.00 \/ mo/);
  assert.doesNotMatch(metaFor({ ...named, binding: {} }, null), /^Plus/);
});

test('a subscription card belongs to one account, and a group header summarises', () => {
  const app = readRendererFile('app.js');
  const forProvider = functionBody(app, 'subscriptionForProvider', 'subscriptionsForProviderGroup');
  const cardFor = functionBody(app, 'subscriptionCardForRow', 'positionSubscriptionTooltip');

  // matchProviderAccount falls back to "the provider has exactly one account",
  // so it must see every account, not just the row being rendered.
  assert.match(forProvider, /const accounts = limitProvidersForSubscriptions\(\);/);
  assert.match(forProvider, /subscriptionAccountValue\(account\) === identity/);
  assert.doesNotMatch(forProvider, /matchProviderAccount\(subscription, \[provider\]\)/);
  assert.match(cardFor, /provider\?\.accountGroup === true/);
  assert.match(cardFor, /subscriptionGroupTooltipRows\(provider\.provider/);
});

test('the seeded plan name is a real plan, never a status label', () => {
  const app = readRendererFile('app.js');
  const suggest = functionBody(app, 'subscriptionSuggestedPlanName', 'subscriptionSelectedAccount');
  // limitProviderPlan() doubles as the status-label producer.
  assert.match(suggest, /provider\.status !== 'ok' && !provider\.stale/);
  assert.match(suggest, /return limitProviderPlan\(provider\);/);
});

test("one account's subscription never appears on its siblings", () => {
  const app = readRendererFile('app.js');
  const subscriptionApi = require('../../src/shared/subscriptionDisplay');
  const accountValue = functionBody(app, 'subscriptionAccountValue', 'subscriptionSuggestedPlanName');
  const forProvider = functionBody(app, 'subscriptionForProvider', 'subscriptionsForProviderGroup');

  const resolve = (accounts, subscriptions, provider) => vm.runInNewContext(
    `${accountValue}\n${forProvider}\nsubscriptionForProvider(provider)?.id || null;`,
    {
      subscriptionApi,
      limitProvidersForSubscriptions: () => accounts,
      subscriptionList: () => subscriptions,
      provider
    }
  );

  const three = [
    { provider: 'codex', accountKey: 'k1', accountEmail: 'a@example.com' },
    { provider: 'codex', accountKey: 'k2', accountEmail: 'b@example.com' },
    { provider: 'codex', accountKey: 'k3', accountEmail: 'c@example.com' }
  ];
  const middle = [{ id: 's1', provider: 'codex', binding: { accountEmail: 'b@example.com' } }];
  assert.deepEqual(
    three.map((account) => resolve(three, middle, account)),
    [null, 's1', null]
  );

  // The sole-account fallback still heals a rotated credential — it just may not
  // reach across siblings any more.
  const one = [{ provider: 'codex', accountKey: 'rotated', accountEmail: '' }];
  const stale = [{ id: 's2', provider: 'codex', binding: { accountKey: 'expired' } }];
  assert.equal(resolve(one, stale, one[0]), 's2');

  // A subscription for another provider never leaks across provider ids.
  const claude = [{ provider: 'claude', accountKey: 'k1', accountEmail: 'a@example.com' }];
  assert.equal(resolve([...three, ...claude], middle, claude[0]), null);
});

test('the provider rollup appears once, on the row that stands for the provider', () => {
  const app = readRendererFile('app.js');
  const subscriptionApi = require('../../src/shared/subscriptionDisplay');
  const planRows = functionBody(app, 'subscriptionPlanTooltipRows', 'subscriptionGroupTooltipRows');
  const hasHeader = functionBody(app, 'subscriptionProviderHasGroupHeader', 'subscriptionCardForRow');
  const cardFor = functionBody(app, 'subscriptionCardForRow', 'positionSubscriptionTooltip');

  const subscription = subscriptionApi.normalizeSubscription({
    provider: 'codex', startDate: '2026-06-08', amountMinor: 2000, currency: 'USD'
  });
  const labels = (includeRollup) => Array.from(vm.runInNewContext(
    `${planRows}\nsubscriptionPlanTooltipRows(subscription, {}, today, includeRollup).map((row) => (row.separator ? '--' : row.label));`,
    {
      subscription,
      today: '2026-08-01',
      includeRollup,
      subscriptionApi,
      t: (key) => key,
      subscriptionPriceText: () => '$20.00 / mo',
      subscriptionDateText: (date) => date,
      subscriptionDaysText: (days) => `${days}d`,
      subscriptionElapsedText: () => '2 mo',
      subscriptionUsageCostUsd: () => 125,
      subscriptionList: () => [subscription],
      subscriptionProviderLabel: (id) => id,
      currencyApi: { normalizeCurrency: () => 'USD', CURRENCY_RATES: { USD: { symbol: '$' } } },
      formatCost: (value) => `$${value}`
    }
  ));

  assert.deepEqual(labels(false), [
    'subscription.tooltip.price',
    'subscription.tooltip.nextCharge',
    'subscription.tooltip.subscribed'
  ]);
  assert.deepEqual(labels(true).slice(3), [
    '--',
    'subscription.tooltip.monthUsage',
    'subscription.tooltip.valueMultiple'
  ]);

  // A group header exists exactly when the provider has more than one account,
  // and that is what moves the rollup off the member rows. Counted from the list
  // renderLimits() groups on, not the device-narrowed matching list.
  assert.match(hasHeader, /state\.stats\?\.limits\?\.providers/);
  assert.doesNotMatch(hasHeader, /limitProvidersForSubscriptions/);
  const headerFor = (accounts) => vm.runInNewContext(
    `${hasHeader}\nsubscriptionProviderHasGroupHeader('codex');`,
    { state: { stats: { limits: { providers: accounts } } } }
  );
  assert.equal(headerFor([{ provider: 'codex' }]), false);
  assert.equal(headerFor([{ provider: 'codex' }, { provider: 'codex' }]), true);
  assert.equal(headerFor([{ provider: 'codex' }, { provider: 'claude' }]), false);
  assert.match(cardFor, /!subscriptionProviderHasGroupHeader\(provider\.provider\)/);
});

test('the subscription card carries no heading of its own', () => {
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  const card = functionBody(app, 'subscriptionCardNode', 'subscriptionProviderHasGroupHeader');
  // Hovering the plan label is what names the card; a "Subscription" line above
  // the rows only repeats the gesture.
  assert.doesNotMatch(card, /subscription-tooltip-title/);
  assert.doesNotMatch(styles, /\.subscription-tooltip-title/);
  assert.doesNotMatch(readRendererFile('i18n.js'), /'subscription\.tooltip\.(topUp)?[Tt]itle'/);
});

test('elapsed subscription time never reads as zero months', () => {
  const app = readRendererFile('app.js');
  const subscriptionApi = require('../../src/shared/subscriptionDisplay');
  const elapsed = functionBody(app, 'subscriptionElapsedText', 'subscriptionPlanTooltipRows');

  const run = (startDate, today) => vm.runInNewContext(
    `${elapsed}\nsubscriptionElapsedText(subscription, today);`,
    {
      subscription: subscriptionApi.normalizeSubscription({
        provider: 'codex', startDate, amountMinor: 16000, currency: 'USD'
      }),
      today,
      subscriptionApi,
      currencyApi: { normalizeCurrency: () => 'USD', CURRENCY_RATES: { USD: { symbol: '$' } } },
      t: (key, vars) => `${key}|${JSON.stringify(vars || {})}`
    }
  );

  // Three weeks in, one payment taken: "0 months · $160 total" reads as a bug.
  assert.match(run('2026-07-08', '2026-08-01'), /^subscription\.tooltip\.daysCount\|\{"days":24\}/);
  assert.match(run('2026-06-08', '2026-08-01'), /^subscription\.tooltip\.months\|\{"months":1\}/);
  // A start date that has not arrived has nothing elapsed and nothing paid.
  assert.match(run('2026-08-08', '2026-08-01'), /^subscription\.tooltip\.notStarted\|/);
  assert.doesNotMatch(run('2026-08-08', '2026-08-01'), /paidTotal/);

  const i18n = readRendererFile('i18n.js');
  for (const key of ['subscription.tooltip.daysCount', 'subscription.tooltip.notStarted']) {
    assert.equal(i18n.split(`'${key}':`).length - 1, 5, `${key} should exist in all five locales`);
  }
});

test('a date bound is only written when it actually changes', () => {
  const app = readRendererFile('app.js');
  const setBound = functionBody(app, 'setSubscriptionDateBound', 'syncSubscriptionDateBounds');
  const sync = functionBody(app, 'syncSubscriptionDateBounds', 'resetSubscriptionForm');

  // Rewriting min/max rebuilds Chromium's date editor and drops the segment
  // being typed, and this runs on the input's own change event.
  const input = {
    writes: 0,
    attrs: { max: '2026-08-01' },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    setAttribute(name, value) { this.writes += 1; this.attrs[name] = value; }
  };
  vm.runInNewContext(
    `${setBound}\nsetSubscriptionDateBound(input, 'max', '2026-08-01');`,
    { input }
  );
  assert.equal(input.writes, 0);
  vm.runInNewContext(
    `${setBound}\nsetSubscriptionDateBound(input, 'max', '2026-08-02');`,
    { input }
  );
  assert.equal(input.writes, 1);
  assert.match(sync, /setSubscriptionDateBound\(els\.subscriptionStartDateInput, 'max', today\)/);
  assert.doesNotMatch(sync, /\.max = /);
});

test('one account holds one subscription record', () => {
  const app = readRendererFile('app.js');
  const subscriptionApi = require('../../src/shared/subscriptionDisplay');
  const accountValue = functionBody(app, 'subscriptionAccountValue', 'subscriptionSuggestedPlanName');
  const forAccount = functionBody(app, 'subscriptionForAccountValue', 'subscriptionTooltipRows');
  const submit = functionBody(app, 'submitSubscription', 'configuredLimitProviderOrder');

  const accounts = [
    { provider: 'codex', accountKey: 'k1', accountEmail: 'a@example.com' },
    { provider: 'codex', accountKey: 'k2', accountEmail: 'b@example.com' }
  ];
  const existing = [{ id: 's1', provider: 'codex', binding: { accountEmail: 'b@example.com' } }];
  const clash = (target, excludeId) => vm.runInNewContext(
    `${accountValue}\n${forAccount}\nsubscriptionForAccountValue(list, 'codex', subscriptionAccountValue(target), excludeId)?.id || null;`,
    {
      subscriptionApi,
      limitProvidersForSubscriptions: () => accounts,
      list: existing,
      target,
      excludeId
    }
  );

  assert.equal(clash(accounts[1]), 's1');
  // A sibling account is free, and editing the record does not clash with itself.
  assert.equal(clash(accounts[0]), null);
  assert.equal(clash(accounts[1], 's1'), null);
  assert.match(submit, /settings\.subscriptions\.errorDuplicate/);
  assert.equal(readRendererFile('i18n.js').split("'settings.subscriptions.errorDuplicate':").length - 1, 5);
});

test('a first charge or last top-up cannot be dated in the future', () => {
  const app = readRendererFile('app.js');
  const submit = functionBody(app, 'submitSubscription', 'configuredLimitProviderOrder');
  // `max` on a date input only marks an out-of-range value invalid; typing one
  // still submits it, and a future anchor makes every derived figure nonsense.
  assert.match(submit, /startDate > subscriptionApi\.todayString\(\)/);
  assert.match(submit, /settings\.subscriptions\.errorFutureDate/);
  assert.equal(readRendererFile('i18n.js').split("'settings.subscriptions.errorFutureDate':").length - 1, 5);
});

test('the subscription card is revealed by having a record, not by a preference', () => {
  // A second switch on top of "did you enter the data" only made it possible to
  // fill the form in and see nothing happen. An account with no record still
  // decorates nothing, so the record itself is the switch.
  const app = readRendererFile('app.js');
  const decorate = functionBody(app, 'decoratePlanWithSubscription', 'subscriptionRowTitle');
  assert.match(decorate, /subscriptionCardForRow\(provider\)/);
  assert.doesNotMatch(decorate, /state\.settings\?\.show/);

  for (const file of ['app.js', 'index.html', 'i18n.js']) {
    assert.doesNotMatch(readRendererFile(file), /showSubscriptionInfo/);
  }
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /showSubscriptionInfo/);
});

test('a plan that does not auto-renew asks when it ends, and stores it there', () => {
  const app = readRendererFile('app.js');
  const fieldMode = functionBody(app, 'setSubscriptionRenewalFieldMode', 'subscriptionFormIsTopUp');
  const submit = functionBody(app, 'submitSubscription', 'configuredLimitProviderOrder');
  const beginEdit = functionBody(app, 'beginSubscriptionEdit', 'submitSubscription');

  // One field, two meanings — so a language switch later has to land on the key
  // the field currently means, not the one the markup shipped with.
  const label = { dataset: {}, textContent: '' };
  const note = { dataset: {}, textContent: '' };
  const run = (checked) => vm.runInNewContext(
    `${fieldMode}\nsetSubscriptionRenewalFieldMode();`,
    {
      t: (key) => `t:${key}`,
      els: {
        subscriptionAutoRenewInput: { checked },
        subscriptionNextRenewalLabel: label,
        subscriptionNextRenewalNote: note
      }
    }
  );

  run(true);
  assert.equal(label.dataset.i18n, 'settings.subscriptions.nextRenewal');
  assert.equal(note.dataset.i18n, 'settings.subscriptions.nextRenewalNote');
  assert.equal(label.textContent, 't:settings.subscriptions.nextRenewal');
  run(false);
  assert.equal(label.dataset.i18n, 'settings.subscriptions.coverageEnd');
  assert.equal(note.dataset.i18n, 'settings.subscriptions.coverageEndNote');
  assert.equal(label.textContent, 't:settings.subscriptions.coverageEnd');

  // The saved record must never carry both dates: a stale override left behind
  // by the toggle would keep scheduling charges on a cancelled plan.
  assert.match(submit, /nextRenewalOverride: kind === 'topup' \|\| !autoRenew \? null : renewalDate \|\| null/);
  assert.match(submit, /endDate: kind === 'topup' \|\| autoRenew \? null : renewalDate \|\| null/);
  assert.match(submit, /settings\.subscriptions\.errorRenewalDate/);
  assert.match(beginEdit, /subscription\.autoRenew \? subscription\.nextRenewalOverride : subscription\.endDate/);
  for (const key of ['coverageEnd', 'coverageEndNote', 'errorRenewalDate']) {
    assert.equal(readRendererFile('i18n.js').split(`'settings.subscriptions.${key}':`).length - 1, 5);
  }
});

test('a lapsed plan reads as ended rather than counting days backwards', () => {
  const app = readRendererFile('app.js');
  const rows = functionBody(app, 'subscriptionPlanTooltipRows', 'subscriptionGroupTooltipRows');
  const elapsed = functionBody(app, 'subscriptionElapsedText', 'subscriptionPlanTooltipRows');
  assert.match(rows, /daysLeft < 0 \? t\('subscription\.tooltip\.expired'\)/);
  assert.equal(readRendererFile('i18n.js').split("'subscription.tooltip.expired':").length - 1, 5);
  // Time on the plan stops at the day coverage ran out; it does not keep ageing
  // after the plan ended.
  assert.match(elapsed, /coverageStopDate\(subscription\)/);
  assert.match(elapsed, /stop && stop < today \? stop : today/);
});

test('removing a ledger entry has to be confirmed, like the rows above it', () => {
  const app = readRendererFile('app.js');
  const render = functionBody(app, 'renderSubscriptionTopUpEntries', 'addSubscriptionTopUpEntry');
  // A mis-click rewrites the month total the ledger exists to report, and the
  // entry is recorded nowhere else.
  assert.match(render, /if \(!armed\) \{/);
  assert.match(render, /remove\.textContent = '✓'/);
  assert.match(render, /settings\.subscriptions\.topUpRemoveConfirm/);
  assert.equal(readRendererFile('i18n.js').split("'settings.subscriptions.topUpRemoveConfirm':").length - 1, 5);
  assert.ok(cssBlock(readRendererFile('styles.css'), '.subscription-topup-row .subscription-topup-remove.is-armed'));
});

test('every provider a subscription can name has a mark to identify it by', () => {
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  const providerBlock = app.slice(app.indexOf('const LIMIT_PROVIDERS = ['));
  const ids = [...providerBlock.slice(0, providerBlock.indexOf('];')).matchAll(/\bid: '([^']+)'/g)]
    .map((match) => match[1]);
  assert.ok(ids.length >= 19, 'LIMIT_PROVIDERS should be parsed, not empty');

  // .row-icon paints currentColor through a mask, so an id with no mask rule
  // behind it renders as a solid square — worse than no icon at all.
  for (const id of ids) {
    assert.ok(
      new RegExp(`\\.row-icon-${id}\\b[^{]*\\{`).test(styles),
      `.row-icon-${id} mask rule should exist for LIMIT_PROVIDERS id ${id}`
    );
  }

  const iconClass = functionBody(app, 'subscriptionProviderIconClass', 'isCreditsProvider');
  const rows = functionBody(app, 'renderSubscriptionRows', 'renderSubscriptionPickers');
  // Unknown ids are the case the mask list cannot cover: a record stays bound to
  // its provider even after that provider leaves the list.
  assert.match(iconClass, /LIMIT_PROVIDERS\.some\(/);
  assert.match(rows, /toolIconsEnabled\(state\.settings\?\.showToolIcons\)/);
  assert.match(rows, /subscriptionProviderIconClass\(subscription\.provider\)/);
  // The gutter only exists when something occupies it.
  assert.match(
    cssBlock(styles, '.subscription-row:has(.subscription-row-icon)'),
    /grid-template-columns: auto minmax\(0, 1fr\) auto/
  );
  assert.ok(cssBlock(styles, '.subscription-row-icon'));
});

test('the settings rows date themselves in short form, the tooltip in full', () => {
  const app = readRendererFile('app.js');
  const meta = functionBody(app, 'subscriptionRowMeta', 'renderSubscriptionRows');
  const short = functionBody(app, 'subscriptionShortDateText', 'subscriptionLocalDate');
  const full = functionBody(app, 'subscriptionDateText', 'subscriptionShortDateText');
  const planRows = functionBody(app, 'subscriptionPlanTooltipRows', 'subscriptionGroupTooltipRows');

  // Two dense lines in a ~300px panel: the date is the longest thing on the
  // second one, and the locale already defines a numeric short form for it.
  assert.match(short, /dateStyle: 'short'/);
  assert.match(full, /month: 'short'/);
  assert.doesNotMatch(meta, /subscriptionDateText\(/);
  // The tooltip has the room, so it keeps spelling the date out.
  assert.match(planRows, /subscriptionDateText\(/);
});

test('the section says where the recorded data shows up', () => {
  const i18n = readRendererFile('i18n.js');
  const html = readRendererFile('index.html');
  // A record decorates a plan label somewhere else entirely; without being told,
  // there is nothing in this panel that points at it.
  const notes = [...i18n.matchAll(/'settings\.subscriptions\.note': '(.+?)',\n/g)].map((match) => match[1]);
  assert.equal(notes.length, 5);
  for (const note of notes) {
    assert.match(note, /Hover|游標|光标|마우스|カーソル/);
  }
  // The markup fallback is what renders before i18n applies, so it cannot lag.
  assert.ok(html.includes("Hover an account's plan label on the AI Tool Limits page"));
});

test('subscriptions are written through the hub-aware channel, never as a setting', () => {
  const app = readRendererFile('app.js');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'preload.js'), 'utf8');

  // Both mutation sites go through the one function that knows the write can be
  // refused. saveSettings() would write settings.json and fork the shared list.
  const rows = functionBody(app, 'renderSubscriptionRows', 'renderSubscriptionPickers');
  const submit = functionBody(app, 'submitSubscription', 'configuredLimitProviderOrder');
  assert.match(rows, /if \(!await saveSubscriptions\(/);
  assert.match(submit, /if \(!await saveSubscriptions\(/);
  assert.doesNotMatch(app, /saveSettings\(\{ subscriptions/);

  // The version the list was built from travels with it, so the write can be
  // refused rather than silently re-based on whatever main holds by then.
  assert.match(preload, /saveSubscriptions: \(subscriptions, base\) => ipcRenderer\.invoke\('subscriptions:save', subscriptions, base\)/);
  // An edit says what it was made on, and that is what the form was opened with —
  // not whatever a push has left in state.settings since.
  assert.match(submit, /saveSubscriptions\(updated, state\.subscriptionFormBase(?:, \{ render: false \})?\)/);
  // A row action has no form, so it reads the list and what it was taken from
  // together at the click rather than reusing the list the row was drawn with.
  assert.doesNotMatch(rows, /saveSubscriptions\(list\.filter/);
  assert.match(rows, /subscriptionSettingsVersion\(\)/);
  // The hub is checked on its own rather than left to the version, which cannot
  // answer for it: two hubs nobody has written to report the same nothing.
  // Checked before the modes divide, or a form opened on a hub would be written
  // into this device's own list — the one write the shared-mode guard never sees.
  const mainSave = functionBody(main, 'saveSubscriptions', 'stopSyncCollector');
  const hubCheckAt = mainSave.search(/base\?\.hub[^\n]*!== currentHubIdentity\(\)/);
  assert.ok(hubCheckAt > -1, 'the hub the edit was composed against must be checked');
  assert.ok(hubCheckAt < mainSave.indexOf('if (!subscriptionsAreShared())'));

  // settings:update must not be a second way in. Asserting that the guard LINE
  // exists is not enough — the first version of this deleted the key from
  // normalizedPatch while the normalizer below read it straight off `patch`, so
  // the guard was inert and this test was green. Assert the dangerous read is
  // gone instead: nothing in the handler may source subscriptions from a patch.
  const handler = main.slice(main.indexOf("ipcMain.handle('settings:update'"));
  const handlerBody = handler.slice(0, handler.indexOf("ipcMain.handle('", 1));
  assert.match(handlerBody, /subscriptions: subscriptionDisplay\.normalizeSubscriptions\(\s*settings\.subscriptions,/);
  assert.doesNotMatch(handlerBody, /patch\.subscriptions/);
  assert.doesNotMatch(handlerBody, /patch\.subscriptionsOrphaned/);

  // A refused write must leave the screen showing what is actually stored.
  const save = functionBody(app, 'saveSubscriptions', 'renderSubscriptionSyncError');
  assert.match(save, /window\.tokenMonitor\.getSettings\(\)/);
  assert.match(save, /stale_write/);
  for (const key of ['errorStaleWrite', 'errorHubWrite', 'noteShared']) {
    assert.equal(readRendererFile('i18n.js').split(`'settings.subscriptions.${key}':`).length - 1, 5);
  }
});

test('the note stops promising the data stays on this device once a hub has it', () => {
  const app = readRendererFile('app.js');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const note = functionBody(app, 'renderSubscriptionNote', 'setSubscriptionError');

  // Retargeting data-i18n as well as the text keeps a later language switch on
  // whichever key currently applies.
  assert.match(note, /subscriptionsShared/);
  assert.match(note, /el\.dataset\.i18n = key;/);
  assert.match(main, /subscriptionsShared: subscriptionsAreShared\(\)/);

  // Only the two hub modes share; local mode keeps its own list.
  const shared = functionBody(main, 'subscriptionsAreShared', 'effectiveSubscriptions');
  const run = (hubMode) => vm.runInNewContext(`${shared}\nsubscriptionsAreShared();`, { settings: { hubMode } });
  assert.equal(run('local'), false);
  assert.equal(run('client'), true);
  assert.equal(run('host'), true);

  // English is what renders before i18n applies, so the markup cannot lag.
  const en = readRendererFile('i18n.js').split("'settings.subscriptions.note':")[1].split('\n')[0];
  const english = en.slice(en.indexOf("'") + 1, en.lastIndexOf("',")).replace(/\\'/g, "'");
  assert.ok(readRendererFile('index.html').includes(english), `markup fallback should read: ${english}`);
  // The shared variant differs by exactly one thing: where the list lives. The
  // old "nothing leaves this device" reassurance answered a question nobody
  // asked and stopped being unconditionally true.
  const sharedNote = readRendererFile('i18n.js').split("'settings.subscriptions.noteShared':")[1].split('\n')[0];
  assert.match(sharedNote, /kept on your hub/);
  assert.doesNotMatch(readRendererFile('i18n.js'), /nothing leaves this device/);
});

test('a record added on another device turns up without pushing settings at the user mid-edit', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const cache = functionBody(main, 'cacheSharedSubscriptions', 'subscriptionsEndpoint');
  const catchUp = functionBody(main, 'runSubscriptionCatchUp', 'saveSubscriptions');

  // Pushing settings re-renders the whole settings form, so a catch-up may only
  // do it when the shared list actually moved.
  assert.match(catchUp, /if \(changed\) pushSettingsToRenderer\(\)/);

  // persistSubscriptionState() sits between the two, so the slice carries it and
  // this exercises the real rollback path rather than a stand-in.
  const run = (previous, incoming, { saveOk = true } = {}) => {
    const context = vm.createContext({
      hubSubscriptions: previous,
      hubSubscriptionsHub: previous ? 'https://hub.example' : '',
      settings: {
        subscriptions: [{ id: 'stale' }],
        subscriptionsOrphaned: { hubUrl: 'https://hub.example', records: [{ id: 'held' }] },
        subscriptionsCacheHub: previous ? 'https://hub.example' : ''
      },
      currentHubIdentity: () => 'https://hub.example',
      saveSettings: () => { context.saved = true; return saveOk; },
      console: { log() {} },
      doc: incoming
    });
    const changed = vm.runInContext(`${cache}\ncacheSharedSubscriptions(doc, 'https://hub.example');`, context);
    return { changed, saved: Boolean(context.saved), settings: plain(context.settings) };
  };
  const doc = { updatedAt: '2026-08-02T09:00:00.000Z', subscriptions: [{ id: 'a' }] };
  // A changed list is mirrored into settings.json, which is what an unreachable
  // hub falls back to showing at the next startup, and tagged with the hub it
  // came from so a later switch does not treat it as this device's own data.
  const first = run(null, doc);
  assert.equal(first.changed, true);
  assert.equal(first.saved, true);
  assert.deepEqual(first.settings.subscriptions, [{ id: 'a' }]);
  assert.equal(first.settings.subscriptionsCacheHub, 'https://hub.example');
  // Same document again: no write, no re-render.
  assert.deepEqual(
    (({ changed, saved }) => ({ changed, saved }))(run(doc, { ...doc })),
    { changed: false, saved: false }
  );
  assert.equal(run(doc, { updatedAt: '2026-08-02T10:00:00.000Z', subscriptions: [] }).changed, true);

  // saveSettings() rolls the whole settings object back when the file cannot be
  // written. The set-aside records would go with it and their notice would
  // disappear mid-session, with nothing on screen saying anything went wrong.
  const failed = run(null, doc, { saveOk: false });
  assert.deepEqual(failed.settings.subscriptions, [{ id: 'a' }]);
  assert.deepEqual(failed.settings.subscriptionsOrphaned.records, [{ id: 'held' }]);
});

test('a deleted record is not resurrected by another device rejoining', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'rememberOrphanedSubscriptions', 'currentHubIdentity'),
    functionBody(main, 'currentHubIdentity', 'orphanedSubscriptions'),
    functionBody(main, 'orphanedSubscriptions', 'pendingOrphanedSubscriptions'),
    functionBody(main, 'pendingOrphanedSubscriptions', 'adoptOrphanedSubscriptions'),
    // functionBody() slices from `function <name>(`, dropping the async keyword.
    `async ${functionBody(main, 'refreshSharedSubscriptionsNow', 'maybeAdoptSharedSubscriptionRevision')}`
  ].join('\n');

  const run = async ({ doc, local, writeFails = false }) => {
    const written = [];
    const context = vm.createContext({
      settings: {
        hubMode: 'client',
        subscriptions: local,
        subscriptionsOrphaned: { hubUrl: '', records: [] },
        subscriptionsCacheHub: ''
      },
      hubSubscriptions: null,
      hubSubscriptionsHub: '',
      subscriptionOpIsCurrent: (hub) => hub === context.currentHubIdentity(),
      subscriptionsAreShared: () => true,
      effectiveHubConfig: () => ({ url: 'https://hub.example' }),
      fetchSharedSubscriptions: async () => doc,
      writeSharedSubscriptionsNow: async (list) => {
        if (writeFails) throw new Error('hub down');
        written.push(list);
        context.hubSubscriptions = { updatedAt: 'written', subscriptions: list };
      },
      cacheSharedSubscriptions: (next, hub) => {
        context.hubSubscriptions = next;
        context.hubSubscriptionsHub = hub;
        return true;
      },
      saveSettings: () => true,
      console: { log() {} },
      JSON
    });
    await vm.runInContext(`${source}\nrefreshSharedSubscriptionsNow({ seedFromLocal: true });`, context);
    return { written, context };
  };

  // Deleting the last record leaves an empty list WITH a timestamp. Treating
  // that as "never written" makes a device holding a stale cache re-upload it,
  // undoing somebody else's delete.
  const afterDelete = await run({
    doc: { updatedAt: '2026-08-02T09:00:00.000Z', subscriptions: [] },
    local: [{ id: 'old' }]
  });
  assert.deepEqual(afterDelete.written, []);
  assert.deepEqual(plain(afterDelete.context.settings.subscriptionsOrphaned), {
    hubUrl: 'https://hub.example',
    records: [{ id: 'old' }]
  });

  // A hub nobody has ever written to still adopts this device's records.
  const virgin = await run({ doc: { updatedAt: '', subscriptions: [] }, local: [{ id: 'mine' }] });
  assert.deepEqual(virgin.written, [[{ id: 'mine' }]]);

  // If that seed fails, the empty document must not stay installed: in shared
  // mode it is what the UI reads, so every record would appear to be gone.
  const failed = await run({ doc: { updatedAt: '', subscriptions: [] }, local: [{ id: 'mine' }], writeFails: true });
  assert.equal(failed.context.hubSubscriptions, null);
});

test('joining a hub that already has records sets this device aside, never over', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const remember = functionBody(main, 'rememberOrphanedSubscriptions', 'adoptOrphanedSubscriptions');
  const adopt = functionBody(main, 'adoptOrphanedSubscriptions', 'discardOrphanedSubscriptions');

  const helpers = [
    remember,
    functionBody(main, 'currentHubIdentity', 'orphanedSubscriptions'),
    functionBody(main, 'orphanedSubscriptions', 'pendingOrphanedSubscriptions'),
    functionBody(main, 'pendingOrphanedSubscriptions', 'adoptOrphanedSubscriptions')
  ].join('\n');
  const context = vm.createContext({
    settings: {
      subscriptions: [{ id: 'a', amountMinor: 1000 }, { id: 'b' }],
      subscriptionsOrphaned: { hubUrl: '', records: [] }
    },
    subscriptionsAreShared: () => true,
    effectiveHubConfig: () => ({ url: 'https://hub.example' }),
    JSON
  });
  const shared = `{ subscriptions: [{ id: 'a', amountMinor: 1000 }, { id: 'z' }] }`;
  const changed = vm.runInContext(
    `${helpers}\nrememberOrphanedSubscriptions(settings.subscriptions, ${shared});`,
    context
  );
  // Only what the shared list does not already have. Matched on record id, not
  // on the account: the same plan entered on two machines has two ids, and
  // folding those together silently would double the monthly total.
  assert.equal(changed, true);
  assert.deepEqual(plain(context.settings.subscriptionsOrphaned.records), [{ id: 'b' }]);
  // Re-running changes nothing, so a reconnect does not keep re-prompting.
  assert.equal(vm.runInContext(`rememberOrphanedSubscriptions(settings.subscriptions, ${shared});`, context), false);

  // A record edited here while the device was in local mode keeps its id, so an
  // id-only comparison would let the shared copy silently win and drop the edit.
  const edited = `{ subscriptions: [{ id: 'a', amountMinor: 2000 }, { id: 'z' }] }`;
  assert.equal(vm.runInContext(`rememberOrphanedSubscriptions(settings.subscriptions, ${edited});`, context), true);
  assert.deepEqual(
    plain(context.settings.subscriptionsOrphaned.records),
    [{ id: 'a', amountMinor: 1000 }, { id: 'b' }]
  );

  // Held back from one hub, never offered to another — or to local mode, where
  // there is nothing to adopt into.
  assert.deepEqual(plain(vm.runInContext('pendingOrphanedSubscriptions();', context)).map((entry) => entry.id), ['a', 'b']);
  context.effectiveHubConfig = () => ({ url: 'https://other.example' });
  assert.deepEqual(plain(vm.runInContext('pendingOrphanedSubscriptions();', context)), []);
  context.effectiveHubConfig = () => ({ url: 'https://hub.example' });
  context.subscriptionsAreShared = () => false;
  assert.deepEqual(plain(vm.runInContext('pendingOrphanedSubscriptions();', context)), []);

  // Adopting appends to the shared list and only then forgets them.
  // Same-id orphans replace rather than append, or normalization would drop the
  // adopted edit as a duplicate id.
  assert.match(adopt, /merged\.set\(orphan\.id, orphan\)/);
  const order = [adopt.indexOf('await writeSharedSubscriptions'), adopt.indexOf("settings.subscriptionsOrphaned = { hubUrl: '', records: [] }")];
  assert.ok(order[0] > -1 && order[0] < order[1], 'orphans must survive a failed adopt');
});

test('a refused write says which problem it was', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const app = readRendererFile('app.js');
  const mapCode = functionBody(main, 'subscriptionWriteFailureCode', 'discardOrphanedSubscriptions');
  const mapKey = functionBody(app, 'subscriptionWriteErrorKey', 'renderSubscriptionOrphanNotice');

  const code = (error) => vm.runInNewContext(`${mapCode}\nsubscriptionWriteFailureCode(error);`, { error });
  // A hub that answered 401 is reachable — telling the user to check their
  // network sends them looking in the wrong place for a wrong secret.
  assert.equal(code({ code: 'rejected', status: 401 }), 'hub_rejected');
  assert.equal(code({ code: 'stale_write' }), 'stale_write');
  assert.equal(code({ code: 'write_failed' }), 'write_failed');
  assert.equal(code(new TypeError('fetch failed')), 'hub_unreachable');

  const key = (message) => vm.runInNewContext(`${mapKey}\nsubscriptionWriteErrorKey({ message });`, { message });
  assert.match(key("Error invoking remote method 'subscriptions:save': Error: hub_rejected"), /errorHubRejected$/);
  assert.match(key('Error: write_failed'), /errorWriteFailed$/);
  assert.match(key('Error: stale_write'), /errorStaleWrite$/);
  assert.match(key('Error: hub_unreachable'), /errorHubWrite$/);

  // A local save that was rolled back is not a save.
  const save = functionBody(main, 'saveSubscriptions', 'stopSyncCollector');
  assert.match(save, /if \(!saveSettings\(\)\) \{/);
  for (const k of ['errorHubRejected', 'errorWriteFailed', 'orphanNotice', 'orphanAdopt', 'orphanDiscard']) {
    assert.equal(readRendererFile('i18n.js').split(`'settings.subscriptions.${k}':`).length - 1, 5);
  }
});

test('a device with no limits of its own can still name the accounts on the hub', () => {
  const app = readRendererFile('app.js');
  const source = [
    functionBody(app, 'limitProvidersForSubscriptions', 'subscriptionAccountValue'),
    functionBody(app, 'subscriptionAccountValue', 'subscriptionSuggestedPlanName')
  ].join('\n');
  const run = (local, aggregate) => plain(vm.runInNewContext(
    `${source}\nlimitProvidersForSubscriptions();`,
    { localDeviceLimitsProviders: () => local, state: { stats: { limits: { providers: aggregate } } } }
  ));
  const remote = [{ provider: 'codex', accountKey: 'remote', accountEmail: 'a@example.com' }];

  // localDeviceLimitsProviders() returns [] when this device is known but reports
  // no limits, and [] is truthy — a plain `||` handed back the empty array and
  // left the picker blank while the accounts sat on another machine.
  assert.deepEqual(run([], remote), remote);
  assert.deepEqual(run(null, remote), remote);
  assert.deepEqual(run([], undefined), []);

  // A shared list names accounts across devices, so both sides show up. Keeping
  // only the local ones hid remote rows — and left a lone local account as the
  // only candidate, which matchProviderAccount()'s sole-account fallback would
  // then bind a remote subscription to.
  const mine = [{ provider: 'claude', accountKey: 'local', accountEmail: 'me@example.com' }];
  assert.deepEqual(run(mine, remote).map((entry) => entry.accountKey), ['local', 'remote']);
  const sameProvider = [{ provider: 'codex', accountKey: 'local', accountEmail: 'me@example.com' }];
  assert.deepEqual(run(sameProvider, remote).map((entry) => entry.accountKey), ['local', 'remote']);
  // The aggregate normally carries this device's accounts too; they appear once.
  assert.deepEqual(run(mine, [...mine, ...remote]).map((entry) => entry.accountKey), ['local', 'remote']);
});

test('a hub timestamp that cannot be parsed does not turn a save into a crash', () => {
  const subscriptionApi = require('../../src/shared/subscriptionDisplay');
  // A stored document could carry a malformed or legacy updatedAt; Date.parse
  // would hand toISOString() a NaN and throw where a save was expected.
  for (const previous of ['not-a-date', '2026-13-45', '∞']) {
    const doc = subscriptionApi.subscriptionDocument([], { previousUpdatedAt: previous });
    assert.match(doc.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('one hub cached list is never filed as records belonging to the next hub', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const refresh = functionBody(main, 'refreshSharedSubscriptionsNow', 'maybeAdoptSharedSubscriptionRevision');

  // Once settings.subscriptions is a cache of some hub it is that hub's data.
  // Carrying it into the next hub would seed or offer accounts that were never
  // entered on this device.
  assert.match(refresh, /const local = settings\.subscriptionsCacheHub \? \[\] : \(settings\.subscriptions \|\| \[\]\);/);
  // And a document from another hub is dropped rather than shown as this one's.
  assert.match(refresh, /hubSubscriptions && hubSubscriptionsHub !== hub/);
  // The identity is captured before the request, so a hub switch mid-flight
  // cannot make a late answer land under the wrong hub's name.
  assert.match(refresh, /const hub = currentHubIdentity\(\);/);
  assert.match(refresh, /if \(!subscriptionOpIsCurrent\(hub\)\) return false;/);
  // Every hub read and write goes through the lane for its own hub, so nothing
  // can observe the state between another operation on it starting and finishing.
  assert.match(functionBody(main, 'refreshSharedSubscriptions', 'refreshSharedSubscriptionsNow'), /queueSubscriptionOp\(/);
  assert.match(functionBody(main, 'writeSharedSubscriptions', 'writeSharedSubscriptionsNow'), /queueSubscriptionOp\(/);
  // Neither can outlast a hub that accepts the connection and stops answering.
  assert.match(functionBody(main, 'fetchSharedSubscriptions', 'staleSubscriptionWriteError'), /signal: AbortSignal\.timeout\(15_000\)/);
  assert.match(functionBody(main, 'writeSharedSubscriptionsNow', 'rememberOrphanedSubscriptions'), /signal: AbortSignal\.timeout\(15_000\)/);

  // Editing in local mode hands ownership back, which is what clears the marker.
  const save = functionBody(main, 'saveSubscriptions', 'stopSyncCollector');
  assert.match(save, /settings\.subscriptionsCacheHub = '';/);

  // A trailing slash the user typed must not read as a different hub.
  const identity = functionBody(main, 'currentHubIdentity', 'orphanedSubscriptions');
  const run = (url) => vm.runInNewContext(`${identity}\ncurrentHubIdentity();`, { effectiveHubConfig: () => ({ url }) });
  assert.equal(run('https://hub.example/'), 'https://hub.example');
  assert.equal(run('https://hub.example'), 'https://hub.example');
  assert.equal(run(null), '');
});

test('both hubs answer a stale write the same way, even when it is also malformed', async () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '..', 'worker', 'src', 'index.js'), 'utf8');
  const staleAt = worker.indexOf('isStaleSubscriptionWrite');
  const currencyAt = worker.indexOf('unsupported currency');
  // A stale write is exactly the case where the client needs the stored document
  // back to re-base on; answering 400 instead would withhold it.
  assert.ok(staleAt > -1 && staleAt < currencyAt, 'staleness must be checked before currency');

  const hubSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'hub', 'server.js'), 'utf8');
  const set = functionBody(hubSource, 'setSubscriptions', 'onStats');
  assert.ok(set.indexOf('isStaleSubscriptionWrite') < set.indexOf('unsupported currency'));
});

test('records held for a decision survive reconnecting to the same hub', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'cacheSharedSubscriptions', 'persistSubscriptionState'),
    functionBody(main, 'rememberOrphanedSubscriptions', 'currentHubIdentity'),
    functionBody(main, 'orphanedSubscriptions', 'pendingOrphanedSubscriptions'),
    functionBody(main, 'pendingOrphanedSubscriptions', 'adoptOrphanedSubscriptions'),
    `async ${functionBody(main, 'refreshSharedSubscriptionsNow', 'maybeAdoptSharedSubscriptionRevision')}`
  ].join('\n');

  const context = vm.createContext({
    settings: {
      hubMode: 'client',
      subscriptions: [{ id: 'mine' }],
      subscriptionsOrphaned: { hubUrl: '', records: [] },
      subscriptionsCacheHub: ''
    },
    hubSubscriptions: null,
    hubSubscriptionsHub: '',
    subscriptionOpIsCurrent: (hub) => hub === context.currentHubIdentity(),
    subscriptionsAreShared: () => true,
    currentHubIdentity: () => 'https://hub.example',
    fetchSharedSubscriptions: async () => ({ updatedAt: '2026-08-02T09:00:00.000Z', subscriptions: [{ id: 'theirs' }] }),
    writeSharedSubscriptionsNow: async () => {},
    persistSubscriptionState: () => true,
    console: { log() {} },
    JSON
  });
  const refresh = () => vm.runInContext(`${source}\nrefreshSharedSubscriptionsNow({ seedFromLocal: true });`, context);

  // Joining a hub that already has records sets this device's aside.
  await refresh();
  assert.deepEqual(plain(context.settings.subscriptionsOrphaned.records), [{ id: 'mine' }]);

  // A restart, or any later mode change, reconciles against the same hub again.
  // settings.subscriptions is now that hub's cache, so comparing it against the
  // hub finds no differences — and used to answer that by clearing a set the
  // user had not decided about yet.
  await refresh();
  assert.deepEqual(plain(context.settings.subscriptionsOrphaned.records), [{ id: 'mine' }]);
  assert.deepEqual(plain(vm.runInContext('pendingOrphanedSubscriptions();', context)), [{ id: 'mine' }]);
});

test('a hub that cannot be reached never shows the previous hub records', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const effective = [
    functionBody(main, 'subscriptionsDocumentFor', 'effectiveSubscriptions'),
    functionBody(main, 'effectiveSubscriptions', 'cacheSharedSubscriptions')
  ].join('\n');
  const run = (context) => plain(vm.runInNewContext(`${effective}\neffectiveSubscriptions();`, {
    subscriptionsAreShared: () => true,
    currentHubIdentity: () => 'https://b.example',
    ...context
  }));

  const cached = { subscriptions: [{ id: 'from-a' }] };
  // Hub B is unreachable, so nothing was fetched and the document in hand is
  // still hub A's. Showing it would describe hub B with hub A's records.
  assert.deepEqual(
    run({
      hubSubscriptions: cached,
      hubSubscriptionsHub: 'https://a.example',
      settings: { subscriptions: [{ id: 'from-a' }], subscriptionsCacheHub: 'https://a.example' }
    }),
    []
  );
  // The on-disk copy answers when it belongs to this hub.
  assert.deepEqual(
    run({
      hubSubscriptions: null,
      hubSubscriptionsHub: '',
      settings: { subscriptions: [{ id: 'from-b' }], subscriptionsCacheHub: 'https://b.example' }
    }),
    [{ id: 'from-b' }]
  );
  // An unmarked list is this device's own, waiting to be seeded.
  assert.deepEqual(
    run({
      hubSubscriptions: null,
      hubSubscriptionsHub: '',
      settings: { subscriptions: [{ id: 'mine' }], subscriptionsCacheHub: '' }
    }),
    [{ id: 'mine' }]
  );
});

test('a rejection from the hub the user just left does not empty the one they are on', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'subscriptionsDocumentFor', 'effectiveSubscriptions'),
    functionBody(main, 'subscriptionOpIsCurrent', 'subscriptionsEndpoint'),
    functionBody(main, 'staleSubscriptionWriteError', 'writeSharedSubscriptions'),
    `async ${functionBody(main, 'writeSharedSubscriptionsNow', 'rememberOrphanedSubscriptions')}`
  ].join('\n');

  const context = vm.createContext({
    settings: { hubMode: 'client' },
    hubSubscriptions: { updatedAt: 'v1', subscriptions: [] },
    hubSubscriptionsHub: 'https://a.example',
    hub: 'https://a.example',
    currentHubIdentity: () => context.hub,
    embeddedHub: null,
    subscriptionsEndpoint: () => ({ url: 'https://a.example/api/subscriptions', headers: {} }),
    // Hub A rejects the write as stale, and the user switches to hub B before the
    // rejection arrives. Its body is hub A's list; caching it would describe hub
    // B with hub A's records — or, as here, with an empty list hub B never had.
    fetch: async () => {
      context.hub = 'https://b.example';
      return { status: 409, ok: false, json: async () => ({ updatedAt: 'a-v2', subscriptions: [] }) };
    },
    cacheSharedSubscriptions: (doc) => { context.cached = doc; return true; },
    AbortSignal: { timeout: () => null },
    JSON
  });
  vm.runInContext(source, context);

  await assert.rejects(
    () => vm.runInContext("writeSharedSubscriptionsNow([{ id: 'x' }], 'https://a.example', 'v1');", context),
    /stale_write/
  );
  assert.equal(context.cached, undefined);

  // Staying put, the same rejection is worth caching: it is the hub's current list.
  context.hub = 'https://a.example';
  context.fetch = async () => ({ status: 409, ok: false, json: async () => ({ updatedAt: 'a-v2', subscriptions: [{ id: 'theirs' }] }) });
  await assert.rejects(() => vm.runInContext("writeSharedSubscriptionsNow([{ id: 'x' }], 'https://a.example', 'v1');", context), /stale_write/);
  assert.deepEqual(plain(context.cached), { updatedAt: 'a-v2', subscriptions: [{ id: 'theirs' }] });
});

test('hub reads and writes run one at a time, in the order they were asked for', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'subscriptionsDocumentFor', 'effectiveSubscriptions'),
    functionBody(main, 'queueSubscriptionOp', 'subscriptionOpIsCurrent'),
    functionBody(main, 'subscriptionOpIsCurrent', 'subscriptionsEndpoint'),
    functionBody(main, 'writeSharedSubscriptions', 'writeSharedSubscriptionsNow'),
    `async ${functionBody(main, 'writeSharedSubscriptionsNow', 'rememberOrphanedSubscriptions')}`,
    functionBody(main, 'refreshSharedSubscriptions', 'refreshSharedSubscriptionsNow'),
    `async ${functionBody(main, 'refreshSharedSubscriptionsNow', 'maybeAdoptSharedSubscriptionRevision')}`
  ].join('\n');

  const build = () => {
    const context = vm.createContext({
      settings: {
        hubMode: 'client',
        subscriptions: [],
        subscriptionsOrphaned: { hubUrl: '', records: [] },
        subscriptionsCacheHub: 'https://hub.example'
      },
      hubSubscriptions: { updatedAt: 'v0', subscriptions: [] },
      hubSubscriptionsHub: 'https://hub.example',
      subscriptionQueues: new Map(),
      AbortSignal: { timeout: () => null },
      subscriptionsAreShared: () => true,
      currentHubIdentity: () => 'https://hub.example',
      embeddedHub: null,
      // The hub's state, so a read really does observe whatever the last write left.
      server: { updatedAt: 'v0', subscriptions: [] },
      log: [],
      subscriptionsEndpoint: () => ({ url: 'https://hub.example/api/subscriptions', headers: {} }),
      // Deliberately slow, so an unserialized read would have every chance to
      // overtake a write and observe the state before it.
      fetchSharedSubscriptions: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        context.log.push(`read:${context.server.updatedAt}`);
        return { ...context.server };
      },
      fetch: async (_url, init) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const body = JSON.parse(init.body);
        context.server = { updatedAt: body.subscriptions[0].id, subscriptions: body.subscriptions };
        context.log.push(`write:${context.server.updatedAt}`);
        return { ok: true, status: 200, json: async () => ({ ...context.server }) };
      },
      cacheSharedSubscriptions: (doc, hub) => {
        context.cached = doc;
        context.hubSubscriptions = doc;
        context.hubSubscriptionsHub = hub;
        return true;
      },
      rememberOrphanedSubscriptions: () => false,
      persistSubscriptionState: () => true,
      console: { log() {} },
      setTimeout,
      Promise,
      JSON
    });
    vm.runInContext(source, context);
    return context;
  };

  // A read started while a write is still in flight would answer with the state
  // before it, land last because it was quicker, and leave the saved record
  // invisible. The lane means the read cannot start until the write is done.
  const a = build();
  const write = vm.runInContext("writeSharedSubscriptions([{ id: 'saved' }], 'v0');", a);
  const read = vm.runInContext('refreshSharedSubscriptions({});', a);
  await Promise.all([write, read]);
  assert.deepEqual(a.log, ['write:saved', 'read:saved']);
  assert.equal(a.cached.updatedAt, 'saved');

  // And the same the other way round, which is the case the epoch used to cover.
  const b = build();
  const first = vm.runInContext('refreshSharedSubscriptions({});', b);
  const second = vm.runInContext("writeSharedSubscriptions([{ id: 'saved' }], 'v0');", b);
  await Promise.all([first, second]);
  assert.deepEqual(b.log, ['read:v0', 'write:saved']);
  assert.equal(b.cached.updatedAt, 'saved');

  // Two writes built on the same version, the second queued before the first came
  // back. Ordering them is not licence to re-base the second on what the first
  // left: its list was made without that change, and sending it under the token
  // the first produced is how a row deleted a moment ago comes back.
  const c = build();
  const one = vm.runInContext("writeSharedSubscriptions([{ id: 'one' }], 'v0');", c);
  const two = vm.runInContext("writeSharedSubscriptions([{ id: 'two' }], 'v0');", c);
  await one;
  await assert.rejects(() => two, /stale_write/);
  assert.deepEqual(c.log, ['write:one']);
  assert.equal(c.cached.updatedAt, 'one');
});

test('a failed operation does not block the lane behind it', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const queue = functionBody(main, 'queueSubscriptionOp', 'subscriptionOpIsCurrent');
  const context = vm.createContext({
    subscriptionQueues: new Map(),
    currentHubIdentity: () => 'https://hub.example',
    Promise
  });
  vm.runInContext(queue, context);

  const ran = [];
  context.boom = () => { ran.push('boom'); return Promise.reject(new Error('hub down')); };
  context.after = () => { ran.push('after'); return Promise.resolve('ok'); };
  // The caller still sees the failure, but one unreachable hub must not wedge
  // every later read and write for the rest of the session.
  await assert.rejects(() => vm.runInContext('queueSubscriptionOp(boom);', context), /hub down/);
  assert.equal(await vm.runInContext('queueSubscriptionOp(after);', context), 'ok');
  assert.deepEqual(ran, ['boom', 'after']);
});

test('a hub that accepts the connection and stops answering does not wedge the lane', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'queueSubscriptionOp', 'subscriptionOpIsCurrent'),
    `async ${functionBody(main, 'fetchSharedSubscriptions', 'staleSubscriptionWriteError')}`
  ].join('\n');

  const context = vm.createContext({
    settings: { hubMode: 'client' },
    embeddedHub: null,
    subscriptionQueues: new Map(),
    currentHubIdentity: () => 'https://hub.example',
    subscriptionsEndpoint: () => ({ url: 'https://hub.example/api/subscriptions', headers: {} }),
    // Records the deadline each request was given, and stands in for a socket
    // that stays open: the first request ends only because the deadline ends it.
    AbortSignal: { timeout: (ms) => ({ ms }) },
    deadlines: [],
    fetch: async (_url, init) => {
      context.deadlines.push(init?.signal?.ms);
      if (context.deadlines.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      return { ok: true, status: 200, json: async () => ({ updatedAt: 'v1', subscriptions: [] }) };
    },
    setTimeout,
    Promise
  });
  vm.runInContext(source, context);

  await assert.rejects(() => vm.runInContext('queueSubscriptionOp(() => fetchSharedSubscriptions());', context), /aborted/);
  // Without a deadline the first request would still be open, and this one — and
  // every save after it — would wait behind it until the app restarted.
  const answered = await vm.runInContext('queueSubscriptionOp(() => fetchSharedSubscriptions());', context);
  assert.equal(answered.updatedAt, 'v1');
  assert.deepEqual(context.deadlines, [15_000, 15_000]);
});

test('a save queued against one hub is not written to the one the user moved to', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'subscriptionsDocumentFor', 'effectiveSubscriptions'),
    functionBody(main, 'queueSubscriptionOp', 'subscriptionOpIsCurrent'),
    functionBody(main, 'subscriptionOpIsCurrent', 'subscriptionsEndpoint'),
    functionBody(main, 'writeSharedSubscriptions', 'writeSharedSubscriptionsNow'),
    `async ${functionBody(main, 'writeSharedSubscriptionsNow', 'rememberOrphanedSubscriptions')}`
  ].join('\n');

  const context = vm.createContext({
    settings: { hubMode: 'client' },
    embeddedHub: null,
    subscriptionQueues: new Map(),
    hub: 'https://a.example',
    currentHubIdentity: () => context.hub,
    hubSubscriptions: { updatedAt: 'a-v1', subscriptions: [] },
    hubSubscriptionsHub: 'https://a.example',
    subscriptionsEndpoint: () => ({ url: `${context.hub}/api/subscriptions`, headers: {} }),
    AbortSignal: { timeout: () => null },
    written: [],
    fetch: async (url) => {
      context.written.push(url);
      return { ok: true, status: 200, json: async () => ({ updatedAt: 'v2', subscriptions: [] }) };
    },
    cacheSharedSubscriptions: () => true,
    staleSubscriptionWriteError: () => new Error('stale_write'),
    Promise,
    JSON
  });
  vm.runInContext(source, context);

  // Hold the lane so the save is still queued when the user switches hubs.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  context.hold = () => held;
  const holding = vm.runInContext('queueSubscriptionOp(hold);', context);
  const queued = vm.runInContext("writeSharedSubscriptions([{ id: 'mine' }]);", context);
  context.hub = 'https://b.example';
  release();
  await holding;

  await assert.rejects(() => queued, /hub changed/);
  // Not merely unsaved: the records the user entered against A must not reach B
  // at all, least of all based on an updatedAt that was never read from it.
  assert.deepEqual(context.written, []);
});

test('a hub that is slow to answer does not hold up the one in front of the user', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const context = vm.createContext({
    subscriptionQueues: new Map(),
    hub: 'https://slow.example',
    currentHubIdentity: () => context.hub,
    Promise
  });
  vm.runInContext(functionBody(main, 'queueSubscriptionOp', 'subscriptionOpIsCurrent'), context);

  const ran = [];
  let finish;
  const stall = new Promise((resolve) => { finish = resolve; });
  const release = () => { ran.push('slow'); finish(); };
  context.slow = () => stall;
  context.quick = () => { ran.push('quick'); return Promise.resolve('quick'); };

  const stalled = vm.runInContext('queueSubscriptionOp(slow);', context);
  context.hub = 'https://near.example';
  // Ordering is only worth anything against one shared document. Behind a single
  // lane this would wait on a hub the user has already left.
  assert.equal(await vm.runInContext('queueSubscriptionOp(quick);', context), 'quick');
  assert.deepEqual(ran, ['quick']);

  release();
  await stalled;
  await new Promise((resolve) => setTimeout(resolve, 0));
  // And the lanes are gone once idle, rather than one per hub ever typed.
  assert.equal(context.subscriptionQueues.size, 0);
});

test('a version broadcast while an operation is in flight is compared again once it settles', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'subscriptionsDocumentFor', 'effectiveSubscriptions'),
    functionBody(main, 'queueSubscriptionOp', 'subscriptionOpIsCurrent'),
    functionBody(main, 'subscriptionOpIsCurrent', 'subscriptionsEndpoint'),
    functionBody(main, 'runSubscriptionCatchUp', 'saveSubscriptions')
  ].join('\n');

  // `leaves` is the version the operation holding the lane caches before it
  // finishes. That is the whole difference between the two cases below, and it
  // is not knowable when the frame arrives — only after.
  const run = async (leaves) => {
    const context = vm.createContext({
      subscriptionQueues: new Map(),
      hubSubscriptions: { updatedAt: 'v1', subscriptions: [] },
      hubSubscriptionsHub: 'https://a.example',
      currentHubIdentity: () => 'https://a.example',
      fetched: 0,
      pushed: 0,
      pushSettingsToRenderer: () => { context.pushed += 1; },
      refreshSharedSubscriptionsNow: async () => {
        context.fetched += 1;
        context.hubSubscriptions = { updatedAt: 'v2', subscriptions: [{ id: 'theirs' }] };
        return true;
      },
      Promise
    });
    vm.runInContext(source, context);

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    context.hold = () => held.then(() => {
      context.hubSubscriptions = { updatedAt: leaves, subscriptions: [] };
    });
    const holding = vm.runInContext('queueSubscriptionOp(hold);', context);

    // The frame lands while that operation is still running, and is the only
    // notice this device gets — nothing arrives afterwards to repeat it.
    const catchUp = vm.runInContext("runSubscriptionCatchUp('v2');", context);
    release();
    await holding;
    await catchUp;
    return context;
  };

  // Its own write: the hub broadcast v2 because this device wrote it, and the
  // write's own response leaves the document at v2. Nothing left to fetch, so
  // recording a subscription must not cost a read back of what was just sent.
  const afterWrite = await run('v2');
  assert.equal(afterWrite.fetched, 0);
  assert.equal(afterWrite.pushed, 0);

  // A read already in flight when the broadcast landed answers with the document
  // from before the write, and caches it. Deciding at frame time would have
  // discarded the only notice of it, leaving this device on the old list.
  const afterRead = await run('v1');
  assert.equal(afterRead.fetched, 1);
  assert.equal(afterRead.pushed, 1);
});

test('a stats frame stamped with a newer subscription version is read back, once', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'subscriptionsAreShared', 'subscriptionsDocumentFor'),
    functionBody(main, 'subscriptionsDocumentFor', 'effectiveSubscriptions'),
    functionBody(main, 'maybeAdoptSharedSubscriptionRevision', 'runSubscriptionCatchUp')
  ].join('\n');

  const context = vm.createContext({
    settings: { hubMode: 'client' },
    subscriptionQueues: new Map(),
    hubSubscriptions: { updatedAt: 'v1', subscriptions: [] },
    hubSubscriptionsHub: 'https://a.example',
    currentHubIdentity: () => 'https://a.example',
    lastSubscriptionCatchUp: { hub: '', version: '', at: 0 },
    SUBSCRIPTION_RETRY_MS: 60000,
    now: 1_000_000,
    Date: { now: () => context.now },
    reads: 0,
    runSubscriptionCatchUp: () => { context.reads += 1; return Promise.resolve(); }
  });
  vm.runInContext(source, context);
  const push = (stats) => vm.runInContext(`maybeAdoptSharedSubscriptionRevision(${JSON.stringify(stats)});`, context);

  // The steady state: the hub is stamping every frame with the version this
  // device already holds, and none of them costs a request. This is what
  // replaced the periodic read, so it has to be free.
  push({ subscriptionsUpdatedAt: 'v1' });
  assert.equal(context.reads, 0);

  // Another device wrote. Landing it settles the question — the document in hand
  // now matches what the hub keeps stamping.
  push({ subscriptionsUpdatedAt: 'v2' });
  assert.equal(context.reads, 1);
  context.hubSubscriptions = { updatedAt: 'v2', subscriptions: [] };
  push({ subscriptionsUpdatedAt: 'v2' });
  assert.equal(context.reads, 1);

  // A local collector's own stats carry no stamp. Reading that as "the hub holds
  // nothing" would take the records off the screen.
  push({});
  push({ subscriptionsUpdatedAt: null });
  assert.equal(context.reads, 1);

  // This one does not land — the document in hand stays at v2. Frames arrive on
  // every ingest from every device, so a hub serving /api/stats but failing
  // /api/subscriptions would be asked again on each one.
  push({ subscriptionsUpdatedAt: 'v3' });
  assert.equal(context.reads, 2);
  push({ subscriptionsUpdatedAt: 'v3' });
  push({ subscriptionsUpdatedAt: 'v3' });
  assert.equal(context.reads, 2);

  // The wait is a floor on retrying the same version, not a polling interval:
  // a transient failure still heals on its own …
  context.now += 60_000;
  push({ subscriptionsUpdatedAt: 'v3' });
  assert.equal(context.reads, 3);

  // … and a version that moves is news again, tried at once rather than waited out.
  push({ subscriptionsUpdatedAt: 'v4' });
  assert.equal(context.reads, 4);

  // Local mode has no shared list to be overtaken.
  context.settings.hubMode = 'local';
  push({ subscriptionsUpdatedAt: 'v5' });
  assert.equal(context.reads, 4);

  // The stamp is only useful if both stats paths consult it: the stream while it
  // is up, and the widget's own read when it is not.
  assert.match(functionBody(main, 'sendPush', 'statsHistoryRevision'), /maybeAdoptSharedSubscriptionRevision\(/);
  assert.match(main, /const stats = await fetchStats\(options\);[\s\S]{0,240}maybeAdoptSharedSubscriptionRevision\(stats\);/);
  // And there is no periodic subscription read left behind it. One existed while
  // the stamp did not; keeping it would spend a request every five minutes per
  // device to be told what every frame already says.
  assert.doesNotMatch(main, /maybeRefreshSharedSubscriptions/);
});

test('coming back to a hub does not write against the other hub token', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'subscriptionsDocumentFor', 'effectiveSubscriptions'),
    functionBody(main, 'queueSubscriptionOp', 'subscriptionOpIsCurrent'),
    functionBody(main, 'subscriptionOpIsCurrent', 'subscriptionsEndpoint'),
    functionBody(main, 'writeSharedSubscriptions', 'writeSharedSubscriptionsNow'),
    `async ${functionBody(main, 'writeSharedSubscriptionsNow', 'rememberOrphanedSubscriptions')}`
  ].join('\n');

  const context = vm.createContext({
    settings: { hubMode: 'client' },
    embeddedHub: null,
    subscriptionQueues: new Map(),
    hub: 'https://a.example',
    currentHubIdentity: () => context.hub,
    // A → B → A: hub B's document is still the one installed, because A's own
    // refresh has not replaced it yet. The queued-hub check passes — A really is
    // in front of the user — and only the document says otherwise.
    hubSubscriptions: { updatedAt: 'b-v9', subscriptions: [{ id: 'b-record' }] },
    hubSubscriptionsHub: 'https://b.example',
    subscriptionsEndpoint: () => ({ url: `${context.hub}/api/subscriptions`, headers: {} }),
    AbortSignal: { timeout: () => null },
    sent: [],
    fetch: async (url, init) => {
      context.sent.push({ url, base: JSON.parse(init.body).baseUpdatedAt });
      return { ok: true, status: 200, json: async () => ({ updatedAt: 'a-v2', subscriptions: [] }) };
    },
    cacheSharedSubscriptions: () => true,
    staleSubscriptionWriteError: () => new Error('stale_write'),
    Promise,
    JSON
  });
  vm.runInContext(source, context);

  // An edit made while B was on screen claims B's token. Sent to A it claims to
  // have read a list that was never A's, and an A carrying the same token would
  // accept it outright, over records this device has never seen. Refused here
  // instead, which tells the user to look at what A actually holds.
  await assert.rejects(
    () => vm.runInContext("writeSharedSubscriptions([{ id: 'mine' }], 'b-v9');", context),
    /stale_write/
  );
  assert.deepEqual(plain(context.sent), []);

  // With A's own document in hand and an edit built on it, the write goes out —
  // carrying the version it was built from, which is what keeps 409 meaningful.
  context.hubSubscriptions = { updatedAt: 'a-v1', subscriptions: [] };
  context.hubSubscriptionsHub = 'https://a.example';
  await vm.runInContext("writeSharedSubscriptions([{ id: 'mine' }], 'a-v1');", context);
  assert.deepEqual(plain(context.sent), [{ url: 'https://a.example/api/subscriptions', base: 'a-v1' }]);

  // And an edit built on a version this device has already moved past is stale
  // for the same reason another device's write is, without a round trip to hear it.
  context.hubSubscriptions = { updatedAt: 'a-v2', subscriptions: [{ id: 'theirs' }] };
  context.sent = [];
  await assert.rejects(
    () => vm.runInContext("writeSharedSubscriptions([{ id: 'mine' }], 'a-v1');", context),
    /stale_write/
  );
  assert.deepEqual(plain(context.sent), []);

  // Adopting set-aside records merges into the document in hand, so it has to ask
  // the same question — otherwise B's records join A's list as though entered here.
  const adopt = functionBody(main, 'adoptOrphanedSubscriptions', 'subscriptionWriteFailureCode');
  assert.doesNotMatch(adopt, /hubSubscriptions\?\./);
  assert.match(adopt, /subscriptionsDocumentFor\(/);
});

test('an edit is saved against the version its form was opened on', async () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  const source = [
    functionBody(app, 'setSubscriptionFormOpen', 'seedSubscriptionPlanName'),
    functionBody(app, 'subscriptionSettingsVersion', 'applySubscriptionSettings'),
    functionBody(app, 'applySubscriptionSettings', 'saveSubscriptions'),
    `async ${functionBody(app, 'saveSubscriptions', 'subscriptionWriteErrorKey')}`,
    functionBody(app, 'subscriptionWriteErrorKey', 'renderSubscriptionOrphanNotice')
  ].join('\n');

  const context = vm.createContext({
    els: {},
    state: { settings: { subscriptionsHub: 'https://a.example', subscriptionsUpdatedAt: 'v1' }, subscriptionFormBase: null },
    hub: 'https://a.example',
    onHub: 'v1',
    // What a write would leave behind, set per step the way a hub would.
    nextVersion: '',
    sent: [],
    window: {
      tokenMonitor: {
        saveSubscriptions: async (list, base) => {
          context.sent.push(base?.updatedAt);
          if (base?.hub !== context.hub) throw new Error('hub_changed');
          if (base?.updatedAt !== context.onHub) throw new Error('stale_write');
          context.onHub = context.nextVersion;
          return { subscriptionsHub: context.hub, subscriptionsUpdatedAt: context.onHub, subscriptions: list };
        },
        getSettings: async () => ({ subscriptionsHub: context.hub, subscriptionsUpdatedAt: context.onHub })
      }
    },
    renderSubscriptionSettings: () => {},
    syncSubscriptionAddControl: () => {},
    resetSubscriptionForm: () => { context.formReset = true; },
    Promise
  });
  vm.runInContext(source, context);

  vm.runInContext('setSubscriptionFormOpen(true);', context);
  assert.deepEqual(plain(context.state.subscriptionFormBase), { hub: 'https://a.example', updatedAt: 'v1' });

  // Another device writes while the form is open. The push replaces settings, and
  // the row for the record being edited is redrawn — but the fields in front of
  // the user are still the ones they typed, against v1.
  context.state.settings = { subscriptionsHub: 'https://a.example', subscriptionsUpdatedAt: 'v2' };
  context.onHub = 'v2';

  // So the save says v1 and is refused, instead of claiming to have seen a change
  // it was never shown and carrying the other device's edit away with it.
  assert.equal(
    await vm.runInContext("saveSubscriptions([{ id: 'mine' }], state.subscriptionFormBase || '');", context),
    false
  );
  assert.deepEqual(context.sent, ['v1']);
  assert.equal(context.state.subscriptionSyncError, 'settings.subscriptions.errorStaleWrite');
  assert.equal(context.formReset, undefined);

  // Re-anchored on what is now on screen, so the user can look at what changed and
  // save again. Without this the second attempt would be refused too, and every
  // one after it.
  assert.deepEqual(plain(context.state.subscriptionFormBase), { hub: 'https://a.example', updatedAt: 'v2' });
  context.nextVersion = 'v3';
  assert.equal(
    await vm.runInContext("saveSubscriptions([{ id: 'mine' }], state.subscriptionFormBase || '');", context),
    true
  );
  assert.deepEqual(context.sent, ['v1', 'v2']);

  // Removing a row while a form is open writes a new version too, and that one
  // the user has seen — they removed it. The form re-anchors on what this device
  // wrote rather than refusing the edit still in progress, once, for a change it
  // caused itself.
  assert.deepEqual(plain(context.state.subscriptionFormBase), { hub: 'https://a.example', updatedAt: 'v3' });
  context.sent = [];
  context.nextVersion = 'v4';
  assert.equal(await vm.runInContext('saveSubscriptions([], subscriptionSettingsVersion());', context), true);
  assert.deepEqual(context.sent, ['v3']);
  assert.deepEqual(plain(context.state.subscriptionFormBase), { hub: 'https://a.example', updatedAt: 'v4' });

  // Switching hubs under an open form is the one case re-anchoring must not
  // handle: the fields hold an edit made for the hub the user left, and giving
  // them the new hub's version would let that edit be saved into its list. Two
  // hubs nobody has written to would even agree on the version, so only the hub
  // itself can answer this.
  context.hub = 'https://b.example';
  context.onHub = 'b-v1';
  context.sent = [];
  assert.equal(
    await vm.runInContext('saveSubscriptions([{ id: \'mine\' }], state.subscriptionFormBase);', context),
    false
  );
  assert.equal(context.state.subscriptionSyncError, 'settings.subscriptions.errorHubChanged');
  assert.equal(context.formReset, true);
  // The form is gone rather than re-pointed, so there is no second attempt to be
  // accepted by the hub the edit was never meant for.
  assert.equal(context.state.subscriptionFormBase, null);

  // And closed, there is no form version to speak for — the row actions carry
  // what is on screen instead.
  vm.runInContext('setSubscriptionFormOpen(true);', context);
  vm.runInContext('setSubscriptionFormOpen(false);', context);
  assert.equal(context.state.subscriptionFormBase, null);

  // Adopting and discarding move the shared list on too, and each was found to
  // have forgotten this rule one at a time. None of the three may take a settings
  // snapshot straight from the channel that produced it — they go through the one
  // function that knows what an open form has to do about it.
  assert.doesNotMatch(
    app,
    /state\.settings = await window\.tokenMonitor\.(saveSubscriptions|adoptOrphanedSubscriptions|discardOrphanedSubscriptions)/
  );
  for (const channel of ['saveSubscriptions', 'adoptOrphanedSubscriptions', 'discardOrphanedSubscriptions']) {
    assert.match(app, new RegExp(`applySubscriptionSettings\\(await window\\.tokenMonitor\\.${channel}\\(`));
  }
});

test('a form opened on a hub is not written into this device own list instead', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'hubChangedError', 'subscriptionsEndpoint'),
    `async ${functionBody(main, 'saveSubscriptions', 'stopSyncCollector')}`
  ].join('\n');

  const context = vm.createContext({
    // Switched to local mode with the hub still configured, which is the state
    // the mode switch leaves behind. Only the mode says which list is in front of
    // the user, so only the mode can say which one an edit belongs to.
    settings: { hubMode: 'local', hubUrl: 'https://a.example', subscriptions: [{ id: 'cached' }], subscriptionsCacheHub: 'https://a.example' },
    subscriptionsAreShared: () => false,
    currentHubIdentity: () => '',
    subscriptionDisplay: { normalizeSubscriptions: (list) => list },
    normalizeCurrency: (value) => value,
    saveSettings: () => { context.saved = true; return true; },
    settingsForRenderer: () => ({}),
    writeSharedSubscriptions: async () => { context.wrote = true; },
    Promise,
    String,
    Object
  });
  vm.runInContext(source, context);

  // The form was composed against hub A's list. Landing it here would take those
  // records as this device's own — subscriptionsCacheHub cleared, ownership
  // handed over — on the strength of an edit that was never about this list.
  await assert.rejects(
    () => vm.runInContext("saveSubscriptions([{ id: 'mine' }], { hub: 'https://a.example', updatedAt: 'a-v1' });", context),
    /hub changed/
  );
  assert.equal(context.saved, undefined);
  assert.equal(context.wrote, undefined);
  assert.equal(context.settings.subscriptionsCacheHub, 'https://a.example');
  assert.deepEqual(plain(context.settings.subscriptions), [{ id: 'cached' }]);

  // A form opened in local mode carries the empty identity and saves normally.
  await vm.runInContext("saveSubscriptions([{ id: 'mine' }], { hub: '', updatedAt: '' });", context);
  assert.equal(context.saved, true);
  assert.equal(context.settings.subscriptionsCacheHub, '');
});

test('adopting set-aside records keeps whatever the hub gained while it waited', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const source = [
    functionBody(main, 'subscriptionsDocumentFor', 'effectiveSubscriptions'),
    functionBody(main, 'queueSubscriptionOp', 'subscriptionOpIsCurrent'),
    functionBody(main, 'subscriptionOpIsCurrent', 'subscriptionsEndpoint'),
    `async ${functionBody(main, 'writeSharedSubscriptionsNow', 'rememberOrphanedSubscriptions')}`,
    `async ${functionBody(main, 'adoptOrphanedSubscriptions', 'subscriptionWriteFailureCode')}`
  ].join('\n');

  const context = vm.createContext({
    settings: { hubMode: 'client', subscriptionsOrphaned: { hubUrl: 'https://a.example', records: [{ id: 'mine' }] } },
    embeddedHub: null,
    subscriptionQueues: new Map(),
    currentHubIdentity: () => 'https://a.example',
    hubSubscriptions: { updatedAt: 'a-v1', subscriptions: [] },
    hubSubscriptionsHub: 'https://a.example',
    pendingOrphanedSubscriptions: () => context.settings.subscriptionsOrphaned.records,
    subscriptionsEndpoint: () => ({ url: 'https://a.example/api/subscriptions', headers: {} }),
    AbortSignal: { timeout: () => null },
    sent: [],
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      context.sent.push({ base: body.baseUpdatedAt, ids: body.subscriptions.map((entry) => entry.id) });
      return { ok: true, status: 200, json: async () => ({ updatedAt: 'a-v3', subscriptions: body.subscriptions }) };
    },
    cacheSharedSubscriptions: () => true,
    staleSubscriptionWriteError: () => new Error('stale_write'),
    settingsForRenderer: () => ({}),
    saveSettings: () => true,
    setTimeout,
    Promise,
    JSON
  });
  vm.runInContext(source, context);

  // Already in the lane, and it moves the hub on: another device's record arrives
  // and the document the merge would have read becomes the one before it.
  context.ahead = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    context.hubSubscriptions = { updatedAt: 'a-v2', subscriptions: [{ id: 'theirs' }] };
  };
  const queued = vm.runInContext('queueSubscriptionOp(ahead);', context);
  const adopting = vm.runInContext('adoptOrphanedSubscriptions();', context);
  await Promise.all([queued, adopting]);

  // Merging outside the lane would pair a-v1's list with a-v2's token: current
  // enough for the hub to accept, and 'theirs' would be gone without a word.
  assert.deepEqual(plain(context.sent), [{ base: 'a-v2', ids: ['theirs', 'mine'] }]);
  assert.deepEqual(plain(context.settings.subscriptionsOrphaned), { hubUrl: '', records: [] });
});

test('switching hubs does not wait out the old hub request before starting', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const startMode = functionBody(main, 'startMode', 'reconcileSharedSubscriptions');
  // The mode queue orders hub infrastructure so a port edit cannot finish behind
  // the mode change that preceded it. Subscriptions are not part of that — they
  // have a lane of their own, per hub — and awaiting them here makes the next
  // hub's stream and collector wait out this one's 15s deadline with nothing on
  // screen.
  assert.doesNotMatch(startMode, /await reconcileSharedSubscriptions/);
  assert.match(startMode, /reconcileSharedSubscriptions\(\);/);
  // Nothing awaits it any more, so it has to keep its own failures rather than
  // surface them as an unhandled rejection.
  assert.match(functionBody(main, 'reconcileSharedSubscriptions', 'restartDeviceRuntimeForMode'), /\} catch \(error\) \{/);
});
