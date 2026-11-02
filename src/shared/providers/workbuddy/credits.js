'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveSqlite, openDb } = require('../../sqliteReadOnly');

// WorkBuddy keeps per-request credit spend in the local app database
// (`session_usage.credit_json`, a map of requestHash -> credits). No vendor API
// exposes this history, so the DB is the only source. 5.5 moved the home from
// `~/.workbuddy` to `~/.workbuddy-ai`; both roots stay resolvable, first hit
// wins, mirroring sessionMetadata.js.
//
// The credit ledger is only half of a calibration pair. `session_usage.used` is
// the *context window* fill (e.g. 508,319 of 1,000,000), not the tokens billed —
// regressing credits against it measures context pressure, not price. The billed
// counter lives in the per-session transcript
// (`<home>/projects/<workspace>/<sessionId>.jsonl`), one usage block per model
// round-trip, which is what `sessionTokens()` accumulates here.

const HOME_ROOTS = ['.workbuddy', '.workbuddy-ai'];

function candidateDbPaths(home) {
  return HOME_ROOTS.map((root) => path.join(home, root, 'workbuddy.db'));
}

// mtime+size keyed so a 15s collection tick does not re-parse half a megabyte
// of transcript per session. Bounded by the session count, not by time.
const transcriptCache = new Map();

function readNumber(source, ...keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

// Same three components the usage pipeline reports, so a calibrated coefficient
// is comparable to the token figure shown in the panel: cached input is billed
// too, and `total_tokens` alone leaves it out.
function usageTotals(usage) {
  const input = readNumber(usage, 'input_tokens', 'inputTokens');
  const cacheRead = readNumber(usage, 'cache_read_input_tokens', 'cacheReadInputTokens');
  const cacheWrite = readNumber(usage, 'cache_write_input_tokens', 'cacheWriteInputTokens');
  const output = readNumber(usage, 'output_tokens', 'outputTokens');
  const components = input + cacheRead + cacheWrite + output;
  const total = readNumber(usage, 'total_tokens', 'totalTokens');
  return {
    tokens: components > 0 ? components : total,
    input,
    cacheRead,
    cacheWrite,
    output,
    hasUsage: components > 0 || total > 0
  };
}

function parseSessionTokens(filePath) {
  const totals = { tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 };
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
  for (const line of content.split('\n')) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const usage = record?.usage || record?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const parts = usageTotals(usage);
    if (!parts.hasUsage) continue;
    totals.tokens += parts.tokens;
    totals.input += parts.input;
    totals.cacheRead += parts.cacheRead;
    totals.cacheWrite += parts.cacheWrite;
    totals.output += parts.output;
    totals.requests += 1;
  }
  return totals;
}

// One stat per candidate root; the transcript basename is the session id, so the
// lookup is a directory walk of depth two rather than a full scan.
function transcriptDirs(home) {
  const dirs = [];
  for (const root of HOME_ROOTS) {
    const projects = path.join(home || '', root, 'projects');
    let entries;
    try {
      entries = fs.readdirSync(projects, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(projects, entry.name));
    }
  }
  return dirs;
}

function sessionTokens(home, sessionId, dirs) {
  if (!sessionId) return null;
  const fileName = `${sessionId}.jsonl`;
  for (const dir of dirs || transcriptDirs(home)) {
    const filePath = path.join(dir, fileName);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      continue;
    }
    const cached = transcriptCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.totals;
    const totals = parseSessionTokens(filePath);
    if (!totals) continue;
    transcriptCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, totals });
    return totals;
  }
  return null;
}

function tableExists(db, name) {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name);
  return Boolean(row);
}

function readSessionModels(db) {
  const models = new Map();
  if (!tableExists(db, 'sessions')) return models;
  for (const row of db.prepare('SELECT id, model FROM sessions').all()) {
    if (row && row.id != null) models.set(String(row.id), row.model || null);
  }
  return models;
}

