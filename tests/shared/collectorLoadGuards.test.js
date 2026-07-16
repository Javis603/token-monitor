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

const collectorPath = require.resolve('../../src/shared/collector');

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

function withTmpHome(prepare) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-home-'));
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
