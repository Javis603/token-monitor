'use strict';

/**
 * mavis-reader.worker.js
 *
 * Worker thread script that owns the entire `node:sqlite` read path against
 * the mavis runtime database. It runs in its own V8 isolate, so even if
 * the runtime is actively writing to the SQLite WAL when we try to open
 * it (which used to lock the Electron main process's V8 isolate for an
 * unbounded amount of time when the read happened on the main thread),
 * the main process's event loop stays healthy and the collect cycle can
 * keep ticking.
 *
 * Contract:
 *   - Input:  `workerData = { dbPath, sql, bindArgs, maxReadRows, busyTimeoutMs }`
 *             `bindArgs` is an array of parameters to bind in `stmt.iterate(...)`.
 *   - Output: `parentPort.postMessage({ type: 'done', rowCount, rows })`
 *             or `{ type: 'error', error }`. The host resolves with `rows`
 *             or rejects with a fresh `Error(error)`.
 *
 * We intentionally post the rows over the worker channel rather than
 * returning a value — there's no return-value mechanism across workers
 * and postMessage gives us a clean termination signal (the host
 * terminates us right after `done`/`error` lands, which releases the
 * SQLite handle and any internal locks).
 *
 * Note: this script is loaded as a worker by `usage.js`. We use
 * `require()` (not `import`) so CommonJS bundling and Electron's asar
 * resolution both work without ESM-loader tweaks.
 */

const { parentPort, workerData } = require('node:worker_threads');

if (!parentPort) {
  // Defensive: this script only makes sense inside a Worker.
  throw new Error('mavis-reader.worker.js must be loaded as a worker_threads worker');
}

async function loadSqlite() {
  // `node:sqlite` is exposed as ESM only; the dynamic import is the
  // documented way to access it from a CommonJS module. Node 22.5+
  // provides it, and Electron 43's bundled Node 24.18.1 also exposes it.
  const mod = await import('node:sqlite');
  if (!mod || typeof mod.DatabaseSync !== 'function') {
    throw new Error('node:sqlite DatabaseSync unavailable in this runtime');
  }
  return mod.DatabaseSync;
}

async function run() {
  const DatabaseSync = await loadSqlite();
  const { dbPath, sql, bindArgs = [], maxReadRows, busyTimeoutMs } = workerData || {};

  if (!dbPath || typeof dbPath !== 'string') {
    parentPort.postMessage({ type: 'error', error: 'mavis worker: dbPath missing or not a string' });
    return;
  }
  if (!sql || typeof sql !== 'string') {
    parentPort.postMessage({ type: 'error', error: 'mavis worker: sql missing or not a string' });
    return;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // busy_timeout applies only to statement execution, not the
    // constructor; we still set it because the active writer can hold
    // the lock past the constructor and we'd rather wait briefly here
    // than surface a "database is locked" error to the UI.
    const busy = Number(busyTimeoutMs);
    if (Number.isFinite(busy) && busy > 0) {
      db.exec(`PRAGMA busy_timeout = ${Math.floor(busy)}`);
    }
    const stmt = db.prepare(sql);
    const iterator = stmt.iterate(...bindArgs);

    const rows = [];
    let rowCount = 0;
    const cap = Number.isFinite(Number(maxReadRows)) && Number(maxReadRows) > 0
      ? Number(maxReadRows)
      : 100_000;

    for (const row of iterator) {
      rowCount++;
      rows.push({
        ts: Number(row.ts) || 0,
        session_id: String(row.session_id || ''),
        agent_name: String(row.agent_name || ''),
        model: row.model == null ? null : String(row.model),
        input_tokens: Number(row.input_tokens) || 0,
        output_tokens: Number(row.output_tokens) || 0,
        reasoning_tokens: Number(row.reasoning_tokens) || 0,
        cache_read_tokens: Number(row.cache_read_tokens) || 0,
        cache_write_tokens: Number(row.cache_write_tokens) || 0,
        cost_usd: Number(row.cost_usd) || 0,
      });
      if (rowCount > cap) {
        parentPort.postMessage({
          type: 'error',
          error: `mavis read budget exceeded: rows > ${cap}`,
        });
        return;
      }
    }

    parentPort.postMessage({ type: 'done', rowCount, rows });
  } catch (e) {
    parentPort.postMessage({
      type: 'error',
      error: (e && e.message) ? e.message : String(e),
    });
  } finally {
    try { db.close(); } catch (_) { /* ignore */ }
  }
}

run().catch((e) => {
  // Last-ditch: post a single error message and let the host reject.
  try {
    parentPort.postMessage({
      type: 'error',
      error: (e && e.message) ? e.message : String(e),
    });
  } catch (_) { /* parentPort may be gone */ }
});