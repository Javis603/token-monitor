'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const rendererDir = path.join(rootDir, 'src', 'electron', 'renderer');

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readRendererFile(name) {
  return readFile(path.join(rendererDir, name));
}

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  return source.slice(start, end);
}

function cssRule(source, selector) {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`).exec(source);
  assert.ok(match, `${selector} rule should exist`);
  return match[1];
}

test('renderer includes a dedicated service status panel and Status view option', () => {
  const html = readRendererFile('index.html');
  const app = readRendererFile('app.js');

  assert.match(html, /<section id="serviceStatusPanel" class="service-status-panel hidden"><\/section>/);
  assert.match(html, /<script src="serviceStatusPresentation\.js"><\/script>/);
  assert.match(app, /\{ id: 'status', labelKey: 'views\.status' \}/);
  assert.match(app, /viewBreakdownValues = new Set\(\['home', \.\.\.baseBreakdownOrder, 'status', 'limits', 'trends'\]\)/);
  // Placeholders cover every provider so the rows render before the first fetch.
  assert.match(app, /label: 'Cursor'/);
  assert.match(app, /label: 'DeepSeek'/);
});

test('renderer surfaces affected component names through the presentation helper', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /serviceStatusPresentationApi\.affectedComponentNames/);
});

test('the status description line leads with the active incident headline', () => {
  const app = readRendererFile('app.js');
  const renderBody = functionBody(app, 'renderServiceStatus', 'refreshServiceStatus');
  assert.match(renderBody, /serviceStatusPresentationApi\.statusHeadline/);
});

test('the meta line shows an affected-component count, not the verbose name list', () => {
  const app = readRendererFile('app.js');
  // The component names made the meta line overflow; the full list now lives only
  // in the row tooltip (meta.title), so the dedicated name-joining helper is gone.
  assert.doesNotMatch(app, /function serviceStatusComponentText/);
  const metaBody = functionBody(app, 'serviceStatusMeta', 'visibleServiceProviderIds');
  // A short count keeps the real scope visible (an incident title can understate
  // it) without reintroducing the overflow that the joined name list caused.
  assert.match(metaBody, /serviceStatus\.components/);
  assert.doesNotMatch(metaBody, /listSeparator/);
});

test('renderer fetches service status only through preload IPC', () => {
  const app = readRendererFile('app.js');
  const renderBody = functionBody(app, 'renderServiceStatus', 'refreshServiceStatus');
  const refreshBody = functionBody(app, 'refreshServiceStatus', 'formatAgo');

  assert.match(renderBody, /service-status-row/);
  assert.match(refreshBody, /window\.tokenMonitor\.getServiceStatus/);
  assert.doesNotMatch(app, /fetch\(['"]https:\/\/status\./);
});

test('preload and main expose service status IPC with status page allowlist', () => {
  const preload = readFile(path.join(rootDir, 'src', 'electron', 'preload.js'));
  const main = readFile(path.join(rootDir, 'src', 'electron', 'main.js'));

  assert.match(preload, /getServiceStatus: \(options\) => ipcRenderer\.invoke\('serviceStatus:get', options\)/);
  assert.match(main, /ipcMain\.handle\('serviceStatus:get'/);
  // The open-external allowlist is derived from the provider list rather than
  // duplicating each status hostname, so new providers stay openable for free.
  assert.match(main, /SERVICE_STATUS_PROVIDERS/);
  assert.match(main, /STATUS_PAGE_HOSTS/);
  // Hidden providers must not be fetched: the handler forwards providerIds and
  // the two preference keys are persisted.
  assert.match(main, /providerIds: Array\.isArray\(options\?\.providerIds\)/);
  assert.match(main, /serviceProviderDisplayOrder/);
  assert.match(main, /hiddenServiceProviders/);
  assert.match(main, /normalizeServiceStatusRefreshMs/);
});

test('statusProvider drag kind is wired into the preference helpers', () => {
  const app = readRendererFile('app.js');
  const html = readRendererFile('index.html');
  assert.match(app, /kind === 'statusProvider'/);
  // closest() used by the drag start must recognise the nested provider rows.
  assert.match(app, /\[data-status-provider\]/);
  assert.match(app, /onServiceProviderVisibilityToggle/);
  // The prefs module must be loaded before the renderer uses its API.
  assert.match(html, /<script src="serviceStatusProviderPreferences\.js"><\/script>/);
});

test('the 狀態 view row is expandable and renders a nested provider sub-list', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  assert.match(app, /serviceProvidersExpanded/);
  assert.match(app, /id = 'serviceProviderList'|id: 'serviceProviderList'|'serviceProviderList'/);
  assert.match(app, /status-provider-row/);
  assert.match(app, /function renderServiceProviderList/);
  // The chevron adds a third trailing control, so the status row needs an
  // extra grid column or its drag handle wraps to a new line.
  assert.match(app, /has-subgroup/);
  assert.match(css, /\.view-preference-row\.has-subgroup/);
  // The "show all" header uses the same CSS outline eye as the other lists,
  // not the filled visibilityIcon SVG (which renders as a solid blob here).
  assert.match(app, /tool-header-eye/);
});

test('view drag query does not select the nested status-provider rows', () => {
  // The sub-list rows use a distinct class/attribute, so the view selector skips them.
  const app = readRendererFile('app.js');
  assert.doesNotMatch(app, /\.view-preference-row\[data-status-provider\]/);
});

test('the Status panel passes the visible provider ids to the fetch and orders by prefs', () => {
  const app = readRendererFile('app.js');
  const refreshBody = functionBody(app, 'refreshServiceStatus', 'formatAgo');
  assert.match(refreshBody, /providerIds:/);
  assert.match(app, /function visibleServiceProviderIds/);
  assert.match(app, /serviceStatus\.allHidden/);
});

test('the status view uses a dedicated ticker and relative timestamps', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /function ensureServiceStatusTicker/);
  assert.match(app, /function onServiceStatusTick/);
  assert.match(app, /service-status-checked/);
  assert.match(app, /function formatAgo/);
  // The old piggyback mechanism is gone.
  assert.doesNotMatch(app, /SERVICE_STATUS_MIN_REFRESH_MS/);
  assert.doesNotMatch(app, /function maybeRefreshServiceStatus/);
});

test('the provider sub-section includes a re-check interval select', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /serviceStatusRefreshSelect/);
  assert.match(app, /serviceStatusRefreshMs: Number/);
});

test('status rows can show provider icons gated by showToolIcons', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /function serviceStatusIconId/);
  assert.match(app, /showToolIcons/);
});

test('Home overview list markers use the shared tool icon path when enabled', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /function applyHomeListMark/);
  assert.match(app, /iconKindFor\(\{ key: row\.providerId \|\| row\.key \}, 'limits'\)/);
  assert.match(app, /iconKindFor\(\{ key: row\.key \|\| row\.name \}, 'model'\)/);
  assert.match(app, /home-list-mark row-icon/);
});

test('Home activity heatmap lets vertical wheel gestures bubble to native Home scrolling', () => {
  const app = readRendererFile('app.js');
  const setupBody = functionBody(app, 'setupHomeActivityScroller', 'renderHomeTrendsModule');
  assert.doesNotMatch(setupBody, /addEventListener\('wheel'/);
  assert.doesNotMatch(setupBody, /closest\('\.home-panel'\)/);
  assert.doesNotMatch(setupBody, /homeActivityWheelDelta\(event/);
  assert.doesNotMatch(setupBody, /homePanel\.scrollTop/);
  assert.doesNotMatch(setupBody, /scrollLeft \+= event\.deltaY/);
});

test('Home activity heatmap contains horizontal overscroll and prevents native pointer drag side effects', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const setupBody = functionBody(app, 'setupHomeActivityScroller', 'renderHomeTrendsModule');
  assert.match(cssRule(css, '.home-activity-scroll'), /overscroll-behavior-x:\s*contain/);
  assert.match(setupBody, /pointerdown[\s\S]*event\.preventDefault\(\)/);
  assert.match(setupBody, /pointermove[\s\S]*event\.preventDefault\(\)/);
});

test('Home model rows align icon spacing with the limit account rows', () => {
  const css = readRendererFile('styles.css');
  assert.match(cssRule(css, '.home-limit-account-head'), /gap:\s*8px/);
  assert.match(cssRule(css, '.home-model-row'), /column-gap:\s*8px/);
});

test('Home tool and device metric columns align with the model summary rows', () => {
  const css = readRendererFile('styles.css');
  assert.match(cssRule(css, '.home-tool-row'), /grid-template-columns:\s*10px minmax\(0, 1fr\) minmax\(42px, auto\) minmax\(31px, auto\)/);
  assert.match(cssRule(css, '.home-device-row'), /grid-template-columns:\s*10px minmax\(0, 1fr\) minmax\(42px, auto\)/);
  assert.match(cssRule(css, '.home-device-label'), /inline-flex/);
  assert.match(cssRule(css, '.home-device-badge'), /flex:\s*0 0 auto/);
  assert.match(cssRule(css, '.home-device-badge,\n.row.local .row-name::after'), /letter-spacing:\s*0\.04em/);
  assert.match(cssRule(css, '.home-device-badge,\n.row.local .row-name::after'), /text-transform:\s*uppercase/);
  assert.match(cssRule(css, '.home-device-row.is-stale .home-device-name,\n.home-device-row.is-stale .home-list-value'), /color:\s*var\(--muted\)/);
});

test('Home module jump icons align optically with their titles', () => {
  const css = readRendererFile('styles.css');
  assert.match(cssRule(css, '.home-module-head'), /align-items:\s*center/);
  assert.match(cssRule(css, '.home-module-jump'), /margin-top:\s*0/);
  assert.match(cssRule(css, '.home-module-jump'), /transform:\s*translateY\(-1px\)/);
});

test('Home limit percentages use the compact Limits view typography', () => {
  const css = readRendererFile('styles.css');
  assert.match(cssRule(css, '.home-limit-window .home-list-value'), /font-size:\s*10px/);
  assert.match(cssRule(css, '.home-limit-window .home-list-value'), /line-height:\s*1\.1/);
});

test('Home billing-only limit rows span the full summary width', () => {
  const css = readRendererFile('styles.css');
  assert.match(cssRule(css, '.home-limit-window:only-child'), /grid-column:\s*1 \/ -1/);
  assert.match(cssRule(css, '.home-limit-window:only-child'), /max-width:\s*none/);
});

test('Home limit provider settings stay compact and list only enabled providers', () => {
  const app = readRendererFile('app.js');
  const i18n = readRendererFile('i18n.js');
  const homeLimitRows = functionBody(app, 'homeLimitRows', 'homeLimitWindowLabel');
  const renderHomeLimitProviderList = functionBody(app, 'renderHomeLimitProviderList', 'renderHomeSettingsList');
  const resetHomeLimitProviderOrder = functionBody(app, 'resetHomeLimitProviderOrder', 'showAllHomeLimitProviders');
  assert.match(homeLimitRows, /const hasConfiguredOrder = Boolean\(state\.settings\?\.homeLimitProviderOrder\)/);
  assert.doesNotMatch(homeLimitRows, /normalizeLimitProviderOrder\(state\.settings\?\.limitProviderOrder, LIMIT_PROVIDERS\)\.join\(','\) !== DEFAULT_LIMIT_PROVIDER_ORDER/);
  assert.match(homeLimitRows, /sort: hasConfiguredOrder \? 'configured' : 'remaining'/);
  assert.match(homeLimitRows, /homeLimitAccountTitle\(id, provider, index\)/);
  assert.match(homeLimitRows, /showHomeLimitProviderNames === true \|\| state\.settings\?\.showToolIcons === false/);
  assert.match(homeLimitRows, /`\$\{providerTitle\} · \$\{accountTitle\}`/);
  assert.match(renderHomeLimitProviderList, /enabledLimitProviderSet\(\)/);
  assert.match(renderHomeLimitProviderList, /orderedLimitProviders\(LIMIT_PROVIDERS, homeLimitProviderOrderValue\(\)\)/);
  assert.match(renderHomeLimitProviderList, /const hasCustomOrder = Boolean\(state\.settings\?\.homeLimitProviderOrder\);/);
  assert.match(renderHomeLimitProviderList, /\.filter\(\(\{ id \}\) => enabled\.has\(id\)\)/);
  assert.match(resetHomeLimitProviderOrder, /saveSettings\(\{ homeLimitProviderOrder: '' \}\)/);
  assert.match(i18n, /Default is least remaining first/);
  assert.match(i18n, /預設按剩餘額度最少優先/);
  assert.match(i18n, /默认按剩余额度最少优先/);
  assert.doesNotMatch(renderHomeLimitProviderList, /limitProviderSettingsTags/);
  assert.doesNotMatch(renderHomeLimitProviderList, /limit-provider-tag/);
});

test('Home limit provider settings expand with the shared accordion transition', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const renderHomeSettingsList = functionBody(app, 'renderHomeSettingsList', 'renderTrendSettingsList');
  assert.match(renderHomeSettingsList, /homeLimitProviderContainer/);
  assert.match(renderHomeSettingsList, /accordion-animated-container\$\{state\.homeLimitSettingsExpanded \? '' : ' hidden'\}/);
  assert.match(renderHomeSettingsList, /accordion-animation-inner/);
  assert.match(renderHomeSettingsList, /container\.classList\.toggle\('hidden', !state\.homeLimitSettingsExpanded\)/);
  assert.doesNotMatch(renderHomeSettingsList, /if \(id === 'limits' && state\.homeLimitSettingsExpanded\) wrap\.append\(renderHomeLimitProviderList\(\)\)/);
  assert.match(css, /\.home-settings-list,\s*\.home-limit-provider-list,\s*\.cursor-settings-details-inner/);
  assert.match(css, /\.home-settings-list > \* \+ \*,\s*\.home-limit-provider-list > \* \+ \*/);
  assert.doesNotMatch(cssRule(css, '.home-settings-list'), /gap:\s*6px/);
});

test('view switcher preserves click-to-cycle and direct selection without crowding settings', () => {
  const html = readRendererFile('index.html');
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const setViewSwitcherOpenBody = functionBody(app, 'setViewSwitcherOpen', 'renderViewSwitcher');
  assert.match(html, /id="viewSwitcher" class="view-switcher"/);
  assert.doesNotMatch(html, /id="viewDock"/);
  assert.match(app, /function nextBreakdown/);
  assert.match(app, /function updateViewSwitcherOpenState/);
  assert.match(app, /function renderViewSwitcher/);
  assert.match(app, /view-switcher-current/);
  assert.match(app, /view-switcher-disclosure/);
  assert.match(app, /view-switcher-menu-item/);
  assert.match(app, /contextmenu/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /disclosure\.addEventListener\('pointerenter'/);
  assert.match(app, /event\.pointerType !== 'mouse'/);
  assert.match(app, /event\.detail > 0 && state\.viewSwitcherOpen/);
  assert.match(app, /els\.viewSwitcher\?\.addEventListener\('pointerleave'/);
  assert.match(app, /viewSwitcherHasOpened/);
  assert.match(app, /menu\.setAttribute\('aria-hidden', String\(!state\.viewSwitcherOpen\)\)/);
  assert.match(app, /item\.tabIndex = state\.viewSwitcherOpen \? \(active \? 0 : -1\) : -1/);
  assert.match(setViewSwitcherOpenBody, /if \(updateViewSwitcherOpenState\(\{ focusMenu, focusDisclosure \}\)\) return/);
  assert.doesNotMatch(app, /function viewDockIsCompact/);
  assert.doesNotMatch(app, /VIEW_DOCK_METRICS/);
  assert.match(cssRule(css, '.view-switcher'), /flex:\s*0 1 auto/);
  assert.match(cssRule(css, '.view-switcher-current'), /min-width:\s*0/);
  assert.match(cssRule(css, '.view-switcher-current'), /color:\s*var\(--muted\)/);
  assert.doesNotMatch(cssRule(css, '.view-switcher-current'), /color:\s*var\(--accent\)/);
  assert.match(cssRule(css, '.view-switcher-disclosure'), /flex:\s*0 0 24px/);
  assert.match(cssRule(css, '.view-switcher-menu'), /position:\s*absolute/);
  assert.match(cssRule(css, '.view-switcher-menu'), /width:\s*100%/);
  assert.match(cssRule(css, '.view-switcher-menu'), /max-height:\s*min\(280px, calc\(100vh - 84px\)\)/);
  assert.match(cssRule(css, '.view-switcher-menu'), /transform-origin:\s*left bottom/);
  assert.match(cssRule(css, '.view-switcher-menu'), /transition:[\s\S]*opacity 190ms/);
  assert.match(cssRule(css, '.view-switcher-menu'), /visibility 0s linear 0s/);
  assert.doesNotMatch(cssRule(css, '.view-switcher-menu'), /width:\s*154px/);
  assert.match(cssRule(css, '.view-switcher-menu'), /background:[\s\S]*var\(--glass-rgb\)/);
  assert.doesNotMatch(cssRule(css, '.view-switcher-menu'), /var\(--panel-rgb\)/);
  assert.doesNotMatch(cssRule(css, '.view-switcher-menu.hidden'), /display:\s*none/);
  assert.match(cssRule(css, '.view-switcher-menu.hidden'), /transition-duration:\s*130ms, 130ms, 130ms, 0s/);
  assert.match(cssRule(css, '.view-switcher-menu.hidden'), /transition-delay:\s*0s, 0s, 0s, 130ms/);
  assert.doesNotMatch(css, /@keyframes viewSwitcherMenuIn/);
  assert.doesNotMatch(css, /@keyframes viewSwitcherMenuOut/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.view-switcher-menu/);
  assert.match(cssRule(css, '.view-switcher-menu-item'), /grid-template-columns:\s*16px minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /\.view-switcher-menu-item\.is-current::after/);
  assert.match(cssRule(css, '.utility-actions'), /flex:\s*0 0 34px/);
  assert.match(cssRule(css, '.utility-actions .refresh-button'), /position:\s*absolute/);
  assert.match(cssRule(css, '.utility-actions .refresh-button'), /right:\s*calc\(100% \+ 6px\)/);
  assert.doesNotMatch(css, /@media \(max-width: 280px\)[\s\S]*\.view-switcher-current > \.view-switcher-icon/);
  assert.match(cssRule(css, '.view-switcher-icon'), /flex:\s*0 0 auto/);
  assert.doesNotMatch(css, /\.view-dock/);
});

test('Home-launched secondary views expose an accessible return action', () => {
  const html = readRendererFile('index.html');
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const homeModuleShellBody = functionBody(app, 'homeModuleShell', 'renderHomeLimitModule');
  const setBreakdownBody = functionBody(app, 'setBreakdown', 'renderBreakdownChange');

  assert.match(html, /id="viewBackRow" class="view-back-row hidden"/);
  assert.match(html, /id="backHomeButton"[^>]*data-i18n-title="views\.backHome"[^>]*data-i18n-aria-label="views\.backHome"/);
  assert.match(html, /class="back-home-icon" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(html, /class="back-home-icon"[^>]*>←<\/span>/);
  assert.match(app, /state\.homeReturnVisible = false/);
  assert.match(homeModuleShellBody, /renderBreakdownChange\(viewId, \{ fromHome: true \}\)/);
  assert.equal((homeModuleShellBody.match(/\{ fromHome: true \}/g) || []).length, 2);
  assert.match(setBreakdownBody, /state\.homeReturnVisible = options\.fromHome === true && state\.breakdown === 'home' && next !== 'home'/);
  assert.match(app, /els\.viewBackRow\?\.classList\.toggle\('hidden', state\.breakdown === 'home' \|\| !state\.homeReturnVisible\)/);
  assert.match(app, /els\.backHomeButton\?\.addEventListener\('click',[\s\S]*?renderBreakdownChange\('home'\)/);
  const backRowRule = cssRule(css, '.view-back-row');
  const backButtonRule = cssRule(css, '.back-home-button');
  const backInteractionRule = cssRule(css, '.back-home-button:hover,\n.back-home-button:active');
  const backIconRule = cssRule(css, '.back-home-icon');
  assert.match(backRowRule, /min-height:\s*26px/);
  assert.match(backRowRule, /padding:\s*0\s*;/);
  assert.match(cssRule(css, '.view-back-row.hidden'), /display:\s*none/);
  assert.match(backButtonRule, /height:\s*26px/);
  assert.match(backButtonRule, /margin-left:\s*0\s*;/);
  assert.match(backButtonRule, /padding:\s*0 6px 0 0\s*;/);
  assert.match(backInteractionRule, /color:\s*var\(--text\)/);
  assert.doesNotMatch(backInteractionRule, /background:/);
  assert.match(cssRule(css, '.back-home-button:focus-visible'), /outline:\s*2px solid/);
  assert.match(backIconRule, /width:\s*12px/);
  assert.match(backIconRule, /flex:\s*0 0 12px/);
  assert.match(backIconRule, /mask:\s*url\("icons\/actions\/arrow-left\.svg"\)/);
  assert.match(backIconRule, /transform:\s*translateX\(-2px\)/);
});

test('Projects view separates visibility from metadata collection', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /state\.projectSettingsExpanded = false/);
  assert.match(app, /id === 'project' && !projectsEnabled/);
  assert.match(app, /projectSettingsContainer/);
  assert.match(app, /function renderProjectSettingsList/);
  assert.match(app, /settings\.views\.enableProjects/);
  assert.match(app, /function setProjectsEnabled/);
  assert.match(app, /saveSettings\(\{ projectsEnabled: false \}\)/);
  assert.match(app, /hidden\.delete\('project'\)/);
  assert.match(app, /function onProjectVisibilityToggle/);
});

test('project identity helpers load before the Projects row renderer', () => {
  const html = readRendererFile('index.html');
  const projectKeyIndex = html.indexOf('../../shared/projectKey.js');
  const projectRowsIndex = html.indexOf('projectRows.js');
  assert.ok(projectKeyIndex >= 0);
  assert.ok(projectRowsIndex >= 0);
  assert.ok(projectKeyIndex < projectRowsIndex);
});

test('Projects TOTAL view explains an incomplete cross-device breakdown', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  assert.match(app, /projectRowsApi\.projectBreakdownIncomplete\(state\.stats, state\.period\)/);
  assert.match(app, /hint\.className = 'breakdown-incomplete-hint'/);
  assert.doesNotMatch(app, /hint\.dataset\.key/);
  assert.match(app, /children\.filter\(\(child\) => child !== existingHint\)/);
  assert.match(app, /JSON\.stringify\(\[state\.breakdown, hintText, rows\.map\(\(row\) => row\.key\)\]\)/);
  assert.match(app, /hint\.setAttribute\('role', 'status'\)/);
  assert.match(app, /incompleteHint = 'projects\.incomplete'/);
  assert.match(app, /incompleteHint = 'sessions\.incomplete'/);
  assert.match(app, /t\(incompleteHint\)/);
  assert.match(cssRule(css, '.breakdown-incomplete-hint'), /color:\s*var\(--muted\)/);
});

test('project rows use a fuller icon without changing the navigation icon', () => {
  const css = readRendererFile('styles.css');
  assert.match(css, /\.view-icon-project\s*\{[^}]*icons\/views\/project\.svg/);
  assert.match(css, /\.row-icon-project\s*\{[^}]*icons\/views\/project-row\.svg/);
});

test('row accordions expose keyboard and aria interactions', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /function toggleAccordionRow/);
  assert.match(app, /function setAttributeIfChanged/);
  assert.match(app, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(app, /row\.tabIndex = 0/);
  assert.match(app, /setAttributeIfChanged\(row, 'role', 'button'\)/);
  assert.match(app, /setAttributeIfChanged\(row, 'aria-expanded'/);
  assert.match(app, /setAttributeIfChanged\(row, 'aria-label', `\$\{name\}, \$\{t\('dashboard\.stat\.totalTokens'\)\}/);
  assert.match(app, /\$\{t\('dashboard\.stat\.totalCost'\)\}: \$\{formatCost\(cost \|\| 0\)\}/);
  assert.match(app, /row\.removeAttribute\('aria-label'\)/);
});

test('project accordions retain unchanged DOM between live refreshes', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /accordionSignature = JSON\.stringify/);
  assert.match(app, /accordionInner\.dataset\.signature !== accordionSignature/);
  assert.match(app, /accordionInner\.dataset\.signature = accordionSignature/);
});
