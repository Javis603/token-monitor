'use strict';

/**
 * Pi Desktop usage parser.
 *
 * Pi Desktop persists its turn history in a SQLite database:
 *   ~/.pi-desktop/pi.sqlite
 * The `turns` table carries per-turn token counters (input_tokens,
 * output_tokens) plus a `usage_json` blob with cacheReadTokens /
 * reasoningTokens. Costs are estimated from the model-price catalog
 * (never trusted from the transcript) mirroring the other local adapters.
 *
 * Pi Desktop also mirrors every session to `~/.pi-desktop/sessions/<id>.jsonl`,
 * appended as each assistant message lands. That transcript is the only source
 * that carries usage for a turn which is still running — the `turns` row keeps
 * `input_tokens = 0` until the turn ends — so it is read as a live fill, see
 * collectPiDesktopJsonlRows.
 *
 * The transcript is deliberately *not* authoritative. Pi Desktop compacts it and
 * only the tail of a conversation survives a compaction (the `.revisions.jsonl`
 * sidecars hold revision markers, no usage), so jsonl totals for a finished turn
 * can sit far below the `turns` row; and a turn that was retried internally
 * accumulates every attempt in the jsonl, which can push it above. `turns`
 * therefore wins whenever it holds a non-zero count.
 *
 * Rows are emitted with `client: 'pi'` so the collector's existing pi period
 * merges them together with the streamed pi agent client.
 *
 * Reads use node:sqlite (Node >= 22.15), read-only, no sqlite3 CLI required.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PI_DESKTOP_ROOT = path.join(os.homedir(), '.pi-desktop');
const PI_DESKTOP_DB_SUFFIX = 'pi.sqlite';
const PI_DESKTOP_SESSIONS_DIRNAME = 'sessions';
const PI_DESKTOP_JSONL_SUFFIX = '.jsonl';
// `<session-id>.revisions.jsonl` sidecars record revision markers only: they
// carry no usage and must never be read as transcripts.
const PI_DESKTOP_REVISIONS_SUFFIX = '.revisions.jsonl';

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime() || 0;
  // Nonnumeric date strings ("2024-01-01", ISO stamps) must resolve to real
  // boundaries instead of collapsing to 0; numeric strings keep the numeric
  // seconds-versus-milliseconds path below.
  if (typeof value === 'string' && value.trim() !== '' && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return n > 0 && n < 1e12 ? n * 1000 : n;
}

function normalizedModelId(value) {
  // Model ids can carry display prefixes such as `[free]kimi-k3` or `[]glm-5.3`.
  const cleaned = String(value || '').trim();
  const idx = cleaned.indexOf(']');
  const base = idx >= 0 ? cleaned.slice(idx + 1).trim() : cleaned;
  return base.toLowerCase() || 'unknown';
}

function estimatedRowCost(row, pricingByModel) {
  const pricing = pricingByModel?.[normalizedModelId(row.model)];
  if (!pricing || typeof pricing !== 'object') return null;
  const components = [
    [row.input, pricing.inputCostPerToken],
    [row.output, pricing.outputCostPerToken],
    [row.cacheRead, pricing.cacheReadInputTokenCost],
    [row.cacheWrite, pricing.cacheCreationInputTokenCost]
  ];
  let cost = 0;
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

function piDesktopDataPaths(options = {}) {
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const explicitDb = String(env.TOKEN_MONITOR_PI_DESKTOP_DB_PATH || '').trim();
  return {
    dbPaths: explicitDb ? [path.resolve(explicitDb)] : [path.join(home, '.pi-desktop', PI_DESKTOP_DB_SUFFIX)]
  };
}

function parseUsageJson(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizePiDesktopRow(dbRow) {
  const usage = parseUsageJson(dbRow.usage_json);
  const input = numberValue(dbRow.input_tokens ?? usage.inputTokens);
  const output = numberValue(dbRow.output_tokens ?? usage.outputTokens);
  const cacheRead = numberValue(usage.cacheReadTokens);
  const cacheWrite = numberValue(usage.cacheCreationTokens);
  if (input + output + cacheRead + cacheWrite === 0) return null;
  const model = normalizedModelId(dbRow.model_id || usage.model || '');
  const now = typeof dbRow.started_at === 'number' ? dbRow.started_at : 0;
  const ended = typeof dbRow.ended_at === 'number' ? dbRow.ended_at : 0;
  return {
    sessionId: `pi-desktop:${String(dbRow.session_id || 'unknown')}`,
    messageId: `pi-desktop:${String(dbRow.id || 'unknown')}`,
    model,
    input,
    output,
    cacheRead,
    cacheWrite,
    createdAt: timestampMs(Math.max(now, ended)),
    startedAt: timestampMs(now),
    endedAt: ended ? timestampMs(ended) : null,
    messages: 1
  };
}

function piDesktopSessionsDir(dbPath) {
  return path.join(path.dirname(dbPath), PI_DESKTOP_SESSIONS_DIRNAME);
}

/**
 * Live fill from the session transcripts.
 *
 * Returns one row per turn that the `turns` table left at zero, summed from the
 * assistant messages of the matching `<session-id>.jsonl`. `coveredTurnIds` holds
 * every turn the table already reported, and those are skipped so a turn is never
 * counted twice and a finished turn never has its authoritative count replaced.
 *
 * A jsonl message is attributed through `messages.id -> messages.turn_id`; the
 * transcript carries no turn id of its own, so a message without that row is left
 * alone rather than guessed at.
 */
