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
  MAX_ICLOUD_DOCUMENT_BYTES,
  pathState,
  readJsonFile,
  safePathForDisplay,
  syncDirectory,
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

test('iCloud path discovery is platform-gated and diagnostics never need a username', async () => {
  const root = makeRoot();
  try {
    const unsupported = await pathState({ platform: 'win32', home: root.root, cloudDocsRoot: path.join(root.root, 'CloudDocs') });
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.available, false);
    assert.equal(unsupported.status, 'unsupported');
    assert.match(safePathForDisplay('/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/Token Monitor/sync-v1', '/Users/bob'), /^\[redacted\]/);
  } finally {
    root.cleanup();
  }
});

test('a sync-root creation failure reports error without claiming iCloud is ready', async () => {
  const root = makeRoot();
  try {
    const cloudDocs = path.join(root.root, 'CloudDocs');
    const syncRoot = path.join(cloudDocs, 'Token Monitor', 'sync-v1');
    fs.mkdirSync(path.dirname(syncRoot), { recursive: true });
    fs.writeFileSync(syncRoot, 'not a directory');
    const store = storeFor(root.root, 'writer-a');
    const discovered = await store.discoverDevices();
    assert.equal(discovered.status.state, 'error');
    assert.equal(discovered.status.reason, 'root-create-failed');
    assert.equal(discovered.status.available, true);
    assert.ok(discovered.errors.some((entry) => entry.category === 'root-create-failed'));
  } finally {
    root.cleanup();
  }
});

test('separate writers converge on device files and atomic writes strip credentials', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const first = storeFor(root.root, 'writer-a');
    const second = storeFor(root.root, 'writer-b');
    await first.writeDevice(device('mac-a', 10));
    await second.writeDevice(device('mac-b', 20));

    const discovered = await first.discoverDevices();
    assert.deepEqual(discovered.records.map((entry) => entry.deviceId), ['mac-a', 'mac-b']);
    assert.equal(discovered.status.state, 'available');
    const devicePath = path.join(discovered.status.devicesRoot, deviceFilenameForId('mac-a'));
    const stored = JSON.parse(fs.readFileSync(devicePath, 'utf8'));
    assert.equal(stored.record.secret, undefined);
    assert.equal(stored.record.nested, undefined);
    assert.equal(stored.record.today.totalTokens, 10);
    // Windows does not expose POSIX mode bits; the atomic-write test below
    // still verifies that the private mode is requested and applied, while
    // macOS continues to assert the real filesystem permission guarantee.
    if (process.platform === 'darwin') assert.equal(fs.statSync(devicePath).mode & 0o777, 0o600);
  } finally {
    root.cleanup();
  }
});

test('same-writer device mutations serialize so an older revision cannot finish last', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const store = storeFor(root.root, 'writer-a');
    const [first, second] = await Promise.all([
      store.writeDevice(device('mac-a', 10)),
      store.writeDevice(device('mac-a', 20))
    ]);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    const discovered = await store.discoverDevices();
    assert.equal(discovered.records[0].periods.today.totalTokens, 20);
    assert.equal(discovered.documents[0].revision, 2);
  } finally {
    root.cleanup();
  }
});

test('store close rejects new mutations and drains device, subscription, deletion, and ledger queues', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const ledgerPath = path.join(root.root, 'revision-ledger.json');
    const base = fs.promises;
    let blockWrites = true;
    let blocked = false;
    let releaseBlockedWrite;
    const writeGate = new Promise((resolve) => { releaseBlockedWrite = resolve; });
    const delayedFs = {
      ...base,
      open: async (...args) => {
        const filename = String(args[0] || '');
        if (blockWrites && filename.endsWith('.tmp') && !blocked) {
          blocked = true;
          await writeGate;
        }
        return base.open(...args);
      }
    };
    const store = createIcloudSyncStore({
      platform: 'darwin',
      home: root.root,
      cloudDocsRoot: path.join(root.root, 'CloudDocs'),
      writerId: 'writer-a',
      revisionLedgerPath: ledgerPath,
      fsApi: delayedFs
    });
    const pendingDevice = store.writeDevice(device('mac-a', 1));
    const pendingSubscriptions = store.writeSubscriptions([], '');
    const pendingDelete = store.deleteDevice('mac-a');
    for (let attempt = 0; attempt < 2000 && !blocked; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(blocked, true);

    const closing = store.close();
    assert.strictEqual(store.close(), closing);
    assert.strictEqual(store.whenIdle(), closing);
    let closed = false;
    closing.then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    await assert.rejects(() => store.writeDevice(device('mac-b')), { code: 'icloud_stopped' });
    await assert.rejects(() => store.writeSubscriptions([], ''), { code: 'icloud_stopped' });
    await assert.rejects(() => store.deleteDevice('mac-a'), { code: 'icloud_stopped' });

    blockWrites = false;
    releaseBlockedWrite();
    await Promise.all([pendingDevice, pendingSubscriptions, pendingDelete, closing]);
  } finally {
    root.cleanup();
  }
});

