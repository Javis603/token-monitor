'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { sharedDataDir } = require('../../config');

function localUsageDatabasePath(options = {}) {
  return options.databasePath || path.join(sharedDataDir(options), 'codex-local-usage.sqlite');
}

function usageCounters(value) {
  if (!value || typeof value !== 'object') return null;
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
  if (fields.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  const write = value.cacheWriteInputTokens ?? 0;
  if (!Number.isSafeInteger(write) || write < 0 || value.cachedInputTokens + write > value.inputTokens
    || value.reasoningOutputTokens > value.outputTokens
    || value.totalTokens !== value.inputTokens + value.outputTokens) return null;
  return {
    input: value.inputTokens - value.cachedInputTokens - write,
    cacheRead: value.cachedInputTokens, cacheWrite: write,
    output: value.outputTokens, reasoning: value.reasoningOutputTokens,
    total: value.totalTokens
  };
}

function createLocalUsageStore(options = {}) {
  const databasePath = localUsageDatabasePath(options);
  let database = null;
  let closed = false;

  function open(write = false) {
    if (closed) return null;
    if (database) return database;
    if (!write && !fs.existsSync(databasePath)) return null;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    database = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    database.exec(`
      PRAGMA busy_timeout = 2000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads (
        account_key TEXT NOT NULL, thread_id TEXT NOT NULL, metadata TEXT NOT NULL,
        checkpoint TEXT, PRIMARY KEY (account_key, thread_id)
      );
      CREATE TABLE IF NOT EXISTS requests (
        account_key TEXT NOT NULL, thread_id TEXT NOT NULL, checkpoint_total INTEGER NOT NULL,
        observed_at TEXT NOT NULL, turn_id TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL, usage TEXT NOT NULL,
        PRIMARY KEY (account_key, thread_id, checkpoint_total)
      );
      CREATE INDEX IF NOT EXISTS requests_thread ON requests(thread_id, observed_at);
    `);
    return database;
  }

  function observe({ accountKey, thread, environmentId, cwd, turnId, tokenUsage, now = new Date() }) {
    let last = usageCounters(tokenUsage?.last);
    const total = usageCounters(tokenUsage?.total);
    if (!accountKey || !thread?.id || !turnId || !thread.model || !last || !total
      || Object.keys(last).some((key) => last[key] > total[key])) return false;
    const db = open(true);
    if (!db) return false;
    const observedAt = new Date(now).toISOString();
    const metadata = {
      title: String(thread.name || '').trim(), model: thread.model, cwd, environmentId,
      createdAt: thread.createdAt, turnEnded: thread.status?.type === 'idle',
      contextTokens: last.total, contextWindow: tokenUsage.modelContextWindow || 0
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT checkpoint FROM threads WHERE account_key = ? AND thread_id = ?').get(accountKey, thread.id);
      const checkpoint = previous?.checkpoint ? JSON.parse(previous.checkpoint) : null;
      // Replayed, duplicate or out-of-order counters must not be added again.
      // Only the reported last request is attributed to this observation. An
      // unseen cumulative prefix has no trustworthy day/model/project split.
      if (checkpoint && total.total <= checkpoint.total) {
        db.exec('COMMIT');
        return false;
      }
      const monotonic = !checkpoint || ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning']
        .every((key) => total[key] >= checkpoint[key]);
      if (!monotonic) {
        db.exec('COMMIT');
        return false;
      }
      // Some servers revise the current request's counters incrementally.
      // When the exact cumulative delta is a subset of `last`, only its new
      // portion belongs to this observation. Never charge overlapping input.
      if (checkpoint && total.total - checkpoint.total < last.total) {
        const delta = Object.fromEntries(Object.keys(total).map((key) => [key, total[key] - checkpoint[key]]));
        if (Object.keys(delta).some((key) => delta[key] > last[key])) {
          db.exec('COMMIT');
          return false;
        }
        last = delta;
      }
      db.prepare(`INSERT INTO threads VALUES (?, ?, ?, ?)
        ON CONFLICT(account_key, thread_id) DO UPDATE SET metadata = excluded.metadata, checkpoint = excluded.checkpoint`)
        .run(accountKey, thread.id, JSON.stringify(metadata), JSON.stringify(total));
      if (last.total > 0) db.prepare('INSERT OR IGNORE INTO requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(accountKey, thread.id, total.total, observedAt, turnId, thread.model, cwd, JSON.stringify(last));
      db.exec('COMMIT');
      return last.total > 0;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function updateThread(accountKey, threadId, patch) {
    const db = open();
    if (!db) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT metadata FROM threads WHERE account_key = ? AND thread_id = ?').get(accountKey, threadId);
      const previous = row ? JSON.parse(row.metadata) : null;
      const next = previous ? { ...previous, ...patch } : null;
      const changed = previous && JSON.stringify(next) !== JSON.stringify(previous);
      if (changed) db.prepare('UPDATE threads SET metadata = ? WHERE account_key = ? AND thread_id = ?')
        .run(JSON.stringify(next), accountKey, threadId);
      db.exec('COMMIT');
      return Boolean(changed);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function rows() {
    const db = open();
    if (!db) return [];
    return db.prepare(`SELECT r.*, t.metadata FROM requests r JOIN threads t
      ON r.account_key = t.account_key AND r.thread_id = t.thread_id ORDER BY r.observed_at, r.checkpoint_total`)
      .all().map((row) => ({
        ...JSON.parse(row.metadata),
        threadId: row.thread_id, turnId: row.turn_id, model: row.model,
        cwd: row.cwd, observedAt: row.observed_at, usage: JSON.parse(row.usage)
      }));
  }

  function close() {
    closed = true;
    database?.close();
    database = null;
  }

  return { observe, updateThread, rows, close };
}

module.exports = { createLocalUsageStore, localUsageDatabasePath, usageCounters };
