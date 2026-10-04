'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveSqlite, openDb } = require('./sqliteReadOnly');

const QUERY_CHUNK_SIZE = 400;
const T3_DEFAULT_TITLES = new Set(['new thread', 'start a new conversation']);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanT3Title(value) {
  const chars = Array.from(cleanText(value));
  return chars.length <= 96 ? chars.join('') : `${chars.slice(0, 95).join('')}…`;
}

// T3 Code keeps its own display titles for each provider. Its state lives under a
// base directory of its own, with the server database one level below in
// `userdata` (a dev-server run writes to `dev` instead).
//
// Only the installed layouts are covered: the default home and an explicit
// `T3CODE_HOME`. A T3 dev run inside a linked git worktree keeps its state in
// that worktree's own `.t3`, which is not reachable from the home directory;
// those sessions keep their native fallback title.
//
// T3 expands a leading `~` against the user's home before resolving the base
// directory, so `T3CODE_HOME=~/t3-alt` means the home directory rather than a
// literal `~` directory under the working directory. Mirror its rule exactly:
// a lone `~` is home, `~/...` and `~\...` drop that first separator and join the
// rest onto home, and anything else is left untouched.
function expandHomePath(value, homeDir) {
  const raw = String(value || '');
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homeDir, raw.slice(2));
  return raw;
}

function t3HomeDir(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  if (options.useEnvRoot !== false) {
    // T3 only trims this value, so collapse nothing: a path containing a
    // doubled space is a different directory, not a cosmetic difference.
    const configured = String(env.T3CODE_HOME || '').trim();
    if (configured) return path.resolve(expandHomePath(configured, homeDir));
  }
  return path.join(homeDir, '.t3');
}

function discoverT3DbPaths(options = {}) {
  if (Array.isArray(options.t3DbPaths)) {
    return [...new Set(options.t3DbPaths.map(String).filter(Boolean))];
  }
  const root = t3HomeDir(options);
  const stateDirs = [
    path.join(root, 'userdata'),
    // A dev server keeps its state beside the base directory rather than in it.
    // T3 picks that state directory from two rules that can disagree on which
    // subdirectory applies: the desktop app uses `dev` when the run is a dev one
    // and no `T3CODE_HOME` is configured, while the server uses `dev` only when no
    // explicit base directory was given. A `T3CODE_HOME` therefore counts as
    // explicit and lands under `dev/userdata`. Check both dev layouts; the
    // leading `userdata` path stays first because an installed app is the common
    // case and is the authoritative store when it exists.
    path.join(root, 'dev', 'userdata'),
    path.join(root, 'dev')
  ];
  // V2 leaves the legacy database behind; its titles can be stale after migration.
  return [...new Set(stateDirs.flatMap((dir) => [
    path.join(dir, 'statev2.sqlite'), path.join(dir, 'state.sqlite')
  ]))];
}

// Provider native ids survive switches. T3 app thread ids and shared provider
// session ids are not native conversation identities.
function t3TitleQueries(db, tables, providerDriver) {
  const queries = [];
  const columnsFor = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
  const v2Threads = 'orchestration_v2_projection_threads';
  const v2Providers = 'orchestration_v2_projection_provider_threads';
  if (tables.has(v2Threads) && tables.has(v2Providers)) {
    const columns = columnsFor(v2Threads);
    const providerColumns = columnsFor(v2Providers);
    if (columns.has('title') && providerColumns.has('payload_json')
      && (providerColumns.has('driver') || providerColumns.has('provider'))) {
      const driver = providerColumns.has('driver')
        ? (providerColumns.has('provider') ? 'COALESCE(r.driver, r.provider)' : 'r.driver')
        : 'r.provider';
      queries.push({
        authoritative: true,
        // One malformed payload must not hide every other title in the batch.
        threadId: "(CASE WHEN json_valid(r.payload_json) THEN json_extract(r.payload_json, '$.nativeThreadRef.nativeId') END)",
        from: `FROM ${v2Threads} t JOIN ${v2Providers} r ON r.thread_id = t.thread_id`,
        // Tombstones still own the native id and suppress retained V1 titles.
        deleted: columns.has('deleted_at') ? '(t.deleted_at IS NOT NULL)' : '0',
        where: `${driver} = ? AND `,
        params: [providerDriver],
        order: columns.has('updated_at') ? ' ORDER BY t.updated_at DESC, t.thread_id' : ''
      });
    }
  }
  if (tables.has('projection_threads') && tables.has('provider_session_runtime')) {
    const columns = columnsFor('projection_threads');
    const runtimeColumns = columnsFor('provider_session_runtime');
    if (columns.has('title') && runtimeColumns.has('resume_cursor_json')
      && (providerDriver === 'codex' || runtimeColumns.has('provider_name'))) {
      queries.push({
        threadId: providerDriver === 'claudeAgent'
          ? "(CASE WHEN json_valid(r.resume_cursor_json) THEN json_extract(r.resume_cursor_json, '$.resume') END)"
          : "(json_extract(r.resume_cursor_json, '$.threadId'))",
        from: 'FROM projection_threads t JOIN provider_session_runtime r ON r.thread_id = t.thread_id',
        where: `${columns.has('deleted_at') ? 't.deleted_at IS NULL AND ' : ''}${runtimeColumns.has('provider_name') ? 'r.provider_name = ? AND ' : ''}`,
        params: runtimeColumns.has('provider_name') ? [providerDriver] : [],
        order: ''
      });
    }
  }
  return queries;
}

