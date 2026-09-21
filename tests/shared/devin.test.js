'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  clientSourceChecks, clientSourceRoots, clientWatchCandidates,
  clientsForWatchPath, deriveClientHealth, tokscaleClientFilter,
  watchAttributionRootsForClients, watchIgnoreMatcher, watchPathsForClients
} = require('../../src/shared/collector');
const { normalizeClientHealth } = require('../../src/shared/clientHealth');
const { clientsCsvForSetting, DEFAULT_CLIENTS, PARSE_LOCAL_CLIENTS } = require('../../src/shared/clientTracking');
const { extractUsageFromTokscale, normalizeClientName } = require('../../src/shared/usage');
const { normalizeTokscaleClientName } = require('../../src/shared/history');
const { homeHasData } = require('../../src/shared/wslUsage');
const { projectIdentity } = require('../../src/shared/sessionMetadata');
const devinSessionMetadata = require('../../src/shared/providers/devin/sessionMetadata');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const maybe = sqlite ? test : test.skip;

installSourceEnvGuard(test);

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHome(prefix = 'devin-home-') {
  // Windows CI uses an 8.3 temp path; match the collector's canonical watch roots.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

const isoFromDate = (value) => {
  const date = value instanceof Date ? value : new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

test('Devin source roots mirror the upstream CLI and Desktop scan roots', () => {
  const home = '/home/u';
  const roots = clientSourceRoots('devin', { homeDir: home, env: {}, platform: 'linux' }).devin;
  const cliDirs = roots.filter((root) => root.id === 'devin-cli-db');
  const desktopDirs = roots.filter((root) => root.id === 'devin-desktop-acp');
  assert.deepEqual(cliDirs.map((root) => root.dir), [
    '/home/u/.local/share/devin/cli',
    '/home/u/AppData/Roaming/devin/cli'
  ]);
  for (const root of cliDirs) {
    assert.equal(root.sourcePath, path.join(root.dir, 'sessions.db'));
  }
  assert.deepEqual(desktopDirs.map((root) => root.dir), [
    '/home/u/Library/Application Support/Devin/User/acp-events',
    '/home/u/.config/Devin/User/acp-events',
    '/home/u/.config/devin/User/acp-events',
    '/home/u/AppData/Roaming/Devin/User/acp-events'
  ]);
  assert.equal(clientSourceRoots('codex', { homeDir: home, env: {}, platform: 'linux' }).devin, undefined);
});

test('Devin CLI roots follow XDG_DATA_HOME and Windows APPDATA like tokscale', () => {
  const xdgRoots = clientSourceRoots('devin', {
    homeDir: '/home/u', env: { XDG_DATA_HOME: '/data/xdg' }, platform: 'linux'
  }).devin;
  assert.equal(xdgRoots[0].dir, '/data/xdg/devin/cli');

  const winRoots = clientSourceRoots('devin', {
    homeDir: 'C:\\Users\\u', env: { APPDATA: 'D:\\Roaming' }, platform: 'win32'
  }).devin;
  const cliDirs = winRoots.filter((root) => root.id === 'devin-cli-db').map((root) => root.dir);
  const desktopDirs = winRoots.filter((root) => root.id === 'devin-desktop-acp').map((root) => root.dir);
  assert.ok(cliDirs.includes('D:\\Roaming\\devin\\cli'));
  assert.ok(cliDirs.includes('C:\\Users\\u\\AppData\\Roaming\\devin\\cli'));
  assert.ok(desktopDirs.includes('D:\\Roaming\\Devin\\User\\acp-events'));
  assert.ok(desktopDirs.includes('C:\\Users\\u\\AppData\\Roaming\\Devin\\User\\acp-events'));
});

test('devin expands to the two concrete tokscale clients, never the bare umbrella id', () => {
  assert.equal(tokscaleClientFilter('devin'), 'devin-cli,devin-desktop');
  assert.equal(tokscaleClientFilter('codex,devin'), 'codex,devin-cli,devin-desktop');
  // devin-desktop scans pull devin-cli metadata lookups upstream too, so the
  // alias pair always travels together.
  assert.equal(tokscaleClientFilter('devin,devin'), 'devin-cli,devin-desktop');
  assert.ok(DEFAULT_CLIENTS.split(',').includes('devin'));
  assert.ok(!PARSE_LOCAL_CLIENTS.includes('devin'));
});

test('devin concrete ids normalize to the umbrella client everywhere', () => {
  for (const name of ['devin', 'Devin', 'devin-cli', 'devin-desktop', 'Devin CLI']) {
    assert.equal(normalizeClientName(name), 'devin', name);
  }
  // history.js only folds the exact wire ids tokscale emits — display-name
  // heuristics stay in usage.js.
  for (const id of ['devin', 'devin-cli', 'devin-desktop']) {
    assert.equal(normalizeTokscaleClientName(id), 'devin', id);
  }
  assert.equal(clientsCsvForSetting('codex,devin-cli'), 'codex,devin');
  assert.equal(clientsCsvForSetting('devin-desktop,devin'), 'devin');
  assert.equal(clientsCsvForSetting(''), '');
});

test('Devin usage rows from either concrete client merge into one client partition', () => {
  const period = extractUsageFromTokscale([
    { client: 'devin-cli', model: 'swe-2-max', totalTokens: 140, cost: 0.01 },
    { client: 'devin-desktop', model: 'swe-2-max', totalTokens: 60, cost: 0.004 }
  ]);
  assert.equal(period.totalTokens, 200);
  assert.equal(period.clients.devin, 200);
  assert.equal(period.clients['devin-cli'], undefined);
  assert.equal(period.clients['devin-desktop'], undefined);
  assert.equal(period.costUsd, 0.014);
  assert.equal(period.clientCosts.devin, 0.014);
});

test('Devin health requires the CLI database or a Desktop acp-events dir', () => {
  const home = tempHome();
  const env = {};
  const missing = clientSourceChecks('devin', { homeDir: home, env, platform: process.platform });
  assert.deepEqual(missing.devin, [
    { id: 'devin-cli-db', exists: false },
    { id: 'devin-desktop-acp', exists: false }
  ]);
  const health = deriveClientHealth('devin', { clients: {} }, { sourceChecks: missing });
  assert.equal(normalizeClientHealth(health).clients.devin.source.state, 'missing');

  const cliDir = path.join(home, '.local', 'share', 'devin', 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  assert.equal(clientSourceChecks('devin', { homeDir: home, env, platform: process.platform }).devin[0].exists, false);
  fs.writeFileSync(path.join(cliDir, 'sessions.db'), '');
  let checks = clientSourceChecks('devin', { homeDir: home, env, platform: process.platform });
  assert.equal(checks.devin.find((check) => check.id === 'devin-cli-db').exists, true);
  assert.equal(deriveClientHealth('devin', { clients: {} }, { sourceChecks: checks }).clients.devin.source.state, 'detected');

  const acpDir = path.join(home, '.config', 'Devin', 'User', 'acp-events');
  fs.mkdirSync(acpDir, { recursive: true });
  checks = clientSourceChecks('devin', { homeDir: home, env, platform: process.platform });
  assert.equal(checks.devin.find((check) => check.id === 'devin-desktop-acp').exists, true);
});

test('Devin watches the CLI db family only; acp-events stays a recursive event tree', () => {
  const home = tempHome();
  const options = { homeDir: home, env: {}, platform: process.platform };
  const cliDir = path.join(home, '.local', 'share', 'devin', 'cli');
  const acpDir = path.join(home, '.config', 'Devin', 'User', 'acp-events');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.mkdirSync(acpDir, { recursive: true });
  assert.ok(clientWatchCandidates('devin', options).devin.includes(cliDir));
  assert.ok(watchPathsForClients('devin', options).includes(acpDir));

  const ignored = watchIgnoreMatcher('devin', options);
  const roots = watchAttributionRootsForClients('devin', null, options);
  assert.equal(ignored(cliDir), false);
  for (const name of ['sessions.db', 'sessions.db-wal', 'sessions.db-shm']) {
    const file = path.join(cliDir, name);
    assert.equal(ignored(file), false, name);
    assert.deepEqual(clientsForWatchPath(file, roots), ['devin']);
  }
  for (const name of ['logs', 'logs/app.log', 'other.db', 'sessions.db.bak', 'nested/sessions.db']) {
    assert.equal(ignored(path.join(cliDir, name)), true, name);
  }
  assert.equal(ignored(path.join(acpDir, 'session-1.ndjson')), false);
  assert.equal(ignored(path.join(acpDir, 'nested', 'event.ndjson')), false);
});

maybe('Devin session metadata resolves titles, timestamps and projects from sessions.db', () => {
  const home = tempHome('devin-meta-');
  const cliDir = path.join(home, '.local', 'share', 'devin', 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  const dbPath = path.join(cliDir, 'sessions.db');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('lavender-flock', 'E:\\tokenMonitor', 'windsurf', 'swe-2-max', 'bypass', 1789951333, 1789952964, 'add devin support');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('shadow-bumper', 'E:\\other', 'windsurf', 'swe-2-max', 'bypass', 1789951131, 1789952963, null);
  db.close();

  const context = {
    deps: { env: {} },
    home,
    resolveProjects: true,
    projectIdentity,
    isoFromDate
  };
  const resolved = devinSessionMetadata.resolveSessionMetadata(
    new Set(['lavender-flock', 'shadow-bumper', 'unknown-session']), context
  );
  const titled = resolved.get('lavender-flock');
  assert.equal(titled.title, 'add devin support');
  assert.equal(titled.startedAt, isoFromDate(1789951333 * 1000));
  assert.equal(titled.lastUsedAt, isoFromDate(1789952964 * 1000));
  assert.equal(titled.projectId, projectIdentity('E:\\tokenMonitor').projectId);
  assert.equal(titled.projectLabel, 'tokenMonitor');

  const untitled = resolved.get('shadow-bumper');
  assert.equal(untitled.title, undefined);
  assert.equal(untitled.startedAt, isoFromDate(1789951131 * 1000));
  assert.equal(resolved.has('unknown-session'), false);
});

maybe('Devin session metadata survives a minimal older schema', () => {
  const home = tempHome('devin-meta-min-');
  const cliDir = path.join(home, '.local', 'share', 'devin', 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(cliDir, 'sessions.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('old-session', 1789950000, 1789950100);
  db.close();

  const resolved = devinSessionMetadata.resolveSessionMetadata(new Set(['old-session']), {
    deps: { env: {} },
    home,
    resolveProjects: true,
    projectIdentity,
    isoFromDate
  });
  assert.deepEqual(resolved.get('old-session'), {
    startedAt: isoFromDate(1789950000 * 1000),
    lastUsedAt: isoFromDate(1789950100 * 1000)
  });
});

test('WSL discovery recognizes the Devin CLI database and Desktop event dir', () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  assert.deepEqual(homeHasData(home, () => false), []);
  assert.deepEqual(
    homeHasData(home, (file) => file === `${home}\\.local\\share\\devin\\cli\\sessions.db`),
    ['devin']
  );
  assert.deepEqual(
    homeHasData(home, (file) => file === `${home}\\.config\\Devin\\User\\acp-events`),
    ['devin']
  );
  // The Windows-shaped root needs the database itself — an empty cli dir is
  // not evidence Devin ever ran here.
  assert.deepEqual(
    homeHasData(home, (file) => file === `${home}\\AppData\\Roaming\\devin\\cli`),
    []
  );
  assert.deepEqual(
    homeHasData(home, (file) => file === `${home}\\AppData\\Roaming\\devin\\cli\\sessions.db`),
    ['devin']
  );
});

test('Devin paths keep a literal backslash in a POSIX home', () => {
  // A backslash is a valid POSIX filename character; treating it as a
  // separator boundary would resolve the wrong directory.
  const roots = clientSourceRoots('devin', { homeDir: '/home/u\\', env: {}, platform: 'linux' }).devin;
  const cliDirs = roots.filter((root) => root.id === 'devin-cli-db');
  assert.equal(cliDirs[0].dir, '/home/u\\/.local/share/devin/cli');
});

test('Devin session metadata does not cache a transient sqlite failure', () => {
  const home = tempHome('devin-meta-retry-');
  const cliDir = path.join(home, '.local', 'share', 'devin', 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'sessions.db'), 'x');
  let opens = 0;
  const flaky = {
    DatabaseSync: class {
      constructor() { opens += 1; if (opens === 1) throw new Error('locked'); }
      prepare() {
        return { all: () => [{ id: 's1', title: 'T', working_directory: '/p', created_at: 1, last_activity_at: 2 }] };
      }
      close() {}
    }
  };
  const context = {
    deps: { sqlite: flaky, env: {}, platform: process.platform },
    home,
    isoFromDate,
    projectIdentity
  };
  assert.equal(devinSessionMetadata.resolveSessionMetadata(['s1'], context).has('s1'), false);
  assert.equal(devinSessionMetadata.resolveSessionMetadata(['s1'], context).get('s1').title, 'T');
});
