'use strict';

const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  commitMacWidgetSnapshot,
  createCommitMacWidgetSnapshot,
  prepareMacWidgetSnapshot,
  resolveMacWidgetSnapshotPath,
  syncMacWidgetSnapshotDirectory,
  updateMacWidgetSnapshot,
  writeMacWidgetSnapshot
} = require('../../src/electron/macWidgetBridge');
const { aggregateDevices } = require('../../src/shared/usage');

async function withTempDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'token-monitor-widget-'));
  try {
    return await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('atomically replaces the snapshot and removes temporary files', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'nested', 'snapshot.json');
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, 'old snapshot', 'utf8');

    const result = await writeMacWidgetSnapshot('{"schemaVersion":1}\n', {
      platform: 'darwin',
      snapshotPath
    });

    assert.deepEqual(result, { ok: true, path: snapshotPath, changed: true });
    assert.equal(await fs.readFile(snapshotPath, 'utf8'), '{"schemaVersion":1}\n');
    assert.deepEqual(await fs.readdir(path.dirname(snapshotPath)), ['snapshot.json']);
    // Windows does not expose POSIX permission bits consistently.
    // Content replacement and temporary-file cleanup are verified above.
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(snapshotPath)).mode & 0o777, 0o600);
    }
  });
});

test('final owner check and formal rename run in one non-yielding commit stack', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    await fs.writeFile(snapshotPath, 'last good snapshot', 'utf8');
    const prepared = await prepareMacWidgetSnapshot('new snapshot', {
      platform: 'darwin',
      snapshotPath
    });
    const events = [];
    let current = true;

    const commitSnapshot = createCommitMacWidgetSnapshot((from, to) => {
      events.push('rename');
      fsSync.renameSync(from, to);
    });
    const result = commitSnapshot(prepared.prepared, {
      isCurrent() {
        events.push('check');
        queueMicrotask(() => {
          current = false;
          events.push('transition');
        });
        return current;
      }
    });
    events.push('returned');
    await Promise.resolve();

    assert.deepEqual(events, ['check', 'rename', 'returned', 'transition']);
    assert.deepEqual(result, { ok: true, path: snapshotPath, changed: true, directory });
    assert.equal(await fs.readFile(snapshotPath, 'utf8'), 'new snapshot');
    await syncMacWidgetSnapshotDirectory(result);
  });
});

test('a superseded prepared snapshot is discarded before formal publish', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    const prepared = await prepareMacWidgetSnapshot('new snapshot', {
      platform: 'darwin',
      snapshotPath
    });

    const result = commitMacWidgetSnapshot(prepared.prepared, {
      isCurrent: () => false
    });

    assert.deepEqual(result, { ok: false, reason: 'superseded' });
    await fs.unlink(prepared.prepared.tempPath);
    await assert.rejects(fs.access(snapshotPath));
  });
});

test('discards a snapshot whose source generation expires before atomic publish', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    let checks = 0;

    const result = await updateMacWidgetSnapshot({
      periods: { today: { totalTokens: 42, costUsd: 0.5 } }
    }, {
      platform: 'darwin',
      snapshotPath,
      isCurrent: () => {
        checks += 1;
        return checks === 1;
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'superseded');
    assert.equal(checks, 2);
    await assert.rejects(fs.access(snapshotPath));
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test('keeps the previous snapshot and reports a controlled failure when rename fails', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    await fs.writeFile(snapshotPath, 'last good snapshot', 'utf8');
    const messages = [];
    const failingFs = { ...fs };

    const result = await writeMacWidgetSnapshot('new snapshot', {
      platform: 'darwin',
      snapshotPath,
      fs: failingFs,
      renameSync() { throw new Error('simulated rename failure'); },
      logger: (message) => messages.push(message)
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'write-failed');
    assert.equal(await fs.readFile(snapshotPath, 'utf8'), 'last good snapshot');
    assert.deepEqual(await fs.readdir(directory), ['snapshot.json']);
    assert.match(messages[0], /simulated rename failure/);
  });
});

test('is a no-op outside macOS without touching the filesystem', async () => {
  const fsApi = new Proxy({}, {
    get() { throw new Error('filesystem should not be accessed'); }
  });
  const result = await writeMacWidgetSnapshot('snapshot', {
    platform: 'linux',
    snapshotPath: '/not/used/snapshot.json',
    fs: fsApi
  });
  assert.deepEqual(result, { ok: false, reason: 'unsupported-platform' });
});

test('is a no-op on macOS when no shared-container path is configured', async () => {
  assert.deepEqual(await writeMacWidgetSnapshot('snapshot', { platform: 'darwin' }), {
    ok: false,
    reason: 'not-configured'
  });
});

test('does not rewrite unchanged snapshots so reload callers can skip refreshes', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    await fs.writeFile(snapshotPath, '{"schemaVersion":2}\n', 'utf8');

    const result = await writeMacWidgetSnapshot('{"schemaVersion":2}\n', {
      platform: 'darwin',
      snapshotPath
    });

    assert.deepEqual(result, { ok: true, path: snapshotPath, changed: false });
  });
});

