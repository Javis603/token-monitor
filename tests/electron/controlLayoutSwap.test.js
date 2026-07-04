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

test('title bar and footer expose display:contents action slots', () => {
  const html = readRendererFile('index.html');
  const css = readRendererFile('styles.css');

  const windowActions = html.match(/<div class="window-actions">[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(windowActions, /<span id="titlebarActionSlot">/, 'titlebar slot lives inside window-actions');

  const footer = html.match(/<footer class="footer">[\s\S]*?<\/footer>/)?.[0] || '';
  assert.match(footer, /<span id="footerActionSlot">/, 'footer slot lives inside footer');

  assert.equal(declaration(cssRule(css, '#titlebarActionSlot'), 'display'), 'contents');
  assert.equal(declaration(cssRule(css, '#footerActionSlot'), 'display'), 'contents');
});

test('default layout places Refresh in the title bar and Settings in the footer', () => {
  const html = readRendererFile('index.html');
  const titlebarSlot = html.match(/<span id="titlebarActionSlot">[\s\S]*?<\/span>/)?.[0] || '';
  const footerSlot = html.match(/<span id="footerActionSlot">[\s\S]*?<\/span>/)?.[0] || '';
  assert.match(titlebarSlot, /id="refreshButton"/, 'refresh defaults into the title bar slot');
  assert.match(footerSlot, /id="settingsButton"/, 'settings defaults into the footer slot');
});

test('applyControlLayout relocates the two buttons between the slots', () => {
  const app = readRendererFile('app.js');
  const body = functionBody(app, 'applyControlLayout', 'applyAppearanceSettings');
  assert.match(body, /titlebarActionSlot/);
  assert.match(body, /footerActionSlot/);
  assert.match(body, /appendChild\(els\.settingsButton\)/);
  assert.match(body, /appendChild\(els\.refreshButton\)/);
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

test('the action button is sized by its slot, not by its element identity', () => {
  const css = readRendererFile('styles.css');
  const titlebar = cssRule(css, '#titlebarActionSlot .icon-button, #titlebarActionSlot .refresh-button');
  assert.equal(declaration(titlebar, 'height'), '28px', 'title bar action matches the window chrome buttons');
  const footer = cssRule(css, '#footerActionSlot .icon-button, #footerActionSlot .refresh-button');
  assert.equal(declaration(footer, 'height'), '30px', 'footer action matches the original footer button');
});

test('appearance settings expose a settings-position checkbox wired to the layout', () => {
  const html = readRendererFile('index.html');
  const app = readRendererFile('app.js');

  const group = html.match(/<div class="settings-subgroup settings-appearance-group">[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(group, /id="settingsInTitlebarInput"/, 'checkbox lives in the appearance group');
  assert.match(group, /data-i18n="settings\.appearance\.settingsInTitlebar"/, 'checkbox uses the i18n label');

  assert.match(app, /settingsInTitlebarInput: document\.getElementById\('settingsInTitlebarInput'\)/, 'els maps the input');
  assert.match(app, /settingsInTitlebar: false/, 'defaultAppearance defaults to the new layout');
  assert.match(app, /settingsInTitlebar: Boolean\(els\.settingsInTitlebarInput\.checked\)/, 'patch reads the checkbox');
  assert.match(app, /els\.settingsInTitlebarInput\.checked = state\.settings\.settingsInTitlebar === true/, 'populate reflects the saved value');
  assert.match(app, /'settingsInTitlebar' in settings.*applyControlLayout\(settings\.settingsInTitlebar === true\)/s, 'apply guards on key presence then relocates');
  assert.match(app, /els\.settingsInTitlebarInput\.addEventListener\('change', saveAppearanceFromControls\)/, 'change persists + applies');
});

test('settings-position label exists in every bundled locale', () => {
  const { MESSAGES } = require('../../src/electron/renderer/i18n.js');
  for (const locale of Object.keys(MESSAGES)) {
    assert.ok(
      MESSAGES[locale]?.['settings.appearance.settingsInTitlebar'],
      `${locale} should define settings.appearance.settingsInTitlebar`
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
  assert.match(app, /refreshStats\(\{ force: true, feedback: true \}\)/, 'Reload click opts into button feedback');

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
  assert.match(cssRule(css, '.refresh-button.is-refreshed'), /border-color:\s*rgba\(var\(--accent-rgb\)/);
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
