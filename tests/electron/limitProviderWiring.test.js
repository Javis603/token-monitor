'use strict';

// Characterization tests for the per-provider limits wiring that the registry
// refactor moves into one place. They pin what exists today — the credential
// key set, the settings keys that scope a provider refresh, the env fallbacks,
// the renderer projection, the URL allowlist and the renderer's account config
// — so each extraction commit can prove it changed nothing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { CREDENTIAL_SETTING_PATHS, credentialSettingsForRenderer } = require('../../src/shared/credentialStore');
const { LIMIT_PROVIDER_SETTING_KEYS, limitsConfigFromSettings } = require('../../src/electron/runtimeConfig');
const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limitProviders');
const { isAllowedVerificationUrl } = require('../../src/shared/providers/copilot/deviceFlow');
const { isAllowedCodexLoginUrl } = require('../../src/shared/providers/codex/login');
const { SERVICE_STATUS_PROVIDERS } = require('../../src/electron/serviceStatus');

const ROOT = path.resolve(__dirname, '../..');
const mainSource = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/index.html'), 'utf8');

// Evaluate one top-level declaration out of a classic script file. `from` and
// `to` are literal markers: the slice runs from `from` to just before `to`.
// A `const name = <expr>` slice is returned as just the expression.
function evalTopLevel(source, from, to, sandbox = {}) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `${from} should exist`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `${to} should follow ${from}`);
  let code = source.slice(start, end).trim().replace(/;$/, '');
  code = code.replace(/^(?:const|let|var)\s+[\w$]+\s*=\s*/, 'return ').replace(/^function\s+[\w$]+/, 'return function');
  return vm.runInNewContext(`(function () { ${code} })()`, sandbox);
}

test('CREDENTIAL_SETTING_PATHS is exactly this set (the store is default-deny)', () => {
  assert.deepEqual(CREDENTIAL_SETTING_PATHS, {
    hubHostSecret: ['hub', 'hostSecret'],
    secret: ['hub', 'clientSecret'],
    claudeWebCookie: ['providers', 'claude', 'webCookie'],
    opencodeCookie: ['providers', 'opencode', 'cookie'],
    opencodeProfiles: ['providers', 'opencode', 'profiles'],
    clineApiKey: ['providers', 'cline', 'apiKey'],
    factoryApiKey: ['providers', 'factory', 'apiKey'],
    kimiApiKey: ['providers', 'kimi', 'apiKey'],
    kimiWebAccessToken: ['providers', 'kimi', 'webAccessToken'],
    copilotApiToken: ['providers', 'copilot', 'apiToken'],
    zedCookie: ['providers', 'zed', 'cookie'],
    typesafeCookie: ['providers', 'typesafe', 'cookie'],
    commandcodeCookie: ['providers', 'commandcode', 'cookie'],
    zaiApiKey: ['providers', 'zai', 'apiKey'],
    zaiTeamApiKey: ['providers', 'zaiTeam', 'apiKey'],
    zaiTeamOrganizationId: ['providers', 'zaiTeam', 'organizationId'],
    zaiTeamProjectId: ['providers', 'zaiTeam', 'projectId'],
    qoderCookie: ['providers', 'qoder', 'cookie'],
    devinBearerToken: ['providers', 'devin', 'bearerToken'],
    deepseekApiKey: ['providers', 'deepseek', 'apiKey'],
    openrouterProfiles: ['providers', 'openrouter', 'profiles'],
    minimaxApiKey: ['providers', 'minimax', 'apiKey'],
    volcengineAccessKeyId: ['providers', 'volcengine', 'accessKeyId'],
    volcengineSecretAccessKey: ['providers', 'volcengine', 'secretAccessKey'],
    volcengineAgentAccessKeyId: ['providers', 'volcengine', 'agentAccessKeyId'],
    volcengineAgentSecretAccessKey: ['providers', 'volcengine', 'agentSecretAccessKey'],
    ollamaCookie: ['providers', 'ollama', 'cookie'],
    traeAccessToken: ['providers', 'trae', 'accessToken'],
    traeDeviceId: ['providers', 'trae', 'deviceId'],
    alibabaCookie: ['providers', 'alibaba', 'cookie'],
    thirdPartyProfiles: ['providers', 'thirdparty', 'profiles']
  });
});

