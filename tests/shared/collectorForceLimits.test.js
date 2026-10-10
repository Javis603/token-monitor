'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractUsageFromTokscale, mergePeriods } = require('../../src/shared/usage');
const { utcOffsetMinutes } = require('../../src/shared/history');
const { installInProcessWatchHost } = require('../helpers/watchHost');

installInProcessWatchHost(test);

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

test('reset boundary scheduling caps timers that exceed the Node timeout range', () => {
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  const {
    LIMITS_RESET_BOUNDARY_MAX_TIMER_MS,
    nextLimitsResetBoundary
  } = require(collectorPath);
  const now = Date.parse('2026-07-01T00:00:00.000Z');
  const next = nextLimitsResetBoundary({
    providers: [{
      provider: 'copilot',
      accountKey: 'copilot-test',
      windows: [{ kind: 'monthly', resetsAt: '2026-08-01T00:00:00.000Z' }]
    }]
  }, now);

  assert.equal(next.delayMs, LIMITS_RESET_BOUNDARY_MAX_TIMER_MS);
  assert.equal(next.refreshAt, Date.parse('2026-08-01T00:00:30.000Z'));
  delete require.cache[collectorPath];
});

test('reset boundary scheduling prunes historical attempted keys but retains current stale keys', () => {
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  const {
    nextLimitsResetBoundary,
    pruneAttemptedResetBoundaries
  } = require(collectorPath);
  const limits = {
    providers: [{
      provider: 'codex',
      accountKey: 'codex-test',
      windows: [{ kind: 'session', resetsAt: '2026-07-20T00:01:00.000Z' }]
    }]
  };
  const currentKey = nextLimitsResetBoundary(limits).keys[0];
  const attempted = new Set(['historical-reset-key', currentKey]);

  pruneAttemptedResetBoundaries(limits, attempted);

  assert.deepEqual([...attempted], [currentKey]);
  delete require.cache[collectorPath];
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

test('collectUsageOnce sends fork-only clients to tokscale like any other client', async () => {
  const { collectUsageOnce } = require('../../src/shared/collector');
  const calls = [];
  const summary = await collectUsageOnce({
    clients: 'proma,qodercn',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'test-device',
    agentVersion: 'test',
    limitsEnabled: false,
    projectsEnabled: false,
    runTokscale: async ({ clients, flags }) => {
      calls.push({ clients, flags });
      const input = flags[0] === '--today' ? 12 : flags[0] === '--month' ? 20 : 30;
      return { entries: [
        { client: 'proma', model: 'm', input, output: 0 },
        { client: 'qodercn', model: 'qmodel', input, output: 3 }
      ] };
    }
  });

  assert.deepEqual(calls.map(({ clients }) => clients), ['proma,qodercn', 'proma,qodercn', 'proma,qodercn']);
  assert.deepEqual(summary.trackedClients, ['proma', 'qodercn']);
  assert.equal(summary.today.clients.proma, 12);
  assert.equal(summary.today.clients.qodercn, 15);
  assert.equal(summary.month.clients.qodercn, 23);
  assert.equal(summary.allTime.clients.proma, 30);
});

test('anchored Proma refresh derives broader windows from the fresh tokscale today scan', async () => {
  const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
  const period = (client, input) => extractUsageFromTokscale({
    entries: [{ client, model: 'm', input, output: 0, cost: 0 }]
  });
  const anchor = {
    dateKey: localTodayKey(),
    utcOffsetMinutes: utcOffsetMinutes(),
    today: mergePeriods(period('claude', 10), period('proma', 5)),
    month: mergePeriods(period('claude', 100), period('proma', 50)),
    allTime: mergePeriods(period('claude', 1000), period('proma', 500))
  };

  const summary = await collectUsageOnce({
    clients: 'claude,proma',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'test-device',
    limitsEnabled: false,
    todayOnlyAnchor: anchor,
    runTokscale: async ({ clients, flags }) => {
      assert.equal(clients, 'claude,proma');
      assert.deepEqual(flags, ['--today']);
      return { entries: [
        { client: 'claude', model: 'm', input: 15 },
        { client: 'proma', model: 'm', input: 8 }
      ] };
    }
  });

  assert.equal(summary.today.totalTokens, 23);
  assert.equal(summary.month.totalTokens, 158);
  assert.equal(summary.allTime.totalTokens, 1508);
  assert.equal(summary.month.clients.proma, 53);
  assert.equal(summary.allTime.clients.proma, 503);
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

test('collectUsageOnce requests the workspace-joined session grouping', async () => {
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
      assert.equal(args[groupIndex + 1], 'client,workspace,session,model');
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

test('collectUsageOnce falls back to plain session grouping when the binary rejects the join', async () => {
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
    const groupBy = args[args.indexOf('--group-by') + 1];
    setImmediate(() => {
      if (groupBy === 'client,workspace,session,model') {
        // What an upstream build actually prints for an unknown --group-by.
        child.stderr.emit('data', Buffer.from("Error: Invalid group-by value: 'client,workspace,session,model'."));
        child.emit('close', 1);
        return;
      }
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

    const groupings = calls.map((args) => args[args.indexOf('--group-by') + 1]);
    // One rejection teaches the whole tick: the retry and both later scans go
    // straight to the grouping this binary knows.
    assert.deepEqual(groupings, [
      'client,workspace,session,model',
      'client,session,model',
      'client,session,model',
      'client,session,model'
    ]);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('resetting the capability cache lets the workspace grouping be tried again', async () => {
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
    const groupBy = args[args.indexOf('--group-by') + 1];
    setImmediate(() => {
      if (groupBy === 'client,workspace,session,model') {
        child.stderr.emit('data', Buffer.from("Error: Invalid group-by value: 'client,workspace,session,model'."));
        child.emit('close', 1);
        return;
      }
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce, resetTokscaleCapabilityCache } = require(collectorPath);
    const options = {
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    };

    await collectUsageOnce(options);
    const afterFirst = calls.length;
    // The rejection is remembered, so nothing retries the joined grouping...
    assert.equal(calls[afterFirst - 1][calls[afterFirst - 1].indexOf('--group-by') + 1], 'client,session,model');

    // ...until the binary's recorded capabilities are dropped, which is what a
    // replaced binary at the same path needs.
    resetTokscaleCapabilityCache();
    await collectUsageOnce(options);

    const firstAfterReset = calls[afterFirst];
    assert.equal(firstAfterReset[firstAfterReset.indexOf('--group-by') + 1], 'client,workspace,session,model');
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('turning Projects off stops asking the scan to resolve workspaces', async () => {
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
      limitsEnabled: false,
      projectsEnabled: false
    });

    // Resolving and labelling workspaces is work the scan only does when asked,
    // so the opt-out has to reach the argument list rather than discard the
    // answer afterwards. Session titles and activity bounds ride this grouping
    // too, so the opt-out costs no timestamps.
    assert.equal(calls.length, 3);
    for (const args of calls) {
      assert.equal(args[args.indexOf('--group-by') + 1], 'client,session,model');
    }
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});
