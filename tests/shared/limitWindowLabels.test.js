'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  FIVE_HOUR_WINDOW_PROVIDERS,
  limitWindowKindLabel,
  limitWindowLabel
} = require('../../src/shared/limitWindowLabels');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

test('the collector label always wins over the kind default', () => {
  assert.equal(limitWindowLabel('claude', { kind: 'weekly', label: 'Fable' }), 'Fable');
  assert.equal(limitWindowLabel('kiro', { kind: 'billing', label: 'Overage' }), 'Overage');
  // Whitespace-only is not a name.
  assert.equal(limitWindowLabel('codex', { kind: 'session', label: '   ' }), 'Session');
});

test('rolling windows are named the way their vendor names them', () => {
  for (const id of ['alibaba', 'antigravity', 'commandcode', 'kimi', 'volcengine', 'zai', 'zaiteam']) {
    assert.equal(limitWindowKindLabel(id, 'session'), '5-hour', `${id} publishes a 5-hour window`);
  }
  for (const id of ['codex', 'claude', 'opencode', 'ollama', 'minimax']) {
    assert.equal(limitWindowKindLabel(id, 'session'), 'Session', `${id} publishes a session window`);
  }
});

test('the remaining kinds are named the same for every provider', () => {
  for (const id of ['codex', 'commandcode', 'volcengine']) {
    assert.equal(limitWindowKindLabel(id, 'daily'), 'Daily');
    assert.equal(limitWindowKindLabel(id, 'weekly'), 'Weekly');
    assert.equal(limitWindowKindLabel(id, 'billing'), 'Monthly');
  }
});

test('an unknown kind falls back to the caller, never to a wrong name', () => {
  assert.equal(limitWindowKindLabel('codex', 'quarterly'), '');
  assert.equal(limitWindowLabel('cursor', { kind: 'quarterly' }, 'Quota'), 'Quota');
  assert.equal(limitWindowLabel('cursor', null, 'Quota'), 'Quota');
  assert.equal(limitWindowLabel('cursor', null), '');
});

// Command Code's rolling windows ship with no label at all (rollingWindow() in
// providers/commandcode/limits.js emits kind only), which is why the Limits
// view used to hard-code "5-hour" and the edge dock — reading the same record —
// showed "Session". Both now resolve the name the same way.
test('Command Code rolling windows resolve to 5-hour from the kind alone', () => {
  assert.equal(limitWindowLabel('commandcode', { kind: 'session', label: '' }), '5-hour');
  assert.equal(limitWindowLabel('commandcode', { kind: 'weekly', label: '' }), 'Weekly');
});

test('every surface that paints a window label routes through the helper', () => {
  const app = read('src/electron/renderer/app.js');
  const dock = read('src/electron/renderer/edgeDock/dock.js');
  const widget = read('src/shared/macWidgetSnapshot.js');

  assert.match(app, /const \{ limitWindowLabel \} = window\.TokenMonitorLimitWindowLabels;/);
  assert.match(dock, /const limitWindowLabels = window\.TokenMonitorLimitWindowLabels;/);
  assert.match(widget, /require\('\.\/limitWindowLabels'\)/);

  // The duplicated per-provider knowledge is gone from the widget snapshot.
  assert.doesNotMatch(widget, /FIVE_HOUR_WINDOW_PROVIDERS/);
  // The dock no longer keeps a kind table of its own.
  assert.doesNotMatch(dock, /WINDOW_KIND_LABELS/);
  // The Limits view no longer hard-codes a rolling-window name.
  assert.doesNotMatch(app, /limitWindowNode\('5-hour'/);

  for (const page of ['src/electron/renderer/index.html', 'src/electron/renderer/edgeDock/index.html']) {
    assert.match(read(page), /limitWindowLabels\.js/, `${page} should load the helper`);
  }
});

test('the default is display-only and never written onto the wire', () => {
  // Two renderers read "no label" as real information — Claude's unlabelled
  // all-models weekly pairs with Session while the labelled promo weekly takes
  // a full row, and third-party presets title their balance from the label the
  // collector set. Defaulting inside normalizeLimitWindow would erase that.
  const core = read('src/shared/limits/core.js');
  assert.doesNotMatch(core, /limitWindowLabels/);
  assert.match(read('src/electron/renderer/limitWindowsView.js'), /if \(weekly\.label\) node\.classList\.add\('limit-window-wide'\)/);

  const { normalizeLimitWindow } = require('../../src/shared/limits/core');
  const normalized = normalizeLimitWindow({ kind: 'session', used: 1, limit: 4 });
  assert.equal(normalized.label, '', 'an unnamed window stays unnamed on the wire');
});

test('the helper carries no knowledge that contradicts the provider catalogue', () => {
  const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limitProviders');
  const known = new Set(LIMIT_PROVIDER_IDS);
  for (const id of FIVE_HOUR_WINDOW_PROVIDERS) {
    assert.ok(known.has(id), `${id} should be a registered limit provider`);
  }
});
