'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readT3SessionMeta } = require('../../src/shared/t3SessionMetadata');
const claude = require('../../src/shared/providers/claude/sessionMetadata');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const { sessionActivityState } = require('../../src/shared/sessionLive');
let sqlite;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const maybe = sqlite ? test : test.skip;

function store(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3-claude-'));
  let db;
  t.after(() => {
    // Windows cannot remove the SQLite file while its connection is open.
    try { if (db) db.close(); } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  const dir = path.join(home, '.t3', 'userdata');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'statev2.sqlite');
  db = new sqlite.DatabaseSync(file);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT, updated_at TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, driver TEXT, provider TEXT, provider_session_id TEXT, payload_json TEXT);
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT);
    CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, provider_name TEXT, resume_cursor_json TEXT);
  `);
  const v2 = (appId, nativeId, title, driver = 'claudeAgent', deleted = null) => {
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?)').run(appId, title, deleted, '2026-10-04T00:00:00Z');
    db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?)').run(
      appId, driver, `custom-${driver}`, 'shared-provider-session', JSON.stringify({ nativeThreadRef: { driver, nativeId } })
    );
  };
  const legacy = (appId, nativeId, title, driver = 'claudeAgent') => {
    db.prepare('INSERT INTO projection_threads VALUES (?, ?, NULL)').run(appId, title);
    db.prepare('INSERT INTO provider_session_runtime VALUES (?, ?, ?)').run(
      appId, driver, JSON.stringify({ threadId: appId, resume: nativeId })
    );
  };
  const read = (ids) => readT3SessionMeta(ids, { driver: 'claudeAgent', homeDir: home, env: {}, sqlite });
  return { home, db, file, v2, legacy, read };
}

maybe('Claude T3 lookup isolates driver identity and maps legacy resume rather than app threadId', (t) => {
  const { v2, legacy, read } = store(t);
  v2('app-claude', 'same-native-id', 'Claude T3 title');
  v2('app-codex', 'same-native-id', 'Wrong Codex title', 'codex');
  v2('app-second', 'second-native-id', 'Second Claude title');
  legacy('legacy-app-id', 'legacy-native-id', 'Legacy Claude title');
  legacy('legacy-codex', 'codex-only-id', 'Wrong legacy provider', 'codex');
  assert.deepEqual(read(['same-native-id', 'second-native-id', 'legacy-native-id', 'legacy-app-id', 'codex-only-id']), new Map([
    ['same-native-id', { title: 'Claude T3 title' }],
    ['second-native-id', { title: 'Second Claude title' }],
    ['legacy-native-id', { title: 'Legacy Claude title' }]
  ]));
});

maybe('Claude V2 tombstones and untitled rows shadow retained legacy titles', (t) => {
  const { v2, legacy, read } = store(t);
  v2('deleted', 'deleted-native', 'Deleted title', 'claudeAgent', '2026-10-04T00:00:00Z');
  v2('placeholder', 'placeholder-native', 'New thread');
  v2('empty', 'empty-native', '');
  for (const id of ['deleted-native', 'placeholder-native', 'empty-native']) legacy(`old-${id}`, id, 'Stale title');
  assert.equal(read(['deleted-native', 'placeholder-native', 'empty-native']).size, 0);
});

maybe('Claude legacy lookup rejects malformed cursors and stores without provider identity', (t) => {
  const { db, legacy, read } = store(t);
  legacy('valid-app', 'valid-native', 'Valid Claude title');
  legacy('malformed-app', 'malformed-native', 'Malformed cursor title');
  db.prepare('UPDATE provider_session_runtime SET resume_cursor_json = ? WHERE thread_id = ?').run('{', 'malformed-app');
  assert.deepEqual(read(['valid-native', 'malformed-native']), new Map([
    ['valid-native', { title: 'Valid Claude title' }]
  ]));
  db.exec('ALTER TABLE provider_session_runtime DROP COLUMN provider_name');
  assert.equal(read(['valid-native']).size, 0);
});

maybe('Claude resolver prefers T3 over native custom/AI titles without changing transcript metrics', (t) => {
  const { home, db, v2 } = store(t);
  const projects = path.join(home, '.claude', 'projects', 'test-project');
  fs.mkdirSync(projects, { recursive: true });
  for (const id of ['t3-native', 'ordinary-native', 'no-transcript-native']) {
    if (id === 'no-transcript-native') continue;
    fs.writeFileSync(path.join(projects, `${id}.jsonl`), [
      { type: 'custom-title', customTitle: 'Native custom title' },
      { type: 'ai-title', aiTitle: 'Native AI title' },
      { type: 'assistant', timestamp: '2026-10-04T00:00:00Z', message: {
        id: id, model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: {
          input_tokens: 100, cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10 }
        }
      } }
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  }
  v2('app-t3', 't3-native', 'Current T3 sidebar title');
  v2('app-missing-transcript', 'no-transcript-native', 'Title without transcript');
  const ids = new Set(['t3-native', 'ordinary-native', 'no-transcript-native']);
  const context = {
    home, now: new Date('2026-10-04T00:00:01Z'),
    deps: { scopedHome: true, claudeMetadataDeps: { sqlite, cache: new Map() } },
    metadata: new Map([['claude:no-transcript-native', { projectLabel: 'Existing project' }]]),
    fileSessionMetadata: (_id, _file, meta) => ({ ...meta, lastUsedAt: '2026-10-04T00:00:00Z', projectLabel: 'Test project' })
  };
  const result = claude.resolveSessionMetadata(ids, context);
  assert.equal(result.get('t3-native').title, 'Current T3 sidebar title');
  assert.equal(result.get('ordinary-native').title, 'Native custom title');
  assert.deepEqual(result.get('no-transcript-native'), {
    projectLabel: 'Existing project', title: 'Title without transcript', titleOnly: true
  });
  const { title: _title, ...metrics } = result.get('t3-native');
  const { title: _otherTitle, ...otherMetrics } = result.get('ordinary-native');
  assert.deepEqual(metrics, otherMetrics);
  assert.equal(metrics.contextTokens, 130);
  assert.equal(metrics.turnEnded, true);
  assert.equal(metrics.promptCache.ttlSeconds, 300);
  db.prepare('UPDATE orchestration_v2_projection_threads SET title = ? WHERE thread_id = ?').run('Renamed T3 title', 'app-t3');
  assert.equal(claude.resolveSessionMetadata(ids, context).get('t3-native').title, 'Renamed T3 title');
  db.prepare('UPDATE orchestration_v2_projection_threads SET deleted_at = ? WHERE thread_id = ?').run('2026-10-04', 'app-t3');
  assert.equal(claude.resolveSessionMetadata(ids, context).get('t3-native').title, 'Native custom title');
});

maybe('scoped homes ignore host T3CODE_HOME and missing SQLite keeps native metadata', (t) => {
  const { home, file, v2 } = store(t);
  v2('app', 'native', 'Host-only title');
  const scopedHome = path.join(home, 'scoped');
  fs.mkdirSync(scopedHome);
  const context = {
    home: scopedHome, deps: { scopedHome: true, env: { T3CODE_HOME: path.dirname(path.dirname(file)) } },
    metadata: new Map(), fileSessionMetadata: () => ({})
  };
  assert.equal(claude.resolveSessionMetadata(new Set(['native']), context).size, 0);
  assert.equal(readT3SessionMeta(['native'], { homeDir: home, driver: 'claudeAgent', sqlite: null }).size, 0);
});

maybe('T3 title-only updates preserve Claude activity until a transcript supplies new evidence', (t) => {
  const { home, v2 } = store(t);
  const now = Date.parse('2026-10-04T00:01:00Z');
  const original = {
    client: 'claude', sessionId: 'native', title: 'Previous title', turnEnded: true,
    startedAt: '2026-10-03T23:00:00Z', lastUsedAt: '2026-10-04T00:00:00Z',
    projectId: 'existing-project', projectLabel: 'Existing project',
    contextTokens: 130, contextWindow: 200000,
    promptCache: { observedAt: '2026-10-04T00:00:00Z', ttlSeconds: 300 }
  };
  v2('app', 'native', 'Current T3 title');
  const session = structuredClone(original);
  const periods = { today: { sessions: { 'claude:native': session } } };
  const deps = {
    now, scopedHome: true, metadataCache: new Map(),
    claudeMetadataDeps: { sqlite, cache: new Map() }
  };
  assert.equal(sessionActivityState(session, now), 'ended');
  applySessionMetadata(periods, home, deps);
  assert.deepEqual(session, { ...original, title: 'Current T3 title' });
  assert.equal(sessionActivityState(session, now), 'ended');

  // The same title-only cached entry must not suppress a later transcript read.
  const projects = path.join(home, '.claude', 'projects', 'test-project');
  fs.mkdirSync(projects, { recursive: true });
  const transcript = path.join(projects, 'native.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'assistant', timestamp: '2026-10-04T00:00:30Z',
    message: { stop_reason: 'tool_use' }
  }) + '\n');
  applySessionMetadata(periods, home, deps);
  assert.equal(session.title, 'Current T3 title');
  assert.equal(session.turnEnded, false);
  assert.equal(sessionActivityState(session, now), 'running');

  // Each collector tick starts with a fresh metadata cache.
  fs.unlinkSync(transcript);
  const beforeMissing = structuredClone(session);
  applySessionMetadata(periods, home, { ...deps, metadataCache: new Map() });
  assert.deepEqual(session, beforeMissing);

  // A readable transcript with no boundary still clears an old finished state.
  fs.writeFileSync(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'Native title' }) + '\n');
  session.turnEnded = true;
  applySessionMetadata(periods, home, { ...deps, metadataCache: new Map() });
  assert.equal(Object.hasOwn(session, 'turnEnded'), false);
  assert.equal(sessionActivityState(session, now), 'running');
});

maybe('Claude V2 tombstones invalidate cached T3 titles without treating reader failures as deletion', (t) => {
  const { home, db, v2, legacy } = store(t);
  v2('deleted-app', 'deleted-native', 'Deleted T3 title');
  v2('active-app', 'active-native', 'Active T3 title');
  legacy('stale-app', 'deleted-native', 'Stale legacy title');
  const makeSession = (sessionId, title) => ({
    client: 'claude', sessionId, title, turnEnded: true,
    lastUsedAt: '2026-10-04T00:00:00Z'
  });
  const original = makeSession('deleted-native', 'Native fallback');
  const active = makeSession('active-native', 'Other native title');
  const periods = { today: { sessions: {
    'claude:deleted-native': original, 'claude:active-native': active
  } } };
  const deps = {
    scopedHome: true, now: Date.parse('2026-10-04T00:01:00Z'),
    metadataCache: new Map(), claudeMetadataDeps: { sqlite, cache: new Map() }
  };
  applySessionMetadata(periods, home, deps);
  assert.equal(original.title, 'Deleted T3 title');
  const transient = makeSession('deleted-native', 'Native fallback');
  applySessionMetadata({ month: { sessions: { 'claude:deleted-native': transient } } }, home, {
    ...deps, claudeMetadataDeps: { ...deps.claudeMetadataDeps, sqlite: null }
  });
  assert.equal(transient.title, 'Deleted T3 title');

  db.prepare('UPDATE orchestration_v2_projection_threads SET deleted_at = ? WHERE thread_id = ?').run('2026-10-04', 'deleted-app');
  applySessionMetadata(periods, home, deps);
  assert.equal(original.title, 'Native fallback');
  assert.equal(original.turnEnded, true);
  assert.equal(active.title, 'Active T3 title');

  const fresh = makeSession('deleted-native', 'Newer native title');
  applySessionMetadata({ allTime: { sessions: { 'claude:deleted-native': fresh } } }, home, deps);
  assert.equal(fresh.title, 'Newer native title');
  assert.equal(fresh.turnEnded, true);

  const projects = path.join(home, '.claude', 'projects', 'test-project');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'deleted-native.jsonl'), JSON.stringify({
    type: 'custom-title', customTitle: 'Current native transcript title'
  }) + '\n');
  applySessionMetadata(periods, home, deps);
  assert.equal(original.title, 'Current native transcript title');
});