test('temporary, unknown, malformed and symlinked device files cannot erase last-good data', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const store = storeFor(root.root, 'writer-a');
    await store.writeDevice(device('mac-a', 33));
    const paths = store.status();
    const knownDevicePath = path.join(paths.devicesRoot, deviceFilenameForId('mac-a'));
    await fs.promises.unlink(knownDevicePath);
    const missing = await store.discoverDevices();
    assert.equal(missing.records[0].periods.today.totalTokens, 33);
    await store.writeDevice(device('mac-a', 34));
    fs.writeFileSync(path.join(paths.devicesRoot, '.device-in-progress.tmp'), '{');
    fs.writeFileSync(path.join(paths.devicesRoot, 'unknown.json'), '{}');
    fs.writeFileSync(knownDevicePath, '{bad json');
    const discovered = await store.discoverDevices();
    assert.equal(discovered.records[0].periods.today.totalTokens, 34);
    assert.ok(discovered.errors.some((entry) => entry.filename === deviceFilenameForId('mac-a')));

    const outside = path.join(root.root, 'outside.json');
    fs.writeFileSync(outside, '{}');
    if (process.platform === 'win32') return;
    fs.rmSync(knownDevicePath);
    fs.symlinkSync(outside, knownDevicePath);
    const symlinked = await store.discoverDevices();
    assert.equal(symlinked.records.length, 1);
    assert.ok(symlinked.errors.some((entry) => entry.category === 'symlink-not-allowed'));
  } finally {
    root.cleanup();
  }
});

test('symlink open failures are classified separately from missing or malformed files', async () => {
  const fakeFs = {
    open: async () => {
      throw Object.assign(new Error('symbolic link refused'), { code: 'ELOOP' });
    }
  };
  const result = await readJsonFile(fakeFs, '/tmp/symlink.json', 1024, 'darwin');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'symlink-not-allowed');
});

test('device deletion is explicit, recoverable by a later writer, and rejects traversal ids', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const store = storeFor(root.root, 'writer-a');
    await store.writeDevice(device('mac-a', 2));
    await assert.rejects(() => store.writeDevice(device('../outside')), { code: 'invalid_device_id' });
    await assert.rejects(() => store.deleteDevice('../outside'), { code: 'invalid_device_id' });
    const deleted = await store.deleteDevice('mac-a');
    assert.equal(deleted.deleted, true);
    assert.equal((await store.discoverDevices()).records.length, 0);
    const deletionPath = path.join(store.status().deletionsRoot, writerFilenameForId('writer-a'));
    assert.equal((await fs.promises.stat(deletionPath)).isFile(), true);
    assert.equal((await fs.promises.stat(path.join(store.status().devicesRoot, deviceFilenameForId('mac-a')))).isFile(), true);
    await store.writeDevice(device('mac-a', 3));
    assert.equal((await store.discoverDevices()).records[0].periods.today.totalTokens, 3);
  } finally {
    root.cleanup();
  }
});

test('subscription winner is deterministic by counter then writer id and stale bases are rejected', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const alpha = storeFor(root.root, 'alpha');
    const beta = storeFor(root.root, 'beta');
    const first = await alpha.writeSubscriptions([subscription('first')]);
    const betaBase = await beta.discoverSubscriptions();
    await beta.writeSubscriptions([subscription('second', 'claude')], { baseRevision: betaBase.revisionToken });
    const current = await alpha.discoverSubscriptions();
    assert.equal(current.winner.writerId, 'beta');
    assert.equal(current.winner.revision.counter, 2);
    await assert.rejects(
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
    await atomicWriteJson(fs.promises, path.join(paths.subscriptionsRoot, writerFilenameForId('alpha')), tied('alpha', [subscription('alpha-tie')]));
    await atomicWriteJson(fs.promises, path.join(paths.subscriptionsRoot, writerFilenameForId('zulu')), tied('zulu', [subscription('zulu-tie')]));
    assert.equal((await alpha.discoverSubscriptions()).winner.writerId, 'zulu');
  } finally {
    root.cleanup();
  }
});