test('every provider credential path lives under providers/<id>', () => {
  for (const [key, segments] of Object.entries(CREDENTIAL_SETTING_PATHS)) {
    if (key === 'hubHostSecret' || key === 'secret') continue;
    assert.equal(segments[0], 'providers', key);
    assert.equal(segments.length, 3, key);
  }
});

test('the renderer receives no credential values except the two hub secrets', () => {
  const settings = Object.fromEntries(Object.keys(CREDENTIAL_SETTING_PATHS).map((key) => [key, { secret: 'x' }]));
  const redacted = credentialSettingsForRenderer(settings, { expose: ['hubHostSecret', 'secret'] });
  for (const key of Object.keys(CREDENTIAL_SETTING_PATHS)) {
    if (key === 'hubHostSecret' || key === 'secret') assert.deepEqual(redacted[key], { secret: 'x' });
    else assert.equal(redacted[key], '', key);
  }
  // main.js is the only caller; pin that it exposes exactly those two keys.
  assert.match(mainSource, /credentialSettingsForRenderer\(settings, \{\s*expose: \['hubHostSecret', 'secret'\]\s*\}\)/);
});

test('LIMIT_PROVIDER_SETTING_KEYS is exactly this set (drives per-provider refresh scopes)', () => {
  assert.deepEqual(LIMIT_PROVIDER_SETTING_KEYS, {
    claude: ['claudeWebCookie'],
    codex: ['codexManagedAccounts'],
    opencode: ['opencodeCookie', 'opencodeProfiles', 'opencodeLocalLimitsEnabled'],
    cursor: ['cursorDisabledAccountIds'],
    cline: ['clineApiKey'],
    factory: ['factoryApiKey'],
    kimi: ['kimiApiKey', 'kimiWebAccessToken'],
    copilot: ['copilotApiToken', 'copilotEnterpriseHost'],
    zed: ['zedCookie'],
    commandcode: ['commandcodeCookie'],
    mimo: ['mimoManagedAccounts'],
    zai: ['zaiApiKey', 'zaiApiRegion'],
    zaiteam: ['zaiTeamApiKey', 'zaiTeamOrganizationId', 'zaiTeamProjectId'],
    workbuddy: ['workbuddyAccessToken', 'workbuddyUserId', 'workbuddyEnterpriseId', 'workbuddyLocale', 'workbuddyDomain', 'workbuddyDepartmentInfo'],
    qoder: ['qoderCookie', 'qoderSite'],
    deepseek: ['deepseekApiKey'],
    devin: ['devinBearerToken', 'devinOrganization'],
    typesafe: ['typesafeCookie'],
    openrouter: ['openrouterProfiles'],
    minimax: ['minimaxApiKey'],
    volcengine: [
      'volcengineAccessKeyId', 'volcengineSecretAccessKey', 'volcengineRegion',
      'volcengineAgentAccessKeyId', 'volcengineAgentSecretAccessKey', 'volcengineAgentRegion'
    ],
    ollama: ['ollamaCookie'],
    trae: ['traeAccessToken', 'traeDeviceId'],
    alibaba: ['alibabaCookie', 'alibabaVariant'],
    thirdparty: ['thirdPartyProfiles']
  });
  for (const provider of Object.keys(LIMIT_PROVIDER_SETTING_KEYS)) {
    assert.ok(LIMIT_PROVIDER_IDS.includes(provider), `${provider} is a catalog id`);
  }
});