test('resolves only safe macOS App Group snapshot paths', () => {
  assert.equal(resolveMacWidgetSnapshotPath({
    platform: 'darwin',
    appGroup: 'group.com.example.tokenmonitor',
    home: '/Users/example'
  }), path.join(
    '/Users/example',
    'Library',
    'Group Containers',
    'group.com.example.tokenmonitor',
    'snapshot.json'
  ));
  assert.equal(resolveMacWidgetSnapshotPath({
    platform: 'linux',
    appGroup: 'group.com.example.tokenmonitor',
    home: '/home/example'
  }), null);
  assert.equal(resolveMacWidgetSnapshotPath({
    platform: 'darwin',
    appGroup: 'ABCDEFGHIJ.dev.example.widgettest',
    home: '/Users/example'
  }), path.join(
    '/Users/example',
    'Library',
    'Group Containers',
    'ABCDEFGHIJ.dev.example.widgettest',
    'snapshot.json'
  ));
  assert.equal(resolveMacWidgetSnapshotPath({
    platform: 'darwin',
    appGroup: 'SHORT.dev.example.widgettest',
    home: '/Users/example'
  }), null);
  assert.equal(resolveMacWidgetSnapshotPath({
    platform: 'darwin',
    appGroup: '../../credentials',
    home: '/Users/example'
  }), null);
  assert.equal(resolveMacWidgetSnapshotPath({
    platform: 'darwin',
    appGroup: 'group.com.example.tokenmonitor',
    home: '/Users/example',
    snapshotFileName: '../credentials.json'
  }), null);
});

test('serializes aggregate stats before writing the snapshot', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    const result = await updateMacWidgetSnapshot({
      periods: { today: { totalTokens: 42, costUsd: 0.5 } }
    }, {
      platform: 'darwin',
      snapshotPath,
      snapshotOptions: { now: '2026-07-16T09:00:00Z' }
    });

    assert.equal(result.ok, true);
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    assert.equal(snapshot.schemaVersion, 6);
    assert.equal(snapshot.generatedAt, '2026-07-16T09:00:00.000Z');
    assert.equal(snapshot.overview.totalTokens, 42);
    assert.equal(snapshot.overview.costUsd, 0.5);
    assert.equal(snapshot.periods.day.overview.totalTokens, 42);
    assert.equal(snapshot.periods.month.overview.totalTokens, 0);
    assert.equal(snapshot.periods.total.overview.totalTokens, 0);
    assert.deepEqual(snapshot.quota, []);
    assert.deepEqual(snapshot.models, []);
  });
});

