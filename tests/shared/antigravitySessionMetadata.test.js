'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { applySessionMetadata, projectIdentity } = require('../../src/shared/sessionMetadata');
const { collectUsageOnce, localTodayKey, startCollector } = require('../../src/shared/collector');
const { sessionActivityState } = require('../../src/shared/sessionLive');
const { projectRollupFromSessions } = require('../../src/shared/usage');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');
const {
  cleanTitle,
  antigravityConversationSummaryCandidates,
  resolveSessionMetadata
} = require('../../src/shared/providers/antigravity/sessionMetadata');

let sqlite;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

installSourceEnvGuard(test);

function summaryStore(t) {
  const temp = fs.realpathSync.native(os.tmpdir());
  const home = fs.mkdtempSync(path.join(temp, 'antigravity-metadata-'));
  const dir = path.join(home, '.gemini', 'antigravity');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'conversation_summaries.db');
  const db = new sqlite.DatabaseSync(dbPath);
  let closed = false;
  const close = () => {
    if (closed) return;
    db.close();
    closed = true;
  };
  t.after(() => {
    close();
    assert.ok(path.resolve(home).startsWith(path.resolve(temp) + path.sep));
    fs.rmSync(home, { recursive: true, force: true });
  });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
    workspace_uris TEXT, last_modified_time TEXT
  )`);
  const put = db.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?, ?)');
  return { home, dir, db, dbPath, put, close, deps: { sqlite, env: {}, antigravityTitleCache: new Map() } };
}

test('cleanTitle strips whitespace and limits code points', () => {
  assert.equal(cleanTitle('  Hello   World  '), 'Hello World');
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle(null), '');
  const long = 'a'.repeat(200);
  assert.equal(cleanTitle(long).length, 96);
});

test('antigravityConversationSummaryCandidates includes data roots and env', () => {
  const home = '/fake/home';
  const candidates = antigravityConversationSummaryCandidates({
    home,
    env: { ANTIGRAVITY_HOME: '/custom/antigravity' }
  });
  assert.ok(candidates.includes(path.join('/custom/antigravity', 'conversation_summaries.db')));
  assert.ok(candidates.includes(path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db')));
  assert.ok(candidates.includes(path.join(home, '.gemini', 'antigravity-ide', 'conversation_summaries.db')));
});

test('Antigravity joins conversation_summaries titles by conversation id and sees later updates', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-titles-'));
  const dbDir = path.join(home, '.gemini', 'antigravity');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'conversation_summaries.db');
  const db = new sqlite.DatabaseSync(dbPath);

  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      preview TEXT NOT NULL DEFAULT "",
      workspace_uris TEXT,
      last_modified_time TEXT
    )
  `);

  const put = db.prepare(`
    INSERT OR REPLACE INTO conversation_summaries
    (conversation_id, title, preview, workspace_uris, last_modified_time)
    VALUES (?, ?, ?, ?, ?)
  `);

  const workspaceDir = path.join(home, 'my-project');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const workspaceUri = pathToFileURL(workspaceDir).href;

  put.run('session-1', '  Fix   auth  bug  ', '', JSON.stringify([workspaceUri]), '2026-10-09 10:00:00.000+00:00');
  put.run('session-2', '', 'Fallback preview title', null, '2026-10-09 11:00:00.000+00:00');
  put.run('session-3', '', '', null, null);

  const cache = new Map();
  const projectIdentity = (dir) => ({ projectId: `proj:${path.basename(dir)}`, projectLabel: path.basename(dir) });
  const deps = { sqlite, antigravityTitleCache: cache };
  const context = { home, deps, resolveProjects: true, projectIdentity };

  const resolved = resolveSessionMetadata(new Set(['session-1', 'session-2', 'session-3', 'missing']), context);
  assert.equal(resolved.get('session-1')?.title, 'Fix auth bug');
  assert.equal(resolved.get('session-1')?.projectLabel, 'my-project');
  assert.equal(resolved.get('session-1')?.lastUsedAt, undefined, 'catalog modification time is not generation activity');
  assert.equal(resolved.get('session-2')?.title, 'Fallback preview title');
  assert.equal(resolved.get('session-3')?.catalogTitle, null, 'a successful empty row is clearing evidence');
  assert.equal(resolved.has('missing'), false);

  const periods = {
    today: {
      sessions: {
        'antigravity:session-1': { client: 'antigravity', sessionId: 'session-1' },
        'antigravity:session-2': { client: 'antigravity', sessionId: 'session-2' },
        'antigravity:missing': { client: 'antigravity', sessionId: 'missing' }
      }
    }
  };

  const metadataCache = new Map();
  const sharedDeps = { ...deps, metadataCache, resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set(), retryMisses: true };
  applySessionMetadata(periods, home, sharedDeps);

  assert.equal(periods.today.sessions['antigravity:session-1'].title, 'Fix auth bug');
  assert.equal(periods.today.sessions['antigravity:session-1'].projectLabel, 'my-project');
  assert.equal(periods.today.sessions['antigravity:session-2'].title, 'Fallback preview title');
  assert.equal(periods.today.sessions['antigravity:missing'].title, undefined);

  // Update conversation title (simulating rename in Antigravity in the next collector tick)
  put.run('session-1', 'Renamed auth bug title', '', JSON.stringify([workspaceUri]), '2026-10-09 12:00:00.000+00:00');
  const nextTickDeps = { ...deps, metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set(), retryMisses: true };
  applySessionMetadata(periods, home, nextTickDeps);
  assert.equal(periods.today.sessions['antigravity:session-1'].title, 'Renamed auth bug title');
});

test('Antigravity returns empty when database or table is missing', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-empty-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const deps = { sqlite, antigravityTitleCache: new Map() };
  const resolved = resolveSessionMetadata(new Set(['some-id']), { home, deps });
  assert.equal(resolved.size, 0);

  // Database exists but table does not
  const dbDir = path.join(home, '.gemini', 'antigravity');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dbDir, 'conversation_summaries.db'));
  db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
  db.close();

  const resolved2 = resolveSessionMetadata(new Set(['some-id']), { home, deps });
  assert.equal(resolved2.size, 0);
});

