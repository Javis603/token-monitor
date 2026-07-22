'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule should exist`);
  return match[1];
}

function declaration(rule, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = rule.match(new RegExp(`(?:^|;|\\{)\\s*${escaped}\\s*:\\s*([^;]+);`));
  return match?.[1].trim() || '';
}

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  return source.slice(start, end);
}

test('footer exposes the utility action slot without a stale titlebar slot', () => {
  const html = readRendererFile('index.html');
  const css = readRendererFile('styles.css');

  const windowActions = html.match(/<div class="window-actions">[\s\S]*?<\/div>/)?.[0] || '';
  assert.doesNotMatch(windowActions, /titlebarActionSlot/, 'the obsolete titlebar action slot is removed');

  const footer = html.match(/<footer class="footer">[\s\S]*?<\/footer>/)?.[0] || '';
  assert.match(footer, /<span id="footerActionSlot">/, 'footer slot lives inside footer');

  assert.doesNotMatch(css, /#titlebarActionSlot/);
  assert.equal(declaration(cssRule(css, '#footerActionSlot'), 'display'), 'contents');
});

test('default layout groups Refresh with Settings in the footer', () => {
  const html = readRendererFile('index.html');
  const footerStart = html.indexOf('<span id="footerActionSlot">');
  const footerSlot = html.slice(footerStart, html.indexOf('</footer>', footerStart));
  assert.match(footerSlot, /id="utilityActions"/, 'utility group defaults into the footer slot');
  assert.ok(
    footerSlot.indexOf('id="refreshButton"') < footerSlot.indexOf('id="settingsButton"'),
    'refresh precedes settings so it can disclose toward the left',
  );
});

test('applyControlLayout keeps both controls in the footer and swaps their roles', () => {
  const app = readRendererFile('app.js');
  const body = functionBody(app, 'applyControlLayout', 'applyAppearanceSettings');
  assert.match(body, /footerActionSlot/);
  assert.match(body, /footerSlot\.appendChild\(els\.utilityActions\)/);
  assert.match(body, /classList\.toggle\('is-swapped', swapSettingsAndRefresh\)/);
  assert.match(body, /els\.utilityActions\.append\(els\.settingsButton, els\.refreshButton\)/);
  assert.match(body, /els\.utilityActions\.append\(els\.refreshButton, els\.settingsButton\)/);
  assert.doesNotMatch(body, /titlebarSlot\.appendChild/);
});

test('window-actions and tabs fade out after a leave grace delay, in instantly', () => {
  const css = readRendererFile('styles.css');

  const actions = cssRule(css, '.window-actions');
  assert.match(declaration(actions, 'transition'), /280ms/, 'window-actions resting state carries the 280ms leave delay');

  const reveal = cssRule(css, '.actions-hotspot:hover ~ .window-actions, .window-actions:hover, .window-actions:focus-within, .shell.settings-open .window-actions');
  assert.equal(declaration(reveal, 'transition-delay'), '0ms', 'revealed state shows instantly');

  const tabs = cssRule(css, '.title-controls .tabs');
  assert.match(declaration(tabs, 'transition'), /280ms/, 'tabs restore after the same 280ms grace');
});

test('hover hotspot stays right-anchored and never extends left over the tabs', () => {
  const css = readRendererFile('styles.css');
  const hotspot = cssRule(css, '.actions-hotspot');
  assert.ok(declaration(hotspot, 'right'), 'hotspot is anchored from the right edge');
  assert.equal(declaration(hotspot, 'left'), '', 'hotspot must not set left (would overlap DAY/MONTH/TOTAL)');
  const width = parseInt(declaration(hotspot, 'width'), 10);
  assert.ok(width > 0 && width <= 32, `hotspot width stays small to clear the TOTAL tab (got ${width})`);
});

test('the reveal trigger is never fired by hovering the period tabs', () => {
  const css = readRendererFile('styles.css');
  // The selector list that reveals .window-actions must not include a .tab/.tabs hover trigger.
  const revealSelector = css.match(/([^}]*?)\s*\{\s*opacity: 1;\s*pointer-events: auto;\s*transform: translateY\(0\);/);
  assert.ok(revealSelector, 'reveal rule exists');
  assert.doesNotMatch(revealSelector[1], /\.tabs?:hover/, 'tabs hover must not reveal the window actions');
});

test('the utility group is sized by its slot', () => {
  const css = readRendererFile('styles.css');
  const footer = cssRule(css, '#footerActionSlot .utility-actions,\n#footerActionSlot .utility-actions .icon-button,\n#footerActionSlot .utility-actions .refresh-button');
  assert.equal(declaration(footer, 'height'), '30px', 'footer action matches the original footer button');
});

test('swapping makes Refresh the anchor and Settings the left disclosure', () => {
  const css = readRendererFile('styles.css');
  const settings = cssRule(css, '.utility-actions.is-swapped .settings-icon-button');
  const refresh = cssRule(css, '.utility-actions.is-swapped .refresh-button');
  const reveal = cssRule(css, '.utility-actions.is-swapped:hover .settings-icon-button,\n.utility-actions.is-swapped:has(:focus-visible) .settings-icon-button,\n.shell.settings-open .utility-actions.is-swapped .settings-icon-button');

  assert.equal(declaration(settings, 'position'), 'absolute');
  assert.match(declaration(settings, 'right'), /100% \+ 6px/);
  assert.equal(declaration(settings, 'opacity'), '0');
  assert.equal(declaration(refresh, 'position'), 'relative');
  assert.equal(declaration(refresh, 'opacity'), '1');
  assert.equal(declaration(reveal, 'opacity'), '1');
});

test('pointer-closing Settings clears sticky focus without blurring keyboard activation', () => {
  const app = readRendererFile('app.js');
  const start = app.indexOf("els.settingsButton.addEventListener('click'");
  const end = app.indexOf("els.settingsPanel.addEventListener('click'", start);
  const handler = app.slice(start, end);

  assert.match(handler, /addEventListener\('click', \(event\) =>/);
  assert.match(handler, /if \(!settingsOpen && event\.detail > 0\) els\.settingsButton\.blur\(\)/);
});

test('Refresh discloses to the left of Settings on hover and keyboard focus', () => {
  const css = readRendererFile('styles.css');
  const group = cssRule(css, '.utility-actions');
  const refresh = cssRule(css, '.utility-actions .refresh-button');
  const reveal = cssRule(css, '.utility-actions:not(.is-swapped):hover .refresh-button,\n.utility-actions:not(.is-swapped):has(:focus-visible) .refresh-button,\n.shell.settings-open .utility-actions:not(.is-swapped) .refresh-button,\n.utility-actions .refresh-button:is(.is-refreshing, .is-refreshed, .is-refresh-error)');

  assert.equal(declaration(group, 'width'), '34px', 'settings remains anchored at its original width');
  assert.match(declaration(refresh, 'right'), /100% \+ 6px/, 'refresh sits to the left of settings');
  assert.equal(declaration(refresh, 'opacity'), '0', 'refresh is hidden at rest');
  assert.equal(declaration(refresh, 'pointer-events'), 'none', 'hidden refresh cannot intercept clicks');
  assert.equal(declaration(reveal, 'opacity'), '1', 'hover/focus reveals refresh');
  assert.equal(declaration(reveal, 'pointer-events'), 'auto', 'revealed refresh is interactive');
  assert.match(css, /\.shell\.settings-open \.utility-actions:not\(\.is-swapped\) \.refresh-button/, 'opening Settings pins refresh open');
  assert.doesNotMatch(css, /\.utility-actions:focus-within \.refresh-button/, 'pointer focus must not pin refresh open after Settings closes');
});

test('tray mode removes title-bar hover controls only while Settings is closed', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');

  assert.match(app, /'trayMode' in settings[\s\S]*state\.settings\?\.trayMode === true/, 'partial appearance previews preserve the full tray-mode state');
  assert.match(app, /els\.shell\.classList\.toggle\('tray-mode', trayMode\)/);
  const hiddenHotspot = cssRule(css, '.shell.tray-mode:not(.settings-open) .actions-hotspot');
  assert.equal(declaration(hiddenHotspot, 'display'), 'none');
  assert.doesNotMatch(css, /\.shell\.tray-mode[^}]*\.window-actions[^}]*display:\s*none/, 'tray mode keeps window actions transitionable');
  assert.match(css, /\.shell\.settings-open \.window-actions[\s\S]*transition-delay:\s*0ms/, 'Settings-open tray mode reuses the original title transition');
});

