'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractUsageFromTokscale, mergePeriods } = require('../../src/shared/usage');

// Isolate the shared data dir so startCollector's persisted collector-anchor.json
// does not write the real user data dir during the suite.
const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-force-limits-'));
process.env.TOKEN_MONITOR_SHARED_DIR = sharedDir;
process.on('exit', () => { try { fs.rmSync(sharedDir, { recursive: true, force: true }); } catch (_) {} });

function fakeTokscaleSpawn() {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ totalTokens: 0, costUsd: 0 })));
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

test('manual collector tick can force the limits snapshot', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = fakeTokscaleSpawn();

  const limitCollectorPath = require.resolve('../../src/shared/limitCollector');
  const collectorPath = require.resolve('../../src/shared/collector');
  const limitCollector = require(limitCollectorPath);
  const originalCreateLimitsCollector = limitCollector.createLimitsCollector;
  const snapshotForces = [];
  limitCollector.createLimitsCollector = () => ({
    snapshot: async (force = false) => {
      snapshotForces.push(Boolean(force));
      return { updatedAt: new Date().toISOString(), refreshMs: 300000, providers: [] };
    }
  });
  delete require.cache[collectorPath];

  try {
    const { startCollector } = require(collectorPath);
    const updates = [];
    const handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60000,
      watchEnabled: false,
      watchDebounceMs: 10,
      limitsEnabled: true,
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForUpdates(updates, 1);
    await handle.tick('manual', { forceLimits: true });
    await waitForUpdates(updates, 2);
    handle.stop();

    assert.deepEqual(snapshotForces.slice(0, 2), [false, true]);
  } finally {
    childProcess.spawn = originalSpawn;
    limitCollector.createLimitsCollector = originalCreateLimitsCollector;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce returns empty usage without spawning tokscale when clients is empty', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  let spawnCalls = 0;
  childProcess.spawn = () => {
    spawnCalls += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ totalTokens: 100, costUsd: 1 })));
      child.emit('close', 0);
    });
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: '',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.equal(spawnCalls, 0);
    assert.deepEqual(summary.trackedClients, []);
    assert.equal(summary.today.totalTokens, 0);
    assert.equal(summary.month.totalTokens, 0);
    assert.equal(summary.allTime.totalTokens, 0);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce handles proma-only tracking without spawning tokscale', async () => {
  const promaPath = require.resolve('../../src/shared/promaUsage');
  const collectorPath = require.resolve('../../src/shared/collector');
  const promaUsage = require(promaPath);
  const originalBuildPromaPeriods = promaUsage.buildPromaPeriods;
  let tokscaleCalls = 0;

  promaUsage.buildPromaPeriods = () => ({
    today: { entries: [{ client: 'proma', model: 'm', input: 12, output: 3 }] },
    month: { entries: [{ client: 'proma', model: 'm', input: 20 }] },
    allTime: { entries: [{ client: 'proma', model: 'm', input: 30 }] }
  });
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: 'proma',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false,
      runTokscale: async () => {
        tokscaleCalls += 1;
        throw new Error('tokscale should not run for proma-only tracking');
      }
    });

    assert.equal(tokscaleCalls, 0);
    assert.deepEqual(summary.trackedClients, ['proma']);
    assert.equal(summary.today.clients.proma, 15);
    assert.equal(summary.month.clients.proma, 20);
    assert.equal(summary.allTime.clients.proma, 30);
  } finally {
    promaUsage.buildPromaPeriods = originalBuildPromaPeriods;
    delete require.cache[collectorPath];
  }
});