test('compares stable snapshot content instead of rewriting for clock-only changes', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    const stats = {
      updatedAt: '2026-07-16T09:00:00Z',
      periods: { today: { totalTokens: 42, costUsd: 0.5 } },
      limits: { providers: [{ provider: 'codex', status: 'ok', windows: [{ kind: 'weekly', remainingPercent: 80 }] }] }
    };
    const options = {
      platform: 'darwin',
      snapshotPath,
      snapshotOptions: {
        history: { daily: [], monthly: [], summary: {} },
        presentation: { defaultPeriod: 'today' }
      }
    };

    const first = await updateMacWidgetSnapshot(stats, {
      ...options,
      snapshotOptions: { ...options.snapshotOptions, now: '2026-07-16T09:00:00Z' }
    });
    const second = await updateMacWidgetSnapshot(stats, {
      ...options,
      snapshotOptions: { ...options.snapshotOptions, now: '2026-07-16T09:04:59Z' }
    });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(JSON.parse(await fs.readFile(snapshotPath, 'utf8')).generatedAt, '2026-07-16T09:00:00.000Z');

    const tokenChanged = structuredClone(stats);
    tokenChanged.periods.today.totalTokens = 43;
    assert.equal((await updateMacWidgetSnapshot(tokenChanged, options)).changed, true);

    const limitsChanged = structuredClone(tokenChanged);
    limitsChanged.limits.providers[0].windows[0].remainingPercent = 79;
    assert.equal((await updateMacWidgetSnapshot(limitsChanged, options)).changed, true);

    assert.equal((await updateMacWidgetSnapshot(limitsChanged, {
      ...options,
      snapshotOptions: { ...options.snapshotOptions, presentation: { currencyCode: 'CNY', currencyRate: 7.1 } }
    })).changed, true);

    // The app's own period tab is deliberately not part of the snapshot, so
    // switching it must not reach disk or spend a WidgetKit reload.
    assert.equal((await updateMacWidgetSnapshot(limitsChanged, {
      ...options,
      snapshotOptions: {
        ...options.snapshotOptions,
        presentation: { currencyCode: 'CNY', currencyRate: 7.1, defaultPeriod: 'month' }
      }
    })).changed, false);
  });
});

test('does not rewrite production-shaped aggregate stats when only updatedAt advances', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    const counters = { rename: 0, tempSync: 0 };
    const trackingFs = {
      ...fs,
      async open(...args) {
        const handle = await fs.open(...args);
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (String(args[0]).includes('.tmp')) counters.tempSync += 1;
          return originalSync();
        };
        return handle;
      }
    };
    const base = {
      updatedAt: '2026-07-16T09:00:00Z',
      stale: false,
      periods: { today: { totalTokens: 42, costUsd: 0.5 } }
    };
    const options = {
      platform: 'darwin',
      snapshotPath,
      fs: trackingFs,
      renameSync(...args) {
        counters.rename += 1;
        return fsSync.renameSync(...args);
      },
      snapshotOptions: {
        now: '2026-07-16T09:00:05Z',
        history: { daily: [], monthly: [], summary: {} }
      }
    };

    const first = await updateMacWidgetSnapshot(base, options);
    const second = await updateMacWidgetSnapshot({ ...base, updatedAt: '2026-07-16T09:00:20Z' }, options);

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(counters.rename, 1);
    assert.equal(counters.tempSync, 1);
  });
});

test('rewrites when the upstream stale state changes in either direction', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    const options = {
      platform: 'darwin',
      snapshotPath,
      snapshotOptions: {
        now: '2026-07-16T09:00:05Z',
        history: { daily: [], monthly: [], summary: {} }
      }
    };
    const stats = {
      updatedAt: '2026-07-16T09:00:00Z',
      periods: { today: { totalTokens: 42, costUsd: 0.5 } }
    };

    assert.equal((await updateMacWidgetSnapshot({ ...stats, stale: false }, options)).changed, true);
    assert.equal((await updateMacWidgetSnapshot({ ...stats, stale: true }, options)).changed, true);
    assert.equal((await updateMacWidgetSnapshot({ ...stats, stale: false }, options)).changed, true);
  });
});

test('refreshes freshness metadata on a bounded heartbeat without rewriting every tick', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    const stats = {
      updatedAt: '2026-07-16T09:00:00Z',
      periods: { today: { totalTokens: 42, costUsd: 0.5 } }
    };
    const options = {
      platform: 'darwin',
      snapshotPath,
      snapshotOptions: { history: { daily: [], monthly: [], summary: {} } }
    };

    assert.equal((await updateMacWidgetSnapshot(stats, {
      ...options,
      snapshotOptions: { ...options.snapshotOptions, now: '2026-07-16T09:00:00Z' }
    })).changed, true);
    assert.equal((await updateMacWidgetSnapshot(stats, {
      ...options,
      snapshotOptions: { ...options.snapshotOptions, now: '2026-07-16T09:04:59Z' }
    })).changed, false);
    assert.equal((await updateMacWidgetSnapshot(stats, {
      ...options,
      snapshotOptions: { ...options.snapshotOptions, now: '2026-07-16T09:05:00Z' }
    })).changed, true);
    assert.equal(JSON.parse(await fs.readFile(snapshotPath, 'utf8')).generatedAt, '2026-07-16T09:05:00.000Z');
  });
});

