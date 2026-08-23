'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// app.js requires a renderer DOM, so it cannot be loaded here; these guard the
// wiring at the source level instead (same approach as refreshForceHistory.test.js).
const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const runtimeConfigSource = fs.readFileSync(path.join(__dirname, '../../src/electron/runtimeConfig.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');

function handlerBody(name) {
  const match = rendererSource.match(new RegExp(`async function ${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `${name} exists`);
  return match[1];
}

test('clients stays a usage-structural setting', () => {
  // The reason the toggle needs no forced refresh: main replaces the usage
  // runtime for this key, and a fresh collector runs its own initial tick.
  const keys = runtimeConfigSource.match(/const USAGE_STRUCTURAL_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(keys, 'USAGE_STRUCTURAL_KEYS exists');
  assert.match(keys[1], /'clients'/);
});

test('usage-structural changes replace usage without restarting limits', () => {
  const start = mainSource.indexOf("ipcMain.handle('settings:update'");
  const end = mainSource.indexOf("ipcMain.handle('appearance:preview'", start);
  const handler = mainSource.slice(start, end);
  assert.match(handler, /if \(runtimeChange\.usageStructural\) \{\s*reconfigureUsageRuntimeForMode\(\);\s*\}/);
  assert.doesNotMatch(handler, /runtimeChange\.usageStructural \|\| runtimeChange\.sinkStructural/);
  assert.match(mainSource, /usageRuntimeReconciler\.schedule\(usageSettingsFingerprint\(settings\)\)/);
});

test('tracking a tool does not stack a second full scan on the restart (#471)', () => {
  // A `clients` change already restarts the usage runtime, whose new collector
  // runs a full tick immediately. Forcing a refresh on top queues a second full
  // scan behind the first (runTick coalesces it) plus an all-provider limits
  // refresh, and the resulting stats pushes repaint the whole settings panel
  // mid-interaction.
  assert.doesNotMatch(handlerBody('onToolTrackingToggle'), /refreshStats/);
});

test('enabling a limits provider does not force a refresh either', () => {
  // Same decision, already made for the limits list. Keep both lists aligned so
  // one cannot silently regress back to the expensive path.
  assert.doesNotMatch(handlerBody('onLimitProviderToggle'), /refreshStats/);
});

test('the cheap per-row toggles stay cheap', () => {
  // Visibility and pin write display-only settings: no runtime restart, no scan.
  // These are the rows users compared against when reporting the stall.
  for (const name of ['onClientVisibilityToggle', 'onClientPinnedToggle']) {
    const match = rendererSource.match(new RegExp(`async function ${name}\\(clientId\\) \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(match, `${name} exists`);
    assert.doesNotMatch(match[1], /refreshStats/);
  }
});
