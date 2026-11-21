'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => {
  const files = [relativePath];
  if (relativePath === 'src/electron/renderer/app.js') files.push('src/electron/renderer/limits/providerOwners/thirdparty.js');
  if (relativePath === 'src/electron/renderer/limits/providerPresentation.js') files.push('src/electron/renderer/providers/thirdparty/presentation.js');
  if (relativePath === 'src/electron/renderer/limits/windowsView.js') files.push('src/electron/renderer/providers/thirdparty/windows.js');
  return files.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
};
const { VENDOR_LABELS, VENDOR_ORDER } = require('../../src/electron/renderer/themePresets');
const { rendererStyles } = require('../helpers/rendererStyles');
const { LIMIT_PROVIDER_CATALOG, LIMIT_PROVIDER_LABELS } = require('../../src/shared/limits/providers');

async function thirdPartyRows(profiles, hasEnvVar = false, readings = [], bridge = {}) {
  const document = require('./accountOwnerDom.fixture.cjs').createDocument();
  const list = document.createElement('div'); list.id = 'thirdpartyProfileList'; document.root.append(list);
  const settings = {};
  const { translate } = require('../../src/electron/renderer/i18n');
  const owner = require('../../src/electron/renderer/limits/providerOwners/thirdparty').create({
    document, initial: {}, getSettings: () => settings, getAccountContext: () => ({ settings }), preserveScroll: fn => fn(),
    t: (key, params) => translate('en', key, params), isSettingsSurfaceVisible: () => true,
    localProviderStatuses: () => readings, limitProviderEnabled: () => true,
    accountProfileRequests: { begin: () => () => true }, renderAccountShellError() {}, renderSettingsSummaries() {},
    accountShellApi: require('../../src/electron/renderer/limits/accountShell'),
    window: { TokenMonitorLegacyAccountList: require('../../src/electron/renderer/limits/legacyAccountList'),
      tokenMonitor: { thirdparty: bridge.api || { getProfiles: async () => ({ profiles, hasEnvVar }) }, limits: { accountSlots: { presentation: bridge.presentation } } } }
  });
  owner.renderThirdPartyProfiles();
  await new Promise(resolve => setImmediate(resolve));
  return { list, rows: [...list.walk()].filter(node => node.dataset.slotId) };
}

