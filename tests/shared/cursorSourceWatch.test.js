'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { cursorDesktopWatchRoots } = require('../../src/shared/providers/cursor/desktopState');
const { SYNC_MIN_INTERVAL_MS, SYNC_SOURCE_EVENT_MIN_INTERVAL_MS } = require('../../src/shared/selfSyncThrottle');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');
const { installInProcessWatchHost } = require('../helpers/watchHost');

installSourceEnvGuard(test);
installInProcessWatchHost(test);

const collectorPath = require.resolve('../../src/shared/collector');

function fixture(t, { platform = process.platform, env = {} } = {}) {
  const homeDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-cursor-watch-'));
  const options = { homeDir, platform, env };
  const roots = cursorDesktopWatchRoots(options);
  for (const root of roots) fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  delete require.cache[collectorPath];
  return { ...options, roots, collector: require(collectorPath) };
}

async function waitFor(check) {
  const deadline = performance.now() + 4000;
  await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(); }
      else if (performance.now() >= deadline) {
        clearInterval(timer);
        reject(new Error('timed out waiting for collector'));
      }
    }, 10);
  });
}

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`Cursor ${platform} desktop sources are bounded and the generated cache stays unwatched`, (t) => {
    const f = fixture(t, { platform });
    const cache = path.join(f.homeDir, '.config', 'tokscale', 'cursor-cache');
    fs.mkdirSync(cache, { recursive: true });
    assert.deepEqual(f.collector.watchPathsForClients('cursor', f), f.roots);
    assert.deepEqual(f.collector.watchPathsForClients('claude', f), []);
    const ignored = f.collector.watchIgnoreMatcher('cursor', f);
    for (const root of f.roots) {
      assert.equal(ignored(root), false);
      assert.equal(ignored(path.join(root, 'state.vscdb')), false);
      assert.equal(ignored(path.join(root, 'state.vscdb-wal')), false);
      for (const relative of ['state.vscdb-shm', 'state.vscdb.backup', 'storage.json',
        'conversation-search.db', 'extension', path.join('extension', 'state.vscdb')]) {
        assert.equal(ignored(path.join(root, relative)), true, relative);
      }
    }
    assert.equal(f.collector.watchIgnoreMatcher('claude', f), undefined);
    assert.deepEqual(f.collector.watchPathsForClients('cursor', {
      ...f, customScanPaths: { cursor: [cache] }
    }), f.roots, 'unsupported Cursor custom paths cannot re-enable the generated cache watcher');
  });
}

test('Cursor resolves both Windows desktop stores and tolerates a missing desktop', (t) => {
  const f = fixture(t, { platform: 'win32' });
  const relocated = path.join(f.homeDir, 'relocated-appdata');
  const options = { ...f, env: { APPDATA: relocated } };
  const relocatedRoot = path.join(relocated, 'Cursor', 'User', 'globalStorage');
  assert.deepEqual(cursorDesktopWatchRoots(options), [relocatedRoot, ...f.roots]);
  assert.deepEqual(f.collector.watchPathsForClients('cursor', options), f.roots);
  fs.mkdirSync(relocatedRoot, { recursive: true });
  assert.deepEqual(f.collector.watchPathsForClients('cursor', options), [relocatedRoot, ...f.roots]);
  assert.deepEqual(cursorDesktopWatchRoots({ ...f, env: {
    APPDATA: path.join(f.homeDir, 'AppData', 'Roaming')
  } }), f.roots, 'duplicate candidates do not duplicate watch roots');
  fs.rmSync(relocatedRoot, { recursive: true });
  fs.rmSync(f.roots[0], { recursive: true });
  assert.deepEqual(f.collector.watchPathsForClients('cursor', options), []);
});

