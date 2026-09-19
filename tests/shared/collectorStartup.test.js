'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cursorAuth = require('../../src/shared/providers/cursor/auth');
const { collectUsageOnce, startCollector } = require('../../src/shared/collector');
const { SYNC_MIN_INTERVAL_MS } = require('../../src/shared/selfSyncThrottle');

function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for startup collection'));
      }
    }, 5);
  });
}

test('startup publishes the local scan before optional Cursor self-sync settles', async () => {
  const originalRunCursorSync = cursorAuth.runCursorSync;
  let syncStarted = false;
  let syncSettled = false;
  let releaseSync;
  let announceSyncStart;
  const syncStart = new Promise((resolve) => { announceSyncStart = resolve; });
  const scans = [];
  const updates = [];
  cursorAuth.runCursorSync = ({ signal } = {}) => {
    syncStarted = true;
    announceSyncStart();
    return new Promise((resolve, reject) => {
      releaseSync = () => {
        syncSettled = true;
        resolve();
      };
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };

  const runtime = startCollector({
    clients: 'cursor',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'startup-self-sync-test',
    agentVersion: 'test',
    historyEnabled: false,
    dailyHistoryArchiveEnabled: false,
    projectsEnabled: false,
    wslScanEnabled: false,
    watchEnabled: false,
    anchorPersistenceEnabled: false,
    deferSelfSyncOnStartup: true,
    intervalMs: 60 * 60 * 1000,
    runTokscale: async ({ clients, flags }) => {
      scans.push({ clients, flags });
      return { entries: [] };
    },
    onUpdate: (summary, reason) => updates.push({ summary, reason })
  });

  try {
    await waitFor(() => updates.length >= 1);
    assert.equal(syncSettled, false, 'the first visible update must not wait for Cursor');
    assert.deepEqual(scans.slice(0, 3).map(({ flags }) => flags), [
      ['--today'],
      ['--month'],
      ['--since', '2024-01-01']
    ]);

    await waitFor(() => syncStarted);
    await syncStart;
    releaseSync();
    await waitFor(() => updates.length >= 2);

    assert.equal(updates[0].reason, 'interval');
    assert.equal(updates[1].reason, 'startup-self-sync');
    assert.equal(syncSettled, true);
    assert.deepEqual(scans.at(-1), { clients: 'cursor', flags: ['--today'] });
  } finally {
    runtime.stop();
    releaseSync?.();
    cursorAuth.runCursorSync = originalRunCursorSync;
  }
});

test('startup self-sync waits until every self-synced client is covered', async () => {
  const originalRunCursorSync = cursorAuth.runCursorSync;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-startup-'));
  fs.mkdirSync(path.join(tmpHome, '.gemini', 'antigravity'), { recursive: true });
  let cursorSyncs = 0;
  let antigravitySyncs = 0;
  let runtime;
  const updates = [];
  cursorAuth.runCursorSync = async () => { cursorSyncs += 1; };

  runtime = startCollector({
    clients: 'cursor,antigravity',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'startup-self-sync-multi-client-test',
    agentVersion: 'test',
    historyEnabled: false,
    dailyHistoryArchiveEnabled: false,
    projectsEnabled: false,
    wslScanEnabled: false,
    watchEnabled: false,
    anchorPersistenceEnabled: false,
    deferSelfSyncOnStartup: true,
    intervalMs: 60 * 60 * 1000,
    homeDir: tmpHome,
    runAntigravitySync: async () => { antigravitySyncs += 1; },
    runTokscale: async () => ({ entries: [] }),
    onUpdate: (_summary, reason) => {
      updates.push(reason);
      if (updates.length === 1) void runtime.refreshClient('cursor', { forceSync: true });
    }
  });

  try {
    await waitFor(() => updates.length >= 3);
    assert.deepEqual(updates.slice(0, 3), ['interval', 'coalesced', 'startup-self-sync']);
    assert.equal(cursorSyncs, 1, 'the targeted refresh should satisfy Cursor while its throttle is active');
    assert.equal(antigravitySyncs, 1, 'the startup catch-up must still sync Antigravity');
  } finally {
    runtime.stop();
    cursorAuth.runCursorSync = originalRunCursorSync;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('startup self-sync retries after the shared throttle allows it', async (t) => {
  const originalRunCursorSync = cursorAuth.runCursorSync;
  const originalNow = Date.now;
  const baseNow = originalNow();
  let clockOffsetMs = 0;
  let syncCalls = 0;
  Date.now = () => baseNow + clockOffsetMs;
  cursorAuth.runCursorSync = async () => { syncCalls += 1; };

  try {
    await collectUsageOnce({
      clients: 'cursor',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'startup-self-sync-throttle-seed',
      agentVersion: 'test',
      historyEnabled: false,
      dailyHistoryArchiveEnabled: false,
      projectsEnabled: false,
      wslScanEnabled: false,
      anchorPersistenceEnabled: false,
      forceSelfSync: ['cursor'],
      runTokscale: async () => ({ entries: [] })
    });
    assert.equal(syncCalls, 1);

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const runtime = startCollector({
      clients: 'cursor',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'startup-self-sync-throttle-test',
      agentVersion: 'test',
      historyEnabled: false,
      dailyHistoryArchiveEnabled: false,
      projectsEnabled: false,
      wslScanEnabled: false,
      watchEnabled: false,
      anchorPersistenceEnabled: false,
      deferSelfSyncOnStartup: true,
      intervalMs: 60 * 60 * 1000,
      runTokscale: async () => ({ entries: [] }),
      onUpdate: () => {}
    });

    try {
      await waitFor(() => runtime.getDiagnostics().lastTickSuccessAt !== null);
      assert.equal(syncCalls, 1, 'the startup catch-up stays pending while Cursor is throttled');

      clockOffsetMs = SYNC_MIN_INTERVAL_MS + 1000;
      t.mock.timers.tick(SYNC_MIN_INTERVAL_MS + 1000);
      await waitFor(() => syncCalls === 2);
      assert.equal(syncCalls, 2, 'the deferred startup sync retries after its throttle window');
    } finally {
      runtime.stop();
    }
  } finally {
    t.mock.timers.reset();
    Date.now = originalNow;
    cursorAuth.runCursorSync = originalRunCursorSync;
  }
});
