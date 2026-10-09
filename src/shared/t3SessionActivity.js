'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveSqlite, openDb } = require('./sqliteReadOnly');
const { processStarts } = require('./processStarts');
const { discoverT3DbPaths } = require('./t3SessionMetadata');
const { SESSION_ACTIVITY_PROVIDERS } = require('./sessionActivityProviders');

const MAX_SESSIONS = 256;
const REQUEST_KINDS = ['command', 'file-read', 'file-change', 'permission', 'mcp-elicitation', 'user_input'];

// A durable pending request alone is not evidence that its owner survived a
// crash. Validate the server incarnation before renewing any observation.
async function readT3Activities(options = {}, drivers = SESSION_ACTIVITY_PROVIDERS.map((entry) => entry.t3Driver).filter(Boolean)) {
  const results = new Map(drivers.map((driver) => [driver, new Map()]));
  if (!drivers.length) return results;
  const sqlite = resolveSqlite(options);
  if (!sqlite || options.scopedHome) return results;
  const clock = Number(new Date(options.now ?? Date.now()));
  for (const file of discoverT3DbPaths(options)) {
    if (path.basename(file) !== 'statev2.sqlite') continue;
    let runtime;
    try {
      // A leftover runtime marker is not an installed activity store. Missing
      // T3 installations never spawn a process probe or open a database.
      if (!fs.statSync(file).isFile()) continue;
      const runtimeFile = path.join(path.dirname(file), 'server-runtime.json');
      if (fs.statSync(runtimeFile).size > 8192) continue;
      runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
      const startedAt = Date.parse(runtime.startedAt);
      if (runtime.version !== 1 || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 0
        || runtime.pid > 2147483647 || !Number.isFinite(startedAt) || startedAt > clock) continue;
      const starts = await (options.readProcessStarts || processStarts)([runtime.pid], options.platform || process.platform);
      const actualStart = starts.get(runtime.pid);
      if (!Number.isFinite(actualStart) || actualStart > startedAt + 1000) continue;
    } catch (_) { continue; }
    let db;
    try {
      db = openDb(file, sqlite);
      // Select the bounded newest sessions before evaluating correlated request
      // lookups. ORDER BY/LIMIT in the subquery lets SQLite defer that work until
      // after sorting, rather than evaluating it for every historical candidate.
      // Join through the request's node and run, never a shared session id.
      const statement = db.prepare(`
        SELECT json_extract(c.payloadJson, '$.nativeThreadRef.nativeId') AS nativeId,
               c.providerStatus, c.runStatus, c.requestedAt, c.deleted,
               EXISTS (
                 SELECT 1 FROM orchestration_v2_projection_runtime_requests q
                 JOIN orchestration_v2_projection_nodes n ON n.node_id = q.node_id
                 WHERE n.provider_thread_id = c.providerThreadId AND n.run_id = c.runId
                   AND q.thread_id = c.threadId AND q.status = 'pending' AND q.resolved_at IS NULL
                   AND n.status = 'waiting' AND n.completed_at IS NULL
                   AND q.kind IN (${REQUEST_KINDS.map(() => '?').join(',')})
                   AND json_valid(q.payload_json)
                   AND json_extract(q.payload_json, '$.responseCapability.type') IN ('live', 'message')
                   AND q.created_at >= ?
                   AND (c.runStatus = 'running' OR
                     (c.runStatus = 'completed' AND q.kind = 'user_input'
                       AND json_extract(q.payload_json, '$.responseCapability.type') = 'message'))
               ) AS waiting
        FROM (
          SELECT p.provider_thread_id AS providerThreadId, p.thread_id AS threadId,
                 p.payload_json AS payloadJson, p.status AS providerStatus,
                 r.run_id AS runId, r.status AS runStatus, r.requested_at AS requestedAt,
                 t.deleted_at AS deleted
          FROM orchestration_v2_projection_provider_threads p
          JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
          JOIN orchestration_v2_projection_runs r ON r.provider_thread_id = p.provider_thread_id
            AND r.ordinal = p.last_run_ordinal
          WHERE COALESCE(p.driver, p.provider) = ? AND json_valid(p.payload_json)
            AND r.requested_at >= ?
          ORDER BY p.updated_at DESC LIMIT ?
        ) c
      `);
      for (const driver of drivers) {
        const result = results.get(driver);
        const rows = statement.all(...REQUEST_KINDS, runtime.startedAt, driver, runtime.startedAt, MAX_SESSIONS);
        for (const row of rows) {
          if (typeof row.nativeId !== 'string' || !row.nativeId || result.has(row.nativeId)
            || Date.parse(row.requestedAt) > clock) continue;
          const terminal = ['completed', 'cancelled', 'interrupted', 'failed', 'rolled_back'].includes(row.runStatus);
          const state = row.deleted ? 'idle'
            : row.waiting && ['running', 'completed'].includes(row.runStatus) ? 'waiting'
            : terminal ? 'idle'
            : row.providerStatus === 'active' && row.runStatus === 'running'
              ? 'running' : null;
          if (state) result.set(row.nativeId, { state, observedAt: new Date(clock).toISOString() });
        }
      }
    } catch (_) { /* Missing and incompatible stores provide no live evidence. */ }
    finally { if (db) { try { db.close(); } catch (_) {} } }
  }
  return results;
}


async function readT3Activity(options = {}, driver = 'codex') {
  const results = options.t3Activity ? await options.t3Activity : await readT3Activities(options, [driver]);
  return results.get(driver) || new Map();
}

module.exports = { readT3Activity, readT3Activities };
