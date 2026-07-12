'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule should exist`);
  return match[1];
}

const settingsIconAssets = {
  general: 'general.svg',
  main: 'main.svg',
  window: 'window.svg',
  appearance: 'appearance.svg',
  tools: 'collection.svg',
  limits: 'limits.svg',
  accounts: 'accounts.svg',
  sync: 'sync.svg'
};

test('preference drag only selects sortable rows, not nested controls', () => {
  const body = functionBody(readRendererFile('app.js'), 'preferenceRows', 'preferenceOrder');
  assert.match(body, /\.tool-preference-row\[data-client\]/);
  assert.match(body, /\.limit-provider-row\[data-provider\]/);
  assert.match(body, /\.view-preference-row\[data-view\]/);
  assert.doesNotMatch(body, /querySelectorAll\(`\\\[data-\$\{attr\}\\\]`\)/);
});

test('preference drag does not animate row transforms during pointer movement', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  assert.doesNotMatch(app, /animatePreferenceOrderChange/);
  assert.doesNotMatch(app, /translateY\(/);
  assert.doesNotMatch(cssRule(css, '.tool-preference-row'), /transform/);
  assert.doesNotMatch(cssRule(css, '.view-preference-row'), /transform/);
  assert.doesNotMatch(cssRule(css, '.settings-panel .limit-provider-row'), /transform/);
  assert.doesNotMatch(cssRule(css, '.preference-order-handle'), /transition:\s*transform/);
});

