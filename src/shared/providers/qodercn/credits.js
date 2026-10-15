'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { sharedDataDir } = require('../../config');
const { qoderCnDataPaths } = require('./paths');
const { normalizeQoderCnCredits } = require('./creditUsage');

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_SOURCE_ENTRIES = 50000;
const MAX_FILES = 10000;

function creditRecord(entry) {
  if (entry?.type !== 'assistant' || entry.entrypoint !== 'cli') return null;
  const message = entry.message;
  const usage = message?.usage;
  if (!usage || !Object.hasOwn(usage, 'credits')) return null;
  const credits = usage.credits;
  const model = typeof message.model === 'string' ? message.model.trim() : '';
  const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  const identity = [
    ['request', usage.request_id], ['message', message.id], ['entry', entry.uuid]
  ].find(([, id]) => typeof id === 'string' && id.length > 0 && id.length <= 256);
  if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0 || credits > 1e12
    || !model || model.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(model)
    || !Number.isFinite(timestamp) || !identity) {
    throw new Error('Invalid Qoder CN CLI credits record (credits, model, timestamp or request identity)');
  }
  return { key: `${identity[0]}:${identity[1]}`, timestamp: new Date(timestamp).toISOString(), model, credits };
}

function sourceFiles(root, fsApi) {
  const files = [];
  let count = 0;
  function walk(dir, initial = false) {
    let entries;
    try { entries = fsApi.readdirSync(dir, { withFileTypes: true }); } catch (error) {
      if (initial && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (++count > MAX_SOURCE_ENTRIES) throw new Error('Qoder CN credits source entry budget exceeded');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (files.length >= MAX_FILES) throw new Error('Qoder CN credits file budget exceeded');
        files.push(file);
      }
    }
  }
  walk(root, true);
  return files.sort();
}