test('limitsConfigFromSettings env fallbacks and precedence', () => {
  const env = {
    CLAUDE_WEB_COOKIE: 'env-claude',
    TOKEN_MONITOR_OPENCODE_COOKIE: 'env-opencode',
    TOKEN_MONITOR_TRAE_ACCESS_TOKEN: 'env-trae-tok',
    TRAE_ACCESS_TOKEN: 'env-trae-legacy',
    TOKEN_MONITOR_TRAE_DEVICE_ID: 'env-trae-dev',
    TOKEN_MONITOR_ZED_COOKIE: 'env-zed-tm',
    TOKEN_MONITOR_TYPESAFE_COOKIE: 'env-typesafe-tm',
    TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN: 'env-wb-tok',
    WORKBUDDY_ACCESS_TOKEN: 'env-wb-legacy',
    TOKEN_MONITOR_WORKBUDDY_DOMAIN: 'env-wb-domain'
  };
  const config = limitsConfigFromSettings({}, { env });
  assert.equal(config.claudeWebCookie, 'env-claude');
  assert.equal(config.opencodeCookie, 'env-opencode');
  assert.equal(config.traeAccessToken, 'env-trae-tok');
  assert.equal(config.traeDeviceId, 'env-trae-dev');
  assert.equal(config.zedCookie, 'env-zed-tm');
  assert.equal(config.typesafeCookie, 'env-typesafe-tm');
  assert.equal(config.workbuddyAccessToken, 'env-wb-tok');
  assert.equal(config.workbuddyDomain, 'env-wb-domain');
  // Legacy bare env names fill in when the prefixed one is absent.
  const legacyOnly = limitsConfigFromSettings({}, {
    env: { TRAE_ACCESS_TOKEN: 'legacy-trae', ZED_COOKIE: 'legacy-zed', TYPESAFE_COOKIE: 'legacy-typesafe', WORKBUDDY_ACCESS_TOKEN: 'legacy-wb' }
  });
  assert.equal(legacyOnly.traeAccessToken, 'legacy-trae');
  assert.equal(legacyOnly.zedCookie, 'legacy-zed');
  assert.equal(legacyOnly.typesafeCookie, 'legacy-typesafe');
  assert.equal(legacyOnly.workbuddyAccessToken, 'legacy-wb');
  // Settings win over env.
  const settingsWin = limitsConfigFromSettings(
    { claudeWebCookie: 'settings-claude', zedCookie: 'settings-zed' },
    { env }
  );
  assert.equal(settingsWin.claudeWebCookie, 'settings-claude');
  assert.equal(settingsWin.zedCookie, 'settings-zed');
  // Fields with no env lane read settings only.
  const noEnv = limitsConfigFromSettings({}, { env });
  for (const key of ['deepseekApiKey', 'minimaxApiKey', 'copilotApiToken', 'factoryApiKey', 'zaiApiKey', 'kimiApiKey', 'ollamaCookie', 'commandcodeCookie', 'alibabaCookie', 'qoderCookie', 'devinBearerToken']) {
    assert.equal(noEnv[key], '', key);
  }
  // Non-credential defaults.
  assert.equal(config.zaiApiRegion, 'global');
  assert.equal(config.qoderSite, 'global');
  assert.equal(config.limitsEnabled, true);
  assert.equal(config.limitsRefreshMs, 300000);
  assert.equal(config.opencodeLocalLimitsEnabled, false);
  assert.equal(config.opencodeAmbientEnabled, true);
  assert.equal(config.claudePrepaidBalanceEnabled, true);
});

test('desktop WorkBuddy ignores env and settings tokens and reads the app session', () => {
  const config = limitsConfigFromSettings(
    { workbuddyAccessToken: 'stored', workbuddyDomain: 'stored.cn' },
    {
      env: { TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN: 'env-tok' },
      workbuddyDesktopSessionOnly: true,
      workbuddyDesktopSessionEnabled: true,
      workbuddyLocalSession: { userId: 'u1', enterpriseId: 'e1', domain: 'session.cn', departmentInfo: 'd', accountType: 'enterprise' }
    }
  );
  assert.equal(config.workbuddyAccessToken, '');
  assert.equal(config.workbuddyDomain, 'session.cn');
  assert.equal(config.workbuddyUserId, 'u1');
  assert.equal(config.workbuddyEnterpriseId, 'e1');
  assert.equal(config.workbuddyAccountType, 'enterprise');
});