test('tool preference controls place compact actions beside the note without duplicate headers', () => {
  const html = readRendererFile('index.html');
  const group = html.match(/<div class="settings-subgroup settings-tools-subgroup">[\s\S]*?<div id="clientDisplayList"/)?.[0] || '';
  assert.match(html, /<div class="settings-group settings-collapsible-group settings-tools-group"/);
  assert.match(group, /<div class="settings-note-row">/);
  assert.match(group, /<p class="settings-note" data-i18n="settings\.tools\.note">[\s\S]*?<div class="tool-header-actions">/);
  assert.match(group, /<div class="tool-header-actions">/);
  assert.match(group, /class="tool-header-action"/);
  assert.doesNotMatch(group, /settings-tools-header/);
  assert.doesNotMatch(group, /settings\.tools\.title/);
  assert.doesNotMatch(group, /<div class="settings-actions tool-settings-actions">/);
  assert.doesNotMatch(group, /class="tool-preference-head"/);
  assert.doesNotMatch(group, /tool-preference-legend-/);

  const css = readRendererFile('styles.css');
  assert.match(cssRule(css, '.settings-note-row'), /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  assert.match(cssRule(css, '.settings-note-row'), /align-items:\s*center/);
  assert.match(cssRule(css, '.tool-preference-row'), /grid-template-columns:\s*minmax\(0,\s*1fr\) repeat\(4,\s*22px\)/);
  assert.match(cssRule(css, '.tool-preference-actions'), /display:\s*contents/);
  assert.doesNotMatch(css, /\.tool-preference-head/);
  assert.doesNotMatch(css, /\.tool-preference-legend-/);
});

test('tool preference rows include compact per-tool pin controls', () => {
  const body = functionBody(readRendererFile('app.js'), 'renderToolPreferences', 'renderLimitProviderCheckboxes');
  assert.match(body, /tool-pin-button/);
  assert.match(body, /settings\.tools\.pinClient/);
  assert.match(body, /settings\.tools\.unpinClient/);
  assert.match(body, /onClientPinnedToggle/);
});

test('view preferences place compact actions beside the note without duplicate headers', () => {
  const html = readRendererFile('index.html');
  const group = html.match(/<div class="settings-subgroup settings-main-screen-group">[\s\S]*?<div id="viewDisplayList"/)?.[0] || '';
  assert.match(html, /<div class="settings-group settings-collapsible-group settings-main-group"/);
  assert.match(group, /<div class="settings-note-row">/);
  assert.match(group, /<p class="settings-note" data-i18n="settings\.views\.note">[\s\S]*?<div class="tool-header-actions">/);
  assert.match(group, /<div class="tool-header-actions">/);
  assert.match(group, /id="resetViewDisplayOrderButton"/);
  assert.match(group, /id="showAllViewsButton"/);
  assert.doesNotMatch(group, /settings-views-header/);
  assert.doesNotMatch(group, /settings\.views\.title/);
  assert.doesNotMatch(group, /viewsSettingsSummary/);
  assert.doesNotMatch(group, /class="view-preference-head"/);

  const body = functionBody(readRendererFile('app.js'), 'renderViewPreferences', 'renderToolPreferences');
  assert.match(body, /view-preference-row/);
  assert.match(body, /settings\.views\.hideView/);
  assert.match(body, /settings\.views\.showView/);
  assert.match(body, /createPreferenceOrderHandle\(\{ kind: 'view'/);
});

test('settings page uses collapsible icon sections with summaries', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /class="settings-section-toggle"/);
  assert.match(html, /class="settings-section-icon settings-section-icon-general"/);
  assert.match(html, /class="settings-section-icon settings-section-icon-main"/);
  assert.match(html, /class="settings-section-icon settings-section-icon-window"/);
  assert.match(html, /class="settings-section-icon settings-section-icon-tools"/);
  assert.match(html, /class="settings-section-icon settings-section-icon-limits"/);
  assert.match(html, /class="settings-section-icon settings-section-icon-accounts"/);
  assert.match(html, /class="settings-section-icon settings-section-icon-sync"/);
  assert.match(html, /id="generalSettingsSummary"/);
  assert.match(html, /id="mainSettingsSummary"/);
  assert.match(html, /id="windowSettingsSummary"/);
  assert.match(html, /id="toolsSettingsSummary"/);
  assert.match(html, /id="limitsSettingsSummary"/);
  assert.match(html, /data-settings-section="general"/);
  assert.match(html, /data-settings-section="main"/);
  assert.match(html, /data-settings-section="window"/);
  assert.match(html, /data-settings-section="appearance"/);
  assert.match(html, /data-settings-section="tools"/);
  assert.match(html, /id="appearanceSettingsSummary"/);
  assert.match(html, /aria-controls="generalSettingsDetails"/);
  assert.match(html, /aria-controls="mainSettingsDetails"/);
  assert.match(html, /aria-controls="windowSettingsDetails"/);
  assert.match(html, /aria-controls="appearanceSettingsDetails"/);

  const app = readRendererFile('app.js');
  assert.match(app, /setupSettingsSections/);
  assert.match(app, /renderSettingsSummaries/);
  assert.match(app, /settingsSectionSummary/);
  assert.match(app, /for \(const other of SETTINGS_SECTION_IDS\)/);
  assert.doesNotMatch(app, /viewsSettingsSummary/);

  const css = readRendererFile('styles.css');
  assert.match(css, /\.settings-section-toggle/);
  assert.match(css, /\.settings-section-icon/);
  assert.match(css, /\.settings-section-summary/);
  assert.match(cssRule(css, '.settings-section-icon'), /mask:\s*var\(--settings-section-icon-url\)/);
  for (const [section, asset] of Object.entries(settingsIconAssets)) {
    assert.match(cssRule(css, `.settings-section-icon-${section}`), new RegExp(`icons/settings/${asset}`));
    assert.ok(fs.existsSync(path.join(rendererDir, 'icons', 'settings', asset)), `${asset} should be local`);
  }
});

test('main section holds views; appearance is its own section; window holds behavior and presence', () => {
  const html = readRendererFile('index.html');

  const main = html.slice(
    html.indexOf('<div id="mainSettingsDetails"'),
    html.indexOf('<div class="settings-group settings-collapsible-group settings-window-section-group"')
  );
  assert.notEqual(main, '', 'main section should exist');
  assert.ok(main.indexOf('settings-main-screen-group') >= 0, 'main screen group should be first-class');
  assert.doesNotMatch(main, /settings-appearance-group/, 'appearance moved out of main');
  assert.match(main, /id="viewDisplayList"/);
  assert.match(main, /id="currencyInput"/);
  assert.doesNotMatch(main, /id="historyEnabledInput"/);
  assert.doesNotMatch(main, /settings\.language\.title/);

  // Appearance is now a top-level section between window and tools, holding the
  // moved glass/zoom controls plus the theme and vendor colour pickers.
  const appearance = html.slice(
    html.indexOf('<div id="appearanceSettingsDetails"'),
    html.indexOf('<div class="settings-group settings-collapsible-group settings-tools-group"')
  );
  assert.notEqual(appearance, '', 'appearance section should exist');
  assert.match(appearance, /id="systemGlassInput"/);
  assert.match(appearance, /id="glassInput"/);
  assert.match(appearance, /id="zoomInput"/);
  assert.match(appearance, /id="themePresetChips"/);
  assert.match(appearance, /id="themeColorGrid"/);
  assert.match(appearance, /id="vendorColorList"/);

  const windowSection = html.slice(
    html.indexOf('<div id="windowSettingsDetails"'),
    html.indexOf('<div class="settings-group settings-collapsible-group settings-appearance-section-group"')
  );
  assert.notEqual(windowSection, '', 'window section should exist');
  const windowIndex = windowSection.indexOf('settings-window-group');
  const presenceIndex = windowSection.indexOf('settings-presence-group');
  assert.ok(windowIndex >= 0, 'window behavior group should be present');
  assert.ok(presenceIndex > windowIndex, 'floating and tray group should follow window');

  const windowGroup = windowSection.match(/<div class="settings-subgroup settings-window-group">[\s\S]*?<div class="settings-subgroup settings-presence-group">/)?.[0] || '';
  assert.match(windowGroup, /id="windowBehaviorInput"/);
  assert.match(windowGroup, /id="windowToggleShortcutRecordButton"/);
  assert.doesNotMatch(windowGroup, /settings\.display\.windowTitle/);
  assert.doesNotMatch(windowGroup, /<div class="settings-group-header"><span data-i18n="settings\.display\.windowTitle">/);
  assert.doesNotMatch(windowGroup, /id="floatingBubbleInput"/);

  const presenceGroup = windowSection.slice(presenceIndex);
  assert.match(presenceGroup, /id="floatingBubbleInput"/);
  assert.match(presenceGroup, /id="showTrayIconInput"/);
  assert.match(presenceGroup, /id="trayModeInput"/);
  assert.equal((presenceGroup.match(/value="limitsAllSessions"/g) || []).length, 2);

  const showTrayIconIndex = presenceGroup.indexOf('id="showTrayIconInput"');
  const trayIconOptionsIndex = presenceGroup.indexOf('id="trayIconOptions"');
  const trayTextIndex = presenceGroup.indexOf('id="trayContentInput"');
  const trayModeIndex = presenceGroup.indexOf('id="trayModeInput"');
  const trayIconOptionsCloseIndex = presenceGroup.indexOf('</div>\n              </div>', trayIconOptionsIndex);
  assert.ok(showTrayIconIndex >= 0, 'show tray icon toggle should be present');
  assert.ok(trayIconOptionsIndex > showTrayIconIndex, 'tray text options should belong to the tray icon toggle');
  assert.ok(trayTextIndex > trayIconOptionsIndex, 'tray text select should be inside tray icon options');
  assert.ok(trayModeIndex > trayIconOptionsIndex, 'tray-only mode should depend on the tray icon toggle');
  assert.ok(trayModeIndex < trayIconOptionsCloseIndex, 'tray-only mode should be inside tray icon options');
  assert.doesNotMatch(
    presenceGroup,
    /id="trayIconOptions"[\s\S]*?<\/div>\s*<label class="checkbox-label"><input id="trayModeInput"/,
    'tray-only mode should not sit beside tray icon options'
  );
});

test('Trends has a master toggle separate from main-screen visibility', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  assert.match(app, /id === 'trends'/);
  assert.match(app, /trendSettingsExpanded/);
  assert.match(app, /function renderTrendSettingsList/);
  assert.match(app, /id = 'trendSettingsList'|id: 'trendSettingsList'|'trendSettingsList'/);
  assert.match(app, /settings\.views\.configureTrend/);
  assert.match(app, /settings\.views\.enableTrend/);
  assert.match(app, /function setTrendEnabled/);
  assert.match(app, /historyEnabled:\s*enabled/);
  assert.match(app, /hiddenViews:\s*nextHiddenViews/);
  assert.match(app, /onTrendVisibilityToggle/);
  assert.match(app, /setTrendEnabled\(true\)/);
  assert.match(app, /row\.classList\.toggle\('is-disabled'/);
  assert.match(css, /\.view-preference-row\.is-disabled/);
  assert.match(css, /\.trend-settings-list/);
});

test('session archive retention has its own setting separate from Trends', () => {
  const app = readRendererFile('app.js');
  const html = readRendererFile('index.html');
  const css = readRendererFile('styles.css');
  const main = readRendererFile('../main.js');
  const agent = readRendererFile('../../agent/agent.js');
  const preload = readRendererFile('../preload.js');
  assert.match(html, /settings-subgroup session-archive-settings/);
  assert.match(html, /id="sessionUsageArchiveInput"/);
  assert.match(html, /id="sessionUsageArchiveStatus"/);
  assert.match(html, /id="clearSessionUsageArchiveButton" class="session-archive-clear"/);
  assert.match(app, /sessionUsageArchiveEnabled:\s*els\.sessionUsageArchiveInput\.checked/);
  assert.doesNotMatch(app, /sessionUsageArchiveCount/);
  assert.match(app, /sessionRowsApi\.archivedSessionCount\(state\.stats\)/);
  assert.match(app, /sessionUsageArchiveEnabled === false[\s\S]{0,160}sessionArchivePaused/);
  assert.doesNotMatch(app, /sessionSettingsExpanded|renderSessionSettingsList/);
  assert.match(css, /\.session-archive-clear\s*\{[\s\S]*?width:\s*auto;[\s\S]*?font-size:\s*10px;/);
  assert.match(main, /sessionUsageArchiveEnabled:\s*parseBoolean\(process\.env\.TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED,\s*true\)/);
  assert.doesNotMatch(main, /sessionUsageArchiveCount:/);
  assert.match(main, /settings\?\.sessionUsageArchiveEnabled === false/);
  assert.match(main, /ipcMain\.handle\('sessionUsageArchive:clear'/);
  assert.match(agent, /TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED,\s*true\)/);
  assert.match(preload, /clearSessionUsageArchive/);
  assert.doesNotMatch(app, /historyEnabled[\s\S]{0,120}sessionUsageArchiveEnabled|sessionUsageArchiveEnabled[\s\S]{0,120}historyEnabled/);
});

test('view visibility changes do not toggle trend history collection', () => {
  const app = readRendererFile('app.js');
  const body = functionBody(app, 'onViewVisibilityToggle', 'onTrendVisibilityToggle');
  assert.match(body, /saveSettings\(\{\s*hiddenViews:/);
  assert.doesNotMatch(body, /historyEnabled/);
});

test('settings saves preserve the settings panel scroll position during rerender', () => {
  const app = readRendererFile('app.js');
  const saveBody = functionBody(app, 'saveSettings', 'updateTitleFit');
  assert.match(app, /function preserveSettingsPanelScroll\(callback\)/);
  assert.match(saveBody, /preserveSettingsPanelScroll\(syncSettingsForm\)/);
  assert.doesNotMatch(saveBody, /\bsyncSettingsForm\(\);/);
});

test('general section owns app-level preferences before startup and updates', () => {
  const html = readRendererFile('index.html');
  const generalSection = html.slice(
    html.indexOf('<div id="generalSettingsDetails"'),
    html.indexOf('<div class="settings-group settings-collapsible-group settings-main-group"')
  );
  assert.match(generalSection, /settings-language-group/);
  assert.ok(generalSection.indexOf('settings-language-group') < generalSection.indexOf('id="startupGroup"'));
  assert.match(generalSection, /id="languageInput"/);
  assert.doesNotMatch(generalSection, /settings\.language\.title/);
  assert.doesNotMatch(generalSection, /id="currencyInput"/);
});

test('sync section icon uses a local sync asset instead of a hand-drawn refresh arrow', () => {
  const html = readRendererFile('index.html');
  const css = readRendererFile('styles.css');
  const icon = html.match(/<span class="settings-section-icon settings-section-icon-sync" aria-hidden="true"><\/span>/)?.[0] || '';
  assert.notEqual(icon, '', 'sync icon should be a local masked icon span');
  assert.match(cssRule(css, '.settings-section-icon-sync'), /icons\/settings\/sync\.svg/);
  assert.doesNotMatch(html, /<svg class="settings-section-icon settings-section-icon-sync"/);
  assert.doesNotMatch(css, /\.settings-section-icon-sync::(?:before|after)/);
  assert.doesNotMatch(cssRule(css, '.settings-section-icon-sync'), /rotate/);
});

test('startup setting stays visible when login items are unsupported', () => {
  const html = readRendererFile('index.html');
  const startupGroup = html.match(/<div id="startupGroup"[\s\S]*?<p id="startupNote"/)?.[0] || '';
  assert.match(startupGroup, /id="startAtLoginInput"/);

  const app = readRendererFile('app.js');
  const syncBody = functionBody(app, 'syncSettingsForm', 'enabledClientSet');
  assert.doesNotMatch(syncBody, /startupGroup\?\.[\s\S]*classList\.toggle\(['"]hidden['"]/);
  assert.match(syncBody, /startAtLoginInput[\s\S]*\.disabled\s*=\s*!state\.appInfo\?\.loginItemSupported/);

  const summaryBody = functionBody(app, 'settingsSectionSummary', 'renderSettingsSummaries');
  assert.match(summaryBody, /settings\.summary\.unavailable/);
});

test('expanded settings sections keep content full width', () => {
  const css = readRendererFile('styles.css');
  const detailsRule = cssRule(css, '.settings-section-details');
  const innerRule = cssRule(css, '.settings-section-details-inner');
  const firstChildRule = cssRule(css, '.settings-section-details-inner > :first-child');
  const lastChildRule = cssRule(css, '.settings-section-details-inner > :last-child');
  assert.match(innerRule, /padding-left:\s*4px/);
  assert.match(firstChildRule, /padding-top:\s*2px/);
  assert.match(lastChildRule, /padding-bottom:\s*10px/);
  assert.doesNotMatch(detailsRule, /padding:\s*[^;]*\s24px\b/);
  assert.doesNotMatch(innerRule, /padding:\s*[^;]*\s24px\b/);
});

test('renderer applies the first visible view on cold startup only', () => {
  const app = readRendererFile('app.js');
  const body = functionBody(app, 'applyInitialBreakdownPreference', 'syncSettingsForm');
  assert.match(body, /initialBreakdownPreferenceApplied/);
  assert.match(body, /preferFirst:\s*true/);
  assert.match(body, /preferredViewId/);

  const syncBody = functionBody(app, 'syncSettingsForm', 'enabledClientSet');
  assert.match(syncBody, /applyInitialBreakdownPreference\(\)/);
});
