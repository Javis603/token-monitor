'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { sharedDataDir } = require('./config');

function getDbPath(options = {}) {
  if (options.dbPath) return options.dbPath;
  const dir = sharedDataDir(options);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'token_monitor.db');
}

function initSqliteCache(options = {}) {
  const dbPath = getDbPath(options);
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_snapshots (
        device_id TEXT PRIMARY KEY,
        updated_at INTEGER,
        payload_json TEXT
      );
      CREATE TABLE IF NOT EXISTS daily_observations (
        date TEXT,
        client TEXT,
        model_id TEXT,
        tokens INTEGER,
        cost REAL,
        messages INTEGER,
        reasoning_tokens INTEGER,
        PRIMARY KEY (date, client, model_id)
      );
    `);
    return db;
  } catch (error) {
    console.warn(`[sqlite-cache] DB init failed at ${dbPath}: ${error.message}`);
    if (db) {
      try { db.close(); } catch (_) {}
    }
    return null;
  }
}

function readLatestSnapshot(deviceId = 'local', options = {}) {
  const db = initSqliteCache(options);
  if (!db) return null;
  try {
    const stmt = db.prepare('SELECT payload_json FROM usage_snapshots WHERE device_id = ?');
    const row = stmt.get(String(deviceId));
    if (!row || !row.payload_json) return null;
    const data = JSON.parse(row.payload_json);
    return data;
  } catch (error) {
    console.warn(`[sqlite-cache] Read snapshot failed: ${error.message}`);
    return null;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

function writeSnapshot(deviceId = 'local', snapshot = {}, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const db = initSqliteCache(options);
  if (!db) return false;
  try {
    const updatedAt = snapshot.updatedAt ? new Date(snapshot.updatedAt).getTime() : Date.now();
    const payloadJson = JSON.stringify(snapshot);
    const stmt = db.prepare(`
      INSERT INTO usage_snapshots (device_id, updated_at, payload_json)
      VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `);
    stmt.run(String(deviceId), updatedAt, payloadJson);
    return true;
  } catch (error) {
    console.warn(`[sqlite-cache] Write snapshot failed: ${error.message}`);
    return false;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

function upsertDailyObservations(date, observations = [], options = {}) {
  if (!date || !Array.isArray(observations) || observations.length === 0) return false;
  const db = initSqliteCache(options);
  if (!db) return false;
  try {
    const stmt = db.prepare(`
      INSERT INTO daily_observations (date, client, model_id, tokens, cost, messages, reasoning_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, client, model_id) DO UPDATE SET
        tokens = excluded.tokens,
        cost = excluded.cost,
        messages = excluded.messages,
        reasoning_tokens = excluded.reasoning_tokens
    `);
    for (const obs of observations) {
      if (!obs) continue;
      stmt.run(
        String(date).slice(0, 10),
        String(obs.client || 'unknown'),
        String(obs.modelId || obs.model || 'unknown'),
        Math.max(0, Math.round(Number(obs.tokens) || 0)),
        Math.max(0, Number(obs.cost) || 0),
        Math.max(0, Math.round(Number(obs.messages) || 0)),
        Math.max(0, Math.round(Number(obs.reasoningTokens) || 0))
      );
    }
    return true;
  } catch (error) {
    console.warn(`[sqlite-cache] Upsert daily observations failed: ${error.message}`);
    return false;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

module.exports = {
  getDbPath,
  initSqliteCache,
  readLatestSnapshot,
  writeSnapshot,
  upsertDailyObservations
};
