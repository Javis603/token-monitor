'use strict';

// Reads OpenCode session metadata + per-exchange detail from opencode.db (SQLite).
// This is the only place that reads the DB for *sessions*; it mirrors the discovery and
// feature-detection used by ./opencodeLimits (node:sqlite, read-only, deps.sqlite seam).
// OpenCode has no jsonl transcript like Claude/Codex — everything lives in the DB.

const { discoverDbPaths } = require('./goLimits');
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
// Storage shapes
// ---------------------------------------------------------------------------
// OpenCode 2.x keeps a session row in `session_v2` and every message in
// `session_message`, where a message row carries its own content items. 1.x wrote
// the parallel `session`/`message`/`part` triple instead and 2.x stopped updating
// it, so that triple is frozen at the upgrade while `session_message` keeps
// growing. The current pair is the superset — every legacy message id still
// exists in `session_message` — so it is read first and the legacy triple is only
// the fallback for a database written before the current tables (or a session the
// upgrade did not carry over). Reading `message`/`part` alone is what reported
// "transcript not found" for every session created after the upgrade.
function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
  } catch (_) { return new Set(); }
}

function openCodeShapes(db) {
  const shapes = [];
  const sessionV2 = tableColumns(db, 'session_v2');
  const sessionMessage = tableColumns(db, 'session_message');
  if (sessionV2.has('id')) {
    shapes.push({
      sessionTable: 'session_v2',
      messageTable: 'session_message',
      role: 'type',
      contentInRow: true,
      // Metadata is readable from the session row alone; a database that never
      // wrote a message table still answers when the session appeared.
      readsMessages: sessionMessage.has('id') && sessionMessage.has('session_id')
        && sessionMessage.has('data') && sessionMessage.has('type')
    });
  }
  const session = tableColumns(db, 'session');
  const message = tableColumns(db, 'message');
  if (session.has('id')) {
    shapes.push({
      sessionTable: 'session',
      messageTable: 'message',
      role: "json_extract(data,'$.role')",
      contentInRow: false,
      readsMessages: message.has('session_id') && message.has('data')
    });
  }
  return shapes;
}

// A message's stored JSON time is the real activity stamp; the column beside it is
// the fallback for a row that predates that field.
function createdMsExpr(columns) {
  const jsonCreated = "CASE WHEN json_valid(data) THEN CAST(json_extract(data,'$.time.created') AS INTEGER) END";
  return `CAST(COALESCE(${jsonCreated}, ${columns.has('time_created') ? 'time_created' : 'NULL'}) AS INTEGER)`;
}

