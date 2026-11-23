'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

// Rough rule splitter: enough to classify declarations, not a CSS parser.
function rules(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].split(/\s+/).join(' ').trim(),
    body: m[2].split(/\s+/).join(' ').trim()
  }));
}

// Without a base size the fallback is the browser's 16px, roughly double this
// UI's body text, so anything that forgets a font-size renders unmistakably
// wrong. The standard root remains 16px; only text scales through rem.
test('the renderer declares its own base type size', () => {
  const css = readRendererFile('styles.css');
  assert.match(css, /\nbody \{ font-size: 0\.6875rem; \}/);
  assert.doesNotMatch(css, /\nhtml, body \{[^}]*font-size/);
});

test('settings reset buttons use a small shared icon and only change color on hover', () => {
  const css = readRendererFile('styles.css');
  const resetRules = rules(css).filter(rule => rule.selector.includes('.settings-reset-button'));
  const button = resetRules.find(rule => rule.selector === '.settings-panel .settings-reset-button');
  const icon = resetRules.find(rule => rule.selector === '.settings-reset-button::before');
  const hover = resetRules.find(rule => rule.selector.includes(':hover'));
  assert.match(button.body, /background: transparent/);
  assert.match(icon.body, /width: 10px; height: 10px/);
  assert.match(icon.body, /mask: url\("icons\/actions\/undo-2\.svg"\)/);
  assert.equal(hover.body, 'color: var(--text);');
});

// Layout here is written with descendant selectors that outrank a lone class, so
// a blanket hiding rule without `!important` loses to the component on hundreds
// of elements. Hiding is a utility that must beat layout by design.
test('hiding is one rule that outranks component layout', () => {
  const css = readRendererFile('styles.css');
  const blanket = rules(css).find((r) => r.selector === '.hidden, [hidden]');
  assert.ok(blanket, 'a single blanket hiding rule should exist');
  assert.equal(blanket.body, 'display: none !important;');
});

// Everything else that mentioned `.hidden` only to say `display: none` is now
// that one rule. A new one may only exist to animate instead of disappear.
test('no component restates the blanket hiding rule', () => {
  const css = readRendererFile('styles.css');
  const ANIMATED = [
    '.settings-panel.hidden',
    '.accordion-animated-container.hidden',
    '.legacy-editor-reveal .legacy-editor-content.hidden',
    '.legacy-slot-editor.is-replacing > .legacy-replacement-content.hidden',
    '.accordion-animated-container.hidden > .accordion-animation-inner',
    '.about-settings-diagnostics.hidden',
    '.view-switcher-menu.hidden',
    '.period-menu.hidden',
    '.hidden, [hidden]'
  ];
  // Visibility-aware spacing is not a hiding rule. Check display declarations,
  // including compound class tokens, without rejecting :not([hidden]) margins.
  // The lookahead keeps a hypothetical `.hidden-sm` out.
  const offenders = rules(css)
    // A negative visibility probe can hide an empty parent without restating
    // the utility on its hidden children.
    .filter((r) => /\.hidden(?![-\w])|\[hidden\]/.test(r.selector.replace(/:not\(\.hidden\)/g, '')))
    .filter((r) => /\bdisplay\s*:/.test(r.body))
    .filter((r) => !ANIMATED.includes(r.selector))
    .map((r) => r.selector);
  assert.deepEqual(offenders, [], 'these should rely on the blanket rule instead');
});

// The blanket applies `display: none` to them too, which would stop the
// transition dead, so each must re-state the box it animates — with matching
// weight, since `!important` is not beaten by specificity alone.
test('the components that animate out keep their box', () => {
  const css = readRendererFile('styles.css');
  for (const selector of [
    '.settings-panel.hidden',
    '.accordion-animated-container.hidden',
    '.about-settings-diagnostics.hidden',
    '.view-switcher-menu.hidden',
    '.period-menu.hidden'
  ]) {
    const rule = rules(css).find((r) => r.selector === selector);
    assert.ok(rule, `${selector} rule should exist`);
    assert.match(rule.body, /display: grid !important/, selector);
  }
});

