'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createIcloudSyncStore, writerFilenameForId } = require('../../src/electron/icloudSync');
const { createIcloudSyncRuntime } = require('../../src/electron/icloudSyncRuntime');

function rootFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-icloud-runtime-'));
  fs.mkdirSync(path.join(root, 'CloudDocs'), { recursive: true });
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function record(deviceId, tokens) {
  const stamp = '2026-09-06T10:00:00.000Z';
  return {
    deviceId,
    hostname: deviceId,
    platform: 'darwin-arm64',
    updatedAt: stamp,
    receivedAt: stamp,
    today: { totalTokens: tokens, clients: { codex: tokens } },
    month: { totalTokens: tokens, clients: { codex: tokens } },
    allTime: { totalTokens: tokens, clients: { codex: tokens } },
    historyAvailable: true,
    history: { daily: [{ date: '2026-09-06', tokens }], monthly: [], summary: {} }
  };
}

test('runtime watches, debounces, aggregates devices, and keeps iCloud state visible', async () => {
  const fixture = rootFixture();
  try {
    const writer = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot: path.join(fixture.root, 'CloudDocs'), writerId: 'writer-a'
    });
    const otherWriter = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot: path.join(fixture.root, 'CloudDocs'), writerId: 'writer-b'
    });
    let onWatch;
    const stats = [];
    const runtime = createIcloudSyncRuntime({
      store: writer,
      debounceMs: 5,
      reconcileMs: 0,
      watchFactory: (_root, callback) => {
        onWatch = callback;
        return { close() {} };
      },
      onStats: (next) => stats.push(next),
      historyEnabled: true
    });
    await runtime.start();
    assert.equal(runtime.getStatus().state, 'available');
    await runtime.writeDevice(record('mac-a', 10));
    otherWriter.writeDevice(record('mac-b', 20));
    onWatch();
    onWatch();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(runtime.getDevices().map((entry) => entry.deviceId), ['mac-a', 'mac-b']);
    assert.equal(runtime.getStats().periods.today.totalTokens, 30);
    assert.equal(runtime.getStats().historyPreview.daily.at(-1).tokens, 30);
    assert.ok(stats.length >= 2);
    await runtime.stop();
  } finally {
    fixture.cleanup();
  }
});

test('runtime waits for the sync directory to initialize before opening a watcher', async () => {
  let watchCalls = 0;
  const store = {
    paths: () => ({ syncRoot: '/tmp/icloud-test-root' }),
    status: () => ({ supported: true, available: true, state: 'initializing', root: '[redacted]/Token Monitor/sync-v1' }),
    discoverDevices: async () => ({ records: [], errors: [] }),
    discoverSubscriptions: async () => ({ winner: null, revisionToken: '', errors: [] })
  };
  const runtime = createIcloudSyncRuntime({
    store,
    reconcileMs: 0,
    watchFactory: () => { watchCalls += 1; return { close() {} }; }
  });
  await runtime.start();
  assert.equal(watchCalls, 0);
  assert.equal(runtime.getStatus().watcher, 'unavailable');
  await runtime.stop();
});

test('runtime retains the last-good aggregate when iCloud Drive disappears', async () => {
  const fixture = rootFixture();
  try {
    const store = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot: path.join(fixture.root, 'CloudDocs'), writerId: 'writer-a'
    });
    const runtime = createIcloudSyncRuntime({ store, reconcileMs: 0, watchFactory: () => ({ close() {} }) });
    await runtime.start();
    await runtime.writeDevice(record('mac-a', 42));
    fs.rmSync(path.join(fixture.root, 'CloudDocs'), { recursive: true, force: true });
    await runtime.reconcile('periodic');
    assert.equal(runtime.getStats().periods.today.totalTokens, 42);
    assert.equal(runtime.getStatus().availability, 'unavailable');
    assert.equal(runtime.getStatus().state, 'waiting');
    await runtime.stop();
  } finally {
    fixture.cleanup();
  }
});

test('generation fencing discards a read that completes after stop', async () => {
  const recordValue = record('late', 9);
  let resolveRead;
  const store = {
    paths: () => ({ syncRoot: '/tmp/icloud-test-root' }),
    status: () => ({ supported: true, available: true, state: 'available', root: '[redacted]/Token Monitor/sync-v1' }),
    discoverDevices: () => new Promise((resolve) => { resolveRead = () => resolve({ records: [recordValue], errors: [] }); }),
    discoverSubscriptions: async () => ({ winner: null, revisionToken: '', errors: [] })
  };
  let published = 0;
  const runtime = createIcloudSyncRuntime({
    store,
    reconcileMs: 0,
    watchFactory: () => ({ close() {} }),
    onStats: () => { published += 1; }
  });
  const started = runtime.start();
  await runtime.stop();
  resolveRead();
  await started;
  assert.equal(published, 0);
  assert.equal(runtime.getDevices().length, 0);
});