test('anchored Proma refresh derives broader windows from the combined fresh today period', async () => {
  const promaPath = require.resolve('../../src/shared/promaUsage');
  const collectorPath = require.resolve('../../src/shared/collector');
  const promaUsage = require(promaPath);
  const originalBuildPromaPeriods = promaUsage.buildPromaPeriods;
  let receivedAllTimeSince = null;

  const period = (client, input) => extractUsageFromTokscale({
    entries: [{ client, model: 'm', input, output: 0, cost: 0 }]
  });
  const anchor = {
    dateKey: require('../../src/shared/collector').localTodayKey(),
    today: mergePeriods(period('claude', 10), period('proma', 5)),
    month: mergePeriods(period('claude', 100), period('proma', 50)),
    allTime: mergePeriods(period('claude', 1000), period('proma', 500))
  };

  promaUsage.buildPromaPeriods = ({ allTimeSince }) => {
    receivedAllTimeSince = allTimeSince;
    return {
      today: { entries: [{ client: 'proma', model: 'm', input: 8 }] },
      month: { entries: [{ client: 'proma', model: 'm', input: 53 }] },
      allTime: { entries: [{ client: 'proma', model: 'm', input: 503 }] }
    };
  };
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: 'claude,proma',
      allTimeSince: '2026-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      limitsEnabled: false,
      todayOnlyAnchor: anchor,
      runTokscale: async ({ clients, flags }) => {
        assert.equal(clients, 'claude');
        assert.deepEqual(flags, ['--today']);
        return { entries: [{ client: 'claude', model: 'm', input: 15 }] };
      }
    });

    assert.equal(receivedAllTimeSince, '2026-01-01');
    assert.equal(summary.today.totalTokens, 23);
    assert.equal(summary.month.totalTokens, 158);
    assert.equal(summary.allTime.totalTokens, 1508);
    assert.equal(summary.month.clients.proma, 53);
    assert.equal(summary.allTime.clients.proma, 503);
  } finally {
    promaUsage.buildPromaPeriods = originalBuildPromaPeriods;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce includes the normalized tracked client list in summaries', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = fakeTokscaleSpawn();

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: ' Codex, Hermes ',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.deepEqual(summary.trackedClients, ['codex', 'hermes']);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce requests session-level tokscale grouping', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
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

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    await collectUsageOnce({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.equal(calls.length, 3);
    for (const args of calls) {
      const groupIndex = args.indexOf('--group-by');
      assert.notEqual(groupIndex, -1);
      assert.equal(args[groupIndex + 1], 'client,session,model');
    }
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce enriches session rows with local last-used timestamps', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-sessions-'));
  const claudeSession = 'claude-session-1';
  const codexSession = 'rollout-2026-05-30T11-44-50-abc';
  const claudeDir = path.join(tmp, '.claude', 'projects', 'project');
  const codexDir = path.join(tmp, '.codex', 'sessions', '2026', '05', '30');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${claudeSession}.jsonl`), [
    JSON.stringify({ sessionId: claudeSession, timestamp: '2026-05-30T04:00:00.000Z' }),
    JSON.stringify({ sessionId: claudeSession, timestamp: '2026-05-30T04:07:32.679Z' })
  ].join('\n'));
  fs.writeFileSync(path.join(codexDir, `${codexSession}.jsonl`), [
    JSON.stringify({ sessionId: codexSession, timestamp: '2026-05-30T03:45:00.000Z' })
  ].join('\n'));

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({
        entries: [
          { client: 'claude', sessionId: claudeSession, model: 'claude-opus-4-8', input: 10, output: 2, cost: 0.1 },
          { client: 'codex', sessionId: codexSession, model: 'gpt-5.5', input: 100, output: 20, cost: 1 }
        ]
      })));
      child.emit('close', 0);
    });
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: 'claude,codex',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false,
      homeDir: tmp
    });

    assert.equal(summary.today.sessions[`claude:${claudeSession}`].lastUsedAt, '2026-05-30T04:07:32.679Z');
    assert.equal(summary.today.sessions[`codex:${codexSession}`].lastUsedAt, '2026-05-30T03:45:00.000Z');
    assert.ok(summary.today.sessions[`codex:${codexSession}`].startedAt);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