function explodeCreditJson(raw, warnings) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    warnings.push('credit_json is not valid JSON');
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push('credit_json is not an object');
    return [];
  }
  const events = [];
  for (const [requestHash, credits] of Object.entries(parsed)) {
    if (typeof credits !== 'number' || !Number.isFinite(credits)) continue;
    events.push({ requestHash, credits });
  }
  return events;
}

function collectCredits({ home, deps } = {}) {
  const sqliteMod = resolveSqlite(deps || {});
  // When both WorkBuddy homes exist (5.5 migration), the first-candidate rule
  // could pin a stale database; the freshest file wins instead.
  const candidates = candidateDbPaths(home || '')
    .map((p) => {
      try { return { p, mtime: fs.statSync(p).mtimeMs }; } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  const dbPath = candidates[0]?.p;
  if (!dbPath) return { available: false, reason: 'workbuddy.db not found' };
  if (!sqliteMod) return { available: false, reason: 'node:sqlite unavailable', dbPath };

  const warnings = [];
  let db;
  try {
    db = openDb(dbPath, sqliteMod);
  } catch (error) {
    return { available: false, reason: `open failed: ${error.message}`, dbPath };
  }

  try {
    if (!tableExists(db, 'session_usage')) {
      return { available: false, reason: 'session_usage table missing', dbPath, warnings };
    }
    const models = readSessionModels(db);
    const events = [];
    const sessions = [];
    let totalCredits = 0;
    let tokenTracked = 0;
    const byModel = new Map();
    const dirs = transcriptDirs(home);

    for (const row of db.prepare(
      'SELECT session_id, used, size, updated_at, credit_json FROM session_usage'
    ).all()) {
      const sessionId = row.session_id == null ? null : String(row.session_id);
      const model = sessionId ? (models.get(sessionId) || null) : null;
      const spent = explodeCreditJson(row.credit_json, warnings);
      let sessionCredits = 0;
      for (const { requestHash, credits } of spent) {
        // credit_json stores positive spend; the ledger records consumption as
        // negative so inflows (if ever present as negative input) stay distinct.
        const delta = -credits;
        sessionCredits += credits;
        totalCredits += credits;
        byModel.set(model || 'unknown', (byModel.get(model || 'unknown') || 0) + credits);
        events.push({
          dedupKey: `${sessionId}:${requestHash}`,
          sessionId,
          model,
          credits: delta,
          updatedAt: Number(row.updated_at) || null,
          requestHash
        });
      }
      const transcript = sessionTokens(home, sessionId, dirs);
      if (transcript && transcript.tokens > 0) tokenTracked += 1;
      sessions.push({
        sessionId,
        model,
        // Billed tokens from the transcript. Null (not 0) when the transcript is
        // gone — a pruned or never-persisted session is missing data, not a free
        // one, and the calibration must not fit it as zero.
        tokens: transcript && transcript.tokens > 0 ? transcript.tokens : null,
        transcriptRequests: transcript ? transcript.requests : 0,
        cacheReadTokens: transcript ? transcript.cacheRead : 0,
        outputTokens: transcript ? transcript.output : 0,
        usedTokens: Number(row.used) || 0,
        sizeTokens: Number(row.size) || 0,
        updatedAt: Number(row.updated_at) || null,
        credits: sessionCredits
      });
    }

    events.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (sessions.length > 0 && tokenTracked === 0) {
      // The ledger is readable but nothing can be calibrated against it: say so
      // once, instead of leaving the conversion page silently empty.
      warnings.push('no session transcript found; credits<->tokens calibration unavailable');
    }
    return {
      available: true,
      dbPath,
      events,
      sessions,
      totals: {
        credits: totalCredits,
        requests: events.length,
        byModel: Object.fromEntries(byModel)
      },
      tokenTrackedSessions: tokenTracked,
      warnings
    };
  } finally {
    try { db.close(); } catch (_) { /* read-only teardown is best effort */ }
  }
}

module.exports = { collectCredits, candidateDbPaths, sessionTokens, usageTotals };
