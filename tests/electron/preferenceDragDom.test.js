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

test('tool diagnostics summarize complete health and render three semantic groups', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const summary = functionBody(app, 'settingsSectionSummary', 'renderSettingsSummaries');
  const group = functionBody(app, 'clientHealthGroup', 'localDayKey');
  const actions = functionBody(app, 'clientHealthActions', 'clientHealthPanel');
  const panel = functionBody(app, 'clientHealthPanel', 'localWslStatus');
  const statsStart = app.indexOf('function renderStatsUpdate(');
  const statsEnd = app.indexOf('const statsRenderScheduler', statsStart);
  assert.notEqual(statsStart, -1);
  assert.notEqual(statsEnd, -1);
  const stats = app.slice(statsStart, statsEnd);

  assert.match(summary, /clientHealthCountsForTracked\([\s\S]*localClientHealth\(\)[\s\S]*enabledClientSet\(\)/);
  assert.match(summary, /if \(counts\) return t\('settings\.summary\.toolsHealth'/);
  assert.match(summary, /return t\('settings\.summary\.tools'/);
  assert.match(group, /group\.id === 'source'/);
  assert.match(group, /group\.id === 'collection'/);
  assert.match(group, /pathInfo\.exists \? ' found' : pathInfo\.pending \? ' pending'/);
  assert.match(actions, /role', 'status'/);
  assert.match(actions, /aria-live', 'polite'/);
  assert.match(actions, /state\.clientRescans\.snapshot\(clientId\)/);
  assert.match(actions, /state\.clientRescans\.begin\(clientId\)/);
  assert.match(actions, /state\.clientRescans\.finish\(clientId, requestId, succeeded\)/);
  assert.match(actions, /rescan\.disabled = rescanState\.pending/);
  assert.match(panel, /for \(const group of detail\.groups\)/);
  assert.match(panel, /note\.group === group\.id/);
  assert.match(stats, /renderSettingsSummaries\(\)/);
  assert.match(cssRule(css, '.tool-health-group'), /grid-template-columns:\s*58px minmax\(0,\s*1fr\)/);
  assert.match(cssRule(css, '.tool-health-group + .tool-health-group'), /border-top/);
});

test('tool diagnostics bind source values to the full health snapshot key', () => {
  const app = readRendererFile('app.js');
  const identity = functionBody(app, 'clientSourcesIdentity', 'exactLocalClientSources');
  const exactReader = functionBody(app, 'exactLocalClientSources', 'localClientSources');
  const reader = functionBody(app, 'localClientSources', 'loadClientSources');
  const loader = functionBody(app, 'loadClientSources', 'refillOpenClientHealthPanel');
  const expand = functionBody(app, 'setClientHealthExpanded', 'clientPeriodUsage');
  const actions = functionBody(app, 'clientHealthActions', 'clientHealthPanel');

  assert.match(identity, /deviceId[\s\S]*clientId[\s\S]*observedAt/);
  assert.match(identity, /clientHealthPresentationApi\.hasClientHealth\(health, id\)/);
  assert.match(exactReader, /clientSourceCacheApi\.readClientSources/);
  assert.match(reader, /state\.clientSourcesKey === key[\s\S]*readLatestClientSources/);
  assert.match(loader, /clientSourceCacheApi\.clientSourceRequestKey\(identity\)/);
  assert.doesNotMatch(loader, /deleteClientSources/);
  assert.match(loader, /clientSourceCacheApi\.writeClientSources/);
  assert.match(loader, /catch[\s\S]*state\.clientSourcesKey = ''[\s\S]*refillOpenClientHealthPanel\(\)/);
  assert.match(loader, /return true;/);
  assert.match(expand, /if \(open\)[\s\S]*loadClientSources\(row\.dataset\.client, \{ force \}\)/);
  assert.match(actions, /succeeded = await window\.tokenMonitor\.rescanClient\(clientId\) === true/);
  assert.match(actions, /if \(succeeded\) loadClientSources/);
  assert.match(actions, /rescan\.id = `toolHealthRescan-\$\{clientId\}`/);
  assert.match(actions, /reveal\.id = `toolHealthReveal-\$\{clientId\}`/);
  assert.match(actions, /exactLocalClientSources\(clientId\)/);
  assert.doesNotMatch(app, /clientSourceIds/);
});

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
  sync: 'sync.svg'
};

test('preference drag only selects sortable rows, not nested controls', () => {
  const body = functionBody(readRendererFile('app.js'), 'preferenceRows', 'preferenceOrder');
  assert.match(body, /\.tool-preference-row\[data-client\]/);
  assert.match(body, /\.limit-provider-row\[data-provider\]/);
  assert.match(body, /\.view-preference-row\[data-view\]/);
  assert.doesNotMatch(body, /querySelectorAll\(`\\\[data-\$\{attr\}\\\]`\)/);
});

// The handle-based lists still reorder by moving DOM nodes as the pointer
// travels, with no transform animation. The two whole-row lists moved to the
// transform model and carry their own guards in limitProviderDrag.test.js.
test('handle-based preference drag does not animate row transforms during pointer movement', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  assert.doesNotMatch(app, /animatePreferenceOrderChange/);
  assert.doesNotMatch(app, /translateY\(/);
  assert.doesNotMatch(cssRule(css, '.view-preference-row'), /transform/);
  assert.doesNotMatch(cssRule(css, '.preference-order-handle'), /transition:\s*transform/);
});

test('tool preference controls place compact actions beside the note without duplicate headers', () => {
  const app = readRendererFile('app.js');
  const body = functionBody(app, 'renderToolPreferencesNow', 'connectLimitProviderCheckboxName');
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
  // The track checkbox gets its own leading cell; visibility and pin stay on the right.
  assert.match(cssRule(css, '.tool-preference-row'), /grid-template-columns:\s*22px minmax\(0,\s*1fr\) repeat\(2,\s*22px\)/);
  assert.match(cssRule(css, '.tool-preference-actions'), /display:\s*contents/);
  assert.match(body, /actions\.append\(visibility, pin\);/);
  assert.match(body, /row\.append\(track, labelGroup, actions(?:, panel)?\);/);
  assert.doesNotMatch(body, /actions\.append\(track/);
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

test('tool preference rows drag from the row itself, not a handle', () => {
  const app = readRendererFile('app.js');
  const body = functionBody(app, 'renderToolPreferencesNow', 'connectLimitProviderCheckboxName');
  assert.doesNotMatch(body, /createPreferenceOrderHandle/);
  // The row the controller is told to look for is the row this builds.
  assert.match(body, /row\.className = 'tool-preference-row';/);
  assert.match(body, /row\.dataset\.client = id;/);
  assert.match(body, /row\.addEventListener\('pointerdown', \(event\) => clientPreferenceRowDrag\.startRowDrag\(event, id\)\);/);
  // The keyboard reorder entry point moves onto the track checkbox, keys unchanged.
  assert.match(body, /trackInput\.setAttribute\('aria-keyshortcuts', 'ArrowUp ArrowDown Home End'\);/);
  assert.match(body, /trackInput\.addEventListener\('keydown', \(event\) => onPreferenceOrderKeydown\(event, 'client', id\)\);/);

  // The handle was the only affordance, so the section note has to say it.
  const html = readRendererFile('index.html');
  assert.match(html, /data-i18n="settings\.tools\.note">[^<]*Drag a row to reorder\./);
  const i18n = readRendererFile('i18n.js');
  assert.doesNotMatch(i18n, /'settings\.tools\.reorderClient':/);
});

// Token-only stats pushes keep the live rows and expanded panel in place; health
// changes refill only the open panel instead of rebuilding the whole tool list.
test('the tool list skips unchanged row renders and refreshes only open health details', () => {
  const app = readRendererFile('app.js');
  const defer = functionBody(app, 'renderToolPreferences', 'toolPreferenceRenderSignature');
  assert.match(defer, /if \(clientPreferenceRowDrag\.deferRender\(\)\) return;/);
  assert.match(defer, /return preserveSettingsPanelScroll\(renderToolPreferencesNow\);/);

  const signature = functionBody(app, 'toolPreferenceRenderSignature', 'renderToolPreferencesNow');
  assert.match(signature, /\[\.\.\.enabledClientSet\(\)\]\.sort\(\)/);
  assert.doesNotMatch(signature, /trackedClients/);
  assert.match(signature, /healthRows: KNOWN_CLIENTS\.map/);
  assert.match(signature, /health\?\.clients\?\.\[id\]\?\.overall/);
  assert.doesNotMatch(signature, /periods/);

  const expanded = functionBody(app, 'setClientHealthExpanded', 'clientPeriodUsage');
  assert.match(expanded, /function setClientHealthExpanded\(clientId, options = \{\}\)/);
  assert.match(
    expanded,
    /const force = options\.refreshPlaceholder === true[\s\S]*clientHealthPresentationApi\.hasClientHealth\(localClientHealth\(\), row\.dataset\.client\)[\s\S]*loadClientSources\(row\.dataset\.client, \{ force \}\)/
  );

  const body = functionBody(app, 'renderToolPreferencesNow', 'connectLimitProviderCheckboxName');
  const fill = functionBody(app, 'fillClientHealthPanel', 'clientHealthGroup');
  assert.match(body, /state\.toolPreferenceRenderSignature === renderSignature/);
  assert.match(body, /state\.toolPreferenceDetailSignature !== detailSignature/);
  assert.match(body, /state\.settings\?\.currencyRatesEffective \|\| null/);
  assert.match(body, /state\.toolPreferenceSourceSignature !== sourceSignature/);
  assert.match(body, /loadClientSources\(state\.clientHealthExpanded\);\s*refillOpenClientHealthPanel\(\);/);
  assert.match(body, /else \{\s*refillOpenClientHealthPanel\(\);\s*\}/);
  assert.match(body, /const detail = clientHealthDetailFor\(id\);/);
  assert.match(body, /visibility\.id = `toolVisibility-\$\{id\}`/);
  assert.match(body, /pin\.id = `toolPin-\$\{id\}`/);
  assert.match(body, /const focusedId = document\.activeElement\?\.id \|\| ''/);
  assert.match(body, /document\.getElementById\(focusedId\)\?\.focus/);
  assert.match(body, /return;/);
  assert.doesNotMatch(body, /replaceChildren/);
  assert.match(
    body,
    /main\.addEventListener\('click', \(\) => \{[\s\S]*const open = state\.clientHealthExpanded !== id;[\s\S]*setClientHealthExpanded\(open \? id : '', \{ refreshPlaceholder: open \}\);/
  );
  const wiring = app.slice(app.indexOf('const clientPreferenceRowDrag = '), app.indexOf('function renderToolPreferences('));
  assert.match(wiring, /setExpanded: setClientHealthExpanded,/);
  assert.doesNotMatch(wiring, /refreshPlaceholder/);
  assert.match(fill, /patchRenderedNode\(current, next\)/);
  assert.match(fill, /else container\.replaceChildren\(next\)/);

  const localSources = functionBody(app, 'localClientSources', 'loadClientSources');
  assert.match(localSources, /exactLocalClientSources\(clientId\)/);
  assert.match(localSources, /const pendingSources = key && state\.clientSourcesKey === key/);
  assert.match(localSources, /exactSources \?\? clientSourceCacheApi\.readLatestClientSources/);
  assert.match(localSources, /exists: false, pending: true/);
});

test('the tool preference row carries the drag transform contract', () => {
  const css = readRendererFile('styles.css');
  const row = cssRule(css, '.tool-preference-row');
  assert.match(row, /position: relative;/);
  assert.match(row, /touch-action: pan-y;/);
  assert.match(row, /transform: translateY\(calc\(var\(--drag-y, 0px\) \+ var\(--drag-shift, 0px\)\)\);/);
  assert.match(row, /transform 170ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
  assert.doesNotMatch(cssRule(css, '.tool-preference-row.dragging'), /transform \d/);
  assert.match(css, /\.tool-preference-list\.drag-active \.tool-preference-row:not\(\.dragging\) \{ opacity: 0\.78; \}/);
});

test('a press on the tool row own controls never arms a drag', () => {
  const app = readRendererFile('app.js');
  // The checkbox sits inside a label, which is a hit target of its own.
  assert.match(app, /const CLIENT_PREFERENCE_DRAG_EXCLUDED = 'button:not\(\.tool-preference-main\), input, select, textarea, a, label, \.accordion-animated-container';/);
  const wiring = app.slice(app.indexOf('const clientPreferenceRowDrag = '), app.indexOf('function renderToolPreferences('));
  assert.match(wiring, /dragExcluded: CLIENT_PREFERENCE_DRAG_EXCLUDED,/);
  assert.match(wiring, /rowSelector: '\.tool-preference-row\[data-client\]',/);
  assert.match(wiring, /idKey: 'client',/);
  assert.match(wiring, /preserveScroll: preserveSettingsPanelScroll,/);
  assert.match(wiring, /applyOrder: \(order\) => applyPreferenceOrder\('client', order\),/);
  assert.match(wiring, /requestRender: \(\) => renderToolPreferences\(\)/);
  // The pin/order decision is made once, by the shared module, and travels from
  // the mirror to the save; onPreferenceOrderCommit would compare against the
  // value the mirror just wrote and drop it.
  assert.match(wiring, /clientDisplayPreferencesApi\.clientDisplayOrderCommit\(order, KNOWN_CLIENTS, state\.settings\?\.clientDisplayOrder, state\.settings\?\.pinnedClients, id\)/);
  assert.match(wiring, /persistOrder: \(_order, _id, patch\) => void saveSettings\(patch\)/);
  assert.doesNotMatch(wiring, /onPreferenceOrderCommit\(/);
  assert.doesNotMatch(functionBody(app, 'onPreferenceOrderCommit', 'onPreferenceOrderKeydown'), /clientDisplayOrder|pinnedClients/);
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
  assert.match(html, /class="settings-section-icon settings-section-icon-sync"/);
  assert.doesNotMatch(html, /data-settings-section="accounts"/);
  assert.match(html, /id="accountsSettingsDetails" class="hidden" aria-hidden="true"/);
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
  assert.doesNotMatch(app, /'limits', 'accounts', 'sync'/);
  assert.doesNotMatch(app, /viewsSettingsSummary/);
  assert.doesNotMatch(app, /orderAccountProviderGroups/);

  const css = readRendererFile('styles.css');
  const i18n = readRendererFile('i18n.js');
  assert.match(css, /\.settings-section-toggle/);
  assert.match(css, /\.settings-section-icon/);
  assert.match(css, /\.settings-section-summary/);
  assert.doesNotMatch(css, /\.settings-section-icon-accounts/);
  assert.doesNotMatch(i18n, /settings\.(?:sections|summary)\.accounts/);
  assert.equal(fs.existsSync(path.join(rendererDir, 'icons', 'settings', 'accounts.svg')), false);
  assert.doesNotMatch(readRendererFile('icons/THIRD_PARTY_NOTICES.md'), /settings\/accounts\.svg/);
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
  assert.match(appearance, /name="systemGlassOption" value="system"/);
  assert.match(appearance, /name="systemGlassOption" value="off"/);
  assert.match(appearance, /id="glassInput"/);
  assert.match(appearance, /id="zoomInput"/);
  assert.match(appearance, /id="themePresetChips"/);
  assert.match(appearance, /id="themeCodeInput"/);
  assert.match(appearance, /id="applyThemeCodeButton"/);
  assert.match(appearance, /id="copyThemeCodeButton"/);
  assert.match(appearance, /id="themeCodeStatus"[^>]*aria-live="polite"/);
  assert.match(appearance, /id="themeAdvancedToggle"[^>]*aria-controls="themeAdvancedDetails"/);
  assert.match(appearance, /id="themeAdvancedDetails" class="cursor-settings-details hidden" inert/);
  assert.match(appearance, /id="themeVendorToggle"[^>]*aria-controls="themeVendorDetails"/);
  assert.match(appearance, /id="themeVendorDetails" class="cursor-settings-details hidden" inert/);

  const vendorGroupIndex = appearance.indexOf('id="themeVendorGroup"');
  assert.ok(vendorGroupIndex > appearance.indexOf('id="themeAdvancedGroup"'), 'vendor colours should follow advanced customization');
  const advancedGroup = appearance.slice(appearance.indexOf('id="themeAdvancedGroup"'), vendorGroupIndex);
  const vendorGroup = appearance.slice(vendorGroupIndex);
  assert.match(advancedGroup, /id="themeColorGrid"/);
  assert.doesNotMatch(advancedGroup, /id="vendorColorList"/);
  assert.match(vendorGroup, /id="resetVendorColorsButton"/);
  assert.match(vendorGroup, /id="vendorColorList"/);

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
  assert.match(windowGroup, /id="windowToggleShortcutValue"/);
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

test('settings mode choices use inline options and compact home limit rows', () => {
  const html = readRendererFile('index.html');
  // Each mode choice is a labelled radiogroup, not a bare cluster of inputs.
  assert.match(html, /<div id="floatingBubbleTriggerRow" class="settings-item">/);
  assert.match(html, /<span id="floatingBubbleTriggerLabel" class="settings-item-text">/);
  assert.match(html, /role="radiogroup" aria-labelledby="floatingBubbleTriggerLabel"/);
  for (const value of ['click', 'hover']) {
    assert.match(html, new RegExp(`<input type="radio" name="floatingBubbleTrigger" value="${value}"`));
  }
  assert.match(html, /<span id="showLimitUsedLabel" class="settings-item-text">/);
  assert.match(html, /role="radiogroup" aria-labelledby="showLimitUsedLabel"/);
  for (const value of ['remaining', 'used']) {
    assert.match(html, new RegExp(`<input type="radio" name="showLimitUsed" value="${value}"`));
  }
  assert.doesNotMatch(html, /id="floatingBubbleTriggerInput"/);
  assert.doesNotMatch(html, /id="showLimitUsedInput"/);

  const app = readRendererFile('app.js');
  assert.match(app, /floatingBubbleTriggerInputs: Array\.from\(document\.querySelectorAll\('input\[name="floatingBubbleTrigger"\]'\)\)/);
  assert.match(app, /showLimitUsedInputs: Array\.from\(document\.querySelectorAll\('input\[name="showLimitUsed"\]'\)\)/);
  assert.match(app, /for \(const input of els\.showLimitUsedInputs \|\| \[\]\)/);
  assert.match(app, /for \(const input of els\.floatingBubbleTriggerInputs \|\| \[\]\)/);

  // Bound every declaration match to the body of the rule it names: an
  // unbounded [\s\S]* happily matches the same property in an unrelated rule
  // further down the file, so the assertion would survive deleting the rule.
  const css = readRendererFile('styles.css');
  assert.match(css, /\.settings-panel \.status-provider-interval\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.settings-panel \.status-provider-interval select\s*\{[^}]*width:\s*auto/);
  assert.match(css, /\.settings-panel \.home-limit-account-count-setting > input\[type="number"\]\s*\{[^}]*height:\s*20px[^}]*padding:\s*2px 8px/);
});

test('nested settings lists share one compact rhythm instead of per-list spacing', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');

  // Every list nested under a view row opts into the shared class. Restyling one
  // of them on its own is how Trends and Status drifted looser than Home.
  for (const list of ['home-limit-provider-list', 'home-settings-list', 'trend-settings-list', 'status-provider-list']) {
    assert.match(app, new RegExp(`wrap\\.className = 'settings-nested-list ${list}'`));
    assert.doesNotMatch(css, new RegExp(`\\.${list}\\s*\\{`));
  }

  // Rows carry their own height, so the container must not add a gap on top.
  assert.match(css, /\.settings-nested-list[^{}]*\{[^}]*gap: 0 !important/);
  assert.match(css, /\.settings-panel \.settings-nested-list > \.checkbox-label,[^{}]*\{[^}]*min-height:\s*24px/);
  assert.match(css, /\.settings-panel \.settings-nested-list > \.checkbox-label,[^{}]*\{[^}]*margin-top:\s*0/);
  assert.match(css, /\.settings-panel \.settings-nested-list > \.settings-item\s*\{[^}]*padding:\s*2px 0/);
  // The interval pill fills the base row, so it needs a taller one to keep the
  // same ~4px of air between controls that the Home rows have.
  assert.match(css, /\.settings-panel \.settings-nested-list > \.status-provider-interval\s*\{[^}]*min-height:\s*28px/);
});

test('checkbox labels keep semantics without making the whole row a hit target', () => {
  const css = readRendererFile('styles.css');
  assert.match(css, /\.settings-panel \.checkbox-label,\s*\.settings-panel label\.client-checkbox\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.settings-panel \.checkbox-label > input\[type="checkbox"\],[^{}]*\.settings-panel label\.client-checkbox > input\[type="checkbox"\]\s*\{[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.settings-panel \.client-checkboxes label\.client-checkbox input\[type="checkbox"\]\s*\{[^}]*cursor:\s*pointer/);
});

// The provider row opens its details, while the checkbox remains the only hit
// target that enables or disables the provider.
test('AI Tool Limits provider checkbox keeps an isolated hit target', () => {
  const css = readRendererFile('styles.css');
  assert.doesNotMatch(css, /\.settings-panel \.limit-provider-list label\.client-checkbox\s*\{[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.settings-panel \.checkbox-label,\s*\.settings-panel label\.client-checkbox\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.settings-panel label\.client-checkbox > input\[type="checkbox"\]\s*\{[^}]*pointer-events:\s*auto/);
});

test('theme code feedback clears when the displayed code changes', () => {
  const app = readRendererFile('app.js');
  const build = functionBody(app, 'buildAppearanceColorControls', 'renderThemePresetChips');
  const clear = functionBody(app, 'clearThemeCodeStatus', 'applyThemeCodeFromInput');
  const invalidate = functionBody(app, 'invalidateThemeCodeFeedback', 'themeCodeFeedbackIsCurrent');
  const apply = functionBody(app, 'applyThemeCodeFromInput', 'copyCurrentThemeCode');
  const paste = functionBody(app, 'pasteAndApplyThemeCode', 'copyCurrentThemeCode');
  const copy = functionBody(app, 'copyCurrentThemeCode', 'previewVendorColor');

  assert.match(build, /themeCodeInput\.value !== code/);
  assert.match(build, /invalidateThemeCodeFeedback\(\)/);
  assert.match(clear, /themeCodeStatus\.textContent = ''/);
  assert.match(clear, /classList\.remove\('success', 'error'\)/);
  assert.match(invalidate, /themeCodeFeedbackGeneration \+= 1/);
  assert.match(app, /themeCodeInput\?\.addEventListener\('input', invalidateThemeCodeFeedback\)/);
  assert.match(apply, /const generation = invalidateThemeCodeFeedback\(\)/);
  assert.match(apply, /themeCodeFeedbackIsCurrent\(generation, parsed\.code\)/);
  assert.match(paste, /const generation = invalidateThemeCodeFeedback\(\)/);
  assert.match(paste, /const code = els\.themeCodeInput\?\.value/);
  assert.equal((paste.match(/themeCodeFeedbackIsCurrent\(generation, code\)/g) || []).length, 2);
  assert.match(paste, /if \(els\.themeCodeInput\) els\.themeCodeInput\.value = trimmed/);
  assert.match(copy, /const generation = invalidateThemeCodeFeedback\(\)/);
  assert.match(copy, /themeCodeFeedbackIsCurrent\(generation, code\)/);
});

test('settings accordions share accessible collapsed-state handling', () => {
  const app = readRendererFile('app.js');
  const setupStart = app.indexOf('function setSettingsAccordionExpanded(');
  const setupEnd = app.indexOf('\nfunction setupSettingsAccordion(', setupStart);
  assert.notEqual(setupStart, -1, 'setSettingsAccordionExpanded function should exist');
  assert.notEqual(setupEnd, -1, 'settings accordion setup calls should follow the helper');
  const setup = app.slice(setupStart, setupEnd);

  assert.match(setup, /toggle\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(setup, /details\.classList\.toggle\('hidden', !open\)/);
  assert.match(setup, /details\.inert = !open/);
  assert.match(setup, /group\.classList\.toggle\('expanded', open\)/);
  assert.match(app, /setupSettingsAccordion\(els\.appUpdateNotes, els\.appUpdateNotesToggle, els\.appUpdateNotesDetails\)/);
  assert.match(app, /setupSettingsAccordion\(els\.advancedSettingsGroup, els\.advancedSettingsToggle, els\.advancedSettingsDetails\)/);
  assert.match(app, /setupSettingsAccordion\(els\.themeAdvancedGroup, els\.themeAdvancedToggle, els\.themeAdvancedDetails\)/);
  assert.match(app, /setupSettingsAccordion\(els\.themeVendorGroup, els\.themeVendorToggle, els\.themeVendorDetails\)/);
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
  assert.match(app, /wrap\.className = 'settings-nested-list trend-settings-list'/);
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
  const startupGroup = html.match(/<div id="startupGroup"[\s\S]*?id="startupNote"[\s\S]*?<\/label>/)?.[0] || '';
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
  assert.match(innerRule, /padding:\s*2px 11px 0/);
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
