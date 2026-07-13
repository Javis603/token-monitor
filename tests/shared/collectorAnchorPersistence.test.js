'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const collectorPath = require.resolve('../../src/shared/collector');

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

const {
  configFingerprint,
  collectUsageOnce,
  localTodayKey
} = require('../../src/shared/collector');

const { emptyPeriod } = require('../../src/shared/usage');

const baseOptions = {
  clients: 'claude',
  allTimeSince: '2024-01-01',
  commandTimeoutMs: 1000,
  deviceId: 'test-device',
  agentVersion: 'test',
  limitsEnabled: false,
  historyEnabled: false
};

test('configFingerprint normalizes clients and includes allTimeSince and project tracking', () => {
  const a = configFingerprint('claude, codex', '2024-01-01');
  const b = configFingerprint('claude,codex', '2024-01-01');
  // whitespace-normalised to the same value
  assert.equal(a, b, 'whitespace should be normalized');
  assert.match(a, /^claude,codex\|2024-01-01\|projects:on$/);

  const c = configFingerprint('claude', '2024-01-01');
  assert.notEqual(a, c, 'different clients should differ');

  const d = configFingerprint('claude,codex', '2024-06-01');
  assert.notEqual(a, d, 'different allTimeSince should differ');

  const e = configFingerprint('claude,codex', '2024-01-01', false);
  assert.notEqual(a, e, 'project tracking changes should invalidate persisted anchors');
});

test('configFingerprint handles undefined and empty clients', () => {
  const a = configFingerprint(undefined, '2024-01-01');
  assert.equal(a, '|2024-01-01|projects:on', 'undefined clients should produce empty string before pipe');

  const b = configFingerprint('', '2024-01-01');
  assert.equal(b, '|2024-01-01|projects:on', 'empty clients should produce same as undefined');

  const c = configFingerprint('claude', undefined);
  assert.match(c, /\|undefined\|projects:on$/, 'undefined allTimeSince produces string "undefined"');
});

test('anchored tick with valid anchor runs todayOnly scan and derives month/allTime', async () => {
  const dateKey = localTodayKey();

  // Establish a baseline anchor from a "previous full scan"
  const anchorToday = emptyPeriod();
  anchorToday.totalTokens = 50;
  anchorToday.clients = { claude: 50 };

  const anchorMonth = emptyPeriod();
  anchorMonth.totalTokens = 500;
  anchorMonth.clients = { claude: 500 };

  const anchorAllTime = emptyPeriod();
  anchorAllTime.totalTokens = 5000;
  anchorAllTime.clients = { claude: 5000 };

  const anchor = { dateKey, today: anchorToday, month: anchorMonth, allTime: anchorAllTime };

  // Stub tokscale to return a delta: today jumped from 50 to 130
  let tokscaleCalls = 0;
  async function stubTokscale() {
    tokscaleCalls += 1;
    return { entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus', input: 80, output: 0, cost: 0 }] };
  }

  const summary = await collectUsageOnce({
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    historyEnabled: false,
    todayOnlyAnchor: anchor,
    wslAnchor: emptyWslBundle(),
    runTokscale: stubTokscale,
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] })
  });

  // Only one tokscale call (--today), not three
  assert.equal(tokscaleCalls, 1, 'anchored tick must only run one tokscale scan');

  // today = 80 (from stub; anchor was 50)
  assert.equal(summary.today.totalTokens, 80, 'today should come from fresh scan');

  // month = anchor month 500 + (today 80 - anchor today 50) = 530
  assert.equal(summary.month.totalTokens, 530, 'month should be derived via applyPeriodDelta');

  // allTime = anchor allTime 5000 + (today 80 - anchor today 50) = 5030
  assert.equal(summary.allTime.totalTokens, 5030, 'allTime should be derived via applyPeriodDelta');
});

