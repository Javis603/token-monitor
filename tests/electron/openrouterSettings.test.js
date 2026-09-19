'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { LIMIT_PROVIDER_LABELS } = require('../../src/shared/limitProviders');

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  return source.slice(start, end);
}

// The Limits rows moved to limitWindowsView.js, which the edge dock renders
// from too, so a provider's markup is built once rather than twice. These read
// whichever file now holds the function.
function limitsViewSource() {
  return read('src/electron/renderer/limitWindowsView.js');
}

function viewBody(name, nextName = '') {
  const source = limitsViewSource();
  return nextName
    ? functionBody(source, name, nextName)
    : functionBody(`${source}\nfunction __endOfView__() {`, name, '__endOfView__');
}

test('OpenRouter settings provide multi-account API key management without a custom URL', () => {
  const html = read('src/electron/renderer/index.html');
  const app = read('src/electron/renderer/app.js');
  const preload = read('src/electron/preload.js');

  assert.match(html, /id="openrouterAccountGroup"/);
  assert.match(html, /id="openrouterProfileList"/);
  assert.match(html, /id="openrouterProfileName"/);
  assert.match(html, /<input id="openrouterApiKeyInput" type="password"[^>]*data-i18n-placeholder="settings\.openrouter\.apiKeyPlaceholder"/);
  assert.doesNotMatch(html, /<textarea id="openrouterApiKeyInput"/);
  assert.match(html, /id="openrouterProfileSubmit"/);
  assert.match(html, /data-i18n="settings\.openrouter\.profileName"/);
  assert.doesNotMatch(html, /openrouter[^"]*(?:Base URL|baseUrl|base-url)/i);
  assert.match(app, /window\.tokenMonitor\.openExternal\('https:\/\/openrouter\.ai\/settings\/keys'\)/);
  assert.match(app, /renderOpenRouterProfiles/);
  assert.match(app, /setProfileEnabled/);
  assert.match(app, /renameProfile/);
  assert.match(app, /deleteProfile/);
  assert.match(preload, /getProfiles: \(\) => ipcRenderer\.invoke\('openrouter:getProfiles'\)/);
  assert.match(preload, /saveProfile: \(name, apiKey\) => ipcRenderer\.invoke\('openrouter:saveProfile', name, apiKey\)/);
});

test('OpenRouter account statuses settle when refreshed stats arrive', () => {
  const app = read('src/electron/renderer/app.js');
  const refreshStats = app.slice(
    app.indexOf('async function refreshStats(options = {})'),
    app.indexOf('async function refreshStatusViewManually()')
  );
  const statsPush = app.slice(
    app.indexOf('window.tokenMonitor.onStatsPush?.'),
    app.indexOf('function pickWorstProvider(')
  );
  const statsRender = app.slice(
    app.indexOf('function renderStatsUpdate()'),
    app.indexOf('const statsRenderScheduler =')
  );

  assert.match(refreshStats, /statsRenderScheduler\.request\(\)/);
  assert.match(statsPush, /statsRenderScheduler\.request\(\)/);
  assert.match(statsRender, /updateOpenRouterProfilesStatus\(\)/);
});

test('OpenRouter credentials stay in the main process and renderer receives configured state only', () => {
  const app = read('src/electron/renderer/app.js');
  const main = read('src/electron/main.js');
  const credentials = read('src/shared/credentialStore.js');

  assert.match(credentials, /openrouterProfiles: \['providers', 'openrouter', 'profiles'\]/);
  assert.match(main, /function redactOpenRouterProfilesForRenderer/);
  assert.match(main, /apiKey: profile\?\.apiKey \? 'set' : ''/);
  assert.match(main, /delete normalizedPatch\.openrouterProfiles/);
  assert.match(main, /ipcMain\.handle\('openrouter:saveProfile'/);
  assert.match(main, /ipcMain\.handle\('openrouter:deleteProfile'/);
  assert.match(main, /ipcMain\.handle\('openrouter:renameProfile'/);
  assert.match(main, /ipcMain\.handle\('openrouter:setProfileEnabled'/);
  assert.match(main, /AbortSignal\.timeout\(15_000\)/);
  assert.match(main, /openrouterLimits\.openrouterProfileName\(rawName\)/);
  assert.match(main, /openrouterLimits\.openrouterProfileName\(rawNewName\)/);
  assert.match(main, /errorCode: 'invalidName'/);
  assert.match(app, /function openrouterProfileErrorText\(result\)/);
  assert.match(app, /t\('settings\.openrouter\.invalidName'\)/);
});

test('OpenRouter Limits presentation shows a real balance meter and compact spend tooltip', () => {
  const app = read('src/electron/renderer/app.js');
  const presentation = read('src/electron/renderer/limitProviderPresentation.js');
  const styles = read('src/electron/renderer/styles.css');
  const colors = read('src/electron/renderer/usageCharts.js');

  assert.equal(LIMIT_PROVIDER_LABELS.openrouter, 'OpenRouter');
  assert.match(limitsViewSource(), /provider\.provider === 'openrouter'/);
  // Several OpenRouter keys render as the shared group, by account count rather
  // than by a wrapper of their own — the same dispatch the dock card uses.
  assert.match(app, /nodes\.push\(renderLimitProviderGroup\(id, label, visibleProviders, color\)\)/);
  assert.match(limitsViewSource(), /function providerSpendEntries\(balance\)/);
  assert.match(limitsViewSource(), /\['Week', optionalFiniteNumber\(balance\?\.weekSpend\)\]/);
  assert.match(limitsViewSource(), /\['All time', optionalFiniteNumber\(balance\?\.allTimeSpend\)\]/);
  assert.match(limitsViewSource(), /summaryNode\.className = 'limit-spend-summary'/);
  assert.match(limitsViewSource(), /function limitDetailInfoNode\(entries, extraClass = '', ariaLabel = ''\)/);
  assert.match(limitsViewSource(), /function limitNoteRowNode\(\{ label, summary = '', detailEntries = null, ariaParts = \[\] \}\)/);
  assert.match(limitsViewSource(), /tooltip\.className = \['limit-detail-tooltip', columns > 2 \? 'limit-detail-tooltip-triple' : ''\]/);
  assert.match(limitsViewSource(), /info\.tabIndex = 0/);
  // The tooltip's render-hold is page state, so the shared view calls back into
  // it rather than reaching for it: the handler stays wired here, and every
  // tooltip — spend, third-party, forecast — is opened and released by the one
  // attacher rather than by a per-row copy.
  assert.match(limitsViewSource(), /function attachLimitDetailTooltip\(wrap, tooltip\)[\s\S]*?const close = \(\) => \{[\s\S]*?tooltipHost\.release\(\);/);
  assert.match(app, /release\(\) \{\s*requestAnimationFrame\(\(\) => \{\s*if \(limitDetailTooltipShouldHoldRender\(\)\) return;/);
  assert.match(limitsViewSource(), /entries\.map\(\(\[entryLabel, value\]\) => \[entryLabel, formatBalanceSpendAmount\(value, balance\)\]\)/);
  assert.match(limitsViewSource(), /const spendNode = providerSpendNode\(balance\)/);
  assert.match(limitsViewSource(), /function openrouterCreditsWindow\(provider\)/);
  assert.match(limitsViewSource(), /windows\.find\(\(window\) => window\?\.metric === 'credits'\)/);
  assert.match(limitsViewSource(), /windows\.find\(\(window\) => !window\?\.metric && window\?\.label === 'Credits'\)/);
  assert.match(limitsViewSource(), /const creditsWindow = openrouterCreditsWindow\(provider\)/);
  assert.match(limitsViewSource(), /limitWindowNode\(\s*'Balance',\s*\{ \.\.\.balanceWindow, label: 'Balance' \}/);
  assert.match(limitsViewSource(), /\.filter\(\(window\) => window !== creditsWindow\)/);
  assert.match(limitsViewSource(), /const hasMeter = quotaWindow\?\.showMeter !== false/);
  assert.match(limitsViewSource(), /const valueOverride = hasMeter \? null : \(quotaWindow\?\.detail \|\| '—'\)/);
  assert.match(presentation, /openrouter: \['Pay-as-you-go', 'API key'\]/);
  assert.match(styles, /^\.row-icon-openrouter/m);
  assert.match(styles, /\.limit-spend-summary\s*\{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  assert.match(colors, /openrouter: '#6566F1'/);
});

test('OpenRouter credits lookup keeps the mixed-version label fallback', () => {
  const helper = viewBody('openrouterCreditsWindow', 'formatLimitWindowValue');
  const findCredits = (windows) => vm.runInNewContext(
    `${helper}\nopenrouterCreditsWindow(${JSON.stringify({ windows })});`
  );
  const legacyCredits = { kind: 'billing', label: 'Credits', remaining: 4 };
  const metricCredits = { kind: 'billing', metric: 'credits', label: 'Account credit', remaining: 8 };

  assert.equal(findCredits([legacyCredits, metricCredits]).metric, 'credits');
  assert.equal(findCredits([legacyCredits]).label, 'Credits');
  assert.equal(findCredits([{ ...legacyCredits, metric: 'quota' }]), null);
});

test('OpenRouter is documented with its supplied icon in every supported-tools table', () => {
  const row = /\.github\/assets\/tools-icon\/openrouter\.png" width="28" alt="OpenRouter" \/> \| OpenRouter \| OpenRouter API/;
  for (const file of ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md']) {
    assert.match(read(file), row, file);
  }
  assert.equal(fs.existsSync(path.join(root, '.github/assets/tools-icon/openrouter.png')), true);
  assert.equal(fs.existsSync(path.join(root, 'assets/icons/openrouter.svg')), true);
});

test('OpenRouter settings status uses collision-free row identity and a stable env account name', () => {
  const app = read('src/electron/renderer/app.js');
  assert.match(app, /info\.dataset\.managedProfileProvider = providerId/);
  assert.match(app, /info\.dataset\.managedProfileName = name/);
  assert.match(app, /info\.dataset\.managedProfileEnvironment = 'true'/);
  assert.match(app, /byName\.get\('environment'\)/);
  assert.match(limitsViewSource(), /function namedApiAccountTitle/);
  assert.doesNotMatch(app, /appendRow\('default \(env\)'/);
  assert.doesNotMatch(app, /openrouter-info-\$\{/);
});

test('OpenRouter key page is narrowly allowlisted', () => {
  const main = read('src/electron/main.js');
  assert.match(main, /parsed\.hostname === 'openrouter\.ai' && parsed\.pathname\.startsWith\('\/settings\/keys'\)/);
});
