'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const { VENDOR_LABELS, VENDOR_ORDER } = require('../../src/electron/renderer/themePresets');

test('third-party settings separate presets, scope, and safe custom mappings', () => {
  const html = read('src/electron/renderer/index.html');
  const app = read('src/electron/renderer/app.js');
  const preload = read('src/electron/preload.js');

  assert.match(html, /id="thirdpartyAccountGroup"/);
  assert.match(html, /id="thirdpartyProfileList"/);
  assert.match(html, /<label for="thirdpartyPlatformInput"[^>]*data-i18n="settings\.thirdparty\.preset"/);
  assert.match(html, /<select id="thirdpartyPlatformInput">[\s\S]*?<option value="newapi"[^>]*>[\s\S]*?<option value="custom"/);
  assert.match(html, /<label for="thirdpartyModeInput"[^>]*data-i18n="settings\.thirdparty\.scope"/);
  assert.match(html, /<select id="thirdpartyModeInput">[\s\S]*?<option value="account"[^>]*>[\s\S]*?<option value="token"/);
  assert.match(html, /class="thirdparty-choice-grid"/);
  assert.match(html, /id="thirdpartyModeHint"/);
  assert.match(html, /<label for="thirdpartyBaseUrlInput"[^>]*data-i18n="settings\.thirdparty\.baseUrl"/);
  assert.match(html, /<input id="thirdpartyBaseUrlInput" type="url"/);
  assert.match(html, /id="thirdpartyHttpWarning"[^>]*role="status"[^>]*data-i18n="settings\.thirdparty\.httpWarning"/);
  assert.match(html, /<input id="thirdpartyAccessTokenInput" type="password"/);
  assert.match(html, /<input id="thirdpartyUserIdInput" type="text"/);
  assert.match(html, /data-i18n="settings\.thirdparty\.userId">User ID \(New API only\)/);
  assert.match(html, /<div id="thirdpartyApiKeyRow" class="thirdparty-field hidden">[\s\S]*?<input id="thirdpartyApiKeyInput" type="password"/);
  assert.match(html, /id="thirdpartyCustomConfig" class="thirdparty-custom-config hidden"/);
  assert.match(html, /id="thirdpartyEndpointPathInput"/);
  assert.match(html, /id="thirdpartyAuthModeInput"[\s\S]*?<option value="bearer"[\s\S]*?<option value="x-api-key"/);
  assert.match(html, /id="thirdpartyRemainingPathInput"/);
  assert.match(html, /id="thirdpartyUsedPathInput"/);
  assert.match(html, /id="thirdpartyTotalPathInput"/);
  assert.match(html, /id="thirdpartyCurrencyInput"/);
  assert.match(html, /id="thirdpartyDivisorInput"/);
  assert.match(app, /function setThirdPartyAdapterFields/);
  assert.match(app, /function selectedThirdPartyAdapter/);
  assert.match(app, /if \(platform === 'custom'\) return 'custom'/);
  assert.match(app, /thirdpartyCustomConfig[\s\S]*?classList\.toggle\('hidden', !customMode\)/);
  assert.match(app, /thirdpartyCredentialGrid[\s\S]*?classList\.toggle\([\s\S]*?'single-field'/);
  assert.match(app, /baseUrlInput\?\.addEventListener\('input', updateThirdPartyHttpWarning\)/);
  assert.match(app, /new URL\(String\(input\?\.value \|\| ''\)\.trim\(\)\)\.protocol === 'http:'/);
  assert.match(read('src/electron/renderer/styles.css'), /\.thirdparty-choice-grid\.single-field,[\s\S]*?\.thirdparty-credential-grid\.single-field \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(preload, /saveProfile: \(profile\) => ipcRenderer\.invoke\('thirdparty:saveProfile', profile\)/);
});

test('third-party credentials stay local while renderer metadata is redacted', () => {
  const credentials = read('src/shared/credentialStore.js');
  const main = read('src/electron/main.js');

  assert.match(credentials, /thirdPartyProfiles: \['providers', 'thirdparty', 'profiles'\]/);
  assert.match(main, /function redactThirdPartyProfilesForRenderer/);
  assert.match(main, /function redactThirdPartyProfilesForRenderer[\s\S]*?const out = Object\.create\(null\)/);
  assert.match(main, /const adapter = thirdPartyLimits\.normalizeAdapterId\(profile\?\.adapter\)/);
  assert.match(main, /baseUrl: thirdPartyLimits\.normalizeThirdPartyBaseUrl\(profile\?\.baseUrl, \{/);
  assert.match(main, /accessToken: profile\?\.accessToken \? 'set' : ''/);
  assert.match(main, /apiKey: profile\?\.apiKey \? 'set' : ''/);
  assert.match(main, /endpointPath: thirdPartyLimits\.normalizeCustomEndpointPath\(profile\?\.endpointPath\)/);
  assert.match(main, /remainingPath: thirdPartyLimits\.normalizeCustomJsonPath\(profile\?\.remainingPath\)/);
  assert.match(main, /delete normalizedPatch\.thirdPartyProfiles/);
  assert.match(main, /ipcMain\.handle\('thirdparty:saveProfile'/);
  assert.match(main, /ipcMain\.handle\('thirdparty:deleteProfile'/);
  assert.match(main, /ipcMain\.handle\('thirdparty:renameProfile'/);
  assert.match(main, /ipcMain\.handle\('thirdparty:setProfileEnabled'/);
  assert.match(main, /thirdPartyLimits\.fetchThirdPartyAccount\(\{ name, \.\.\.profile \}/);
  assert.match(main, /thirdPartyLimits\.CUSTOM_BALANCE_ADAPTER/);
  assert.doesNotMatch(main, /DEFAULT_THIRD_PARTY_ADAPTER/);
  assert.doesNotMatch(main, /ONEAPI_ACCOUNT_ADAPTER/);
  assert.doesNotMatch(main, /errorCode: 'missingUserId'/);
});

test('third-party profile rows share the named-account component with OpenRouter', () => {
  const app = read('src/electron/renderer/app.js');
  assert.match(app, /function appendNamedApiProfileRow/);
  assert.match(app, /info\.dataset\.managedProfileProvider = providerId/);
  assert.match(app, /info\.dataset\.managedProfileName = name/);
  assert.match(app, /info\.dataset\.managedProfileEnvironment = 'true'/);
  assert.match(app, /providerId: 'openrouter',[\s\S]*?rerender: renderOpenRouterProfiles/);
  assert.match(app, /providerId: 'thirdparty',[\s\S]*?rerender: renderThirdPartyProfiles/);
  assert.match(app, /t\('settings\.profiles\.rename'\)/);
  assert.match(app, /t\('settings\.profiles\.delete'\)/);
});

test('third-party Limits presentation uses compact scope labels and a details tooltip', () => {
  const app = read('src/electron/renderer/app.js');
  const i18n = read('src/electron/renderer/i18n.js');
  const presentation = read('src/electron/renderer/limitProviderPresentation.js');
  const balanceDisplay = read('src/shared/limitBalanceDisplay.js');
  const styles = read('src/electron/renderer/styles.css');
  const colors = read('src/electron/renderer/usageCharts.js');

  assert.match(app, /\{ id: 'thirdparty', label: 'Third-party APIs' \}/);
  assert.match(app, /provider\.provider === 'thirdparty'/);
  assert.match(app, /function thirdPartyQuotaWindow/);
  assert.match(app, /quotaWindow\?\.label \|\| 'Balance'/);
  assert.match(app, /function thirdPartyPlanText/);
  assert.match(app, /if \(provider\?\.status !== 'ok'\) return undefined/);
  assert.match(app, /if \(planLabel === 'account'\) return 'Account'/);
  assert.match(app, /if \(planLabel === 'api key'\) return 'API key'/);
  assert.match(app, /if \(planLabel === 'custom'\) return 'Custom'/);
  assert.doesNotMatch(app, /planLabel\.includes\('token'\) \|\| quotaLabel\.includes\('token'\)/);
  assert.match(app, /function thirdPartySpendNode/);
  assert.match(app, /balance\?\.requestCount/);
  assert.match(app, /settings\.thirdparty\.requests/);
  assert.match(app, /if \(allTimeSpend === null && entries\.length === 0\) return null/);
  assert.match(app, /const summary = allTimeSpend === null \? '' : `All time \$\{formatMoney\(allTimeSpend, currency\)\}`/);
  assert.match(app, /label: allTimeSpend === null \? 'Details' : 'Spend'/);
  assert.match(balanceDisplay, /return symbol \? `\$\{symbol\}\$\{number\.toFixed\(2\)\}` : `\$\{code\} \$\{number\.toFixed\(2\)\}`/);
  assert.match(app, /`All time \$\{formatMoney\(allTimeSpend, currency\)\}`/);
  assert.match(app, /function renderNamedApiAccountGroup[\s\S]*?planText: options\.groupPlanText/);
  assert.match(app, /groupPlanText: t\('settings\.openrouter\.nAccounts', \{ count: providers\.length \}\)/);
  assert.match(app, /groupPlanText: t\('settings\.thirdparty\.nAccounts', \{ count: providers\.length \}\)/);
  assert.doesNotMatch(i18n, /settings\.thirdparty\.(?:spend|allTime)/);
  assert.match(app, /limitDetailInfoNode\(detailEntries, 'limit-spend-info-wrap'\)/);
  assert.match(app, /function renderThirdPartyAccountGroup/);
  assert.match(app, /renderNamedApiAccountGroup\('thirdparty'/);
  assert.match(presentation, /thirdparty: \['Relay', 'API'\]/);
  assert.match(styles, /\.limit-icon-thirdparty/);
  assert.match(colors, /thirdparty: '#DD2E57'/);
});

test('third-party money formatting preserves supported custom units', () => {
  const { formatMoney, formatCompactMoney } = require('../../src/shared/limitBalanceDisplay');
  assert.deepEqual([
    formatMoney(12.5, 'USD'),
    formatMoney(12.5, 'USDT'),
    formatMoney(12.5, 'POINTS'),
    formatMoney(12.5, 'US$'),
    formatCompactMoney(1_250_000, 'USDT')
  ], [
    '$12.50',
    'USDT 12.50',
    'POINTS 12.50',
    '$12.50',
    'USDT 1.25M'
  ]);
});

test('third-party scope labels do not infer adapters from display text', () => {
  const app = read('src/electron/renderer/app.js');
  const start = app.indexOf('function thirdPartyPlanText');
  const end = app.indexOf('function renderNamedApiAccountGroup', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = app.slice(start, end);
  const result = vm.runInNewContext(
    `${source}
    JSON.stringify([
      thirdPartyPlanText({ status: 'ok', planLabel: 'Account' }),
      thirdPartyPlanText({ status: 'ok', planLabel: 'API key' }),
      thirdPartyPlanText({ status: 'ok', planLabel: 'Custom' }),
      thirdPartyPlanText({ status: 'ok', planLabel: 'Token deluxe' }) ?? null,
      thirdPartyPlanText({ status: 'unavailable', planLabel: 'Account' }) ?? null
    ]);`
  );
  assert.deepEqual(JSON.parse(result), ['Account', 'API key', 'Custom', null, null]);
});

test('third-party profile rows keep metadata on line two and rename on line one', () => {
  const html = read('src/electron/renderer/index.html');
  const styles = read('src/electron/renderer/styles.css');
  const app = read('src/electron/renderer/app.js');

  assert.match(html, /id="thirdpartyProfileList" class="opencode-profile-list thirdparty-profile-list"/);
  assert.match(app, /if \(detail\) \{[\s\S]*?detailSpan\.className = 'profile-detail'/);
  assert.match(styles, /grid-template-columns: minmax\(0, max-content\) auto minmax\(0, 1fr\);/);
  assert.match(styles, /grid-template-areas:\s*"name rename \."\s*"detail detail detail";/);
  assert.match(styles, /\.opencode-profile-item \.profile-name \{[\s\S]*?grid-area: name;/);
  assert.match(styles, /\.opencode-profile-item \.profile-detail \{[\s\S]*?grid-area: detail;/);
  assert.match(styles, /\.opencode-profile-item \.profile-name-input \{[\s\S]*?grid-area: name;/);
  assert.match(styles, /\.opencode-profile-item \.profile-rename-btn \{[\s\S]*?grid-area: rename;/);
  assert.doesNotMatch(styles, /\.thirdparty-profile-list \.opencode-profile-item/);
  assert.doesNotMatch(styles, /\.thirdparty-profile-list \.profile-right/);
  assert.match(styles, /\.thirdparty-choice-grid,[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.thirdparty-field \{[\s\S]*?display: grid;/);
  assert.match(app, /new URL\(String\(profile\?\.baseUrl \|\| ''\)\)\.host/);
  assert.match(app, /settings\.thirdparty\.detailCustom/);
  assert.match(app, /formatCompactMoney,?[\s\S]{0,120}?\} = window\.TokenMonitorLimitBalanceDisplay/);
  assert.match(app, /formatCompactMoney\(balance, provider\.balance\?\.currency \|\| 'USD'\)/);
});

test('third-party status settles after refresh and pushed stats', () => {
  const app = read('src/electron/renderer/app.js');
  const refreshStats = app.slice(
    app.indexOf('async function refreshStats(options = {})'),
    app.indexOf('async function refreshStatusViewManually()')
  );
  const statsRender = app.slice(
    app.indexOf('function renderStatsUpdate()'),
    app.indexOf('const statsRenderScheduler =')
  );
  const statsPush = app.slice(
    app.indexOf('window.tokenMonitor.onStatsPush?.((payload) => {'),
    app.indexOf('window.tokenMonitor.onSnapshotPush?.((payload) => {')
  );

  assert.match(refreshStats, /statsRenderScheduler\.request\(\);/);
  assert.match(statsRender, /updateThirdPartyProfilesStatus\(\);/);
  assert.match(statsPush, /statsRenderScheduler\.request\(\);/);
  assert.match(app, /function updateThirdPartyProfilesStatus/);
  assert.match(app, /function thirdPartyProfileStatusText/);
  assert.match(app, /settings\.thirdparty\.unlimited/);
});

test('third-party provider identity stays English while account labels remain localized', () => {
  const i18n = read('src/electron/renderer/i18n.js');
  assert.match(i18n, /'settings\.thirdparty\.title': 'Third-party API Accounts'/);
  assert.match(i18n, /'settings\.thirdparty\.title': 'Third-party APIs 帳號'/);
  assert.match(i18n, /'settings\.thirdparty\.title': 'Third-party APIs 账号'/);
  assert.match(i18n, /'settings\.thirdparty\.title': 'Third-party APIs 계정'/);
  assert.match(i18n, /'settings\.thirdparty\.title': 'Third-party APIsアカウント'/);
});

test('third-party fallback stays last after named providers across product surfaces', () => {
  const html = read('src/electron/renderer/index.html');
  assert.ok(html.indexOf('id="thirdpartyAccountGroup"') > html.indexOf('id="copilotAccountGroup"'));

  const app = read('src/electron/renderer/app.js');
  const providerOrder = app.slice(
    app.indexOf('const LIMIT_PROVIDERS = ['),
    app.indexOf('const DEFAULT_LIMIT_PROVIDER_ORDER')
  );
  assert.ok(providerOrder.indexOf("{ id: 'thirdparty'") > providerOrder.indexOf("{ id: 'ollama'"));
  const iconProviders = app.slice(
    app.indexOf('const clientsWithIcon = new Set(['),
    app.indexOf('function osIconFor')
  );
  assert.ok(iconProviders.lastIndexOf("'thirdparty'") > iconProviders.lastIndexOf("'ollama'"));
  assert.equal(VENDOR_ORDER.at(-1), 'thirdparty');
  assert.ok(
    Object.keys(VENDOR_LABELS).indexOf('thirdparty') > Object.keys(VENDOR_LABELS).indexOf('ollama')
  );

  const env = read('.env.example');
  const envProviderList = env.slice(
    env.indexOf('# Providers to probe.'),
    env.indexOf('TOKEN_MONITOR_LIMIT_PROVIDERS=')
  );
  assert.ok(envProviderList.lastIndexOf('thirdparty') > envProviderList.lastIndexOf('ollama'));
  assert.ok(env.indexOf('# Third-party API accounts.') > env.indexOf('# Kimi Code API key.'));

  const api = read('docs/API.md');
  const providerContract = api.split('\n').find((line) => line.startsWith('`limits.providers[].provider`'));
  assert.ok(providerContract, 'docs/API.md must document the limits provider enum');
  assert.ok(providerContract.lastIndexOf('`thirdparty`') > providerContract.lastIndexOf('`ollama`'));

  for (const file of ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md']) {
    const content = read(file);
    assert.ok(
      content.indexOf('tools-icon/newapi.png') > content.indexOf('tools-icon/ollama.png'),
      file
    );
  }
});

test('third-party adapters document New API compatibility, Custom, assets, and environment variables', () => {
  for (const file of ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md']) {
    const content = read(file);
    assert.match(content, /\.github\/assets\/tools-icon\/newapi\.png"/, file);
    assert.match(content, /Third-party APIs|第三方 API|サードパーティAPI|서드파티 API/, file);
    assert.match(content, /Custom|自訂|自定义|カスタム|사용자 지정/, file);
    assert.match(content, /One API/, file);
  }
  const env = read('.env.example');
  assert.match(env, /TOKEN_MONITOR_NEWAPI_BASE_URL=/);
  assert.match(env, /TOKEN_MONITOR_NEWAPI_ACCESS_TOKEN=/);
  assert.match(env, /TOKEN_MONITOR_NEWAPI_USER_ID=/);
  assert.match(env, /TOKEN_MONITOR_NEWAPI_API_KEY=/);
  assert.equal(fs.existsSync(path.join(root, '.github/assets/tools-icon/newapi.png')), true);
  assert.equal(fs.existsSync(path.join(root, 'assets/icons/newapi.svg')), true);
});

test('OpenRouter remains official-only and does not inherit third-party Base URL settings', () => {
  const html = read('src/electron/renderer/index.html');
  const openrouterSection = html.slice(
    html.indexOf('id="openrouterAccountGroup"'),
    html.indexOf('id="thirdpartyAccountGroup"')
  );
  assert.doesNotMatch(openrouterSection, /Base URL|baseUrl|newapi|thirdparty/i);
  assert.match(openrouterSection, /id="openrouterApiKeyInput"/);
});
