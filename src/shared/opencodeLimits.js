'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SESSION_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GO_LIMITS = { session: 12, weekly: 30, monthly: 60 };
// OpenCode Go official limits (USD): https://opencode.ai/docs/go/ — $12/5h, $30/week, $60/month.
// These are server-side fixed values not stored in the local DB, so they are hardcoded; env-overridable in case the official values change.

// ---------------------------------------------------------------------------
// Limit config
// ---------------------------------------------------------------------------
function goLimits(env = process.env) {
  const raw = String(env.TOKEN_MONITOR_OPENCODE_GO_LIMITS || '').trim();
  if (!raw) return { ...DEFAULT_GO_LIMITS };
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n > 0)) {
    return { session: parts[0], weekly: parts[1], monthly: parts[2] };
  }
  return { ...DEFAULT_GO_LIMITS };
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------
function clampPercent(value) { return Math.max(0, Math.min(100, value)); }
function round1(value) { return Math.round(value * 10) / 10; }

// Returns the UTC Monday 00:00 timestamp for the week containing nowMs.
function weekStartMs(nowMs) {
  const d = new Date(nowMs);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const sinceMonday = day === 0 ? 6 : day - 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
}

// Returns [startMs, endMs) for the billing month that contains nowMs.
// anchorMs pins the month boundary to the day/time of the first usage; null → calendar month (UTC).
function monthBoundsMs(nowMs, anchorMs) {
  const now = new Date(nowMs);
  if (anchorMs == null) {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    return { startMs: start, endMs: end };
  }
  const a = new Date(anchorMs);
  const day = a.getUTCDate();
  const hh = a.getUTCHours();
  const mm = a.getUTCMinutes();
  const ss = a.getUTCSeconds();
  const ms = a.getUTCMilliseconds();
  const anchored = (year, month) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(day, lastDay), hh, mm, ss, ms);
  };
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let startMs = anchored(year, month);
  if (startMs > nowMs) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    startMs = anchored(year, month);
  }
  let ey = year;
  let em = month + 1;
  if (em > 11) { em = 0; ey += 1; }
  return { startMs, endMs: anchored(ey, em) };
}

function sumCost(rows, startMs, endMs) {
  let total = 0;
  for (const row of rows) {
    if (row.createdMs >= startMs && row.createdMs < endMs) total += row.cost;
  }
  return total;
}

// ---------------------------------------------------------------------------
// DB path discovery
// ---------------------------------------------------------------------------
function resolveDataDir(env = process.env) {
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'opencode');
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.local', 'share', 'opencode');
}

// Matches `opencode.db` or `opencode-<channel>.db` where channel is [A-Za-z0-9._-].
// Excludes WAL/SHM/journal side-files.
function isOpenCodeDbFilename(name) {
  if (!name.endsWith('.db')) return false;
  const stem = name.slice(0, -3);
  if (stem === 'opencode') return true;
  if (!stem.startsWith('opencode-')) return false;
  const channel = stem.slice('opencode-'.length);
  return channel.length > 0 && /^[A-Za-z0-9._-]+$/.test(channel);
}

function discoverDbPaths(env = process.env) {
  const override = String(env.OPENCODE_DB || '').trim();
  if (override) {
    try { if (fs.statSync(override).isFile()) return [override]; } catch (_) { /* fall through */ }
  }
  const dataDir = resolveDataDir(env);
  let entries;
  try { entries = fs.readdirSync(dataDir); } catch (_) { return []; }
  return entries.filter(isOpenCodeDbFilename).sort().map((name) => path.join(dataDir, name));
}

// ---------------------------------------------------------------------------
// SQLite read
// ---------------------------------------------------------------------------
const GO_ROWS_SQL = `
  SELECT CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS createdMs,
         CAST(json_extract(data,'$.cost') AS REAL) AS cost
  FROM message
  WHERE json_valid(data)
    AND json_extract(data,'$.providerID') = 'opencode-go'
    AND json_extract(data,'$.role') = 'assistant'
    AND json_type(data,'$.cost') IN ('integer','real')`;

