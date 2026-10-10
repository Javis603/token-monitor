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
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
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
    projectLabel: 'Existing project', title: 'Title without transcript',
    t3Title: 'Title without transcript', titleOnly: true
  });
  const { title: _title, t3Title: _t3Title, titleFallback: _titleFallback, ...metrics } = result.get('t3-native');
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

maybe('watch titles learned or renamed after a full scan survive T3 read misses', async (t) => {
  const { home, db, v2 } = store(t);
  let captured;
  const options = {
    clients: 'claude', homeDir: home, projectsEnabled: false, historyEnabled: false,
    wslScanEnabled: false, osInfo: {},
    sessionMetadataDeps: { scopedHome: true, claudeMetadataDeps: { sqlite, cache: new Map() } },
    runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 'native', model: 'claude-opus', input: 10, output: 0, cost: 0 }] }),
    onAnchorComputed: (value) => { captured = value; }
  };
  const initial = await collectUsageOnce(options);
  const anchor = {
    dateKey: localTodayKey(), utcOffsetMinutes: require('../../src/shared/history').utcOffsetMinutes(),
    today: initial.today, month: initial.month, allTime: initial.allTime,
    todayPartitions: captured.todayPartitions, t3Titles: captured.t3Titles
  };
  const watch = async (sqliteMod = sqlite) => {
    const summary = await collectUsageOnce({
      ...options, todayOnlyAnchor: anchor,
      sessionMetadataDeps: { scopedHome: true, claudeMetadataDeps: { sqlite: sqliteMod, cache: new Map() } }
    });
    anchor.todayPartitions = captured.todayPartitions;
    anchor.todayT3Titles = captured.t3Titles;
    return summary;
  };
  const expectTitles = (summary, expected) => {
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(summary[period].sessions['claude:native'].title || '', expected);
      assert.equal(summary[period].totalTokens, initial[period].totalTokens);
    }
  };
  v2('app', 'native', 'Late T3 title');
  expectTitles(await watch(), 'Late T3 title');
  expectTitles(await watch(null), 'Late T3 title');
  expectTitles(await watch(null), 'Late T3 title');
  db.prepare('UPDATE orchestration_v2_projection_threads SET title = ?').run('Renamed T3 title');
  expectTitles(await watch(), 'Renamed T3 title');
  expectTitles(await watch(null), 'Renamed T3 title');
  assert.equal(initial.month.sessions['claude:native'].title || '', '', 'watch labels do not rewrite the full-scan anchor');
  db.prepare('UPDATE orchestration_v2_projection_threads SET deleted_at = ?').run('2026-10-05');
  expectTitles(await watch(), '');
  expectTitles(await watch(null), '');
  db.prepare('UPDATE orchestration_v2_projection_threads SET title = ?, deleted_at = NULL').run('Revived T3 title');
  expectTitles(await watch(), 'Revived T3 title');
  expectTitles(await watch(null), 'Revived T3 title');
});

