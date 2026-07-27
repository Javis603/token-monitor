'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  resolveMacWidgetSnapshotPath,
  updateMacWidgetSnapshot,
  writeMacWidgetSnapshot
} = require('../../src/electron/macWidgetBridge');

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

test('keeps the previous snapshot and reports a controlled failure when rename fails', async () => {
  await withTempDirectory(async (directory) => {
    const snapshotPath = path.join(directory, 'snapshot.json');
    await fs.writeFile(snapshotPath, 'last good snapshot', 'utf8');
    const messages = [];
    const failingFs = {
      ...fs,
      async rename() { throw new Error('simulated rename failure'); }
    };

    const result = await writeMacWidgetSnapshot('new snapshot', {
      platform: 'darwin',
      snapshotPath,
      fs: failingFs,
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
    assert.equal(snapshot.schemaVersion, 5);
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
