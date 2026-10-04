'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const metadata = require('../../src/shared/providers/codex/sessionMetadata');
const maybe = sqlite ? test : test.skip;
const tmpDirs = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb(rows, schema = 'full') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meta-'));
  tmpDirs.push(root);
  const file = path.join(root, 'state_5.sqlite');
  const db = new sqlite.DatabaseSync(file);
  if (schema === 'minimal') {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)');
    const insert = db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)');
    for (const row of rows) insert.run(row.id, row.title || '');
  } else {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, preview TEXT, first_user_message TEXT, title TEXT, model TEXT, thread_source TEXT, source TEXT)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(
      row.id, row.name || '', row.preview || '', row.firstUserMessage || '', row.title || '',
      row.model || '', row.threadSource || '', row.source || ''
    );
  }
  db.close();
  return file;
}

// T3 Code keeps its own thread catalog: a T3 thread id (unrelated to Codex's)
// whose runtime cursor names the Codex thread it drives. The generated display
// title lives only on that T3 row, so it is only reachable through this join.
function makeT3Db(rows, { cursorColumn = 'resume_cursor_json', deletedColumn = 'deleted_at' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-meta-'));
  tmpDirs.push(root);
  const file = path.join(root, 'state.sqlite');
  const db = new sqlite.DatabaseSync(file);
  const deleted = deletedColumn ? `, ${deletedColumn} TEXT` : '';
  db.exec(`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, title TEXT${deleted})`);
  db.exec(`CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, provider_name TEXT, ${cursorColumn} TEXT)`);
  for (const row of rows) {
    const columns = deletedColumn ? `(thread_id, title, ${deletedColumn})` : '(thread_id, title)';
    const placeholders = deletedColumn ? '(?, ?, ?)' : '(?, ?)';
    const values = deletedColumn ? [row.t3ThreadId, row.title, row.deletedAt || null] : [row.t3ThreadId, row.title];
    db.prepare(`INSERT INTO projection_threads ${columns} VALUES ${placeholders}`).run(...values);
    db.prepare(`INSERT INTO provider_session_runtime (thread_id, provider_name, ${cursorColumn}) VALUES (?, ?, ?)`)
      .run(row.t3ThreadId, row.providerName || 'codex', JSON.stringify({ threadId: row.codexThreadId }));
  }
  db.close();
  return file;
}

function makeT3V2Db(rows, stateDir) {
  const root = stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 't3-v2-meta-'));
  if (!stateDir) tmpDirs.push(root);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'statev2.sqlite');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, default_provider TEXT, deleted_at TEXT, updated_at TEXT)');
  db.exec('CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT, driver TEXT, provider_session_id TEXT, payload_json TEXT)');
  rows.forEach((row, index) => {
    db.prepare('INSERT OR REPLACE INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?)')
      .run(row.t3ThreadId, row.title, row.defaultProvider || 'codex', row.deletedAt || null, row.updatedAt || '2026-10-04T00:00:00Z');
    db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?, ?)')
      .run(`provider-${index}`, row.t3ThreadId, row.provider || 'codex', row.driver || 'codex',
        'provider-session:provider-instance:codex:shared', row.payload ?? JSON.stringify({
          nativeThreadRef: { driver: row.driver || 'codex', nativeId: row.codexThreadId }
        }));
  });
  db.close();
  return file;
}

maybe('reads persisted display titles and classifies guardian reviews without exposing their prompts', () => {
  const file = makeDb([
    { id: 'named', name: '繼續目前工作', preview: 'ignored preview' },
    {
      id: 'fallback',
      preview: '[@image.png](file:///private/a.png) Fix the compact session list Use the available Lody MCP tools when relevant; ignore this suffix.'
    },
    { id: 'review-model', model: 'codex-auto-review', preview: 'private review prompt' },
    { id: 'review-user', model: 'codex-auto-review', threadSource: 'user', source: '{"subagent":{"other":"guardian"}}' },
    { id: 'review-source', threadSource: 'guardian_review', title: 'private guardian title' },
    { id: 'review-json-source', threadSource: 'subagent', source: '{"subagent":{"other":"guardian"}}' }
  ]);

  const result = metadata.readSessionMeta([
    'named', 'fallback', 'review-model', 'review-user', 'review-source', 'review-json-source'
  ], {
    dbPaths: [file],
    sqlite
  });

  assert.deepEqual(result.get('named'), { title: '繼續目前工作' });
  assert.equal(result.has('fallback'), false);
  assert.equal(result.has('review-model'), false);
  assert.equal(result.has('review-user'), false);
  assert.deepEqual(result.get('review-source'), { sessionKind: 'background-review' });
  assert.deepEqual(result.get('review-json-source'), { sessionKind: 'background-review' });
});

