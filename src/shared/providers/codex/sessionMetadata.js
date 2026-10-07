'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveSqlite, openDb } = require('../../sqliteReadOnly');
const { findSessionFiles, codexSessionFile } = require('../../sessionFiles');
const t3SessionMetadata = require('../../t3SessionMetadata');
const { expandHomePath, t3HomeDir, discoverT3DbPaths } = t3SessionMetadata;
const { shouldReadSessionContext } = require('../../sessionContext');
const { readCodexSessionState, readCodexSessionContext, readCodexTurnEnded } = require('./sessionContext');

const TITLE_MAX_CODE_POINTS = 96;
const QUERY_CHUNK_SIZE = 400;
const THREAD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// T3 Code is a separate Codex client that keeps its own thread catalog. It runs
// the same Codex harness, so the rollout transcript under `~/.codex/sessions` is
// shared, but T3 never writes the display title back to the Codex thread row.
// The generated title lives only in T3's own store, joined to the Codex thread id
// through its native thread reference (or the legacy provider cursor), so a
// Codex-only reader sees the first user message and never T3's title.

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

function readT3SessionMeta(sessionIds, deps = {}) {
  return t3SessionMetadata.readT3SessionMeta(sessionIds, {
    ...deps, driver: 'codex', candidatesForId: threadIdCandidates, cleanTitle: cleanSessionTitle
  });
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
  // T3 queries expand and batch the ids against JSON runtime cursors. Exclude
  // titles that cannot be replaced before paying for those fallback queries.
  const t3SessionIds = [...sessionIds].filter(
    (id) => !(result.get(id)?.title && generatedTitleById.get(id))
  );
  for (const [sessionId, meta] of readT3Metadata(t3SessionIds)) {
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
    const state = readCodexSessionState(filePath, deps.codexDeps);
    if (state.promptCacheState?.observation !== undefined) meta.promptCache = state.promptCacheState.observation;
    const sessionContext = deps.readCodexSessionContext ? readContext(filePath) : state.context;
    // The turn boundary rides the same tail and answers the other half of the
    // question the window cannot: whether the agent is still generating.
    const turnEnded = deps.readCodexTurnEnded ? readTurnEnded(filePath) : state.turnEnded;
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
