'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-usage-runtime-'));
process.env.TOKEN_MONITOR_SHARED_DIR = sharedDir;
process.on('exit', () => { try { fs.rmSync(sharedDir, { recursive: true, force: true }); } catch (_) {} });

const cursorAuth = require('../../src/shared/cursorAuth');
const { collectUsageOnce, startCollector } = require('../../src/shared/collector');
const { createUsageRuntime } = require('../../src/shared/usageRuntime');

function emptyTokscaleResult() {
  return { entries: [] };
}

function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for usage runtime update'));
      }
    }, 5);
  });
}

test('collectUsageOnce never calls or awaits a legacy limits collector', async () => {
  let snapshotCalls = 0;
  const summary = await collectUsageOnce({
    clients: '',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-only',
    limitsEnabled: true,
    limitsCollector: {
      snapshot: () => {
        snapshotCalls += 1;
        return new Promise(() => {});
      }
    }
  });

  assert.equal(snapshotCalls, 0);
  assert.equal(Object.hasOwn(summary, 'limits'), false);
  assert.equal(summary.today.totalTokens, 0);
});

test('createUsageRuntime exposes the usage lifecycle handle', () => {
  const expected = { stop() {}, tick() {}, refreshClient() {} };
  let receivedOptions = null;
  const runtime = createUsageRuntime({ clients: 'codex' }, {
    startCollector: (options) => {
      receivedOptions = options;
      return expected;
    }
  });

  assert.equal(runtime, expected);
  assert.equal(receivedOptions.clients, 'codex');
});

test('forced Cursor sync bypasses the throttle and resets the ordinary cadence', async () => {
  const originalReadActiveAccount = cursorAuth.readActiveAccount;
  const originalRunCursorSync = cursorAuth.runCursorSync;
  let syncCalls = 0;
  cursorAuth.readActiveAccount = () => ({ accountId: 'cursor-test' });
  cursorAuth.runCursorSync = async () => { syncCalls += 1; };

  const options = {
    clients: 'cursor',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-only',
    historyEnabled: false,
    runTokscale: async () => emptyTokscaleResult()
  };

  try {
    await collectUsageOnce({ ...options, forceCursorSync: true });
    await collectUsageOnce(options);
    assert.equal(syncCalls, 1);
  } finally {
    cursorAuth.readActiveAccount = originalReadActiveAccount;
    cursorAuth.runCursorSync = originalRunCursorSync;
  }
});

test('refreshClient cursor runs one targeted today scan without rebuilding the runtime', async () => {
  const originalReadActiveAccount = cursorAuth.readActiveAccount;
  const originalRunCursorSync = cursorAuth.runCursorSync;
  const flags = [];
  let syncCalls = 0;
  cursorAuth.readActiveAccount = () => ({ accountId: 'cursor-test' });
  cursorAuth.runCursorSync = async () => { syncCalls += 1; };
  const updates = [];

  const runtime = startCollector({
    clients: 'cursor',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-runtime',
    intervalMs: 60000,
    watchEnabled: false,
    historyEnabled: false,
    runTokscale: async ({ flags: scanFlags }) => {
      flags.push(scanFlags);
      return emptyTokscaleResult();
    },
    onUpdate: (summary, reason) => updates.push({ summary, reason })
  });

  try {
    await waitFor(() => updates.length >= 1);
    const callsAfterStartup = flags.length;
    await runtime.refreshClient('cursor', { forceSync: true });
    assert.equal(flags.length, callsAfterStartup + 1);
    assert.deepEqual(flags.at(-1), ['--today']);
    assert.equal(updates.at(-1).reason, 'client:cursor');
    assert.ok(syncCalls >= 1);
  } finally {
    runtime.stop();
    cursorAuth.readActiveAccount = originalReadActiveAccount;
    cursorAuth.runCursorSync = originalRunCursorSync;
  }
});

test('refreshClient rejects unsupported targeted usage clients', async () => {
  const runtime = startCollector({
    clients: '',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-runtime',
    intervalMs: 60000,
    watchEnabled: false,
    historyEnabled: false,
    onUpdate: () => {}
  });

  try {
    assert.throws(() => runtime.refreshClient('claude'), /Unsupported targeted usage client/);
  } finally {
    runtime.stop();
  }
});