test('native Cursor WAL writes arrive while read-only SQLite SHM changes stay ignored', async (t) => {
  const f = fixture(t);
  const databasePath = path.join(f.roots[0], 'state.vscdb');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE fixture (value INTEGER)');
  const watcher = f.collector.openWatch(require('chokidar'), {
    dirs: f.roots, clients: 'cursor', cursorDesktopRoots: f.roots, usePolling: false
  });
  const events = [];
  watcher.on('all', (_event, file) => events.push(path.basename(file)));
  try {
    await new Promise((resolve, reject) => {
      watcher.once('ready', resolve);
      watcher.once('error', reject);
    });
    // ready can precede native-stream delivery on loaded CI runners. Retry a
    // real committed write until delivery, without asserting platform latency.
    const waitForWalWrite = () => new Promise((resolve, reject) => {
      let retry;
      let finished = false;
      const deadline = setTimeout(() => finish(new Error('no native Cursor WAL event')), 45_000);
      const onEvent = (_event, file) => { if (path.basename(file) === 'state.vscdb-wal') finish(); };
      function finish(error) {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        clearInterval(retry);
        watcher.off('all', onEvent);
        watcher.off('error', finish);
        if (error) reject(error); else resolve();
      }
      const write = () => {
        try { db.exec('INSERT INTO fixture VALUES (1)'); }
        catch (error) { finish(error); }
      };
      watcher.on('all', onEvent);
      watcher.on('error', finish);
      retry = setInterval(write, 1500);
      write();
    });
    await waitForWalWrite();
    const shmBeforeRead = fs.readFileSync(databasePath + '-shm');
    const readOnly = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.ok(readOnly.prepare('SELECT COUNT(*) AS count FROM fixture').get().count > 0); }
    finally { readOnly.close(); }
    if (process.platform === 'darwin') {
      assert.notDeepEqual(fs.readFileSync(databasePath + '-shm'), shmBeforeRead,
        'the read-only query really modified the wal-index on macOS');
    }
    // Even a recreated wal-index cannot enter collection. Also churn an
    // unrelated sibling after the stream has proved live.
    fs.utimesSync(databasePath + '-shm', new Date(), new Date());
    fs.writeFileSync(path.join(f.roots[0], 'storage.json'), '{}');
    // A fresh allowed write is a positive delivery barrier after the excluded
    // writes, including awaitWriteFinish's stability window. Check registration
    // as well as delivery so delayed forbidden events cannot give a false pass.
    await waitForWalWrite();
    const watchedFiles = Object.values(watcher.getWatched()).flat();
    assert.equal(watchedFiles.includes('state.vscdb-shm'), false);
    assert.equal(watchedFiles.includes('storage.json'), false);
    assert.ok(events.includes('state.vscdb-wal'));
    assert.equal(events.includes('state.vscdb-shm'), false);
    assert.equal(events.includes('storage.json'), false);
  } finally {
    await watcher.close();
    db.close();
  }
});

