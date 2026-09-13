'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findSessionFiles, codexSessionFile } = require('../../sessionFiles');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const TITLE_MAX_CODE_POINTS = 96;
const QUERY_CHUNK_SIZE = 400;
const THREAD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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
          if (title) metaByThreadId.set(id, { title });
        }
      }
    } catch (_) { /* skip missing, locked, or older databases */ } finally {
      if (db) { try { db.close(); } catch (_) {} }
    }
  }
  for (const [sessionId, candidates] of candidatesBySession) {
    const meta = candidates.map((id) => metaByThreadId.get(id)).find(Boolean);
    if (meta) out.set(sessionId, meta);
  }
  return out;
}

function readSessionMetaForHome(sessionIds, homeDir, deps = {}) {
  return readSessionMeta(sessionIds, { ...deps, homeDir, useEnvRoot: false });
}

function resolveSessionMetadata(sessionIds, context) {
  const { deps, home, metadata } = context;
  const result = new Map();
  const readMetadata = deps.readCodexMeta || (deps.scopedHome
    ? (ids) => readSessionMetaForHome(ids, home, deps.codexDeps)
    : (ids) => readSessionMeta(ids, {
      ...(deps.codexDeps || {}),
      homeDir: home,
      env: deps.env
    }));
  for (const [sessionId, meta] of readMetadata(sessionIds)) {
    result.set(sessionId, { ...(metadata.get(`codex:${sessionId}`) || {}), ...meta });
  }

  const codexHome = codexHomeDir({
    homeDir: home,
    env: deps.env,
    useEnvRoot: !deps.scopedHome
  });
  const missingIds = new Set();
  for (const sessionId of sessionIds) {
    const filePath = codexSessionFile(home, sessionId, { codexHome });
    if (filePath) {
      result.set(sessionId, context.fileSessionMetadata(
        sessionId,
        filePath,
        result.get(sessionId)
      ));
    } else {
      missingIds.add(sessionId);
    }
  }
  const files = findSessionFiles(path.join(codexHome, 'sessions'), missingIds);
  for (const [sessionId, filePath] of files) {
    result.set(sessionId, context.fileSessionMetadata(
      sessionId,
      filePath,
      result.get(sessionId)
    ));
  }
  return result;
}

module.exports = {
  TITLE_MAX_CODE_POINTS,
  cleanSessionTitle,
  codexHomeDir,
  discoverDbPaths,
  threadIdCandidates,
  readSessionMeta,
  readSessionMetaForHome,
  resolveSessionMetadata
};