test('settings:update normalizes every provider field and never persists these keys', () => {
  // The normalizer each patch key goes through inside the settings:update
  // handler. Pinning name-by-name catches a key silently losing its normalize.
  const normalizers = {
    claudeWebCookie: 'normalizeClaudeWebCookie',
    deepseekApiKey: 'normalizeDeepSeekApiKey',
    minimaxApiKey: 'normalizeMinimaxApiKey',
    copilotApiToken: 'normalizeCopilotApiToken',
    copilotEnterpriseHost: 'normalizeCopilotEnterpriseHost',
    factoryApiKey: 'normalizeFactoryApiKey',
    clineApiKey: 'normalizeClineApiKey',
    zaiApiKey: 'normalizeZaiApiKey',
    zaiApiRegion: 'normalizeZaiApiRegion',
    zaiTeamApiKey: 'normalizeZaiTeamApiKey',
    zaiTeamOrganizationId: 'normalizeZaiTeamId',
    zaiTeamProjectId: 'normalizeZaiTeamId',
    volcengineAccessKeyId: 'normalizeSecretSetting',
    volcengineSecretAccessKey: 'normalizeSecretSetting',
    volcengineRegion: 'normalizeVolcengineRegion',
    volcengineAgentAccessKeyId: 'normalizeSecretSetting',
    volcengineAgentSecretAccessKey: 'normalizeSecretSetting',
    volcengineAgentRegion: 'normalizeVolcengineRegion',
    qoderCookie: 'normalizeQoderCookie',
    qoderSite: 'normalizeQoderSite',
    devinBearerToken: 'normalizeDevinBearerToken',
    devinOrganization: 'normalizeDevinOrganization',
    alibabaCookie: 'normalizeAlibabaCookie',
    alibabaVariant: 'normalizeAlibabaVariant',
    traeAccessToken: 'normalizeTraeAccessToken',
    traeDeviceId: 'normalizeTraeDeviceId',
    zedCookie: 'normalizeZedCookie',
    typesafeCookie: 'normalizeTypesafeCookie',
    commandcodeCookie: 'normalizeCommandcodeCookie',
    kimiApiKey: 'normalizeKimiApiKey',
    kimiWebAccessToken: 'normalizeKimiWebAccessToken',
    ollamaCookie: 'normalizeOllamaCookie'
  };
  // Fields whose stored value is re-normalized on read rather than trusted.
  const fallbackNormalizers = { zaiApiRegion: 'normalizeZaiApiRegion', qoderSite: 'normalizeQoderSite' };
  // The kimi keys have no explicit line in the final settings object; they reach
  // it through the normalizedPatch spread, which the step assertion covers.
  const spreadOnly = new Set(['kimiApiKey', 'kimiWebAccessToken']);
  const handlerStart = mainSource.indexOf("ipcMain.handle('settings:update'");
  const handlerEnd = mainSource.indexOf('ipcMain.handle(', handlerStart + 10);
  const handler = mainSource.slice(handlerStart, handlerEnd);
  for (const [key, normalizer] of Object.entries(normalizers)) {
    const step = new RegExp(`if \\(patch\\.${key} !== undefined\\) normalizedPatch\\.${key} = ${normalizer}\\(patch\\.${key}\\)`);
    assert.match(handler, step, `${key} normalized in normalizedPatch`);
    if (spreadOnly.has(key)) continue;
    const fallback = fallbackNormalizers[key]
      ? `${fallbackNormalizers[key]}\\(settings\\.${key} \\|\\| 'global'\\)`
      : `\\(settings\\.${key} \\|\\| ''\\)`;
    const final = new RegExp(`${key}: patch\\.${key} !== undefined\\s*\\?\\s*${normalizer}\\(patch\\.${key}\\)\\s*:\\s*${fallback}`);
    assert.match(handler, final, `${key} normalized in final settings object`);
  }
  // These keys are managed elsewhere and must never survive the patch spread.
  for (const key of [
    'codexManagedAccounts', 'antigravityManagedAccounts', 'mimoManagedAccounts',
    'workbuddyAccessToken', 'workbuddyUserId', 'workbuddyEnterpriseId',
    'workbuddyEndpoint', 'workbuddyLocale', 'workbuddyDomain', 'workbuddyDepartmentInfo',
    'workbuddyLocalAppEnabled', 'openrouterProfiles', 'thirdPartyProfiles',
    'subscriptions', 'subscriptionsOrphaned', 'subscriptionsCacheHub',
    'subscriptionsShared', 'subscriptionsHub', 'subscriptionsUpdatedAt'
  ]) {
    assert.match(handler, new RegExp(`delete normalizedPatch\\.${key};`), `${key} stripped from the patch`);
  }
});

