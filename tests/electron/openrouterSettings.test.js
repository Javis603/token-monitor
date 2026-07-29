'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  return source.slice(start, end);
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

  assert.match(app, /\{ id: 'openrouter', label: 'OpenRouter' \}/);
  assert.match(app, /provider\.provider === 'openrouter'/);
  assert.match(app, /function renderOpenRouterAccountGroup/);
  assert.match(
    app,
    /if \(id === 'openrouter' && Array\.isArray\(visibleProviders\) && visibleProviders\.length > 1\) \{\s*nodes\.push\(renderOpenRouterAccountGroup\(label, visibleProviders, color\)\);\s*continue;\s*\}/
  );
  assert.match(app, /function providerSpendEntries\(balance\)/);
  assert.match(app, /\['Week', optionalFiniteNumber\(balance\?\.weekSpend\)\]/);
  assert.match(app, /\['All time', optionalFiniteNumber\(balance\?\.allTimeSpend\)\]/);
  assert.match(app, /summaryNode\.className = 'limit-spend-summary'/);
  assert.match(app, /function limitDetailInfoNode\(entries, extraClass = '', ariaLabel = ''\)/);
  assert.match(app, /function limitNoteRowNode\(\{ label, summary = '', detailEntries = null, ariaParts = \[\] \}\)/);
  assert.match(app, /tooltip\.className = \['limit-detail-tooltip', columns > 2 \? 'limit-detail-tooltip-triple' : ''\]/);
  assert.match(app, /info\.tabIndex = 0/);
  assert.match(app, /const release = \(\) => \{\s*requestAnimationFrame\(\(\) => \{\s*if \(limitDetailTooltipShouldHoldRender\(\)\) return;/);
  assert.match(app, /entries\.map\(\(\[entryLabel, value\]\) => \[entryLabel, formatMoney\(value, currency\)\]\)/);
  assert.match(app, /const spendNode = providerSpendNode\(balance\)/);
  assert.match(app, /function openrouterCreditsWindow\(provider\)/);
  assert.match(app, /windows\.find\(\(window\) => window\?\.metric === 'credits'\)/);
  assert.match(app, /windows\.find\(\(window\) => !window\?\.metric && window\?\.label === 'Credits'\)/);
  assert.match(app, /const creditsWindow = openrouterCreditsWindow\(provider\)/);
  assert.match(app, /limitWindowNode\(\s*'Balance',\s*\{ \.\.\.balanceWindow, label: 'Balance' \}/);
  assert.match(app, /\.filter\(\(window\) => window !== creditsWindow\)/);
  assert.match(app, /const hasMeter = quotaWindow\?\.showMeter !== false/);
  assert.match(app, /const valueOverride = hasMeter \? null : \(quotaWindow\?\.detail \|\| '—'\)/);
  assert.match(presentation, /openrouter: \['Pay-as-you-go', 'API key'\]/);
  assert.match(styles, /\.limit-icon-openrouter/);
  assert.match(styles, /\.limit-spend-summary\s*\{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  assert.match(colors, /openrouter: '#6566F1'/);
});

test('OpenRouter credits lookup keeps the mixed-version label fallback', () => {
  const app = read('src/electron/renderer/app.js');
  const helper = functionBody(app, 'openrouterCreditsWindow', 'formatLimitWindowValue');
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
  assert.match(app, /function namedApiAccountTitle/);
  assert.doesNotMatch(app, /appendRow\('default \(env\)'/);
  assert.doesNotMatch(app, /openrouter-info-\$\{/);
});

test('OpenRouter key page is narrowly allowlisted', () => {
  const main = read('src/electron/main.js');
  assert.match(main, /parsed\.hostname === 'openrouter\.ai' && parsed\.pathname\.startsWith\('\/settings\/keys'\)/);
});
