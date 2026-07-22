'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_ANIMATED_BREAKDOWN_ROWS,
  isLargeSessionBreakdown,
  rowRenderFingerprint,
  shouldAnimateBreakdownRows
} = require('../../src/electron/renderer/breakdownRenderPolicy');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

test('small breakdowns keep motion while large breakdowns skip it', () => {
  assert.equal(shouldAnimateBreakdownRows(MAX_ANIMATED_BREAKDOWN_ROWS), true);
  assert.equal(shouldAnimateBreakdownRows(MAX_ANIMATED_BREAKDOWN_ROWS + 1), false);
});

test('reduced motion skips layout capture even for small breakdowns', () => {
  assert.equal(shouldAnimateBreakdownRows(1, { reducedMotion: true }), false);
});

test('only large session breakdowns opt into off-screen rendering containment', () => {
  assert.equal(isLargeSessionBreakdown('session', MAX_ANIMATED_BREAKDOWN_ROWS + 1), true);
  assert.equal(isLargeSessionBreakdown('session', MAX_ANIMATED_BREAKDOWN_ROWS), false);
  assert.equal(isLargeSessionBreakdown('model', MAX_ANIMATED_BREAKDOWN_ROWS + 100), false);
});

test('row fingerprints stay stable until visible row output changes', () => {
  const row = {
    key: 'session:codex:s1',
    kind: 'session',
    name: 'Codex · gpt-5.6-sol',
    subtitle: '21:53 · 465 msgs',
    detail: 's1',
    value: 1234,
    cost: 0.42,
    color: '#49a3b0',
    client: 'codex'
  };
  const context = { breakdown: 'session', currency: 'USD', locale: 'en-US', showToolIcons: true };

  const fingerprint = rowRenderFingerprint(row, 5000, context);
  assert.equal(rowRenderFingerprint({ ...row }, 5000, { ...context }), fingerprint);
  assert.notEqual(rowRenderFingerprint({ ...row, value: 1235 }, 5000, context), fingerprint);
  assert.notEqual(rowRenderFingerprint(row, 6000, context), fingerprint);
  assert.notEqual(rowRenderFingerprint(row, 5000, { ...context, currency: 'HKD' }), fingerprint);
});

test('renderer applies the policy before touching breakdown rows', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

  assert.ok(html.indexOf('<script src="breakdownRenderPolicy.js"></script>') < html.indexOf('<script src="app.js"></script>'));
  assert.match(app, /shouldAnimateBreakdownRows\(rows\.length, \{ reducedMotion: prefersReducedMotion\(\) \}\)/);
  assert.match(app, /if \(rowRenderFingerprints\.get\(row\) === fingerprint\) continue;/);
  assert.match(app, /classList\.toggle\('large-session-list', largeSessionList\)/);
  assert.match(css, /\.breakdown\.large-session-list \.session-row\s*\{[^}]*content-visibility:\s*auto;[^}]*contain:\s*layout paint style;/s);
});
