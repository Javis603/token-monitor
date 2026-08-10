'use strict';

// The cold-start seed has to reach the same places a collected record does. Two
// of them are easy to lose: the tray, which reads what sendPush sets and is the
// only visible surface in tray mode, and a renderer that has not finished
// loading, which silently drops anything sent to it. main.js cannot be required
// outside Electron, hence the source-level contract.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

function functionSource(signature) {
  const start = main.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = main.indexOf('\nfunction ', start + signature.length);
  return main.slice(start, end === -1 ? main.length : end);
}

test('the anchor seed publishes through sendPush, not straight to the renderer', () => {
  const prime = functionSource('function primeLocalStatsFromAnchor(');
  assert.match(prime, /sendPush\(/);
  // Going direct would leave latestStats, the tray and the local status
  // injection on the empty state, which in tray mode is the whole UI.
  assert.doesNotMatch(prime, /sendMainWindowEvent\(/);
  // A republished snapshot must not spend the export interval the first live
  // scan of this run needs.
  assert.match(prime, /skipExport: true/);
  assert.match(prime, /deferToRenderer: true/);
});

test('only the seed waits for the renderer, so the deferral cannot queue up', () => {
  const push = functionSource('function sendPush(');
  // Live stats send directly. Deferring all of them would add a
  // did-finish-load listener per frame while the renderer loads, and the
  // renderer's own refreshStats() on init already covers what gets dropped.
  assert.match(push, /if \(options\.deferToRenderer\)/);
  assert.match(push, /else if \(mainWindow && !mainWindow\.isDestroyed\(\)\)/);
  assert.equal((main.match(/deferToRenderer: true/g) || []).length, 1, 'exactly one caller may defer');
  // The queued snapshot is only delivered while it is still what was published
  // last; deferredWindowSend.test.js covers the behaviour.
  assert.match(push, /latestStats === deferred/);
});

test('the seed runs before the collector and only on a cold start', () => {
  const localCollector = functionSource('function startLocalCollector()');
  const seedAt = localCollector.indexOf('primeLocalStatsFromAnchor(usageOptions, widgetProducerOwner);');
  const runtimeAt = localCollector.indexOf('createDeviceRuntime(');
  assert.ok(seedAt >= 0, 'the seed has to run');
  assert.ok(runtimeAt > seedAt, 'the seed has to land before the first scan starts');

  // Without this guard a settings change would replace lastCollectedDevice with
  // an anchor record carrying no limits, and initialLimits below reads from it.
  const prime = functionSource('function primeLocalStatsFromAnchor(');
  assert.match(prime, /if \(lastCollectedDevice\) return;/);
  assert.doesNotMatch(prime, /lastCollectedDevice =/);
});
