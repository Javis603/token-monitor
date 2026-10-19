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
// growing. Prefer current messages, but the v1 migration replaces a compaction
// prompt and its paid summary with one compaction row that omits usage, and drops
// task assistants. Restore only verified omitted usage; the two histories cannot
// simply be added together. Unmigrated sessions still use the legacy triple.
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
        && sessionMessage.has('seq') && sessionMessage.has('time_created')
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
  const turnEndedBySession = new Map();
  const columns = tableColumns(db, shape.messageTable);
  if (!columns.has('session_id') || !columns.has('data') || (shape.contentInRow && !columns.has('type'))) {
    return { lastMessageBySession, turnEndedBySession };
  }

  const createdMs = createdMsExpr(columns);
  // Settings selections are persisted messages in v2, but do not represent new
  // work and must not renew the running window of an otherwise idle session.
  const activityFilter = shape.contentInRow
    ? "AND type NOT IN ('model-switched', 'agent-switched', 'location-switched')" : '';
  const messageSql = `SELECT session_id AS sessionId,
                             MAX(${createdMs}) AS lastMessageMs
                      FROM ${shape.messageTable}
                      WHERE session_id IN (${placeholders})
                        ${activityFilter}
                      GROUP BY session_id`;
  for (const row of db.prepare(messageSql).all(...ids)) {
    lastMessageBySession.set(String(row.sessionId), row.lastMessageMs);
  }

  // v2's durable seq, not the clock or message id, defines conversation order.
  // Non-boundary messages leave the last real boundary intact. An unfinished
  // assistant or running manual compaction clears a prior idle without a prompt.
  const orderId = columns.has('id') ? 'id' : 'rowid';
  const order = shape.contentInRow && columns.has('seq') ? 'seq DESC' : `${createdMs} DESC, ${orderId} DESC`;
  const boundaryFilter = shape.contentInRow
    ? "AND (type IN ('user', 'assistant', 'idle') OR (type = 'compaction' AND json_extract(data,'$.status') = 'running'))" : '';
  const finishSql = `SELECT sessionId, role, finish FROM (
                       SELECT session_id AS sessionId,
                              ${shape.role} AS role,
                              json_extract(data,'$.finish') AS finish,
                              ROW_NUMBER() OVER (
                                PARTITION BY session_id
                                ORDER BY ${order}
                              ) AS rank
                       FROM ${shape.messageTable}
                       WHERE session_id IN (${placeholders})
                         AND json_valid(data)
                         ${boundaryFilter}
                     ) WHERE rank = 1`;
  for (const row of db.prepare(finishSql).all(...ids)) {
    const sessionId = String(row.sessionId);
    const role = String(row.role || '');
    const finish = String(row.finish || '');
    if (role === 'assistant') {
      // Missing finish is an active v2 assistant; older stores may never have
      // recorded this field, so preserve their unknown state.
      if (!finish) {
        if (shape.contentInRow) turnEndedBySession.set(sessionId, false);
        continue;
      }
      // Only a pause to run tools leaves the turn open. Every other
      // reason OpenCode can record is terminal — it stops the loop and
      // waits for the next prompt — including `length` (the output
      // budget ran out) and `content-filter`. Treating those as
      // "still generating" held the running mark for the whole recency
      // window after the model had already stopped.
      turnEndedBySession.set(sessionId, finish !== 'tool-calls');
    } else if (role === 'user' || (shape.contentInRow && role === 'compaction')) {
      // A prompt or explicitly running compaction starts work. Completed/failed
      // compactions are excluded above; they are not conversation terminals.
      turnEndedBySession.set(sessionId, false);
    } else if (role === 'idle') {
      // The turn loop has stopped, including after a tool-calls pause.
      turnEndedBySession.set(sessionId, true);
    }
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
const USAGE_COLUMNS_SQL =
  `json_extract(data,'$.cost')             AS cost,
          json_extract(data,'$.tokens.input')     AS tInput,
          json_extract(data,'$.tokens.output')    AS tOutput,
          json_extract(data,'$.tokens.reasoning') AS tReasoning,
          json_extract(data,'$.tokens.cache.read')  AS tCacheRead,
          json_extract(data,'$.tokens.cache.write') AS tCacheWrite`;

const MESSAGES_SQL =
  `SELECT id,
          CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS createdMs,
          json_extract(data,'$.role') AS role,
          ${USAGE_COLUMNS_SQL}
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

// Project before crossing into JS: tool output, reasoning and answer text are
// unused by Session Detail and can dwarf the usage and tool names it needs.
const CURRENT_MESSAGES_SQL =
  `SELECT id,
          CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS createdMs,
          type AS role,
          json_type(data) AS payloadType,
          CASE WHEN type = 'user' THEN json_extract(data,'$.text') END AS text,
          ${USAGE_COLUMNS_SQL},
          (json_extract(data,'$.tokens') IS NOT NULL OR json_extract(data,'$.cost') IS NOT NULL) AS hasUsage,
          CASE WHEN type = 'assistant' THEN (
            SELECT json_group_array(json_extract(item.value,'$.name'))
            FROM json_each(CASE WHEN json_type(session_message.data,'$.content') = 'array'
              THEN json_extract(session_message.data,'$.content') ELSE '[]' END) AS item
            WHERE CASE WHEN item.type = 'object' THEN json_extract(item.value,'$.type') = 'tool' ELSE 0 END
          ) ELSE '[]' END AS toolsJson
   FROM session_message
   WHERE session_id = ? AND json_valid(data)
   ORDER BY seq ASC`;

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

function readMigratedUsage(db, sessionId) {
  const supplements = new Map();
  const columns = tableColumns(db, 'message');
  if (!['id', 'session_id', 'data', 'time_created'].every((column) => columns.has(column))) return supplements;
  const partColumns = tableColumns(db, 'part');
  const currentId = `(SELECT current.id FROM session_message AS current
                     WHERE current.session_id = message.session_id AND current.id = message.id)`;
  const compactionId = `(SELECT current.id FROM session_message AS current
                        WHERE current.session_id = message.session_id AND current.type = 'compaction'
                          AND current.id = json_extract(message.data,'$.parentID'))`;
  const hasParts = ['message_id', 'session_id', 'data'].every((column) => partColumns.has(column));
  const parentHasPart = (type) => hasParts
    ? `EXISTS (SELECT 1 FROM message AS parent JOIN part ON part.message_id = parent.id AND part.session_id = parent.session_id
                  WHERE parent.session_id = message.session_id AND parent.id = json_extract(message.data,'$.parentID')
                    AND json_valid(parent.data) AND json_extract(parent.data,'$.role') = 'user'
                    AND json_valid(part.data) AND json_extract(part.data,'$.type') = '${type}')` : '0';
  const isSummary = `(json_extract(data,'$.summary') = 1 AND (${compactionId} IS NOT NULL OR ${parentHasPart('compaction')}))`;
  const isSubtask = hasParts
    ? `(${parentHasPart('subtask')} AND EXISTS (SELECT 1 FROM part AS owned
         WHERE owned.session_id = message.session_id AND owned.message_id = message.id AND json_valid(owned.data)
           AND json_extract(owned.data,'$.type') = 'tool' AND json_extract(owned.data,'$.tool') = 'task'))` : '0';
  const tools = hasParts
    ? `(SELECT json_group_array(json_extract(owned.data,'$.tool')) FROM part AS owned
        WHERE owned.session_id = message.session_id AND owned.message_id = message.id AND json_valid(owned.data)
          AND json_extract(owned.data,'$.type') = 'tool')` : "'[]'";
  const rows = db.prepare(`SELECT id, time_created AS orderMs, json_extract(data,'$.parentID') AS parentId,
                                 ${currentId} AS currentId, ${compactionId} AS compactionId,
                                 CASE WHEN ${isSummary} THEN 'compaction-summary' END AS type,
                                 CASE WHEN ${currentId} IS NULL THEN ${tools} ELSE '[]' END AS toolsJson,
                                 ${createdMsExpr(columns)} AS createdMs, ${USAGE_COLUMNS_SQL}
                          FROM message
                          WHERE session_id = ? AND json_valid(data)
                            AND (${currentId} IS NOT NULL OR (
                              json_extract(data,'$.role') = 'assistant' AND (${isSummary} OR ${isSubtask})))`).iterate(sessionId);
  const entries = [];
  try {
    for (const row of rows) entries.push(row);
  } finally {
    rows.return();
  }
  // Match upstream transformSession's stored-time/id order, including its JS
  // localeCompare tie-break. Failed/incomplete compactions and task assistants
  // have no new row: place their usage after the last surviving legacy id, without
  // reordering v2 seq or fabricating seq from clocks. A legacy-only prefix stays
  // ahead of messages appended after migration, even when no old id survived.
  entries.sort((a, b) => a.orderMs - b.orderMs || a.id.localeCompare(b.id));
  let anchor = null;
  for (const row of entries) {
    if (row.currentId) { anchor = row.currentId; continue; }
    const position = (row.type === 'compaction-summary' && row.compactionId) || anchor;
    if (!supplements.has(position)) supplements.set(position, []);
    supplements.get(position).push({ ...row, role: 'assistant' });
  }
  return supplements;
}

function readSessionEventsCurrent(db, sessionId) {
  const supplements = readMigratedUsage(db, sessionId);
  const rows = db.prepare(CURRENT_MESSAGES_SQL).iterate(sessionId);
  let found = false;
  const messages = [...(supplements.get(null) || [])];
  const parts = [];
  try {
    for (const row of rows) {
      found = true;
      if (!['object', 'array'].includes(row.payloadType)) continue;
      if (row.role === 'user') {
        if (typeof row.text === 'string' && row.text) parts.push({ messageId: row.id, type: 'text', text: row.text });
        messages.push(row);
      } else if (row.role === 'assistant') {
        messages.push(row);
      } else if (row.role === 'compaction') {
        // Native compactions may already carry the omitted summary's usage.
        if (row.hasUsage) messages.push({ ...row, role: 'assistant', type: 'compaction-summary' });
      }
      for (const supplement of supplements.get(row.id) || []) {
        if (row.role === 'compaction' && row.hasUsage && supplement.type === 'compaction-summary' && supplement.parentId === row.id) continue;
        messages.push(supplement);
      }
    }
  } finally {
    rows.return();
  }
  for (const message of messages) {
    for (const tool of JSON.parse(message.toolsJson || '[]')) {
      if (tool) parts.push({ messageId: message.id, type: 'tool', tool });
    }
  }
  return found ? { messages, parts } : null;
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
      events.push({ kind: 'turn', ...(m.type ? { type: m.type } : {}), timestamp, tokens: mapTokens(m), tools, cost });
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
      // Reconcile both shapes from one read snapshot while OpenCode appends.
      // Closing this read-only connection also ends the transaction.
      db.exec('BEGIN');
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