function readT3SessionMeta(sessionIds, deps = {}) {
  const providerDriver = deps.driver;
  if (!['codex', 'claudeAgent'].includes(providerDriver)) return new Map();
  const cleanTitle = deps.cleanTitle || cleanT3Title;
  const candidatesForId = deps.candidatesForId || ((id) => [id]);
  const ids = [...new Set(Array.from(sessionIds || []).map(String).filter(Boolean))];
  const out = new Map();
  if (ids.length === 0) return out;
  const sqliteMod = resolveSqlite(deps);
  if (!sqliteMod) return out;
  // Most machines do not run T3 at all, and a full tick can carry thousands of
  // sessions. Confirming the store exists before expanding every id into its
  // candidates keeps that case at one stat per known path; a missing store is
  // the same fail-closed answer the open below would give.
  const dbPaths = discoverT3DbPaths(deps).filter((dbPath) => {
    try { return fs.statSync(dbPath).isFile(); } catch (_) { return false; }
  });
  if (dbPaths.length === 0) return out;
  // Codex supplies rollout-id expansion; Claude matches its native session id
  // exactly. Neither provider may match a T3 app id or shared runtime session.
  const candidatesBySession = new Map(ids.map((id) => [id, candidatesForId(id)]));
  const candidateIds = [...new Set([...candidatesBySession.values()].flat())];
  const titleByThreadId = new Map();
  const v2SeenThreadIds = new Set();
  const legacyTitles = new Map();

  for (const dbPath of dbPaths) {
    let db;
    try {
      db = openDb(dbPath, sqliteMod);
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
      for (const query of t3TitleQueries(db, tables, providerDriver)) {
        for (let offset = 0; offset < candidateIds.length; offset += QUERY_CHUNK_SIZE) {
          const chunk = candidateIds.slice(offset, offset + QUERY_CHUNK_SIZE).filter(
            (id) => !v2SeenThreadIds.has(id) && (query.authoritative || !legacyTitles.has(id))
          );
          if (chunk.length === 0) continue;
          const placeholders = chunk.map(() => '?').join(',');
          const sql = `SELECT ${query.threadId} AS cursorThreadId, t.title AS title, ${query.deleted || '0'} AS deleted
                       ${query.from}
                       WHERE ${query.where}${query.threadId} IN (${placeholders})${query.order}`;
          for (const row of db.prepare(sql).all(...query.params, ...chunk)) {
            const threadId = cleanText(row.cursorThreadId);
            if (!threadId || v2SeenThreadIds.has(threadId)) continue;
            if (query.authoritative) {
              v2SeenThreadIds.add(threadId);
              if (row.deleted) continue;
            } else if (legacyTitles.has(threadId)) continue;
            const title = cleanTitle(row.title);
            if (!title || T3_DEFAULT_TITLES.has(title.toLowerCase())) continue;
            (query.authoritative ? titleByThreadId : legacyTitles).set(threadId, title);
          }
        }
      }
    } catch (_) { /* skip missing, locked, or incompatible databases */ } finally {
      if (db) { try { db.close(); } catch (_) {} }
    }
  }
  // A later V2 database also shadows an earlier legacy match. Delay fallback
  // until every store has been checked, without keeping their connections open.
  for (const [threadId, title] of legacyTitles) {
    if (!v2SeenThreadIds.has(threadId)) titleByThreadId.set(threadId, title);
  }
  for (const [sessionId, candidates] of candidatesBySession) {
    const title = candidates.map((id) => titleByThreadId.get(id)).find(Boolean);
    if (title) out.set(sessionId, { title });
  }
  return out;
}

module.exports = { expandHomePath, t3HomeDir, discoverT3DbPaths, readT3SessionMeta };