maybe('tolerates older thread schemas and uses title as the final fallback', () => {
  const file = makeDb([{ id: 'old', title: 'Older Codex thread' }], 'minimal');
  assert.deepEqual(metadata.readSessionMeta(['old'], { dbPaths: [file], sqlite }).get('old'), {
    title: 'Older Codex thread'
  });
});

maybe('maps Tokscale rollout ids and merged rollout ids back to Codex thread UUIDs', () => {
  const first = '01a08a9f-4c18-7b81-9f7d-072365428426';
  const second = '01a08aa3-1ce6-7312-bfe8-94a766d11890';
  const file = makeDb([
    { id: first, name: 'First thread' },
    { id: second, name: 'Second thread' }
  ]);
  const prefixed = `rollout-2026-09-10T20-09-00-${first}`;
  const merged = `${prefixed}_rollout-2026-09-10T18-21-00-${second}`;

  const result = metadata.readSessionMeta([prefixed, merged], { dbPaths: [file], sqlite });

  assert.deepEqual(result.get(prefixed), { title: 'First thread' });
  assert.deepEqual(result.get(merged), { title: 'First thread' });
  assert.deepEqual(metadata.threadIdCandidates(merged), [merged, first, second]);
});

maybe('reads the T3 Code title through its runtime cursor join and ignores its placeholder', () => {
  const ours = '01a0a091-18da-7123-b874-e75d66eaae9c';
  const other = '01a0a0d2-3da6-7151-9e15-7673a4b40d1f';
  const claudeDriven = '01a09bfb-b843-76e1-93fb-21bf598bc92c';
  const file = makeT3Db([
    { t3ThreadId: '99ccacdd-6ddb-4f59-bc4b-c0275c75b0b7', codexThreadId: ours, title: '修正 Droid 標籤與 Provider 排序' },
    { t3ThreadId: '5469367a-1bf6-44f1-9ec5-4875048f01f3', codexThreadId: other, title: 'Start a New Conversation' },
    { t3ThreadId: 'dead-dead-dead-dead-dead', codexThreadId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Deleted thread', deletedAt: '2026-09-14T00:00:00Z' },
    // The only row naming this Codex thread belongs to another provider, so it
    // must not answer for a Codex session even though the id matches.
    { t3ThreadId: 'beef-beef-beef-beef-beef', codexThreadId: claudeDriven, title: 'Claude title', providerName: 'claudeAgent' }
  ]);

  // Tokscale reports the rollout id; T3 stores the bare Codex thread id.
  const rollout = `rollout-2026-09-14T23-37-38-${ours}`;
  const result = metadata.readT3SessionMeta([rollout], { t3DbPaths: [file], sqlite });
  assert.deepEqual(result.get(rollout), { title: '修正 Droid 標籤與 Provider 排序' });

  // A thread T3 has not titled yet carries its placeholder, which is not a title.
  assert.equal(metadata.readT3SessionMeta([other], { t3DbPaths: [file], sqlite }).has(other), false);
  // A deleted T3 thread is not a title source.
  assert.equal(metadata.readT3SessionMeta(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], { t3DbPaths: [file], sqlite }).size, 0);
  // A thread driven by another provider is not a Codex title source.
  assert.equal(metadata.readT3SessionMeta([claudeDriven], { t3DbPaths: [file], sqlite }).size, 0);
});