test('third-party settings separate presets, scope, and safe custom mappings', () => {
  const html = read('src/electron/renderer/index.html');
  const app = read('src/electron/renderer/app.js');
  const preload = read('src/electron/preload.js');
  const styles = rendererStyles();

  assert.match(html, /id="thirdpartyAccountGroup"/);
  assert.match(html, /id="thirdpartyProfileList"/);
  assert.match(html, /<label for="thirdpartyPlatformInput"[^>]*data-i18n="settings\.thirdparty\.preset"/);
  assert.match(html, /<select id="thirdpartyPlatformInput">[\s\S]*?<option value="newapi"[^>]*>[\s\S]*?<option value="custom"/);
  assert.match(html, /<option value="sub2api"[^>]*data-i18n="settings\.thirdparty\.presetSub2Api"/);
  assert.match(html, /<label for="thirdpartyModeInput"[^>]*data-i18n="settings\.thirdparty\.scope"/);
  assert.match(html, /<select id="thirdpartyModeInput">[\s\S]*?<option value="account"[^>]*>[\s\S]*?<option value="token"/);
  assert.match(html, /class="thirdparty-choice-grid"/);
  assert.match(html, /id="thirdpartyModeHint"/);
  assert.match(html, /id="thirdpartySub2ApiSteps" class="settings-note hidden"/);
  assert.match(html, /settings\.thirdparty\.sub2ApiStep1/);
  assert.match(html, /DevTools → Application → Local storage/);
  assert.match(html, /<label for="thirdpartyBaseUrlInput"[^>]*data-i18n="settings\.thirdparty\.baseUrl"/);
  assert.match(html, /<input id="thirdpartyBaseUrlInput" type="url"/);
  assert.match(html, /id="thirdpartyHttpWarning"[^>]*role="status"[^>]*data-i18n="settings\.thirdparty\.httpWarning"/);
  assert.match(html, /<input id="thirdpartyAccessTokenInput" type="password"/);
  assert.match(html, /<div id="thirdpartyRefreshTokenRow" class="thirdparty-field hidden">[\s\S]*?<input id="thirdpartyRefreshTokenInput" type="password"/);
  assert.match(html, /data-i18n="settings\.thirdparty\.refreshToken">Refresh token \(optional\)/);
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
  assert.match(app, /if \(platform === 'sub2api'\) return 'sub2api'/);
  assert.match(app, /thirdpartyRefreshTokenRow[\s\S]*?classList\.toggle\('hidden', !sub2apiMode\)/);
  assert.match(app, /thirdpartySub2ApiSteps[\s\S]*?classList\.toggle\('hidden', !sub2apiMode\)/);
  assert.match(app, /const accessTokenKey = 'settings\.thirdparty\.accessToken'/);
  assert.match(app, /const refreshTokenKey = 'settings\.thirdparty\.refreshToken'/);
  assert.match(app, /settings\.thirdparty\.sub2ApiAccessTokenPlaceholder/);
  assert.match(app, /settings\.thirdparty\.sub2ApiRefreshTokenPlaceholder/);
  assert.match(html, /id="thirdpartyRefreshTokenRow" class="thirdparty-field hidden"/);
  assert.match(app, /const refreshToken = String\(refreshTokenInput\?\.value \|\| ''\)\.trim\(\)/);
  assert.match(app, /thirdPartyProfileErrorText\(result, adapter\)/);
  assert.match(app, /errorCode === 'newApiLegacyTokenRetired'/);
  assert.match(app, /errorCode === 'newApiScopeDenied'/);
  assert.match(app, /thirdpartyCustomConfig[\s\S]*?classList\.toggle\('hidden', !customMode\)/);
  assert.match(app, /thirdpartyCredentialGrid[\s\S]*?classList\.toggle\([\s\S]*?'single-field'/);
  assert.match(app, /const pairedCredentials = newApiAccountMode;/);
  assert.match(app, /baseUrlInput\?\.addEventListener\('input', updateThirdPartyHttpWarning\)/);
  assert.match(app, /new URL\(String\(input\?\.value \|\| ''\)\.trim\(\)\)\.protocol === 'http:'/);
  assert.match(styles, /\.thirdparty-choice-grid\.single-field,[\s\S]*?\.thirdparty-credential-grid\.single-field \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(preload, /saveProfile: \(profile\) => ipcRenderer\.invoke\('thirdparty:saveProfile', profile\)/);
});

test('third-party credentials stay local while renderer metadata is redacted', () => {
  const main = read('src/electron/main.js') + '\n' + read('src/electron/providers/thirdparty/accountService.js');
  const accountSettings = read('src/electron/limits/accountSettings.js');
  const { CREDENTIAL_SETTING_PATHS } = require('../../src/shared/credentialStore');
  const { accountFieldProjection, normalizeAccountPatch } = require('../../src/electron/limits/accountSettings');

  assert.deepEqual(CREDENTIAL_SETTING_PATHS.thirdPartyProfiles, ['providers', 'thirdparty', 'profiles']);
  assert.match(main, /\.\.\.accountFieldProjection\(settings, process\.env\)/);
  assert.match(accountSettings, /function redactThirdPartyProfilesForRenderer[\s\S]*?const out = Object\.create\(null\)/);
  assert.match(accountSettings, /const adapter = thirdPartyLimits\.normalizeAdapterId\(profile\?\.adapter\)/);
  assert.match(accountSettings, /baseUrl: thirdPartyLimits\.normalizeThirdPartyBaseUrl\(profile\?\.baseUrl, \{/);
  assert.match(accountSettings, /accessToken: profile\?\.accessToken \? 'set' : ''/);
  assert.match(accountSettings, /apiKey: profile\?\.apiKey \? 'set' : ''/);
  assert.match(accountSettings, /refreshToken: profile\?\.refreshToken \? 'set' : ''/);
  const projected = accountFieldProjection({ thirdPartyProfiles: { example: { accessToken: 'secret', apiKey: 'secret', refreshToken: 'secret' } } });
  assert.equal(projected.thirdPartyProfiles.example.accessToken, 'set');
  assert.equal(projected.thirdPartyProfiles.example.apiKey, 'set');
  assert.equal(projected.thirdPartyProfiles.example.refreshToken, 'set');
  assert.match(main, /function persistThirdPartyCredentialsRenewal\(renewal = \{\}\)/);
  assert.match(main, /function persistThirdPartyAccountKey\(update = \{\}\)/);
  assert.match(main, /onThirdPartyCredentialsRenewed: persistThirdPartyCredentialsRenewal/);
  assert.match(main, /onThirdPartyAccountKeyResolved: persistThirdPartyAccountKey/);
  assert.match(main, /function thirdPartyProfileWithCanonicalIdentity\(profile, provider\)/);
  assert.match(main, /canonicalAccountKey: provider\?\.accountKey/);
  assert.doesNotMatch(main, /persistThirdPartyCredentialsRenewal\(renewal, profile\)/);
  assert.doesNotMatch(main, /profiles\[accountName\] \|\| fallbackProfile/);
  assert.match(accountSettings, /endpointPath: thirdPartyLimits\.normalizeCustomEndpointPath\(profile\?\.endpointPath\)/);
  assert.match(accountSettings, /remainingPath: thirdPartyLimits\.normalizeCustomJsonPath\(profile\?\.remainingPath\)/);
  assert.match(main, /normalizeAccountPatch\(patch, normalizedPatch\)/);
  const normalized = { thirdPartyProfiles: { example: { apiKey: 'secret' } } };
  normalizeAccountPatch(normalized, normalized);
  assert.equal(Object.hasOwn(normalized, 'thirdPartyProfiles'), false);
  assert.match(main, /ipcMain\.handle\('thirdparty:saveProfile'/);
  assert.match(main, /ipcMain\.handle\('thirdparty:deleteProfile'/);
  assert.match(main, /ipcMain\.handle\('thirdparty:renameProfile'/);
  assert.match(main, /ipcMain\.handle\('thirdparty:setProfileEnabled'/);
  assert.match(main, /thirdPartyLimits\.fetchThirdPartyAccount\(\{ name, \.\.\.profile \}/);
  assert.match(main, /surfaceAccessTokenErrors: true/);
  assert.match(main, /onEnrichmentAccessTokenError/);
  assert.match(main, /warning: 'newApiMissingUsageScope'/);
  assert.match(main, /'ACCESS_TOKEN_LEGACY_RETIRED'\) return 'newApiLegacyTokenRetired'/);
  assert.match(main, /'ACCESS_TOKEN_SCOPE_DENIED'\) return 'newApiScopeDenied'/);
  assert.match(read('src/electron/renderer/app.js'), /result\.warning === 'newApiMissingUsageScope'/);
  assert.match(main, /thirdPartyLimits\.CUSTOM_BALANCE_ADAPTER/);
  assert.doesNotMatch(main, /DEFAULT_THIRD_PARTY_ADAPTER/);
  assert.doesNotMatch(main, /ONEAPI_ACCOUNT_ADAPTER/);
  assert.doesNotMatch(main, /errorCode: 'missingUserId'/);
});

test('third-party profile rows retain named identity and accessible rename/remove actions', async () => {
  const { rows } = await thirdPartyRows({ 'default (env)': { canonicalAccountKey: 'saved' } }, true);
  assert.deepEqual(rows.map(row => row.dataset.slotId), ['default (env)', 'environment']);
  assert.equal(rows[0].querySelector('.slot-name').textContent, 'default (env)');
  assert.equal(rows[1].querySelector('.slot-name').textContent, 'Environment');
  for (const row of rows) assert.ok(row.querySelector('.slot-rename-button').attributes['aria-label']);
  const remove = [...rows[0].walk()].find(node => node.dataset.slotAction === 'remove');
  assert.equal(remove.attributes['aria-label'], 'Remove account');
});

test('third-party Limits presentation uses compact scope labels and a details tooltip', () => {
  const app = read('src/electron/renderer/app.js');
  const i18n = read('src/electron/renderer/i18n.js');
  const presentation = read('src/electron/renderer/limits/providerPresentation.js');
  const balanceDisplay = read('src/shared/limits/balanceDisplay.js');
  const styles = rendererStyles();
  const { clientColors } = require('../../src/electron/renderer/usageCharts');

  assert.equal(LIMIT_PROVIDER_LABELS.thirdparty, 'Third-party APIs');
  assert.match(read('src/electron/renderer/limits/windowOwners.js'), /thirdparty: require\('\.\.\/providers\/thirdparty\/windows'\)/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /function thirdPartyQuotaWindow/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /quotaWindow\?\.label \|\| 'Balance'/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /const meterPercent = creditsMeterPercent\(provider, quotaWindow\)/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /\.\.\.\(meterPercent !== null \? \{ remainingPercent: meterPercent, showMeter: true \} : \{\}\)/);
  // The adapter's own name, mark and colour are provider presentation, so they
  // live in the module both surfaces load rather than in the page that happened
  // to need them first. The dock card renders the same rows and cannot reach
  // app.js.
  assert.match(presentation, /function thirdPartyGroupPlanText/);
  assert.match(presentation, /adapterId === 'sub2api'/);
  assert.match(presentation, /const THIRD_PARTY_ADAPTER_VISUALS/);
  assert.match(presentation, /if \(provider\?\.status !== 'ok'\) return undefined/);
  assert.match(presentation, /if \(planLabel === 'account'\) return 'Account'/);
  assert.match(presentation, /if \(planLabel === 'api key'\) return 'API key'/);
  assert.match(presentation, /if \(planLabel === 'custom'\) return 'Custom'/);
  assert.doesNotMatch(presentation, /planLabel\.includes\('token'\) \|\| quotaLabel\.includes\('token'\)/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /function thirdPartySpendNode/);
  // Account metadata and the order of rendered tooltip rows are exercised by
  // edgeDockLimitCard.test.js through the shared view used by both surfaces.
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /if \(spendRows\.length === 0 && entries\.length === 0\) return null/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /const spendValues = providerSpendEntries\(balance\)/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /preferredSpend\.length > 0 \? preferredSpend : spendValues\.slice\(0, 2\)/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /\.join\(' · '\)/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /settings\.thirdparty\.monthTokens/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /settings\.thirdparty\.avgResponse/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /label: summary \? 'Spend' : 'Details'/);
  assert.match(balanceDisplay, /return symbol \? `\$\{symbol\}\$\{number\.toFixed\(2\)\}` : `\$\{code\} \$\{number\.toFixed\(2\)\}`/);
  // The group builder is the shared view's, and it now derives the adapter
  // decorations itself: a host that passes nothing — the dock card — still gets
  // each row's own mark, colour and adapter name, and a header that wears the
  // family they share.
  const view = read('src/electron/renderer/limits/windowsView.js');
  assert.match(view, /function renderLimitProviderGroup\(providerId, label, providers, color\)/);
  assert.match(view, /renderLimitProviderGroupFrame\(\s*providerId, label, providers, color, \{ count: providers\.length, markId \}/);
  assert.match(view, /const groupPolicy =[\s\S]*?markId: family \|\| 'thirdparty', sharedFamily: family/);
  assert.match(view, /const rowPolicy =[\s\S]*?const visual = presentationApi\.thirdPartyAdapterVisual\(provider, color\)/);
  // The page's group call passes the provider and nothing else, so it cannot
  // render this group differently from the card.
  assert.match(app, /renderLimitProviderGroup\(id, label, visibleProviders, color\)/);
  assert.doesNotMatch(app, /groupPlanText|markIdForProvider|colorForProvider/);
  assert.doesNotMatch(i18n, /settings\.thirdparty\.(?:spend|allTime)/);
  assert.match(read('src/electron/renderer/limits/windowsView.js'), /limitDetailInfoNode\(detailEntries, 'limit-spend-info-wrap'\)/);
  assert.deepEqual(require('../../src/electron/renderer/limits/providerPresentation').connectionTag('thirdparty').parts, ['API key']);
  assert.match(styles, /^\.row-icon-sub2api/m);
  assert.match(styles, /assets\/icons\/sub2api\.svg/);
  assert.match(styles, /^\.row-icon-thirdparty[\s\S]*?assets\/icons\/thirdparty\.svg/m);
  assert.doesNotMatch(styles, /customapi\.svg/);
  assert.match(presentation, /custom: \{ color: '#8A96A8', markId: 'thirdparty' \}/);
  assert.doesNotMatch(app, /mark\.style\.color/);
  assert.equal(clientColors.thirdparty, '#8090A6');
});

test('third-party money formatting preserves supported custom units', () => {
  const { formatMoney, formatCompactMoney } = require('../../src/shared/limits/balanceDisplay');
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
  const helpers = require('../../src/electron/renderer/providers/thirdparty/presentation');
  const result = vm.runInNewContext(
    `JSON.stringify([
      thirdPartyGroupPlanText({ status: 'ok', planLabel: 'Account' }),
      thirdPartyGroupPlanText({ status: 'ok', planLabel: 'API key' }),
      thirdPartyGroupPlanText({ status: 'ok', planLabel: 'Custom' }),
      thirdPartyGroupPlanText({ status: 'ok', adapterId: 'newapi-account', planLabel: 'Account' }),
      thirdPartyGroupPlanText({ status: 'ok', adapterId: 'sub2api', planLabel: 'Account' }),
      thirdPartyGroupPlanText({ status: 'ok', planLabel: 'Token deluxe' }) ?? null,
      thirdPartyGroupPlanText({ status: 'unavailable', planLabel: 'Account' }) ?? null
    ]);`, helpers
  );
  assert.deepEqual(JSON.parse(result), ['Account', 'API key', 'Custom', 'New API · Account', 'Sub2API · Account', null, null]);
});

test('third-party group icon represents a shared adapter family', () => {
  const helpers = require('../../src/electron/renderer/providers/thirdparty/presentation');
  const result = vm.runInNewContext(
    `JSON.stringify([
      thirdPartySharedAdapterFamily([{ adapterId: 'newapi-account' }, { adapterId: 'newapi-token' }]),
      thirdPartySharedAdapterFamily([{ adapterId: 'sub2api' }, { adapterId: 'sub2api' }]),
      thirdPartySharedAdapterFamily([{ adapterId: 'custom' }, { adapterId: 'custom' }]),
      thirdPartySharedAdapterFamily([{ adapterId: 'newapi-account' }, { adapterId: 'sub2api' }]),
      thirdPartySharedAdapterFamily([{ adapterId: 'newapi-account' }, {}]),
      thirdPartySharedAdapterFamily([{}, {}])
    ]);`, helpers
  );
  assert.deepEqual(JSON.parse(result), [
    'newapi',
    'sub2api',
    'thirdparty',
    null,
    null,
    ''
  ]);
});

test('third-party profile rows keep metadata on line two and rename on line one', async () => {
  const html = read('src/electron/renderer/index.html');
  const styles = rendererStyles();
  const app = read('src/electron/renderer/app.js');

  assert.match(html, /id="thirdpartyProfileList" class="opencode-profile-list thirdparty-profile-list"/);
  const { rows } = await thirdPartyRows({ work: { canonicalAccountKey: 'saved', baseUrl: 'https://quota.example.com', adapter: 'newapi-account', enabled: false } });
  const copy = rows[0].querySelector('.slot-copy');
  const nameLine = rows[0].querySelector('.slot-name-line');
  const rename = rows[0].querySelector('.slot-rename-button');
  const detail = rows[0].querySelector('.slot-detail');
  assert.equal(rename.parentElement, nameLine);
  assert.deepEqual(copy.children.slice(0, 2), [nameLine, detail]);
  assert.equal(detail.textContent, 'New API · Account · quota.example.com');
  assert.equal(rows[0].querySelector('.slot-status').textContent, 'Paused');
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
  assert.match(app, /formatCompactMoney/);
  assert.match(app, /formatCompactMoney\(balance, provider\.balance\?\.currency \|\| 'USD', state\.settings\?\.compactTokenUnits, currentLocale\(\)\)/);
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
  assert.match(statsRender, /refreshAccountOwnerReadings\(\);/);
  assert.match(statsPush, /statsRenderScheduler\.request\(\);/);
  assert.match(read('src/electron/renderer/limits/providerOwners/thirdparty.js'), /refreshReadings: updateThirdPartyProfilesStatus/);
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

  const providerOrder = LIMIT_PROVIDER_CATALOG.map((provider) => provider.id);
  assert.equal(providerOrder.at(-1), 'thirdparty');
  assert.ok(providerOrder.indexOf('thirdparty') > providerOrder.indexOf('ollama'));
  // clientsWithIcon is VENDOR_ORDER now, so this covers the icon set too.
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
  assert.ok(providerContract, 'docs/API.md must document the limits provider contract');
  assert.match(providerContract, /`LIMIT_PROVIDER_CATALOG` in `src\/shared\/limits\/providers\.js`/);

  for (const file of ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md']) {
    const content = read(file);
    assert.ok(
      content.indexOf('tools-icon/thirdparty.gif') > content.indexOf('tools-icon/ollama.png'),
      file
    );
  }
});

test('third-party adapters share one documentation icon and preserve compatibility guidance', () => {
  for (const file of ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md']) {
    const content = read(file);
    assert.match(content, /\.github\/assets\/tools-icon\/thirdparty\.gif"/, file);
    assert.doesNotMatch(content, /\.github\/assets\/tools-icon\/newapi\.png"/, file);
    assert.match(content, /Third-party APIs|第三方 API|サードパーティAPI|서드파티 API/, file);
    assert.match(content, /New API \/ Sub2API/, file);
    assert.match(content, /Custom|自訂|自定义|カスタム|사용자 지정/, file);
    assert.match(content, /One API/, file);
  }
  const env = read('.env.example');
  assert.match(env, /TOKEN_MONITOR_NEWAPI_BASE_URL=/);
  assert.match(env, /TOKEN_MONITOR_NEWAPI_ACCESS_TOKEN=/);
  assert.match(env, /TOKEN_MONITOR_NEWAPI_USER_ID=/);
  assert.match(env, /TOKEN_MONITOR_NEWAPI_API_KEY=/);
  assert.equal(fs.existsSync(path.join(root, '.github/assets/tools-icon/thirdparty.gif')), true);
  assert.equal(fs.existsSync(path.join(root, '.github/assets/tools-icon/newapi.png')), false);
  assert.equal(fs.existsSync(path.join(root, 'assets/icons/newapi.svg')), true);
});

test('OpenRouter remains official-only and does not inherit third-party Base URL settings', () => {
  const { limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
  const form = limitAccountFormsForRenderer().find(form => form.id === 'openrouter');
  assert.deepEqual(form.fields.map(field => field.key), ['openrouterApiKey']);
  assert.equal(form.openUrl.url, 'https://openrouter.ai/settings/keys');
});

test('third-party service DTO retains collector identity through redaction and shared rows', async () => {
  const limits = require('../../src/shared/providers/thirdparty/limits');
  const { createThirdpartyAccountService } = require('../../src/electron/providers/thirdparty/accountService');
  const profiles = {
    account: { adapter: 'newapi-account', baseUrl: 'https://account.example', accessToken: 'private-access', userId: '42' },
    token: { adapter: 'newapi-token', baseUrl: 'https://token.example', apiKey: 'private-api' },
    sub: { adapter: 'sub2api', baseUrl: 'https://sub.example', accessToken: 'private-sub', refreshToken: 'private-refresh', canonicalAccountKey: `sha256:${'a'.repeat(64)}` },
    custom: { adapter: 'custom', baseUrl: 'https://custom.example', apiKey: 'private-custom', endpointPath: '/balance', authMode: 'bearer', remainingPath: 'balance', currency: 'USD', divisor: 1 }
  };
  const service = createThirdpartyAccountService({ getThirdPartyProfiles: () => profiles, env: {} });
  const { profiles: safe } = await service.getProfiles();
  for (const [name, profile] of Object.entries(profiles)) {
    const reading = await limits.fetchThirdPartyAccount({ name, ...limits.normalizeThirdPartyProfile(profile) }, { env: {}, fetch: async () => ({ ok: false, status: 401 }) });
    assert.ok(safe[name].accountKey, name);
    assert.equal(safe[name].accountKey, reading.accountKey, name);
    const { rows } = await thirdPartyRows({ [name]: safe[name] }, false, [{ ...reading, status: 'ok' }]);
    assert.equal(rows.length, 1);
    assert.match(rows[0].querySelector('.slot-status').attributes['aria-label'], /Connected/);
    const rename = [...rows[0].walk()].find(node => node.dataset.slotAction === 'rename');
    assert.ok(rename);
    assert.notEqual(rename.disabled, true);
    assert.equal(rename.classList.contains('hidden'), false);
  }
  assert.equal(safe.sub.accountKey, profiles.sub.canonicalAccountKey);
  assert.ok(!JSON.stringify(safe).includes('private-'));
  profiles.sub.enabled = false;
  assert.equal((await service.getProfiles()).profiles.sub.accountKey, safe.sub.accountKey);
});

for (const mode of ['account', 'token']) for (const status of ['ok', 'unauthorized']) {
  test(`third-party ${mode} environment DTO drives ${status} status and presentation controls`, async () => {
    const limits = require('../../src/shared/providers/thirdparty/limits');
    const { createThirdpartyAccountService } = require('../../src/electron/providers/thirdparty/accountService');
    const env = { TOKEN_MONITOR_NEWAPI_BASE_URL: 'https://env.example/v1/',
      ...(mode === 'account' ? { TOKEN_MONITOR_NEWAPI_ACCESS_TOKEN: 'private-env-access', TOKEN_MONITOR_NEWAPI_USER_ID: '42' }
        : { TOKEN_MONITOR_NEWAPI_API_KEY: 'private-env-api' }) };
    const profiles = { saved: { adapter: 'newapi-token', baseUrl: 'https://saved.example', apiKey: 'private-saved-api' } };
    const service = createThirdpartyAccountService({ getThirdPartyProfiles: () => profiles, env });
    const dto = await service.getProfiles();
    const readings = await limits.fetchThirdPartyLimits({}, { env, fetch: async url => {
      const path = new URL(url).pathname;
      const http = status === 'unauthorized' && path !== '/api/status' ? 401 : 200;
      const data = path === '/api/status' ? { quota_per_unit: 500000 }
        : path === '/api/data/self' ? []
        : { quota: 2500000, used_quota: 500000, total_available: 2500000, total_used: 500000 };
      return { ok: http === 200, status: http, json: async () => ({ success: true, data }) };
    } });
    assert.equal(readings.length, 1);
    assert.equal(readings[0].status, status);
    assert.equal(dto.hasEnvVar, true);
    assert.equal(dto.environmentAccountKey, readings[0].accountKey);
    assert.doesNotMatch(JSON.stringify(dto), /private-/);
    const calls = [];
    const { rows } = await thirdPartyRows({}, false, readings, { api: service, presentation: async (...args) => {
      calls.push(args); return { ok: true };
    } });
    const row = rows.find(row => row.dataset.slotId === 'environment');
    assert.ok(row);
    assert.equal(row.querySelector('.slot-status').classList.contains(status === 'ok' ? 'slot-connected' : 'slot-invalid'), true);
    const action = name => [...row.walk()].find(node => node.dataset.slotAction === name);
    assert.equal(action('rename').classList.contains('hidden'), false);
    action('rename').click();
    const input = row.querySelector('.slot-rename'); input.value = 'Environment display name';
    await input.key('Enter');
    assert.deepEqual(calls[0], ['thirdparty', readings[0].accountKey, 'rename', 'Environment display name']);
    await action('up').click();
    assert.deepEqual(calls[1], ['thirdparty', readings[0].accountKey, 'order', [readings[0].accountKey, dto.profiles.saved.accountKey]]);
    for (const name of ['replaceKey', 'pause', 'remove']) assert.equal(action(name).classList.contains('hidden'), true, name);
    assert.equal(row.querySelector('.slot-fix').classList.contains('hidden'), true);
  });
}