test('Antigravity does not reopen the database for sessions the fingerprint already missed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-miss-'));
  const dbDir = path.join(home, '.gemini', 'antigravity');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'conversation_summaries.db');
  fs.writeFileSync(dbPath, 'stub');
  let opens = 0;
  let queries = 0;
  const fakeSqlite = {
    DatabaseSync: class {
      constructor() { opens += 1; }
      prepare(sql) {
        return {
          get: () => {
            queries += 1;
            if (sql.includes('sqlite_master')) return { 1: 1 };
            return undefined;
          }
        };
      }
      exec() {}
      close() {}
    }
  };

  const deps = { sqlite: fakeSqlite, antigravityTitleCache: new Map() };
  const first = resolveSessionMetadata(new Set(['no-summary']), { home, deps });
  assert.equal(first.size, 0);
  assert.equal(opens, 1);

  const second = resolveSessionMetadata(new Set(['no-summary']), { home, deps });
  assert.equal(second.size, 0);
  assert.equal(opens, 1, 'a definitive miss is cached per fingerprint, so the DB is not reopened');
  assert.ok(queries > 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Antigravity handles encoded file URIs and invalid JSON', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-uris-'));
  const dbDir = path.join(home, '.gemini', 'antigravity');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'conversation_summaries.db');
  const db = new sqlite.DatabaseSync(dbPath);
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      preview TEXT NOT NULL DEFAULT "",
      workspace_uris TEXT,
      last_modified_time TEXT
    )
  `);
  const put = db.prepare(`
    INSERT INTO conversation_summaries (conversation_id, title, preview, workspace_uris, last_modified_time)
    VALUES (?, ?, ?, ?, ?)
  `);
  put.run('s-encoded', 'Encoded URI Title', '', JSON.stringify(['file:///e%3A/project/my-repo']), null);
  put.run('s-badjson', 'Bad JSON Title', '', '{invalid-json', null);
  put.run('s-nonfile', 'Non-file URI Title', '', JSON.stringify(['http://localhost:3000']), null);

  const deps = { sqlite, platform: 'win32', antigravityTitleCache: new Map() };
  const context = { home, deps, resolveProjects: true, projectIdentity };

  const resolved = resolveSessionMetadata(new Set(['s-encoded', 's-badjson', 's-nonfile']), context);
  assert.equal(resolved.get('s-encoded')?.title, 'Encoded URI Title');
  assert.equal(resolved.get('s-encoded')?.projectLabel, 'my-repo');
  assert.equal(resolved.get('s-encoded')?.projectId, projectIdentity('E:/project/my-repo').projectId);
  assert.equal(resolved.get('s-badjson')?.title, 'Bad JSON Title');
  assert.equal(resolved.get('s-badjson')?.projectId, undefined);
  assert.equal(resolved.get('s-nonfile')?.title, 'Non-file URI Title');
  assert.equal(resolved.get('s-nonfile')?.projectId, undefined);
});

test('Antigravity cached source rows follow Projects changes without reopening SQLite', { skip: !sqlite }, (t) => {
  const store = summaryStore(t);
  const workspace = path.join(store.home, 'project');
  const uris = JSON.stringify([pathToFileURL(workspace).href]);
  store.put.run('named', 'Project title', '', uris, null);
  store.put.run('workspace-only', '', '', uris, null);
  let opens = 0;
  const deps = {
    ...store.deps,
    sqlite: { DatabaseSync: class {
      constructor(...args) { opens += 1; return new sqlite.DatabaseSync(...args); }
    } }
  };
  const context = { home: store.home, deps, projectIdentity };
  const ids = new Set(['named', 'workspace-only']);
  for (const enabled of [false, true, false, true]) {
    const resolved = resolveSessionMetadata(ids, { ...context, resolveProjects: enabled });
    assert.equal(resolved.get('named').title, 'Project title');
    assert.equal(resolved.get('named').projectId, enabled ? projectIdentity(workspace).projectId : undefined);
    assert.equal(resolved.get('workspace-only')?.projectId, enabled ? projectIdentity(workspace).projectId : undefined);
    assert.equal(resolved.get('workspace-only')?.catalogTitle, null);
  }
  assert.equal(opens, 1, 'configuration changes re-project cached rows instead of querying again');
});

test('Antigravity project attribution recovers on a second real collector tick', { skip: !sqlite }, async (t) => {
  const store = summaryStore(t);
  const workspace = path.join(store.home, 'project');
  store.put.run('collector-session', 'Collector title', '', JSON.stringify([pathToFileURL(workspace).href]), null);
  const options = {
    clients: 'antigravity', homeDir: store.home, allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000, deviceId: 'fixture-device', agentVersion: 'fixture',
    codexLocalUsageEnabled: false, wslScanEnabled: false,
    historyEnabled: false, dailyHistoryArchiveEnabled: false,
    sessionMetadataDeps: store.deps, runAntigravitySync: async () => {},
    runTokscale: async () => ({ entries: [{
      client: 'antigravity', sessionId: 'collector-session', model: 'fixture-model', input: 1, output: 1, cost: 0
    }] })
  };
  const first = await collectUsageOnce({ ...options, projectsEnabled: false });
  const second = await collectUsageOnce({ ...options, projectsEnabled: true });
  assert.equal(first.today.sessions['antigravity:collector-session'].projectId, '');
  for (const period of [second.today, second.month, second.allTime]) {
    assert.equal(period.sessions['antigravity:collector-session'].projectId, projectIdentity(workspace).projectId);
    assert.equal(period.totalTokens, 2);
  }
});

test('Antigravity scopedHome ignores both host overrides and decodes WSL workspaces as POSIX', { skip: !sqlite }, (t) => {
  const host = summaryStore(t);
  const wsl = summaryStore(t);
  host.put.run('shared-id', 'Host title', '', JSON.stringify([pathToFileURL(path.join(host.home, 'host-project')).href]), null);
  wsl.put.run('shared-id', 'WSL title', '', JSON.stringify(['file:///home/wsl/project%20name']), null);
  const deps = {
    ...host.deps, platform: 'win32',
    env: { ANTIGRAVITY_HOME: host.dir, ANTIGRAVITY_DATA_DIR: host.dir }
  };
  const ids = new Set(['shared-id']);
  assert.equal(resolveSessionMetadata(ids, { home: wsl.home, deps }).get('shared-id').title, 'Host title');
  const periods = { today: { sessions: { 'antigravity:shared-id': { client: 'antigravity', sessionId: 'shared-id' } } } };
  applySessionMetadata(periods, wsl.home, { ...deps, scopedHome: true });
  const session = periods.today.sessions['antigravity:shared-id'];
  assert.equal(session.title, 'WSL title');
  assert.equal(session.projectId, projectIdentity('/home/wsl/project name').projectId);
  assert.equal(session.projectLabel, 'project name');
});

test('Antigravity catalog renames preserve transcript activity, turn state and project attribution', { skip: !sqlite }, (t) => {
  const store = summaryStore(t);
  const now = Date.parse('2026-10-09T09:00:30Z');
  const sessions = {};
  const originals = {};
  for (const [id, lastUsedAt, turnEnded] of [
    ['ended', '2026-10-09T09:00:00Z', true], ['idle', '2026-10-08T00:00:00Z', false]
  ]) {
    store.put.run(id, 'Original title', '', JSON.stringify([pathToFileURL(path.join(store.home, 'catalog-project')).href]), '2026-10-09T09:00:00Z');
    originals[id] = {
      client: 'antigravity', sessionId: id, title: 'Native title',
      startedAt: '2026-10-08T00:00:00Z', lastUsedAt, turnEnded,
      ...projectIdentity(path.join(store.home, 'native-project')),
      contextTokens: 130, contextWindow: 200000,
      promptCache: { observedAt: '2026-10-09T09:00:00Z', ttlSeconds: 300 }
    };
    sessions[`antigravity:${id}`] = structuredClone(originals[id]);
  }
  const periods = { today: { sessions } };
  applySessionMetadata(periods, store.home, store.deps);
  store.db.prepare('UPDATE conversation_summaries SET title = ?, last_modified_time = ?').run('Renamed title', '2026-10-09T09:00:20Z');
  applySessionMetadata(periods, store.home, store.deps);
  for (const [id, original] of Object.entries(originals)) {
    const session = sessions[`antigravity:${id}`];
    assert.deepEqual(session, { ...original, title: 'Renamed title' });
    assert.equal(sessionActivityState(session, now), id);
  }
});

test('Antigravity retries failed rows without losing successful cached titles', (t) => {
  const temp = fs.realpathSync.native(os.tmpdir());
  const home = fs.mkdtempSync(path.join(temp, 'antigravity-retry-'));
  const dir = path.join(home, '.gemini', 'antigravity');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversation_summaries.db'), 'stub');
  t.after(() => {
    assert.ok(path.resolve(home).startsWith(path.resolve(temp) + path.sep));
    fs.rmSync(home, { recursive: true, force: true });
  });
  let fail = true;
  const queried = [];
  const deps = {
    env: {}, antigravityTitleCache: new Map(),
    sqlite: { DatabaseSync: class {
      constructor(_file, options) { assert.equal(options.readOnly, true); }
      exec() {}
      close() {}
      prepare(sql) {
        return { get(id) {
          if (sql.includes('sqlite_master')) return { 1: 1 };
          queried.push(id);
          if (id === 'retry' && fail) throw new Error('SQLITE_BUSY');
          return { title: `${id} title`, preview: '', workspace_uris: null };
        } };
      }
    } }
  };
  const ids = new Set(['good', 'retry']);
  const first = resolveSessionMetadata(ids, { home, deps });
  assert.equal(first.get('good').title, 'good title');
  assert.equal(first.has('retry'), false);
  fail = false;
  const second = resolveSessionMetadata(ids, { home, deps });
  assert.equal(second.get('retry').title, 'retry title');
  assert.deepEqual(queried, ['good', 'retry', 'retry']);
});

test('Antigravity watch renames and confirmed removals survive read misses and cold metadata caches', { skip: !sqlite }, async (t) => {
  const store = summaryStore(t);
  store.put.run('watch-session', 'Full title', '', null, null);
  const key = 'antigravity:watch-session';
  let captured;
  const options = {
    clients: 'antigravity', homeDir: store.home, projectsEnabled: false,
    historyEnabled: false, dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false,
    wslScanEnabled: false, osInfo: {}, allTimeSince: '2024-01-01',
    deviceId: 'fixture-device', agentVersion: 'fixture', commandTimeoutMs: 1000,
    sessionMetadataDeps: store.deps, runAntigravitySync: async () => {},
    runTokscale: async () => ({ entries: [{ client: 'antigravity', sessionId: 'watch-session', model: 'fixture', input: 10, output: 2, cost: 0.5 }] }),
    onAnchorComputed: (value) => { captured = value; }
  };
  const initial = await collectUsageOnce(options);
  const anchor = {
    dateKey: localTodayKey(), today: initial.today, month: initial.month, allTime: initial.allTime,
    todayPartitions: captured.todayPartitions, t3Titles: captured.t3Titles
  };
  const watch = async (deps = store.deps) => {
    const summary = await collectUsageOnce({ ...options, sessionMetadataDeps: deps, todayOnlyAnchor: anchor, targetClients: ['antigravity'] });
    anchor.todayPartitions = captured.todayPartitions;
    anchor.todayT3Titles = captured.t3Titles;
    return summary;
  };
  const expectTitle = (summary, title) => {
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(summary[period].sessions[key].title || '', title);
      assert.equal(summary[period].totalTokens, initial[period].totalTokens);
      assert.equal(summary[period].costUsd, initial[period].costUsd);
      assert.equal(summary[period].sessions[key].catalogTitle, undefined, 'provenance stays local');
    }
  };
  store.db.prepare('UPDATE conversation_summaries SET title = ?').run('Watch title');
  expectTitle(await watch(), 'Watch title');
  store.db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
  store.db.prepare('UPDATE conversation_summaries SET title = ?').run('After lock');
  store.db.exec('COMMIT');
  expectTitle(await watch(), 'Watch title');
  store.db.exec('PRAGMA locking_mode = NORMAL; BEGIN; SELECT 1 FROM conversation_summaries; COMMIT');
  expectTitle(await watch(), 'After lock');
  const unavailable = { ...store.deps, sqlite: null, antigravityTitleCache: new Map() };
  expectTitle(await watch(unavailable), 'After lock');
  store.db.prepare('UPDATE conversation_summaries SET title = ?, preview = ?').run('', 'Preview fallback');
  expectTitle(await watch(), 'Preview fallback');
  store.db.prepare('UPDATE conversation_summaries SET title = ?, preview = ?').run('', '');
  expectTitle(await watch(), '');
  expectTitle(await watch(unavailable), '');
  store.db.prepare('UPDATE conversation_summaries SET title = ?').run('Revived title');
  expectTitle(await watch(), 'Revived title');
  store.db.exec('DELETE FROM conversation_summaries');
  expectTitle(await watch(), '');
  expectTitle(await watch(), '');
  expectTitle(await watch(unavailable), '');
});

test('Antigravity clears only its catalog override and restores a native fallback', { skip: !sqlite }, (t) => {
  const store = summaryStore(t);
  store.put.run('native-session', 'Catalog title', '', null, null);
  const session = { client: 'antigravity', sessionId: 'native-session', title: 'Native title', turnEnded: true };
  const periods = { today: { sessions: { 'antigravity:native-session': session } } };
  const deps = { ...store.deps, metadataCache: new Map(), retryMisses: true };
  applySessionMetadata(periods, store.home, deps);
  assert.equal(session.title, 'Catalog title');
  store.db.prepare('UPDATE conversation_summaries SET title = ?').run('Renamed catalog title');
  applySessionMetadata(periods, store.home, deps);
  assert.equal(session.title, 'Renamed catalog title');
  store.db.prepare('UPDATE conversation_summaries SET title = ?').run('');
  applySessionMetadata(periods, store.home, deps);
  assert.equal(session.title, 'Native title');
  assert.equal(session.turnEnded, true);
  session.title = 'Newer native title';
  applySessionMetadata(periods, store.home, deps);
  assert.equal(session.title, 'Newer native title');
});

for (const update of ['renamed', 'cleared', 'deleted-while-stopped']) {
  test(`Antigravity ${update} titles survive persisted-anchor restart without moving usage baselines`, { skip: !sqlite }, async (t) => {
    const store = summaryStore(t);
    store.put.run('persisted', 'Original title', '', null, null);
    const shared = path.join(store.home, 'shared');
    const oldShared = process.env.TOKEN_MONITOR_SHARED_DIR;
    process.env.TOKEN_MONITOR_SHARED_DIR = shared;
    const key = 'antigravity:persisted';
    const expected = update === 'renamed' ? 'Renamed title' : '';
    const updates = [];
    let scans = 0;
    let inputToday = 10;
    let handle;
    t.after(() => {
      handle?.stop();
      if (oldShared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
      else process.env.TOKEN_MONITOR_SHARED_DIR = oldShared;
    });
    const options = {
      clients: 'antigravity', homeDir: store.home, allTimeSince: '2024-01-01',
      projectsEnabled: false, historyEnabled: false, dailyHistoryArchiveEnabled: false,
      codexLocalUsageEnabled: false, wslScanEnabled: false, sessionActivityPolling: false,
      watchEnabled: false, intervalMs: 60 * 60 * 1000, commandTimeoutMs: 1000,
      deviceId: 'fixture-device', agentVersion: 'fixture', osInfo: {},
      sessionMetadataDeps: store.deps, runAntigravitySync: async () => {},
      runTokscale: async ({ flags }) => {
        scans += 1;
        const input = flags.includes('--month') ? 100 : flags.includes('--since') ? 1000 : inputToday;
        return { entries: [{ client: 'antigravity', sessionId: 'persisted', model: 'fixture', input, output: 0, cost: input / 100 }] };
      },
      onUpdate: (summary) => updates.push(summary)
    };
    const waitForUpdate = async (count) => {
      for (let attempt = 0; attempt < 200 && updates.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(updates.length, count);
    };
    handle = startCollector(options);
    await waitForUpdate(1);
    const file = path.join(shared, 'collector-anchor.json');
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(original.catalogTitleSources[key], store.dbPath);
    if (update === 'deleted-while-stopped') {
      handle.stop();
      handle = null;
      store.db.exec('DELETE FROM conversation_summaries');
      const beforeRestart = scans;
      handle = startCollector({ ...options, sessionMetadataDeps: { ...store.deps, antigravityTitleCache: new Map() } });
      await waitForUpdate(2);
      assert.equal(scans - beforeRestart, 1);
      for (const period of ['today', 'month', 'allTime']) {
        assert.equal(updates.at(-1)[period].sessions[key].title || '', '');
        assert.equal(updates.at(-1)[period].totalTokens, original[period].totalTokens);
        assert.equal(updates.at(-1)[period].costUsd, original[period].costUsd);
      }
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.t3Titles[key], null);
      assert.equal(saved.fullScanAt, original.fullScanAt);
      handle.stop();
      handle = null;
      handle = startCollector({ ...options, sessionMetadataDeps: { ...store.deps, sqlite: null, antigravityTitleCache: new Map() } });
      await waitForUpdate(3);
      for (const period of ['today', 'month', 'allTime']) assert.equal(updates.at(-1)[period].sessions[key].title || '', '');
      return;
    }
    inputToday = 20;
    store.db.prepare('UPDATE conversation_summaries SET title = ?').run(expected);
    await handle.refreshClient('antigravity');
    const check = (summary) => {
      for (const [period, tokens] of [['today', 20], ['month', 110], ['allTime', 1010]]) {
        assert.equal(summary[period].sessions[key].title || '', expected);
        assert.equal(summary[period].totalTokens, tokens);
        assert.ok(Math.abs(summary[period].costUsd - tokens / 100) < 1e-10);
      }
    };
    check(updates.at(-1));
    const savedText = fs.readFileSync(file, 'utf8');
    const saved = JSON.parse(savedText);
    assert.equal(saved.todayT3Titles[key], expected || null);
    assert.equal(saved.fullScanAt, original.fullScanAt);
    for (const period of ['today', 'month', 'allTime']) {
      const { title: _oldTitle, ...before } = original[period].sessions[key];
      const { title: _newTitle, ...after } = saved[period].sessions[key];
      assert.deepEqual(after, before);
      assert.equal(saved[period].sessions[key].title || '', expected);
    }
    handle.stop();
    handle = null;
    const beforeRestart = scans;
    handle = startCollector({ ...options, sessionMetadataDeps: { ...store.deps, sqlite: null, antigravityTitleCache: new Map() } });
    await waitForUpdate(3);
    assert.equal(scans - beforeRestart, 1, 'restart reuses the baseline and scans only today');
    check(updates.at(-1));
    assert.equal(fs.readFileSync(file, 'utf8'), savedText, 'reader failures do not rewrite unchanged title state');
  });
}

for (const unavailable of ['renamed-file', 'stat-error']) {
  test(`Antigravity full scans retain cached titles when the database has a temporary ${unavailable}`, { skip: !sqlite }, async (t) => {
    const store = summaryStore(t);
    store.put.run('unavailable', 'Known title', '', null, null);
    const options = {
      clients: 'antigravity', homeDir: store.home, projectsEnabled: false,
      historyEnabled: false, dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false,
      wslScanEnabled: false, osInfo: {}, allTimeSince: '2024-01-01',
      deviceId: 'fixture-device', agentVersion: 'fixture', commandTimeoutMs: 1000,
      sessionMetadataDeps: store.deps, runAntigravitySync: async () => {},
      runTokscale: async () => ({ entries: [{ client: 'antigravity', sessionId: 'unavailable', model: 'fixture', input: 12, output: 0, cost: 0.5 }] })
    };
    const first = await collectUsageOnce(options);
    let restore;
    if (unavailable === 'renamed-file') {
      store.close();
      fs.renameSync(store.dbPath, `${store.dbPath}.moved`);
      restore = () => fs.renameSync(`${store.dbPath}.moved`, store.dbPath);
    } else {
      const original = fs.statSync;
      fs.statSync = function (file, ...args) {
        if (file === store.dbPath) throw Object.assign(new Error('fixture permission failure'), { code: 'EACCES' });
        return original.call(this, file, ...args);
      };
      restore = () => { fs.statSync = original; };
    }
    try {
      const next = await collectUsageOnce(options);
      for (const period of ['today', 'month', 'allTime']) {
        assert.equal(next[period].sessions['antigravity:unavailable'].title, 'Known title');
        assert.equal(next[period].totalTokens, first[period].totalTokens);
        assert.equal(next[period].costUsd, first[period].costUsd);
      }
    } finally { restore(); }
    const writer = new sqlite.DatabaseSync(store.dbPath);
    try { writer.prepare('UPDATE conversation_summaries SET title = ?').run('Recovered title'); }
    finally { writer.close(); }
    const recovered = await collectUsageOnce(options);
    assert.equal(recovered.today.sessions['antigravity:unavailable'].title, 'Recovered title');
  });
}

test('Antigravity summary workspace changes reach all watch periods without changing accounting', { skip: !sqlite }, async (t) => {
  const store = summaryStore(t);
  const projectA = path.join(store.home, 'project-a');
  const projectB = path.join(store.home, 'project-b');
  store.put.run('moving', 'Workspace title', '', JSON.stringify([pathToFileURL(projectA).href]), null);
  let captured;
  const options = {
    clients: 'antigravity', homeDir: store.home, projectsEnabled: true,
    historyEnabled: false, dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false,
    wslScanEnabled: false, osInfo: {}, allTimeSince: '2024-01-01',
    deviceId: 'fixture-device', agentVersion: 'fixture', commandTimeoutMs: 1000,
    sessionMetadataDeps: store.deps, runAntigravitySync: async () => {},
    runTokscale: async () => ({ entries: [{ client: 'antigravity', sessionId: 'moving', model: 'fixture', input: 12, output: 0, cost: 0.5 }] }),
    onAnchorComputed: (value) => { captured = value; }
  };
  const first = await collectUsageOnce(options);
  const anchor = {
    dateKey: localTodayKey(), today: first.today, month: first.month, allTime: first.allTime,
    todayPartitions: captured.todayPartitions, t3Titles: captured.t3Titles, catalogProjects: captured.catalogProjects
  };
  store.db.prepare('UPDATE conversation_summaries SET workspace_uris = ?').run(JSON.stringify([pathToFileURL(projectB).href]));
  const next = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients: ['antigravity'] });
  for (const period of ['today', 'month', 'allTime']) {
    assert.equal(next[period].sessions['antigravity:moving'].projectId, projectIdentity(projectB).projectId);
    assert.equal(next[period].totalTokens, first[period].totalTokens);
    assert.equal(next[period].costUsd, first[period].costUsd);
    assert.equal(next[period].sessions['antigravity:moving'].catalogProject, undefined);
  }
  // Even a native path equal to the old catalog association stays authoritative.
  const native = projectB;
  options.runTokscale = async () => ({ entries: [{ client: 'antigravity', sessionId: 'moving', workspaceKey: 'native', model: 'fixture', input: 12, output: 0, cost: 0.5 }],
    sessions: [{ client: 'antigravity', sessionId: 'moving', workspaceKey: 'native' }],
    workspaces: [{ workspaceKey: 'native', path: native }] });
  const nativeFirst = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients: ['antigravity'] });
  const nativeAnchor = { dateKey: localTodayKey(), today: nativeFirst.today, month: nativeFirst.month, allTime: nativeFirst.allTime,
    todayPartitions: captured.todayPartitions, t3Titles: captured.t3Titles, catalogProjects: captured.catalogProjects };
  assert.equal(captured.catalogProjects.today['antigravity:moving'], undefined);
  store.db.prepare('UPDATE conversation_summaries SET workspace_uris = ?').run(JSON.stringify([pathToFileURL(projectA).href]));
  const nativeNext = await collectUsageOnce({ ...options, todayOnlyAnchor: nativeAnchor, targetClients: ['antigravity'] });
  for (const period of ['today', 'month', 'allTime']) {
    assert.equal(nativeNext[period].sessions['antigravity:moving'].projectId, projectIdentity(native).projectId);
  }
});

test('Antigravity workspace provenance persists across restart without moving usage anchors', { skip: !sqlite }, async (t) => {
  const store = summaryStore(t);
  const projectA = path.join(store.home, 'project-a');
  const projectB = path.join(store.home, 'project-b');
  store.put.run('moving', 'Stable title', '', JSON.stringify([pathToFileURL(projectA).href]), null);
  const shared = path.join(store.home, 'shared');
  const oldShared = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = shared;
  let handle;
  t.after(() => {
    handle?.stop();
    if (oldShared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = oldShared;
  });
  const updates = [];
  let scans = 0;
  const options = {
    clients: 'antigravity', homeDir: store.home, projectsEnabled: true,
    historyEnabled: false, dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false,
    wslScanEnabled: false, sessionActivityPolling: false, watchEnabled: false, intervalMs: 60 * 60 * 1000,
    osInfo: {}, allTimeSince: '2024-01-01', deviceId: 'fixture-device', agentVersion: 'fixture', commandTimeoutMs: 1000,
    sessionMetadataDeps: store.deps, runAntigravitySync: async () => {},
    runTokscale: async () => { scans += 1; return { entries: [{ client: 'antigravity', sessionId: 'moving', model: 'fixture', input: 12, output: 0, cost: 0.5 }] }; },
    onUpdate: (summary) => updates.push(summary)
  };
  const wait = async (count) => {
    for (let attempt = 0; attempt < 200 && updates.length < count; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(updates.length, count);
  };
  handle = startCollector(options);
  await wait(1);
  const file = path.join(shared, 'collector-anchor.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.db.prepare('UPDATE conversation_summaries SET workspace_uris = ?').run(JSON.stringify([pathToFileURL(projectB).href]));
  await handle.refreshClient('antigravity');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.fullScanAt, original.fullScanAt);
  assert.equal(saved.catalogProjects.today['antigravity:moving'], projectIdentity(projectB).projectId);
  for (const period of ['today', 'month', 'allTime']) {
    const { projectId: _oldId, projectLabel: _oldLabel, ...before } = original[period].sessions['antigravity:moving'];
    const { projectId: _newId, projectLabel: _newLabel, ...after } = saved[period].sessions['antigravity:moving'];
    assert.deepEqual(after, before);
    assert.equal(updates.at(-1)[period].sessions['antigravity:moving'].projectId, projectIdentity(projectB).projectId);
  }
  handle.stop();
  handle = null;
  const beforeRestart = scans;
  handle = startCollector({ ...options, sessionMetadataDeps: { ...store.deps, antigravityTitleCache: new Map() } });
  await wait(3);
  assert.equal(scans - beforeRestart, 1);
  for (const period of ['today', 'month', 'allTime']) assert.equal(updates.at(-1)[period].sessions['antigravity:moving'].projectId, projectIdentity(projectB).projectId);
});

test('Antigravity confirmed misses do not shadow a later store or a temporarily unreadable store', { skip: !sqlite }, (t) => {
  const store = summaryStore(t);
  const otherDir = path.join(store.home, '.gemini', 'antigravity-ide');
  fs.mkdirSync(otherDir, { recursive: true });
  const otherPath = path.join(otherDir, 'conversation_summaries.db');
  const other = new sqlite.DatabaseSync(otherPath);
  try {
    other.exec('CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, workspace_uris TEXT)');
    other.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run('later', 'Later store title', '', null);
    const ids = new Set(['later']);
    const deps = { ...store.deps, t3Titles: { 'antigravity:later': 'Anchor title' }, invalidatedTitleKeys: new Set() };
    const result = resolveSessionMetadata(ids, { home: store.home, deps });
    assert.equal(result.get('later').title, 'Later store title');
    const unavailable = { ...deps, antigravityTitleCache: new Map(), sqlite: { DatabaseSync: class {
      constructor(file, options) {
        if (file === otherPath) throw new Error('SQLITE_BUSY');
        return new sqlite.DatabaseSync(file, options);
      }
    } } };
    assert.equal(resolveSessionMetadata(ids, { home: store.home, deps: unavailable }).get('later').title, 'Anchor title');
  } finally { other.close(); }
});

test('Antigravity revalidates changed fingerprints per row and retains failed rows until retry succeeds', (t) => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'antigravity-fingerprint-'));
  const dir = path.join(home, '.gemini', 'antigravity');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'conversation_summaries.db');
  fs.writeFileSync(file, 'stub');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let revision = 1;
  let fail = false;
  const queried = [];
  const deps = {
    env: {}, antigravityTitleCache: new Map(),
    sqlite: { DatabaseSync: class {
      exec() {}
      close() {}
      prepare(sql) {
        return { get(id) {
          if (sql.includes('sqlite_master')) return { 1: 1 };
          queried.push(id);
          if (fail && id === 'retry') throw new Error('SQLITE_BUSY');
          return { title: `${id} v${revision}`, preview: '', workspace_uris: null };
        } };
      }
    } }
  };
  const ids = new Set(['good', 'retry']);
  const context = { home, deps };
  assert.equal(resolveSessionMetadata(ids, context).get('retry').title, 'retry v1');
  fs.appendFileSync(file, 'changed');
  revision = 2;
  fail = true;
  const partial = resolveSessionMetadata(ids, context);
  assert.equal(partial.get('good').title, 'good v2');
  assert.equal(partial.get('retry').title, 'retry v1');
  fail = false;
  const retried = resolveSessionMetadata(ids, context);
  assert.equal(retried.get('retry').title, 'retry v2');
  assert.deepEqual(queried, ['good', 'retry', 'good', 'retry', 'retry']);
});

test('Antigravity CLI summary candidates follow GEMINI_CLI_HOME while scoped homes stay isolated', () => {
  const home = path.resolve('/fixture/home');
  const relocated = path.resolve('/fixture/relocated-gemini');
  const candidates = antigravityConversationSummaryCandidates({ home, env: { GEMINI_CLI_HOME: relocated } });
  assert.ok(candidates.includes(path.join(relocated, 'antigravity-cli', 'conversation_summaries.db')));
  assert.ok(candidates.includes(path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db')));
  assert.equal(candidates.includes(path.join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db')), false);
});


for (const failure of ['stat-error', 'missing-file', 'busy']) {
  test(`Antigravity multiple stores preserve the title on ${failure} and prefer a fresh later row`, { skip: !sqlite }, async (t) => {
    const store = summaryStore(t);
    const dir = path.join(store.home, '.gemini', 'antigravity-ide');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'conversation_summaries.db');
    const other = new sqlite.DatabaseSync(file);
    other.exec('CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, workspace_uris TEXT)');
    other.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run('multi', 'Known later title', '', null);
    const options = {
      clients: 'antigravity', homeDir: store.home, projectsEnabled: false,
      historyEnabled: false, dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false, wslScanEnabled: false,
      osInfo: {}, allTimeSince: '2024-01-01', sessionMetadataDeps: store.deps,
      runAntigravitySync: async () => {}, runTokscale: async () => ({ entries: [{ client: 'antigravity', sessionId: 'multi', input: 12, output: 0, cost: 0.5 }] })
    };
    const originalStat = fs.statSync;
    try {
      const first = await collectUsageOnce(options);
      assert.equal(first.today.sessions['antigravity:multi'].title, 'Known later title');
      if (failure === 'missing-file') { other.close(); fs.renameSync(file, `${file}.moved`); }
      else if (failure === 'stat-error') fs.statSync = function (target, ...args) {
        if (target === file) throw Object.assign(new Error('permission failure'), { code: 'EACCES' });
        return originalStat.call(this, target, ...args);
      };
      else {
        other.prepare('UPDATE conversation_summaries SET title = ?').run('Unread revision');
        options.sessionMetadataDeps = { ...store.deps, sqlite: { DatabaseSync: class {
          constructor(target, config) { if (target === file) throw new Error('SQLITE_BUSY'); return new sqlite.DatabaseSync(target, config); }
        } } };
      }
      const unavailable = await collectUsageOnce(options);
      for (const period of ['today', 'month', 'allTime']) assert.equal(unavailable[period].sessions['antigravity:multi'].title, 'Known later title');
      const cold = await collectUsageOnce({ ...options,
        sessionMetadataDeps: { ...options.sessionMetadataDeps, antigravityTitleCache: new Map() },
        todayOnlyAnchor: { dateKey: localTodayKey(), today: first.today, month: first.month, allTime: first.allTime,
          t3Titles: { 'antigravity:multi': 'Known later title' }, catalogTitleSources: { 'antigravity:multi': file } }
      });
      for (const period of ['today', 'month', 'allTime']) assert.equal(cold[period].sessions['antigravity:multi'].title, 'Known later title');
    } finally {
      fs.statSync = originalStat;
      if (other.isOpen) other.close();
    }
  });
}

test('Antigravity cached removals and stale first-store rows cannot shadow a valid later title', { skip: !sqlite }, async (t) => {
  const store = summaryStore(t);
  store.put.run('multi', 'First title', '', null, null);
  const dir = path.join(store.home, '.gemini', 'antigravity-ide');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'conversation_summaries.db');
  const other = new sqlite.DatabaseSync(file);
  try {
    other.exec('CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, workspace_uris TEXT)');
    const options = {
      clients: 'antigravity', homeDir: store.home, projectsEnabled: false, historyEnabled: false,
      dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false, wslScanEnabled: false,
      osInfo: {}, allTimeSince: '2024-01-01', sessionMetadataDeps: store.deps,
      runAntigravitySync: async () => {}, runTokscale: async () => ({ entries: [{ client: 'antigravity', sessionId: 'multi', input: 12, output: 0, cost: 0.5 }] })
    };
    assert.equal((await collectUsageOnce(options)).today.sessions['antigravity:multi'].title, 'First title');
    store.db.exec('DELETE FROM conversation_summaries');
    await collectUsageOnce(options);
    other.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run('multi', 'Fresh later title', '', null);
    store.db.exec('CREATE TABLE fingerprint_change(value TEXT)');
    options.sessionMetadataDeps = { ...store.deps, sqlite: { DatabaseSync: class {
      constructor(target, config) { if (target === store.dbPath) throw new Error('SQLITE_BUSY'); return new sqlite.DatabaseSync(target, config); }
    } } };
    const later = await collectUsageOnce(options);
    for (const period of ['today', 'month', 'allTime']) assert.equal(later[period].sessions['antigravity:multi'].title, 'Fresh later title');
    store.put.run('multi', 'Stale first title', '', null, null);
    await collectUsageOnce({ ...options, sessionMetadataDeps: store.deps });
    store.put.run('multi', 'Unvalidated change', '', null, null);
    assert.equal((await collectUsageOnce(options)).today.sessions['antigravity:multi'].title, 'Fresh later title');
  } finally { other.close(); }
});

for (const nativeHistory of [false, true]) {
  test(`Antigravity workspace removal preserves period sources (native history: ${nativeHistory})`, { skip: !sqlite }, async (t) => {
    const store = summaryStore(t);
    const key = 'antigravity:workspace';
    const projectA = path.join(store.home, 'project-a');
    const projectB = path.join(store.home, 'project-b');
    store.put.run('workspace', 'Workspace title', '', JSON.stringify([pathToFileURL(projectA).href]), null);
    const oldShared = process.env.TOKEN_MONITOR_SHARED_DIR;
    const shared = path.join(store.home, 'shared');
    process.env.TOKEN_MONITOR_SHARED_DIR = shared;
    let handle;
    t.after(() => { handle?.stop(); if (oldShared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR; else process.env.TOKEN_MONITOR_SHARED_DIR = oldShared; });
    const updates = [];
    const options = {
      clients: 'antigravity', homeDir: store.home, projectsEnabled: true, historyEnabled: false,
      dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false, wslScanEnabled: false, sessionActivityPolling: false,
      osInfo: {}, allTimeSince: '2024-01-01', sessionMetadataDeps: store.deps, watchEnabled: false, intervalMs: 3600000,
      runAntigravitySync: async () => {}, runTokscale: async ({ flags }) => ({
        entries: [{ client: 'antigravity', sessionId: 'workspace', input: flags.includes('--today') ? 12 : 120, output: 0, cost: 0.5,
          ...(nativeHistory && !flags.includes('--today') ? { workspaceKey: 'native' } : {}) }],
        workspaces: [{ workspaceKey: 'native', path: projectA }]
      }), onUpdate: (value) => updates.push(value)
    };
    handle = startCollector(options);
    for (let attempt = 0; attempt < 200 && updates.length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(updates.length, 1);
    const file = path.join(shared, 'collector-anchor.json');
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    store.db.prepare('UPDATE conversation_summaries SET title = ?, workspace_uris = ?').run('Renamed', JSON.stringify([pathToFileURL(projectB).href]));
    await handle.refreshClient('antigravity');
    for (const period of ['today', 'month', 'allTime']) {
      const expected = nativeHistory && period !== 'today' ? projectA : projectB;
      assert.equal(updates.at(-1)[period].sessions[key].projectId, projectIdentity(expected).projectId);
    }
    store.db.prepare('UPDATE conversation_summaries SET workspace_uris = ?').run('[]');
    await handle.refreshClient('antigravity');
    const check = (value) => {
      for (const period of ['today', 'month', 'allTime']) {
        assert.equal(value[period].sessions[key].projectId || '', nativeHistory && period !== 'today' ? projectIdentity(projectA).projectId : '');
        assert.equal(value[period].sessions[key].title, 'Renamed');
        assert.equal(value[period].totalTokens, original[period].totalTokens);
      }
    };
    check(updates.at(-1));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.fullScanAt, original.fullScanAt);
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(saved.catalogProjects[period][key], undefined);
      assert.equal(saved[period].sessions[key].projectId || '', nativeHistory && period !== 'today' ? projectIdentity(projectA).projectId : '');
      assert.equal(saved[period].costUsd, original[period].costUsd);
    }
    handle.stop(); handle = null;
    handle = startCollector({ ...options, sessionMetadataDeps: { ...store.deps, sqlite: null, antigravityTitleCache: new Map() } });
    for (let attempt = 0; attempt < 200 && updates.length < 4; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(updates.length, 4);
    check(updates.at(-1));
  });
}


test('Antigravity an empty first-store row cannot clear a title while a later store is unreadable', { skip: !sqlite }, async (t) => {
  const store = summaryStore(t);
  store.put.run('multi', '', '', null, null);
  const dir = path.join(store.home, '.gemini', 'antigravity-ide');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'conversation_summaries.db');
  const other = new sqlite.DatabaseSync(file);
  try {
    other.exec('CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, workspace_uris TEXT)');
    other.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run('multi', 'Valid later title', '', null);
    const options = {
      clients: 'antigravity', homeDir: store.home, projectsEnabled: false, historyEnabled: false,
      dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false, wslScanEnabled: false,
      osInfo: {}, allTimeSince: '2024-01-01', sessionMetadataDeps: store.deps,
      runAntigravitySync: async () => {}, runTokscale: async () => ({ entries: [{ client: 'antigravity', sessionId: 'multi', input: 12, output: 0, cost: 0.5 }] })
    };
    const first = await collectUsageOnce(options);
    assert.equal(first.today.sessions['antigravity:multi'].title, 'Valid later title');
    const next = await collectUsageOnce({ ...options,
      sessionMetadataDeps: { ...store.deps, antigravityTitleCache: new Map(), sqlite: { DatabaseSync: class {
        constructor(target, config) { if (target === file) throw new Error('SQLITE_BUSY'); return new sqlite.DatabaseSync(target, config); }
      } } },
      todayOnlyAnchor: { dateKey: localTodayKey(), today: first.today, month: first.month, allTime: first.allTime,
        t3Titles: { 'antigravity:multi': 'Valid later title' } }
    });
    for (const period of ['today', 'month', 'allTime']) assert.equal(next[period].sessions['antigravity:multi'].title, 'Valid later title');
  } finally { other.close(); }
});


test('Antigravity full-scan deletion stays cleared through a later fingerprint read failure', { skip: !sqlite }, async (t) => {
  const store = summaryStore(t);
  store.put.run('deleted', 'Original title', '', null, null);
  const options = {
    clients: 'antigravity', homeDir: store.home, projectsEnabled: false, historyEnabled: false,
    dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false, wslScanEnabled: false,
    osInfo: {}, allTimeSince: '2024-01-01', sessionMetadataDeps: store.deps,
    runAntigravitySync: async () => {}, runTokscale: async () => ({ entries: [{ client: 'antigravity', sessionId: 'deleted', input: 12, output: 0, cost: 0.5 }] })
  };
  assert.equal((await collectUsageOnce(options)).today.sessions['antigravity:deleted'].title, 'Original title');
  store.db.exec('DELETE FROM conversation_summaries');
  assert.equal((await collectUsageOnce(options)).today.sessions['antigravity:deleted'].title || '', '');
  store.db.exec('CREATE TABLE fingerprint_change(value TEXT)');
  const failed = await collectUsageOnce({ ...options, sessionMetadataDeps: { ...store.deps, sqlite: { DatabaseSync: class {
    constructor() { throw new Error('SQLITE_BUSY'); }
  } } } });
  for (const period of ['today', 'month', 'allTime']) assert.equal(failed[period].sessions['antigravity:deleted'].title || '', '');
});


for (const secondFailure of ['missing-file', 'changed-fingerprint-busy']) {
  test(`Antigravity per-store confirmed deletion survives ${secondFailure} without shadowing fallback`, { skip: !sqlite }, async (t) => {
    const store = summaryStore(t);
    store.put.run('removed', 'Old primary title', '', null, null);
    const dir = path.join(store.home, '.gemini', 'antigravity-ide');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'conversation_summaries.db');
    const other = new sqlite.DatabaseSync(file);
    try {
      other.exec('CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, workspace_uris TEXT)');
      other.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run('removed', 'Fallback title', '', null);
      const options = {
        clients: 'antigravity', homeDir: store.home, projectsEnabled: false, historyEnabled: false,
        dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false, wslScanEnabled: false,
        osInfo: {}, allTimeSince: '2024-01-01', sessionMetadataDeps: store.deps,
        runAntigravitySync: async () => {}, runTokscale: async () => ({ entries: [{ client: 'antigravity', sessionId: 'removed', input: 12, output: 0, cost: 0.5 }] })
      };
      const original = await collectUsageOnce(options);
      assert.equal(original.today.sessions['antigravity:removed'].title, 'Old primary title');
      store.db.exec('DELETE FROM conversation_summaries');
      assert.equal((await collectUsageOnce(options)).today.sessions['antigravity:removed'].title, 'Fallback title');
      if (secondFailure === 'missing-file') {
        store.close(); other.close();
        fs.renameSync(store.dbPath, `${store.dbPath}.moved`);
        fs.renameSync(file, `${file}.moved`);
      } else {
        store.db.exec('CREATE TABLE fingerprint_change(value TEXT)');
        options.sessionMetadataDeps = { ...store.deps, sqlite: { DatabaseSync: class {
          constructor(target, config) { if (target === store.dbPath) throw new Error('SQLITE_BUSY'); return new sqlite.DatabaseSync(target, config); }
        } } };
      }
      const unavailable = await collectUsageOnce(options);
      for (const period of ['today', 'month', 'allTime']) {
        assert.equal(unavailable[period].sessions['antigravity:removed'].title, 'Fallback title');
        assert.equal(unavailable[period].totalTokens, original[period].totalTokens);
        assert.equal(unavailable[period].costUsd, original[period].costUsd);
      }
    } finally { if (other.isOpen) other.close(); }
  });
}

test('Antigravity post-anchor sessions retain project labels and rollups through unavailable-store restart', { skip: !sqlite }, async (t) => {
  const store = summaryStore(t);
  const key = 'antigravity:new-session';
  const project = path.join(store.home, 'new-project');
  const shared = path.join(store.home, 'shared');
  const oldShared = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = shared;
  let handle;
  let includeNew = false;
  const updates = [];
  t.after(() => { handle?.stop(); if (oldShared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR; else process.env.TOKEN_MONITOR_SHARED_DIR = oldShared; });
  const options = {
    clients: 'antigravity', homeDir: store.home, projectsEnabled: true, historyEnabled: false,
    dailyHistoryArchiveEnabled: false, codexLocalUsageEnabled: false, wslScanEnabled: false, sessionActivityPolling: false,
    osInfo: {}, allTimeSince: '2024-01-01', sessionMetadataDeps: store.deps, watchEnabled: false, intervalMs: 3600000,
    runAntigravitySync: async () => {}, runTokscale: async () => ({ entries: includeNew ? [{ client: 'antigravity', sessionId: 'new-session', input: 12, output: 0, cost: 0.5 }] : [] }),
    onUpdate: (value) => updates.push(value)
  };
  const wait = async (count) => {
    for (let attempt = 0; attempt < 200 && updates.length < count; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(updates.length, count);
  };
  handle = startCollector(options);
  await wait(1);
  const file = path.join(shared, 'collector-anchor.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  includeNew = true;
  store.put.run('new-session', 'New title', '', JSON.stringify([pathToFileURL(project).href]), null);
  await handle.refreshClient('antigravity');
  const learned = updates.at(-1);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.fullScanAt, original.fullScanAt);
  assert.equal(saved.today.sessions[key], undefined, 'metadata persistence leaves the usage baseline frozen');
  assert.equal(saved.catalogProjects.labels[projectIdentity(project).projectId], 'new-project');
  handle.stop(); handle = null;
  store.close();
  fs.renameSync(store.dbPath, `${store.dbPath}.moved`);
  handle = startCollector({ ...options, sessionMetadataDeps: { ...store.deps, antigravityTitleCache: new Map() } });
  await wait(3);
  for (const period of ['today', 'month', 'allTime']) {
    const session = updates.at(-1)[period].sessions[key];
    assert.equal(session.projectId, projectIdentity(project).projectId);
    assert.equal(session.projectLabel, 'new-project');
    assert.deepEqual(projectRollupFromSessions(updates.at(-1)[period].sessions), projectRollupFromSessions(learned[period].sessions));
    assert.equal(updates.at(-1)[period].totalTokens, learned[period].totalTokens);
    assert.equal(updates.at(-1)[period].costUsd, learned[period].costUsd);
  }
});