maybe('an untitled T3 thread and an unreachable store are skipped rather than failing', () => {
  // A thread T3 has run but never generated a title for yet.
  const file = makeT3Db([
    { t3ThreadId: 'untitled', codexThreadId: '01a0a091-18da-7123-b874-e75d66eaae9c', title: 'New thread' }
  ], { deletedColumn: '' });
  assert.equal(metadata.readT3SessionMeta(['01a0a091-18da-7123-b874-e75d66eaae9c'], { t3DbPaths: [file], sqlite }).size, 0);
  // A missing database is an absence of T3, not an error.
  assert.equal(metadata.readT3SessionMeta(['01a0a091-18da-7123-b874-e75d66eaae9c'], {
    t3DbPaths: [path.join(os.tmpdir(), 'does-not-exist', 'state.sqlite')],
    sqlite
  }).size, 0);
});

maybe('T3 V2 maps native threads separately even when their provider session is shared', () => {
  const first = '01a10238-ae80-72a2-a21f-8db41915b3dc';
  const second = '01a10293-14c7-76d3-8df9-9a71c4b49659';
  const file = makeT3V2Db([
    { t3ThreadId: 'pricing', codexThreadId: first, title: 'Tokscale 自訂定價覆蓋限制', defaultProvider: 'claudeAgent' },
    // A custom provider instance still uses the Codex driver.
    { t3ThreadId: 'codebuddy', codexThreadId: second, title: 'Review CodeBuddy Usage Tracking', provider: 'custom-codex' },
    { t3ThreadId: 'bad-json', title: 'Malformed payload', payload: '{' },
    { t3ThreadId: 'pending', title: 'Not started', payload: '{}' },
    { t3ThreadId: 'placeholder', codexThreadId: 'placeholder', title: 'New thread' },
    { t3ThreadId: 'deleted', codexThreadId: 'deleted', title: 'Deleted title', deletedAt: '2026-10-04T00:00:00Z' },
    { t3ThreadId: 'claude', codexThreadId: 'claude', title: 'Claude title', driver: 'claudeAgent' }
  ]);
  const rollout = `rollout-2026-10-03T00-00-00-${first}`;
  const merged = `${rollout}_rollout-2026-10-03T01-00-00-${second}`;
  const result = metadata.readT3SessionMeta([first, second, rollout, merged, 'placeholder', 'deleted', 'claude'], { t3DbPaths: [file], sqlite });
  assert.deepEqual(result, new Map([
    [first, { title: 'Tokscale 自訂定價覆蓋限制' }],
    [second, { title: 'Review CodeBuddy Usage Tracking' }],
    [rollout, { title: 'Tokscale 自訂定價覆蓋限制' }],
    [merged, { title: 'Tokscale 自訂定價覆蓋限制' }]
  ]));

  const db = new sqlite.DatabaseSync(file);
  db.prepare('UPDATE orchestration_v2_projection_threads SET title = ? WHERE thread_id = ?').run('Renamed pricing thread', 'pricing');
  db.close();
  assert.deepEqual(metadata.readT3SessionMeta([first], { t3DbPaths: [file], sqlite }).get(first), { title: 'Renamed pricing thread' });
});

maybe('T3 V2 discovers the new store before stale legacy titles and preserves Codex names', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3-v2-home-'));
  tmpDirs.push(home);
  const first = '01a10238-ae80-72a2-a21f-8db41915b3dc';
  const second = '01a10293-14c7-76d3-8df9-9a71c4b49659';
  const legacyOnly = '01a10295-0c81-7aa1-a22a-a94d8ceed1ed';
  const stateDir = path.join(home, '.t3', 'userdata');
  makeT3V2Db([
    { t3ThreadId: 'v2-first', codexThreadId: first, title: 'Current T3 title' },
    { t3ThreadId: 'v2-second', codexThreadId: second, title: 'Other T3 title' }
  ], stateDir);
  const legacy = makeT3Db([
    { t3ThreadId: 'legacy-first', codexThreadId: first, title: 'Stale legacy title' },
    { t3ThreadId: 'legacy-only', codexThreadId: legacyOnly, title: 'Legacy-only title' }
  ]);
  fs.copyFileSync(legacy, path.join(stateDir, 'state.sqlite'));
  const codex = makeDb([
    { id: first, title: 'First user message' },
    { id: second, name: 'Real Codex name', title: 'Another first message' }
  ]);
  const result = metadata.resolveSessionMetadata(new Set([first, second, legacyOnly]), {
    deps: { scopedHome: true, codexDeps: { dbPaths: [codex], sqlite } },
    home,
    metadata: new Map(),
    fileSessionMetadata: (_sessionId, _filePath, existing) => existing || {}
  });
  assert.equal(result.get(first).title, 'Current T3 title');
  assert.equal(result.get(second).title, 'Real Codex name');
  assert.equal(result.get(legacyOnly).title, 'Legacy-only title');
});