function collectPiDesktopJsonlRows(db, dbPath, coveredTurnIds) {
  const sessionsDir = piDesktopSessionsDir(dbPath);
  if (!fs.existsSync(sessionsDir)) return [];

  const messageTurns = new Map();
  // Sessions still holding a turn the table has not counted. Only those
  // transcripts can contribute, so the rest of the corpus is never opened — the
  // steady state (every turn flushed) reads no jsonl at all.
  const pendingSessions = new Set();
  try {
    for (const message of db.prepare('SELECT id, turn_id, session_id FROM messages').iterate()) {
      const id = String(message.id || '');
      const turnId = String(message.turn_id || '');
      if (!id || !turnId) continue;
      messageTurns.set(id, turnId);
      if (!coveredTurnIds.has(turnId)) pendingSessions.add(String(message.session_id || ''));
    }
  } catch (_) {
    return []; // stores without a messages table cannot attribute the transcript
  }
  if (pendingSessions.size === 0) return [];

  let files;
  try {
    files = fs.readdirSync(sessionsDir);
  } catch (_) {
    return [];
  }

  const turns = new Map();
  for (const file of files) {
    if (!file.endsWith(PI_DESKTOP_JSONL_SUFFIX) || file.endsWith(PI_DESKTOP_REVISIONS_SUFFIX)) continue;
    const sessionId = file.slice(0, -PI_DESKTOP_JSONL_SUFFIX.length);
    if (!pendingSessions.has(sessionId)) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(sessionsDir, file), 'utf8');
    } catch (_) {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_) {
        continue; // a live turn leaves a partial last line behind
      }
      if (!entry || entry.type !== 'message' || !entry.meta || !entry.meta.usage) continue;
      const turnId = messageTurns.get(String(entry.id || ''));
      if (!turnId || coveredTurnIds.has(turnId)) continue;
      const usage = entry.meta.usage;
      let acc = turns.get(turnId);
      if (!acc) {
        acc = { sessionId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, startedAt: 0, lastAt: 0, model: '' };
        turns.set(turnId, acc);
      }
      acc.input += numberValue(usage.inputTokens);
      acc.output += numberValue(usage.outputTokens);
      acc.cacheRead += numberValue(usage.cacheReadTokens);
      acc.cacheWrite += numberValue(usage.cacheWriteTokens);
      const at = timestampMs(entry.createdAt);
      if (at && (!acc.startedAt || at < acc.startedAt)) acc.startedAt = at;
      if (at > acc.lastAt) acc.lastAt = at;
      const model = normalizedModelId(entry.meta.modelId || '');
      if (model !== 'unknown') acc.model = model;
    }
  }

  const rows = [];
  for (const [turnId, acc] of turns) {
    if (acc.input + acc.output + acc.cacheRead + acc.cacheWrite === 0) continue;
    rows.push({
      sessionId: `pi-desktop:${acc.sessionId}`,
      messageId: `pi-desktop:${turnId}`,
      model: acc.model || 'unknown',
      input: acc.input,
      output: acc.output,
      cacheRead: acc.cacheRead,
      cacheWrite: acc.cacheWrite,
      createdAt: acc.lastAt || acc.startedAt,
      startedAt: acc.startedAt,
      endedAt: null,
      // One row per turn, matching how a turns-table row is counted.
      messages: 1
    });
  }
  return rows;
}

