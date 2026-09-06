'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  atomicWriteJson,
  createIcloudSyncStore,
  deviceFilenameForId,
  pathState,
  safePathForDisplay,
  writerFilenameForId
} = require('../../src/electron/icloudSync');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-icloud-'));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function device(deviceId, tokens = 1) {
  const now = '2026-09-06T10:00:00.000Z';
  return {
    deviceId,
    hostname: deviceId,
    platform: 'darwin-arm64',
    updatedAt: now,
    receivedAt: now,
    agentVersion: 'test',
    today: { totalTokens: tokens, clients: { codex: tokens }, models: { 'gpt-test': tokens } },
    month: { totalTokens: tokens, clients: { codex: tokens }, models: { 'gpt-test': tokens } },
    allTime: { totalTokens: tokens, clients: { codex: tokens }, models: { 'gpt-test': tokens } },
    historyAvailable: true,
    history: { daily: [{ date: '2026-09-06', tokens }], monthly: [], summary: {} },
    secret: 'must-not-enter-iCloud',
    nested: { cookie: 'must-not-enter-iCloud', safe: true }
  };
}

function subscription(id, provider = 'codex') {
  return {
    id,
    provider,
    planName: 'Test',
    amountMinor: 2000,
    currency: 'USD',
    interval: 'month',
    intervalCount: 1,
    startDate: '2026-01-01',
    topUps: [],
    autoRenew: true,
    updatedAt: '2026-09-06T10:00:00.000Z'
  };
}

function storeFor(root, writerId) {
  return createIcloudSyncStore({
    platform: 'darwin',
    home: root,
    cloudDocsRoot: path.join(root, 'CloudDocs'),
    writerId
  });
}

test('iCloud path discovery is platform-gated and diagnostics never need a username', () => {
  const root = makeRoot();
  try {
    const unsupported = pathState({ platform: 'win32', home: root.root, cloudDocsRoot: path.join(root.root, 'CloudDocs') });
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.available, false);
    assert.equal(unsupported.status, 'unsupported');
    assert.match(safePathForDisplay('/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/Token Monitor/sync-v1', '/Users/bob'), /^\[redacted\]/);
  } finally {
    root.cleanup();
  }
});

test('a sync-root creation failure reports error without claiming iCloud is ready', () => {
  const root = makeRoot();
  try {
    const cloudDocs = path.join(root.root, 'CloudDocs');
    const syncRoot = path.join(cloudDocs, 'Token Monitor', 'sync-v1');
    fs.mkdirSync(path.dirname(syncRoot), { recursive: true });
    fs.writeFileSync(syncRoot, 'not a directory');
    const store = storeFor(root.root, 'writer-a');
    const discovered = store.discoverDevices();
    assert.equal(discovered.status.state, 'error');
    assert.equal(discovered.status.reason, 'root-create-failed');
    assert.equal(discovered.status.available, true);
    assert.ok(discovered.errors.some((entry) => entry.category === 'root-create-failed'));
  } finally {
    root.cleanup();
  }
});

test('separate writers converge on device files and atomic writes strip credentials', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const first = storeFor(root.root, 'writer-a');
    const second = storeFor(root.root, 'writer-b');
    first.writeDevice(device('mac-a', 10));
    second.writeDevice(device('mac-b', 20));

    const discovered = first.discoverDevices();
    assert.deepEqual(discovered.records.map((entry) => entry.deviceId), ['mac-a', 'mac-b']);
    assert.equal(discovered.status.state, 'available');
    const devicePath = path.join(discovered.status.devicesRoot, deviceFilenameForId('mac-a'));
    const stored = JSON.parse(fs.readFileSync(devicePath, 'utf8'));
    assert.equal(stored.record.secret, undefined);
    assert.equal(stored.record.nested, undefined);
    assert.equal(stored.record.today.totalTokens, 10);
    assert.equal(fs.statSync(devicePath).mode & 0o777, 0o600);
  } finally {
    root.cleanup();
  }
});

test('temporary, unknown, malformed and symlinked device files cannot erase last-good data', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const store = storeFor(root.root, 'writer-a');
    store.writeDevice(device('mac-a', 33));
    const paths = store.status();
    fs.writeFileSync(path.join(paths.devicesRoot, '.device-in-progress.tmp'), '{');
    fs.writeFileSync(path.join(paths.devicesRoot, 'unknown.json'), '{}');
    fs.writeFileSync(path.join(paths.devicesRoot, deviceFilenameForId('mac-a')), '{bad json');
    const discovered = store.discoverDevices();
    assert.equal(discovered.records[0].periods.today.totalTokens, 33);
    assert.ok(discovered.errors.some((entry) => entry.filename === deviceFilenameForId('mac-a')));

    const outside = path.join(root.root, 'outside.json');
    fs.writeFileSync(outside, '{}');
    fs.rmSync(path.join(paths.devicesRoot, deviceFilenameForId('mac-a')));
    fs.symlinkSync(outside, path.join(paths.devicesRoot, deviceFilenameForId('mac-a')));
    assert.equal(store.discoverDevices().records.length, 1);
  } finally {
    root.cleanup();
  }
});

test('device deletion is exact, recoverable by a later writer, and rejects traversal ids', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const store = storeFor(root.root, 'writer-a');
    store.writeDevice(device('mac-a', 2));
    assert.throws(() => store.writeDevice(device('../outside')), { code: 'invalid_device_id' });
    assert.throws(() => store.deleteDevice('../outside'), { code: 'invalid_device_id' });
    assert.equal(store.deleteDevice('mac-a').deleted, true);
    assert.equal(store.discoverDevices().records.length, 0);
    store.writeDevice(device('mac-a', 3));
    assert.equal(store.discoverDevices().records[0].periods.today.totalTokens, 3);
  } finally {
    root.cleanup();
  }
});

test('subscription winner is deterministic by counter then writer id and stale bases are rejected', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const alpha = storeFor(root.root, 'alpha');
    const beta = storeFor(root.root, 'beta');
    const first = alpha.writeSubscriptions([subscription('first')]);
    const betaBase = beta.discoverSubscriptions();
    beta.writeSubscriptions([subscription('second', 'claude')], { baseRevision: betaBase.revisionToken });
    const current = alpha.discoverSubscriptions();
    assert.equal(current.winner.writerId, 'beta');
    assert.equal(current.winner.revision.counter, 2);
    assert.throws(
      () => alpha.writeSubscriptions([subscription('stale')], { baseRevision: first.revisionToken }),
      { code: 'stale_write' }
    );

    const paths = alpha.status();
    const tied = (writerId, subscriptions) => ({
      schemaVersion: 1,
      kind: 'subscriptions',
      writerId,
      revision: { counter: 9, writerId },
      updatedAt: '2026-09-06T10:00:00.000Z',
      subscriptions
    });
    atomicWriteJson(fs, path.join(paths.subscriptionsRoot, writerFilenameForId('alpha')), tied('alpha', [subscription('alpha-tie')]));
    atomicWriteJson(fs, path.join(paths.subscriptionsRoot, writerFilenameForId('zulu')), tied('zulu', [subscription('zulu-tie')]));
    assert.equal(alpha.discoverSubscriptions().winner.writerId, 'zulu');
  } finally {
    root.cleanup();
  }
});