test('appearance settings expose a Settings/Refresh swap wired to the legacy preference', () => {
  const html = readRendererFile('index.html');
  const app = readRendererFile('app.js');

  const groupStart = html.indexOf('<div class="settings-subgroup settings-appearance-group">');
  const groupEnd = html.indexOf('<div class="settings-subgroup settings-theme-group">', groupStart);
  const group = groupStart >= 0 && groupEnd > groupStart ? html.slice(groupStart, groupEnd) : '';
  assert.match(group, /id="swapSettingsRefreshInput"/, 'checkbox lives in the appearance group');
  assert.match(group, /data-i18n="settings\.appearance\.swapSettingsRefresh"/, 'checkbox uses the swap label');

  assert.match(app, /swapSettingsRefreshInput: document\.getElementById\('swapSettingsRefreshInput'\)/, 'els maps the input');
  assert.match(app, /settingsInTitlebar: false/, 'legacy persisted preference defaults to the standard order');
  assert.match(app, /settingsInTitlebar: Boolean\(els\.swapSettingsRefreshInput\.checked\)/, 'patch keeps writing the compatible setting key');
  assert.match(app, /els\.swapSettingsRefreshInput\.checked = state\.settings\.settingsInTitlebar === true/, 'populate reflects the saved value');
  assert.match(app, /'settingsInTitlebar' in settings \|\| 'trayMode' in settings[\s\S]*applyControlLayout\(settings\.settingsInTitlebar === true\)/, 'apply guards on key presence then swaps the footer controls');
  assert.match(app, /els\.swapSettingsRefreshInput\.addEventListener\('change', \(\) => \{[\s\S]*applyControlLayout\(els\.swapSettingsRefreshInput\.checked\);[\s\S]*void saveAppearanceFromControls\(\);[\s\S]*\}\)/, 'change swaps immediately, then persists');
});