for (const unusable of [
  { label: 'tombstone', title: 'Old T3 title', deleted: '2026-10-04' },
  { label: 'empty title', title: '', deleted: null },
  { label: 'placeholder', title: 'New thread', deleted: null }
]) {
  maybe(`Claude invalidates all cached T3 overrides on an authoritative V2 ${unusable.label}`, (t) => {
    const { home, db, v2, legacy } = store(t);
    const projects = path.join(home, '.claude', 'projects', 'test-project');
    fs.mkdirSync(projects, { recursive: true });
    const sessions = {};
    for (const id of ['untitled-transcript', 'named-transcript', 'missing-transcript']) {
      v2(`app-${id}`, id, 'Old T3 title');
      legacy(`legacy-${id}`, id, 'Stale legacy title');
      sessions[`claude:${id}`] = { client: 'claude', sessionId: id, lastUsedAt: '2026-10-04T00:00:00Z' };
      if (id === 'missing-transcript') {
        sessions[`claude:${id}`].title = 'Scanned native title';
        continue;
      }
      const records = [{ type: 'assistant', timestamp: '2026-10-04T00:00:00Z', message: { stop_reason: 'end_turn' } }];
      if (id === 'named-transcript') records.push({ type: 'custom-title', customTitle: 'Native custom title' });
      fs.writeFileSync(path.join(projects, `${id}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    }
    const deps = {
      scopedHome: true, now: Date.parse('2026-10-04T00:01:00Z'),
      metadataCache: new Map(), claudeMetadataDeps: { sqlite, cache: new Map() }
    };
    const periods = { today: { sessions } };
    applySessionMetadata(periods, home, deps);
    assert.equal(deps.metadataCache.get('claude:untitled-transcript').titleOnly, undefined);
    for (const session of Object.values(sessions)) assert.equal(session.title, 'Old T3 title');
    db.prepare('UPDATE orchestration_v2_projection_threads SET title = ?, deleted_at = ?').run(unusable.title, unusable.deleted);
    applySessionMetadata(periods, home, deps);
    assert.equal(Object.hasOwn(sessions['claude:untitled-transcript'], 'title'), false);
    assert.equal(sessions['claude:untitled-transcript'].turnEnded, true);
    assert.equal(sessions['claude:named-transcript'].title, 'Native custom title');
    assert.equal(sessions['claude:missing-transcript'].title, 'Scanned native title');
    for (const meta of deps.metadataCache.values()) assert.equal(Object.hasOwn(meta, 't3Title'), false);

    db.prepare('UPDATE orchestration_v2_projection_threads SET title = ?, deleted_at = NULL').run('Old T3 title');
    applySessionMetadata(periods, home, deps);
    for (const session of Object.values(sessions)) assert.equal(session.title, 'Old T3 title');
    applySessionMetadata(periods, home, {
      ...deps, claudeMetadataDeps: { ...deps.claudeMetadataDeps, sqlite: null }
    });
    for (const session of Object.values(sessions)) assert.equal(session.title, 'Old T3 title');
  });

  maybe(`anchored Claude collection propagates an authoritative V2 ${unusable.label}`, async (t) => {
    const { home, db, v2, legacy } = store(t);
    const ids = ['untitled-transcript', 'named-transcript', 'missing-transcript', 'native-only'];
    const projects = path.join(home, '.claude', 'projects', 'test-project');
    fs.mkdirSync(projects, { recursive: true });
    for (const id of ids) {
      v2(`app-${id}`, id, id === 'native-only' ? 'New thread' : 'Old T3 title');
      legacy(`legacy-${id}`, id, 'Stale legacy title');
      if (id === 'missing-transcript' || id === 'native-only') continue;
      const records = [{ type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn' } }];
      if (id === 'named-transcript') records.push({ type: 'custom-title', customTitle: 'Native title' });
      fs.writeFileSync(path.join(projects, `${id}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    }
    let scans = 0;
    let captured;
    let nativeScanTitle = true;
    const options = {
      clients: 'claude', homeDir: home, projectsEnabled: false, historyEnabled: false,
      wslScanEnabled: false, osInfo: {},
      sessionMetadataDeps: { scopedHome: true, claudeMetadataDeps: { sqlite, cache: new Map() } },
      runTokscale: async ({ flags }) => {
        scans++;
        const input = flags.includes('--month') ? 100 : flags.includes('--since') ? 1000 : 10;
        return { entries: ids.map((sessionId) => ({
          client: 'claude', sessionId, model: 'claude-opus', input, output: 0, cost: 0,
          ...(sessionId === 'native-only' && nativeScanTitle ? { sessionTitle: 'Native scan label' } : {})
        })) };
      },
      onAnchorComputed: (value) => { captured = value; }
    };
    const initial = await collectUsageOnce(options);
    assert.equal(scans, 3);
    for (const period of ['today', 'month', 'allTime']) {
      for (const id of ids) assert.equal(initial[period].sessions[`claude:${id}`].title,
        id === 'native-only' ? 'Native scan label' : 'Old T3 title');
    }
    const anchor = JSON.parse(JSON.stringify({
      dateKey: localTodayKey(), utcOffsetMinutes: require('../../src/shared/history').utcOffsetMinutes(),
      today: initial.today, month: initial.month, allTime: initial.allTime,
      todayPartitions: captured.todayPartitions, t3Titles: captured.t3Titles
    }));
    const watchOptions = { ...options, todayOnlyAnchor: anchor, targetClients: ['claude'] };
    nativeScanTitle = false;

    // A reader failure is a miss: broader periods retain their known title.
    const transient = await collectUsageOnce({
      ...watchOptions,
      sessionMetadataDeps: { scopedHome: true, claudeMetadataDeps: { sqlite: null, cache: new Map() } }
    });
    for (const period of ['month', 'allTime']) {
      for (const id of ids) assert.equal(transient[period].sessions[`claude:${id}`].title,
        id === 'native-only' ? 'Native scan label' : 'Old T3 title');
    }

    db.prepare('UPDATE orchestration_v2_projection_threads SET title = ?, deleted_at = ?').run(unusable.title, unusable.deleted);
    const before = scans;
    const invalidated = await collectUsageOnce(watchOptions);
    assert.equal(scans - before, 1, 'watch collection still scans only today');
    const periods = [invalidated.today, invalidated.month, invalidated.allTime, captured.todayPartitions.claude];
    for (const period of periods) {
      assert.equal(period.sessions['claude:untitled-transcript'].title || '', '');
      assert.equal(period.sessions['claude:missing-transcript'].title || '', '');
      assert.equal(period.sessions['claude:named-transcript'].title, 'Native title');
      assert.equal(period.sessions['claude:untitled-transcript'].turnEnded, true);
      for (const session of Object.values(period.sessions)) {
        assert.equal(Object.hasOwn(session, 'invalidatedTitleKeys'), false);
        assert.equal(Object.hasOwn(session, 't3Title'), false);
      }
    }
    for (const period of ['month', 'allTime']) assert.equal(invalidated[period].sessions['claude:native-only'].title, 'Native scan label');
    assert.equal(invalidated.today.totalTokens, initial.today.totalTokens);
    assert.equal(invalidated.month.totalTokens, initial.month.totalTokens);
    assert.equal(invalidated.allTime.totalTokens, initial.allTime.totalTokens);
    assert.equal(initial.month.sessions['claude:untitled-transcript'].title, 'Old T3 title', 'the full-scan anchor remains immutable');
    assert.equal(Object.hasOwn(invalidated, 't3Titles'), false);

    db.prepare('UPDATE orchestration_v2_projection_threads SET title = ?, deleted_at = NULL').run('Revived T3 title');
    const revived = await collectUsageOnce(watchOptions);
    for (const period of ['today', 'month', 'allTime']) {
      for (const id of ids) assert.equal(revived[period].sessions[`claude:${id}`].title, 'Revived T3 title');
    }
    // A partition can carry a more recent T3 rename than the frozen full scan.
    anchor.todayPartitions = captured.todayPartitions;
    anchor.todayT3Titles = captured.t3Titles;
    db.prepare('UPDATE orchestration_v2_projection_threads SET title = ?, deleted_at = ?').run(unusable.title, unusable.deleted);
    const untargeted = await collectUsageOnce({
      ...watchOptions, clients: 'claude,codex', targetClients: ['codex'],
      todayOnlyAnchor: { ...anchor, todayPartitions: { ...anchor.todayPartitions, codex: { sessions: {} } } },
      runTokscale: async () => ({ entries: [] })
    });
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(untargeted[period].sessions['claude:untitled-transcript'].title || '', '');
      assert.equal(untargeted[period].sessions['claude:missing-transcript'].title || '', '');
      assert.equal(untargeted[period].sessions['claude:named-transcript'].title, 'Native title');
    }
    anchor.todayPartitions = captured.todayPartitions;
    anchor.todayT3Titles = captured.t3Titles;
    const afterRemovalMiss = await collectUsageOnce({
      ...watchOptions,
      sessionMetadataDeps: { scopedHome: true, claudeMetadataDeps: { sqlite: null, cache: new Map() } }
    });
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(afterRemovalMiss[period].sessions['claude:untitled-transcript'].title || '', '');
      assert.equal(afterRemovalMiss[period].sessions['claude:missing-transcript'].title || '', '');
      assert.equal(afterRemovalMiss[period].sessions['claude:named-transcript'].title, 'Native title');
    }
  });
}
