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

test('startCollector exposes safe on-demand runtime diagnostics', async () => {
  const updates = [];
  const runtime = startCollector({
    clients: 'codex',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-diagnostics',
    intervalMs: 60000,
    watchEnabled: false,
    watchTriggersCollection: false,
    historyEnabled: false,
    anchorPersistenceEnabled: false,
    runTokscale: async () => emptyTokscaleResult(),
    onUpdate: (summary, reason) => updates.push({ summary, reason })
  });

  try {
    await waitFor(() => updates.length >= 1);
    const diagnostics = runtime.getDiagnostics();
    assert.equal(diagnostics.state, 'idle');
    assert.equal(diagnostics.collectionMode, 'interval');
    assert.equal(diagnostics.watchMode, 'disabled');
    assert.equal(diagnostics.tickInFlight, false);
    assert.equal(diagnostics.tickPending, false);
    assert.equal(diagnostics.lastTickScope, 'full');
    assert.ok(diagnostics.lastTickAttemptAt);
    assert.ok(diagnostics.lastTickSuccessAt);
    assert.equal(diagnostics.lastFailureCode, null);
  } finally {
    runtime.stop();
  }
  assert.equal(runtime.getDiagnostics().state, 'stopped');
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
    await collectUsageOnce({ ...options, forceSelfSync: true });
    await collectUsageOnce(options);
    assert.equal(syncCalls, 1);
  } finally {
    cursorAuth.readActiveAccount = originalReadActiveAccount;
    cursorAuth.runCursorSync = originalRunCursorSync;
  }
});