test('the external URL allowlist admits exactly the provider consoles it should', () => {
  const isAllowedExternalUrl = evalTopLevel(
    mainSource,
    'function isAllowedExternalUrl(',
    '\nfunction revealWindow(',
    {
      URL,
      settings: { copilotEnterpriseHost: '' },
      process: { env: {} },
      isAllowedVerificationUrl,
      isAllowedCodexLoginUrl,
      STATUS_PAGE_HOSTS: new Set(SERVICE_STATUS_PROVIDERS.map((provider) => new URL(provider.pageUrl).hostname))
    }
  );
  const allowed = [
    'https://claude.ai/settings',
    'https://claude.ai/settings/billing',
    'https://cursor.com/settings',
    'https://www.cursor.com/settings',
    'https://opencode.ai/',
    'https://www.opencode.ai/auth',
    'https://openrouter.ai/settings/keys',
    'https://platform.deepseek.com/api_keys',
    'https://app.devin.ai/settings/usage',
    'https://platform.minimaxi.com/',
    'https://platform.minimax.io/user-center/basic-information/interface-key',
    'https://app.factory.ai/settings/api-keys',
    'https://app.cline.bot/dashboard',
    'https://z.ai/',
    'https://www.z.ai/billing',
    'https://bigmodel.cn/',
    'https://www.volcengine.com/',
    'https://console.volcengine.com/ark',
    'https://qoder.com/',
    'https://www.qoder.com.cn/console',
    'https://trae.cn/',
    'https://www.trae.cn/console',
    'https://commandcode.ai/',
    'https://dashboard.zed.dev/',
    'https://console.typesafe.ai/settings/billing',
    'https://ollama.com/settings',
    'https://www.ollama.com/signin',
    'https://kimi.com/code',
    'https://www.kimi.com/code/console',
    'https://bailian.console.aliyun.com/cn-beijing',
    'https://modelstudio.console.alibabacloud.com/ap-southeast-1',
    'https://codex-resets.com/',
    'https://status.claude.com/',
    'https://status.openai.com/',
    'https://status.cursor.com/',
    'https://status.deepseek.com/',
    'https://github.com/junhoyeo/tokscale',
    'https://github.com/Javis603/token-monitor/releases',
    'https://www.npmjs.com/package/@tokscale/cli',
    'https://javis-ai.com/token-monitor',
    'https://www.javis-ai.com/token-monitor/'
  ];
  for (const url of allowed) assert.equal(isAllowedExternalUrl(url), true, url);
  const denied = [
    'https://claude.ai/',
    'https://claude.ai/login',
    'https://cursor.com/',
    'https://openrouter.ai/',
    'https://openrouter.ai/settings',
    'https://platform.deepseek.com/',
    'https://app.devin.ai/',
    'https://app.devin.ai/settings',
    'https://app.factory.ai/',
    'https://app.cline.bot/',
    'https://console.typesafe.ai/',
    'https://console.typesafe.ai/settings',
    'https://ollama.com/',
    'https://kimi.com/',
    'https://bailian.console.aliyun.com/',
    'https://bailian.console.aliyun.com/us-west-1',
    'https://status.claude.com/incidents',
    'https://codex-resets.com/path',
    'https://github.com/junhoyeo',
    'https://github.com/Javis603/other-repo',
    'https://javis-ai.com/',
    'http://claude.ai/settings',
    'https://evil-claude.ai/settings',
    'https://claude.ai.evil.com/settings',
    'not a url',
    ''
  ];
  for (const url of denied) assert.equal(isAllowedExternalUrl(url), false, url);
});