test('iCloud storage performs core read/write/reconcile through injected async filesystem APIs', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const calls = [];
    const call = (name, operation) => {
      calls.push(name);
      const result = operation();
      assert.equal(typeof result?.then, 'function', `${name} must return a Promise`);
      return result;
    };
    const wrapHandle = (handle) => new Proxy(handle, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args) => call(`handle.${String(property)}`, () => value.apply(target, args));
      }
    });
    const asyncFs = {
      lstat: (...args) => call('lstat', () => fs.promises.lstat(...args)),
      mkdir: (...args) => call('mkdir', () => fs.promises.mkdir(...args)),
      readdir: (...args) => call('readdir', () => fs.promises.readdir(...args)),
      rename: (...args) => call('rename', () => fs.promises.rename(...args)),
      chmod: (...args) => call('chmod', () => fs.promises.chmod(...args)),
      unlink: (...args) => call('unlink', () => fs.promises.unlink(...args)),
      open: (...args) => call('open', async () => wrapHandle(await fs.promises.open(...args)))
    };
    const store = createIcloudSyncStore({
      platform: 'darwin',
      home: root.root,
      cloudDocsRoot: path.join(root.root, 'CloudDocs'),
      writerId: 'writer-a',
      fsApi: asyncFs
    });

    await store.writeDevice(device('mac-a', 11));
    const discovered = await store.discoverDevices();
    assert.equal(discovered.records[0].periods.today.totalTokens, 11);
    assert.ok(calls.includes('lstat'));
    assert.ok(calls.includes('mkdir'));
    assert.ok(calls.includes('readdir'));
    assert.ok(calls.includes('open'));
    assert.ok(calls.includes('handle.writeFile'));
    assert.ok(calls.includes('handle.stat'));
    assert.ok(calls.includes('handle.readFile'));
    assert.ok(calls.includes('handle.sync'));
    assert.ok(calls.includes('handle.close'));
    assert.ok(calls.includes('rename'));
  } finally {
    root.cleanup();
  }
});

test('oversized device documents are rejected before JSON parsing and keep last-good data', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const store = storeFor(root.root, 'writer-a');
    await store.writeDevice(device('mac-a', 11));
    const target = path.join(store.status().devicesRoot, deviceFilenameForId('mac-a'));
    await fs.promises.writeFile(target, '{'.repeat(MAX_ICLOUD_DOCUMENT_BYTES + 1));
    const discovered = await store.discoverDevices();
    assert.equal(discovered.records[0].periods.today.totalTokens, 11);
    assert.ok(discovered.errors.some((entry) => entry.category === 'document-too-large'));
    assert.equal(discovered.errors.some((entry) => entry.category === 'invalid-json'), false);
  } finally {
    root.cleanup();
  }
});

test('a file that disappears during read keeps last-good data without masquerading as malformed JSON', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    let failReads = false;
    const flakyFs = {
      ...fs.promises,
      open: async (...args) => {
        const handle = await fs.promises.open(...args);
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'readFile') {
              return async (...readArgs) => {
                if (failReads) throw Object.assign(new Error('replaced by File Provider'), { code: 'ENOENT' });
                return target.readFile(...readArgs);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
    };
    const store = createIcloudSyncStore({
      platform: 'darwin',
      home: root.root,
      cloudDocsRoot: path.join(root.root, 'CloudDocs'),
      writerId: 'writer-a',
      fsApi: flakyFs
    });
    await store.writeDevice(device('mac-a', 12));
    failReads = true;
    const discovered = await store.discoverDevices();
    assert.equal(discovered.records[0].periods.today.totalTokens, 12);
    assert.ok(discovered.errors.some((entry) => entry.category === 'missing'));
    assert.equal(discovered.errors.some((entry) => entry.category === 'invalid-json'), false);
  } finally {
    root.cleanup();
  }
});

test('same-handle reads do not follow a path replacement after open', async () => {
  const root = makeRoot();
  try {
    const target = path.join(root.root, 'document.json');
    const replacement = `${target}.old`;
    await fs.promises.writeFile(target, JSON.stringify({ source: 'old' }));
    let swapped = false;
    const raceFs = {
      ...fs.promises,
      open: async (...args) => {
        const handle = await fs.promises.open(...args);
        if (args[0] === target && !swapped) {
          swapped = true;
          await fs.promises.rename(target, replacement);
          await fs.promises.writeFile(target, JSON.stringify({ source: 'new' }));
        }
        return handle;
      }
    };
    const result = await readJsonFile(raceFs, target, 1024, 'darwin');
    assert.deepEqual(result, { ok: true, value: { source: 'old' } });
    assert.deepEqual(JSON.parse(await fs.promises.readFile(target, 'utf8')), { source: 'new' });
  } finally {
    root.cleanup();
  }
});