for (const scenario of ['completed', 'generating', 'windows-candidates', 'windows-title-only', 'history-completed', 'history-generating']) {
  test('Cursor collector retains and resolves boundaries across collections: ' + scenario, async (t) => {
    const databases = [];
    // Close handles before fixture() removes the temporary Windows stores.
    t.after(() => databases.forEach((db) => db.close()));
    const windows = scenario.startsWith('windows-');
    const historyOnly = scenario.startsWith('history-');
    const completed = scenario.endsWith('completed');
    const f = fixture(t, { platform: windows ? 'win32' : 'linux' });
    const auth = require('../../src/shared/providers/cursor/auth');
    t.mock.method(auth, 'runCursorSync', async () => {});
    const now = Date.now();
    const old = new Date(now - 3600_000).toISOString();
    const stores = windows
      ? [path.join(f.homeDir, 'relocated', 'Cursor', 'User', 'globalStorage'), ...f.roots] : f.roots;
    for (const root of stores) {
      fs.mkdirSync(root, { recursive: true });
      const db = new DatabaseSync(path.join(root, 'state.vscdb'));
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)');
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
      db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
      databases.push(db);
    }
    if (scenario === 'windows-title-only') {
      databases[0].prepare('INSERT INTO composerHeaders VALUES (?, ?)').run('s1', JSON.stringify({ name: 'Preferred title' }));
    }
    const active = databases.at(-1);
    const put = active.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)');
    const putHeader = active.prepare('INSERT OR REPLACE INTO composerHeaders VALUES (?, ?)');
    putHeader.run('s1', JSON.stringify({ name: 'Original title', lastUpdatedAt: now }));
    put.run('composerData:s1', JSON.stringify({ composerId: 's1', status: completed ? 'completed' : 'generating', lastUpdatedAt: now }));
    let fail = false;
    const sqlite = { DatabaseSync: class {
      constructor(...args) { this.db = new DatabaseSync(...args); }
      exec(...args) { return this.db.exec(...args); }
      prepare(sql) {
        if (fail && sql.includes('FROM cursorDiskKV')) throw new Error('SQLITE_BUSY');
        return this.db.prepare(sql);
      }
      close() { this.db.close(); }
    } };
    let removed = false;
    const options = {
      clients: 'cursor', homeDir: f.homeDir, allTimeSince: '2024-01-01', deviceId: 'fixture', agentVersion: 'test',
      now: new Date(now), limitsEnabled: false, historyEnabled: false, projectsEnabled: false,
      onProgress() {},
      sessionMetadataDeps: { sqlite, platform: f.platform, env: windows ? { APPDATA: path.join(f.homeDir, 'relocated') } : {}, cursorTitleCache: new Map(), now },
      runTokscale: async ({ flags }) => ({ entries: [{ client: 'cursor', sessionId: removed || (historyOnly && flags.includes('--today')) ? 'today-session' : 's1', model: 'fixture', input: 123, cost: 0.45, lastUsedAt: completed ? new Date(now).toISOString() : old }] }),
      collectWslUsage: async () => ({ bundle: { today: {}, month: {}, allTime: {} }, detected: [] })
    };
    const { sessionActivityState } = require('../../src/shared/sessionLive');
    const expected = completed ? 'ended' : 'running';
    const periods = historyOnly ? ['month', 'allTime'] : ['today', 'month', 'allTime'];
    const first = await f.collector.collectUsageOnce(options);
    if (historyOnly) assert.equal(first.today.sessions['cursor:s1'], undefined);
    for (const period of periods) assert.equal(sessionActivityState(first[period].sessions['cursor:s1'], now), expected);
    putHeader.run('s1', JSON.stringify({ name: 'Updated title', lastUpdatedAt: now }));
    fail = true;
    const second = await f.collector.collectUsageOnce(options);
    for (const period of periods) {
      const row = second[period].sessions['cursor:s1'];
      assert.equal(sessionActivityState(row, now), expected, 'new collection must retain the last successful state');
      assert.equal(row.title, scenario === 'windows-title-only' ? 'Preferred title' : 'Updated title');
      assert.equal(row.totalTokens, first[period].sessions['cursor:s1'].totalTokens);
      assert.equal(row.costUsd, first[period].sessions['cursor:s1'].costUsd);
    }
    fail = false;
    put.run('composerData:s1', JSON.stringify({ composerId: 's1', status: 'none' }));
    const third = await f.collector.collectUsageOnce(options);
    for (const period of periods) {
      assert.equal(third[period].sessions['cursor:s1'].turnEnded, undefined, 'successful unknown state clears retained boundary');
      assert.equal(sessionActivityState(third[period].sessions['cursor:s1'], now), completed ? 'running' : 'idle');
    }
    if (historyOnly) {
      // No further WAL change: a complete scan must still prune an absent id.
      removed = true;
      await f.collector.collectUsageOnce(options);
      for (const cached of options.sessionMetadataDeps.cursorTitleCache.values()) {
        assert.equal(cached.turnEnds.has('s1'), false);
        assert.equal(cached.turnRetries.has('s1'), false);
      }
    }
  });
}

