'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cursorAuth = require('../../src/shared/cursorAuth');
const { createDeviceRuntime } = require('../../src/shared/deviceRuntime');
const { startCollector, selfSyncThrottle } = require('../../src/shared/collector');
const { SYNC_SOURCE_EVENT_MIN_INTERVAL_MS } = require('../../src/shared/selfSyncThrottle');

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for collector lifecycle');
    await nextTurn();
  }
}

test('stopping superseded collectors aborts their physical scan before the next period', async () => {
  let active = 0;
  let maxActive = 0;
  let aborted = 0;
  let completed = 0;
  const calls = [];

  function runTokscale({ flags, signal }) {
    calls.push(flags);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        active -= 1;
        completed += 1;
        signal.removeEventListener('abort', onAbort);
        resolve({ entries: [] });
      }, 1000);
      function onAbort() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active -= 1;
        aborted += 1;
        reject(signal.reason);
      }
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  const options = {
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 5000,
    deviceId: 'cancellation-test',
    agentVersion: 'test',
    agentRuntime: 'test',
    historyEnabled: false,
    dailyHistoryArchiveEnabled: false,
    projectsEnabled: false,
    wslScanEnabled: false,
    watchEnabled: false,
    anchorPersistenceEnabled: false,
    homeDir: '/nonexistent-token-monitor-cancellation-test-home',
    osInfo: {},
    runTokscale,
    onUpdate() {}
  };

  let runtime = startCollector(options);
  await nextTurn();
  for (let index = 0; index < 30; index += 1) {
    runtime.stop();
    runtime = startCollector(options);
    await nextTurn();
  }
  runtime.stop();
  await nextTurn();

  assert.equal(calls.length, 31);
  assert.ok(calls.every((flags) => flags.includes('--today')), 'no superseded collector may advance to month/all-time');
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.equal(aborted, 31);
  assert.equal(completed, 0);
});

