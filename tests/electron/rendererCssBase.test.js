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
// wrong. It is on `body` rather than `html` so `rem` keeps meaning 16px.
test('the renderer declares its own base type size', () => {
  const css = readRendererFile('styles.css');
  assert.match(css, /\nbody \{ font-size: 11px; \}/);
  assert.doesNotMatch(css, /\nhtml, body \{[^}]*font-size/);
});

// These carry a glyph rather than body text and were the only things in the app
// relying on the 16px fallback, so they have to say the size out loud.
test('the glyph buttons that wanted 16px declare it', () => {
  const css = readRendererFile('styles.css');
  for (const selector of ['.tool-header-action', '.reset-appearance-button']) {
    const rule = rules(css).find((r) => r.selector === selector);
    assert.ok(rule, `${selector} rule should exist`);
    assert.match(rule.body, /font-size: 16px/, selector);
  }
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
    '.accordion-animated-container.hidden > .accordion-animation-inner',
    '.about-settings-diagnostics.hidden',
    '.view-switcher-menu.hidden',
    '.period-menu.hidden',
    '.hidden, [hidden]'
  ];
  // `.hidden` as a class token wherever it appears, so a compound selector like
  // `#claudeManualPanel.hidden` — the exact form this change deleted — is caught
  // too. The lookahead keeps a hypothetical `.hidden-sm` out.
  const offenders = rules(css)
    .filter((r) => /\.hidden(?![-\w])|\[hidden\]/.test(r.selector))
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