test('swap-control label exists in every bundled locale', () => {
  const { MESSAGES } = require('../../src/electron/renderer/i18n.js');
  for (const locale of Object.keys(MESSAGES)) {
    assert.ok(
      MESSAGES[locale]?.['settings.appearance.swapSettingsRefresh'],
      `${locale} should define settings.appearance.swapSettingsRefresh`
    );
  }
});

test('index.html language dropdown offers an option for every language', () => {
  const { LANGUAGE_OPTIONS } = require('../../src/electron/renderer/i18n.js');
  const html = readRendererFile('index.html');
  for (const { value } of LANGUAGE_OPTIONS) {
    assert.match(
      html,
      new RegExp(`<option value="${value}"`),
      `index.html language dropdown should offer "${value}"`
    );
  }
});

test('refresh button exposes busy, success, and error feedback states', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');

  assert.match(app, /refreshBusy: false/, 'renderer tracks refresh busy state');
  assert.match(app, /refreshFeedbackTimer: null/, 'renderer tracks transient feedback cleanup');
  assert.match(app, /function setRefreshButtonState\(/, 'refresh feedback is centralized');
  assert.match(app, /is-refreshing/, 'busy state class is applied from renderer');
  assert.match(app, /is-refreshed/, 'success state class is applied from renderer');
  assert.match(app, /is-refresh-error/, 'error state class is applied from renderer');
  assert.match(app, /aria-busy/, 'busy state is exposed to assistive tech');
  assert.match(app, /els\.refreshButton\.disabled = status === 'refreshing'/, 'refreshing disables repeat clicks');

  const body = functionBody(app, 'refreshStats', 'publishViewState');
  assert.match(body, /options\.feedback === true/, 'button feedback is opt-in, not tied to every forced refresh');
  assert.match(body, /setRefreshButtonState\('refreshing'/, 'feedback refresh starts button feedback immediately');
  assert.match(body, /settleRefreshButtonState\('refreshed'/, 'feedback refresh shows success feedback');
  assert.match(body, /settleRefreshButtonState\('error'/, 'feedback refresh shows error feedback');
  // Intent is the feedback opt-in, not the exact flag list (the Reload click also
  // forces a history rescan — see refreshForceHistory.test.js).
  assert.match(app, /refreshStats\(\{[^}]*feedback: true[^}]*\}\)/, 'Reload click opts into button feedback');

  assert.doesNotMatch(cssRule(css, '.refresh-button.is-refreshing'), /cursor:\s*progress/, 'loading state should not alter the pointer cursor');
  assert.equal(declaration(cssRule(css, '.refresh-button:disabled'), 'cursor'), 'default', 'disabled refresh keeps the normal arrow cursor');
  const html = readRendererFile('index.html');
  assert.match(html, /class="refresh-button-icon"/, 'refresh glyph has its own animation target');
  assert.match(html, /<span class="refresh-button-spinner" aria-hidden="true"><\/span>/, 'loading glyph is an empty span styled by a reusable CSS mask icon');
  assert.doesNotMatch(css, /\.refresh-button::after/, 'refresh loading should not add a competing ring layer');
  assert.doesNotMatch(css, /repeating-conic-gradient/, 'loading glyph should not be hand-drawn in CSS');
  assert.doesNotMatch(css, /@keyframes refresh-spinner-spin/, 'the spinner animates itself (SMIL); no CSS rotation keyframe needed');
  assert.equal(declaration(cssRule(css, '.refresh-button-spinner'), 'width'), '0.94em', 'spinner should stay close to the reload glyph without feeling oversized');
  assert.equal(declaration(cssRule(css, '.refresh-button-spinner'), 'height'), '0.94em', 'spinner should stay close to the reload glyph without feeling oversized');
  assert.match(cssRule(css, '.refresh-button-spinner'), /display:\s*none/, 'spinner stays hidden while idle');
  assert.match(cssRule(css, '.refresh-button.is-refreshing .refresh-button-icon'), /display:\s*none/, 'loading state hides the reload glyph');
  assert.match(css, /\.refresh-button\.is-refreshing \.refresh-button-spinner\s*\{\s*display:\s*block;\s*\}/, 'loading state reveals the masked spinner');
  assert.match(cssRule(css, '.refresh-button-spinner::before'), /mask:\s*url\("icons\/actions\/spinner\.svg"\)/, 'spinner is a reusable asset file, not markup inlined in the page');
  assert.equal(declaration(cssRule(css, '.refresh-button-spinner::before'), 'background'), 'currentColor', 'spinner mask is tinted by the button state color');
  assert.match(cssRule(css, '.refresh-button.is-refreshed'), /border-color:\s*rgba\(var\(--success-rgb\)/);
  assert.match(cssRule(css, '.refresh-button.is-refresh-error'), /border-color:\s*rgba\(255,\s*99,\s*99/);

  const spinnerSvg = readRendererFile('icons/actions/spinner.svg');
  assert.match(spinnerSvg, /<animate attributeName="opacity"/, 'spinner animates itself via SMIL, independent of CSS/JS');

  const notice = readRendererFile('icons/THIRD_PARTY_NOTICES.md');
  assert.doesNotMatch(notice, /svg-spinners/, 'the spinner is original artwork now, not a third-party icon');
  assert.equal(
    fs.existsSync(path.join(rendererDir, 'icons', 'settings', 'THIRD_PARTY_NOTICES.md')),
    false,
    'settings-specific notice file was consolidated into the shared icon notice file',
  );
});