test('usage replacement waits for an aborted tokscale child to close before spawning again', async () => {
  const childProcess = require('node:child_process');
  const collectorPath = require.resolve('../../src/shared/collector');
  const originalSpawn = childProcess.spawn;
  const children = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => true;
    children.push(child);
    if (children.length > 1) {
      setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({ entries: [] }));
        child.emit('close', 0);
      });
    }
    return child;
  };
  delete require.cache[collectorPath];

  let runtime = null;
  try {
    const fresh = require(collectorPath);
    const usageOptions = {
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 5000,
      deviceId: 'physical-close-barrier-test',
      agentVersion: 'test',
      historyEnabled: false,
      dailyHistoryArchiveEnabled: false,
      projectsEnabled: false,
      wslScanEnabled: false,
      watchEnabled: false,
      anchorPersistenceEnabled: false
    };
    runtime = createDeviceRuntime({ usageOptions }, {
      createUsageRuntime: (next) => fresh.startCollector(next),
      createLimitsRuntime: () => ({ stop() {} })
    });
    await waitFor(() => children.length === 1);

    assert.equal(runtime.reconfigureUsage(usageOptions), true);
    assert.equal(runtime.reconfigureUsage(usageOptions), true);
    await nextTurn();
    assert.equal(children.length, 1, 'even chained replacements must remain behind the physical close barrier');

    children[0].emit('close', null, 'SIGTERM');
    await waitFor(() => children.length >= 2);
  } finally {
    runtime?.stop();
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('timed-out tokscale remains the replacement barrier through forced termination', async () => {
  const childProcess = require('node:child_process');
  const collectorPath = require.resolve('../../src/shared/collector');
  const originalSpawn = childProcess.spawn;
  const children = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.signals = [];
    child.kill = (signal) => { child.signals.push(signal); return true; };
    children.push(child);
    if (children.length > 1) {
      setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({ entries: [] }));
        child.emit('close', 0);
      });
    }
    return child;
  };
  delete require.cache[collectorPath];

  let runtime = null;
  try {
    const fresh = require(collectorPath);
    const usageOptions = {
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1,
      deviceId: 'timeout-close-barrier-test',
      agentVersion: 'test',
      historyEnabled: false,
      dailyHistoryArchiveEnabled: false,
      projectsEnabled: false,
      wslScanEnabled: false,
      watchEnabled: false,
      anchorPersistenceEnabled: false
    };
    runtime = createDeviceRuntime({ usageOptions }, {
      createUsageRuntime: (next) => fresh.startCollector(next),
      createLimitsRuntime: () => ({ stop() {} })
    });
    await waitFor(() => children[0]?.signals.includes('SIGTERM'));

    assert.equal(runtime.reconfigureUsage(usageOptions), true);
    await nextTurn();
    assert.equal(children.length, 1, 'replacement stays blocked after the timeout requests SIGTERM');

    await waitFor(() => children[0].signals.includes('SIGKILL'), 3500);
    assert.equal(children.length, 1, 'forced termination is still only a request until close');

    children[0].emit('close', null, 'SIGKILL');
    await waitFor(() => children.length >= 2);
  } finally {
    runtime?.stop();
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('a self-sync cancelled by usage replacement is neutral and returns its allowance', async () => {
  const originalReadActiveAccount = cursorAuth.readActiveAccount;
  const originalRunCursorSync = cursorAuth.runCursorSync;
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cancelled-self-sync-'));
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = sharedDir;
  let syncCalls = 0;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  cursorAuth.readActiveAccount = () => ({ accountId: 'cursor-test' });
  cursorAuth.runCursorSync = ({ signal } = {}) => {
    syncCalls += 1;
    if (syncCalls > 1) return Promise.resolve();
    firstStartedResolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  };

  const options = {
    clients: 'cursor',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 5000,
    deviceId: 'self-sync-cancellation-test',
    agentVersion: 'test',
    historyEnabled: false,
    dailyHistoryArchiveEnabled: false,
    projectsEnabled: false,
    wslScanEnabled: false,
    watchEnabled: false,
    anchorPersistenceEnabled: false,
    runTokscale: async () => ({ entries: [] })
  };
  let superseded = null;
  let replacement = null;
  try {
    superseded = startCollector({ ...options, onUpdate() {} });
    await firstStarted;
    superseded.stop();

    const updates = [];
    replacement = startCollector({ ...options, onUpdate: (summary) => updates.push(summary) });
    await waitFor(() => updates.length === 1);

    assert.equal(syncCalls, 2, 'the cancelled claim does not block the replacement sync');
    assert.equal(selfSyncThrottle.sourceFloorMs('cursor'), SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);
    assert.equal(selfSyncThrottle.syncStatus('cursor').state, 'ok');
    assert.notEqual(updates[0].clientHealth.clients.cursor.collection.state, 'failed');
  } finally {
    superseded?.stop();
    replacement?.stop();
    cursorAuth.readActiveAccount = originalReadActiveAccount;
    cursorAuth.runCursorSync = originalRunCursorSync;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    fs.rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('native Antigravity cancellation releases the claim without publishing failure', async () => {
  const childProcess = require('node:child_process');
  const collectorPath = require.resolve('../../src/shared/collector');
  const originalSpawn = childProcess.spawn;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cancelled-antigravity-'));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });
  let syncSpawns = 0;
  let killed = 0;
  let firstSyncChild = null;
  childProcess.spawn = (_bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => { killed += 1; };
    if (args.includes('antigravity') && args.includes('sync')) {
      syncSpawns += 1;
      if (syncSpawns === 1) firstSyncChild = child;
      if (syncSpawns > 1) setImmediate(() => child.emit('close', 0));
    }
    return child;
  };
  delete require.cache[collectorPath];

  try {
    const fresh = require(collectorPath);
    const controller = new AbortController();
    const options = {
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 5000,
      deviceId: 'antigravity-cancellation-test',
      agentVersion: 'test',
      historyEnabled: false,
      homeDir: home,
      runTokscale: async () => ({ entries: [] })
    };
    const cancelled = fresh.collectUsageOnce({ ...options, signal: controller.signal });
    await waitFor(() => syncSpawns === 1);
    controller.abort(new Error('usage runtime superseded'));
    let cancellationSettled = false;
    cancelled.catch(() => { cancellationSettled = true; });
    await nextTurn();
    assert.equal(cancellationSettled, false, 'Antigravity cancellation waits for child close');
    firstSyncChild.emit('close', null, 'SIGTERM');
    await assert.rejects(cancelled, /usage runtime superseded/);

    assert.equal(killed, 1);
    assert.equal(fresh.selfSyncThrottle.syncStatus('antigravity').state, 'idle');
    assert.equal(fresh.selfSyncThrottle.sourceFloorMs('antigravity'), SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);

    const replacement = await fresh.collectUsageOnce(options);
    assert.equal(syncSpawns, 2, 'the replacement immediately owns the restored allowance');
    assert.equal(fresh.selfSyncThrottle.syncStatus('antigravity').state, 'ok');
    assert.notEqual(replacement.clientHealth.clients.antigravity.collection.state, 'failed');
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('native Antigravity timeout remains pending until the child closes', async () => {
  const childProcess = require('node:child_process');
  const collectorPath = require.resolve('../../src/shared/collector');
  const originalSpawn = childProcess.spawn;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-timeout-antigravity-'));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });
  let syncChild = null;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.signals = [];
    child.kill = (signal) => { child.signals.push(signal); return true; };
    syncChild = child;
    return child;
  };
  delete require.cache[collectorPath];

  try {
    const fresh = require(collectorPath);
    let failed = 0;
    const pending = fresh.collectUsageOnce({
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 5000,
      selfSyncTimeoutMs: 1,
      deviceId: 'antigravity-timeout-test',
      agentVersion: 'test',
      historyEnabled: false,
      homeDir: home,
      runTokscale: async () => ({ entries: [] }),
      onSelfSyncFailed: () => { failed += 1; }
    });
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });

    await waitFor(() => syncChild?.signals.includes('SIGTERM'));
    assert.equal(settled, false, 'sync timeout must not release the operation before close');
    assert.equal(fresh.selfSyncThrottle.syncStatus('antigravity').state, 'pending');

    syncChild.emit('close', null, 'SIGTERM');
    const summary = await pending;
    assert.equal(failed, 1);
    assert.equal(fresh.selfSyncThrottle.syncStatus('antigravity').failureCode, 'sync-timeout');
    assert.equal(summary.clientHealth.clients.antigravity.collection.state, 'failed');
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
    fs.rmSync(home, { recursive: true, force: true });
  }
});