test('discovers the newest state database first and honors CODEX_HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  tmpDirs.push(root);
  fs.writeFileSync(path.join(root, 'state_2.sqlite'), '');
  fs.writeFileSync(path.join(root, 'state_5.sqlite'), '');
  fs.mkdirSync(path.join(root, 'sqlite'));
  fs.writeFileSync(path.join(root, 'sqlite', 'state_4.sqlite'), '');

  assert.deepEqual(metadata.discoverDbPaths({ env: { CODEX_HOME: root } }), [
    path.join(root, 'state_5.sqlite'),
    path.join(root, 'state_2.sqlite'),
    path.join(root, 'sqlite', 'state_4.sqlite')
  ]);
});

test('the default T3 discovery covers every installed and dev state layout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3-default-home-'));
  tmpDirs.push(home);
  const root = path.join(home, '.t3');

  const paths = metadata.discoverT3DbPaths({ homeDir: home });

  // An installed app is the common case, so its store stays first.
  assert.equal(paths[0], path.join(root, 'userdata', 'statev2.sqlite'));
  assert.equal(paths[1], path.join(root, 'userdata', 'state.sqlite'));
  assert.ok(paths.includes(path.join(root, 'dev', 'userdata', 'statev2.sqlite')), 'V2 dev-runner layout missing');
  assert.ok(paths.includes(path.join(root, 'dev', 'statev2.sqlite')), 'V2 dev layout missing');
  assert.ok(paths.includes(path.join(root, 'dev', 'userdata', 'state.sqlite')), 'dev-runner layout missing');
  assert.ok(paths.includes(path.join(root, 'dev', 'state.sqlite')), 'dev layout missing');
  assert.equal(new Set(paths).size, paths.length, 'paths must be deduped');
});

test('T3CODE_HOME expands a leading tilde the way T3 Code itself does', () => {
  // Build the home from the running platform's filesystem root so it is already
  // absolute on Windows too (`D:\home\someone`), which `path.resolve` preserves.
  const home = path.join(path.parse(process.cwd()).root, 'home', 'someone');
  const t3Root = (value) => metadata.t3HomeDir({ homeDir: home, env: { T3CODE_HOME: value } });

  // T3 resolves `resolve(expandHomePath(raw.trim()))`, so these land in home.
  assert.equal(t3Root('~'), home);
  assert.equal(t3Root('~/custom-t3'), path.join(home, 'custom-t3'));
  // T3 drops the leading separator for both forms and joins the remainder, so a
  // backslash-typed path resolves under home on POSIX too rather than staying a
  // literal name with a backslash in it.
  assert.equal(metadata.expandHomePath('~\\custom-t3', home), path.join(home, 'custom-t3'));
  // An absolute path is left alone.
  const absolute = path.join(path.parse(process.cwd()).root, 'srv', 't3');
  assert.equal(t3Root(absolute), absolute);
  // A bare `~` inside a longer segment is a literal directory name, not home.
  assert.equal(metadata.expandHomePath('~x', home), '~x');
  assert.equal(metadata.expandHomePath('a/~/b', home), 'a/~/b');
  // Absent or blank, the default base directory still applies.
  assert.equal(t3Root(''), path.join(home, '.t3'));
  assert.equal(metadata.t3HomeDir({ homeDir: home, env: {} }), path.join(home, '.t3'));
  // T3 only trims the value, so internal spaces are preserved verbatim.
  const spaced = metadata.t3HomeDir({ homeDir: home, env: { T3CODE_HOME: '/srv/T3  Data ' } });
  assert.equal(spaced, path.resolve('/srv/T3  Data'));
  assert.match(spaced, /T3 {2}Data$/);
});