function readGoRows(dbPath, sqliteMod = sqlite) {
  const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 250');
    const rows = db.prepare(GO_ROWS_SQL).all();
    return rows
      .filter((r) => Number.isFinite(r.createdMs) && r.createdMs > 0 && Number.isFinite(r.cost) && r.cost >= 0)
      .map((r) => ({ createdMs: Number(r.createdMs), cost: Number(r.cost) }));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Window assembly
// ---------------------------------------------------------------------------
function buildWindows(rows, nowMs, limits) {
  // Compute earliest timestamp with a plain loop to avoid stack overflow on large arrays.
  let earliest = null;
  for (const r of rows) { if (earliest === null || r.createdMs < earliest) earliest = r.createdMs; }

  const sessionStart = nowMs - SESSION_MS;
  const weekStart = weekStartMs(nowMs);
  const { startMs: monthStart, endMs: monthEnd } = monthBoundsMs(nowMs, earliest);

  const sessionRows = rows.filter((r) => r.createdMs >= sessionStart && r.createdMs < nowMs);

  // When there are no rows in the 5h window, the reset defaults to now+5h (next possible session boundary).
  let sessionOldest = nowMs;
  for (const r of sessionRows) { if (r.createdMs < sessionOldest) sessionOldest = r.createdMs; }

  // windowMinutes for monthly reflects the actual month length rather than a hardcoded value.
  const monthlyWindowMinutes = Math.round((monthEnd - monthStart) / 60000);

  const mk = (kind, used, limit, resetMs, windowMinutes) => ({
    kind,
    used: round1(used),
    limit,
    usedPercent: limit > 0 ? round1(clampPercent((used / limit) * 100)) : null,
    resetsAt: new Date(resetMs).toISOString(),
    windowMinutes
  });

  return [
    mk('session', sumCost(rows, sessionStart, nowMs), limits.session, sessionOldest + SESSION_MS, 300),
    mk('weekly', sumCost(rows, weekStart, weekStart + WEEK_MS), limits.weekly, weekStart + WEEK_MS, 10080),
    mk('monthly', sumCost(rows, monthStart, monthEnd), limits.monthly, monthEnd, monthlyWindowMinutes)
  ];
}

// ---------------------------------------------------------------------------
// Public collector
// ---------------------------------------------------------------------------
function collectGo(deps = {}) {
  const env = deps.env || process.env;
  const nowMs = (deps.now || Date.now)();
  // Allow injecting a sqlite module for testing the unavailable path.
  const sqliteMod = deps.sqlite !== undefined ? deps.sqlite : sqlite;
  const paths = discoverDbPaths(env);
  // "No DB found" and "DB readable but no opencode-go usage" both collapse to notConfigured
  // (per spec) so the provider is simply hidden rather than shown as an error.
  if (paths.length === 0) return { status: 'notConfigured', windows: [] };
  if (!sqliteMod) return { status: 'unavailable', windows: [] };

  let rows = [];
  let read = false;
  for (const dbPath of paths) {
    try { rows = rows.concat(readGoRows(dbPath, sqliteMod)); read = true; } catch (_) { /* skip unreadable db */ }
  }
  if (!read) return { status: 'unavailable', windows: [] };
  if (rows.length === 0) return { status: 'notConfigured', windows: [] };

  return { status: 'ok', identity: `opencode-go:${paths[0]}`, windows: buildWindows(rows, nowMs, goLimits(env)) };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  SESSION_MS,
  WEEK_MS,
  DEFAULT_GO_LIMITS,
  goLimits,
  weekStartMs,
  monthBoundsMs,
  sumCost,
  clampPercent,
  round1,
  discoverDbPaths,
  resolveDataDir,
  isOpenCodeDbFilename,
  collectGo,
  buildWindows,
  readGoRows
};