// The dashboard window links styles.css before its own sheet, so it is covered
// by both rules above and must not grow a second copy of either.
test('the dashboard window inherits the base rules rather than repeating them', () => {
  const html = readRendererFile('dashboard.html');
  assert.ok(
    html.indexOf('href="styles.css"') < html.indexOf('href="dashboard.css"'),
    'dashboard.css should load after styles.css'
  );
  const css = readRendererFile('dashboard.css');
  assert.deepEqual(rules(css).filter((r) => r.selector.includes('.hidden')).map((r) => r.selector), []);
  assert.doesNotMatch(css, /\nbody \{[^}]*font-size/);
});

// Icon glyphs remain sized for their fixed controls when body text grows.
test('small action glyphs stay fixed while text scales', () => {
  const cssRules = rules(readRendererFile('styles.css'));
  for (const [selector, size] of [
    ['.managed-account-remove', '11px'],
    ['.subscription-topup-remove', '11px'],
    ['.subscription-row-actions button', '11px'],
    ['.opencode-profile-item .profile-delete', '11px']
  ]) {
    const rule = cssRules.find((r) => r.selector === selector);
    assert.ok(rule, selector);
    assert.ok(rule.body.includes(`font-size: ${size};`), selector);
  }
});

test('profile rename icons keep fixed geometry and an accessible name', () => {
  const cssRules = rules(readRendererFile('styles.css'));
  const button = cssRules.find((r) => r.selector === '.opencode-profile-item .profile-rename-btn');
  const icon = cssRules.find((r) => r.selector === '.opencode-profile-item .profile-rename-btn::before');
  assert.match(button?.body || '', /width: 18px; height: 18px;/);
  assert.match(icon?.body || '', /width: 12px; height: 12px;/);
  assert.match(icon?.body || '', /background: currentColor;/);
  assert.match(icon?.body || '', /mask: url\("icons\/actions\/pencil-line\.svg"\)/);
  assert.doesNotMatch(icon?.body || '', /(?:rem|em)\b/);
  assert.ok(fs.existsSync(path.join(rendererDir, 'icons', 'actions', 'pencil-line.svg')));

  const app = ['opencode', 'thirdparty'].map(id => readRendererFile(`limits/providerOwners/${id}.js`)).join('\n');
  const renameButtons = [...app.matchAll(/const renameBtn = document\.createElement\('button'\);([\s\S]*?)renameBtn\.setAttribute\('aria-label', t\('settings\.(?:opencode|profiles)\.rename'\)\);/g)];
  assert.equal(renameButtons.length, 1, 'OpenCode editor labels its rename icon');
  const panel = readRendererFile('limits/accountSlotsPanel.js');
  assert.match(panel, /renameButton\.setAttribute\('aria-label', tr\('rename'\)\)/);
  assert.match(panel, /const el = make\('button'/);
  assert.match(panel, /el\.type = 'button'/);
  const slotButton = cssRules.find(rule => rule.selector === '.slot-rename-button');
  const slotIcon = cssRules.find(rule => rule.selector === '.slot-rename-button::before');
  assert.match(slotButton?.body || '', /width: 24px; height: 24px;/);
  assert.match(slotIcon?.body || '', /width: 12px; height: 12px;/);
  assert.match(slotIcon?.body || '', /background: currentColor;/);
  assert.match(slotIcon?.body || '', /mask: url\("icons\/actions\/pencil-line\.svg"\)/);
  for (const [, setup] of renameButtons) {
    assert.match(setup, /renameBtn\.type = 'button';/);
    assert.doesNotMatch(setup, /renameBtn\.title/);
    assert.doesNotMatch(setup, /renameBtn\.textContent/);
  }
});

test('short-window labels and cost scale while the primary total stays fixed', () => {
  const css = readRendererFile('styles.css');
  const shortWindow = css.slice(css.indexOf('@media (max-height: 200px)'));
  for (const selector of ['.label-row', '.total-compact', '.cost']) {
    const rule = rules(shortWindow).find((r) => r.selector === selector);
    assert.match(rule?.body || '', /font-size: calc\(clamp\([^;]+\) \* var\(--ui-text-scale\)\)/, selector);
  }
  const totals = rules(css).filter((r) => r.selector === '.total-number');
  assert.ok(totals.length >= 2);
  for (const rule of totals) {
    assert.doesNotMatch(rule.body, /font-size:[^;]*(?:rem|--ui-text-scale)/);
  }
  const headingRules = rules(css).filter((r) => r.selector.includes('.settings-section-toggle'));
  assert.ok(headingRules.every((r) => !r.body.includes('minmax(max-content')));
});
