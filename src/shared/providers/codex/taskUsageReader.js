'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TaskUsageLedger, identifier } = require('./taskUsage');
const { codexHomeDir, discoverDbPaths } = require('./sessionMetadata');
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

function inside(file, root) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeRollout(file, home) {
  if (typeof file !== 'string' || path.extname(file) !== '.jsonl') return false;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return false;
    const real = fs.realpathSync(file);
    return ['sessions', 'archived_sessions'].some((part) => {
      try { return inside(real, fs.realpathSync(path.join(home, part))); } catch (_) { return false; }
    });
  } catch (_) { return false; }
}

function readCatalog(ledger, home, { dbPaths, sqlite } = {}) {
  const files = new Map();
  let sqliteMod = sqlite;
  if (sqliteMod === undefined) {
    try { sqliteMod = require('node:sqlite'); } catch (_) { sqliteMod = null; }
  }
  if (!sqliteMod) { ledger.diagnose('sqlite-unavailable'); return files; }
  const paths = discoverDbPaths({ dbPaths, homeDir: path.dirname(home), env: { CODEX_HOME: home } });
  if (!paths.length) ledger.diagnose('local-catalog-missing');
  for (const dbPath of paths) {
    let db;
    try {
      db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 250; PRAGMA query_only = ON');
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((r) => r.name));
      if (!columns.has('id')) { ledger.diagnose('unsupported-catalog-schema'); continue; }
      // No titles, prompts, cwd, creator identities, settings, or credentials.
      const fields = ['id', 'source', 'rollout_path', 'model', 'model_provider'].filter((k) => columns.has(k));
      for (const row of db.prepare(`SELECT ${fields.join(',')} FROM threads LIMIT 50001`).all()) {
        if (files.has(row.id)) continue; // newest schema wins
        ledger.metadata(row, 'local-catalog');
        if (identifier(row.id)) files.set(row.id, row.rollout_path || null);
      }
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
      if (tables.has('thread_spawn_edges')) {
        for (const row of db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges LIMIT 100001').all()) {
          ledger.metadata({ id: row.child_thread_id, parent_thread_id: row.parent_thread_id }, 'local-catalog');
        }
      }
    } catch (error) {
      if (error instanceof RangeError) throw error;
      ledger.diagnose('catalog-unreadable');
    } finally { if (db) { try { db.close(); } catch (_) {} } }
  }
  return files;
}

async function readEvents(file, ledger, options = {}) {
  let currentId = options.threadId || null;
  const evidence = options.evidence || 'event-import';
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) { ledger.diagnose('not-a-regular-file', currentId); return; }
    if (stat.size > MAX_FILE_BYTES) { ledger.diagnose('file-size-limit', currentId); return; }
    if (options.budget && (options.budget.bytes += stat.size) > MAX_TOTAL_BYTES) {
      ledger.diagnose('total-read-limit', currentId); return;
    }
    const stream = fs.createReadStream(file, { fd, autoClose: false, highWaterMark: 64 * 1024, end: Math.max(0, stat.size - 1) });
    let pending = Buffer.alloc(0);
    let skipping = false;
    let identityMismatch = false;
    const consume = (line) => {
      if (!line.length) return;
      let e;
      try { e = JSON.parse(line.toString('utf8')); } catch (_) { ledger.diagnose('malformed-json-line', currentId); return; }
      if (e?.type === 'session_meta') {
        const id = identifier(e.payload?.id);
        if (options.threadId && id !== options.threadId) {
          identityMismatch = true; ledger.diagnose('rollout-identity-mismatch', options.threadId); return;
        }
        if (id) currentId = id;
      }
      if (!identityMismatch) ledger.ingest(e, { threadId: currentId, evidence });
    };
    for await (const chunk of stream) {
      let start = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] !== 10) continue;
        const piece = chunk.subarray(start, i);
        if (!skipping && pending.length + piece.length <= MAX_LINE_BYTES) consume(Buffer.concat([pending, piece]));
        else if (!skipping) ledger.diagnose('oversized-line-skipped', currentId);
        pending = Buffer.alloc(0); skipping = false; start = i + 1;
      }
      if (!skipping) {
        const tail = chunk.subarray(start);
        if (pending.length + tail.length > MAX_LINE_BYTES) {
          pending = Buffer.alloc(0); skipping = true; ledger.diagnose('oversized-line-skipped', currentId);
        } else pending = Buffer.concat([pending, tail]);
      }
    }
    if (!skipping && pending.length) consume(pending);
    if (fs.fstatSync(fd).size !== stat.size) ledger.diagnose('file-changed-during-read', currentId);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    ledger.diagnose('events-file-unreadable', currentId);
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} } }
}

async function collectTaskUsage(options = {}) {
  const ledger = new TaskUsageLedger();
  const home = options.codexHome ? path.resolve(options.codexHome) : codexHomeDir();
  const files = options.noLocal ? new Map() : readCatalog(ledger, home, options);
  const budget = { bytes: 0 };
  // Import metadata before choosing local descendants. --no-local performs no DB reads.
  for (const file of [...new Set(options.events || [])]) await readEvents(file, ledger, { budget });
  if (options.thread && !identifier(options.thread)) throw new Error('invalid-thread-id');
  const selected = options.thread ? ledger.descendants(options.thread) : new Set(files.keys());
  for (const id of selected) {
    if (!files.has(id)) continue;
    const file = files.get(id);
    if (!safeRollout(file, home)) { ledger.diagnose('rollout-missing-or-unsafe', id); continue; }
    await readEvents(file, ledger, { threadId: id, evidence: 'local-rollout', budget });
  }
  return ledger.report(options.thread || null);
}

module.exports = { collectTaskUsage, readCatalog, readEvents, safeRollout, MAX_LINE_BYTES, MAX_FILE_BYTES };
