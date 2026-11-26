// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { antigravityCliDataDir } = require('../../clientSources');
const { CONTEXT_READ_WINDOW_MS, normalizeSessionContext } = require('../../sessionContext');

const CONVERSATION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** @param {Parameters<typeof antigravityCliDataDir>[0]} options */
function cliContextPath(options) {
  return path.join(path.dirname(antigravityCliDataDir(options)), 'token-monitor-context.sqlite');
}

/**
 * @param {typeof import('node:sqlite')} sqlite
 * @param {string} file
 * @param {Set<string>} ids
 * @param {number} now
 */
function readCliContext(sqlite, file, ids, now) {
  const readings = new Map();
  if (!fs.existsSync(file)) return readings;
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(`SELECT session_id, used, capacity FROM context_readings
      WHERE session_id IN (SELECT value FROM json_each(?)) AND observed_at >= ?`)
      .all(JSON.stringify([...ids]), now - CONTEXT_READ_WINDOW_MS);
    for (const row of rows) {
      readings.set(row.session_id, normalizeSessionContext({ contextTokens: row.used, contextWindow: row.capacity })
        || { contextTokens: 0, contextWindow: 0 });
    }
  } catch (_) { /* Missing status-line configuration or a concurrent write. */ }
  finally { db?.close(); }
  return readings;
}

/** @param {unknown} payload */
function recordStatusLine(payload) {
  if (!payload || typeof payload !== 'object' || !('product' in payload) || payload.product !== 'antigravity') return;
  const { conversation_id: id, context_window: context } = /** @type {{conversation_id?: string, context_window?: { context_window_size?: number, used_percentage?: number }}} */ (payload);
  if (typeof id !== 'string' || !CONVERSATION_ID.test(id)) return;
  const size = context?.context_window_size;
  const capacity = typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? size : 0;
  const percent = context?.used_percentage;
  // The CLI reports its native percentage against the full model window.
  // Its status-line percentage is rounded, so the reconstructed count is approximate.
  const used = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100
    ? Math.round(percent * capacity / 100) : 0;
  const now = Date.now();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(cliContextPath(undefined));
  try {
    db.exec(`PRAGMA busy_timeout = 250;
      CREATE TABLE IF NOT EXISTS context_readings (
        session_id TEXT PRIMARY KEY, used INTEGER NOT NULL, capacity INTEGER NOT NULL, observed_at INTEGER NOT NULL
      )`);
    db.prepare(`INSERT INTO context_readings VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET used=excluded.used, capacity=excluded.capacity, observed_at=excluded.observed_at
      WHERE excluded.observed_at >= context_readings.observed_at
        AND (context_readings.used != excluded.used OR context_readings.capacity != excluded.capacity
          OR excluded.observed_at - context_readings.observed_at >= ?)`)
      .run(id, used, used ? capacity : 0, now, CONTEXT_READ_WINDOW_MS / 2);
    db.prepare('DELETE FROM context_readings WHERE observed_at < ?').run(now - CONTEXT_READ_WINDOW_MS);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  // The hook leaves the built-in status line in place. Failed or malformed
  // frames should never interrupt the terminal session.
  try {
    recordStatusLine(JSON.parse(fs.readFileSync(0, 'utf8')));
  } catch (_) { /* Retry on the next frame. */ }
}

module.exports = { cliContextPath, readCliContext };
