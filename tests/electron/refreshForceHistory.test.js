'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// main.js requires electron at the top level, so it cannot be loaded here; these
// guard the wiring at the source level instead (same approach as the
// renderHomeTrendsModule guard in homeOverview.test.js).
const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');

test('the manual refresh button requests today-only usage without a history rescan', () => {
  const handler = rendererSource.match(/els\.refreshButton\.addEventListener\('click',([\s\S]*?)\n\}\);/);
  assert.ok(handler, 'refresh button handler exists');
  assert.match(handler[0], /refreshStats\(\{[^}]*todayOnly: true[^}]*\}\)/);
  assert.match(handler[0], /forceSelfSync: true/);
  assert.match(handler[0], /feedback: true/);
  assert.doesNotMatch(handler[0], /forceHistory: true/);
});

test('manual refresh keeps the expensive history graph out of ordinary clicks', () => {
  const handler = rendererSource.match(/els\.refreshButton\.addEventListener\('click',([\s\S]*?)\n\}\);/);
  assert.ok(handler, 'refresh button handler exists');
  assert.doesNotMatch(handler[0], /forceHistory: true/);
});

test('a forced history refresh restores the Home full-history retry budget', () => {
  const refreshStats = rendererSource.match(/async function refreshStats\(options = \{\}\) \{([\s\S]*?)\n\}\n\nasync function refreshStatusViewManually/);
  assert.ok(refreshStats, 'refreshStats exists');
  const body = refreshStats[1];
  assert.match(body, /options\.forceHistory === true/);
  assert.match(body, /homeHistoryLoadedSignature = ''/);
  assert.match(body, /homeHistoryRetrySignature = ''/);
  assert.match(body, /homeHistoryRetries = 0/);
  assert.match(body, /homeHistorySignature = ''/);
});

test('fetchStats reads forceHistory independently of force', () => {
  const fetchStats = mainSource.match(/async function fetchStats\(options = \{\}\) \{([\s\S]*?)\n {2}if \(mode === 'local'\)/);
  assert.ok(fetchStats, 'fetchStats exists');
  const head = fetchStats[1];
  // The tick option must come from its own flag, never be aliased to `force`.
  assert.match(head, /forceHistory: Boolean\(options\?\.forceHistory\)/);
  assert.doesNotMatch(head, /forceHistory: force\b/);
  assert.doesNotMatch(head, /forceHistory: true/);
});