// ---------------------------------------------------------------------------
// Session metadata (for the list-row timestamps + title)
// ---------------------------------------------------------------------------
function readMessageActivity(db, shape, ids, placeholders) {
  const lastMessageBySession = new Map();
  // The newest assistant row's `finish` is OpenCode's turn-end signal, the
  // same fact Claude states as `stop_reason`: `stop` means the model
  // finished its answer, `tool-calls` means it paused to run tools and is
  // still mid-turn. Read beside the last-message timestamp so one query
  // answers both, and only `stop` counts as finished.
  // Tri-state per session: true = the newest word was a completed answer,
  // false = a prompt is waiting on one, absent = no evidence. A boolean
  // pair could not express the third case, and collapsing it into "omit"
  // is what let a stale completion survive.
  const turnEndedBySession = new Map();
  const columns = tableColumns(db, shape.messageTable);
  if (!columns.has('session_id') || !columns.has('data')) return { lastMessageBySession, turnEndedBySession };

  const createdMs = createdMsExpr(columns);
  const messageSql = `SELECT session_id AS sessionId,
                             MAX(${createdMs}) AS lastMessageMs
                      FROM ${shape.messageTable}
                      WHERE session_id IN (${placeholders})
                      GROUP BY session_id`;
  for (const row of db.prepare(messageSql).all(...ids)) {
    lastMessageBySession.set(String(row.sessionId), row.lastMessageMs);
  }

  // One row per session: the newest message. Windowed rather than grouped,
  // because the role/finish values belong to that single row and SQLite's
  // bare-column grouping would pick an arbitrary one. (A correlated subquery is
  // the obvious alternative, but `inner` is a reserved word and the resulting
  // syntax error is swallowed by the caller's catch, which reads as "this
  // session has no metadata".)
  // The boundary belongs to the newest message, not to the newest assistant
  // message: a prompt accepted after a completion has already started the next
  // turn, so that completion no longer describes the current one. Taking the
  // newest assistant row unconditionally latched the previous `stop` and marked a
  // freshly prompted session finished.
  // Order by the same effective timestamp the query above used rather than an
  // unconditional `time_created, id`: the guard only requires a session id plus
  // the message payload, so a schema without `id` (or without `time_created`)
  // would make SQLite reject this query, and the caller's catch would read that
  // as "this session has no metadata" and blank its title and timestamps.
  const orderId = columns.has('id') ? 'id' : 'rowid';
  const finishSql = `SELECT sessionId, role, finish FROM (
                       SELECT session_id AS sessionId,
                              ${shape.role} AS role,
                              json_extract(data,'$.finish') AS finish,
                              ROW_NUMBER() OVER (
                                PARTITION BY session_id
                                ORDER BY ${createdMs} DESC,
                                         ${orderId} DESC
                              ) AS rank
                       FROM ${shape.messageTable}
                       WHERE session_id IN (${placeholders})
                         AND json_valid(data)
                     ) WHERE rank = 1`;
  for (const row of db.prepare(finishSql).all(...ids)) {
    const sessionId = String(row.sessionId);
    const role = String(row.role || '');
    const finish = String(row.finish || '');
    if (role === 'assistant') {
      // A row with no `finish` is the pre-v2 shape, which recorded no
      // boundary at all and therefore is not evidence of one.
      if (!finish) continue;
      // Only a pause to run tools leaves the turn open. Every other
      // reason OpenCode can record is terminal — it stops the loop and
      // waits for the next prompt — including `length` (the output
      // budget ran out) and `content-filter`. Treating those as
      // "still generating" held the running mark for the whole recency
      // window after the model had already stopped.
      turnEndedBySession.set(sessionId, finish !== 'tool-calls');
    } else if (role === 'user') {
      // The newest message is the user's, so a prompt is waiting on an
      // answer and the previous completion no longer describes this turn.
      turnEndedBySession.set(sessionId, false);
    } else if (role === 'idle') {
      // The current shape writes an `idle` row when the session's turn loop
      // stops, carrying the outcome (`succeeded`/`interrupted`). It is the
      // explicit completion the legacy shape stated as an assistant `finish`,
      // and it lands after that assistant row — so a turn that paused on
      // `tool-calls` is over once this row is the newest one. Without it the
      // busiest OpenCode sessions (21 of 45 in one real database) would fall
      // back to a time window instead of being known to have stopped.
      turnEndedBySession.set(sessionId, true);
    }
    // Any other kind (system, synthetic, compaction, model-switched…) is not a
    // turn boundary, so it leaves the session without evidence either way.
  }
  return { lastMessageBySession, turnEndedBySession };
}