test('the renderer account config names the settings keys main must project', () => {
  const config = evalTopLevel(appSource, 'const externalLimitAccountConfig = {', '\nfunction clearDisabledLimitProviderPendingChecks(');
  assert.deepEqual(Object.keys(config).sort(), [
    'alibaba', 'claude', 'cline', 'commandcode', 'devin', 'factory', 'kimi',
    'ollama', 'qoder', 'trae', 'typesafe', 'volcengine', 'zai', 'zaiteam', 'zed'
  ].sort());
  for (const [provider, entry] of Object.entries(config)) {
    assert.deepEqual(Object.keys(entry).sort(), ['configuredKey', 'pendingKey', 'sourceKey'], provider);
    // Every configured/source pair the renderer reads must exist in
    // settingsForRenderer()'s projection, either as `key: value` or shorthand.
    for (const key of [entry.configuredKey, entry.sourceKey]) {
      assert.match(mainSource, new RegExp(`\\b${key}[:,]`), `${provider}.${key} projected`);
    }
  }
});

test('renderExternalProviderStatus runs for exactly the account-config providers, in both call sites', () => {
  const calls = [...appSource.matchAll(/renderExternalProviderStatus\('([a-z]+)'\)/g)].map((match) => match[1]);
  const config = evalTopLevel(appSource, 'const externalLimitAccountConfig = {', '\nfunction clearDisabledLimitProviderPendingChecks(');
  const expected = Object.keys(config).sort();
  // The two refresh loops each render every configured provider; every other
  // call lives inside that provider's own setup block.
  const firstLoop = calls.slice(0, expected.length).sort();
  const secondLoop = calls.slice(expected.length, expected.length * 2).sort();
  assert.deepEqual(firstLoop, expected);
  assert.deepEqual(secondLoop, expected);
  const setupCalls = calls.slice(expected.length * 2);
  for (const provider of expected) {
    assert.ok(setupCalls.includes(provider), `${provider} is re-rendered by its own wiring`);
  }
});

test('every provider with an account panel has its group and status markup in index.html', () => {
  const groupIds = evalTopLevel(appSource, 'const LIMIT_PROVIDER_ACCOUNT_GROUP_IDS = {', '\nconst LIMIT_PROVIDER_ACCOUNT_STATUS_IDS');
  // Not every catalog provider has a panel (grok, kiro and workbuddy take their
  // credentials from the tool itself); the map is the list of those that do.
  assert.deepEqual(
    LIMIT_PROVIDER_IDS.filter((provider) => !groupIds[provider]).sort(),
    ['grok', 'kiro', 'workbuddy']
  );
  for (const [provider, id] of Object.entries(groupIds)) {
    assert.ok(LIMIT_PROVIDER_IDS.includes(provider), `${provider} is a catalog id`);
    assert.match(indexHtml, new RegExp(`id="${id}"`), `${provider} group exists in index.html`);
  }
  // The two id maps cover the same providers.
  const statusIds = evalTopLevel(appSource, 'const LIMIT_PROVIDER_ACCOUNT_STATUS_IDS = {', '\nconst LIMIT_PROVIDER_CONNECTION_DETAIL_KEYS');
  assert.deepEqual(Object.keys(statusIds).sort(), Object.keys(groupIds).sort());
  for (const [provider, id] of Object.entries(statusIds)) {
    assert.match(indexHtml, new RegExp(`id="${id}"`), `${provider} status pill exists in index.html`);
  }
});
