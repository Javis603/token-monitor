'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findSessionFiles, codexSessionFile } = require('../../sessionFiles');
const { shouldReadSessionContext } = require('../../sessionContext');
const { readCodexSessionContext, readCodexTurnEnded } = require('./sessionContext');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const TITLE_MAX_CODE_POINTS = 96;
const QUERY_CHUNK_SIZE = 400;
const THREAD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// T3 Code is a separate Codex client that keeps its own thread catalog. It runs
// the same Codex harness, so the rollout transcript under `~/.codex/sessions` is
// shared, but T3 never writes the display title back to the Codex thread row.
// The generated title lives only in T3's own store, joined to the Codex thread id
// through its per-thread provider cursor, so a reader that only looks at the
// Codex database sees the first user message and never T3's title.
const T3_DEFAULT_TITLES = new Set(['new thread', 'start a new conversation']);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, maxCodePoints = TITLE_MAX_CODE_POINTS) {
  const chars = Array.from(value);
  return chars.length <= maxCodePoints
    ? value
    : `${chars.slice(0, Math.max(1, maxCodePoints - 1)).join('')}…`;
}

function cleanSessionTitle(value) {
  const withoutAttachments = String(value || '')
    .replace(/\[@[^\]]+\]\(file:\/\/[^)]+\)/gi, ' ')
    .replace(/\s+Use the available Lody MCP tools when relevant[\s\S]*$/i, ' ');
  return truncateText(cleanText(withoutAttachments));
}

function codexHomeDir(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  if (options.useEnvRoot !== false) {
    const configured = cleanText(env.CODEX_HOME);
    if (configured) return path.resolve(configured);
  }
  return path.join(homeDir, '.codex');
}

// T3 Code is another Codex client: it drives the same harness and shared
// rollout transcripts, but keeps its own thread catalog and never writes the
// generated title back to the Codex thread row. Its runtime state lives under a
// base directory of its own, with the server database one level below in
// `userdata` (a dev-server run writes to `dev` instead).
//
// Only the installed layouts are covered: the default home and an explicit
// `T3CODE_HOME`. A T3 dev run inside a linked git worktree keeps its state in
// that worktree's own `.t3`, which is not reachable from the home directory;
// those sessions simply keep the Codex fallback title.
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
  return [...new Set([
    path.join(root, 'userdata', 'state.sqlite'),
    // A dev server keeps its state beside the base directory rather than in it.
    // T3 picks that state directory from two rules that can disagree on which
    // subdirectory applies: the desktop app uses `dev` when the run is a dev one
    // and no `T3CODE_HOME` is configured, while the server uses `dev` only when no
    // explicit base directory was given. A `T3CODE_HOME` therefore counts as
    // explicit and lands under `dev/userdata`. Check both dev layouts; the
    // leading `userdata` path stays first because an installed app is the common
    // case and is the authoritative store when it exists.
    path.join(root, 'dev', 'userdata', 'state.sqlite'),
    path.join(root, 'dev', 'state.sqlite')
  ])];
}