function readSessionMeta(sessionIds, deps = {}) {
  const ids = Array.from(sessionIds || []).filter(Boolean).map(String);
  const out = new Map();
  if (ids.length === 0) return out;
  const sqliteMod = resolveSqlite(deps);
  if (!sqliteMod) return out;

  for (const dbPath of resolvePaths(deps)) {
    let db;
    try {
      db = openDb(dbPath, sqliteMod);
      for (const shape of openCodeShapes(db)) {
        const missing = ids.filter((id) => !out.has(id));
        if (missing.length === 0) break;
        const placeholders = missing.map(() => '?').join(',');
        const columns = tableColumns(db, shape.sessionTable);
        const title = columns.has('title') ? "COALESCE(title,'')" : "''";
        const directory = columns.has('directory') ? "COALESCE(directory,'')" : "''";
        const created = columns.has('time_created') ? 'time_created' : 'NULL';
        const { lastMessageBySession, turnEndedBySession } = readMessageActivity(db, shape, missing, placeholders);
        const sql = `SELECT id, ${title} AS title, ${directory} AS directory, ${created} AS created
                     FROM ${shape.sessionTable} WHERE id IN (${placeholders})`;
        for (const r of db.prepare(sql).all(...missing)) {
          const id = String(r.id);
          if (out.has(id)) continue;
          const startedAt = isoFromMs(r.created);
          // session.time_updated can change for metadata/background work. Only a
          // persisted message is real usage activity; a message-less session
          // falls back to its creation time instead of masquerading as recent.
          const lastUsedAt = isoFromMs(lastMessageBySession.get(id)) || startedAt;
          const meta = { startedAt, lastUsedAt, title: String(r.title || '') };
          if (r.directory) meta.projectPath = String(r.directory);
          // A completion ends the turn and a waiting prompt clears one; a
          // `tool-calls` pause is still work in progress (a `false`), and a session
          // whose newest row states nothing is left without evidence rather than
          // guessed at.
          const ended = turnEndedBySession.get(id);
          if (ended !== undefined) meta.turnEnded = ended;
          out.set(id, meta);
        }
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

function resolveSessionMetadata(sessionIds, context) {
  const { deps, home, projectIdentity, resolveProjects } = context;
  const readMetadata = deps.readOpencodeMeta || (deps.scopedHome
    ? (ids) => readSessionMetaForHome(ids, home, deps.opencodeDeps)
    : (ids) => readSessionMeta(ids, deps.opencodeDeps));
  const result = new Map();
  for (const [sessionId, meta] of readMetadata(sessionIds)) {
    const startedAt = meta.startedAt || '';
    const lastUsedAt = meta.lastUsedAt || startedAt;
    const identity = resolveProjects ? projectIdentity(meta.projectPath) : {};
    const title = String(meta.title || '').trim();
    if (startedAt || lastUsedAt || identity.projectId || title) {
      result.set(sessionId, {
        startedAt,
        lastUsedAt,
        ...identity,
        title,
        // Forwarded in both directions: `false` is evidence of an active turn
        // and has to reach the merge to clear a `true` from an earlier tick.
        ...(meta.turnEnded === undefined ? {} : { turnEnded: meta.turnEnded === true })
      });
    }
  }
  return result;
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

// The current shape stores the payload of a message in its own row, so the whole
// transcript arrives in one query and the content items are unpacked below.
const CURRENT_MESSAGES_SQL =
  `SELECT id,
          CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS createdMs,
          type AS role,
          data
   FROM session_message
   WHERE session_id = ? AND json_valid(data)
   ORDER BY createdMs ASC, id ASC`;

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

// Content items carry the same text/tool facts the legacy `part` rows did, under
// the names the current shape uses (`name` rather than `tool`).
function collectContentParts(parts, messageId, content) {
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && item.text) parts.push({ messageId, type: 'text', text: item.text });
    else if (item.type === 'tool' && item.name) parts.push({ messageId, type: 'tool', tool: item.name });
  }
}

// Only the current shape needs this: it reads one table and parses JSON in JS,
// because the payload (role, tokens, cost, content) lives inside the row.
// Returns null when the session has no message row at all, which is the signal
// that this database does not hold its transcript.
function readSessionEventsCurrent(db, sessionId) {
  const rows = db.prepare(CURRENT_MESSAGES_SQL).all(sessionId);
  if (rows.length === 0) return null;
  const messages = [];
  const parts = [];
  for (const row of rows) {
    let data;
    try { data = JSON.parse(row.data); } catch (_) { continue; }
    if (!data || typeof data !== 'object') continue;
    const role = String(row.role || data.role || '');
    if (role === 'user') {
      // A prompt is the row's own `text`; it has no content items.
      if (typeof data.text === 'string' && data.text) parts.push({ messageId: row.id, type: 'text', text: data.text });
      messages.push({ id: row.id, role, createdMs: row.createdMs });
    } else if (role === 'assistant') {
      collectContentParts(parts, row.id, data.content);
      // An aborted or in-flight turn can omit tokens and cost; num() reads both
      // as zero rather than dropping the turn's row.
      const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : {};
      const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
      messages.push({
        id: row.id,
        role,
        createdMs: row.createdMs,
        cost: data.cost,
        tInput: tokens.input,
        tOutput: tokens.output,
        tReasoning: tokens.reasoning,
        tCacheRead: cache.read,
        tCacheWrite: cache.write
      });
    }
    // system, synthetic, idle and the other non-exchange kinds are not prompts
    // or turns; they are skipped exactly as a non user/assistant role always was.
  }
  return { messages, parts };
}

// The legacy shape keeps the role and token counts in the message payload and the
// prompt/answer text in separate `part` rows.
function readSessionEventsLegacy(db, sessionId) {
  const messages = db.prepare(MESSAGES_SQL).all(sessionId);
  if (messages.length === 0) return null;
  return { messages, parts: db.prepare(PARTS_SQL).all(sessionId) };
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
      for (const shape of openCodeShapes(db)) {
        if (!shape.readsMessages) continue;
        const transcript = shape.contentInRow
          ? readSessionEventsCurrent(db, id)
          : readSessionEventsLegacy(db, id);
        if (!transcript) continue;
        const { events, sessionCost } = buildEvents(transcript.messages, transcript.parts);
        return { found: true, events, sessionCost };
      }
    } catch (_) { /* skip unreadable db */ } finally {
      if (db) { try { db.close(); } catch (_) {} }
    }
  }
  return empty;
}

module.exports = { readSessionMeta, readSessionMetaForHome, readSessionEvents, resolveSessionMetadata };