test('a scoped force syncs only the client it names', async () => {
  const originalReadActiveAccount = cursorAuth.readActiveAccount;
  const originalRunCursorSync = cursorAuth.runCursorSync;
  let cursorSyncs = 0;
  let antigravitySyncs = 0;
  cursorAuth.readActiveAccount = () => ({ accountId: 'cursor-test' });
  cursorAuth.runCursorSync = async () => { cursorSyncs += 1; };

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-self-sync-'));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });
  const options = {
    clients: 'cursor,antigravity',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-only',
    historyEnabled: false,
    homeDir: home,
    runTokscale: async () => emptyTokscaleResult(),
    runAntigravitySync: async () => { antigravitySyncs += 1; }
  };

  try {
    // lastSyncAt lives at module scope, so arm both throttles here rather than
    // inheriting whatever earlier tests left behind. After this, the only thing
    // that can produce another sync is an explicit force.
    await collectUsageOnce({ ...options, forceSelfSync: true });
    const [primedCursor, primedAntigravity] = [cursorSyncs, antigravitySyncs];

    // A Cursor sign-in must not drag an unrelated `tokscale antigravity sync`
    // along with it, and vice versa.
    await collectUsageOnce({ ...options, forceSelfSync: ['cursor'] });
    assert.equal(cursorSyncs, primedCursor + 1);
    assert.equal(antigravitySyncs, primedAntigravity);

    await collectUsageOnce({ ...options, forceSelfSync: ['antigravity'] });
    assert.equal(cursorSyncs, primedCursor + 1);
    assert.equal(antigravitySyncs, primedAntigravity + 1);

    // `true` is the manual-refresh case: every self-synced client at once.
    await collectUsageOnce({ ...options, forceSelfSync: true });
    assert.equal(cursorSyncs, primedCursor + 2);
    assert.equal(antigravitySyncs, primedAntigravity + 2);

    // And an unforced tick still respects the throttle both syncs just reset.
    await collectUsageOnce(options);
    assert.equal(cursorSyncs, primedCursor + 2);
    assert.equal(antigravitySyncs, primedAntigravity + 2);
  } finally {
    cursorAuth.readActiveAccount = originalReadActiveAccount;
    cursorAuth.runCursorSync = originalRunCursorSync;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a backwards clock step cannot strand a self-sync behind its own stamp', async () => {
  // An NTP correction or a VM resume can move Date.now backwards, leaving the
  // last-sync stamp in the future. A negative elapsed compares below every floor,
  // so without a guard the throttle would hold for the length of the jump — and
  // the manual refresh, whose floor is zero, would be refused outright.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-clock-step-'));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });
  let antigravitySyncs = 0;
  const options = {
    clients: 'antigravity',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-only',
    historyEnabled: false,
    homeDir: home,
    runTokscale: async () => emptyTokscaleResult(),
    runAntigravitySync: async () => { antigravitySyncs += 1; }
  };

  const originalNow = Date.now;
  let clockOffsetMs = 0;
  Date.now = () => originalNow() + clockOffsetMs;
  try {
    await collectUsageOnce({ ...options, forceSelfSync: true });
    const primed = antigravitySyncs;

    clockOffsetMs = -60 * 60 * 1000;
    await collectUsageOnce({ ...options, forceSelfSync: true });
    assert.equal(antigravitySyncs, primed + 1, 'a manual refresh still waits for nothing');

    // Re-anchored to the stepped clock, so the ordinary floor applies again.
    await collectUsageOnce(options);
    assert.equal(antigravitySyncs, primed + 1);
  } finally {
    Date.now = originalNow;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('refreshClient cursor runs one targeted today scan without rebuilding the runtime', async () => {
  const originalReadActiveAccount = cursorAuth.readActiveAccount;
  const originalRunCursorSync = cursorAuth.runCursorSync;
  const flags = [];
  const scannedClients = [];
  let syncCalls = 0;
  cursorAuth.readActiveAccount = () => ({ accountId: 'cursor-test' });
  cursorAuth.runCursorSync = async () => { syncCalls += 1; };
  const updates = [];

  const runtime = startCollector({
    clients: 'cursor,claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-runtime',
    intervalMs: 60000,
    watchEnabled: false,
    historyEnabled: false,
    runTokscale: async ({ clients, flags: scanFlags }) => {
      scannedClients.push(clients);
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
    assert.equal(scannedClients.at(-1), 'cursor');
    assert.equal(updates.at(-1).reason, 'client:cursor');
    assert.ok(syncCalls >= 1);
  } finally {
    runtime.stop();
    cursorAuth.readActiveAccount = originalReadActiveAccount;
    cursorAuth.runCursorSync = originalRunCursorSync;
  }
});

test('a coalesced manual refresh stays a full scan', async () => {
  // The coalesced replay used to derive todayOnly from the force-sync flag,
  // which was invisible while only refreshClient set that flag. Now that the
  // refresh button sets it too, the derivation would silently downgrade a
  // manual "rescan everything" into a one-partition warm scan.
  const flags = [];
  const updates = [];
  let gate = null;

  const runtime = startCollector({
    clients: 'codex',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-runtime',
    intervalMs: 60000,
    watchEnabled: false,
    historyEnabled: false,
    runTokscale: async ({ flags: scanFlags }) => {
      flags.push(scanFlags);
      if (gate) await gate.promise;
      return emptyTokscaleResult();
    },
    onUpdate: (summary, reason) => updates.push({ summary, reason })
  });

  try {
    await waitFor(() => updates.length >= 1);
    const callsAfterStartup = flags.length;
    assert.equal(callsAfterStartup, 3, 'startup should be a full today/month/allTime scan');

    // Hold the first manual tick inside tokscale so the second one has to
    // coalesce onto it instead of running on its own.
    let release;
    gate = { promise: new Promise((resolve) => { release = resolve; }) };
    const first = runtime.tick('manual', { forceSelfSync: true });
    await waitFor(() => flags.length > callsAfterStartup);
    const second = runtime.tick('manual', { forceSelfSync: true });
    gate = null;
    release();
    await Promise.all([first, second]);

    // 3 for the tick that was in flight, 3 for the coalesced replay. A replay
    // that had inherited todayOnly would have added a single ['--today'].
    assert.equal(flags.length, callsAfterStartup + 6);
    assert.deepEqual(flags.at(-1), flags[2]);
  } finally {
    runtime.stop();
  }
});

test('coalesced targeted refreshes preserve the union of their clients', async () => {
  const scans = [];
  const updates = [];
  let gate = null;
  const runtime = startCollector({
    clients: 'claude,cursor',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-runtime',
    intervalMs: 60000,
    watchEnabled: false,
    historyEnabled: false,
    runTokscale: async ({ clients, flags }) => {
      scans.push({ clients, flags });
      if (gate) await gate.promise;
      return emptyTokscaleResult();
    },
    onUpdate: (summary, reason) => updates.push({ summary, reason })
  });

  try {
    await waitFor(() => updates.length >= 1);
    let release;
    gate = { promise: new Promise((resolve) => { release = resolve; }) };
    const held = runtime.tick('held', { todayOnly: true, targetClients: ['claude'] });
    await waitFor(() => scans.at(-1)?.flags?.[0] === '--today');
    const cursor = runtime.refreshClient('cursor');
    const claude = runtime.refreshClient('claude');
    gate = null;
    release();
    const results = await Promise.all([held, cursor, claude]);

    assert.deepEqual(results, [true, true, true]);
    assert.deepEqual(scans.at(-1), { clients: 'cursor,claude', flags: ['--today'] });
    assert.equal(updates.at(-1).reason, 'coalesced');
  } finally {
    runtime.stop();
  }
});

test('coalesced targeted refresh reports the replay failure', async () => {
  const scans = [];
  const updates = [];
  let gate = null;
  const runtime = startCollector({
    clients: 'claude,cursor',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-runtime',
    intervalMs: 60000,
    watchEnabled: false,
    historyEnabled: false,
    runTokscale: async ({ clients, flags }) => {
      scans.push({ clients, flags });
      if (gate) await gate.promise;
      if (clients === 'cursor') {
        throw new Error('scan failed');
      }
      return emptyTokscaleResult();
    },
    onUpdate: (summary, reason) => updates.push({ summary, reason }),
    onError: () => {}
  });

  try {
    await waitFor(() => updates.length >= 1);
    let release;
    gate = { promise: new Promise((resolve) => { release = resolve; }) };
    const held = runtime.tick('held', { todayOnly: true, targetClients: ['claude'] });
    await waitFor(() => scans.at(-1)?.flags?.[0] === '--today');
    const cursor = runtime.refreshClient('cursor');
    gate = null;
    release();

    assert.equal(await held, true);
    assert.equal(await cursor, false);
    assert.deepEqual(scans.at(-1), { clients: 'cursor', flags: ['--today'] });
  } finally {
    runtime.stop();
  }
});

// Targeted refresh is a control-plane API: it accepts only exact clients this
// collector is configured to track, so bad input can never widen into all-client
// work after collectUsageOnce filters it.
test('refreshClient rejects empty, unknown, and untracked clients before scanning', async () => {
  let scans = 0;
  let updates = 0;
  const runtime = startCollector({
    clients: 'claude,cursor',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'usage-runtime',
    intervalMs: 60000,
    watchEnabled: false,
    historyEnabled: false,
    runTokscale: async () => { scans += 1; return emptyTokscaleResult(); },
    onUpdate: () => { updates += 1; }
  });

  try {
    await waitFor(() => updates >= 1);
    const startupScans = scans;
    assert.throws(() => runtime.refreshClient(''), /Unsupported targeted usage client/);
    assert.throws(() => runtime.refreshClient(null), /Unsupported targeted usage client/);
    assert.throws(() => runtime.refreshClient('codex'), /Unsupported targeted usage client: codex/);
    assert.throws(() => runtime.refreshClient('not-a-client'), /Unsupported targeted usage client: not-a-client/);
    assert.equal(scans, startupScans);
    assert.doesNotThrow(() => { void runtime.refreshClient('claude'); });
    assert.doesNotThrow(() => { void runtime.refreshClient('cursor', { forceSync: true }); });
  } finally {
    runtime.stop();
  }
});