function versionedDbFiles(dir, deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  let names;
  try { names = readdirSync(dir); } catch (_) { return []; }
  return names
    .map((name) => {
      const match = String(name).match(/^state_(\d+)\.sqlite$/);
      return match ? { filePath: path.join(dir, name), version: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.version - a.version)
    .map((entry) => entry.filePath);
}

function discoverDbPaths(options = {}) {
  if (Array.isArray(options.dbPaths)) return [...new Set(options.dbPaths.map(String).filter(Boolean))];
  const root = codexHomeDir(options);
  return [...new Set([
    ...versionedDbFiles(root, options),
    ...versionedDbFiles(path.join(root, 'sqlite'), options)
  ])];
}

function resolveSqlite(deps) {
  return deps.sqlite !== undefined ? deps.sqlite : sqlite;
}

function openDb(dbPath, sqliteMod) {
  const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 250');
  db.exec('PRAGMA query_only = ON');
  return db;
}

function isBackgroundReview(row) {
  const threadSource = cleanText(row.thread_source).toLowerCase();
  if (threadSource === 'user') return false;
  if (threadSource === 'guardian_review') return true;
  return /"other"\s*:\s*"guardian"/i.test(String(row.source || ''));
}

function titleForRow(row) {
  // `preview` and `first_user_message` are conversation content, not persisted
  // title metadata. Keep prompt-derived labels as a separate, explicit product
  // choice instead of silently treating private text as a title here.
  for (const field of ['name', 'title']) {
    const title = cleanSessionTitle(row[field]);
    if (title) return title;
  }
  return '';
}

// Whether the chosen title actually came from `name`, the app-generated field,
// rather than from the `title` first-user-message fallback. `name` can clean down
// to nothing (for example a value that only held an attachment), in which case the
// fallback is what is displayed and a caller holding a better generated title of
// its own may still replace it.
function isGeneratedTitle(row) {
  return Boolean(cleanSessionTitle(row.name));
}

function selectExpression(columns, name) {
  return columns.has(name) ? `COALESCE(${name}, '') AS ${name}` : `'' AS ${name}`;
}

function threadIdCandidates(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) return [];
  return [...new Set([raw, ...(raw.match(THREAD_ID_PATTERN) || [])])];
}

function readSessionMeta(sessionIds, deps = {}) {
  const ids = [...new Set(Array.from(sessionIds || []).map(String).filter(Boolean))];
  const out = new Map();
  if (ids.length === 0) return out;
  const sqliteMod = resolveSqlite(deps);
  if (!sqliteMod) return out;
  const titleSourceById = deps.titleSourceById instanceof Map ? deps.titleSourceById : null;
  // Ids whose title came from `name` (an app-generated title) rather than from
  // `title` (the first user message). Kept beside the returned map rather than
  // inside it so the row contract stays a plain `title`.
  const generatedTitleIds = new Set();

  const candidatesBySession = new Map(ids.map((id) => [id, threadIdCandidates(id)]));
  const candidateIds = [...new Set([...candidatesBySession.values()].flat())];
  const metaByThreadId = new Map();

  for (const dbPath of discoverDbPaths(deps)) {
    let db;
    try {
      db = openDb(dbPath, sqliteMod);
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((column) => String(column.name)));
      if (!columns.has('id')) continue;
      const fields = ['name', 'title', 'thread_source', 'source'];
      for (let offset = 0; offset < candidateIds.length; offset += QUERY_CHUNK_SIZE) {
        const chunk = candidateIds.slice(offset, offset + QUERY_CHUNK_SIZE).filter((id) => !metaByThreadId.has(id));
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => '?').join(',');
        const sql = `SELECT id, ${fields.map((field) => selectExpression(columns, field)).join(', ')}
                     FROM threads WHERE id IN (${placeholders})`;
        for (const row of db.prepare(sql).all(...chunk)) {
          const id = String(row.id || '');
          if (!id || metaByThreadId.has(id)) continue;
          if (isBackgroundReview(row)) {
            metaByThreadId.set(id, { sessionKind: 'background-review' });
            continue;
          }
          const title = titleForRow(row);
          if (!title) continue;
          metaByThreadId.set(id, { title });
          if (isGeneratedTitle(row)) generatedTitleIds.add(id);
        }
      }
    } catch (_) { /* skip missing, locked, or older databases */ } finally {
      if (db) { try { db.close(); } catch (_) {} }
    }
  }
  for (const [sessionId, candidates] of candidatesBySession) {
    const matched = candidates.find((id) => metaByThreadId.has(id));
    if (!matched) continue;
    out.set(sessionId, metaByThreadId.get(matched));
    // A background-review row carries no title; leave its source unset so a
    // caller does not treat the classification as a title it may replace.
    if (titleSourceById && !metaByThreadId.get(matched).sessionKind) {
      titleSourceById.set(sessionId, generatedTitleIds.has(matched));
    }
  }
  return out;
}

