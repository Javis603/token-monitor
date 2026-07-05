'use strict';

// Reads ZCode per-request token usage from ~/.zcode/cli/db/db.sqlite::model_usage.
// Mirrors the cc-switch field mapping (see docs/guides/zcode-usage-tracking.md §3–§4):
// terminal-state-only filter, cache-inclusive input (input already contains cache_read),
// reasoning excluded from output (output is pure), session_id/provider_id/model_id preserved.
// tokscale does not scan ~/.zcode/projects (it rarely exists); the real data lives in the
// SQLite db, so we read it directly via node:sqlite (Node >= 22.5 / Electron 42).

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

function resolveSqlite(deps) {
  return deps.sqlite !== undefined ? deps.sqlite : sqlite;
}

function resolveDbPath(deps) {
  if (deps.dbPath) return deps.dbPath;
  const home = deps.homeDir || require('node:os').homedir();
  const path = require('node:path');
  return path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
}

function openDb(dbPath, sqliteMod) {
  const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 250');
  return db;
}

// Local midnight boundary: today starts at local 00:00, month at local 1st 00:00.
// Mirrors usage.js utcDayKey/utcMonthKey but in local time so a request at 23:59 UTC
// on a day-N local date still lands in today, not tomorrow.
function localTodayStartMs(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localMonthStartMs(date = new Date()) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Terminal-state filter: cc-switch §4 — only rows with completed_at AND status in
// ('completed', 'cancelled', 'error') AND at least one token > 0. Prevents half-written
// streaming rows from being synced (would be INSERT OR IGNORE'd by primary key and
// permanently undercounted).
const TERMINAL_ROWS_SQL =
  `SELECT session_id,
          model_id,
          provider_id,
          input_tokens,
          output_tokens,
          reasoning_tokens,
          cache_creation_input_tokens,
          cache_read_input_tokens,
          started_at,
          completed_at
   FROM model_usage
   WHERE completed_at IS NOT NULL
     AND status IN ('completed', 'cancelled', 'error')
     AND (input_tokens > 0 OR output_tokens > 0
          OR cache_creation_input_tokens > 0 OR cache_read_input_tokens > 0)`;

// Read all terminal rows and bucket into { today, month, allTime } neutral shapes
// that extractUsageFromTokscale can consume. Filters by completed_at ms against
// local-time boundaries. Returns raw row arrays (not yet extracted).
function readZcodeRows(dbPath, sqliteMod, nowMs) {
  let db;
  try {
    db = openDb(dbPath, sqliteMod);
  } catch (_) {
    return null; // unreadable or missing — caller returns empty
  }
  try {
    const rows = db.prepare(TERMINAL_ROWS_SQL).all();
    const todayStart = localTodayStartMs(new Date(nowMs));
    const monthStart = localMonthStartMs(new Date(nowMs));
    const bucket = { today: [], month: [], allTime: [] };
    for (const row of rows) {
      const completedMs = num(row.completed_at);
      if (completedMs <= 0) continue; // should not happen given WHERE, but defensive
      // ZCode's input_tokens is cache-INCLUSIVE (includes cache_read, like
      // OpenAI/Gemini). usage.js's additive total formula is
      // fresh_input + cache_read + output + cache_creation, so we MUST pass the
      // FRESH input (input - cache_read) here — otherwise extractUsageFromTokscale
      // would add cache_read twice (input already absorbed it + explicit cache_read).
      // See cc-switch docs/guides/zcode-usage-tracking.md §3 ("getFreshInputTokens").
      const inputTokensRaw = Math.max(0, num(row.input_tokens));
      const cacheReadTokens = Math.max(0, num(row.cache_read_input_tokens));
      const freshInput = Math.max(0, inputTokensRaw - cacheReadTokens);
      const neutral = {
        client: 'zcode',
        session_id: String(row.session_id || ''),
        model: String(row.model_id || ''),
        provider: String(row.provider_id || ''),
        input_tokens: freshInput,
        output_tokens: num(row.output_tokens),
        cache_write_tokens: num(row.cache_creation_input_tokens),
        cache_read_tokens: cacheReadTokens,
        // reasoning is informational only; not added to total (output already pure).
        // Kept in the row so extractUsageFromTokscale's REASONING_TOKEN_KEYS picks it up
        // for display, but tokenValue() won't sum it (see usage.js TOKEN_COMPONENT_KEYS).
        reasoning_tokens: num(row.reasoning_tokens),
        started_at: isoFromMs(num(row.started_at)),
        last_used_at: isoFromMs(completedMs)
      };
      bucket.allTime.push(neutral);
      if (completedMs >= monthStart) bucket.month.push(neutral);
      if (completedMs >= todayStart) bucket.today.push(neutral);
    }
    return bucket;
  } finally {
    if (db) { try { db.close(); } catch (_) {} }
  }
}

// Main entry: returns { today, month, allTime } where each is an array of neutral
// rows ready for extractUsageFromTokscale. Returns null arrays if db missing/unreadable
// or node:sqlite unavailable — caller treats null as empty.
function collectZcodeUsage(deps = {}) {
  const sqliteMod = resolveSqlite(deps);
  if (!sqliteMod) return { today: null, month: null, allTime: null };
  const dbPath = resolveDbPath(deps);
  const nowMs = deps.nowMs != null ? deps.nowMs : Date.now();
  return readZcodeRows(dbPath, sqliteMod, nowMs) || { today: null, month: null, allTime: null };
}

module.exports = { collectZcodeUsage };
