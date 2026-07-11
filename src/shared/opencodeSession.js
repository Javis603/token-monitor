'use strict';

// Reads OpenCode session metadata + per-exchange detail from opencode.db (SQLite).
// This is the only place that reads the DB for *sessions*; it mirrors the discovery and
// feature-detection used by ./opencodeLimits (node:sqlite, read-only, deps.sqlite seam).
// OpenCode has no jsonl transcript like Claude/Codex — everything lives in the DB.

const { discoverDbPaths } = require('./opencodeLimits');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isoFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toISOString();
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function resolveSqlite(deps) {
  return deps.sqlite !== undefined ? deps.sqlite : sqlite;
}

function resolvePaths(deps) {
  return deps.dbPaths || discoverDbPaths(deps.env || process.env);
}

function openDb(dbPath, sqliteMod) {
  const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 250');
  return db;
}

// ---------------------------------------------------------------------------
// Session metadata (for the list-row timestamps + title)
// ---------------------------------------------------------------------------
function readSessionMeta(sessionIds, deps = {}) {
  const ids = Array.from(sessionIds || []).filter(Boolean).map(String);
  const out = new Map();
  if (ids.length === 0) return out;
  const sqliteMod = resolveSqlite(deps);
  if (!sqliteMod) return out;

  const placeholders = ids.map(() => '?').join(',');
  for (const dbPath of resolvePaths(deps)) {
    let db;
    try {
      db = openDb(dbPath, sqliteMod);
      const columns = new Set(db.prepare('PRAGMA table_info(session)').all().map((column) => String(column.name)));
      const directory = columns.has('directory') ? "COALESCE(directory,'')" : "''";
      const sql = `SELECT id, COALESCE(title,'') AS title, ${directory} AS directory, time_created AS created, time_updated AS updated
                   FROM session WHERE id IN (${placeholders})`;
      for (const r of db.prepare(sql).all(...ids)) {
        const id = String(r.id);
        if (out.has(id)) continue;
        const startedAt = isoFromMs(r.created);
        const meta = { startedAt, lastUsedAt: isoFromMs(r.updated) || startedAt, title: String(r.title || '') };
        if (r.directory) meta.projectPath = String(r.directory);
        out.set(id, meta);
      }
    } catch (_) { /* skip unreadable db */ } finally {
      if (db) { try { db.close(); } catch (_) {} }
    }
  }
  return out;
}

function readSessionMetaForHome(sessionIds, home, deps = {}) {
  const env = deps.env || process.env;
  const scopedEnv = {
    ...env,
    OPENCODE_DB: '',
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    HOME: home,
    USERPROFILE: home
  };
  return readSessionMeta(sessionIds, { ...deps, dbPaths: discoverDbPaths(scopedEnv) });
}

// ---------------------------------------------------------------------------
// Session detail events (neutral shape consumed by sessionDetail.js)
// ---------------------------------------------------------------------------
const MESSAGES_SQL =
  `SELECT id,
          CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS createdMs,
          json_extract(data,'$.role')             AS role,
          json_extract(data,'$.cost')             AS cost,
          json_extract(data,'$.tokens.input')     AS tInput,
          json_extract(data,'$.tokens.output')    AS tOutput,
          json_extract(data,'$.tokens.reasoning') AS tReasoning,
          json_extract(data,'$.tokens.cache.read')  AS tCacheRead,
          json_extract(data,'$.tokens.cache.write') AS tCacheWrite
   FROM message
   WHERE session_id = ? AND json_valid(data)
   ORDER BY createdMs ASC, id ASC`;

const PARTS_SQL =
  `SELECT message_id AS messageId,
          json_extract(data,'$.type') AS type,
          json_extract(data,'$.text') AS text,
          json_extract(data,'$.tool') AS tool
   FROM part
   WHERE session_id = ? AND json_valid(data)
   ORDER BY time_created ASC, id ASC`;

function mapTokens(r) {
  const input = num(r.tInput);
  const output = num(r.tOutput);
  const reasoning = num(r.tReasoning);
  const cacheRead = num(r.tCacheRead);
  const cacheWrite = num(r.tCacheWrite);
  // Match how tokscale totals a session: input + output + cacheRead + cacheWrite. OpenCode's
  // stored `tokens.total` ADDS reasoning on top of that, so trusting it over-counts vs the
  // session card. Keep reasoning informational only — same convention as Claude/Codex.
  const total = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, reasoning, total };
}

function buildEvents(messages, parts) {
  const textByMessage = new Map();
  const toolsByMessage = new Map();
  for (const p of parts) {
    if (p.type === 'text' && p.text) {
      if (!textByMessage.has(p.messageId)) textByMessage.set(p.messageId, []);
      textByMessage.get(p.messageId).push(String(p.text));
    } else if (p.type === 'tool' && p.tool) {
      if (!toolsByMessage.has(p.messageId)) toolsByMessage.set(p.messageId, []);
      toolsByMessage.get(p.messageId).push(String(p.tool));
    }
  }

  const events = [];
  let sessionCost = 0;
  for (const m of messages) {
    const timestamp = isoFromMs(m.createdMs);
    if (m.role === 'user') {
      // Each user message is one exchange boundary (even with empty text).
      const text = cleanText((textByMessage.get(m.id) || []).join(' '));
      events.push({ kind: 'prompt', timestamp, text });
    } else if (m.role === 'assistant') {
      const cost = num(m.cost);
      sessionCost += cost;
      const tools = Array.from(new Set(toolsByMessage.get(m.id) || []));
      events.push({ kind: 'turn', timestamp, tokens: mapTokens(m), tools, cost });
    }
  }
  return { events, sessionCost };
}

function readSessionEvents(sessionId, deps = {}) {
  const empty = { found: false, events: [], sessionCost: 0 };
  const id = String(sessionId || '');
  if (!id) return empty;
  const sqliteMod = resolveSqlite(deps);
  if (!sqliteMod) return empty;

  for (const dbPath of resolvePaths(deps)) {
    let db;
    try {
      db = openDb(dbPath, sqliteMod);
      const messages = db.prepare(MESSAGES_SQL).all(id);
      if (messages.length === 0) continue;
      const parts = db.prepare(PARTS_SQL).all(id);
      const { events, sessionCost } = buildEvents(messages, parts);
      return { found: true, events, sessionCost };
    } catch (_) { /* skip unreadable db */ } finally {
      if (db) { try { db.close(); } catch (_) {} }
    }
  }
  return empty;
}

module.exports = { readSessionMeta, readSessionMetaForHome, readSessionEvents };