maybe('a tilde T3CODE_HOME still finds the store instead of failing closed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3-tilde-home-'));
  tmpDirs.push(home);
  const codexThreadId = '01a0a091-18da-7123-b874-e75d66eaae9c';
  // T3CODE_HOME is the base directory; the server database sits under `userdata`.
  const stateDir = path.join(home, 'userdata');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(stateDir, 'state.sqlite'));
  db.exec('CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT)');
  db.exec('CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, provider_name TEXT, resume_cursor_json TEXT)');
  db.prepare('INSERT INTO projection_threads VALUES (?, ?, NULL)').run('t3-1', 'T3 title via tilde home');
  db.prepare('INSERT INTO provider_session_runtime VALUES (?, ?, ?)')
    .run('t3-1', 'codex', JSON.stringify({ threadId: codexThreadId }));
  db.close();

  // The populated store sits in a custom root, reached only if the tilde expands:
  // without expansion the reader would stat a literal `~` directory and give up.
  const result = metadata.readT3SessionMeta([codexThreadId], {
    homeDir: home,
    env: { T3CODE_HOME: '~' },
    sqlite
  });
  assert.deepEqual(result.get(codexThreadId), { title: 'T3 title via tilde home' });
});

test('title cleaning is Unicode-safe and bounded', () => {
  const cleaned = metadata.cleanSessionTitle('🧪'.repeat(metadata.TITLE_MAX_CODE_POINTS + 20));
  assert.equal(Array.from(cleaned).length, metadata.TITLE_MAX_CODE_POINTS);
  assert.match(cleaned, /…$/);
});

maybe('a name that cleans away is not treated as a generated title', () => {
  const id = '01a0a091-18da-7123-b874-e75d66eaae9c';
  // `cleanText(name)` is non-empty here, but `cleanSessionTitle(name)` strips it to
  // nothing, so the displayed title is the `title` fallback and T3 may still win.
  const file = makeDb([{ id, name: '[@image.png](file:///private/a.png)', title: 'first user message' }]);
  const sources = new Map();
  const rows = metadata.readSessionMeta([id], { dbPaths: [file], sqlite, titleSourceById: sources });

  assert.deepEqual(rows.get(id), { title: 'first user message' });
  assert.equal(sources.get(id), false);
});

maybe('the T3 title outranks a prompt-derived Codex label but never a generated one', () => {
  const promptTitled = '01a0a091-18da-7123-b874-e75d66eaae9c';
  const appTitled = '01a0a0d2-3da6-7151-9e15-7673a4b40d1f';
  const codexFile = makeDb([
    // Only `title` set: Codex itself never generated a name, so the row's title
    // is the first user message and T3's generated one is the better answer.
    { id: promptTitled, title: '我發現需要整理上一個 commit 的東西' },
    // `name` set: a real Codex-generated title that must win.
    { id: appTitled, name: 'T3 Code Thread Title Display', title: 'hi' }
  ]);
  const t3File = makeT3Db([
    { t3ThreadId: '99ccacdd-6ddb-4f59-bc4b-c0275c75b0b7', codexThreadId: promptTitled, title: '修正 Droid 標籤與 Provider 排序' },
    { t3ThreadId: '7cbf027c-0539-45cb-bd61-6b50b24f623b', codexThreadId: appTitled, title: 'A T3 title that must not win' }
  ]);
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-empty-'));
  tmpDirs.push(emptyHome);

  const result = metadata.resolveSessionMetadata(new Set([promptTitled, appTitled]), {
    deps: { scopedHome: true, codexDeps: { dbPaths: [codexFile], t3DbPaths: [t3File], sqlite } },
    home: emptyHome,
    metadata: new Map(),
    resolveProjects: false,
    fileSessionMetadata: (sessionId, filePath, existing) => existing || {}
  });

  assert.equal(result.get(promptTitled).title, '修正 Droid 標籤與 Provider 排序');
  assert.equal(result.get(appTitled).title, 'T3 Code Thread Title Display');
});

