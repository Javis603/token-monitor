'use strict';

// Watch-triggered ticks scan only --today and derive month/allTime exactly from
// the last full-scan anchor (issue #15 follow-up): one tokscale spawn per watch
// tick instead of three, with no loss of accuracy.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const collectorPath = require.resolve('../../src/shared/collector');

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

function recordingSpawn(calls, tokens = 50, sessionMeta = {}) {
  return (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({
        entries: [{
          client: 'claude',
          sessionId: 's1',
          model: 'claude-opus-4-8',
          input: tokens,
          output: 0,
          cost: tokens / 100,
          ...sessionMeta
        }]
      })));
      child.emit('close', 0);
    });
    return child;
  };
}

function waitForUpdates(updates, count) {
  if (updates.length >= count) return Promise.resolve();
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (updates.length >= count) {
        clearInterval(interval);
        resolve();
      }
    }, 5);
  });
}

const baseOptions = {
  clients: 'claude',
  allTimeSince: '2024-01-01',
  commandTimeoutMs: 1000,
  deviceId: 'test-device',
  agentVersion: 'test',
  limitsEnabled: false
};

test('collectUsageOnce with a valid anchor runs a single --today scan and derives the broader periods', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls, 50);
  try {
    const { collectUsageOnce, localTodayKey } = freshCollector();
    const { emptyPeriod } = require('../../src/shared/usage');
    const anchor = {
      dateKey: localTodayKey(),
      today: { ...emptyPeriod(), totalTokens: 30, clients: { claude: 30 } },
      month: { ...emptyPeriod(), totalTokens: 100, clients: { claude: 100 } },
      allTime: { ...emptyPeriod(), totalTokens: 1000, clients: { claude: 1000 } }
    };
    const summary = await collectUsageOnce({ ...baseOptions, todayOnlyAnchor: anchor });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--today'));
    assert.equal(summary.today.totalTokens, 50);
    assert.equal(summary.month.totalTokens, 120);
    assert.equal(summary.allTime.totalTokens, 1020);
    assert.equal(summary.month.clients.claude, 120);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('an anchored watch tick does not re-read session files that only appear in the derived periods', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls, 50, {
    startedAt: '2026-07-13T08:00:00.000Z',
    lastUsedAt: '2026-07-13T08:30:00.000Z'
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-home-'));
  const realOpen = fs.openSync;
  try {
    const dir = path.join(home, '.claude', 'projects', '-p');
    fs.mkdirSync(dir, { recursive: true });
    const s1File = path.join(dir, 's1.jsonl');
    const s2File = path.join(dir, 's2.jsonl');
    const line = (cwd, ts) => `${JSON.stringify({ cwd, timestamp: ts })}\n`;
    fs.writeFileSync(s1File, line('/work/one', '2026-07-13T10:00:00.000Z'));
    fs.writeFileSync(s2File, line('/work/two', '2026-07-13T09:00:00.000Z'));

    const { collectUsageOnce, localTodayKey } = freshCollector();
    const { emptyPeriod } = require('../../src/shared/usage');
    // s2 is only in the broader windows, already resolved at the last full scan.
    const withS2 = (totalTokens) => ({
      ...emptyPeriod(),
      totalTokens,
      clients: { claude: totalTokens },
      sessions: { 'claude:s2': { client: 'claude', sessionId: 's2', totalTokens, projectId: 'pid2', projectLabel: 'two' } }
    });
    const anchor = {
      dateKey: localTodayKey(),
      today: { ...emptyPeriod(), totalTokens: 30, clients: { claude: 30 } },
      month: withS2(100),
      allTime: withS2(1000)
    };

    let s1Opens = 0;
    let s2Opens = 0;
    fs.openSync = (target, ...rest) => {
      if (target === s1File) s1Opens += 1;
      if (target === s2File) s2Opens += 1;
      return realOpen(target, ...rest);
    };

    const summary = await collectUsageOnce({ ...baseOptions, homeDir: home, todayOnlyAnchor: anchor });

    assert.ok(s1Opens > 0, "today's own session must still be decorated on a watch tick");
    assert.equal(s2Opens, 0, 'a session only in the derived periods must not be re-read on a watch tick');
    assert.equal(summary.month.sessions['claude:s2'].projectLabel, 'two');
    const todayS1 = summary.today.sessions['claude:s1'];
    assert.ok(todayS1.projectId, "today's new session must be decorated");
    assert.equal(todayS1.projectLabel, 'one');
    assert.equal(todayS1.startedAt, '2026-07-13T08:00:00.000Z');
    assert.equal(todayS1.lastUsedAt, '2026-07-13T10:00:00.000Z');
    for (const period of [summary.month, summary.allTime]) {
      const derivedS1 = period.sessions['claude:s1'];
      assert.equal(derivedS1.projectId, todayS1.projectId);
      assert.equal(derivedS1.projectLabel, todayS1.projectLabel);
      assert.equal(derivedS1.startedAt, todayS1.startedAt);
      assert.equal(derivedS1.lastUsedAt, todayS1.lastUsedAt);
    }
  } finally {
    fs.openSync = realOpen;
    childProcess.spawn = originalSpawn;
    fs.rmSync(home, { recursive: true, force: true });
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce ignores a stale anchor from a previous day and runs the full scan', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls, 50);
  try {
    const { collectUsageOnce } = freshCollector();
    const { emptyPeriod } = require('../../src/shared/usage');
    const anchor = { dateKey: '2020-01-01', today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
    await collectUsageOnce({ ...baseOptions, todayOnlyAnchor: anchor });
    assert.equal(calls.length, 3);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('startCollector: watch ticks reuse the full-scan anchor, manual ticks rescan everything', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls, 50);
  // Use an isolated shared data dir so the test doesn't pick up a real
  // collector-anchor.json left by the actual app (anchor persistence).
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shared-'));
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    const handle = startCollector({
      ...baseOptions,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      watchDebounceMs: 10,
      historyEnabled: false,
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForUpdates(updates, 1);
    const fullScans = calls.length;
    assert.equal(fullScans, 3);

    await handle.tick('watch:change:file.jsonl', { todayOnly: true });
    await waitForUpdates(updates, 2);
    assert.equal(calls.length, fullScans + 1);
    // Same fake data both rounds: delta is zero, broader periods match the anchor.
    assert.equal(updates[1].summary.month.totalTokens, updates[0].summary.month.totalTokens);
    assert.equal(updates[1].summary.allTime.totalTokens, updates[0].summary.allTime.totalTokens);
    assert.equal(updates[1].summary.today.totalTokens, 50);

    await handle.tick('manual');
    await waitForUpdates(updates, 3);
    assert.equal(calls.length, fullScans + 1 + 3);

    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    fs.rmSync(tmpShared, { recursive: true, force: true });
    delete require.cache[collectorPath];
  }
});