test('rewrites when a real source refresh restores stale data to fresh', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    const stats = {
      updatedAt: '2026-07-16T09:39:00Z',
      periods: { today: { totalTokens: 42, costUsd: 0.5 } },
      limits: { providers: [{ provider: 'codex', status: 'ok', windows: [{ kind: 'weekly', remainingPercent: 80 }] }] }
    };
    const options = {
      platform: 'darwin',
      snapshotPath,
      snapshotOptions: {
        now: '2026-07-16T10:00:00Z',
        history: { daily: [], monthly: [], summary: {} }
      }
    };

    const stale = await updateMacWidgetSnapshot(stats, options);
    assert.equal(stale.changed, true);
    assert.equal(JSON.parse(await fs.readFile(snapshotPath, 'utf8')).status.isStale, true);

    const refreshedStats = { ...stats, updatedAt: '2026-07-16T09:50:00Z' };
    const refreshed = await updateMacWidgetSnapshot(refreshedStats, options);
    assert.equal(refreshed.changed, true);
    const freshSnapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    assert.equal(freshSnapshot.status.isStale, false);
    assert.equal(freshSnapshot.status.sourceUpdatedAt, '2026-07-16T09:50:00.000Z');

    const clockOnly = await updateMacWidgetSnapshot(refreshedStats, {
      ...options,
      snapshotOptions: { ...options.snapshotOptions, now: '2026-07-16T10:01:00Z' }
    });
    assert.equal(clockOnly.changed, false);
  });
});

test('rewrites when a Hub device refresh restores stale data to fresh without business changes', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    const nowMs = Date.parse('2026-07-16T10:00:00Z');
    const device = (receivedAt) => ({
      deviceId: 'remote',
      updatedAt: receivedAt,
      receivedAt,
      periods: {
        today: { totalTokens: 42, costUsd: 0.5 },
        month: { totalTokens: 42, costUsd: 0.5 },
        allTime: { totalTokens: 42, costUsd: 0.5 }
      }
    });
    const options = {
      platform: 'darwin',
      snapshotPath,
      snapshotOptions: {
        now: new Date(nowMs).toISOString(),
        history: { daily: [], monthly: [], summary: {} }
      }
    };

    const staleStats = aggregateDevices([device('2026-07-16T09:00:00Z')], 20 * 60 * 1000, nowMs);
    const freshStats = aggregateDevices([device('2026-07-16T09:55:00Z')], 20 * 60 * 1000, nowMs);
    assert.equal((await updateMacWidgetSnapshot(staleStats, options)).changed, true);
    assert.equal((await updateMacWidgetSnapshot(freshStats, options)).changed, true);
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    assert.equal(snapshot.status.isStale, false);
    assert.equal(snapshot.status.sourceUpdatedAt, '2026-07-16T09:55:00.000Z');
  });
});

test('compares an existing snapshot from before startup by stable content', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    const stats = {
      updatedAt: '2026-07-16T09:00:00Z',
      periods: { today: { totalTokens: 42, costUsd: 0.5 } }
    };
    const first = await updateMacWidgetSnapshot(stats, {
      platform: 'darwin',
      snapshotPath,
      snapshotOptions: {
        now: '2026-07-16T09:00:00Z',
        history: { daily: [], monthly: [], summary: {} }
      }
    });
    assert.equal(first.changed, true);

    const oldSnapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    oldSnapshot.generatedAt = '2026-07-16T08:59:00.000Z';
    oldSnapshot.status.snapshotGeneratedAt = oldSnapshot.generatedAt;
    await fs.writeFile(snapshotPath, `${JSON.stringify(oldSnapshot)}\n`, 'utf8');

    const second = await updateMacWidgetSnapshot(stats, {
      platform: 'darwin',
      snapshotPath,
      snapshotOptions: {
        now: '2026-07-16T09:01:00Z',
        history: { daily: [], monthly: [], summary: {} }
      }
    });
    assert.equal(second.changed, false);
    assert.equal(JSON.parse(await fs.readFile(snapshotPath, 'utf8')).generatedAt, '2026-07-16T08:59:00.000Z');
  });
});
