'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_ANIMATED_BREAKDOWN_ROWS,
  createAfterLayoutScheduler,
  isLargeSessionBreakdown,
  rowRenderFingerprint,
  shouldAnimateBreakdownRows,
  toolIconsEnabled
} = require('../../src/electron/renderer/breakdownRenderPolicy');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

test('small breakdowns keep motion while large breakdowns skip it', () => {
  assert.equal(shouldAnimateBreakdownRows(MAX_ANIMATED_BREAKDOWN_ROWS), true);
  assert.equal(shouldAnimateBreakdownRows(MAX_ANIMATED_BREAKDOWN_ROWS + 1), false);
});

test('reduced motion skips layout capture even for small breakdowns', () => {
  assert.equal(shouldAnimateBreakdownRows(1, { reducedMotion: true }), false);
});

test('tool icon state uses the same strict normalization as row rendering', () => {
  assert.equal(toolIconsEnabled(undefined), false);
  assert.equal(toolIconsEnabled(false), false);
  assert.equal(toolIconsEnabled(true), true);
});

test('off-screen containment waits for two frames and can be cancelled', () => {
  let nextHandle = 1;
  const callbacks = new Map();
  const requestFrame = (callback) => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  };
  const cancelFrame = (handle) => callbacks.delete(handle);
  const runNextFrame = () => {
    const [handle, callback] = callbacks.entries().next().value;
    callbacks.delete(handle);
    callback();
  };
  const scheduler = createAfterLayoutScheduler(requestFrame, cancelFrame);
  let ready = false;

  scheduler.schedule(() => { ready = true; });
  assert.equal(scheduler.pending(), true);
  runNextFrame();
  assert.equal(ready, false);
  assert.equal(scheduler.pending(), true);
  runNextFrame();
  assert.equal(ready, true);
  assert.equal(scheduler.pending(), false);

  scheduler.schedule(() => { ready = false; });
  scheduler.cancel();
  assert.equal(scheduler.pending(), false);
  assert.equal(callbacks.size, 0);
  assert.equal(ready, true);
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
  assert.match(app, /showToolIcons:\s*toolIconsEnabled\(state\.settings\?\.showToolIcons\)/);
  assert.match(app, /updateLargeSessionContainment\(largeSessionList, \{ remeasure: structureChanged \}\)/);
  assert.match(app, /largeSessionContainmentScheduler\.schedule\(\(\) => \{/);
  assert.match(css, /\.breakdown\.large-session-list \.session-row\s*\{[^}]*contain-intrinsic-block-size:\s*auto 72px;/s);
  assert.match(css, /\.breakdown\.large-session-list\.large-session-list-ready \.session-row\s*\{[^}]*content-visibility:\s*auto;[^}]*contain:\s*layout paint style;/s);
});