// Only metadata enters SQLite. Incomplete JSONL bytes live in this instance's
// memory, never in the ledger. Replays after restart deduplicate by request.
function createQoderCnCreditsCollector(options = {}) {
  const fsApi = options.fs || fs;
  const databasePath = options.databasePath || path.join(sharedDataDir(options), 'qodercn-credits.sqlite');
  let database;
  let root = '';
  let files = new Map();
  let cachedView = null;
  let dataVersion = null;
  let statements;

  function open() {
    if (database) return;
    if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const opened = new DatabaseSync(databasePath);
    try {
      opened.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL;');
      const version = opened.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw new Error('Unsupported Qoder CN credits ledger version');
      opened.exec(`
        CREATE TABLE IF NOT EXISTS requests (
          source_root TEXT NOT NULL, request_key TEXT NOT NULL,
          timestamp TEXT NOT NULL, model TEXT NOT NULL, credits REAL NOT NULL,
          PRIMARY KEY (source_root, request_key)
        );
        PRAGMA user_version = 1;
      `);
      statements = {
        existing: opened.prepare('SELECT timestamp, model, credits FROM requests WHERE source_root = ? AND request_key = ?'),
        put: opened.prepare(`INSERT INTO requests VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source_root, request_key) DO UPDATE SET timestamp=excluded.timestamp, model=excluded.model, credits=excluded.credits
          WHERE excluded.timestamp > requests.timestamp`),
        days: opened.prepare(`SELECT strftime('%Y-%m-%d', timestamp, 'localtime') AS day, model,
          SUM(credits) AS credits, COUNT(*) AS requests FROM requests
          WHERE source_root = ? GROUP BY day, model ORDER BY day, model`)
      };
    } catch (error) {
      opened.close();
      throw error;
    }
    database = opened;
  }

  function scan(scanOptions = {}) {
    const nextRoot = path.resolve(qoderCnDataPaths({ ...options, ...scanOptions }).projectsDir);
    const discovered = sourceFiles(nextRoot, fsApi);
    open();
    const previousFiles = root === nextRoot ? files : new Map();
    const stagedFiles = new Map();
    let scannedBytes = 0;
    let changed = root !== nextRoot;
    database.exec('BEGIN IMMEDIATE');
    try {
      const apply = (bytes, complete) => {
        if (bytes.length > MAX_LINE_BYTES) throw new Error('Qoder CN credits JSONL line budget exceeded');
        if (!bytes.toString('utf8').trim()) return;
        let entry;
        try { entry = JSON.parse(bytes.toString('utf8')); } catch (error) {
          if (!complete) return; // an unfinished final write will be retried
          throw new Error('Invalid complete JSONL record in Qoder CN credits source', { cause: error });
        }
        const row = creditRecord(entry);
        if (!row) return;
        const existing = statements.existing.get(nextRoot, row.key);
        if (existing?.timestamp === row.timestamp && (existing.model !== row.model || existing.credits !== row.credits)) {
          throw new Error('Conflicting Qoder CN credits metadata for the same request and timestamp');
        }
        const result = statements.put.run(nextRoot, row.key, row.timestamp, row.model, row.credits);
        changed ||= result.changes > 0;
      };

      for (const file of discovered) {
        const stat = fsApi.statSync(file);
        const old = previousFiles.get(file);
        if (old && old.size === stat.size && old.mtime === stat.mtimeMs && old.ctime === stat.ctimeMs && old.ino === stat.ino) {
          stagedFiles.set(file, old);
          continue;
        }
        const fd = fsApi.openSync(file, 'r');
        try {
          const read = (position, length) => {
            const bytes = Buffer.alloc(length);
            let offset = 0;
            while (offset < length) {
              const count = fsApi.readSync(fd, bytes, offset, length - offset, position + offset);
              if (!count) throw new Error('Qoder CN credits source changed during read');
              offset += count;
            }
            scannedBytes += length;
            if (scannedBytes > MAX_SCAN_BYTES) throw new Error('Qoder CN credits scan byte budget exceeded');
            return bytes;
          };
          // Prefix/tail comparisons distinguish append from source compaction
          // that grew. Truncation/replacement replays safely into the ledger.
          const append = old && old.ino === stat.ino && stat.size > old.size
            && read(0, old.head.length).equals(old.head)
            && read(old.size - old.tail.length, old.tail.length).equals(old.tail);
          let position = append ? old.size : 0;
          let pending = append ? old.pending : Buffer.alloc(0);
          while (position < stat.size) {
            const chunk = read(position, Math.min(64 * 1024, stat.size - position));
            position += chunk.length;
            const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            let start = 0;
            for (let index = bytes.indexOf(10); index !== -1; index = bytes.indexOf(10, start)) {
              apply(bytes.subarray(start, index), true);
              start = index + 1;
            }
            pending = Buffer.from(bytes.subarray(start));
            if (pending.length > MAX_LINE_BYTES) throw new Error('Qoder CN credits JSONL line budget exceeded');
          }
          apply(pending, false);
          const head = read(0, Math.min(128, stat.size));
          const tail = read(Math.max(0, stat.size - 64), Math.min(64, stat.size));
          const after = fsApi.fstatSync(fd);
          if (after.ino !== stat.ino || after.size < stat.size) throw new Error('Qoder CN credits source changed during read');
          stagedFiles.set(file, { size: stat.size, ino: stat.ino, mtime: stat.mtimeMs, ctime: stat.ctimeMs, pending, head, tail });
        } finally { fsApi.closeSync(fd); }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    const version = database.prepare('PRAGMA data_version').get().data_version;
    if (changed || !cachedView || version !== dataVersion) {
      const days = Object.create(null);
      for (const row of statements.days.all(nextRoot)) {
        const models = days[row.day] || (days[row.day] = Object.create(null));
        models[row.model] = { credits: row.credits, requests: row.requests };
      }
      const normalized = normalizeQoderCnCredits({ days });
      if (!normalized) throw new Error('Qoder CN credits history exceeds supported date/model bounds');
      cachedView = normalized;
    }
    files = stagedFiles;
    root = nextRoot;
    dataVersion = version;
    return getSnapshot(scanOptions);
  }

  function getSnapshot(scanOptions = {}) {
    if (!cachedView || root !== path.resolve(qoderCnDataPaths({ ...options, ...scanOptions }).projectsDir)) return null;
    const since = scanOptions.allTimeSince || options.allTimeSince || '';
    return { days: Object.fromEntries(Object.entries(cachedView.days).filter(([day]) => !since || day >= since)) };
  }

  function close() {
    database?.close();
    database = null;
    statements = null;
    files.clear();
    cachedView = null;
  }

  return { scan, getSnapshot, close };
}

module.exports = { createQoderCnCreditsCollector, creditRecord };
