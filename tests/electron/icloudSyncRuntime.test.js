'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createIcloudSyncStore,
  deviceFilenameForId,
  writerFilenameForId
} = require('../../src/electron/icloudSync');
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

async function waitFor(predicate, label = 'condition') {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function blockingWriteFs() {
  const base = fs.promises;
  let blockWrites = false;
  let blocked = false;
  let releaseBlockedWrite = () => {};
  let writeGate = Promise.resolve();
  const api = {
    ...base,
    open: async (...args) => {
      const handle = await base.open(...args);
      const filename = String(args[0] || '');
      if (!blockWrites || !filename.endsWith('.tmp')) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'sync' && !blocked) {
            blocked = true;
            return async (...syncArgs) => {
              await writeGate;
              return target.sync(...syncArgs);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
  return {
    api,
    enable() {
      blockWrites = true;
      blocked = false;
      writeGate = new Promise((resolve) => { releaseBlockedWrite = resolve; });
    },
    isBlocked: () => blocked,
    release() {
      blockWrites = false;
      releaseBlockedWrite();
    }
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
    await otherWriter.writeDevice(record('mac-b', 20));
    onWatch();
    onWatch();
    await waitFor(
      () => runtime.getDevices().some((entry) => entry.deviceId === 'mac-b'),
      'watch reconciliation to discover the second device'
    );
    assert.deepEqual(runtime.getDevices().map((entry) => entry.deviceId), ['mac-a', 'mac-b']);
    assert.equal(runtime.getStats().periods.today.totalTokens, 30);
    assert.equal(runtime.getStats().historyPreview.daily.at(-1).tokens, 30);
    assert.ok(stats.length >= 2);
    await runtime.stop();
  } finally {
    fixture.cleanup();
  }
});

test('a remote tombstone suppresses the local overlay until the next real publish', async () => {
  const fixture = rootFixture();
  try {
    const cloudDocsRoot = path.join(fixture.root, 'CloudDocs');
    const localStore = createIcloudSyncStore({
      platform: 'darwin',
      home: fixture.root,
      cloudDocsRoot,
      writerId: 'writer-a'
    });
    const remoteStore = createIcloudSyncStore({
      platform: 'darwin',
      home: fixture.root,
      cloudDocsRoot,
      writerId: 'writer-b'
    });
    const runtime = createIcloudSyncRuntime({
      store: localStore,
      reconcileMs: 0,
      watchFactory: () => ({ close() {} })
    });

    await runtime.start();
    await runtime.writeDevice(record('shared-device', 10));
    await remoteStore.deleteDevice('shared-device');

    await runtime.reconcile('tombstone');
    assert.deepEqual(runtime.getDevices(), []);

    await runtime.writeDevice(record('shared-device', 11));
    assert.deepEqual(runtime.getDevices().map((entry) => ({
      deviceId: entry.deviceId,
      tokens: entry.periods.today.totalTokens
    })), [{ deviceId: 'shared-device', tokens: 11 }]);
    const republished = await localStore.discoverDevices();
    assert.equal(republished.documents[0].revision, 2);
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

test('a successful reconciliation clears the current diagnostic error', async () => {
  let emitError = true;
  let currentStoreError = 'invalid-json';
  let clearCalls = 0;
  const store = {
    paths: () => ({ syncRoot: '/tmp/icloud-test-root' }),
    status: () => ({
      supported: true,
      available: true,
      state: 'available',
      root: '[redacted]/Token Monitor/sync-v1',
      lastErrorCategory: currentStoreError
    }),
    clearError: () => {
      clearCalls += 1;
      currentStoreError = '';
    },
    discoverDevices: async () => ({ records: [], errors: emitError ? [{ category: 'invalid-json' }] : [] }),
    discoverSubscriptions: async () => ({ winner: null, revisionToken: '', errors: [] })
  };
  const runtime = createIcloudSyncRuntime({ store, reconcileMs: 0, watchFactory: () => ({ close() {} }) });
  await runtime.start();
  assert.equal(runtime.getStatus().lastErrorCategory, 'invalid-json');
  emitError = false;
  await runtime.reconcile('recovered');
  assert.equal(runtime.getStatus().lastErrorCategory, '');
  assert.equal(runtime.getStatus().lastReconcileErrorCategory, '');
  assert.equal(clearCalls, 1);
  await runtime.stop();
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
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = runtime.stop();
  let stopSettled = false;
  stopping.then(() => { stopSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);
  resolveRead();
  await Promise.all([started, stopping]);
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
  const firstStop = runtime.stop();
  resolveFirstRead();
  await firstStop;
  await runtime.start();
  assert.equal(runtime.getDevices()[0].deviceId, 'new-generation');
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
  const stopping = runtime.stop();
  await new Promise((resolve) => setImmediate(resolve));
  resolveWrite();
  await stopping;
  assert.equal(await pendingWrite, false);
  await runtime.start();
  assert.equal(runtime.getDevices().length, 0);
  await runtime.stop();
});

test('runtime stop waits for reconciliation, closes the store once, and is idempotent', async () => {
  let resolveDevices;
  let closeCalls = 0;
  const store = {
    paths: () => ({ syncRoot: '/tmp/icloud-test-root' }),
    status: () => ({ supported: true, available: true, state: 'available', root: '[redacted]/Token Monitor/sync-v1' }),
    discoverDevices: () => new Promise((resolve) => { resolveDevices = resolve; }),
    discoverSubscriptions: async () => ({ winner: null, revisionToken: '', errors: [] }),
    close: () => { closeCalls += 1; return Promise.resolve(); }
  };
  const runtime = createIcloudSyncRuntime({
    store,
    reconcileMs: 0,
    watchFactory: () => ({ close() {} })
  });
  const starting = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  const firstStop = runtime.stop();
  const secondStop = runtime.stop();
  assert.strictEqual(firstStop, secondStop);
  assert.equal(closeCalls, 1);
  let stopSettled = false;
  firstStop.then(() => { stopSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);
  resolveDevices({ records: [], errors: [] });
  await Promise.all([starting, firstStop]);
  assert.equal(stopSettled, true);
  assert.equal(runtime.getStatus().state, 'stopped');
  await runtime.stop();
  assert.equal(closeCalls, 1);
});

test('main awaits old iCloud runtime teardown before mode or sink replacement', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const startIcloud = main.slice(
    main.indexOf('async function startIcloudCollector()'),
    main.indexOf('\nfunction startSyncCollector()', main.indexOf('async function startIcloudCollector()'))
  );
  const startMode = main.slice(
    main.indexOf('function startMode()'),
    main.indexOf('\nasync function reconcileSharedSubscriptions()', main.indexOf('function startMode()'))
  );
  const restart = main.slice(
    main.indexOf('function restartDeviceRuntimeForMode()'),
    main.indexOf('\nfunction usageCollectorNameForMode()', main.indexOf('function restartDeviceRuntimeForMode()'))
  );
  assert.match(startIcloud, /await stopIcloudRuntime\(\)/);
  assert.match(startMode, /const icloudStop = stopIcloudRuntime\(\);[\s\S]*await icloudStop[\s\S]*await stopIcloudRuntime\(\)/);
  assert.match(restart, /if \(settings\.hubMode === 'icloud'\) \{\s*return startIcloudCollector\(\);/);
  assert.doesNotMatch(main, /void icloudRuntimeHandle\.stop\(\)/);
});

test('runtime quiescence prevents an old device write from landing after replacement', async () => {
  const fixture = rootFixture();
  try {
    const cloudDocsRoot = path.join(fixture.root, 'CloudDocs');
    const ledgerPath = path.join(fixture.root, 'revision-ledger.json');
    const blockedFs = blockingWriteFs();
    const storeA = createIcloudSyncStore({
      platform: 'darwin',
      home: fixture.root,
      cloudDocsRoot,
      writerId: 'writer-a',
      revisionLedgerPath: ledgerPath,
      fsApi: blockedFs.api
    });
    const runtimeA = createIcloudSyncRuntime({
      store: storeA,
      reconcileMs: 0,
      watchFactory: () => ({ close() {} })
    });
    await runtimeA.start();
    await runtimeA.writeDevice(record('shared-device', 1));

    blockedFs.enable();
    const oldWrite = runtimeA.writeDevice(record('shared-device', 2));
    await waitFor(blockedFs.isBlocked, 'old device write to block');
    const stopping = runtimeA.stop();
    let replacementStarted = false;
    const storeB = createIcloudSyncStore({
      platform: 'darwin',
      home: fixture.root,
      cloudDocsRoot,
      writerId: 'writer-b',
      revisionLedgerPath: ledgerPath
    });
    const runtimeB = createIcloudSyncRuntime({
      store: storeB,
      reconcileMs: 0,
      watchFactory: () => ({ close() {} })
    });
    const replacement = (async () => {
      await stopping;
      replacementStarted = true;
      await runtimeB.start();
      const oldDocument = JSON.parse(await fs.promises.readFile(
        path.join(storeB.status().devicesRoot, deviceFilenameForId('shared-device')),
        'utf8'
      ));
      assert.equal(oldDocument.revision, 2);
      await runtimeB.writeDevice(record('shared-device', 9));
    })();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replacementStarted, false);

    blockedFs.release();
    assert.equal(await oldWrite, false);
    await replacement;
    const final = await storeB.discoverDevices();
    assert.equal(final.records[0].periods.today.totalTokens, 9);
    assert.equal(final.documents[0].revision, 3);
    await runtimeB.stop();
  } finally {
    fixture.cleanup();
  }
});

test('runtime quiescence drains a pending subscription write before replacement', async () => {
  const fixture = rootFixture();
  try {
    const cloudDocsRoot = path.join(fixture.root, 'CloudDocs');
    const ledgerPath = path.join(fixture.root, 'revision-ledger.json');
    const blockedFs = blockingWriteFs();
    const storeA = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot, writerId: 'writer-a', revisionLedgerPath: ledgerPath, fsApi: blockedFs.api
    });
    const runtimeA = createIcloudSyncRuntime({ store: storeA, reconcileMs: 0, watchFactory: () => ({ close() {} }) });
    await runtimeA.start();
    const subscription = (id) => ({
      id, provider: 'codex', planName: 'Test', amountMinor: 100, currency: 'USD', interval: 'month',
      intervalCount: 1, startDate: '2026-01-01', topUps: [], autoRenew: true,
      updatedAt: '2026-09-06T10:00:00.000Z'
    });
    blockedFs.enable();
    const oldSave = runtimeA.saveSubscriptions([subscription('old')], '');
    await waitFor(blockedFs.isBlocked, 'old subscription write to block');
    const stopping = runtimeA.stop();
    const storeB = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot, writerId: 'writer-b', revisionLedgerPath: ledgerPath
    });
    const runtimeB = createIcloudSyncRuntime({ store: storeB, reconcileMs: 0, watchFactory: () => ({ close() {} }) });
    const replacement = (async () => {
      await stopping;
      await runtimeB.start();
      const current = runtimeB.getSubscriptions();
      assert.equal(current.subscriptions[0].id, 'old');
      await runtimeB.saveSubscriptions([subscription('new')], current.revisionToken);
    })();
    blockedFs.release();
    await assert.rejects(oldSave, { code: 'icloud_stopped' });
    await replacement;
    assert.equal(runtimeB.getSubscriptions().subscriptions[0].id, 'new');
    assert.equal(runtimeB.getSubscriptions().revision.counter, 2);
    await runtimeB.stop();
  } finally {
    fixture.cleanup();
  }
});

test('runtime quiescence drains a pending deletion before replacement', async () => {
  const fixture = rootFixture();
  try {
    const cloudDocsRoot = path.join(fixture.root, 'CloudDocs');
    const ledgerPath = path.join(fixture.root, 'revision-ledger.json');
    const blockedFs = blockingWriteFs();
    const storeA = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot, writerId: 'writer-a', revisionLedgerPath: ledgerPath, fsApi: blockedFs.api
    });
    const runtimeA = createIcloudSyncRuntime({ store: storeA, reconcileMs: 0, watchFactory: () => ({ close() {} }) });
    await runtimeA.start();
    await runtimeA.writeDevice(record('shared-delete', 1));
    blockedFs.enable();
    const oldDelete = runtimeA.deleteDevice('shared-delete');
    await waitFor(blockedFs.isBlocked, 'old deletion to block');
    const stopping = runtimeA.stop();
    const storeB = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot, writerId: 'writer-b', revisionLedgerPath: ledgerPath
    });
    const runtimeB = createIcloudSyncRuntime({ store: storeB, reconcileMs: 0, watchFactory: () => ({ close() {} }) });
    let replacementStarted = false;
    const replacement = (async () => {
      await stopping;
      replacementStarted = true;
      await runtimeB.start();
      await runtimeB.writeDevice(record('shared-delete', 9));
    })();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replacementStarted, false);
    blockedFs.release();
    await assert.rejects(oldDelete, { code: 'icloud_stopped' });
    await replacement;
    const final = await storeB.discoverDevices();
    assert.equal(final.records[0].periods.today.totalTokens, 9);
    assert.equal(final.documents[0].revision, 2);
    const tombstone = JSON.parse(await fs.promises.readFile(
      path.join(storeB.status().deletionsRoot, writerFilenameForId('writer-a')),
      'utf8'
    ));
    assert.equal(tombstone.deletions[0].targetDeviceRevision, 1);
    await runtimeB.stop();
  } finally {
    fixture.cleanup();
  }
});