test('same-handle oversized reads are rejected before handle.readFile', async () => {
  const maxBytes = 32;
  let readCalls = 0;
  let openFlags = null;
  const fakeFs = {
    open: async (_target, flags) => {
      openFlags = flags;
      return {
        stat: async () => ({ isFile: () => true, size: maxBytes + 1 }),
        readFile: async () => {
          readCalls += 1;
          return '{}';
        },
        close: async () => {}
      };
    }
  };
  const result = await readJsonFile(fakeFs, '/tmp/oversized.json', maxBytes, 'darwin');
  assert.deepEqual(result, { ok: false, reason: 'document-too-large', size: maxBytes + 1 });
  assert.equal(readCalls, 0);
  if (typeof fs.constants.O_NOFOLLOW === 'number') {
    assert.equal(openFlags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
  } else {
    assert.equal(openFlags, fs.constants.O_RDONLY || 0);
  }
});

test('oversized writes are rejected before creating a temporary file', async () => {
  const root = makeRoot();
  try {
    const target = path.join(root.root, 'documents', 'device.json');
    await assert.rejects(
      atomicWriteJson(fs.promises, target, { data: 'x'.repeat(128) }, { maxBytes: 32 }),
      { code: 'document_too_large' }
    );
    assert.equal(fs.existsSync(path.dirname(target)), false);
  } finally {
    root.cleanup();
  }
});

test('atomic writes fsync the file and parent directory, preserve 0600, and clean temporary files', async () => {
  const root = makeRoot();
  try {
    const directory = path.join(root.root, 'documents');
    const target = path.join(directory, 'device.json');
    const syncKinds = [];
    const openModes = [];
    const chmodModes = [];
    const base = fs.promises;
    const tracingFs = {
      ...base,
      open: async (file, flags, mode) => {
        openModes.push({ file, flags, mode });
        const handle = await base.open(file, flags, mode);
        return {
          writeFile: (...args) => handle.writeFile(...args),
          sync: async () => {
            syncKinds.push(file === directory ? 'directory' : 'file');
            return handle.sync();
          },
          close: () => handle.close()
        };
      },
      chmod: async (file, mode) => {
        chmodModes.push({ file, mode });
        return base.chmod(file, mode);
      }
    };
    await atomicWriteJson(tracingFs, target, { ok: true }, {
      platform: 'darwin',
      hostPlatform: process.platform
    });
    assert.deepEqual(syncKinds, ['file', 'directory']);
    assert.equal(openModes.find(({ flags }) => flags === 'wx')?.mode, 0o600);
    assert.deepEqual(chmodModes.map(({ mode }) => mode), [0o600]);
    // Windows does not expose POSIX mode bits, but the macOS production path
    // must continue to enforce the private file mode on a POSIX filesystem.
    if (process.platform === 'darwin') assert.equal((await fs.promises.stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.promises.readdir(directory), ['device.json']);

    const old = await fs.promises.readFile(target, 'utf8');
    const failingFs = {
      ...base,
      rename: async () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); }
    };
    await assert.rejects(
      atomicWriteJson(failingFs, target, { replaced: true }, { platform: 'darwin' }),
      { code: 'EIO' }
    );
    assert.equal(await fs.promises.readFile(target, 'utf8'), old);
    assert.deepEqual(await fs.promises.readdir(directory), ['device.json']);

    const unsupportedDirectoryFs = {
      ...base,
      open: async (file, flags, mode) => {
        const handle = await base.open(file, flags, mode);
        if (file !== directory) return handle;
        return {
          sync: async () => { throw Object.assign(new Error('directory sync unsupported'), { code: 'EINVAL' }); },
          close: () => handle.close()
        };
      }
    };
    await assert.rejects(
      atomicWriteJson(unsupportedDirectoryFs, target, { replaced: true }, {
        platform: 'darwin',
        hostPlatform: 'darwin'
      }),
      { code: 'EINVAL' }
    );
  } finally {
    root.cleanup();
  }
});

test('a non-macOS filesystem host can safely downgrade logical macOS directory fsync', async () => {
  const root = makeRoot();
  try {
    const directory = path.join(root.root, 'documents');
    await fs.promises.mkdir(directory, { recursive: true });
    const unsupportedFs = {
      ...fs.promises,
      open: async () => ({
        sync: async () => { throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); },
        close: async () => {}
      })
    };
    assert.deepEqual(
      await syncDirectory(unsupportedFs, directory, 'darwin', 'win32'),
      { durable: false, degraded: true }
    );
  } finally {
    root.cleanup();
  }
});

