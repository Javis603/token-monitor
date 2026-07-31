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

const collectorPath = require.resolve('../../src/shared/collector');

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

test('watchPathsForClients watches the Antigravity CLI data dir but not the IDE sync cache', () => {
  // antigravity is self-synced (its IDE cache is watch-excluded to avoid the
  // issue #15 loop), but the CLI writes parse-local SQLite we don't touch, so it
  // must be watched for the seconds-level refresh the sync path can't give.
  const tmp = withTmpHome([
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
    assert.ok(dirs.includes(path.join(tmp, '.copilot', 'otel')));
    assert.ok(dirs.includes(path.join(tmp, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')));
    assert.deepEqual(clientDataDirPresence('copilot'), { copilot: true });
  } finally {
    os.homedir = originalHomedir;
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

test('watchPathsForClients watches Pi (incl. Oh My Pi), Zed (incl. native macOS), Kilo Code (only tokscale-scanned roots), and Kiro (CLI + IDE + kiro-cli roots)', () => {
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
    // Kiro: tokscale reads the sessions tree for both CLI and IDE, the Kiro IDE
    // globalStorage root, and the kiro-cli sqlite dir — all home-relative, so we
    // watch each.
    assert.ok(dirs.includes(path.join(tmp, '.kiro', 'sessions')));
    assert.ok(dirs.includes(path.join(tmp, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')));
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