test('a temporarily missing subscription file keeps the last-good winner', async () => {
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
    assert.equal(published.length, 0);
    assert.equal(runtime.getSubscriptions().subscriptions[0].id, 'one');
    await runtime.stop();
  } finally {
    fixture.cleanup();
  }
});

test('an explicit empty subscription snapshot publishes an authoritative clear', async () => {
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
    const published = [];
    const runtime = createIcloudSyncRuntime({
      store,
      reconcileMs: 0,
      watchFactory: () => ({ close() {} }),
      onSubscriptions: (document) => { published.push(document); }
    });
    await runtime.start();
    const initial = await runtime.saveSubscriptions([subscription], '');
    published.length = 0;
    await runtime.saveSubscriptions([], initial.revisionToken);
    assert.equal(published.at(-1).subscriptions.length, 0);
    assert.equal(runtime.getSubscriptions().subscriptions.length, 0);
    await runtime.stop();
  } finally {
    fixture.cleanup();
  }
});

test('runtime keeps the empty-snapshot distinction across a restart with no subscription winner', async () => {
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
    const runtime = createIcloudSyncRuntime({ store, reconcileMs: 0, watchFactory: () => ({ close() {} }) });
    await runtime.start();
    await runtime.saveSubscriptions([subscription], '');
    const subscriptionPath = path.join(store.status().subscriptionsRoot, writerFilenameForId('writer-a'));
    await fs.promises.unlink(subscriptionPath);
    await runtime.stop();

    const restartedStore = createIcloudSyncStore({
      platform: 'darwin', home: fixture.root, cloudDocsRoot: path.join(fixture.root, 'CloudDocs'), writerId: 'writer-a'
    });
    const restarted = createIcloudSyncRuntime({
      store: restartedStore, reconcileMs: 0, watchFactory: () => ({ close() {} })
    });
    await restarted.start();
    assert.equal(restarted.getSubscriptions(), null);
    assert.equal((await restartedStore.discoverSubscriptions()).winner, null);
    await restarted.stop();
  } finally {
    fixture.cleanup();
  }
});

test('main iCloud subscription refresh never turns an absent winner into a clear', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const start = source.indexOf('async function refreshSharedSubscriptionsNow');
  const end = source.indexOf('// Every hub stamps its stats with the version', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /if \(!document\) return false;/);
  assert.doesNotMatch(body, /if \(!document\)[\s\S]*subscriptions:\s*\[\]/);
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
    await second.writeSubscriptions([subscription('two')], { baseRevision: (await second.discoverSubscriptions()).revisionToken });
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
