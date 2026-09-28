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
  assert.equal(paths[0], path.join(root, 'userdata', 'state.sqlite'));
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