maybe('T3 lookup only receives sessions whose title it can still improve', () => {
  const named = '01a0a091-18da-7123-b874-e75d66eaae9c';
  const other = '01a0a0d2-3da6-7151-9e15-7673a4b40d1f';
  const rollout = `rollout-2026-09-14T23-37-38-${named}`;
  const merged = `${rollout}_rollout-2026-09-14T23-38-00-${other}`;
  const codexFile = makeDb([
    { id: named, name: 'Codex generated', title: 'First prompt' },
    { id: other, title: 'Another prompt' },
    { id: 'prompt', title: 'First prompt' },
    { id: 'stripped', name: '[@image.png](file:///private/a.png)', title: 'First prompt' },
    { id: 'blank', name: '   ' },
    { id: 'review', name: 'Private review', threadSource: 'guardian_review' }
  ]);
  const fallbackIds = ['prompt', 'stripped', 'blank', 'missing', 'review'];
  const t3File = makeT3Db([named, other, ...fallbackIds].map((id) => ({
    t3ThreadId: `t3-${id}`, codexThreadId: id, title: `T3 ${id}`
  })));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-t3-filter-'));
  tmpDirs.push(home);
  const requested = [];
  const resolve = () => metadata.resolveSessionMetadata(new Set([rollout, merged, ...fallbackIds]), {
    deps: {
      scopedHome: true,
      codexDeps: { dbPaths: [codexFile], sqlite },
      readT3Meta(ids) {
        requested.push([...ids]);
        return metadata.readT3SessionMeta(ids, { t3DbPaths: [t3File], sqlite });
      }
    },
    home,
    metadata: new Map(),
    resolveProjects: false,
    fileSessionMetadata: (_sessionId, _filePath, existing) => existing || {}
  });

  const result = resolve();
  assert.deepEqual(requested, [fallbackIds]);
  assert.equal(result.get(rollout).title, 'Codex generated');
  assert.equal(result.get(merged).title, 'Codex generated');
  for (const id of fallbackIds) assert.equal(result.get(id).title, `T3 ${id}`);
  assert.equal(result.get('review').sessionKind, 'background-review');

  // Eligibility comes from this pass's Codex rows, not a persistent title cache.
  // Removing a generated name must restore T3 fallback on the very next pass;
  // assigning one must immediately stop that session's fallback query.
  const db = new sqlite.DatabaseSync(codexFile);
  db.prepare('UPDATE threads SET name = ? WHERE id = ?').run('', named);
  db.prepare('UPDATE threads SET name = ? WHERE id = ?').run('New Codex name', 'prompt');
  db.close();
  const renamed = resolve();
  assert.deepEqual(requested[1], [rollout, merged, 'stripped', 'blank', 'missing', 'review']);
  assert.equal(renamed.get(rollout).title, `T3 ${named}`);
  assert.equal(renamed.get(merged).title, `T3 ${named}`);
  assert.equal(renamed.get('prompt').title, 'New Codex name');
});

maybe('an already named Codex history does not open the T3 database', () => {
  const rows = Array.from({ length: 401 }, (_, index) => ({ id: `named-${index}`, name: `Codex ${index}` }));
  const codexFile = makeDb(rows);
  const t3File = makeT3Db([
    { t3ThreadId: 't3-0', codexThreadId: rows[0].id, title: 'Unused T3 title' }
  ]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-t3-named-'));
  tmpDirs.push(home);
  let t3Opens = 0;
  const observedSqlite = {
    DatabaseSync: function(file, options) {
      if (file === t3File) t3Opens += 1;
      return new sqlite.DatabaseSync(file, options);
    }
  };
  const result = metadata.resolveSessionMetadata(new Set(rows.map((row) => row.id)), {
    deps: { scopedHome: true, codexDeps: { dbPaths: [codexFile], t3DbPaths: [t3File], sqlite: observedSqlite } },
    home,
    metadata: new Map(),
    resolveProjects: false,
    fileSessionMetadata: (_sessionId, _filePath, existing) => existing || {}
  });

  // Count work rather than elapsed time: this remains deterministic on slow CI.
  assert.equal(t3Opens, 0);
  assert.deepEqual(result, new Map(rows.map((row) => [row.id, { title: row.name }])));
});