function runtimeFixture(t, { overlappingRoot = false } = {}) {
  const f = fixture(t);
  const chokidar = require('chokidar');
  const cursorAuth = require('../../src/shared/providers/cursor/auth');
  const originalWatch = chokidar.watch;
  const originalSync = cursorAuth.runCursorSync;
  const originalNow = Date.now;
  const startedAt = originalNow();
  let now = startedAt;
  Date.now = () => now;
  let watcherConfig;
  let emit;
  chokidar.watch = (dirs, options) => {
    watcherConfig = { dirs, ...options };
    const watcher = {
      on(event, callback) { if (event === 'all') emit = callback; return watcher; },
      close() {}
    };
    return watcher;
  };
  const updates = [];
  const operations = [];
  let syncCalls = 0;
  let cursorTokens = 10;
  let failNext = false;
  cursorAuth.runCursorSync = async () => {
    operations.push({ kind: 'sync' });
    syncCalls += 1;
    if (failNext) { failNext = false; throw new Error('fixture sync failed'); }
    cursorTokens = syncCalls * 10;
  };
  const handle = f.collector.startCollector({
    ...f,
    ...(overlappingRoot ? { customScanPaths: { claude: f.roots } } : {}),
    clients: 'claude,cursor', allTimeSince: '2024-01-01',
    deviceId: 'cursor-source-fixture', agentVersion: 'test',
    intervalMs: 60 * 60 * 1000, watchEnabled: true, watchUsePolling: false,
    watchTriggersCollection: true, watchDebounceMs: 10,
    limitsEnabled: false, historyEnabled: false, anchorPersistenceEnabled: false,
    runTokscale: async (input) => {
      operations.push({ kind: 'scan', clients: input.clients, flags: input.flags });
      return { entries: input.clients.split(',').map((client) => ({
        client, sessionId: `${client}-session`, model: 'fixture-model',
        input: client === 'cursor' ? cursorTokens : 50, output: 0, cost: 0
      })) };
    },
    onUpdate: (summary, reason) => updates.push({ summary, reason })
  });
  t.after(() => {
    handle.stop();
    chokidar.watch = originalWatch;
    cursorAuth.runCursorSync = originalSync;
    Date.now = originalNow;
    delete require.cache[collectorPath];
  });
  return {
    ...f, handle, updates, operations,
    event: (name, relative) => emit(name, path.join(f.roots[0], relative)),
    at: (offset) => { now = startedAt + offset; },
    failNextSync: () => { failNext = true; },
    get syncCalls() { return syncCalls; },
    get watcherConfig() { return watcherConfig; }
  };
}

test('Cursor WAL writes retain a targeted cloud-sync catch-up and exact period deltas', async (t) => {
  const f = runtimeFixture(t);
  await waitFor(() => f.updates.length === 1);
  assert.equal(f.syncCalls, 1);
  assert.deepEqual(f.watcherConfig.dirs, f.roots);
  assert.equal(f.watcherConfig.ignored(path.join(f.roots[0], 'extension')), true,
    'the host uses the same resolved source roots as the collector');

  f.at(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS - 300);
  for (let i = 0; i < 10; i += 1) {
    f.event('change', 'state.vscdb');
    f.event('change', 'state.vscdb-wal');
  }
  await waitFor(() => f.updates.length === 2);
  assert.equal(f.syncCalls, 1, 'dense writes inside the source floor do not spam syncs');
  assert.deepEqual(f.operations.at(-1), { kind: 'scan', clients: 'cursor', flags: ['--today'] });
  for (const period of ['today', 'month', 'allTime']) {
    assert.deepEqual(f.updates[1].summary[period], f.updates[0].summary[period],
      'a throttled source event retains the cached totals until its catch-up sync');
  }

  f.at(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS + 1000);
  await waitFor(() => f.updates.length === 3);
  assert.equal(f.syncCalls, 2, 'the deferred event syncs without another filesystem event');
  assert.deepEqual(f.operations.slice(-2), [
    { kind: 'sync' }, { kind: 'scan', clients: 'cursor', flags: ['--today'] }
  ], 'cloud sync finishes before scanning its updated cache');
  const summary = f.updates.at(-1).summary;
  for (const period of ['today', 'month', 'allTime']) {
    assert.equal(summary[period].clients.cursor, 20, period);
    assert.equal(summary[period].clients.claude, 50, 'unrelated partitions stay intact');
    assert.equal(summary[period].totalTokens, 70, period);
  }

  const count = f.operations.length;
  f.at(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS * 3);
  f.event('change', 'state.vscdb-shm');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.operations.length, count, 'our SQLite reads cannot trigger more scans or cloud syncs');
  f.event('change', 'state.vscdb');
  await waitFor(() => f.updates.length === 4);
  assert.equal(f.syncCalls, 3, 'database checkpoint writes also trigger targeted sync');
});

test('an overlapping recursive client root cannot turn extension data into a Cursor cloud-sync source', async (t) => {
  const f = runtimeFixture(t, { overlappingRoot: true });
  await waitFor(() => f.updates.length === 1);
  assert.equal(f.watcherConfig.ignored(path.join(f.roots[0], 'extension', 'state.vscdb')), false,
    'the recursive client still gets its input');
  f.at(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS * 3);
  f.event('change', path.join('extension', 'state.vscdb'));
  await waitFor(() => f.updates.length === 2);
  assert.equal(f.syncCalls, 1, 'nested databases do not request a Cursor cloud sync');
});

