'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function waitForCondition(predicate, timeoutMs = 1000) {
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

function finishTokscaleChild(child, payload) {
  child.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
  child.emit('close', 0);
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

test('collectUsageOnce can refresh only requested usage periods', async () => {
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
      child.stdout.emit('data', Buffer.from(JSON.stringify({ totalTokens: 22, costUsd: 0.02 })));
      child.emit('close', 0);
    });
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: 'claude',
      periods: ['month'],
      previousPeriods: {
        today: { totalTokens: 11, costUsd: 0.01 },
        allTime: { totalTokens: 99, costUsd: 0.09 }
      },
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--month'));
    assert.equal(summary.today.totalTokens, 11);
    assert.equal(summary.month.totalTokens, 22);
    assert.equal(summary.allTime.totalTokens, 99);
    assert.equal(summary.allTime.estimated, undefined);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce can reuse a clean requested period from cache', async () => {
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
      clients: 'claude',
      periods: ['month'],
      previousPeriods: {
        month: { totalTokens: 22, costUsd: 0.02, clients: { claude: 22 } }
      },
      loadedPeriods: new Set(['month']),
      dirtyPeriods: new Set(),
      onlyIfDirty: true,
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.equal(spawnCalls, 0);
    assert.equal(summary.month.totalTokens, 22);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce can reuse a loaded zero-usage period from cache', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  let spawnCalls = 0;
  childProcess.spawn = () => {
    spawnCalls += 1;
    return fakeTokscaleSpawn()();
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: 'claude',
      periods: ['today'],
      previousPeriods: {
        today: { totalTokens: 0, costUsd: 0, clients: {}, sessions: {} }
      },
      loadedPeriods: new Set(['today']),
      dirtyPeriods: new Set(),
      onlyIfDirty: true,
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.equal(spawnCalls, 0);
    assert.equal(summary.today.totalTokens, 0);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce refreshes a requested period when cache gating is disabled', async () => {
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
      child.stdout.emit('data', Buffer.from(JSON.stringify({ totalTokens: 33, costUsd: 0.03 })));
      child.emit('close', 0);
    });
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: 'claude',
      periods: ['month'],
      previousPeriods: {
        month: { totalTokens: 22, costUsd: 0.02, clients: { claude: 22 } }
      },
      loadedPeriods: new Set(['month']),
      dirtyPeriods: new Set(),
      onlyIfDirty: false,
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--month'));
    assert.equal(summary.month.totalTokens, 33);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce estimates broader periods from a today-only refresh delta', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify([
        { client: 'claude', sessionId: 's1', model: 'claude-opus', totalTokens: 15, costUsd: 0.15 }
      ])));
      child.emit('close', 0);
    });
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: 'claude',
      periods: ['today'],
      previousPeriods: {
        today: {
          totalTokens: 10,
          costUsd: 0.1,
          clients: { claude: 10 },
          clientCosts: { claude: 0.1 },
          models: { 'claude-opus': 10 },
          modelCosts: { 'claude-opus': 0.1 },
          clientModels: { claude: { 'claude-opus': 10 } },
          clientModelCosts: { claude: { 'claude-opus': 0.1 } },
          sessions: {
            'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 10, costUsd: 0.1, models: { 'claude-opus': 10 }, modelCosts: { 'claude-opus': 0.1 } }
          }
        },
        month: {
          totalTokens: 100,
          costUsd: 1,
          clients: { claude: 100 },
          clientCosts: { claude: 1 },
          models: { 'claude-opus': 100 },
          modelCosts: { 'claude-opus': 1 },
          clientModels: { claude: { 'claude-opus': 100 } },
          clientModelCosts: { claude: { 'claude-opus': 1 } },
          sessions: {
            'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 100, costUsd: 1, models: { 'claude-opus': 100 }, modelCosts: { 'claude-opus': 1 } }
          }
        },
        allTime: {
          totalTokens: 1000,
          costUsd: 10,
          clients: { claude: 1000 },
          clientCosts: { claude: 10 },
          models: { 'claude-opus': 1000 },
          modelCosts: { 'claude-opus': 10 },
          clientModels: { claude: { 'claude-opus': 1000 } },
          clientModelCosts: { claude: { 'claude-opus': 10 } },
          sessions: {
            'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 1000, costUsd: 10, models: { 'claude-opus': 1000 }, modelCosts: { 'claude-opus': 10 } }
          }
        }
      },
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.equal(summary.today.totalTokens, 15);
    assert.equal(summary.month.totalTokens, 105);
    assert.equal(summary.month.clients.claude, 105);
    assert.equal(summary.month.models['claude-opus'], 105);
    assert.equal(summary.month.clientModels.claude['claude-opus'], 105);
    assert.equal(summary.month.sessions['claude:s1'].totalTokens, 105);
    assert.equal(summary.month.sessions['claude:s1'].models['claude-opus'], 105);
    assert.equal(summary.month.estimated, true);
    assert.equal(summary.allTime.totalTokens, 1005);
    assert.equal(summary.allTime.clients.claude, 1005);
    assert.equal(summary.allTime.models['claude-opus'], 1005);
    assert.equal(summary.allTime.clientModels.claude['claude-opus'], 1005);
    assert.equal(summary.allTime.sessions['claude:s1'].totalTokens, 1005);
    assert.equal(summary.allTime.sessions['claude:s1'].models['claude-opus'], 1005);
    assert.equal(summary.allTime.estimated, true);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce estimates distribution changes even when total delta is zero', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify([
        { client: 'claude', model: 'claude-opus', totalTokens: 5, costUsd: 0.05 },
        { client: 'codex', model: 'gpt-5', totalTokens: 5, costUsd: 0.05 }
      ])));
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
      periods: ['today'],
      previousPeriods: {
        today: { totalTokens: 10, costUsd: 0.1, clients: { claude: 10 }, models: { 'claude-opus': 10 } },
        month: { totalTokens: 100, costUsd: 1, clients: { claude: 100 }, models: { 'claude-opus': 100 } },
        allTime: { totalTokens: 1000, costUsd: 10, clients: { claude: 1000 }, models: { 'claude-opus': 1000 } }
      },
      loadedPeriods: new Set(['today']),
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.equal(summary.month.totalTokens, 100);
    assert.equal(summary.month.clients.claude, 95);
    assert.equal(summary.month.clients.codex, 5);
    assert.equal(summary.month.models['claude-opus'], 95);
    assert.equal(summary.month.models['gpt-5'], 5);
    assert.equal(summary.month.estimated, true);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce estimates allTime from a month-only refresh delta', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify([
        { client: 'claude', sessionId: 's1', model: 'claude-opus', totalTokens: 120, costUsd: 1.2 }
      ])));
      child.emit('close', 0);
    });
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: 'claude',
      periods: ['month'],
      previousPeriods: {
        today: {
          totalTokens: 10,
          costUsd: 0.1,
          clients: { claude: 10 },
          sessions: {
            'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 10, costUsd: 0.1 }
          }
        },
        month: {
          totalTokens: 100,
          costUsd: 1,
          clients: { claude: 100 },
          models: { 'claude-opus': 100 },
          sessions: {
            'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 100, costUsd: 1, models: { 'claude-opus': 100 } }
          }
        },
        allTime: {
          totalTokens: 1000,
          costUsd: 10,
          clients: { claude: 1000 },
          models: { 'claude-opus': 1000 },
          sessions: {
            'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 1000, costUsd: 10, models: { 'claude-opus': 1000 } }
          }
        }
      },
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.equal(summary.today.totalTokens, 10);
    assert.equal(summary.today.estimated, undefined);
    assert.equal(summary.month.totalTokens, 120);
    assert.equal(summary.allTime.totalTokens, 1020);
    assert.equal(summary.allTime.models['claude-opus'], 1020);
    assert.equal(summary.allTime.sessions['claude:s1'].totalTokens, 1020);
    assert.equal(summary.allTime.estimated, true);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce does not estimate broader periods without a source baseline', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify([
        { client: 'claude', sessionId: 's1', model: 'claude-opus', totalTokens: 120, costUsd: 1.2 }
      ])));
      child.emit('close', 0);
    });
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { collectUsageOnce } = require(collectorPath);
    const summary = await collectUsageOnce({
      clients: 'claude',
      periods: ['month'],
      previousPeriods: {
        allTime: { totalTokens: 1000, costUsd: 10, clients: { claude: 1000 } }
      },
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });

    assert.equal(summary.month.totalTokens, 120);
    assert.equal(summary.allTime.totalTokens, 1000);
    assert.equal(summary.allTime.estimated, undefined);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('startCollector preserves a manual period request while another tick is running', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  const pendingChildren = [];
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    pendingChildren.push(child);
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { startCollector } = require(collectorPath);
    const updates = [];
    const handle = startCollector({
      clients: 'claude',
      periods: ['today'],
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60000,
      watchEnabled: false,
      watchDebounceMs: 10,
      limitsEnabled: false,
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForCondition(() => pendingChildren.length === 1);
    const manualTick = handle.tick('manual', { periods: ['month'], onlyIfDirty: true });
    finishTokscaleChild(pendingChildren.shift(), { totalTokens: 11, costUsd: 0.01 });

    await waitForCondition(() => pendingChildren.length === 1);
    finishTokscaleChild(pendingChildren.shift(), { totalTokens: 22, costUsd: 0.02 });
    await manualTick;
    await waitForUpdates(updates, 2);
    handle.stop();

    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('--today'));
    assert.ok(calls[1].includes('--month'));
    assert.equal(updates[1].summary.month.totalTokens, 22);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('startCollector can use full initial periods and lightweight later ticks', async () => {
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
      child.stdout.emit('data', Buffer.from(JSON.stringify({ totalTokens: calls.length, costUsd: 0 })));
      child.emit('close', 0);
    });
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { startCollector } = require(collectorPath);
    const updates = [];
    const handle = startCollector({
      clients: 'claude',
      initialPeriods: ['today', 'month', 'allTime'],
      periods: ['today'],
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60000,
      watchEnabled: false,
      watchDebounceMs: 10,
      limitsEnabled: false,
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForUpdates(updates, 1);
    assert.equal(calls.length, 3);
    assert.ok(calls[0].includes('--today'));
    assert.ok(calls[1].includes('--month'));
    assert.ok(calls[2].includes('--since'));

    await handle.tick('manual');
    await waitForUpdates(updates, 2);
    handle.stop();

    assert.equal(calls.length, 4);
    assert.ok(calls[3].includes('--today'));
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('startCollector refreshes all periods after crossing a local date boundary', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  const nowValues = [
    new Date('2026-06-05T23:59:00'),
    new Date('2026-06-06T00:01:00')
  ];
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ totalTokens: calls.length, costUsd: 0 })));
      child.emit('close', 0);
    });
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { startCollector } = require(collectorPath);
    const updates = [];
    const handle = startCollector({
      clients: 'claude',
      periods: ['today'],
      now: () => nowValues.shift() || new Date('2026-06-06T00:01:00'),
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60000,
      watchEnabled: false,
      watchDebounceMs: 10,
      limitsEnabled: false,
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForUpdates(updates, 1);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--today'));

    await handle.tick('manual');
    await waitForUpdates(updates, 2);
    handle.stop();

    assert.equal(calls.length, 4);
    assert.ok(calls[1].includes('--today'));
    assert.ok(calls[2].includes('--month'));
    assert.ok(calls[3].includes('--since'));
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('startCollector keeps a period dirty when a watch event arrives during its refresh', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-watch-'));
  fs.mkdirSync(path.join(tmp, '.claude', 'projects'), { recursive: true });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const originalHomedir = os.homedir;
  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  const calls = [];
  const pendingChildren = [];
  let watchCallback = null;

  os.homedir = () => tmp;
  chokidar.watch = () => ({
    on: (eventName, callback) => {
      if (eventName === 'all') watchCallback = callback;
      return this;
    },
    close: () => {}
  });
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    pendingChildren.push(child);
    return child;
  };

  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];

  try {
    const { startCollector } = require(collectorPath);
    const updates = [];
    const handle = startCollector({
      clients: 'claude',
      periods: ['month'],
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60000,
      watchEnabled: true,
      watchDebounceMs: 50,
      watchCooldownMs: 0,
      limitsEnabled: false,
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForCondition(() => pendingChildren.length === 1 && watchCallback);
    finishTokscaleChild(pendingChildren.shift(), { totalTokens: 10, costUsd: 0.01 });
    await waitForUpdates(updates, 1);

    watchCallback('change', path.join(tmp, '.claude', 'projects', 'session.jsonl'));
    await waitForCondition(() => pendingChildren.length === 1);
    watchCallback('change', path.join(tmp, '.claude', 'projects', 'session.jsonl'));
    finishTokscaleChild(pendingChildren.shift(), { totalTokens: 20, costUsd: 0.02 });
    await waitForUpdates(updates, 2);

    const manualTick = handle.tick('manual', { periods: ['month'], onlyIfDirty: true });
    await waitForCondition(() => pendingChildren.length === 1);
    finishTokscaleChild(pendingChildren.shift(), { totalTokens: 30, costUsd: 0.03 });
    await manualTick;
    await waitForUpdates(updates, 3);
    handle.stop();

    assert.equal(calls.length, 3);
    assert.ok(calls.every((args) => args.includes('--month')));
    assert.equal(updates[2].summary.month.totalTokens, 30);
  } finally {
    childProcess.spawn = originalSpawn;
    os.homedir = originalHomedir;
    chokidar.watch = originalWatch;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
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