function collectPiDesktopRows(options = {}) {
  const paths = piDesktopDataPaths(options);
  const dbPaths = Array.isArray(options.dbPaths) ? options.dbPaths : paths.dbPaths;
  const rows = [];
  for (const dbPath of dbPaths) {
    if (!options.dbPaths && !fs.existsSync(dbPath)) continue;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const sql = 'SELECT id,session_id,status,model_id,input_tokens,output_tokens,usage_json,started_at,ended_at FROM turns';
      const stmt = db.prepare(sql);
      const it = stmt.iterate();
      const coveredTurnIds = new Set();
      for (const turn of it) {
        const row = normalizePiDesktopRow(turn);
        if (row && row.input + row.output + row.cacheRead + row.cacheWrite > 0) {
          rows.push(row);
          coveredTurnIds.add(String(turn.id));
        }
      }
      // Turns that have not flushed their counters yet — a turn still running, or
      // one that ended without writing usage_json — are picked up from the
      // transcript instead of being dropped.
      rows.push(...collectPiDesktopJsonlRows(db, dbPath, coveredTurnIds));
    } finally {
      db.close();
    }
  }
  return rows;
}

function buildTokscaleJson(startMs, rows, pricingByModel, includeUndated = false) {
  const grouped = new Map();
  const seen = new Set();
  for (const row of rows) {
    if (startMs && (row.createdAt ? row.createdAt < startMs : !includeUndated)) continue;
    const key = `${row.messageId || row.sessionId}\u0000${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const groupKey = `${row.sessionId}\u0000${row.model}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        sessionId: row.sessionId,
        model: row.model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        messages: 0,
        startedAt: 0,
        lastUsedAt: 0,
        cost: 0
      });
    }
    const group = grouped.get(groupKey);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += Number(row.messages || 1);
    const cost = estimatedRowCost(row, pricingByModel);
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }
  const entries = [...grouped.values()].map((row) => ({
    client: 'pi',
    mergedClients: null,
    sessionId: row.sessionId,
    model: row.model,
    provider: 'pi',
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    reasoning: 0,
    messageCount: row.messages,
    cost: row.cost,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '',
    performance: null
  }));
  const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
  return {
    groupBy: 'client,session,model',
    entries,
    totalInput: sum('input'),
    totalOutput: sum('output'),
    totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'),
    totalMessages: sum('messageCount'),
    totalCost: sum('cost'),
    processingTimeMs: 0
  };
}

function buildPiDesktopPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : collectPiDesktopRows(options);
  const pricingByModel = options.pricingByModel;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return {
    today: buildTokscaleJson(todayStart, rows, pricingByModel),
    month: buildTokscaleJson(monthStart, rows, pricingByModel),
    allTime: buildTokscaleJson(timestampMs(options.allTimeSince), rows, pricingByModel, true)
  };
}

function localDateKey(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildPiDesktopHistoryGraph(options = {}) {
  const days = new Map();
  for (const row of (Array.isArray(options.rows) ? options.rows : collectPiDesktopRows(options))) {
    const date = localDateKey(row.createdAt);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const day = days.get(date);
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = {
        client: 'pi',
        modelId: row.model,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(model);
    }
    const cost = estimatedRowCost(row, options.pricingByModel);
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.cost += cost === null ? 0 : cost;
    model.messages += Number(row.messages || 1);
  }
  return { contributions: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = {
  PI_DESKTOP_ROOT,
  collectPiDesktopRows,
  piDesktopDataPaths,
  piDesktopSessionsDir,
  timestampMs,
  estimatedRowCost,
  normalizedModelId,
  buildTokscaleJson,
  buildPiDesktopHistoryGraph,
  buildPiDesktopPeriods
};