test('Cursor desktop titles refresh while cloud usage sync is throttled', async (t) => {
  const f = runtimeFixture(t);
  await waitFor(() => f.updates.length === 1);
  const db = new DatabaseSync(path.join(f.roots[0], 'state.vscdb'));
  try {
    db.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO composerHeaders (composerId, value) VALUES (?, ?)').run(
      'cursor-session', JSON.stringify({ name: 'Updated desktop title' })
    );
  } finally { db.close(); }

  f.at(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS - 300);
  f.event('change', 'state.vscdb');
  await waitFor(() => f.updates.length === 2);
  assert.equal(f.syncCalls, 1, 'local titles do not bypass the cloud-sync floor');
  const before = f.updates[0].summary;
  const after = f.updates[1].summary;
  assert.equal(Object.values(after.today.sessions).find((session) => session.client === 'cursor').title,
    'Updated desktop title');
  for (const period of ['today', 'month', 'allTime']) {
    assert.deepEqual(after[period].clients, before[period].clients);
    assert.equal(after[period].totalTokens, before[period].totalTokens);
  }
});

test('Cursor WAL start and finish update session state inside the cloud-sync floor', async (t) => {
  const f = runtimeFixture(t);
  await waitFor(() => f.updates.length === 1);
  const db = new DatabaseSync(path.join(f.roots[0], 'state.vscdb'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const put = db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)');
  const { sessionActivityState } = require('../../src/shared/sessionLive');
  const before = f.updates[0].summary;
  try {
    for (const [index, status] of ['generating', 'completed', 'aborted'].entries()) {
      f.at(1000 + index * 1000);
      put.run('composerData:cursor-session', JSON.stringify({ composerId: 'cursor-session', status, lastUpdatedAt: Date.now() }));
      f.event('change', 'state.vscdb-wal');
      await waitFor(() => f.updates.length === index + 2);
      const after = f.updates.at(-1).summary;
      for (const name of ['today', 'month', 'allTime']) {
        const row = Object.values(after[name].sessions).find((session) => session.client === 'cursor');
        assert.equal(row.turnEnded, status !== 'generating', `${name} receives the latest boundary`);
        assert.equal(sessionActivityState(row) === 'running', status === 'generating', `${name} spinner follows the boundary`);
        assert.deepEqual(after[name].clients, before[name].clients);
        assert.equal(after[name].totalTokens, before[name].totalTokens);
        assert.equal(after[name].costUsd, before[name].costUsd);
      }
      assert.equal(f.syncCalls, 1, 'state reads do not force another cloud request');
    }
  } finally { db.close(); }
});

test('a failed Cursor source sync keeps its event on the failure backoff', async (t) => {
  const f = runtimeFixture(t);
  await waitFor(() => f.updates.length === 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.at(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS + 1000);
  f.failNextSync();
  f.event('change', 'state.vscdb-wal');
  t.mock.timers.tick(10);
  await waitFor(() => f.updates.length === 2);
  assert.equal(f.syncCalls, 2);

  f.at(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS * 3);
  f.event('change', 'state.vscdb-wal');
  t.mock.timers.tick(10);
  await waitFor(() => f.updates.length === 3);
  assert.equal(f.syncCalls, 2, 'new source activity cannot bypass failure backoff');
  f.at(SYNC_MIN_INTERVAL_MS * 2);
  t.mock.timers.tick(SYNC_MIN_INTERVAL_MS);
  t.mock.timers.reset();
  await waitFor(() => f.syncCalls === 3 && f.updates.length >= 4);
  assert.deepEqual(f.operations.slice(-2), [
    { kind: 'sync' }, { kind: 'scan', clients: 'cursor', flags: ['--today'] }
  ]);
});

test('manual Cursor refresh satisfies a pending source event and stop cancels catch-up', async (t) => {
  const f = runtimeFixture(t);
  await waitFor(() => f.updates.length === 1);
  f.at(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS - 300);
  f.event('change', 'state.vscdb-wal');
  await waitFor(() => f.updates.length === 2);
  await f.handle.tick('manual', { forceSelfSync: ['cursor'] });
  assert.equal(f.syncCalls, 2);
  f.at(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS * 3);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.syncCalls, 2, 'manual sync consumed the pending event');

  f.event('change', 'state.vscdb-wal');
  f.handle.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.syncCalls, 2, 'a stopped runtime cannot sync again');
});
