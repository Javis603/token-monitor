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

test('About uses runtime version and allowlisted Token Monitor links', () => {
  const app = read('app.js');

  assert.match(app, /aboutVersion\.textContent = state\.appInfo\?\.version \? `v\$\{state\.appInfo\.version\}` : '—'/);
  assert.match(app, /TOKEN_MONITOR_REPOSITORY_URL = 'https:\/\/github\.com\/Javis603\/token-monitor'/);
  assert.match(app, /TOKEN_MONITOR_ISSUES_URL = `\$\{TOKEN_MONITOR_REPOSITORY_URL\}\/issues\/new\/choose`/);
  assert.match(app, /TOKEN_MONITOR_WEBSITE_URL = 'https:\/\/javis-ai\.com\/token-monitor\/'/);
  assert.match(app, /openRepositoryButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_REPOSITORY_URL/);
  assert.match(app, /openWebsiteButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_WEBSITE_URL/);
  assert.match(app, /reportIssueButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_ISSUES_URL/);

  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  assert.match(main, /parsed\.hostname === 'javis-ai\.com'[\s\S]*parsed\.pathname === '\/token-monitor'/);
});

test('About links stay visually secondary and wrap in narrow settings', () => {
  const css = read('styles.css');

  assert.match(css, /\.about-settings-links \{[\s\S]*flex-wrap: wrap;/);
  assert.match(css, /\.about-settings-links \.inline-link \{ font-size: 10px; \}/);
});

test('About diagnostics open from the support links and separate generate, view and copy actions', () => {
  const html = read('index.html');
  const about = html.match(/<div class="settings-subgroup about-settings">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)?.[0] || '';

  assert.match(about, /id="diagnosticToggleButton"[\s\S]*settings\.about\.diagnostics\.toggle[\s\S]*aria-controls="diagnosticDetails"/);
  assert.match(about, /id="diagnosticDetails" class="about-settings-diagnostics accordion-animated-container hidden"[^>]*inert/);
  assert.match(about, /class="accordion-animation-inner about-settings-diagnostics-inner"/);
  assert.match(about, /id="generateDiagnosticButton"[\s\S]*settings\.about\.diagnostics\.generate/);
  assert.match(about, /id="copyDiagnosticButton"[^>]*class="hidden"[\s\S]*settings\.about\.diagnostics\.copy/);
  assert.match(about, /id="previewDiagnosticButton"[^>]*class="inline-link hidden"[\s\S]*settings\.about\.diagnostics\.preview/);
  assert.doesNotMatch(about, /id="closeDiagnosticPreviewButton"/);
  assert.doesNotMatch(about, /id="diagnosticGeneratedAt"/);
  assert.match(about, /id="diagnosticPreview" class="diagnostic-preview hidden"[^>]*aria-hidden="true"[^>]*inert/);
  assert.ok(about.indexOf('id="reportIssueButton"') < about.indexOf('id="diagnosticToggleButton"'));
  assert.match(about, /data-i18n="settings\.about\.diagnostics\.privacy"/);
  assert.ok(html.indexOf('src="diagnosticsPanel.js"') < html.indexOf('src="app.js"'));

  const app = read('app.js');
  const panel = read('diagnosticsPanel.js');
  assert.match(app, /const diagnosticsPanel = window\.TokenMonitorDiagnosticsPanel\?\.createDiagnosticsPanel\(/);
  assert.match(app, /diagnosticsPanel\?\.render\(\)/);
  assert.doesNotMatch(app, /state\.diagnostics(?:Busy|DetailsOpen|Text|GeneratedAt|PreviewOpen|StatusKey|StatusTone)/);
  assert.match(panel, /async function requestReport\([\s\S]*generateDiagnosticReport/);
  assert.match(panel, /async function ensureReport\([\s\S]*state\.busy/);
  assert.match(panel, /function toggleDetails\([\s\S]*state\.detailsOpen/);
  assert.match(panel, /state\.busy = true[\s\S]*render\(\)/);
  assert.match(panel, /generate: \(\) => ensureReport\(\{ openPreview: true \}\)/);
  assert.match(panel, /regenerate: \(\) => ensureReport\(\{ force: true, openPreview: true \}\)/);
  assert.match(panel, /previewButton\.textContent = state\.previewOpen[\s\S]*settings\.about\.diagnostics\.hidePreview/);
  assert.match(panel, /function togglePreview\([\s\S]*state\.previewOpen = !state\.previewOpen/);
  assert.match(panel, /elements\.generate\?\.addEventListener\('click'/);
  assert.match(panel, /elements\.copy\?\.addEventListener\('click'/);
  assert.doesNotMatch(app, /closeDiagnosticPreviewButton|function closeDiagnosticPreview/);
  assert.doesNotMatch(panel, /diagnosticGeneratedAt/);
});

test('Diagnostic disclosure uses the shared accordion transition and compact preview styling', () => {
  const css = read('styles.css');

  assert.match(css, /\.about-settings-diagnostics \{[\s\S]*transition: grid-template-rows 250ms cubic-bezier/);
  assert.match(css, /\.about-settings-diagnostics\.hidden \{[\s\S]*padding-top: 0;[\s\S]*border-top-color: transparent;/);
  assert.doesNotMatch(css, /\.about-settings-diagnostics\.hidden,\s*\.diagnostic-preview\.hidden \{ display: none; \}/);
  assert.match(css, /#diagnosticReportText \{[\s\S]*max-height: 260px;[\s\S]*overflow: auto;/);
  assert.match(css, /\.diagnostic-actions button:disabled[\s\S]*opacity: 0\.45/);
});