function readSessionMetaForHome(sessionIds, homeDir, deps = {}) {
  return readSessionMeta(sessionIds, { ...deps, homeDir, useEnvRoot: false });
}

// The title T3 Code generated for a Codex thread, keyed by the Codex thread id.
// T3 stores its own thread row (whose id is unrelated to Codex's) and joins it to
// the Codex thread through the runtime cursor it resumes with, so the join is
// cursor -> Codex thread id -> display title. T3's placeholder title for a
// never-titled thread is not an answer.
function readT3SessionMeta(sessionIds, deps = {}) {
  const ids = [...new Set(Array.from(sessionIds || []).map(String).filter(Boolean))];
  const out = new Map();
  if (ids.length === 0) return out;
  // A parenthesized left-hand side keeps `FROM` on its own line for the
  // schema-introspecting tests that expect a single select expression there.
  const cursorThreadId = "(json_extract(r.resume_cursor_json, '$.threadId'))";
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
  // Tokscale reports rollouts as `rollout-<timestamp>-<uuid>` and merged
  // rollouts by concatenating them, while T3 stores the bare Codex thread id.
  // Match on the ids each session could carry, exactly as the Codex reader does.
  const candidatesBySession = new Map(ids.map((id) => [id, threadIdCandidates(id)]));
  const candidateIds = [...new Set([...candidatesBySession.values()].flat())];
  const titleByThreadId = new Map();

  for (const dbPath of dbPaths) {
    let db;
    try {
      db = openDb(dbPath, sqliteMod);
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
      if (!tables.has('projection_threads') || !tables.has('provider_session_runtime')) continue;
      const columns = new Set(db.prepare('PRAGMA table_info(projection_threads)').all().map((column) => String(column.name)));
      if (!columns.has('title')) continue;
      // Older T3 stores have no soft-delete column; absence of the column is
      // not the same as a thread being deleted, so the filter is omitted.
      const liveOnly = columns.has('deleted_at') ? 't.deleted_at IS NULL AND ' : '';
      // T3 also drives other providers; only its Codex threads share id space
      // with the sessions being resolved here.
      const runtimeColumns = new Set(db.prepare('PRAGMA table_info(provider_session_runtime)').all().map((column) => String(column.name)));
      const codexOnly = runtimeColumns.has('provider_name') ? "r.provider_name = 'codex' AND " : '';
      for (let offset = 0; offset < candidateIds.length; offset += QUERY_CHUNK_SIZE) {
        const chunk = candidateIds.slice(offset, offset + QUERY_CHUNK_SIZE).filter((id) => !titleByThreadId.has(id));
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => '?').join(',');
        const sql = `SELECT ${cursorThreadId} AS cursorThreadId, t.title AS title
                     FROM projection_threads t
                     JOIN provider_session_runtime r ON r.thread_id = t.thread_id
                     WHERE ${liveOnly}${codexOnly}${cursorThreadId} IN (${placeholders})`;
        for (const row of db.prepare(sql).all(...chunk)) {
          const threadId = cleanText(row.cursorThreadId);
          if (!threadId || titleByThreadId.has(threadId)) continue;
          const title = cleanSessionTitle(row.title);
          if (!title || T3_DEFAULT_TITLES.has(title.toLowerCase())) continue;
          titleByThreadId.set(threadId, title);
        }
      }
    } catch (_) { /* skip missing, locked, or incompatible databases */ } finally {
      if (db) { try { db.close(); } catch (_) {} }
    }
  }
  for (const [sessionId, candidates] of candidatesBySession) {
    const title = candidates.map((id) => titleByThreadId.get(id)).find(Boolean);
    if (title) out.set(sessionId, { title });
  }
  return out;
}

