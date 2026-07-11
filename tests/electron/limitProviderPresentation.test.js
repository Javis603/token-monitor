'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  apiKeyAccountStatus,
  isCodexLiveAccount,
  limitProviderDisplayLabel,
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

test('limitProviderDisplayLabel normalizes short account labels without rewriting identifiers', () => {
  assert.equal(limitProviderDisplayLabel('plus'), 'Plus');
  assert.equal(limitProviderDisplayLabel('pro'), 'Pro');
  assert.equal(limitProviderDisplayLabel('go'), 'Go');
  assert.equal(limitProviderDisplayLabel('Team'), 'Team');
  assert.equal(limitProviderDisplayLabel('javis603@gmail.com'), 'javis603@gmail.com');
  assert.equal(limitProviderDisplayLabel(''), '');
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

function runLocalProviderStatus(source, state, providerName) {
  const localDeviceHelper = functionBody(source, 'localDeviceLimitsProviders', 'localProviderStatus');
  const localProviderHelper = functionBody(source, 'localProviderStatus', 'deepseekAccountLinked');
  return vm.runInNewContext(
    `${localDeviceHelper}\n${localProviderHelper}\nlocalProviderStatus(${JSON.stringify(providerName)});`,
    { state }
  );
}

function runLocalLiveCodexProvider(source, state) {
  const localDeviceHelper = functionBody(source, 'localDeviceLimitsProviders', 'localProviderStatus');
  const liveHelper = functionBody(source, 'localLiveCodexProvider', 'codexActiveAccountFromStats');
  return vm.runInNewContext(
    `${localDeviceHelper}\n${liveHelper}\nlocalLiveCodexProvider();`,
    { state, limitProviderPresentationApi: { isCodexLiveAccount } }
  );
}

test('capability tags explain how each provider is collected in settings', () => {
  assert.deepEqual(limitProviderCapabilityTags('claude'), ['Auto', 'OAuth/CLI']);
  assert.deepEqual(limitProviderCapabilityTags('codex'), ['Auto', 'App/CLI RPC']);
  assert.deepEqual(limitProviderCapabilityTags('cursor'), ['Manual login', 'Web']);
  assert.deepEqual(limitProviderCapabilityTags('antigravity'), ['App/CLI must be open', 'RPC']);
  assert.deepEqual(limitProviderCapabilityTags('opencode'), ['Local/Web', 'Manual login']);
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
  assert.equal(apiKeyAccountStatus(null, true), 'checking');
  assert.equal(apiKeyAccountStatus({ status: 'ok' }, true), 'linked');
  assert.equal(apiKeyAccountStatus({ status: 'unauthorized' }, true), 'invalid');
  assert.equal(apiKeyAccountStatus({ status: 'rateLimited' }, true), 'limited');
  assert.equal(apiKeyAccountStatus({ status: 'sourceRateLimited' }, true), 'limited');
  assert.equal(apiKeyAccountStatus({ status: 'unavailable' }, true), 'unavailable');
  assert.equal(apiKeyAccountStatus({ status: 'error' }, true), 'error');
  assert.equal(apiKeyAccountStatus({ status: 'disabled' }, true), 'notChecked');
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
  const renderAllSessions = functionBody(app, 'renderAllSessionsIcon', 'renderLimitSessionsIcon');

  assert.match(pickConfigured, /providersByLimitProviderId\(providers\)/);
  assert.doesNotMatch(pickConfigured, /new Map\(providers\.map\(\(p\) => \[String\(p\.provider\)\.toLowerCase\(\), p\]\)\)/);
  assert.match(renderAllSessions, /trayBarsLayout\(height, \{ contentOnly: true \}\)/);
});

test('limit percent tray mode renders provider icons into a generated tray image', () => {
  const app = readRendererFile('app.js');
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const renderLimitSessionsIcon = functionBody(app, 'renderLimitSessionsIcon', 'barsDataUrlForMode');
  const maybeUpdateBarsIcon = functionBody(app, 'maybeUpdateBarsIcon', 'loadImage');
  const updateTrayDisplay = functionBody(main, 'updateTrayDisplay', 'sendStatus');

  assert.match(renderLimitSessionsIcon, /pickConfiguredSessionProviders\(stats, configOrder\)/);
  assert.match(renderLimitSessionsIcon, /trayBarsLayout\(height/);
  assert.match(renderLimitSessionsIcon, /layout\.iconSize/);
  assert.match(renderLimitSessionsIcon, /picks\.length === 1/);
  assert.match(renderLimitSessionsIcon, /kind === 'weekly'/);
  assert.match(renderLimitSessionsIcon, /weeklyPercent === null \? '' : formatPercent\(weeklyPercent\)/);
  assert.match(renderLimitSessionsIcon, /trayProviderImages\[pick\.provider\.provider\]/);
  assert.match(renderLimitSessionsIcon, /`500 \$\{fontSize\}px/);
  assert.match(renderLimitSessionsIcon, /formatPercent\(limitFillPercent/);
  assert.match(renderLimitSessionsIcon, /·/);
  assert.match(maybeUpdateBarsIcon, /limitsAllSessions/);
  assert.match(maybeUpdateBarsIcon, /trayDataUrlForMode\(mode, 44\)/);
  assert.match(updateTrayDisplay, /mode === 'limitsAllSessions'/);
  assert.match(updateTrayDisplay, /const barsImageMode = .*?!limitText && providerTrayIcons\[mode\]/);
  assert.match(updateTrayDisplay, /Boolean\(limitText\)/);
  assert.match(updateTrayDisplay, /const limitText = formatTrayText/);
  assert.match(updateTrayDisplay, /trayImageMode[\s\S]*?\? '' : limitText/);
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

test('Qoder renders its single Credits billing window full-width', () => {
  const app = readRendererFile('app.js');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');

  assert.match(renderProviderWindows, /provider\.provider === 'qoder'/);
  assert.match(renderProviderWindows, /const credits = windowForKind\(provider, 'billing'\);/);
  assert.match(renderProviderWindows, /formatLimitCount\(credits, Boolean\(state\.settings\?\.showLimitUsed\)\)/);
  assert.match(renderProviderWindows, /limit-window-wide/);
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

test('Codex renders manual reset credits below session and weekly windows', () => {
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');
  const resetCreditsValue = functionBody(app, 'formatCodexResetCreditsValue', 'formatCodexResetCreditsExpiry');
  const resetCreditsExpiry = functionBody(app, 'formatCodexResetCreditsExpiry', 'codexResetCreditExpirationDates');
  const resetCreditExpirationDates = functionBody(app, 'codexResetCreditExpirationDates', 'codexResetCreditExpiryLabel');
  const resetCreditExpiryLabel = functionBody(app, 'codexResetCreditExpiryLabel', 'codexResetCreditsNode');
  const codexResetCreditsNode = functionBody(app, 'codexResetCreditsNode', 'renderLimitProviderHead');
  const resetCreditsTooltipShouldHoldRender = functionBody(app, 'resetCreditsTooltipShouldHoldRender', 'flushPendingResetCreditsTooltipRender');
  const flushPendingResetCreditsTooltipRender = functionBody(app, 'flushPendingResetCreditsTooltipRender', 'codexResetCreditsNode');
  const renderLimits = functionBody(app, 'renderLimits', 'serviceStatusLabel');

  assert.match(app, /resetCreditsTooltipHasOpened: false/);
  assert.match(app, /resetCreditsTooltipActive: false/);
  assert.match(app, /resetCreditsTooltipRenderPending: false/);
  assert.match(renderProviderWindows, /provider\.provider === 'codex'/);
  assert.match(renderProviderWindows, /const resetNode = codexResetCreditsNode\(provider\.resetCredits\);/);
  assert.doesNotMatch(renderProviderWindows, /limitWindowNode\('Reset credits'/);
  assert.match(resetCreditsValue, /if \(count <= 0\) return '';/);
  assert.match(resetCreditsValue, /return `\$\{count\} reset\$\{count === 1 \? '' : 's'\}`;/);
  assert.doesNotMatch(resetCreditsValue, /available`;/);
  assert.match(resetCreditsExpiry, /`Next expires in \$\{formatDuration\(diffMs\)\}`/);
  assert.match(resetCreditExpirationDates, /resetCredits\?\.expirations/);
  assert.match(resetCreditExpirationDates, /\.sort\(\(a, b\) => a\.getTime\(\) - b\.getTime\(\)\)/);
  assert.match(resetCreditExpiryLabel, /`Expires in \$\{formatDuration\(diffMs\)\}`/);
  assert.match(codexResetCreditsNode, /limit-reset-credits/);
  assert.match(codexResetCreditsNode, /limit-reset-credits-line/);
  assert.match(codexResetCreditsNode, /limit-reset-credits-info-wrap/);
  assert.match(codexResetCreditsNode, /limit-reset-credits-info/);
  assert.match(codexResetCreditsNode, /limit-reset-credits-tooltip/);
  assert.match(codexResetCreditsNode, /infoWrap\.classList\.toggle\('has-opened', state\.resetCreditsTooltipHasOpened\);/);
  assert.match(codexResetCreditsNode, /pointerenter/);
  assert.match(codexResetCreditsNode, /focusin/);
  assert.match(codexResetCreditsNode, /state\.resetCreditsTooltipHasOpened = true;/);
  assert.match(codexResetCreditsNode, /state\.resetCreditsTooltipActive = true;/);
  assert.match(codexResetCreditsNode, /infoWrap\.classList\.add\('has-opened'\);/);
  assert.match(codexResetCreditsNode, /addEventListener\('pointerenter', markResetCreditsTooltipOpened\)/);
  assert.match(codexResetCreditsNode, /addEventListener\('focusin', markResetCreditsTooltipOpened\)/);
  assert.match(codexResetCreditsNode, /addEventListener\('pointerleave', releaseResetCreditsTooltip\)/);
  assert.match(codexResetCreditsNode, /addEventListener\('focusout', releaseResetCreditsTooltip\)/);
  assert.match(codexResetCreditsNode, /infoWrap\.matches\(':hover, :focus-within'\)/);
  assert.match(codexResetCreditsNode, /info\.textContent = 'i';/);
  assert.match(codexResetCreditsNode, /infoWrap\.append\(info, tooltip\);/);
  assert.match(codexResetCreditsNode, /expiryGroup\.append\(infoWrap\);/);
  assert.match(codexResetCreditsNode, /tabIndex = 0/);
  assert.doesNotMatch(codexResetCreditsNode, /aria-expanded/);
  assert.doesNotMatch(codexResetCreditsNode, /addEventListener\('click'/);
  assert.match(codexResetCreditsNode, /formatCodexResetCreditsValue\(resetCredits\)/);
  assert.match(codexResetCreditsNode, /formatCodexResetCreditsExpiry\(resetCredits\)/);
  assert.match(codexResetCreditsNode, /aria-label/);
  assert.match(resetCreditsTooltipShouldHoldRender, /state\.resetCreditsTooltipActive/);
  assert.match(resetCreditsTooltipShouldHoldRender, /querySelector\('\.limit-reset-credits-info-wrap:hover, \.limit-reset-credits-info-wrap:focus-within'\)/);
  assert.match(flushPendingResetCreditsTooltipRender, /state\.resetCreditsTooltipRenderPending/);
  assert.match(flushPendingResetCreditsTooltipRender, /state\.breakdown !== 'limits'/);
  assert.match(flushPendingResetCreditsTooltipRender, /renderLimits\(\)/);
  assert.match(renderLimits, /const holdResetCreditsTooltipRender = resetCreditsTooltipShouldHoldRender\(\);/);
  assert.match(renderLimits, /if \(holdResetCreditsTooltipRender \|\| holdCodexSwitchPopoverRender\) \{/);
  assert.match(renderLimits, /if \(holdResetCreditsTooltipRender\) state\.resetCreditsTooltipRenderPending = true;/);
  assert.match(renderLimits, /return;/);
  assert.match(styles, /\.limit-reset-credits\s*\{[^}]*font-size: 9px;/s);
  assert.match(styles, /\.limit-reset-credits-line\s*\{[^}]*justify-content: space-between;/s);
  assert.match(styles, /\.limit-reset-credits-info-wrap\s*\{[^}]*position: relative;/s);
  assert.match(styles, /\.limit-reset-credits-info-wrap\s*\{[^}]*width: 14px;/s);
  assert.match(styles, /\.limit-reset-credits-info\s*\{[^}]*width: 10px;/s);
  assert.match(styles, /\.limit-reset-credits-info\s*\{[^}]*cursor: default;/s);
  assert.match(styles, /\.limit-reset-credits-info\s*\{[^}]*border-radius: 999px;/s);
  assert.match(styles, /\.limit-reset-credits-tooltip\s*\{[^}]*position: absolute;/s);
  assert.match(styles, /\.limit-reset-credits-tooltip\s*\{[^}]*rgba\(var\(--glass-rgb\), 0\.76\)/s);
  assert.match(styles, /\.limit-reset-credits-info-wrap:hover \.limit-reset-credits-tooltip/s);
  assert.match(styles, /\.limit-reset-credits-info-wrap:focus-within \.limit-reset-credits-tooltip/s);
  assert.match(styles, /\.limit-reset-credits-info-wrap\.has-opened \.limit-reset-credits-tooltip\s*\{[^}]*transition: none;/s);
  assert.doesNotMatch(styles, /\.limit-reset-credits-info:hover \+ \.limit-reset-credits-tooltip/);
  assert.doesNotMatch(styles, /\.limit-reset-credits-details/);
  assert.match(styles, /\.limit-reset-credits-expiry\s*\{[^}]*opacity: 0\.66;/s);
});

test('Home uses explicit billing labels so Copilot Premium and Chat stay distinct', () => {
  const app = readRendererFile('app.js');
  const i18n = readRendererFile('i18n.js');
  const homeLabel = functionBody(app, 'homeLimitWindowLabel', 'renderHomeLimitModule');
  const homeModule = functionBody(app, 'renderHomeLimitModule', 'renderHomeModelModule');
  const valueFormatter = functionBody(app, 'formatHomeLimitWindowValue', 'balanceRemainingWindow');

  assert.match(homeLabel, /if \(window\?\.kind === 'billing'\) \{/);
  assert.match(homeLabel, /const label = String\(window\?\.label \|\| ''\)\.trim\(\);/);
  assert.match(homeLabel, /if \(label\) return label;/);
  assert.match(homeLabel, /billing: 'home\.limit\.billing'/);
  assert.match(homeLabel, /if \(window\?\.kind === 'balance'\) return 'Balance';/);
  assert.match(homeModule, /value\.textContent = window\.value \|\| formatHomeLimitWindowValue\(window, Boolean\(state\.settings\?\.showLimitUsed\)\);/);
  assert.match(valueFormatter, /`\$\{formatMoney\(window\.amount, window\.currency\)\} left`/);
  assert.match(valueFormatter, /`\$\{formatPercent\(percent\)\} \$\{limitModeSuffix\(showUsed\)\}`/);
  assert.doesNotMatch(i18n, /home\.limit\.(balance|leftPercent|leftAmount)/);
});

test('tray bars draw the billing window for a billing-only provider instead of two empty bars', () => {
  // renderBarsIcon used to unconditionally draw session+weekly, painting two
  // empty tracks for a Grok-only selection. It must now branch: session/weekly
  // when present, else the single billing bar on the top track.
  const app = readRendererFile('app.js');
  const renderBarsIcon = functionBody(app, 'renderBarsIcon', 'renderAllSessionsIcon');

  assert.match(renderBarsIcon, /w\.kind === 'billing'/);
  assert.match(renderBarsIcon, /if \(session \|\| weekly\)/);
  assert.match(renderBarsIcon, /} else if \(billing\)/);
  assert.match(renderBarsIcon, /drawBar\(layout\.barsStartY, Number\(billing\.remainingPercent\)\)/);
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
  assert.match(planBody, /const label = String\(provider\?\.accountLabel \|\| ''\)\.trim\(\);/);
});

test('settings provider status waits for stats and refreshes when stats arrive', () => {
  const app = readRendererFile('app.js');
  const renderSettings = functionBody(app, 'renderLimitProviderCheckboxes', 'onToolTrackingToggle');
  const refreshStats = functionBody(app, 'refreshStats', 'publishViewState');
  const statsPush = app.match(/window\.tokenMonitor\.onStatsPush\?\.\(\(payload\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  const settingsPush = app.match(/window\.tokenMonitor\.onSettingsPush\?\.\(\(next\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  const syncSettings = functionBody(app, 'syncSettingsForm', 'enabledClientSet');

  assert.doesNotMatch(renderSettings, /state\.stats \? missingLimitProviderStatus\(\) : 'unavailable'/);
  assert.match(refreshStats, /renderLimitProviderCheckboxes\(\);/);
  assert.match(refreshStats, /applyCodexActiveAccountFromStats\(\);/);
  assert.doesNotMatch(refreshStats, /state\.codexActiveAccount = codexActiveAccountFromStats\(\);/);
  assert.match(statsPush, /applyCodexActiveAccountFromStats\(\);/);
  assert.match(statsPush, /renderLimitProviderCheckboxes\(\);/);
  // Account cards read state.stats, so every path that refreshes stats must
  // re-render them. Grok is automatic and belongs only to the generic provider
  // list, so it must not retain a separate account-card renderer.
  // Settings pushes route through syncSettingsForm (which init() also calls), so
  // the two cards are re-rendered there and
  // onSettingsPush itself does not duplicate the calls.
  for (const fn of ['renderDeepseekStatus', 'renderMinimaxStatus']) {
    assert.match(refreshStats, new RegExp(`${fn}\\(\\);`), `${fn} missing from refreshStats`);
    assert.match(statsPush, new RegExp(`${fn}\\(\\);`), `${fn} missing from onStatsPush`);
    assert.match(syncSettings, new RegExp(`${fn}\\(\\);`), `${fn} missing from syncSettingsForm`);
  }
  for (const provider of ['zai', 'volcengine', 'qoder', 'kimi']) {
    assert.match(refreshStats, new RegExp(`renderExternalProviderStatus\\('${provider}'\\);`), `${provider} missing from refreshStats`);
    assert.match(statsPush, new RegExp(`renderExternalProviderStatus\\('${provider}'\\);`), `${provider} missing from onStatsPush`);
    assert.match(syncSettings, new RegExp(`renderExternalProviderStatus\\('${provider}'\\);`), `${provider} missing from syncSettingsForm`);
  }
  for (const fn of ['renderDeepseekStatus', 'renderMinimaxStatus']) {
    assert.doesNotMatch(settingsPush, new RegExp(`${fn}\\(\\);`), `${fn} should not be duplicated in onSettingsPush (syncSettingsForm covers it)`);
  }
  assert.doesNotMatch(app, /renderGrokStatus|grokAccountLinked|grokAccountExpanded/);
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
  assert.match(rawHelper, /state\.stats\?\.devices/);
  assert.match(rawHelper, /Array\.isArray\(devices\)/);
  assert.match(rawHelper, /device\.deviceId === localId/);
  assert.match(rawHelper, /limits\?\.providers/);
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

test('Accounts summary counts all managed account groups including MiMo', () => {
  const app = readRendererFile('app.js');
  const mimoLinkedBody = functionBody(app, 'mimoAccountLinked', 'renderMimoStatus');
  const summaryBody = functionBody(app, 'settingsSectionSummary', 'renderSettingsSummaries');

  assert.match(mimoLinkedBody, /return \(state\.settings\?\.mimoManagedAccounts \|\| \[\]\)\.length > 0;/);
  assert.match(summaryBody, /const minimaxLinked = minimaxAccountLinked\(\);/);
  assert.match(summaryBody, /const zaiLinked = externalProviderAccountLinked\('zai'\);/);
  assert.match(summaryBody, /const zaiteamLinked = externalProviderAccountLinked\('zaiteam'\);/);
  assert.match(summaryBody, /const volcengineLinked = externalProviderAccountLinked\('volcengine'\);/);
  assert.match(summaryBody, /const qoderLinked = externalProviderAccountLinked\('qoder'\);/);
  assert.match(summaryBody, /const kimiLinked = externalProviderAccountLinked\('kimi'\);/);
  assert.match(summaryBody, /const mimoLinked = mimoAccountLinked\(\);/);
  assert.match(summaryBody, /const copilotLinked = copilotAccountLinked\(\);/);
  assert.match(summaryBody, /\(minimaxLinked \? 1 : 0\)/);
  assert.match(summaryBody, /\(zaiLinked \? 1 : 0\)/);
  assert.match(summaryBody, /\(zaiteamLinked \? 1 : 0\)/);
  assert.match(summaryBody, /\(volcengineLinked \? 1 : 0\)/);
  assert.match(summaryBody, /\(qoderLinked \? 1 : 0\)/);
  assert.match(summaryBody, /\(kimiLinked \? 1 : 0\)/);
  assert.match(summaryBody, /\(mimoLinked \? 1 : 0\)/);
  assert.match(summaryBody, /\(copilotLinked \? 1 : 0\)/);
  assert.match(summaryBody, /total: 12/);
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
  // Local machine is signed into `quality` (App) and only manages the other two.
  // A synced device (9950x3d) is signed into `javis`, so aggregateLimits() picks
  // its live App record for the `javis` row — which sorts first. Reading the
  // aggregate would move the ✓ onto `javis`; the marker must instead track this
  // device's own live login (`quality`).
  const app = readRendererFile('app.js');
  const localProviders = [
    { provider: 'codex', status: 'ok', sourceDetail: 'managed', accountKey: 'sha256:javis', accountEmail: 'javis603@gmail.com' },
    { provider: 'codex', status: 'ok', sourceDetail: 'managed', accountKey: 'sha256:linus', accountEmail: 'linus@gmail.com' },
    { provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'sha256:quality', accountEmail: 'quality@icloud.com' }
  ];
  const remoteJavisLive = { provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'sha256:javis', accountEmail: 'javis603@gmail.com', sourceDeviceId: '9950x3d' };
  const provider = runLocalLiveCodexProvider(app, {
    settings: { deviceId: 'this-mac' },
    stats: {
      devices: [
        { deviceId: 'this-mac', limits: { providers: localProviders } },
        { deviceId: '9950x3d', limits: { providers: [remoteJavisLive] } }
      ],
      limits: { providers: [remoteJavisLive, localProviders[1], localProviders[2]] }
    }
  });

  assert.equal(provider.accountKey, 'sha256:quality');
});

test('no active Codex account when this device is signed out, even if a synced device is live', () => {
  const app = readRendererFile('app.js');
  const remoteLive = { provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'sha256:javis', sourceDeviceId: '9950x3d' };
  const provider = runLocalLiveCodexProvider(app, {
    settings: { deviceId: 'this-mac' },
    stats: {
      devices: [
        { deviceId: 'this-mac', limits: { providers: [{ provider: 'codex', status: 'ok', sourceDetail: 'managed', accountKey: 'sha256:javis' }] } },
        { deviceId: '9950x3d', limits: { providers: [remoteLive] } }
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

test('Z.ai, Volcengine, and Qoder source labels and setup statuses', () => {
  assert.deepEqual(presentation.limitProviderCapabilityTags('zai'), ['Coding Plan', 'API key']);
  assert.deepEqual(presentation.limitProviderCapabilityTags('volcengine'), ['Coding Plan', 'API key']);
  assert.deepEqual(presentation.limitProviderCapabilityTags('qoder'), ['Manual login', 'Web']);
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'zai', source: 'api' }), 'API');
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'volcengine', source: 'api' }), 'API');
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'qoder', source: 'web' }), 'Web');
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
});

test('Kimi capability tags and source label', () => {
  assert.deepEqual(presentation.limitProviderCapabilityTags('kimi'), ['Coding Plan', 'API key']);
  assert.equal(presentation.limitProviderSourceLabel({ provider: 'kimi', source: 'api' }), 'API');
  assert.deepEqual(
    presentation.limitProviderStatusLabel({ provider: 'kimi', status: 'notConfigured' }),
    { label: 'Add API key', tone: 'setup' }
  );
});

test('Kimi usage and limits share the canonical provider id and vendor color', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /\{ id: 'kimi', label: 'Kimi' \}/);
  assert.match(app, /const color = id === 'mimo' \? clientColors\.xiaomi : \(clientColors\[id\] \|\| clientColors\.default\)/);
});
