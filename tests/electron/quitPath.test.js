'use strict';

// Quitting used to hang: teardown blocked the main thread and the app never
// reached its exit. The fix is a teardown that stays synchronous all the way to
// the exit, and the failure mode is subtle enough to re-introduce by accident,
// so the shape is asserted here. main.js cannot be required outside Electron,
// hence the source-level contract.

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

test('nothing asynchronous sits between teardown and the exit', () => {
  const performQuit = functionSource('function performQuit()');
  const teardownAt = performQuit.indexOf('stopAll();');
  const exitAt = performQuit.indexOf('app.exit(0);');
  // Both positions are checked before they are compared: a missing call reads as
  // -1, which would otherwise satisfy the ordering on its own.
  assert.ok(teardownAt >= 0, 'quit teardown has to run');
  assert.ok(exitAt > teardownAt, 'the exit has to follow teardown');
  // An await here is the original bug in a new place: whatever it waits on gets
  // to decide whether the process ever exits.
  assert.doesNotMatch(performQuit, /\bawait\b/);
  assert.doesNotMatch(performQuit, /^async function performQuit/);
  // app.exit() is the documented immediate exit and reports success. Reaching
  // for an unconditional kill instead would need a reproducer showing app.exit()
  // itself hangs once the expensive teardown is skipped, and there is none.
  assert.doesNotMatch(performQuit, /SIGKILL/);
});

test('quit teardown never waits on the embedded hub', () => {
  const stopAll = functionSource('function stopAll()');
  assert.doesNotMatch(stopAll, /^async function stopAll/);
  // server.close() does not complete until every in-flight request does, so a
  // remote device on the embedded hub would otherwise gate our own exit.
  assert.match(stopAll, /void stopEmbeddedHub\(\);/);
  assert.doesNotMatch(stopAll, /\bawait\b/);
});

test('before-quit hands over without taking the quit away from the OS', () => {
  const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"));
  const handler = beforeQuit.slice(0, beforeQuit.indexOf('\n});'));
  assert.match(handler, /performQuit\(\);/);
  // preventDefault would cancel an OS-initiated logout or restart on macOS, and
  // a synchronous performQuit gives it nothing to buy.
  assert.doesNotMatch(handler, /preventDefault/);
  // electron-updater owns the restart, so that one route has to opt out.
  assert.match(handler, /if \(skipForcedQuit\) \{ disposePluginRuntime\(\); return; \}/);
  assert.match(main, /skipForcedQuit = true;/);
});


test('tray and signal quit flush plugin state before immediate exit', () => {
  const vm = require('node:vm');
  const events = [];
  const context = { console, quitRequested: false, quitInProgress: false,
    pluginRuntime: { dispose() { events.push('flush'); } },
    stopPersistBoundsTimer() {}, stopLocalCollector() {}, stopStatsStream() {}, stopHostStats() {},
    stopSyncCollector() {}, stopIcloudRuntime() {}, terminateUsageHostSubprocesses() {},
    syncStatsPublication: { cancel() {} }, macWidgetSnapshotController: null, macWidgetDemand: null,
    stopEmbeddedHub() {}, stopDiscordRpc() {}, sessionUsageArchiveStore: { close() {} }, tray: null,
    app: { exit() { events.push('exit'); } } };
  vm.runInNewContext(main.slice(main.indexOf('function stopAll()'), main.indexOf('\nlet quitRequested')) + '\n'
    + main.slice(main.indexOf('function performQuit()'), main.indexOf('// Write the export file set')), context);
  context.requestAppQuit();
  assert.deepEqual(events, ['flush', 'exit']);
});

test('a failing plugin teardown cannot skip the host shutdown that follows it', () => {
  const stopAll = functionSource('function stopAll()');
  assert.match(stopAll, /^function stopAll\(\) \{\s*disposePluginRuntime\(\);/);
  assert.equal((main.match(/pluginRuntime\?\.dispose\(\)/g) || []).length, 1, 'every dispose goes through the guard');
  const warnings = [];
  const dispose = new Function('pluginRuntime', 'console', `${main.match(/function disposePluginRuntime\(\) \{[\s\S]*?\n\}/)[0]}; return disposePluginRuntime;`)(
    { dispose() { throw new Error('boom'); } }, { warn: message => warnings.push(message) });
  assert.doesNotThrow(dispose);
  assert.deepEqual(warnings, ['[plugins] dispose failed: boom']);
});
