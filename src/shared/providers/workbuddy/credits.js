'use strict';

const path = require('node:path');
const { resolveSqlite, openDb } = require('../../sqliteReadOnly');

// WorkBuddy keeps per-request credit spend in the local app database
// (`session_usage.credit_json`, a map of requestHash -> credits). No vendor API
// exposes this history, so the DB is the only source; exploding it here gives
// TokenLedger the credit ledger plus the session token counter (`used`) that
// the credits<->tokens regression calibrates against. 5.5 moved the home from
// `~/.workbuddy` to `~/.workbuddy-ai`; both roots stay resolvable, first hit
// wins, mirroring sessionMetadata.js.

function candidateDbPaths(home) {
  return [
    path.join(home, '.workbuddy', 'workbuddy.db'),
    path.join(home, '.workbuddy-ai', 'workbuddy.db')
  ];
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
  const fs = require('node:fs');
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
    const byModel = new Map();

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
      sessions.push({
        sessionId,
        model,
        usedTokens: Number(row.used) || 0,
        sizeTokens: Number(row.size) || 0,
        updatedAt: Number(row.updated_at) || null,
        credits: sessionCredits
      });
    }

    events.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
      warnings
    };
  } finally {
    try { db.close(); } catch (_) { /* read-only teardown is best effort */ }
  }
}

module.exports = { collectCredits, candidateDbPaths };