function resolveSessionMetadata(sessionIds, context) {
  const { deps, home, metadata } = context;
  const result = new Map();
  // Which ids already carry an app-generated Codex title. T3's title is a
  // better answer than the first user message a prompt-derived `title` gives,
  // but a real Codex title still wins over T3's.
  const generatedTitleById = new Map();
  const readMetadata = deps.readCodexMeta || (deps.scopedHome
    ? (ids) => readSessionMetaForHome(ids, home, { ...(deps.codexDeps || {}), titleSourceById: generatedTitleById })
    : (ids) => readSessionMeta(ids, {
      ...(deps.codexDeps || {}),
      titleSourceById: generatedTitleById,
      homeDir: home,
      env: deps.env
    }));
  for (const [sessionId, meta] of readMetadata(sessionIds)) {
    result.set(sessionId, { ...(metadata.get(`codex:${sessionId}`) || {}), ...meta });
  }

  const readT3Metadata = deps.readT3Meta || (deps.scopedHome
    ? (ids) => readT3SessionMeta(ids, { ...(deps.codexDeps || {}), homeDir: home, useEnvRoot: false })
    : (ids) => readT3SessionMeta(ids, {
      ...(deps.codexDeps || {}),
      homeDir: home,
      env: deps.env
    }));
  for (const [sessionId, meta] of readT3Metadata(sessionIds)) {
    const resolved = result.get(sessionId) || {};
    // Never overwrite a title the Codex store itself generated; do replace the
    // prompt-derived fallback, which is exactly the case T3 improves on.
    if (resolved.title && generatedTitleById.get(sessionId)) continue;
    if (!meta.title || meta.title === resolved.title) continue;
    result.set(sessionId, { ...resolved, title: meta.title });
  }

  const codexHome = codexHomeDir({
    homeDir: home,
    env: deps.env,
    useEnvRoot: !deps.scopedHome
  });
  const readContext = deps.readCodexSessionContext || readCodexSessionContext;
  const readTurnEnded = deps.readCodexTurnEnded || readCodexTurnEnded;
  // The transcript this pass just stat-ed is also where the context window
  // lives, so the reading rides on the same file the timestamp came from. It is
  // attempted only once that timestamp says the session could still be open —
  // `fileSessionMetadata` has to run first for that reason.
  const decorate = (sessionId, filePath) => {
    const meta = context.fileSessionMetadata(sessionId, filePath, result.get(sessionId));
    if (!shouldReadSessionContext(meta.lastUsedAt, context.now)) return meta;
    const sessionContext = readContext(filePath);
    // The turn boundary rides the same tail and answers the other half of the
    // question the window cannot: whether the agent is still generating.
    const turnEnded = readTurnEnded(filePath);
    const decorated = sessionContext ? { ...meta, ...sessionContext } : meta;
    // Forwarded in all three states, so a \' + BT + 'false\' + BT + ' can clear a \' + BT + 'true\' + BT + ' from an
    // earlier tick and an unknown transcript leaves the reading alone.
    return turnEnded === undefined ? decorated : { ...decorated, turnEnded };
  };
  const missingIds = new Set();
  for (const sessionId of sessionIds) {
    const filePath = codexSessionFile(home, sessionId, { codexHome });
    if (filePath) {
      result.set(sessionId, decorate(sessionId, filePath));
    } else {
      missingIds.add(sessionId);
    }
  }
  const files = findSessionFiles(path.join(codexHome, 'sessions'), missingIds);
  for (const [sessionId, filePath] of files) {
    result.set(sessionId, decorate(sessionId, filePath));
  }
  return result;
}

module.exports = {
  TITLE_MAX_CODE_POINTS,
  cleanSessionTitle,
  codexHomeDir,
  t3HomeDir,
  expandHomePath,
  discoverT3DbPaths,
  discoverDbPaths,
  threadIdCandidates,
  readSessionMeta,
  readT3SessionMeta,
  readSessionMetaForHome,
  resolveSessionMetadata
};