test('a restarted runtime does not let the old reconcile promise clear the new generation', async () => {
  const firstRecord = record('old-generation', 1);
  const secondRecord = record('new-generation', 2);
  let reads = 0;
  let resolveFirstRead;
  const store = {
    paths: () => ({ syncRoot: '/tmp/icloud-test-root' }),
    status: () => ({ supported: true, available: true, state: 'available', root: '[redacted]/Token Monitor/sync-v1' }),
    discoverDevices: () => {
      reads += 1;
      if (reads === 1) return new Promise((resolve) => { resolveFirstRead = () => resolve({ records: [firstRecord], errors: [] }); });
      return Promise.resolve({ records: [secondRecord], errors: [] });
    },
    discoverSubscriptions: async () => ({ winner: null, revisionToken: '', errors: [] })
  };
  const runtime = createIcloudSyncRuntime({
    store,
    reconcileMs: 0,
    watchFactory: () => ({ close() {} })
  });
  const firstStart = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.stop();
  await runtime.start();
  assert.equal(runtime.getDevices()[0].deviceId, 'new-generation');
  resolveFirstRead();
  await firstStart;
  assert.equal(runtime.getDevices()[0].deviceId, 'new-generation');
  await runtime.stop();
});

test('a late device write from a stopped generation cannot repaint the restarted runtime', async () => {
  const firstRecord = record('late-generation', 7);
  let resolveWrite;
  const store = {
    paths: () => ({ syncRoot: '/tmp/icloud-test-root' }),
    status: () => ({ supported: true, available: true, state: 'available', root: '[redacted]/Token Monitor/sync-v1' }),
    discoverDevices: async () => ({ records: [], errors: [] }),
    discoverSubscriptions: async () => ({ winner: null, revisionToken: '', errors: [] }),
    writeDevice: () => new Promise((resolve) => { resolveWrite = resolve; })
  };
  const runtime = createIcloudSyncRuntime({
    store,
    reconcileMs: 0,
    watchFactory: () => ({ close() {} })
  });
  await runtime.start();
  const pendingWrite = runtime.writeDevice(firstRecord);
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.stop();
  await runtime.start();
  resolveWrite();
  assert.equal(await pendingWrite, false);
  assert.equal(runtime.getDevices().length, 0);
  await runtime.stop();
});

test('a valid subscription-file deletion publishes an authoritative empty winner', async () => {
  const fixture = rootFixture();
  try {
    const store = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot: path.join(fixture.root, 'CloudDocs'), writerId: 'writer-a'
    });
    const subscription = {
      id: 'one', provider: 'codex', planName: 'Test', amountMinor: 100, currency: 'USD', interval: 'month',
      intervalCount: 1, startDate: '2026-01-01', topUps: [], autoRenew: true,
      updatedAt: '2026-09-06T10:00:00.000Z'
    };
    let published = [];
    const runtime = createIcloudSyncRuntime({
      store,
      reconcileMs: 0,
      watchFactory: () => ({ close() {} }),
      onSubscriptions: (document) => { published.push(document); }
    });
    await runtime.start();
    await runtime.saveSubscriptions([subscription], '');
    published = [];
    fs.rmSync(path.join(store.status().subscriptionsRoot, writerFilenameForId('writer-a')));
    await runtime.reconcile('watch');
    assert.equal(published.length, 1);
    assert.equal(published[0], null);
    assert.equal(runtime.getSubscriptions(), null);
    await runtime.stop();
  } finally {
    fixture.cleanup();
  }
});

test('a stale subscription save refreshes the deterministic winner before rejecting', async () => {
  const fixture = rootFixture();
  try {
    const first = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot: path.join(fixture.root, 'CloudDocs'), writerId: 'writer-a'
    });
    const second = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot: path.join(fixture.root, 'CloudDocs'), writerId: 'writer-b'
    });
    const subscription = (id) => ({
      id, provider: 'codex', planName: 'Test', amountMinor: 100, currency: 'USD', interval: 'month',
      intervalCount: 1, startDate: '2026-01-01', topUps: [], autoRenew: true,
      updatedAt: '2026-09-06T10:00:00.000Z'
    });
    const runtime = createIcloudSyncRuntime({ store: first, reconcileMs: 0, watchFactory: () => ({ close() {} }) });
    await runtime.start();
    const initial = await runtime.saveSubscriptions([subscription('one')], '');
    const base = initial.revisionToken;
    second.writeSubscriptions([subscription('two')], { baseRevision: second.discoverSubscriptions().revisionToken });
    await assert.rejects(
      runtime.saveSubscriptions([subscription('stale')], base),
      { code: 'stale_write' }
    );
    assert.equal(runtime.getSubscriptions().subscriptions[0].id, 'two');
    await runtime.stop();
  } finally {
    fixture.cleanup();
  }
});