function emptyWslBundle() {
  return { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
}

function mkPeriod() {
  return { totalTokens: 50, costUsd: 0, clients: { claude: 50 }, clientCosts: {}, models: {}, modelCosts: {}, clientModels: {}, clientModelCosts: {}, sessions: {} };
}

test('restart reuse: anchor file on disk enables todayOnly on first interval tick', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-restart-'));
  const dateKey = localTodayKey();

  // Write a valid anchor file to the isolated shared dir
  fs.mkdirSync(path.join(tmpShared), { recursive: true });
  const anchorData = {
    dateKey,
    today: mkPeriod(), month: mkPeriod(), allTime: mkPeriod(),
    wslBundle: null,
    configFingerprint: configFingerprint('claude', '2024-01-01'),
    fullScanAt: new Date(Date.now() - 300000).toISOString() // 5 minutes ago — within the 1h safety window
  };
  fs.writeFileSync(path.join(tmpShared, 'collector-anchor.json'), JSON.stringify(anchorData));

  // Mock spawn BEFORE freshCollector so the re-required module picks it up
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = () => {
    calls.push('spawn');
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onUpdate: () => updates.push(true)
    });

    // Wait for the first interval tick
    await waitForCondition(() => updates.length === 1);
    // With a valid anchor on disk, the first tick should be todayOnly (1 spawn)
    assert.equal(calls.length, 1, 'anchor from disk enables todayOnly — one spawn, not three');
    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (handle) try { handle.stop(); } catch (_) {}
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

test('future fullScanAt forces a full scan on first interval tick', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-future-ts-'));
  const dateKey = localTodayKey();

  fs.mkdirSync(path.join(tmpShared), { recursive: true });
  const anchorData = {
    dateKey,
    today: mkPeriod(), month: mkPeriod(), allTime: mkPeriod(),
    wslBundle: null,
    configFingerprint: configFingerprint('claude', '2024-01-01'),
    fullScanAt: new Date(Date.now() + 3600000).toISOString() // 1 hour in the future
  };
  fs.writeFileSync(path.join(tmpShared, 'collector-anchor.json'), JSON.stringify(anchorData));

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = () => {
    calls.push('spawn');
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onUpdate: () => updates.push(true)
    });

    await waitForCondition(() => updates.length === 1);
    // Future fullScanAt should force a full 3-scan tick
    assert.equal(calls.length, 3, 'future fullScanAt forces full scan — three spawns, not one');
    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (handle) try { handle.stop(); } catch (_) {}
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

test('missing fullScanAt forces a full scan on first interval tick', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-missing-ts-'));
  const dateKey = localTodayKey();

  fs.mkdirSync(path.join(tmpShared), { recursive: true });
  // Valid anchor, but no fullScanAt field (old format or corrupted)
  const anchorData = {
    dateKey,
    today: mkPeriod(), month: mkPeriod(), allTime: mkPeriod(),
    wslBundle: null,
    configFingerprint: configFingerprint('claude', '2024-01-01')
    // no fullScanAt — triggers lastFullScanAt = 0 → full scan
  };
  fs.writeFileSync(path.join(tmpShared, 'collector-anchor.json'), JSON.stringify(anchorData));

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = () => {
    calls.push('spawn');
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onUpdate: () => updates.push(true)
    });

    await waitForCondition(() => updates.length === 1);
    // Missing fullScanAt → lastFullScanAt = 0 → forces full scan
    assert.equal(calls.length, 3, 'missing fullScanAt forces full scan — three spawns');
    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (handle) try { handle.stop(); } catch (_) {}
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

test('unparseable fullScanAt forces a full scan on first interval tick', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bad-ts-'));
  const dateKey = localTodayKey();

  fs.mkdirSync(path.join(tmpShared), { recursive: true });
  // Valid anchor, but fullScanAt is not a parseable date: Date.parse -> NaN,
  // Number.isFinite(NaN) is false, so lastFullScanAt stays 0 -> full scan.
  const anchorData = {
    dateKey,
    today: mkPeriod(), month: mkPeriod(), allTime: mkPeriod(),
    wslBundle: null,
    configFingerprint: configFingerprint('claude', '2024-01-01'),
    fullScanAt: 'not-a-timestamp'
  };
  fs.writeFileSync(path.join(tmpShared, 'collector-anchor.json'), JSON.stringify(anchorData));

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = () => {
    calls.push('spawn');
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onUpdate: () => updates.push(true)
    });

    await waitForCondition(() => updates.length === 1);
    // Unparseable fullScanAt → lastFullScanAt = 0 → forces full scan
    assert.equal(calls.length, 3, 'unparseable fullScanAt forces full scan — three spawns');
    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (handle) try { handle.stop(); } catch (_) {}
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

test('WSL toggle off: persisted wslAnchor is not merged into warm previews', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-off-'));
  const dateKey = localTodayKey();

  fs.mkdirSync(tmpShared, { recursive: true });
  // Seed a persisted anchor that still carries a WSL bundle, as if WSL scanning
  // was ON during the last full scan. No fullScanAt -> the first tick is a full
  // scan, so progressive previews fire (the only place wslAnchor is read without
  // the wslScanEnabled gate).
  const wslPeriod = { ...emptyPeriod(), totalTokens: 999, clients: { claude: 999 } };
  const anchorData = {
    dateKey,
    today: mkPeriod(), month: mkPeriod(), allTime: mkPeriod(),
    wslBundle: { today: wslPeriod, month: wslPeriod, allTime: wslPeriod },
    configFingerprint: configFingerprint('claude', '2024-01-01')
    // no fullScanAt -> forces a full scan on the first interval tick
  };
  fs.writeFileSync(path.join(tmpShared, 'collector-anchor.json'), JSON.stringify(anchorData));

  // Host scan returns empty entries -> host periods are 0. If the persisted WSL
  // bundle leaks into a preview it shows totalTokens 999 instead of 0.
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const previews = [];
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      wslScanEnabled: false,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onPreview: (p) => previews.push(p),
      onUpdate: () => updates.push(true)
    });

    await waitForCondition(() => updates.length === 1);
    assert.ok(previews.length >= 1, 'a full-scan tick must emit at least one preview');
    for (const p of previews) {
      assert.equal(p.today.totalTokens, 0, 'preview today must not carry the persisted WSL bundle when the toggle is off');
      if (p.month) assert.equal(p.month.totalTokens, 0, 'preview month must not carry persisted WSL when off');
    }
    // Final summary is host-only too (collectWsl is never called when off).
    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (handle) try { handle.stop(); } catch (_) {}
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

test('cross-day anchor invalidation: stale dateKey triggers full scan', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = () => {
    calls.push('spawn');
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  try {
    const { collectUsageOnce } = freshCollector();
    const { emptyPeriod } = require('../../src/shared/usage');
    const anchor = { dateKey: '2020-01-01', today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
    await collectUsageOnce({ ...baseOptions, todayOnlyAnchor: anchor });
    assert.equal(calls.length, 3, 'stale dateKey anchor should trigger full 3-scan tick');
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

function waitForCondition(predicate, timeoutMs = 4000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        reject(new Error('Timed out waiting for condition'));
      }
    }, 5);
  });
}