test('device and subscription revisions stay monotonic across restart and temporary missing files', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const first = storeFor(root.root, 'writer-a');
    const firstDevice = await first.writeDevice(device('mac-a', 1));
    const devicePath = path.join(first.status().devicesRoot, deviceFilenameForId('mac-a'));
    await fs.promises.unlink(devicePath);
    const restarted = storeFor(root.root, 'writer-a');
    const secondDevice = await restarted.writeDevice(device('mac-a', 2));
    assert.equal(firstDevice.revision, 1);
    assert.equal(secondDevice.revision, 2);

    const firstSubscription = await first.writeSubscriptions([subscription('one')]);
    const subscriptionPath = path.join(first.status().subscriptionsRoot, writerFilenameForId('writer-a'));
    await fs.promises.unlink(subscriptionPath);
    const secondSubscription = await restarted.writeSubscriptions([subscription('two')]);
    assert.equal(firstSubscription.written.revision.counter, 1);
    assert.equal(secondSubscription.written.revision.counter, 2);
  } finally {
    root.cleanup();
  }
});

test('a restart with an invisible subscription snapshot rejects a stale base instead of resetting it', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const first = storeFor(root.root, 'writer-a');
    const snapshot = await first.writeSubscriptions([subscription('one')]);
    await fs.promises.unlink(path.join(first.status().subscriptionsRoot, writerFilenameForId('writer-a')));
    const restarted = storeFor(root.root, 'writer-a');
    await assert.rejects(
      () => restarted.writeSubscriptions([subscription('stale')], { baseRevision: snapshot.revisionToken }),
      { code: 'stale_write' }
    );
  } finally {
    root.cleanup();
  }
});

test('malformed deletion documents never hide a valid device', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    const store = storeFor(root.root, 'writer-a');
    await store.writeDevice(device('mac-a', 7));
    const deletionPath = path.join(store.status().deletionsRoot, writerFilenameForId('writer-b'));
    await fs.promises.writeFile(deletionPath, JSON.stringify({
      schemaVersion: 1,
      kind: 'device-deletions',
      writerId: 'writer-b',
      revision: { counter: 1, writerId: 'writer-b' },
      deletions: [{ targetDeviceId: 'mac-a', targetDeviceRevision: -1 }]
    }));
    const discovered = await store.discoverDevices();
    assert.equal(discovered.records.length, 1);
    assert.equal(discovered.records[0].deviceId, 'mac-a');
  } finally {
    root.cleanup();
  }
});

test('identical semantic device snapshots skip writes while meaningful changes and heartbeat advance', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root.root, 'CloudDocs'), { recursive: true });
    let clock = Date.parse('2026-09-06T10:00:00.000Z');
    const store = createIcloudSyncStore({
      platform: 'darwin',
      home: root.root,
      cloudDocsRoot: path.join(root.root, 'CloudDocs'),
      writerId: 'writer-a',
      staleAfterMs: 10_000,
      now: () => clock
    });
    const initial = device('mac-a', 1);
    const first = await store.writeDevice(initial);
    const target = path.join(store.status().devicesRoot, deviceFilenameForId('mac-a'));
    const firstRaw = JSON.parse(await fs.promises.readFile(target, 'utf8'));

    clock += 1_000;
    const freshnessOnly = {
      ...initial,
      updatedAt: new Date(clock).toISOString(),
      receivedAt: new Date(clock).toISOString()
    };
    const skipped = await store.writeDevice(freshnessOnly);
    const skippedRaw = JSON.parse(await fs.promises.readFile(target, 'utf8'));
    assert.equal(first.revision, 1);
    assert.equal(skipped.skipped, true);
    assert.equal(skippedRaw.revision, firstRaw.revision);

    clock += 100;
    const meaningful = { ...freshnessOnly, today: { ...freshnessOnly.today, totalTokens: 2, clients: { codex: 2 } } };
    const changed = await store.writeDevice(meaningful);
    assert.equal(changed.skipped, false);
    assert.equal(changed.revision, 2);

    clock += 5_001;
    const heartbeat = {
      ...meaningful,
      updatedAt: new Date(clock).toISOString(),
      receivedAt: new Date(clock).toISOString()
    };
    const heartbeated = await store.writeDevice(heartbeat);
    assert.equal(heartbeated.skipped, false);
    assert.equal(heartbeated.revision, 3);
    assert.equal(heartbeated.record.updatedAt, heartbeat.updatedAt);
  } finally {
    root.cleanup();
  }
});
