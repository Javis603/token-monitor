'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { applySessionMetadata, projectIdentity } = require('../../src/shared/sessionMetadata');
const { collectUsageOnce } = require('../../src/shared/collector');
const { sessionActivityState } = require('../../src/shared/sessionLive');
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
  t.after(() => {
    db.close();
    assert.ok(path.resolve(home).startsWith(path.resolve(temp) + path.sep));
    fs.rmSync(home, { recursive: true, force: true });
  });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
    workspace_uris TEXT, last_modified_time TEXT
  )`);
  const put = db.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?, ?)');
  return { home, dir, db, dbPath, put, deps: { sqlite, env: {}, antigravityTitleCache: new Map() } };
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
  assert.equal(resolved.has('session-3'), false);
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
    assert.equal(resolved.has('workspace-only'), enabled);
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
