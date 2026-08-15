'use strict';

// Guards against the runaway-collection loop from issue #15: watching our own
// sync-cache dirs re-triggered ticks forever, and each tick spawned concurrent
// tokscale scans plus an unconditional antigravity sync.

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { emptyPeriod } = require('../../src/shared/usage');
const {
  clampTimerDelayMs, SYNC_MIN_INTERVAL_MS, SYNC_SOURCE_EVENT_MIN_INTERVAL_MS
} = require('../../src/shared/selfSyncThrottle');

const { installSourceEnvGuard } = require('../helpers/sourceEnv');

const collectorPath = require.resolve('../../src/shared/collector');

installSourceEnvGuard(test);

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

// realpath the base: a real os.homedir() is already canonical, but os.tmpdir()
// is an 8.3 short path on the Windows CI runner. Without this the fixture home
// differs from the canonical root the collector watches, so the synthetic event
// paths below would stop mapping back to their client on Windows only.
function withTmpHome(prepare) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'token-monitor-home-'));
  for (const dir of prepare) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  return tmp;
}

function recordingSpawn(calls) {
  return (_bin, args) => {
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
}

function wslBundleWith(client, tokens) {
  const period = () => {
    const value = emptyPeriod();
    value.totalTokens = tokens;
    value.clients = { [client]: tokens };
    return value;
  };
  return { today: period(), month: period(), allTime: period() };
}

test('watchPathsForClients excludes the tokscale cache dirs our own syncs write', () => {
  const tmp = withTmpHome([
    path.join('.claude', 'projects'),
    path.join('.config', 'tokscale', 'cursor-cache'),
    path.join('.config', 'tokscale', 'antigravity-cache')
  ]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { watchPathsForClients } = freshCollector();
    const dirs = watchPathsForClients('claude,cursor,antigravity');
    assert.ok(dirs.includes(path.join(tmp, '.claude', 'projects')));
    assert.equal(dirs.filter((dir) => dir.includes(path.join('.config', 'tokscale'))).length, 0);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchPathsForClients watches both MiMo Code roots tokscale scans', () => {
  // Tokscale unions the XDG data dir with orca's hook-sandbox copy, and
  // that copy can hold sessions the XDG one is missing. Watching only XDG would
  // leave an orca-driven install without the seconds-level refresh.
  const orcaRoot = path.join('Library', 'Application Support', 'orca', 'mimocode-hooks', 'shared', 'data');
  const tmp = withTmpHome([path.join('.local', 'share', 'mimocode'), orcaRoot]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { watchPathsForClients } = freshCollector();
    const dirs = watchPathsForClients('micode');
    assert.ok(dirs.includes(path.join(tmp, '.local', 'share', 'mimocode')));
    assert.ok(dirs.includes(path.join(tmp, orcaRoot)));
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Command Code watches its transcript tree and prunes non-transcript events', () => {
  const workspace = path.join('.commandcode', 'projects', 'workspace');
  const tmp = withTmpHome([workspace]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { watchPathsForClients, watchIgnoreMatcher } = freshCollector();
    const projects = path.join(tmp, '.commandcode', 'projects');
    const workspaceDir = path.join(tmp, workspace);
    const transcript = path.join(workspaceDir, 'session.jsonl');
    const checkpoint = path.join(workspaceDir, 'session.checkpoints.jsonl');
    const metadata = path.join(workspaceDir, 'metadata.json');
    fs.writeFileSync(transcript, '');
    fs.writeFileSync(checkpoint, '');
    fs.writeFileSync(metadata, '');

    assert.deepEqual(watchPathsForClients('commandcode'), [projects]);
    const ignored = watchIgnoreMatcher('commandcode');
    assert.equal(ignored(projects), false);
    assert.equal(ignored(workspaceDir), false);
    assert.equal(ignored(transcript), false);
    assert.equal(ignored(checkpoint), true);
    assert.equal(ignored(metadata), true);
    assert.equal(ignored(path.join(workspaceDir, 'removed.jsonl')), false);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher keeps every direct Tokscale MiMo database variant but prunes logs', () => {
  const orcaRoot = path.join('Library', 'Application Support', 'orca', 'mimocode-hooks', 'shared', 'data');
  const tmp = withTmpHome([path.join('.local', 'share', 'mimocode'), orcaRoot]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('micode');
    const roots = [
      path.join(tmp, '.local', 'share', 'mimocode'),
      path.join(tmp, orcaRoot)
    ];
    const dbFamily = [
      'mimocode.db',
      'mimocode.db-wal',
      'mimocode.db-shm',
      'mimocode-nightly.db',
      'mimocode-nightly.db-wal',
      'mimocode-nightly.db-shm'
    ];
    for (const root of roots) {
      assert.equal(ignored(root), false);
      for (const name of dbFamily) assert.equal(ignored(path.join(root, name)), false);
      assert.equal(ignored(path.join(root, 'log')), true);
      assert.equal(ignored(path.join(root, 'log', 'mimocode-nightly.db')), true);
      assert.equal(ignored(path.join(root, 'other.txt')), true);
    }
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher bounds OpenCode to its database family and legacy message source', () => {
  const root = path.join('.local', 'share', 'opencode');
  const tmp = withTmpHome([
    root,
    path.join(root, 'storage', 'message'),
    path.join(root, 'storage', 'message', 'session-1'),
    path.join(root, 'storage', 'session_diff'),
    path.join(root, 'log'),
    path.join(root, 'snapshot')
  ]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { watchIgnoreMatcher, watchPathsForClients } = freshCollector();
    const ignored = watchIgnoreMatcher('opencode');
    const dataRoot = path.join(tmp, root);
    assert.deepEqual(watchPathsForClients('opencode'), [dataRoot]);
    assert.equal(typeof ignored, 'function');

    const kept = [
      dataRoot,
      path.join(dataRoot, 'opencode.db'),
      path.join(dataRoot, 'opencode.db-wal'),
      path.join(dataRoot, 'opencode.db-shm'),
      path.join(dataRoot, 'opencode-stable.db'),
      path.join(dataRoot, 'opencode-nightly.db-wal'),
      path.join(dataRoot, 'storage'),
      path.join(dataRoot, 'storage', 'message'),
      path.join(dataRoot, 'storage', 'message', 'session-1'),
      path.join(dataRoot, 'storage', 'message', 'session-1', 'msg.json'),
      path.join(dataRoot, 'storage', 'message', 'legacy.json')
    ];
    for (const target of kept) assert.equal(ignored(target), false, target);

    const pruned = [
      path.join(dataRoot, 'account.json'),
      path.join(dataRoot, 'other.db'),
      path.join(dataRoot, 'opencode.db-journal'),
      path.join(dataRoot, 'log'),
      path.join(dataRoot, 'log', 'runtime.log'),
      path.join(dataRoot, 'snapshot'),
      path.join(dataRoot, 'storage', 'session_diff'),
      path.join(dataRoot, 'storage', 'message', 'session-1', 'nested'),
      path.join(dataRoot, 'storage', 'message', 'session-1', 'nested', 'msg.json'),
      path.join(dataRoot, 'storage', 'message', 'session-1', 'not-json.txt')
    ];
    for (const target of pruned) assert.equal(ignored(target), true, target);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher bounds Kiro CLI, Zed, and CodeBuddy extension roots', () => {
  const codebuddyLogs = process.platform === 'win32'
    ? path.join('AppData', 'Local', 'CodeBuddyExtension', 'Logs')
    : process.platform === 'darwin'
      ? path.join('Library', 'Application Support', 'CodeBuddyExtension', 'Logs')
      : path.join('.local', 'share', 'CodeBuddyExtension', 'Logs');
  const tmp = withTmpHome([
    path.join('.local', 'share', 'kiro-cli'),
    path.join('.local', 'share', 'zed', 'threads'),
    codebuddyLogs
  ]);
  const originalHomedir = os.homedir;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  os.homedir = () => tmp;
  try {
    if (process.platform === 'win32') {
      process.env.LOCALAPPDATA = path.join(tmp, 'AppData', 'Local');
    }
    const { watchIgnoreMatcher, watchPathsForClients } = freshCollector();
    const ignored = watchIgnoreMatcher('kiro,zed,codebuddy');
    const kiroRoot = path.join(tmp, '.local', 'share', 'kiro-cli');
    const zedRoot = path.join(tmp, '.local', 'share', 'zed', 'threads');
    const codebuddyRoot = path.join(tmp, codebuddyLogs);
    assert.ok(watchPathsForClients('kiro,zed,codebuddy').includes(kiroRoot));
    assert.ok(watchPathsForClients('kiro,zed,codebuddy').includes(zedRoot));
    assert.ok(watchPathsForClients('kiro,zed,codebuddy').includes(codebuddyRoot));

    assert.equal(ignored(kiroRoot), false);
    assert.equal(ignored(path.join(kiroRoot, 'data.sqlite3')), false);
    assert.equal(ignored(path.join(kiroRoot, 'data.sqlite3-wal')), false);
    assert.equal(ignored(path.join(kiroRoot, 'data.sqlite3-shm')), false);
    assert.equal(ignored(path.join(kiroRoot, 'logs')), true);
    assert.equal(ignored(path.join(kiroRoot, 'logs', 'runtime.log')), true);

    assert.equal(ignored(zedRoot), false);
    assert.equal(ignored(path.join(zedRoot, 'threads.db')), false);
    assert.equal(ignored(path.join(zedRoot, 'threads.db-wal')), false);
    assert.equal(ignored(path.join(zedRoot, 'threads.db-shm')), false);
    assert.equal(ignored(path.join(zedRoot, 'cache')), true);

    assert.equal(ignored(codebuddyRoot), false);
    assert.equal(ignored(path.join(codebuddyRoot, 'CodeBuddyIDE')), false);
    assert.equal(ignored(path.join(codebuddyRoot, 'CodeBuddyIDE', 'session.log')), false);
    assert.equal(ignored(path.join(codebuddyRoot, 'VSCode', 'extension.log')), false);
    assert.equal(ignored(path.join(codebuddyRoot, 'Other', 'runtime.log')), true);
  } finally {
    os.homedir = originalHomedir;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchPathsForClients watches Antigravity source and CLI data but not the sync cache', () => {
  // The IDE source roots are read by `antigravity sync`, while the CLI writes
  // parse-local SQLite that we do not touch. Both are safe watch inputs; the
  // normalized cache remains excluded to avoid the issue #15 loop.
  const tmp = withTmpHome([
    path.join('.gemini', 'antigravity', 'brain'),
    path.join('.gemini', 'antigravity-ide', 'conversations'),
    path.join('.gemini', 'antigravity-cli', 'conversations'),
    path.join('.config', 'tokscale', 'antigravity-cache')
  ]);
  const originalHomedir = os.homedir;
  const previousGeminiHome = process.env.GEMINI_CLI_HOME;
  os.homedir = () => tmp;
  try {
    delete process.env.GEMINI_CLI_HOME;
    const { watchPathsForClients } = freshCollector();
    const dirs = watchPathsForClients('antigravity');
    assert.ok(dirs.includes(path.join(tmp, '.gemini', 'antigravity')));
    assert.ok(dirs.includes(path.join(tmp, '.gemini', 'antigravity-ide')));
    assert.ok(dirs.includes(path.join(tmp, '.gemini', 'antigravity-cli', 'conversations')));
    assert.equal(dirs.filter((dir) => dir.includes(path.join('.config', 'tokscale'))).length, 0);
  } finally {
    os.homedir = originalHomedir;
    if (previousGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = previousGeminiHome;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher bounds Antigravity roots to source and metadata inputs', () => {
  // Top-level names here are the real ones an Antigravity IDE home carries, so
  // the pruned side of the assertion keeps meaning something: builtin/ alone
  // churns more than brain/ does.
  const root = path.join('.gemini', 'antigravity');
  const tmp = withTmpHome([
    path.join(root, 'brain'),
    path.join(root, 'conversations'),
    path.join(root, 'annotations'),
    path.join(root, 'agyhub_summaries_proto.pb'),
    path.join(root, 'builtin'),
    path.join(root, 'crashes'),
    path.join('.config', 'tokscale', 'antigravity-cache')
  ]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('antigravity');
    assert.equal(ignored(path.join(tmp, root)), false);
    assert.equal(ignored(path.join(tmp, root, 'brain')), false);
    assert.equal(ignored(path.join(tmp, root, 'conversations', 'session-a.db-wal')), false);
    assert.equal(ignored(path.join(tmp, root, 'annotations', 'session-a.pbtxt')), false);
    assert.equal(ignored(path.join(tmp, root, 'agyhub_summaries_proto.pb')), false);
    assert.equal(ignored(path.join(tmp, root, 'builtin', 'keep.txt')), true);
    assert.equal(ignored(path.join(tmp, root, 'crashes', 'crash_1.log')), true);
    assert.equal(ignored(path.join(tmp, root, 'antigravity_state.pbtxt')), true);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher watches brain session dirs but never recurses into them', () => {
  // A new session shows up as a new brain/<id> directory, so brain/ itself has
  // to stay watched. Its contents are plans, uploads and screenshots — hundreds
  // of directories per home for a handful of writes a week — and each one costs
  // an inotify descriptor on Linux, which is what pushes the watcher into the
  // sticky polling fallback where the whole tree then gets stat'd every pass.
  const root = path.join('.gemini', 'antigravity');
  const tmp = withTmpHome([path.join(root, 'brain', 'session-a', '.system_generated')]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('antigravity');
    assert.equal(ignored(path.join(tmp, root, 'brain')), false);
    assert.equal(ignored(path.join(tmp, root, 'brain', 'session-a')), false);
    assert.equal(ignored(path.join(tmp, root, 'brain', 'session-a', 'media__1.png')), true);
    assert.equal(ignored(path.join(tmp, root, 'brain', 'session-a', '.system_generated')), true);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Antigravity source events target its umbrella client without watching sync cache', async () => {
  const sourceRoot = path.join('.gemini', 'antigravity');
  const tmp = withTmpHome([
    path.join(sourceRoot, 'brain'),
    path.join('.config', 'tokscale', 'antigravity-cache')
  ]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  let watchedDirs = null;
  let ignored = null;
  chokidar.watch = (dirs, options) => {
    watchedDirs = dirs;
    ignored = options.ignored;
    const watcher = {
      on(event, handler) {
        if (event === 'all') watchHandler = handler;
        return watcher;
      },
      close() {}
    };
    return watcher;
  };

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

  // Pinned to a captured instant, not `originalNow() + offset`: the floor is
  // measured from the startup sync, so letting real time leak into the elapsed
  // would make "inside the floor" depend on how long the startup tick took —
  // flaky on a loaded CI host. waitForCondition runs off performance.now, so
  // freezing Date.now does not stall the polling.
  const originalNow = Date.now;
  const baseNow = originalNow();
  let clockOffsetMs = 0;
  Date.now = () => baseNow + clockOffsetMs;

  let handle = null;
  let syncCalls = 0;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: true,
      watchDebounceMs: 10,
      limitsEnabled: false,
      historyEnabled: false,
      anchorPersistenceEnabled: false,
      runAntigravitySync: async () => { syncCalls += 1; },
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(syncCalls, 1, 'startup sync still runs while the IDE source exists');
    assert.ok(watchedDirs.includes(path.join(tmp, sourceRoot)));
    assert.equal(
      watchedDirs.some((dir) => dir.includes(path.join('.config', 'tokscale'))),
      false,
      'the sync output cache remains outside the watcher'
    );
    assert.equal(ignored(path.join(tmp, sourceRoot, 'brain', 'session-a')), false);
    assert.equal(ignored(path.join(tmp, sourceRoot, 'builtin', 'keep.txt')), true);
    assert.ok(watchHandler, 'watcher handler captured');

    // The floor is shorter than the idle cadence, not absent: `antigravity sync`
    // re-fetches over RPC and rewrites every known session artifact on every run,
    // and the per-turn source file is a SQLite WAL that churns for the whole
    // turn, so an unrationed sync would spawn one of those per quiet gap.
    assert.ok(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS < 60 * 1000);
    clockOffsetMs = SYNC_SOURCE_EVENT_MIN_INTERVAL_MS - 300;
    watchHandler('change', path.join(tmp, sourceRoot, 'annotations', 'session-a.pbtxt'));
    await waitForCondition(() => updates.length === 2);
    assert.equal(syncCalls, 1, 'a source event inside the floor reuses the fresh cache');
    const targeted = calls[calls.length - 1];
    assert.equal(targeted[targeted.indexOf('--client') + 1], 'antigravity,antigravity-cli');
    assert.ok(targeted.includes('--today'));

    // The floor defers that sync, it does not drop it. No second event follows —
    // a turn that ends inside the floor must not sit on stale numbers until the
    // fallback interval, so the catch-up has to fire on its own.
    clockOffsetMs = SYNC_SOURCE_EVENT_MIN_INTERVAL_MS + 1000;
    await waitForCondition(() => syncCalls === 2);
    await waitForCondition(() => updates.length === 3);
    const caughtUp = calls[calls.length - 1];
    assert.equal(caughtUp[caughtUp.indexOf('--client') + 1], 'antigravity,antigravity-cli');
    assert.ok(caughtUp.includes('--today'), 'the catch-up rescans behind the sync it waited for');
  } finally {
    Date.now = originalNow;
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a catch-up that comes due mid-tick keeps its targeted scan scope', async () => {
  // runTick's coalesce state carries the sync selections but not targetClients,
  // so folding the catch-up into an in-flight tick would silently widen it from
  // one client's --today partition to every tracked client's. Two clients here
  // precisely so a widened scan is distinguishable from a targeted one.
  const sourceRoot = path.join('.gemini', 'antigravity');
  const tmp = withTmpHome([path.join(sourceRoot, 'conversations')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => {
    const watcher = {
      on(event, handler) {
        if (event === 'all') watchHandler = handler;
        return watcher;
      },
      close() {}
    };
    return watcher;
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  let holdNextSpawn = null;
  let heldSpawns = 0;
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    const hold = holdNextSpawn;
    holdNextSpawn = null;
    if (hold) heldSpawns += 1;
    Promise.resolve(hold).then(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalNow = Date.now;
  const baseNow = originalNow();
  let clockOffsetMs = 0;
  Date.now = () => baseNow + clockOffsetMs;

  let handle = null;
  let syncCalls = 0;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude,antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 5000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: true,
      watchDebounceMs: 10,
      limitsEnabled: false,
      historyEnabled: false,
      anchorPersistenceEnabled: false,
      runAntigravitySync: async () => { syncCalls += 1; },
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(syncCalls, 1);

    // A source event inside the floor, so the sync is deferred rather than run.
    // The remaining floor becomes the catch-up's real timer delay, so it doubles
    // as the deadline the hold below has to outlive.
    const catchUpDelayMs = 400;
    clockOffsetMs = SYNC_SOURCE_EVENT_MIN_INTERVAL_MS - catchUpDelayMs;
    watchHandler('change', path.join(tmp, sourceRoot, 'conversations', 'session-a.db-wal'));
    const armedAt = performance.now();
    await waitForCondition(() => updates.length === 2);
    assert.equal(syncCalls, 1);

    // Hold a tokscale child open so the tick is provably still in flight when the
    // catch-up comes due. Both halves matter: the latch keeps the tick running so
    // the ordinary drain path is unreachable, and the hold outlives the armed
    // deadline by construction — mocking Date.now does not move a real
    // setTimeout, so releasing early would assert against a callback that had not
    // run yet and prove nothing about the re-arm.
    let releaseInFlight = null;
    holdNextSpawn = new Promise((resolve) => { releaseInFlight = resolve; });
    const inFlight = handle.tick('manual');
    await waitForCondition(() => heldSpawns === 1);
    clockOffsetMs = SYNC_SOURCE_EVENT_MIN_INTERVAL_MS + 1000;
    await waitForCondition(() => performance.now() - armedAt > catchUpDelayMs + 150, 4000);
    assert.equal(syncCalls, 1, 'the catch-up waits rather than folding into the in-flight tick');

    releaseInFlight();
    await inFlight;
    await waitForCondition(() => syncCalls === 2, 4000);
    const caughtUp = calls[calls.length - 1];
    const scanned = caughtUp[caughtUp.indexOf('--client') + 1];
    assert.equal(scanned, 'antigravity,antigravity-cli', 'the catch-up stays targeted');
    assert.equal(scanned.includes('claude'), false, 'and never widens to every tracked client');
  } finally {
    Date.now = originalNow;
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a manual refresh satisfies a deferred source sync instead of adding one', async () => {
  // The user reaches for refresh precisely when the number looks stale, which is
  // when a source event is most likely to still be sitting inside the floor. The
  // forced sync re-reads the IDE from scratch, so the deferred catch-up would be
  // a second full `antigravity sync` for a change already picked up.
  const sourceRoot = path.join('.gemini', 'antigravity');
  const tmp = withTmpHome([path.join(sourceRoot, 'conversations'), path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => {
    const watcher = {
      on(event, handler) {
        if (event === 'all') watchHandler = handler;
        return watcher;
      },
      close() {}
    };
    return watcher;
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  const originalNow = Date.now;
  const baseNow = originalNow();
  let clockOffsetMs = 0;
  Date.now = () => baseNow + clockOffsetMs;

  let handle = null;
  let syncCalls = 0;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: true,
      watchDebounceMs: 10,
      limitsEnabled: false,
      historyEnabled: false,
      anchorPersistenceEnabled: false,
      runAntigravitySync: async () => { syncCalls += 1; },
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(syncCalls, 1);

    clockOffsetMs = SYNC_SOURCE_EVENT_MIN_INTERVAL_MS - 300;
    watchHandler('change', path.join(tmp, sourceRoot, 'conversations', 'session-a.db-wal'));
    await waitForCondition(() => updates.length === 2);
    assert.equal(syncCalls, 1, 'the source event is deferred, not run');

    await handle.tick('manual', { forceSelfSync: true });
    assert.equal(syncCalls, 2, 'the manual refresh syncs immediately');

    // Well past the floor: a still-pending catch-up would fire straight away.
    clockOffsetMs = SYNC_SOURCE_EVENT_MIN_INTERVAL_MS * 3;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(syncCalls, 2, 'the deferred sync was satisfied, not queued behind the manual one');
  } finally {
    Date.now = originalNow;
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a failed forced sync hands the source event back instead of eating it', async (t) => {
  // maybeSyncAntigravity resolves on every outcome so a stuck sync cannot hold
  // the tick open, which means a timeout or non-zero exit is indistinguishable
  // from success unless it reports. It has to: the tick already consumed the
  // source event on its behalf, and swallowing the failure would put the refresh
  // back on the fallback interval — the latency this path exists to remove.
  const sourceRoot = path.join('.gemini', 'antigravity');
  const tmp = withTmpHome([path.join(sourceRoot, 'conversations')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => {
    const watcher = {
      on(event, handler) {
        if (event === 'all') watchHandler = handler;
        return watcher;
      },
      close() {}
    };
    return watcher;
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  const originalNow = Date.now;
  const baseNow = originalNow();
  let clockOffsetMs = 0;
  Date.now = () => baseNow + clockOffsetMs;

  let handle = null;
  let syncCalls = 0;
  let failNextSync = false;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: true,
      watchDebounceMs: 10,
      limitsEnabled: false,
      historyEnabled: false,
      anchorPersistenceEnabled: false,
      runAntigravitySync: async () => {
        syncCalls += 1;
        if (failNextSync) throw new Error('language server went away');
      },
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(syncCalls, 1);

    // A source event still inside the floor, so its sync is deferred.
    clockOffsetMs = SYNC_SOURCE_EVENT_MIN_INTERVAL_MS - 300;
    watchHandler('change', path.join(tmp, sourceRoot, 'conversations', 'session-a.db-wal'));
    await waitForCondition(() => updates.length === 2);
    assert.equal(syncCalls, 1);

    // The manual refresh claims that pending event, then fails. The restored
    // catch-up is armed a full floor out — the failed attempt still stamped the
    // rate limit, deliberately, so a wedged language server cannot be retried in
    // a loop — so the timer is mocked rather than waited on. waitForCondition
    // runs off setInterval and stays real.
    failNextSync = true;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await handle.tick('manual', { forceSelfSync: true });
    assert.equal(syncCalls, 2, 'the forced sync was attempted');

    // The change is still uncollected, so the catch-up has to come back for it —
    // on the idle cadence, because the attempt that consumed it failed.
    failNextSync = false;
    clockOffsetMs = SYNC_MIN_INTERVAL_MS * 2;
    t.mock.timers.tick(SYNC_MIN_INTERVAL_MS + 1000);
    t.mock.timers.reset();
    await waitForCondition(() => syncCalls === 3, 4000);
    const retried = calls[calls.length - 1];
    assert.equal(retried[retried.indexOf('--client') + 1], 'antigravity,antigravity-cli');
  } finally {
    Date.now = originalNow;
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a source event that keeps failing backs off to the idle cadence', async (t) => {
  // Restoring a consumed event on failure is what stops a change being stranded,
  // but the restore must not re-enter the ten-second floor: a sync that keeps
  // failing would then drive its own next attempt for as long as the process
  // lives. The first retry is fast, and a failure drops the client back to the
  // idle cadence — which is exactly where it sat before any of this existed.
  const sourceRoot = path.join('.gemini', 'antigravity');
  const tmp = withTmpHome([path.join(sourceRoot, 'conversations')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => {
    const watcher = {
      on(event, handler) {
        if (event === 'all') watchHandler = handler;
        return watcher;
      },
      close() {}
    };
    return watcher;
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = recordingSpawn([]);

  const originalNow = Date.now;
  const baseNow = originalNow();
  let clockOffsetMs = 0;
  Date.now = () => baseNow + clockOffsetMs;

  let handle = null;
  let syncCalls = 0;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: true,
      watchDebounceMs: 10,
      limitsEnabled: false,
      historyEnabled: false,
      anchorPersistenceEnabled: false,
      runAntigravitySync: async () => {
        syncCalls += 1;
        // The startup sync succeeds: the client has to be on the fast floor for
        // the source event below to be the thing that trips the backoff.
        if (syncCalls > 1) throw new Error('language server unreachable');
      },
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(syncCalls, 1, 'the startup sync succeeded');

    // Mocked before the event, not after: the restore arms a real timer, and
    // enabling the mock afterwards would leave that timer outside its control —
    // the assertion would then pass because nothing could fire, proving nothing.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    clockOffsetMs = SYNC_SOURCE_EVENT_MIN_INTERVAL_MS + 1000;
    watchHandler('change', path.join(tmp, sourceRoot, 'conversations', 'session-a.db-wal'));
    t.mock.timers.tick(50);
    await waitForCondition(() => syncCalls === 2, 4000);

    // Nothing further happens: no new events, just time. Advancing past the
    // source floor must not produce another attempt — the restored event is
    // parked on the idle cadence, so only a far larger jump would reach it.
    clockOffsetMs += SYNC_SOURCE_EVENT_MIN_INTERVAL_MS + 1000;
    t.mock.timers.tick(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS + 1000);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.reset();
    assert.equal(syncCalls, 2, 'a failing sync does not drive its own next attempt');
  } finally {
    Date.now = originalNow;
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an unrelated client event does not bypass a source-sync backoff', async () => {
  // scheduleTick drains the pending source set on *every* watcher event, so the
  // backoff cannot live in the catch-up timer alone: a client the user happens to
  // be working in would drain the failed one straight back out and retry it on
  // the fast floor — the same retry loop, driven by someone else's activity.
  const sourceRoot = path.join('.gemini', 'antigravity');
  const tmp = withTmpHome([
    path.join(sourceRoot, 'conversations'),
    path.join('.claude', 'projects')
  ]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => {
    const watcher = {
      on(event, handler) {
        if (event === 'all') watchHandler = handler;
        return watcher;
      },
      close() {}
    };
    return watcher;
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  const originalNow = Date.now;
  const baseNow = originalNow();
  let clockOffsetMs = 0;
  Date.now = () => baseNow + clockOffsetMs;

  let handle = null;
  let syncCalls = 0;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude,antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: true,
      watchDebounceMs: 10,
      limitsEnabled: false,
      historyEnabled: false,
      anchorPersistenceEnabled: false,
      runAntigravitySync: async () => {
        syncCalls += 1;
        if (syncCalls > 1) throw new Error('language server unreachable');
      },
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(syncCalls, 1, 'the startup sync succeeded');

    clockOffsetMs = SYNC_SOURCE_EVENT_MIN_INTERVAL_MS + 1000;
    watchHandler('change', path.join(tmp, sourceRoot, 'conversations', 'session-a.db-wal'));
    await waitForCondition(() => syncCalls === 2, 4000);

    // Far past the source floor, so only the backoff can hold it back now.
    clockOffsetMs += SYNC_SOURCE_EVENT_MIN_INTERVAL_MS * 4;
    const updatesBefore = updates.length;
    watchHandler('change', path.join(tmp, '.claude', 'projects', 'a', 'session.jsonl'));
    await waitForCondition(() => updates.length > updatesBefore, 4000);
    assert.equal(syncCalls, 2, 'the unrelated event did not retry the backed-off sync');
  } finally {
    Date.now = originalNow;
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a failed sync moves the client off the fast source floor', async () => {
  // The backoff is one decision, read by all three schedulers — the drain, the
  // catch-up arm and the sync itself. Pinning the decision rather than each
  // caller is what stops them disagreeing: an earlier version backed off only
  // the timer, and an unrelated client's watch event still drained the failed
  // client on the fast floor, consuming a pending event for a sync that would
  // then be refused.
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-floor-'));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });

  try {
    const { collectUsageOnce, selfSyncThrottle } = freshCollector();
    const sourceSyncFloorMs = (kind) => selfSyncThrottle.sourceFloorMs(kind);
    const options = {
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'usage-only',
      historyEnabled: false,
      homeDir: home,
      runTokscale: async () => ({ entries: [] })
    };

    assert.equal(sourceSyncFloorMs('antigravity'), SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);

    await collectUsageOnce({
      ...options,
      forceSelfSync: true,
      runAntigravitySync: async () => { throw new Error('language server unreachable'); }
    });
    assert.equal(sourceSyncFloorMs('antigravity'), SYNC_MIN_INTERVAL_MS, 'a failure backs the client off');

    await collectUsageOnce({
      ...options,
      forceSelfSync: true,
      runAntigravitySync: async () => {}
    });
    assert.equal(
      sourceSyncFloorMs('antigravity'),
      SYNC_SOURCE_EVENT_MIN_INTERVAL_MS,
      'and a working sync earns the fast floor back'
    );
  } finally {
    delete require.cache[collectorPath];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a superseded sync attempt cannot rewrite the current backoff', async () => {
  // stop() cannot cancel a sync already in flight, so a collector rebuilt by a
  // settings change can have the previous one's attempt land after its own.
  // Whichever attempt started last owns the flag — otherwise a stale failure
  // parks a healthy client on the five-minute cadence, and a stale success
  // clears a backoff the live collector still needs.
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-supersede-'));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });

  try {
    const { collectUsageOnce, selfSyncThrottle } = freshCollector();
    const sourceSyncFloorMs = (kind) => selfSyncThrottle.sourceFloorMs(kind);
    const options = {
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'usage-only',
      historyEnabled: false,
      homeDir: home,
      forceSelfSync: true,
      runTokscale: async () => ({ entries: [] })
    };

    // The old attempt is still running when the new one starts and succeeds.
    let releaseStale = null;
    const staleStarted = new Promise((resolve) => {
      const stale = collectUsageOnce({
        ...options,
        runAntigravitySync: () => new Promise((_, reject) => {
          releaseStale = () => reject(new Error('language server went away'));
          resolve();
        })
      });
      stale.catch(() => {});
    });
    await staleStarted;

    await collectUsageOnce({ ...options, runAntigravitySync: async () => {} });
    assert.equal(sourceSyncFloorMs('antigravity'), SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);

    // Now the old one fails. It must not drag the live client into a backoff.
    releaseStale();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(
      sourceSyncFloorMs('antigravity'),
      SYNC_MIN_INTERVAL_MS,
      'the superseded failure was ignored'
    );

    // And the same in the other direction, which is the more dangerous one: a
    // stale success must not clear a backoff the live client still needs.
    let releaseStaleOk = null;
    const staleOkStarted = new Promise((resolve) => {
      const staleOk = collectUsageOnce({
        ...options,
        runAntigravitySync: () => new Promise((fulfil) => {
          releaseStaleOk = () => fulfil();
          resolve();
        })
      });
      staleOk.catch(() => {});
    });
    await staleOkStarted;

    await collectUsageOnce({
      ...options,
      runAntigravitySync: async () => { throw new Error('language server went away'); }
    });
    assert.equal(sourceSyncFloorMs('antigravity'), SYNC_MIN_INTERVAL_MS);

    releaseStaleOk();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      sourceSyncFloorMs('antigravity'),
      SYNC_MIN_INTERVAL_MS,
      'the superseded success did not clear the live backoff'
    );
  } finally {
    delete require.cache[collectorPath];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a misbehaving sync child reports failure exactly once', async () => {
  // A child reports more than once: a SIGTERM'd timeout still emits close, and
  // error is normally followed by close. That was harmless while every path only
  // resolved a promise, but onFailure re-arms the catch-up — and a late duplicate
  // could land after a later catch-up already succeeded, putting the same source
  // event back into a set with nothing left to collect.
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-sync-once-'));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  let emitAfterError = false;
  childProcess.spawn = (_bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    const isSync = args.includes('sync');
    setImmediate(() => {
      if (!isSync) {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
        child.emit('close', 0);
        return;
      }
      if (emitAfterError) child.emit('error', new Error('spawn failed'));
      child.emit('close', 1);
    });
    return child;
  };

  try {
    const { collectUsageOnce } = freshCollector();
    for (const withError of [false, true]) {
      emitAfterError = withError;
      const failures = [];
      await collectUsageOnce({
        clients: 'antigravity',
        allTimeSince: '2024-01-01',
        commandTimeoutMs: 1000,
        deviceId: 'usage-only',
        historyEnabled: false,
        homeDir: home,
        forceSelfSync: true,
        onSelfSyncFailed: (kind) => failures.push(kind)
      });
      assert.deepEqual(failures, ['antigravity'], withError ? 'error then close' : 'non-zero close');
    }
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an unusable watch debounce cannot turn the catch-up retry into a spin', () => {
  // setTimeout rewrites a non-finite or oversized delay to 1ms, so an env-set
  // TOKEN_MONITOR_WATCH_DEBOUNCE_MS of Infinity would make the mid-tick retry
  // fire hundreds of times per second for the length of the tick.
  assert.equal(clampTimerDelayMs(Infinity, 1000), 1000);
  assert.equal(clampTimerDelayMs(-Infinity, 1000), 1000);
  assert.equal(clampTimerDelayMs(NaN, 1000), 1000);
  assert.equal(clampTimerDelayMs(undefined, 1000), 1000);
  assert.equal(clampTimerDelayMs(0, 1000), 1000);
  assert.equal(clampTimerDelayMs(-5, 1000), 1000);
  assert.equal(clampTimerDelayMs(2 ** 32, 1000), 2 ** 31 - 1);
  assert.equal(clampTimerDelayMs(1500, 1000), 1500);
});

test('an Antigravity CLI event rescans without paying for an IDE sync', async () => {
  // Both roots share the umbrella client id, so the scan target is the same for
  // either. Only the IDE roots feed `antigravity sync`; the CLI writes
  // parse-local SQLite tokscale reads directly, so a CLI write has nothing to
  // re-sync and must not skip the idle cadence to spawn one.
  const sourceRoot = path.join('.gemini', 'antigravity');
  const cliRoot = path.join('.gemini', 'antigravity-cli');
  const tmp = withTmpHome([
    path.join(sourceRoot, 'conversations'),
    path.join(cliRoot, 'conversations')
  ]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  const previousGeminiHome = process.env.GEMINI_CLI_HOME;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;
  delete process.env.GEMINI_CLI_HOME;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => {
    const watcher = {
      on(event, handler) {
        if (event === 'all') watchHandler = handler;
        return watcher;
      },
      close() {}
    };
    return watcher;
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  let syncCalls = 0;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: true,
      watchDebounceMs: 10,
      limitsEnabled: false,
      historyEnabled: false,
      anchorPersistenceEnabled: false,
      runAntigravitySync: async () => { syncCalls += 1; },
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(syncCalls, 1, 'startup sync still runs');

    watchHandler('change', path.join(tmp, cliRoot, 'conversations', 'state.db'));
    await waitForCondition(() => updates.length === 2);
    assert.equal(syncCalls, 1, 'a CLI-only event leaves the sync on its idle cadence');
    const targeted = calls[calls.length - 1];
    assert.equal(targeted[targeted.indexOf('--client') + 1], 'antigravity,antigravity-cli');
    assert.ok(targeted.includes('--today'));
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (previousGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = previousGeminiHome;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('selfSyncSourceRootsForClients covers the IDE roots and excludes the CLI dir', () => {
  const tmp = withTmpHome([
    path.join('.gemini', 'antigravity', 'brain'),
    path.join('.gemini', 'antigravity-ide', 'conversations'),
    path.join('.gemini', 'antigravity-cli', 'conversations'),
    path.join('.config', 'tokscale', 'antigravity-cache')
  ]);
  const originalHomedir = os.homedir;
  const previousGeminiHome = process.env.GEMINI_CLI_HOME;
  os.homedir = () => tmp;
  try {
    delete process.env.GEMINI_CLI_HOME;
    const { selfSyncSourceRootsForClients } = freshCollector();
    assert.deepEqual(selfSyncSourceRootsForClients('antigravity'), {
      antigravity: [
        path.join(tmp, '.gemini', 'antigravity'),
        path.join(tmp, '.gemini', 'antigravity-ide')
      ]
    });
    assert.deepEqual(selfSyncSourceRootsForClients('claude'), {});
  } finally {
    os.homedir = originalHomedir;
    if (previousGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = previousGeminiHome;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchPathsForClients watches only Proma data that is currently parsed', () => {
  const tmp = withTmpHome([
    path.join('.proma', 'agent-sessions'),
    path.join('.proma', 'conversations')
  ]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { watchPathsForClients } = freshCollector();
    assert.deepEqual(watchPathsForClients('proma'), [path.join(tmp, '.proma', 'agent-sessions')]);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('clientDataDirPresence still detects cursor/antigravity via their cache dirs', () => {
  const tmp = withTmpHome([
    path.join('.config', 'tokscale', 'cursor-cache'),
    path.join('.config', 'tokscale', 'antigravity-cache')
  ]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { clientDataDirPresence } = freshCollector();
    const presence = clientDataDirPresence('cursor,antigravity');
    assert.equal(presence.cursor, true);
    assert.equal(presence.antigravity, true);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('clientDataDirPresence detects Antigravity native source roots', () => {
  const tmp = withTmpHome([path.join('.gemini', 'antigravity', 'brain')]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { clientDataDirPresence } = freshCollector();
    assert.deepEqual(clientDataDirPresence('antigravity'), { antigravity: true });
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchPathsForClients includes Kimi, Qwen, and Grok Build local roots', () => {
  const tmp = withTmpHome([
    path.join('.kimi', 'sessions'),
    path.join('.kimi-code', 'sessions'),
    path.join('.qwen', 'projects'),
    path.join('.grok', 'sessions')
  ]);
  const originalHomedir = os.homedir;
  const previousKimiCodeHome = process.env.KIMI_CODE_HOME;
  const previousGrokHome = process.env.GROK_HOME;
  os.homedir = () => tmp;
  try {
    delete process.env.KIMI_CODE_HOME;
    delete process.env.GROK_HOME;
    const { clientDataDirPresence, watchPathsForClients } = freshCollector();
    const dirs = watchPathsForClients('kimi,qwen,grok');
    assert.ok(dirs.includes(path.join(tmp, '.kimi', 'sessions')));
    assert.ok(dirs.includes(path.join(tmp, '.kimi-code', 'sessions')));
    assert.ok(dirs.includes(path.join(tmp, '.qwen', 'projects')));
    assert.ok(dirs.includes(path.join(tmp, '.grok', 'sessions')));
    assert.deepEqual(clientDataDirPresence('kimi,qwen,grok'), { kimi: true, qwen: true, grok: true });
  } finally {
    os.homedir = originalHomedir;
    if (previousKimiCodeHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimiCodeHome;
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchPathsForClients includes GitHub Copilot CLI and VS Code chat roots', () => {
  const tmp = withTmpHome([
    path.join('.copilot', 'otel'),
    path.join('Library', 'Application Support', 'Code', 'User', 'workspaceStorage')
  ]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { clientDataDirPresence, watchPathsForClients } = freshCollector();
    const dirs = watchPathsForClients('copilot');
    assert.ok(dirs.includes(path.join(tmp, '.copilot')));
    assert.ok(!dirs.includes(path.join(tmp, '.copilot', 'otel')));
    assert.ok(dirs.includes(path.join(tmp, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')));
    assert.deepEqual(clientDataDirPresence('copilot'), { copilot: true });
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchPathsForClients includes Tokscale auxiliary source roots', () => {
  const codexHome = path.join('custom-codex');
  const headlessRoot = path.join('custom-headless');
  const clineRoot = path.join('custom-cline-sessions');
  const exporter = path.join('custom-export', 'copilot.jsonl');
  const tmp = withTmpHome([
    path.join('.copilot', 'otel'),
    path.join('.zcode', 'cli', 'db'),
    path.join('.grok', 'sessions'),
    path.join('.grok', 'logs'),
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
    path.join(headlessRoot, 'codex'),
    clineRoot,
    path.dirname(exporter)
  ]);
  const originalHomedir = os.homedir;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousHeadlessRoot = process.env.TOKSCALE_HEADLESS_DIR;
  const previousClineRoot = process.env.CLINE_SESSION_DATA_DIR;
  const previousExporter = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  os.homedir = () => tmp;
  try {
    process.env.CODEX_HOME = path.join(tmp, codexHome);
    process.env.TOKSCALE_HEADLESS_DIR = path.join(tmp, headlessRoot);
    process.env.CLINE_SESSION_DATA_DIR = path.join(tmp, clineRoot);
    process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = path.join(tmp, exporter);
    fs.writeFileSync(path.join(tmp, '.copilot', 'data.db'), '');
    fs.writeFileSync(path.join(tmp, '.zcode', 'cli', 'db', 'db.sqlite'), '');
    fs.writeFileSync(path.join(tmp, '.grok', 'logs', 'unified.jsonl'), '');
    fs.writeFileSync(path.join(tmp, exporter), '');

    const { clientDataDirPresence, watchPathsForClients } = freshCollector();
    const dirs = watchPathsForClients('copilot,zcode,grok,codex,cline');
    assert.ok(dirs.includes(path.join(tmp, '.copilot')));
    assert.ok(!dirs.includes(path.join(tmp, '.copilot', 'otel')));
    assert.ok(dirs.includes(path.join(tmp, '.zcode', 'cli', 'db')));
    assert.ok(dirs.includes(path.join(tmp, '.grok', 'logs')));
    assert.ok(dirs.includes(path.join(tmp, codexHome, 'sessions')));
    assert.ok(dirs.includes(path.join(tmp, codexHome, 'archived_sessions')));
    assert.ok(dirs.includes(path.join(tmp, headlessRoot, 'codex')));
    assert.ok(dirs.includes(path.join(tmp, clineRoot)));
    assert.ok(dirs.includes(path.join(tmp, path.dirname(exporter))));
    assert.deepEqual(clientDataDirPresence('copilot,zcode,grok,codex,cline'), {
      copilot: true, zcode: true, grok: true, codex: true, cline: true
    });
  } finally {
    os.homedir = originalHomedir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousHeadlessRoot === undefined) delete process.env.TOKSCALE_HEADLESS_DIR;
    else process.env.TOKSCALE_HEADLESS_DIR = previousHeadlessRoot;
    if (previousClineRoot === undefined) delete process.env.CLINE_SESSION_DATA_DIR;
    else process.env.CLINE_SESSION_DATA_DIR = previousClineRoot;
    if (previousExporter === undefined) delete process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
    else process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = previousExporter;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher bounds Copilot data, Grok unified, ZCode, and exporter roots', () => {
  const exporter = path.join('.copilot', 'custom-export', 'copilot.jsonl');
  const tmp = withTmpHome([
    path.join('.copilot', 'otel'),
    path.join('.grok', 'logs'),
    path.join('.zcode', 'cli', 'db'),
    path.dirname(exporter)
  ]);
  const originalHomedir = os.homedir;
  const previousExporter = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  os.homedir = () => tmp;
  try {
    process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = `  ${path.join(tmp, exporter)}  `;
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('copilot,grok,zcode');
    const copilotRoot = path.join(tmp, '.copilot');
    const grokLogs = path.join(tmp, '.grok', 'logs');
    const zcodeDb = path.join(tmp, '.zcode', 'cli', 'db');
    const exporterRoot = path.join(tmp, path.dirname(exporter));

    assert.equal(ignored(copilotRoot), false);
    assert.equal(ignored(path.join(copilotRoot, 'data.db')), false);
    assert.equal(ignored(path.join(copilotRoot, 'data.db-wal')), false);
    assert.equal(ignored(path.join(copilotRoot, 'data.db-shm')), false);
    assert.equal(ignored(path.join(copilotRoot, 'otel', 'trace.jsonl')), false);
    assert.equal(ignored(path.join(copilotRoot, 'cache')), true);

    assert.equal(ignored(grokLogs), false);
    assert.equal(ignored(path.join(grokLogs, 'unified.jsonl')), false);
    assert.equal(ignored(path.join(grokLogs, 'other.log')), true);
    assert.equal(ignored(path.join(grokLogs, 'archive', 'unified.jsonl')), true);

    assert.equal(ignored(zcodeDb), false);
    assert.equal(ignored(path.join(zcodeDb, 'db.sqlite')), false);
    assert.equal(ignored(path.join(zcodeDb, 'db.sqlite-wal')), false);
    assert.equal(ignored(path.join(zcodeDb, 'cache')), true);

    assert.equal(ignored(exporterRoot), false);
    assert.equal(ignored(path.join(exporterRoot, 'copilot.jsonl')), false);
    assert.equal(ignored(path.join(exporterRoot, 'other.jsonl')), true);
  } finally {
    os.homedir = originalHomedir;
    if (previousExporter === undefined) delete process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
    else process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = previousExporter;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher preserves recursive client roots under an exporter parent', () => {
  const tmp = withTmpHome([path.join('.codex', 'sessions')]);
  const originalHomedir = os.homedir;
  const previousExporter = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  os.homedir = () => tmp;
  try {
    process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = path.join(tmp, 'copilot.jsonl');
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('copilot,codex');
    const codexRoot = path.join(tmp, '.codex', 'sessions');

    assert.equal(ignored(codexRoot), false);
    assert.equal(ignored(path.join(codexRoot, 'session.jsonl')), false);
    assert.equal(ignored(path.join(tmp, 'unrelated')), true);
  } finally {
    os.homedir = originalHomedir;
    if (previousExporter === undefined) delete process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
    else process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = previousExporter;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher preserves bounded sources under an exporter parent', () => {
  const opencodeRoot = path.join('.local', 'share', 'opencode');
  const exporter = path.join(opencodeRoot, 'copilot.jsonl');
  const tmp = withTmpHome([opencodeRoot]);
  const originalHomedir = os.homedir;
  const previousExporter = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  os.homedir = () => tmp;
  try {
    process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = path.join(tmp, exporter);
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('copilot,opencode');
    const root = path.join(tmp, opencodeRoot);

    assert.equal(ignored(path.join(root, 'opencode.db')), false);
    assert.equal(ignored(path.join(root, 'opencode.db-wal')), false);
    assert.equal(ignored(path.join(root, 'log')), true);
    assert.equal(ignored(path.join(root, 'copilot.jsonl')), false);
  } finally {
    os.homedir = originalHomedir;
    if (previousExporter === undefined) delete process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
    else process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = previousExporter;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher preserves recursive sources nested under bounded roots', () => {
  const opencodeRoot = path.join('.local', 'share', 'opencode');
  const tmp = withTmpHome([path.join(opencodeRoot, 'sessions')]);
  const originalHomedir = os.homedir;
  const previousCodexHome = process.env.CODEX_HOME;
  os.homedir = () => tmp;
  try {
    process.env.CODEX_HOME = path.join(tmp, opencodeRoot);
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('opencode,codex');
    const codexRoot = path.join(tmp, opencodeRoot, 'sessions');
    const opencodeRootPath = path.join(tmp, opencodeRoot);

    assert.equal(ignored(codexRoot), false);
    assert.equal(ignored(path.join(codexRoot, 'session.jsonl')), false);
    assert.equal(ignored(path.join(opencodeRootPath, 'opencode.db')), false);
    assert.equal(ignored(path.join(opencodeRootPath, 'log')), true);
  } finally {
    os.homedir = originalHomedir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The three ways two source roots can overlap. `ignored` is one predicate for
// the whole chokidar instance, so each of these is a case where two clients
// need different answers about the same path and only one can be given: the
// union of what they read. An ordered branch chain answered from whichever root
// it happened to test first, which is why all three are pinned here.

test('watchIgnoreMatcher keeps a recursive source rooted on a bounded root', () => {
  const shared = 'shared-root';
  const tmp = withTmpHome([shared]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    // Hermes prunes everything but its SQLite trio; the Cline CLI session dir is
    // a recursive transcript tree. Pointed at one directory, Hermes' rule would
    // erase Cline's source unless the recursive root gets a say at equal depth.
    process.env.HERMES_HOME = path.join(tmp, shared);
    process.env.CLINE_SESSION_DATA_DIR = path.join(tmp, shared);
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('hermes,cline');
    const root = path.join(tmp, shared);

    assert.equal(ignored(root), false);
    assert.equal(ignored(path.join(root, 'state.db')), false);
    assert.equal(ignored(path.join(root, 'session.jsonl')), false);
    assert.equal(ignored(path.join(root, 'nested', 'task.json')), false);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher lets a recursive ancestor override a bounded root inside it', () => {
  const tmp = withTmpHome([path.join('nest', 'sessions', 'grok', 'logs')]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    // Grok keeps only logs/unified.jsonl, but here that log dir sits inside a
    // Codex transcript tree, which tokscale walks in full. Pruning Grok's
    // siblings would drop paths Codex reads, so the ancestor wins.
    process.env.CODEX_HOME = path.join(tmp, 'nest');
    process.env.GROK_HOME = path.join(tmp, 'nest', 'sessions', 'grok');
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('codex,grok,zcode');
    const grokLogs = path.join(tmp, 'nest', 'sessions', 'grok', 'logs');

    assert.equal(ignored(path.join(grokLogs, 'unified.jsonl')), false);
    assert.equal(ignored(path.join(grokLogs, 'other.log')), false);
    assert.equal(ignored(path.join(grokLogs, 'archive', 'unified.jsonl')), false);
    // An ancestor suspends pruning under itself, not everywhere: ZCode's root is
    // home-relative, so it sits outside the Codex tree and still prunes. Asserting
    // this on another Codex root would prove nothing — the ancestor covers those.
    const zcodeDb = path.join(tmp, '.zcode', 'cli', 'db');
    assert.equal(ignored(path.join(zcodeDb, 'db.sqlite')), false);
    assert.equal(ignored(path.join(zcodeDb, 'cache')), true);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher unions two bounded roots on one directory', () => {
  const tmp = withTmpHome([path.join('shared', 'logs')]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    // Both clients bound the same directory to a different single file. Neither
    // rule may answer for the other, and what neither wants is still pruned —
    // the union must not degrade into watching everything.
    process.env.HERMES_HOME = path.join(tmp, 'shared', 'logs');
    process.env.GROK_HOME = path.join(tmp, 'shared');
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('hermes,grok');
    const root = path.join(tmp, 'shared', 'logs');

    assert.equal(ignored(root), false);
    assert.equal(ignored(path.join(root, 'state.db')), false);
    assert.equal(ignored(path.join(root, 'state.db-wal')), false);
    assert.equal(ignored(path.join(root, 'unified.jsonl')), false);
    assert.equal(ignored(path.join(root, 'other.log')), true);
    assert.equal(ignored(path.join(root, 'archive', 'unified.jsonl')), true);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher keeps an exporter file after Windows path canonicalization', () => {
  const exporter = path.join('.copilot', 'custom-export', 'copilot.jsonl');
  const { base, alias, real } = withAliasedTmpHome([path.dirname(exporter)]);
  const originalHomedir = os.homedir;
  const previousExporter = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  os.homedir = () => alias;
  try {
    process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = path.join(alias, exporter);
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('copilot');
    const eventRoot = process.platform === 'win32' ? real : alias;
    assert.equal(ignored(path.join(eventRoot, exporter)), false);
    assert.equal(ignored(path.join(eventRoot, path.dirname(exporter), 'other.jsonl')), true);
  } finally {
    os.homedir = originalHomedir;
    if (previousExporter === undefined) delete process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
    else process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = previousExporter;
    delete require.cache[collectorPath];
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('watchPathsForClients follows XDG_DATA_HOME for OpenCode, MiMo, and Zed', () => {
  const xdgRoot = path.join('custom-xdg');
  const tmp = withTmpHome([
    path.join(xdgRoot, 'opencode'),
    path.join(xdgRoot, 'mimocode'),
    path.join(xdgRoot, 'zed', 'threads')
  ]);
  const originalHomedir = os.homedir;
  const previousXdg = process.env.XDG_DATA_HOME;
  os.homedir = () => tmp;
  try {
    process.env.XDG_DATA_HOME = path.join(tmp, xdgRoot);
    const { clientDataDirPresence, watchPathsForClients } = freshCollector();
    const dirs = watchPathsForClients('opencode,micode,zed');
    assert.ok(dirs.includes(path.join(tmp, xdgRoot, 'opencode')));
    assert.ok(dirs.includes(path.join(tmp, xdgRoot, 'mimocode')));
    assert.ok(dirs.includes(path.join(tmp, xdgRoot, 'zed', 'threads')));
    assert.ok(!dirs.includes(path.join(tmp, '.local', 'share', 'opencode')));
    assert.deepEqual(clientDataDirPresence('opencode,micode,zed'), {
      opencode: true, micode: true, zed: true
    });
  } finally {
    os.homedir = originalHomedir;
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher prunes unrelated VS Code workspace state but keeps Copilot chats', () => {
  const tmp = withTmpHome([
    path.join('Library', 'Application Support', 'Code', 'User', 'workspaceStorage', 'abc', 'chatSessions')
  ]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { watchIgnoreMatcher } = freshCollector();
    const root = path.join(tmp, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
    const ignored = watchIgnoreMatcher('copilot');
    assert.equal(ignored(root), false);
    assert.equal(ignored(path.join(root, 'abc')), false);
    assert.equal(ignored(path.join(root, 'abc', 'chatSessions')), false);
    assert.equal(ignored(path.join(root, 'abc', 'chatSessions', 'session.jsonl')), false);
    assert.equal(ignored(path.join(root, 'abc', 'workspace.json')), false);
    assert.equal(ignored(path.join(root, 'abc', 'state.vscdb')), true);
    assert.equal(ignored(path.join(root, 'abc', 'other', 'cache.bin')), true);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('clientDataDirPresence requires an actual VS Code Copilot chat source', () => {
  const tmp = withTmpHome([
    path.join('Library', 'Application Support', 'Code', 'User', 'workspaceStorage', 'plain-workspace')
  ]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { clientDataDirPresence } = freshCollector();
    assert.deepEqual(clientDataDirPresence('copilot'), { copilot: false });
    fs.mkdirSync(path.join(tmp, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage', 'copilot-workspace', 'chatSessions'), { recursive: true });
    assert.deepEqual(clientDataDirPresence('copilot'), { copilot: true });
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchPathsForClients keeps bounded tool roots but leaves Kiro IDE globalStorage to interval scans', () => {
  const tmp = withTmpHome([
    path.join('.pi', 'agent', 'sessions'),
    path.join('.omp', 'agent', 'sessions'),
    path.join('.local', 'share', 'zed', 'threads'),
    path.join('Library', 'Application Support', 'Zed', 'threads'),
    path.join('.config', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'),
    path.join('.vscode-server', 'data', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'),
    path.join('Library', 'Application Support', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'),
    path.join('.local', 'share', 'mimocode'),
    path.join('.zcode', 'projects'),
    path.join('.kiro', 'sessions', 'workspace-a', 'sess_123'),
    path.join('Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent'),
    path.join('.local', 'share', 'kiro-cli'),
    path.join('.codebuddy', 'projects'),
    path.join('.workbuddy', 'projects')
  ]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { clientDataDirPresence, watchPathsForClients } = freshCollector();
    const dirs = watchPathsForClients('pi,zed,kilocode,micode,zcode,kiro,codebuddy,workbuddy');
    assert.ok(dirs.includes(path.join(tmp, '.pi', 'agent', 'sessions')));
    assert.ok(dirs.includes(path.join(tmp, '.omp', 'agent', 'sessions')));
    assert.ok(dirs.includes(path.join(tmp, '.local', 'share', 'zed', 'threads')));
    assert.ok(dirs.includes(path.join(tmp, 'Library', 'Application Support', 'Zed', 'threads')));
    assert.ok(dirs.includes(path.join(tmp, '.config', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks')));
    assert.ok(dirs.includes(path.join(tmp, '.vscode-server', 'data', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks')));
    // tokscale 3.1.3 does not scan KiloCode's native macOS/Windows globalStorage,
    // so we must not watch it (would be a dead watch + a false "active" status).
    assert.ok(!dirs.includes(path.join(tmp, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks')));
    assert.ok(dirs.includes(path.join(tmp, '.local', 'share', 'mimocode')));
    assert.ok(dirs.includes(path.join(tmp, '.zcode', 'projects')));
    // Kiro sessions and the bounded kiro-cli database keep seconds-level
    // refresh. The unbounded IDE globalStorage source remains present and
    // collectable, but never enters chokidar's native or 2-second polling tree.
    assert.ok(dirs.includes(path.join(tmp, '.kiro', 'sessions')));
    assert.ok(!dirs.includes(path.join(tmp, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')));
    assert.ok(dirs.includes(path.join(tmp, '.local', 'share', 'kiro-cli')));
    // CodeBuddy/WorkBuddy: assert the platform-agnostic roots. CodeBuddy's
    // extension-log root is process.platform-specific, so it's covered by the
    // collector code, not this cross-platform test.
    assert.ok(dirs.includes(path.join(tmp, '.codebuddy', 'projects')));
    assert.ok(dirs.includes(path.join(tmp, '.workbuddy', 'projects')));
    assert.deepEqual(clientDataDirPresence('pi,zed,kilocode,micode,zcode,kiro,codebuddy,workbuddy'), {
      pi: true, zed: true, kilocode: true, micode: true, zcode: true, kiro: true, codebuddy: true, workbuddy: true
    });
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Kiro IDE globalStorage stays a health source when it is the only Kiro root', () => {
  const globalStorage = path.join('Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
  const tmp = withTmpHome([globalStorage]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { clientDataDirPresence, clientSourceChecks, watchPathsForClients } = freshCollector();
    assert.deepEqual(watchPathsForClients('kiro'), []);
    assert.deepEqual(clientDataDirPresence('kiro'), { kiro: true });
    assert.deepEqual(
      clientSourceChecks('kiro').kiro.find((check) => check.id === 'kiro-ide-globalstorage'),
      { id: 'kiro-ide-globalstorage', exists: true }
    );
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchPathsForClients watches Hermes profile dirs alongside the home root', () => {
  const tmp = withTmpHome([path.join('.hermes', 'hermes-agent', 'node_modules')]);
  const hermesRoot = path.join(tmp, '.hermes');
  fs.writeFileSync(path.join(hermesRoot, 'state.db'), '');
  const profileDir = path.join(hermesRoot, 'profiles', 'research');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'state.db'), '');
  const originalHomedir = os.homedir;
  const previousHermesHome = process.env.HERMES_HOME;
  os.homedir = () => tmp;
  try {
    delete process.env.HERMES_HOME;
    const { clientDataDirPresence, watchPathsForClients } = freshCollector();
    const dirs = watchPathsForClients('hermes');
    assert.deepEqual(dirs, [hermesRoot, profileDir]);
    assert.deepEqual(clientDataDirPresence('hermes'), { hermes: true });
  } finally {
    os.homedir = originalHomedir;
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchPathsForClients watches the Hermes home dir so new state.db sidecars are picked up', () => {
  // Hermes keeps usage in a single SQLite db at the root of HERMES_HOME, but that
  // dir also holds the Desktop App runtime (hermes-agent/node_modules/venv: GBs /
  // 150k+ files). We watch the dir (not the db files directly) so a state.db-wal
  // created after startup is still seen; the recursive poll that pegged CPU at
  // 100%+ (issue #38) is avoided by the watchIgnoreMatcher pruning below.
  const tmp = withTmpHome([path.join('.hermes', 'hermes-agent', 'node_modules')]);
  fs.writeFileSync(path.join(tmp, '.hermes', 'state.db'), '');
  const originalHomedir = os.homedir;
  const previousHermesHome = process.env.HERMES_HOME;
  os.homedir = () => tmp;
  try {
    delete process.env.HERMES_HOME;
    const { clientDataDirPresence, watchPathsForClients } = freshCollector();
    const dirs = watchPathsForClients('hermes');
    assert.deepEqual(dirs, [path.join(tmp, '.hermes')]);
    assert.deepEqual(clientDataDirPresence('hermes'), { hermes: true });
  } finally {
    os.homedir = originalHomedir;
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher prunes the Hermes runtime but keeps the state.db family and the watch root', () => {
  const tmp = withTmpHome([path.join('.hermes', 'hermes-agent', 'node_modules')]);
  const originalHomedir = os.homedir;
  const previousHermesHome = process.env.HERMES_HOME;
  os.homedir = () => tmp;
  try {
    delete process.env.HERMES_HOME;
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('claude,hermes');
    const hermes = path.join(tmp, '.hermes');
    // The watch root itself and the db family are kept.
    assert.equal(ignored(hermes), false);
    assert.equal(ignored(path.join(hermes, 'state.db')), false);
    assert.equal(ignored(path.join(hermes, 'state.db-wal')), false);
    assert.equal(ignored(path.join(hermes, 'state.db-shm')), false);
    // The runtime / logs / cache under ~/.hermes are pruned (never recursed).
    assert.equal(ignored(path.join(hermes, 'hermes-agent')), true);
    assert.equal(ignored(path.join(hermes, 'hermes-agent', 'node_modules')), true);
    assert.equal(ignored(path.join(hermes, 'logs')), true);
    assert.equal(ignored(path.join(hermes, 'cache', 'blob')), true);
    // Other clients' paths are never touched by the matcher.
    assert.equal(ignored(path.join(tmp, '.claude', 'projects', 'p', 'a.jsonl')), false);
  } finally {
    os.homedir = originalHomedir;
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher keeps profile dirs and their db family so profile changes still fire', () => {
  // A profile dir lives under the Hermes home root, so the child-prune must not
  // ignore it just because its basename isn't a db file — chokidar would then
  // refuse to watch the explicit profile watch root and profile-db edits would
  // only surface on the next interval scan, not the promised 3-5 s refresh.
  const tmp = withTmpHome([path.join('.hermes', 'hermes-agent', 'node_modules')]);
  const hermesRoot = path.join(tmp, '.hermes');
  fs.writeFileSync(path.join(hermesRoot, 'state.db'), '');
  const profileDir = path.join(hermesRoot, 'profiles', 'research');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'state.db'), '');
  const originalHomedir = os.homedir;
  const previousHermesHome = process.env.HERMES_HOME;
  os.homedir = () => tmp;
  try {
    delete process.env.HERMES_HOME;
    const { watchIgnoreMatcher } = freshCollector();
    const ignored = watchIgnoreMatcher('hermes');
    // The profile dir (an explicit watch root) and its db family stay watched.
    assert.equal(ignored(profileDir), false);
    assert.equal(ignored(path.join(profileDir, 'state.db')), false);
    assert.equal(ignored(path.join(profileDir, 'state.db-wal')), false);
    assert.equal(ignored(path.join(profileDir, 'state.db-shm')), false);
    // Junk inside a profile dir is still pruned.
    assert.equal(ignored(path.join(profileDir, 'logs')), true);
  } finally {
    os.homedir = originalHomedir;
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchIgnoreMatcher honors HERMES_HOME and is absent when Hermes is not tracked', () => {
  const tmp = withTmpHome([]);
  const hermesHome = path.join(tmp, 'custom-hermes');
  fs.mkdirSync(path.join(hermesHome, 'logs'), { recursive: true });
  const originalHomedir = os.homedir;
  const previousHermesHome = process.env.HERMES_HOME;
  os.homedir = () => tmp;
  try {
    process.env.HERMES_HOME = hermesHome;
    const { watchPathsForClients, watchIgnoreMatcher } = freshCollector();
    assert.deepEqual(watchPathsForClients('hermes'), [hermesHome]);
    const ignored = watchIgnoreMatcher('hermes');
    assert.equal(ignored(path.join(hermesHome, 'state.db-wal')), false);
    assert.equal(ignored(path.join(hermesHome, 'logs')), true);
    // No Hermes tracked, no matcher, so other watchers run unchanged.
    assert.equal(watchIgnoreMatcher('claude,codex'), undefined);
  } finally {
    os.homedir = originalHomedir;
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('collectUsageOnce skips antigravity sync when no antigravity data root exists', async () => {
  const tmp = withTmpHome([]);
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);
  try {
    const { collectUsageOnce } = freshCollector();
    await collectUsageOnce({
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false,
      homeDir: tmp
    });
    assert.equal(calls.filter((args) => args.includes('sync')).length, 0);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('antigravity sync runs at most once per throttle window across ticks', async () => {
  const tmp = withTmpHome([path.join('.gemini', 'antigravity')]);
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);
  try {
    const { collectUsageOnce } = freshCollector();
    const options = {
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false,
      homeDir: tmp
    };
    await collectUsageOnce(options);
    await collectUsageOnce(options);
    assert.equal(calls.filter((args) => args.includes('sync')).length, 1);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('collectUsageOnce scans tokscale for antigravity-cli when antigravity is tracked', async () => {
  // tokscale 4.x exposes Antigravity CLI (`agy`) under its own parse-local client
  // id `antigravity-cli`; our tracked-client list only knows the umbrella
  // `antigravity` id, so the scan filter must be widened or the CLI rows are
  // dropped and never reach extractUsageFromTokscale (which folds them back in).
  const tmp = withTmpHome([]);
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);
  try {
    const { collectUsageOnce } = freshCollector();
    await collectUsageOnce({
      clients: 'antigravity',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false,
      homeDir: tmp
    });
    const scanFilters = calls
      .filter((args) => args.includes('--client'))
      .map((args) => args[args.indexOf('--client') + 1]);
    assert.ok(scanFilters.length > 0, 'expected at least one tokscale scan');
    for (const filter of scanFilters) {
      const ids = filter.split(',');
      assert.ok(ids.includes('antigravity'), `antigravity missing from --client ${filter}`);
      assert.ok(ids.includes('antigravity-cli'), `antigravity-cli missing from --client ${filter}`);
    }
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cursor sync runs at most once per throttle window across ticks', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = recordingSpawn([]);
  const cursorAuth = require('../../src/shared/cursorAuth');
  const originalReadActiveAccount = cursorAuth.readActiveAccount;
  const originalRunCursorSync = cursorAuth.runCursorSync;
  let syncCalls = 0;
  cursorAuth.readActiveAccount = () => ({ accessToken: 'token' });
  cursorAuth.runCursorSync = async () => { syncCalls += 1; };
  try {
    const { collectUsageOnce } = freshCollector();
    const options = {
      clients: 'cursor',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    };
    await collectUsageOnce(options);
    await collectUsageOnce(options);
    assert.equal(syncCalls, 1);
  } finally {
    childProcess.spawn = originalSpawn;
    cursorAuth.readActiveAccount = originalReadActiveAccount;
    cursorAuth.runCursorSync = originalRunCursorSync;
    delete require.cache[collectorPath];
  }
});

test('cursor sync failure metadata reaches client health without stderr or paths', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = recordingSpawn([]);
  const cursorAuth = require('../../src/shared/cursorAuth');
  const originalReadActiveAccount = cursorAuth.readActiveAccount;
  const originalRunCursorSync = cursorAuth.runCursorSync;
  cursorAuth.readActiveAccount = () => ({ accessToken: 'token' });
  cursorAuth.runCursorSync = async () => {
    const error = new Error('tokscale cursor sync exited 17: /Users/alice/.config/tokscale/private');
    error.syncFailureStage = 'process-exit';
    error.syncDetailCode = 'authentication-failed';
    error.syncExitCode = 17;
    throw error;
  };
  try {
    const { collectUsageOnce } = freshCollector();
    const summary = await collectUsageOnce({
      clients: 'cursor',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      forceSelfSync: true,
      limitsEnabled: false
    });
    const entry = summary.clientHealth.clients.cursor;
    assert.equal(entry.collection.state, 'failed');
    assert.equal(entry.collection.syncFailureStage, 'process-exit');
    assert.equal(entry.collection.syncDetailCode, 'authentication-failed');
    assert.equal(entry.collection.syncExitCode, 17);
    assert.equal(JSON.stringify(summary).includes('/Users/alice'), false);
  } finally {
    childProcess.spawn = originalSpawn;
    cursorAuth.readActiveAccount = originalReadActiveAccount;
    cursorAuth.runCursorSync = originalRunCursorSync;
    delete require.cache[collectorPath];
  }
});

test('a targeted tick does not sync an unrelated self-synced client', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = recordingSpawn([]);
  const cursorAuth = require('../../src/shared/cursorAuth');
  const originalReadActiveAccount = cursorAuth.readActiveAccount;
  const originalRunCursorSync = cursorAuth.runCursorSync;
  let syncCalls = 0;
  cursorAuth.readActiveAccount = () => ({ accessToken: 'token' });
  cursorAuth.runCursorSync = async () => { syncCalls += 1; };
  try {
    const { collectUsageOnce, localTodayKey } = freshCollector();
    const claude = emptyPeriod();
    const cursor = emptyPeriod();
    await collectUsageOnce({
      clients: 'claude,cursor',
      targetClients: ['claude'],
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false,
      todayOnlyAnchor: {
        dateKey: localTodayKey(),
        today: emptyPeriod(),
        month: emptyPeriod(),
        allTime: emptyPeriod(),
        todayPartitions: { claude, cursor }
      }
    });
    assert.equal(syncCalls, 0);
  } finally {
    childProcess.spawn = originalSpawn;
    cursorAuth.readActiveAccount = originalReadActiveAccount;
    cursorAuth.runCursorSync = originalRunCursorSync;
    delete require.cache[collectorPath];
  }
});

test('collectUsageOnce runs the three tokscale scans serially, not concurrently', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  let active = 0;
  let maxActive = 0;
  childProcess.spawn = () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      active -= 1;
      child.emit('close', 0);
    });
    return child;
  };
  try {
    const { collectUsageOnce } = freshCollector();
    await collectUsageOnce({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });
    assert.equal(maxActive, 1);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('collector exposes no watch-cooldown knob (refresh cadence is debounce-only)', () => {
  const collector = freshCollector();
  assert.equal(collector.watchDelayMs, undefined);
});

function waitForCondition(predicate, timeoutMs = 2000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (performance.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        reject(new Error('Timed out waiting for condition'));
      }
    }, 5);
  });
}

test('a watch event during an in-flight tick re-arms the debounce instead of coalescing into a full rescan', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  // Isolate the shared data dir so the test doesn't pick up a real
  // collector-anchor.json left by the actual app (anchor persistence).
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => ({
    on: (event, handler) => { if (event === 'all') watchHandler = handler; },
    close: () => {}
  });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  let spawnDelayMs = 5;
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    }, spawnDelayMs);
    return child;
  };

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 5000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchDebounceMs: 10,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason)
    });

    // Initial interval tick: full serial scan (3 spawns).
    await waitForCondition(() => updates.length === 1);
    assert.equal(calls.length, 3);
    assert.ok(watchHandler, 'watcher handler captured');

    // Slow ticks down so the second watch event lands while one is in flight.
    spawnDelayMs = 150;
    watchHandler('change', '/fake/session.jsonl');
    await waitForCondition(() => calls.length === 4);
    watchHandler('change', '/fake/session.jsonl');

    await waitForCondition(() => updates.length === 3);
    // Re-armed tick stays a today-only single scan; the old coalesce path
    // would have run a full 3-scan tick with reason 'coalesced'.
    assert.equal(calls.length, 5);
    assert.ok(!updates.includes('coalesced'), `unexpected coalesced tick in: ${updates.join(', ')}`);
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('live watch events scan only changed clients and preserve the other client partitions', async () => {
  const tmp = withTmpHome([
    path.join('.claude', 'projects'),
    path.join('.codex', 'sessions')
  ]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => {
    const watcher = {
      on(event, handler) {
        if (event === 'all') watchHandler = handler;
        return watcher;
      },
      close() {}
    };
    return watcher;
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  let codexDeleted = false;
  let codexUnattributed = false;
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const selected = String(args[args.indexOf('--client') + 1] || '').split(',').filter(Boolean);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      const entries = codexUnattributed && selected.length === 1 && selected[0] === 'codex'
        ? [{ model: 'unknown', totalTokens: 99 }]
        : selected.filter((client) => !(codexDeleted && client === 'codex')).map((client) => {
            const tokens = client === 'codex' && selected.length === 1 ? 30 : (client === 'codex' ? 20 : 10);
            return {
              client,
              sessionId: `${client}-session`,
              model: `${client}-model`,
              totalTokens: tokens,
              input: tokens,
              cacheRead: tokens,
              output: tokens,
              cost: tokens / 100
            };
          });
      child.stdout.emit('data', Buffer.from(JSON.stringify({
        entries
      })));
      child.emit('close', 0);
    });
    return child;
  };

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude,codex',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: true,
      watchDebounceMs: 10,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (summary, reason) => updates.push({ summary, reason })
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(calls.length, 3, 'startup still performs one serial full scan');
    assert.ok(watchHandler, 'watcher handler captured');

    watchHandler('change', path.join(tmp, '.codex', 'sessions', 'active.jsonl'));
    await waitForCondition(() => updates.length === 2);

    const targeted = calls[3];
    assert.equal(targeted[targeted.indexOf('--client') + 1], 'codex');
    assert.ok(targeted.includes('--today'));
    assert.equal(updates[1].summary.today.totalTokens, 40);
    assert.equal(updates[1].summary.today.clients.claude, 10);
    assert.equal(updates[1].summary.today.clients.codex, 30);
    assert.equal(updates[1].summary.today.models['claude-model'], 10);
    assert.equal(updates[1].summary.today.models['codex-model'], 30);
    assert.equal(updates[1].summary.today.cacheReadTokens, 40);
    assert.equal(updates[1].summary.month.totalTokens, 40);
    assert.equal(updates[1].summary.allTime.totalTokens, 40);

    // Multiple clients changing inside one debounce window become one targeted
    // scan containing the union, not two subprocesses or an all-client fallback.
    watchHandler('change', path.join(tmp, '.claude', 'projects', 'a.jsonl'));
    watchHandler('change', path.join(tmp, '.codex', 'sessions', 'b.jsonl'));
    await waitForCondition(() => updates.length === 3);
    const union = calls[4];
    assert.equal(union[union.indexOf('--client') + 1], 'claude,codex');
    assert.equal(calls.length, 5);

    watchHandler('change', path.join(tmp, 'unmapped', 'unknown.jsonl'));
    await waitForCondition(() => updates.length === 4);
    const fallback = calls[5];
    assert.equal(fallback[fallback.indexOf('--client') + 1], 'claude,codex');

    codexUnattributed = true;
    watchHandler('change', path.join(tmp, '.codex', 'sessions', 'unattributed.jsonl'));
    await waitForCondition(() => updates.length === 5);
    assert.equal(calls[6][calls[6].indexOf('--client') + 1], 'codex');
    assert.equal(calls[7][calls[7].indexOf('--client') + 1], 'claude,codex');
    assert.equal(updates[4].summary.today.totalTokens, 30);

    // A targeted scan that returns no rows replaces that client's partition
    // with empty usage, so deletes do not leave stale totals behind.
    codexUnattributed = false;
    codexDeleted = true;
    watchHandler('unlink', path.join(tmp, '.codex', 'sessions', 'active.jsonl'));
    await waitForCondition(() => updates.length === 6);
    const deletion = calls[8];
    assert.equal(deletion[deletion.indexOf('--client') + 1], 'codex');
    assert.equal(updates[5].summary.today.totalTokens, 10);
    assert.equal(updates[5].summary.today.clients.claude, 10);
    assert.equal(updates[5].summary.today.clients.codex, undefined);
    assert.equal(updates[5].summary.month.totalTokens, 10);
    assert.equal(updates[5].summary.allTime.totalTokens, 10);
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('smart collection uses native watching and skips idle intervals after startup', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchOptions = null;
  chokidar.watch = (_dirs, options) => {
    watchOptions = options;
    return { on: () => {}, close: () => {} };
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 25,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: false,
      intervalRequiresActivity: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason)
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(calls.length, 3, 'startup performs one full serial collection');
    assert.equal(watchOptions?.usePolling, false);
    assert.equal(watchOptions?.interval, undefined);
    assert.equal(watchOptions?.binaryInterval, undefined);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(calls.length, 3, 'clean smart intervals do not spawn tokscale');
    assert.equal(updates.length, 1, 'clean smart intervals do not publish updates');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Qoder CN db-shm events are ignored without suppressing real database changes', () => {
  const { isQoderCnSelfWatchEvent } = freshCollector();
  const root = path.join(os.tmpdir(), 'QoderCN', 'db');
  const roots = { qodercn: [root] };

  assert.equal(isQoderCnSelfWatchEvent(path.join(root, 'local.db-shm'), roots), true);
  assert.equal(isQoderCnSelfWatchEvent(path.join(root, 'local.db-wal'), roots), false);
  assert.equal(isQoderCnSelfWatchEvent(path.join(os.tmpdir(), 'Other', 'local.db-shm'), roots), false);
});

test('collector preserves Qoder CN while publishing other clients after a bounded SQLite read fails', async () => {
  const tmp = withTmpHome([]);
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const qoderCnUsagePath = require.resolve('../../src/shared/qoderCnUsage');
  const qoderCnUsage = require(qoderCnUsagePath);
  const originalRows = qoderCnUsage.collectQoderCnRows;
  const originalPeriods = qoderCnUsage.buildQoderCnPeriods;
  let failReads = false;
  let claudeTokens = 3;
  qoderCnUsage.collectQoderCnRows = async () => {
    if (failReads) {
      const error = new Error('qodercn sqlite read budget exceeded (rows limit 100000)');
      error.code = 'QODER_CN_READ_BUDGET_EXCEEDED';
      throw error;
    }
    return [];
  };
  qoderCnUsage.buildQoderCnPeriods = () => ({
    today: { entries: [{ client: 'qodercn', model: 'qmodel', input: 7 }] },
    month: { entries: [{ client: 'qodercn', model: 'qmodel', input: 7 }] },
    allTime: { entries: [{ client: 'qodercn', model: 'qmodel', input: 7 }] }
  });
  delete require.cache[collectorPath];

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const previews = [];
    const updates = [];
    const collectorOptions = {
      clients: 'claude,qodercn',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      limitsEnabled: false,
      historyEnabled: false,
      runTokscale: async () => ({ entries: [{ client: 'claude', model: 'm', input: claudeTokens }] })
    };
    handle = startCollector({
      ...collectorOptions,
      onPreview: (summary) => previews.push(summary),
      onUpdate: (summary) => updates.push(summary)
    });

    await waitForCondition(() => updates.length === 1);
    const anchorPath = path.join(tmp, 'collector-anchor.json');
    const firstAnchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
    assert.equal(firstAnchor.qoderCnPeriods.today.clients.qodercn, 7);
    const initialPreviewCount = previews.length;
    failReads = true;
    claudeTokens = 5;
    await handle.tick('manual');

    assert.equal(updates.length, 2, 'a Qoder CN failure must not suppress fresh data from other clients');
    assert.equal(updates.at(-1).today.clients.qodercn, 7, 'final update keeps the last Qoder CN period');
    assert.equal(updates.at(-1).today.clients.claude, 5, 'final update publishes the fresh Claude period');
    const fallbackAnchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
    assert.equal(fallbackAnchor.fullScanAt, firstAnchor.fullScanAt, 'a fallback is not recorded as a successful full scan');
    const failedPreviews = previews.slice(initialPreviewCount);
    assert.equal(failedPreviews.length, 2, 'the failed full scan still emits its two host previews');
    assert.equal(Object.prototype.hasOwnProperty.call(failedPreviews.at(-1), 'qoderCnStatus'), false);
    assert.equal(failedPreviews.at(-1).today.clients.qodercn, 7, 'preview keeps the anchored Qoder CN today partition');
    assert.equal('month' in failedPreviews.at(-1), false, 'preview keeps the last complete month while Qoder CN is unavailable');

    handle.stop();
    handle = startCollector({
      ...collectorOptions,
      onUpdate: (summary) => updates.push(summary)
    });
    await waitForCondition(() => updates.length === 3);
    assert.equal(updates.at(-1).today.clients.qodercn, 7, 'a persisted anchor keeps Qoder CN data after restart');
  } finally {
    if (handle) handle.stop();
    qoderCnUsage.collectQoderCnRows = originalRows;
    qoderCnUsage.buildQoderCnPeriods = originalPeriods;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('collector does not reuse persisted Qoder CN periods after the DB path changes', async () => {
  const tmp = withTmpHome([]);
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  const originalQoderCnDbPath = process.env.TOKEN_MONITOR_QODER_CN_DB_PATH;
  const oldDbPath = path.join(tmp, 'old', 'local.db');
  const newDbPath = path.join(tmp, 'new', 'local.db');
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;
  process.env.TOKEN_MONITOR_QODER_CN_DB_PATH = newDbPath;

  const initialCollector = freshCollector();
  const oldQoderCnPeriod = emptyPeriod();
  oldQoderCnPeriod.totalTokens = 9;
  oldQoderCnPeriod.clients = { qodercn: 9 };
  fs.writeFileSync(path.join(tmp, 'collector-anchor.json'), JSON.stringify({
    dateKey: initialCollector.localTodayKey(),
    today: emptyPeriod(),
    month: emptyPeriod(),
    allTime: emptyPeriod(),
    qoderCnPeriods: { today: oldQoderCnPeriod, month: oldQoderCnPeriod, allTime: oldQoderCnPeriod },
    configFingerprint: initialCollector.configFingerprint('claude,qodercn', '2024-01-01', true, oldDbPath),
    fullScanAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
  }));

  const qoderCnUsagePath = require.resolve('../../src/shared/qoderCnUsage');
  const qoderCnUsage = require(qoderCnUsagePath);
  const originalRows = qoderCnUsage.collectQoderCnRows;
  qoderCnUsage.collectQoderCnRows = async () => {
    throw new Error('new Qoder CN database is temporarily unavailable');
  };
  delete require.cache[collectorPath];

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude,qodercn',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      limitsEnabled: false,
      historyEnabled: false,
      runTokscale: async () => ({ entries: [{ client: 'claude', model: 'm', input: 3 }] }),
      onUpdate: (summary) => updates.push(summary)
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(updates.at(-1).today.clients.claude, 3);
    assert.equal(updates.at(-1).today.clients.qodercn || 0, 0, 'old-path Qoder CN fallback must not leak into the new path');
  } finally {
    if (handle) handle.stop();
    qoderCnUsage.collectQoderCnRows = originalRows;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (originalQoderCnDbPath === undefined) delete process.env.TOKEN_MONITOR_QODER_CN_DB_PATH;
    else process.env.TOKEN_MONITOR_QODER_CN_DB_PATH = originalQoderCnDbPath;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('collector publishes other clients when Qoder CN fails before the first complete snapshot', async () => {
  const tmp = withTmpHome([]);
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const qoderCnUsagePath = require.resolve('../../src/shared/qoderCnUsage');
  const qoderCnUsage = require(qoderCnUsagePath);
  const originalRows = qoderCnUsage.collectQoderCnRows;
  let qoderCnReads = 0;
  let claudeTokens = 3;
  qoderCnUsage.collectQoderCnRows = async () => {
    qoderCnReads += 1;
    throw new Error('Qoder CN unavailable before first complete snapshot');
  };
  delete require.cache[collectorPath];

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude,qodercn',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      anchorPersistenceEnabled: false,
      limitsEnabled: false,
      historyEnabled: false,
      runTokscale: async () => ({ entries: [{ client: 'claude', model: 'm', input: claudeTokens }] }),
      onUpdate: (summary) => updates.push(summary)
    });

    await waitForCondition(() => updates.length === 1);
    claudeTokens = 5;
    await handle.tick('incremental', { todayOnly: true });

    assert.equal(qoderCnReads, 2, 'Qoder CN is retried on the incremental read');
    assert.equal(updates.length, 2, 'a first-read Qoder CN failure must not suppress other clients');
    assert.equal(updates.at(-1).today.clients.claude, 5, 'the incremental Claude period is published');
  } finally {
    if (handle) handle.stop();
    qoderCnUsage.collectQoderCnRows = originalRows;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('collector publishes live periods when only Qoder CN history read fails', async () => {
  const tmp = withTmpHome([]);
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const qoderCnUsagePath = require.resolve('../../src/shared/qoderCnUsage');
  const qoderCnUsage = require(qoderCnUsagePath);
  const originalRows = qoderCnUsage.collectQoderCnRows;
  const originalHistory = qoderCnUsage.buildQoderCnHistoryGraph;
  let failHistory = false;
  const todayKey = new Date().toISOString().slice(0, 10);
  qoderCnUsage.collectQoderCnRows = async () => [];
  qoderCnUsage.buildQoderCnHistoryGraph = () => {
    if (failHistory) throw new Error('temporary Qoder CN history read failure');
    return {
      contributions: [{
        date: todayKey,
        clients: [{ client: 'qodercn', modelId: 'qmodel', tokens: { input: 2 }, cost: 0, messages: 1 }]
      }]
    };
  };
  delete require.cache[collectorPath];

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude,qodercn',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      anchorPersistenceEnabled: false,
      limitsEnabled: false,
      historyEnabled: true,
      runTokscale: async () => ({ entries: [{ client: 'claude', model: 'm', input: 3 }] }),
      runGraph: async () => ({
        contributions: [{
          date: todayKey,
          clients: [{ client: 'claude', modelId: 'm', tokens: { input: 3 }, cost: 0, messages: 1 }]
        }]
      }),
      onUpdate: (summary) => updates.push(summary)
    });

    await waitForCondition(() => updates.length === 1);
    failHistory = true;
    await handle.tick('manual', { forceHistory: true });

    assert.equal(updates.length, 2, 'history-only failure must not suppress fresh live periods');
    assert.equal(Object.prototype.hasOwnProperty.call(updates.at(-1), 'qoderCnStatus'), false);
    assert.equal(updates.at(-1).history.daily[0].perClient.claude.tokens, 3);
    assert.equal(updates.at(-1).history.daily[0].perClient.qodercn.tokens, 2);
    assert.equal(updates.at(-1).today.clients.claude, 3);
  } finally {
    if (handle) handle.stop();
    qoderCnUsage.collectQoderCnRows = originalRows;
    qoderCnUsage.buildQoderCnHistoryGraph = originalHistory;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('smart collection coalesces watch events into one targeted interval scan', async () => {
  const tmp = withTmpHome([
    path.join('.claude', 'projects'),
    path.join('.codex', 'sessions')
  ]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => ({
    on: (event, handler) => { if (event === 'all') watchHandler = handler; },
    close: () => {}
  });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude,codex,cursor',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 80,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: false,
      intervalRequiresActivity: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason)
    });

    await waitForCondition(() => updates.length === 1);
    watchHandler('change', path.join(tmp, '.claude', 'projects', 'one.jsonl'));
    watchHandler('change', path.join(tmp, '.claude', 'projects', 'two.jsonl'));
    watchHandler('change', path.join(tmp, '.claude', 'projects', 'three.jsonl'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 3, 'watch events never scan immediately in smart mode');

    await waitForCondition(() => updates.length === 2);
    assert.equal(calls.length, 4, 'one today-only scan acknowledges the event batch');
    assert.equal(calls[3][calls[3].indexOf('--client') + 1], 'claude,cursor');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls.length, 4, 'the acknowledged batch does not repeat');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('smart collection keeps events received during a scan pending', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => ({
    on: (event, handler) => { if (event === 'all') watchHandler = handler; },
    close: () => {}
  });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  let spawnDelayMs = 0;
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    }, spawnDelayMs);
    return child;
  };

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 40,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: false,
      intervalRequiresActivity: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason)
    });

    await waitForCondition(() => updates.length === 1);
    spawnDelayMs = 80;
    watchHandler('change', '/fake/before.jsonl');
    await waitForCondition(() => calls.length === 4);
    watchHandler('change', '/fake/during.jsonl');

    await waitForCondition(() => updates.length === 3);
    assert.equal(calls.length, 5, 'the during-scan event causes a second interval scan');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('smart collection retries a failed activity scan on the next interval', async () => {
  const tmp = withTmpHome([
    path.join('.claude', 'projects'),
    path.join('.codex', 'sessions')
  ]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => ({
    on: (event, handler) => { if (event === 'all') watchHandler = handler; },
    close: () => {}
  });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  let failNext = false;
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      if (!failNext) child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', failNext ? 1 : 0);
      failNext = false;
    });
    return child;
  };

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    const errors = [];
    handle = startCollector({
      clients: 'claude,codex,cursor',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 40,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: false,
      intervalRequiresActivity: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason),
      onError: (error) => errors.push(error.message)
    });

    await waitForCondition(() => updates.length === 1);
    failNext = true;
    watchHandler('change', path.join(tmp, '.claude', 'projects', 'session.jsonl'));
    await waitForCondition(() => errors.length === 1);
    await waitForCondition(() => updates.length === 2);
    assert.equal(calls.length, 5, 'failed and successful activity attempts each spawn once');
    assert.equal(calls[3][calls[3].indexOf('--client') + 1], 'claude,cursor');
    assert.equal(
      calls[4][calls[4].indexOf('--client') + 1],
      'claude,codex,cursor',
      'a failed targeted scan retries all clients instead of acknowledging partial data'
    );
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TOKEN_MONITOR_WATCH_POLLING overrides the native watch default', () => {
  const { resolveWatchUsePolling } = freshCollector();

  // Default is native events, and it is deliberately not platform-dependent:
  // chokidar 4 has one backend for every platform.
  assert.equal(resolveWatchUsePolling(undefined, {}), false);
  // A caller that states a preference wins over the default.
  assert.equal(resolveWatchUsePolling(true, {}), true);
  // The escape hatch beats both, in both directions — its whole purpose is
  // rescuing a filesystem whose native events never arrive.
  assert.equal(resolveWatchUsePolling(false, { TOKEN_MONITOR_WATCH_POLLING: '1' }), true);
  assert.equal(resolveWatchUsePolling(true, { TOKEN_MONITOR_WATCH_POLLING: '0' }), false);
  // Unset must stay tri-state: an empty value is not "false".
  assert.equal(resolveWatchUsePolling(false, { TOKEN_MONITOR_WATCH_POLLING: '' }), false);
  assert.equal(resolveWatchUsePolling(true, { TOKEN_MONITOR_WATCH_POLLING: '' }), true);
});

test('watch-descriptor exhaustion degrades to polling and stays there', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  const watchOptions = [];
  const errorHandlers = [];
  let closed = 0;
  chokidar.watch = (_dirs, options) => {
    watchOptions.push(options);
    return {
      on: (event, handler) => { if (event === 'error') errorHandlers.push(handler); },
      close: () => { closed += 1; }
    };
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  const logs = [];
  try {
    const { startCollector } = freshCollector();
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 1000,
      watchEnabled: true,
      limitsEnabled: false,
      historyEnabled: false,
      logger: (line) => logs.push(line),
      onUpdate: () => {}
    });

    await waitForCondition(() => errorHandlers.length === 1);
    assert.equal(watchOptions[0].usePolling, false, 'starts on native events');

    // inotify exhaustion is reported asynchronously on the watcher; without the
    // fallback the watch simply stops delivering events.
    const enospc = new Error('ENOSPC: System limit for number of file watchers reached');
    enospc.code = 'ENOSPC';
    errorHandlers[0](enospc);

    await waitForCondition(() => watchOptions.length === 2);
    assert.equal(watchOptions[1].usePolling, true, 'rebuilds the watcher with polling');
    assert.equal(watchOptions[1].interval, 2000);
    assert.equal(closed, 1, 'the exhausted native watcher is closed');
    assert.ok(logs.some((line) => line.includes('ENOSPC')));

    // A later rebuild (a client gaining a data directory) must not retry native
    // events — the budget that failed is machine-wide, not ours to reclaim.
    fs.mkdirSync(path.join(tmp, '.claude', 'transcripts'), { recursive: true });
    await handle.tick('manual');
    await waitForCondition(() => watchOptions.length === 3);
    assert.equal(watchOptions[2].usePolling, true, 'the fallback is sticky');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a successful watcher rebuild clears the current watcher failure', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchCalls = 0;
  chokidar.watch = () => {
    watchCalls += 1;
    if (watchCalls === 1) throw new Error('temporary watcher setup failure');
    return { on: () => {}, close: () => {} };
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = recordingSpawn([]);

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 1000,
      watchEnabled: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason)
    });

    assert.equal(handle.getDiagnostics().lastWatchFailureCode, 'watcher-rebuild-failed');
    await waitForCondition(() => updates.length === 1);
    assert.equal(watchCalls, 2);
    assert.equal(handle.getDiagnostics().lastWatchFailureCode, null);
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The two tests below need a home that is definitely NOT its own canonical
// path, because that is the only input under which canonicalWatchPath() does
// anything observable. Simply skipping realpath would not do it: that only
// works while os.tmpdir() happens to be non-canonical, which is true today
// (macOS /var -> /private/var, an 8.3 short path on the Windows runner) but is
// a property of the runner image rather than of this test. A fixture that can
// stop being able to fail when an image changes is exactly what this file
// refuses to rely on elsewhere.
//
// So build the real home under a canonicalised base and hand back an alias to
// it. Junction rather than symlink on Windows: junctions need neither elevation
// nor developer mode, and a junction is one of the two things
// canonicalWatchPath() exists to resolve.
function withAliasedTmpHome(prepare) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'token-monitor-alias-'));
  const real = path.join(base, 'real-home');
  const alias = path.join(base, 'alias-home');
  fs.mkdirSync(real, { recursive: true });
  for (const dir of prepare) fs.mkdirSync(path.join(real, dir), { recursive: true });
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  // Guard the fixture itself: if the alias ever stopped being non-canonical the
  // tests below would silently lose their teeth, which is the failure mode this
  // whole approach exists to avoid.
  assert.notEqual(alias, fs.realpathSync.native(alias));
  return { base, alias, real };
}

test('watch roots reach chokidar canonicalised on Windows and untouched elsewhere', async () => {
  const { base, alias, real } = withAliasedTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => alias;
  process.env.TOKEN_MONITOR_SHARED_DIR = alias;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchedDirs = null;
  chokidar.watch = (dirs) => {
    watchedDirs = dirs;
    return { on: () => {}, close: () => {} };
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 1000,
      watchEnabled: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: () => {}
    });

    await waitForCondition(() => Array.isArray(watchedDirs) && watchedDirs.length > 0);
    if (process.platform === 'win32') {
      // The junction must have been resolved away. Handing libuv a path it will
      // report events under in a different form is what fires the fs-event
      // assert, and that abort is not something the watcher can recover from.
      assert.deepEqual(watchedDirs, [path.join(real, '.claude', 'projects')]);
    } else {
      // Off Windows this must be identity: resolving here would make the watch
      // roots disagree with the paths tokscale is pointed at.
      assert.deepEqual(watchedDirs, [path.join(alias, '.claude', 'projects')]);
    }
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the ignore matcher agrees with the roots chokidar was actually handed', async () => {
  // The dangerous half of the invariant: chokidar reports events under the root
  // it was handed, so canonicalising the roots without canonicalising the
  // matcher would leave it comparing against a path no event ever carries. The
  // watch would keep working while the Hermes runtime silently stopped being
  // pruned (issue #38, 150k+ files).
  //
  // Both halves are read back off the same chokidar.watch call rather than
  // recomputed here, which is what makes this hold on every platform: it asserts
  // that the two agree, not which form they agree on.
  const { base, alias } = withAliasedTmpHome([]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  const originalHermesHome = process.env.HERMES_HOME;
  os.homedir = () => alias;
  process.env.TOKEN_MONITOR_SHARED_DIR = alias;
  const hermesHome = path.join(alias, '.hermes');
  fs.mkdirSync(hermesHome, { recursive: true });
  process.env.HERMES_HOME = hermesHome;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchedDirs = null;
  let ignored = null;
  chokidar.watch = (dirs, options) => {
    watchedDirs = dirs;
    ignored = options?.ignored;
    return { on: () => {}, close: () => {} };
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    handle = startCollector({
      clients: 'hermes',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 1000,
      watchEnabled: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: () => {}
    });

    await waitForCondition(() => Array.isArray(watchedDirs) && watchedDirs.length > 0);
    assert.equal(typeof ignored, 'function', 'a Hermes watch must carry the prune matcher');
    const watchedHome = watchedDirs[0];
    assert.equal(
      ignored(path.join(watchedHome, 'node_modules', 'anything.js')),
      true,
      'runtime files under the watched Hermes root must be pruned'
    );
    assert.equal(ignored(watchedHome), false, 'the root itself stays watched');
    assert.equal(ignored(path.join(watchedHome, 'state.db-wal')), false, 'db sidecars stay watched');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHermesHome;
    delete require.cache[collectorPath];
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('TOKEN_MONITOR_WATCH_POLLING=0 opts out of the descriptor fallback', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  const originalPolling = process.env.TOKEN_MONITOR_WATCH_POLLING;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;
  process.env.TOKEN_MONITOR_WATCH_POLLING = '0';

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  const watchOptions = [];
  const errorHandlers = [];
  chokidar.watch = (_dirs, options) => {
    watchOptions.push(options);
    return {
      on: (event, handler) => { if (event === 'error') errorHandlers.push(handler); },
      close: () => {}
    };
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 1000,
      watchEnabled: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: () => {}
    });

    await waitForCondition(() => errorHandlers.length === 1);
    const enospc = new Error('ENOSPC: System limit for number of file watchers reached');
    enospc.code = 'ENOSPC';
    errorHandlers[0](enospc);

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(watchOptions.length, 1, 'an explicit "never poll" must survive descriptor exhaustion');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (originalPolling === undefined) delete process.env.TOKEN_MONITOR_WATCH_POLLING;
    else process.env.TOKEN_MONITOR_WATCH_POLLING = originalPolling;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a non-descriptor watch error is logged without degrading to polling', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  const watchOptions = [];
  const errorHandlers = [];
  chokidar.watch = (_dirs, options) => {
    watchOptions.push(options);
    return {
      on: (event, handler) => { if (event === 'error') errorHandlers.push(handler); },
      close: () => {}
    };
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  const logs = [];
  try {
    const { startCollector } = freshCollector();
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 1000,
      watchEnabled: true,
      limitsEnabled: false,
      historyEnabled: false,
      logger: (line) => logs.push(line),
      onUpdate: () => {}
    });

    await waitForCondition(() => errorHandlers.length === 1);
    const transient = new Error('EACCES: permission denied');
    transient.code = 'EACCES';
    errorHandlers[0](transient);

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(watchOptions.length, 1, 'a permission error must not cost every user native events');
    assert.ok(logs.some((line) => line.includes('EACCES')));
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('live collection retries all clients after a failed targeted watch scan', async () => {
  const tmp = withTmpHome([
    path.join('.claude', 'projects'),
    path.join('.codex', 'sessions')
  ]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => ({
    on: (event, handler) => { if (event === 'all') watchHandler = handler; },
    close: () => {}
  });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  let failNext = false;
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      if (!failNext) child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', failNext ? 1 : 0);
      failNext = false;
    });
    return child;
  };

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    const errors = [];
    handle = startCollector({
      clients: 'claude,codex',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      // Long enough that the interval reconciliation cannot be what recovers
      // the failed client: only the next watch event may do it.
      intervalMs: 60000,
      watchEnabled: true,
      watchDebounceMs: 10,
      watchUsePolling: false,
      watchTriggersCollection: true,
      intervalRequiresActivity: false,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason),
      onError: (error) => errors.push(error.message)
    });

    await waitForCondition(() => updates.length === 1);
    const afterStartup = calls.length;

    failNext = true;
    watchHandler('change', path.join(tmp, '.claude', 'projects', 'session.jsonl'));
    await waitForCondition(() => errors.length === 1);

    // An unrelated client changes next. Without an unconditional full-scan
    // flag this tick targets only codex, leaving claude on the stale anchor
    // partition until the 5–30 minute interval — the live-mode gap.
    watchHandler('change', path.join(tmp, '.codex', 'sessions', 'rollout.jsonl'));
    await waitForCondition(() => calls.length === afterStartup + 2);

    const failed = calls[afterStartup];
    const recovery = calls[afterStartup + 1];
    assert.equal(failed[failed.indexOf('--client') + 1], 'claude');
    assert.equal(
      recovery[recovery.indexOf('--client') + 1],
      'claude,codex',
      'a failed live targeted scan retries every client on the next watch event'
    );
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('idle smart collection still performs the hourly full reconciliation', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalNow = Date.now;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  let nowMs = originalNow();
  os.homedir = () => tmp;
  Date.now = () => nowMs;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  chokidar.watch = () => ({ on: () => {}, close: () => {} });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 20,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: false,
      intervalRequiresActivity: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason)
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(calls.length, 3, 'startup performs a full scan');

    nowMs += 60 * 60 * 1000 + 1;
    await waitForCondition(() => updates.length === 2);
    assert.equal(calls.length, 6, 'hourly reconciliation performs all three period scans');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    Date.now = originalNow;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hourly smart reconciliation refreshes WSL-only usage without a host event', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalNow = Date.now;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  let nowMs = originalNow();
  os.homedir = () => tmp;
  Date.now = () => nowMs;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  chokidar.watch = () => ({ on: () => {}, close: () => {} });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = recordingSpawn([]);

  let handle = null;
  let wslCalls = 0;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude,gemini',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      platform: 'win32',
      intervalMs: 20,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: false,
      intervalRequiresActivity: true,
      limitsEnabled: false,
      historyEnabled: false,
      probeWslState: () => 'ok',
      collectWslUsage: async () => {
        wslCalls += 1;
        return { bundle: wslBundleWith('gemini', wslCalls === 1 ? 5 : 9), detected: ['gemini'] };
      },
      onUpdate: (summary) => updates.push(summary)
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(updates[0].today.clients.gemini, 5);

    nowMs += 60 * 60 * 1000 + 1;
    await waitForCondition(() => updates.length === 2);
    assert.equal(wslCalls, 2, 'hourly fallback rescans WSL');
    assert.equal(updates[1].today.clients.gemini, 9, 'fresh WSL-only usage reaches the summary');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    Date.now = originalNow;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hourly smart reconciliation starts watching a client directory created after startup', async () => {
  const tmp = withTmpHome([]);
  const originalHomedir = os.homedir;
  const originalNow = Date.now;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  let nowMs = originalNow();
  os.homedir = () => tmp;
  Date.now = () => nowMs;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchCalls = 0;
  let watchHandler = null;
  chokidar.watch = () => {
    watchCalls += 1;
    return {
      on: (event, handler) => { if (event === 'all') watchHandler = handler; },
      close: () => {}
    };
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 20,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: false,
      intervalRequiresActivity: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (summary) => updates.push(summary)
    });

    await waitForCondition(() => updates.length === 1);
    assert.equal(watchCalls, 0, 'no watcher exists for a directory absent at startup');
    assert.equal(updates[0].clientStatus.claude, 'missing');

    fs.mkdirSync(path.join(tmp, '.claude', 'projects'), { recursive: true });
    nowMs += 60 * 60 * 1000 + 1;
    await waitForCondition(() => updates.length === 2);
    assert.equal(calls.length, 6, 'missed activity is recovered by a full scan');
    assert.equal(updates[1].clientStatus.claude, 'waiting', 'new client directory is discovered');
    await waitForCondition(() => typeof watchHandler === 'function');
    assert.equal(watchCalls, 1, 'the successful full scan adds a watcher for the new directory');

    watchHandler('change', path.join(tmp, '.claude', 'projects', 'new.jsonl'));
    await waitForCondition(() => updates.length === 3);
    assert.equal(calls.length, 7, 'later activity in the new directory uses the smart interval scan');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    Date.now = originalNow;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('smart collection lets a successful manual refresh acknowledge existing activity', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => ({
    on: (event, handler) => { if (event === 'all') watchHandler = handler; },
    close: () => {}
  });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: false,
      intervalRequiresActivity: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason)
    });

    await waitForCondition(() => updates.length === 1);
    watchHandler('change', '/fake/before-manual.jsonl');
    await handle.tick('manual');
    assert.deepEqual(updates, ['interval', 'manual']);
    assert.equal(calls.length, 6, 'startup and manual refresh are full scans');

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(updates, ['interval', 'manual'], 'the next smart interval does not repeat covered activity');
    assert.equal(calls.length, 6, 'the covered activity does not cause another scan');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('smart collection acknowledges the latest activity revision after tick coalescing', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => ({
    on: (event, handler) => { if (event === 'all') watchHandler = handler; },
    close: () => {}
  });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  let spawnDelayMs = 0;
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    }, spawnDelayMs);
    return child;
  };

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 40,
      watchEnabled: true,
      watchUsePolling: false,
      watchTriggersCollection: false,
      intervalRequiresActivity: true,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason)
    });

    await waitForCondition(() => updates.length === 1);
    await new Promise((resolve) => setImmediate(resolve));
    spawnDelayMs = 35;
    const manualTick = handle.tick('manual');
    await waitForCondition(() => calls.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    watchHandler('change', '/fake/during-manual.jsonl');

    await manualTick;
    await waitForCondition(() => updates.length === 3);
    assert.deepEqual(updates, ['interval', 'manual', 'coalesced']);
    // 3 + 3 + 1: the replay honours what the ticks folded into it actually
    // asked for. Only the anchored interval tick was pending here, so it stays
    // the `--today` scan it would have been on its own. A pending manual tick,
    // or an interval tick due for its hourly reconciliation, omits todayOnly
    // and drags the replay back to a full scan.
    assert.equal(calls.length, 7, 'the coalesced replay is the warm scan the pending interval tick requested');

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(updates.length, 3, 'coalesced scan acknowledges activity and prevents a redundant interval');
    assert.equal(calls.length, 7, 'no redundant scan runs on the next interval');
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// tokscale resolves opencode, zed and micode through `PathRoot::XdgData`
// (clients.rs) and the CodeBuddy extension logs through `dirs::data_local_dir()`,
// which is the XDG data home on Linux. Kiro's CLI database is the deliberate
// exception: tokscale spells it as a home-relative literal, so following XDG
// there would watch a directory it never reads.
test('XDG_DATA_HOME moves exactly the roots tokscale resolves through it', () => {
  const tmp = withTmpHome([]);
  const xdg = path.join(tmp, 'custom-xdg');
  for (const dir of ['opencode', 'zed/threads', 'mimocode', 'CodeBuddyExtension/Logs']) {
    fs.mkdirSync(path.join(xdg, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(tmp, '.local', 'share', 'kiro-cli'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'AppData', 'Local', 'CodeBuddyExtension', 'Logs'), { recursive: true });
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  process.env.XDG_DATA_HOME = xdg;
  try {
    const { watchPathsForClients } = freshCollector();
    const roots = watchPathsForClients('opencode,zed,micode,codebuddy,kiro');
    assert.ok(roots.includes(path.join(xdg, 'opencode')));
    assert.ok(roots.includes(path.join(xdg, 'zed', 'threads')));
    assert.ok(roots.includes(path.join(xdg, 'mimocode')));
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      assert.ok(roots.includes(path.join(xdg, 'CodeBuddyExtension', 'Logs')));
    }
    // tokscale seeds its CodeBuddy log list with the home-relative
    // Windows-shaped path on every platform, so a home carried over from
    // Windows has to be watched here too, not only scanned periodically.
    assert.ok(roots.includes(path.join(tmp, 'AppData', 'Local', 'CodeBuddyExtension', 'Logs')));
    // Home-relative in tokscale, so it must NOT follow XDG.
    assert.ok(roots.includes(path.join(tmp, '.local', 'share', 'kiro-cli')));
    assert.ok(!roots.includes(path.join(xdg, 'kiro-cli')));
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an unset XDG_DATA_HOME falls back to the .local/share roots', () => {
  const tmp = withTmpHome([
    path.join('.local', 'share', 'opencode'),
    path.join('.local', 'share', 'zed', 'threads'),
    path.join('.local', 'share', 'mimocode')
  ]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { watchPathsForClients } = freshCollector();
    const roots = watchPathsForClients('opencode,zed,micode');
    assert.ok(roots.includes(path.join(tmp, '.local', 'share', 'opencode')));
    assert.ok(roots.includes(path.join(tmp, '.local', 'share', 'zed', 'threads')));
    assert.ok(roots.includes(path.join(tmp, '.local', 'share', 'mimocode')));
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// tokscale treats a whitespace-only KIMI_CODE_HOME as unset because it joins
// `sessions` onto the raw value: a blank export would resolve to the root-level
// /sessions, hiding the real one and pointing the walker somewhere unrelated.
test('a whitespace-only KIMI_CODE_HOME falls back instead of watching /sessions', () => {
  const tmp = withTmpHome([path.join('.kimi-code', 'sessions')]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  process.env.KIMI_CODE_HOME = '   ';
  try {
    const { watchPathsForClients } = freshCollector();
    const roots = watchPathsForClients('kimi');
    assert.ok(roots.includes(path.join(tmp, '.kimi-code', 'sessions')));
    assert.ok(!roots.some((root) => root.trim().startsWith(path.sep + 'sessions')));
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// A custom exporter's parent has to be watched (the file may not exist yet) but
// must never become a copilot attribution prefix: pointed at a file in $HOME it
// would make every other client's event target copilot too, turning each
// targeted --today scan into a two-client scan.
test('a custom Copilot exporter watches its parent without attributing it', () => {
  const tmp = withTmpHome([path.join('.claude', 'projects'), '.copilot']);
  const exporter = path.join(tmp, 'copilot-otel.jsonl');
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = exporter;
  try {
    const { watchPathsForClients, watchAttributionRootsForClients, clientsForWatchPath } = freshCollector();
    const clients = 'claude,copilot';
    // The parent is still watched, otherwise a later-created file is invisible.
    assert.ok(watchPathsForClients(clients).includes(tmp));

    const attribution = watchAttributionRootsForClients(clients);
    assert.ok(!attribution.copilot.includes(tmp), 'the exporter parent must not be an attribution prefix');
    assert.ok(attribution.copilot.some((root) => path.resolve(root) === path.resolve(exporter)));

    // A Claude transcript write targets Claude alone.
    assert.deepEqual(
      clientsForWatchPath(path.join(tmp, '.claude', 'projects', 'a.jsonl'), attribution),
      ['claude']
    );
    // The exporter file itself is what makes an event a Copilot event.
    assert.deepEqual(clientsForWatchPath(exporter, attribution), ['copilot']);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// An exporter written straight into ~/.copilot shares its parent with the
// copilot-data root, which owns that prefix for `otel/`. Dropping it there would
// silence the OTel tree, so the parent survives when another source owns it.
test('an exporter inside ~/.copilot keeps the data root as an attribution prefix', () => {
  const tmp = withTmpHome([path.join('.copilot', 'otel')]);
  const exporter = path.join(tmp, '.copilot', 'custom.jsonl');
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = exporter;
  try {
    const { watchAttributionRootsForClients, clientsForWatchPath } = freshCollector();
    const attribution = watchAttributionRootsForClients('copilot');
    assert.deepEqual(
      clientsForWatchPath(path.join(tmp, '.copilot', 'otel', 'a.jsonl'), attribution),
      ['copilot']
    );
    assert.deepEqual(clientsForWatchPath(exporter, attribution), ['copilot']);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The diagnostics panel prints `dir` and colours it by `exists`. For an
// exact-file source those have to describe the same filesystem entity, or the
// panel calls a directory that is plainly there missing.
test('exact-file sources report the file they probed, not the watch parent', () => {
  const tmp = withTmpHome(['.copilot', path.join('.grok', 'logs'), path.join('.zcode', 'cli', 'db')]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { clientDiagnosticRoots } = freshCollector();
    const roots = clientDiagnosticRoots('copilot,grok,zcode');
    const find = (client, id) => (roots[client] || []).find((root) => root.id === id);

    const copilotData = find('copilot', 'copilot-data');
    assert.equal(copilotData.dir, path.join(tmp, '.copilot', 'data.db'));
    assert.equal(copilotData.exists, false);
    assert.equal(copilotData.sourcePath, path.join(tmp, '.copilot', 'data.db'));

    assert.equal(find('grok', 'grok-unified-log').dir, path.join(tmp, '.grok', 'logs', 'unified.jsonl'));
    assert.equal(find('zcode', 'zcode-cli-db').dir, path.join(tmp, '.zcode', 'cli', 'db', 'db.sqlite'));

    fs.writeFileSync(path.join(tmp, '.copilot', 'data.db'), '');
    const afterCreate = clientDiagnosticRoots('copilot').copilot.find((root) => root.id === 'copilot-data');
    assert.equal(afterCreate.exists, true);

    // A directory source keeps reporting its directory and carries no sourcePath,
    // which is what makes the reveal handler pick openPath over showItemInFolder.
    const otel = find('copilot', 'copilot-otel');
    assert.equal(otel.dir, path.join(tmp, '.copilot', 'otel'));
    assert.equal(otel.sourcePath, undefined);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Tokscale headless capture roots are optional only while they are the defaults', () => {
  const tmp = withTmpHome([path.join('.codex', 'sessions')]);
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  try {
    const { clientDiagnosticRoots, clientSourceChecks, visibleDiagnosticRoots } = freshCollector();
    const headless = (roots) => roots.filter((root) => root.dir.includes('headless'));
    const capture = path.join(tmp, '.config', 'tokscale', 'headless', 'codex');

    const probed = clientDiagnosticRoots('codex').codex;
    assert.deepEqual(headless(probed).map((root) => root.dir), [
      capture,
      path.join(tmp, 'Library', 'Application Support', 'tokscale', 'headless', 'codex')
    ]);
    assert.ok(headless(probed).every((root) => root.optional === true));
    // The roots Codex itself writes are never optional: their absence is the
    // one thing the panel exists to report.
    assert.ok(probed.filter((root) => !root.dir.includes('headless')).every((root) => root.optional === undefined));

    // The panel-facing list drops them while they are absent...
    assert.deepEqual(visibleDiagnosticRoots('codex').codex.map((root) => root.dir), [
      path.join(tmp, '.codex', 'sessions'),
      path.join(tmp, '.codex', 'archived_sessions')
    ]);

    // ...and stops dropping one the moment it exists, because by then it is
    // contributing tokens. Nothing else has to change for it to reappear.
    fs.mkdirSync(capture, { recursive: true });
    assert.deepEqual(visibleDiagnosticRoots('codex').codex.map((root) => root.dir), [
      path.join(tmp, '.codex', 'sessions'),
      path.join(tmp, '.codex', 'archived_sessions'),
      capture
    ]);
    fs.rmSync(capture, { recursive: true, force: true });

    // Hiding is a display choice, so the health check is untouched either way —
    // one id for every Codex root, still detected because ~/.codex/sessions is there.
    assert.deepEqual(clientSourceChecks('codex').codex, [{ id: 'codex-sessions', exists: true }]);

    // An explicitly configured root replaces the pair and is not optional, so it
    // survives the panel-facing filter while missing: the user named that path.
    process.env.TOKSCALE_HEADLESS_DIR = path.join(tmp, 'capture');
    const configured = visibleDiagnosticRoots('codex').codex;
    assert.deepEqual(headless(configured), []);
    const named = configured.find((root) => root.dir.startsWith(path.join(tmp, 'capture')));
    assert.equal(named.dir, path.join(tmp, 'capture', 'codex'));
    assert.equal(named.exists, false);
    assert.equal(named.optional, undefined);
  } finally {
    os.homedir = originalHomedir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the quit variant of stop() skips the watcher walk and leans on `stopped`', async () => {
  const tmp = withTmpHome([path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  let closeCalls = 0;
  chokidar.watch = () => {
    const watcher = {
      on(event, handler) {
        if (event === 'all') watchHandler = handler;
        return watcher;
      },
      close() { closeCalls += 1; }
    };
    return watcher;
  };

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = recordingSpawn(calls);

  const collectorOptions = {
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'test-device',
    agentVersion: 'test',
    intervalMs: 60 * 60 * 1000,
    watchEnabled: true,
    watchUsePolling: false,
    watchTriggersCollection: true,
    watchDebounceMs: 10,
    limitsEnabled: false,
    historyEnabled: false,
    anchorPersistenceEnabled: false
  };

  let replaced = null;
  let quitting = null;
  try {
    const { startCollector } = freshCollector();

    // A mode switch has to hand the same paths to a new watcher, so the old one
    // is really closed even though chokidar's close() walks the whole tree.
    const replacedUpdates = [];
    replaced = startCollector({ ...collectorOptions, onUpdate: () => replacedUpdates.push(1) });
    await waitForCondition(() => replacedUpdates.length === 1);
    assert.ok(watchHandler, 'watcher handler captured');
    replaced.stop();
    assert.equal(closeCalls, 1);

    // Quit teardown runs inline ahead of the exit, where that same walk reads as a
    // hang, so it is skipped and the OS reclaims the handles at exit instead.
    const quittingUpdates = [];
    quitting = startCollector({ ...collectorOptions, onUpdate: () => quittingUpdates.push(1) });
    await waitForCondition(() => quittingUpdates.length === 1);
    const spawnsBeforeStop = calls.length;
    quitting.stop({ skipCloseWatchers: true });
    assert.equal(closeCalls, 1, 'the quit path never walks the watch tree');

    // Leaving the watcher open is only safe because `stopped` severs it: an event
    // that lands in the gap before the process goes must not start another scan.
    watchHandler('change', path.join(tmp, '.claude', 'projects', 'demo.jsonl'));
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    assert.equal(calls.length, spawnsBeforeStop, 'a late event cannot spawn another scan');
    assert.equal(quittingUpdates.length, 1);
  } finally {
    if (replaced) replaced.stop();
    if (quitting) quitting.stop({ skipCloseWatchers: true });
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
