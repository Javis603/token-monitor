'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function read(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

test('General settings ends with a compact About section', () => {
  const html = read('index.html');
  const general = html.match(/<div id="generalSettingsDetails"[\s\S]*?<div id="mainSettingsDetails"/)?.[0] || '';

  assert.match(general, /class="settings-subgroup about-settings"/);
  assert.match(general, /id="aboutVersion">—<\/span>/);
  assert.match(general, /id="openRepositoryButton"[\s\S]*settings\.about\.repository/);
  assert.match(general, /id="openWebsiteButton"[\s\S]*settings\.about\.website/);
  assert.match(general, /id="reportIssueButton"[\s\S]*settings\.about\.reportIssue/);
  assert.ok(general.indexOf('settings.advanced.title') < general.indexOf('settings.about.title'));
});

test('General settings keeps Tokscale inside a collapsed Advanced disclosure', () => {
  const html = read('index.html');
  const general = html.match(/<div id="generalSettingsDetails"[\s\S]*?<div id="mainSettingsDetails"/)?.[0] || '';
  const start = general.indexOf('<div id="advancedSettingsGroup"');
  const end = general.indexOf('<div class="settings-subgroup about-settings">', start);
  const advanced = start >= 0 && end >= 0 ? general.slice(start, end) : '';

  assert.match(advanced, /^<div id="advancedSettingsGroup" class="settings-subgroup advanced-settings">/);
  assert.match(advanced, /<button id="advancedSettingsToggle"[\s\S]*aria-expanded="false" aria-controls="advancedSettingsDetails">[\s\S]*settings\.advanced\.title/);
  assert.match(advanced, /<div id="advancedSettingsDetails" class="advanced-settings-details hidden" inert>/);
  assert.match(advanced, /id="advancedSettingsSummary"[\s\S]*settings\.advanced\.summary/);
  assert.ok(advanced.indexOf('id="tokscaleGroup"') < advanced.indexOf('id="openConfigButton"'));
  assert.ok(general.indexOf('settings.appUpdate.title') < start);
  assert.ok(end < general.indexOf('settings.about.title'));
});

test('General settings explains Discord presence and identifies Tokscale as an npm CLI dependency', () => {
  const html = read('index.html');
  const i18n = read('i18n.js');

  assert.match(html, /id="discordRpcInput"[^>]*aria-describedby="discordRpcDescription"[\s\S]*id="discordRpcDescription" class="settings-item-desc"[^>]*settings\.integrations\.discordDescription/);
  assert.equal((i18n.match(/'settings\.integrations\.discordDescription':/g) || []).length, 5);
  assert.match(i18n, /'settings\.tokscale\.source': '來自 npm 的 CLI 依賴'/);
  assert.doesNotMatch(i18n, /'settings\.tokscale\.source': '[^']*(?:Data engine|資料引擎|数据引擎|데이터 엔진|データエンジン)/);
});

test('General settings places integrations after the complete App Updates group', () => {
  const html = read('index.html');
  const general = html.match(/<div id="generalSettingsDetails"[\s\S]*?<div id="mainSettingsDetails"/)?.[0] || '';

  assert.ok(general.indexOf('id="startupGroup"') < general.indexOf('id="automaticAppUpdatesRow"'));
  assert.ok(general.indexOf('id="appUpdateMessage"') < general.indexOf('id="discordRpcInput"'));
  assert.ok(general.indexOf('id="discordRpcInput"') < general.indexOf('id="advancedSettingsGroup"'));
});

test('Advanced disclosure uses the shared animated accordion with accessible state', () => {
  const css = read('styles.css');
  const app = read('app.js');

  assert.match(css, /\.advanced-settings-toggle:focus-visible \{[\s\S]*outline:/);
  assert.match(css, /\.advanced-settings\.expanded > \.advanced-settings-toggle \.settings-section-disclosure \{[\s\S]*transform: rotate\(180deg\)/);
  assert.match(app, /'\.advanced-settings-details'/);
  assert.match(app, /function setSettingsAccordionExpanded\(group, toggle, details, expanded\)[\s\S]*details\.inert = !open/);
  assert.match(app, /setupSettingsAccordion\(els\.advancedSettingsGroup, els\.advancedSettingsToggle, els\.advancedSettingsDetails\)/);
});

test('maintenance versions stay as compact flat rows instead of nested cards', () => {
  const css = read('styles.css');
  const gridStart = css.indexOf('.maintenance-version-grid {');
  const gridEnd = css.indexOf('}', gridStart);
  const grid = css.slice(gridStart, gridEnd);

  assert.match(grid, /display: grid/);
  assert.match(grid, /gap: 6px/);
  assert.doesNotMatch(grid, /background|border-radius|grid-template-columns/);
  assert.match(css, /\.maintenance-version-item \{[\s\S]*display: flex;[\s\S]*justify-content: space-between/);
});

test('Tokscale updates surface a localized status in the collapsed Advanced row', () => {
  const app = read('app.js');

  assert.match(app, /advancedSettingsSummary: document\.getElementById\('advancedSettingsSummary'\)/);
  assert.match(app, /state\.tokscaleCheck\?\.newer[\s\S]*'settings\.advanced\.tokscaleUpdate'[\s\S]*'settings\.advanced\.summary'/);
  assert.match(app, /advancedSettingsSummary\.dataset\.i18n = advancedSummaryKey/);
});

test('About uses runtime version and allowlisted Routed Monitoring links', () => {
  const app = read('app.js');

  assert.match(app, /aboutVersion\.textContent = state\.appInfo\?\.version \? `v\$\{state\.appInfo\.version\}` : '—'/);
  assert.match(app, /TOKEN_MONITOR_REPOSITORY_URL = 'https:\/\/github\.com\/Javis603\/router-x-token-monitor'/);
  assert.match(app, /TOKEN_MONITOR_ISSUES_URL = `\$\{TOKEN_MONITOR_REPOSITORY_URL\}\/issues\/new\/choose`/);
  assert.match(app, /TOKEN_MONITOR_WEBSITE_URL = 'https:\/\/javis-ai\.com\/router-x-token-monitor\/'/);
  assert.match(app, /openRepositoryButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_REPOSITORY_URL/);
  assert.match(app, /openWebsiteButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_WEBSITE_URL/);
  assert.match(app, /reportIssueButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_ISSUES_URL/);

  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  assert.match(main, /parsed\.hostname === 'javis-ai\.com'[\s\S]*parsed\.pathname === '\/router-x-token-monitor'/);
});

test('About links stay visually secondary and wrap in narrow settings', () => {
  const css = read('styles.css');

  assert.match(css, /\.about-settings-links \{[\s\S]*flex-wrap: wrap;/);
  assert.match(css, /\.about-settings-links \.inline-link \{ font-size: 10px; \}/);
});
