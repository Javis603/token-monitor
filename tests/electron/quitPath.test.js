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


test('tray and signal quit flush plugin and quota history state before immediate exit', () => {
  const vm = require('node:vm');
  const events = [];
  const context = { console, quitRequested: false, quitInProgress: false,
    pluginRuntime: { dispose() { events.push('flush'); } },
    stopPersistBoundsTimer() {}, stopLocalCollector() {}, stopStatsStream() {}, stopHostStats() {},
    stopSyncCollector() {}, stopIcloudRuntime() {}, terminateUsageHostSubprocesses() {},
    syncStatsPublication: { cancel() {} }, macWidgetSnapshotController: null, macWidgetDemand: null,
    stopEmbeddedHub() {}, stopDiscordRpc() {}, sessionUsageArchiveStore: { close() {} }, tray: null,
    limitsHistoryController: null, limitsHistoryStore: { closeSync() { events.push('quota-close'); } },
    app: { exit() { events.push('exit'); } } };
  vm.runInNewContext(main.slice(main.indexOf('function stopAll()'), main.indexOf('\nlet quitRequested')) + '\n'
    + main.slice(main.indexOf('function performQuit()'), main.indexOf('// Write the export file set')), context);
  context.requestAppQuit();
  assert.deepEqual(events, ['flush', 'quota-close', 'exit']);
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

test('an aborted updater handoff can reopen quota history after draining the prior worker', async t => {
  const vm = require('node:vm');
  const os = require('node:os');
  const { createLimitsHistoryStore } = require('../../src/electron/limits/historyStore');
  const { createUpdateInstallQuitGuard } = require('../../src/electron/updateInstallQuit');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-update-recovery-'));
  let beforeQuit;
  let historyOptions;
  const events = [];
  const clock = new Date(2026, 10, 3, 12).getTime();
  const context = {
    settings: { hubMode: 'local', hubUrl: 'https://hub.test/', hubHostPort: 17321 }, normalizeHubPort: port => port,
    path, createLimitsHistoryStore: (file, options) => { historyOptions = options; return createLimitsHistoryStore(file, { ...options, now: () => clock }); }, limitsHistoryStore: null,
    limitsHistoryController: { dispose() { events.push('preview-close'); }, refresh() {} },
    app: { getPath: () => directory, on: (_event, callback) => { beforeQuit = callback; } },
    console, quitRequested: false, skipForcedQuit: false,
    antigravityOAuthLoginController: null, workbuddyManagedAccountService: null,
    resetMacWidgetReloadThrottle() {}, rateRefreshTimer: null, appUpdateBackgroundTimer: null,
    clearInterval() {}, stopTaskbarZOrderKeeper() {}, unregisterWindowToggleShortcut() {},
    edgeDockController: null, notchController: null, clearTimeout() {}, notchRateTimer: null,
    electronWorkbuddyLocalAuth: { dispose() {} }, disposePluginRuntime() {},
    performQuit() { throw new Error('the installer owns this quit'); }
  };
  t.after(async () => { await context.limitsHistoryStore?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const getter = main.slice(main.indexOf('function getLimitsHistoryStore()'), main.indexOf('async function limitsHistoryPayload('));
  const start = main.indexOf("app.on('before-quit'");
  const handler = main.slice(start, main.indexOf('\n});', start) + 4);
  const config = main.slice(main.indexOf('function effectiveHubConfig('), main.indexOf('function hubDataFile('));
  vm.runInNewContext(config + getter + handler, context);
  const now = clock;
  const row = (offset, used) => ({ provider: 'codex', accountKey: 'update-test', status: 'ok', updatedAt: new Date(now + offset).toISOString(),
    windows: [{ kind: 'weekly', usedPercent: used }] });
  const previous = context.getLimitsHistoryStore();
  assert.equal(context.effectiveHubConfig().url, null, 'local mode has no active Hub URL');
  assert.ok(historyOptions.legacyScopes().includes('client|https://hub.test'), 'saved Hub history remains discoverable in local mode');
  assert.ok(historyOptions.legacyScopes().includes('host|http://127.0.0.1:17321'));
  await previous.record('local', { providers: [row(-300_000, 20)] });
  const drain = previous.closeSync;
  previous.closeSync = () => { events.push('history-drain'); drain(); };
  const guard = createUpdateInstallQuitGuard({
    graceMs: 1000, setTimeoutFn: () => ({ unref() {} }), clearTimeoutFn() {},
    claim() { context.quitRequested = true; context.skipForcedQuit = true; },
    release() { context.quitRequested = false; context.skipForcedQuit = false; }
  });
  assert.equal(guard.request(), true);
  beforeQuit();
  assert.deepEqual(events, ['preview-close', 'history-drain']);
  assert.equal(guard.abort(), true);
  const recovered = context.getLimitsHistoryStore();
  assert.notEqual(recovered, previous, 'an aborted update cannot retain the permanently closed store');
  await recovered.record('local', { providers: [row(0, 25)] });
  const history = (await recovered.query('local', row(0, 25))).windows[0];
  assert.deepEqual(history.points.map(point => point.value), [20, 25]);
  assert.equal(history.distribution.buckets.at(-1).value, 5);
});
