'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const GOOSE_ROW = Object.freeze({
  id: 'goose-contract', model: 'claude-sonnet-4-20250514',
  createdAt: '2026-08-20T00:00:00Z',
  total: 100, input: 70, output: 30,
  accumulatedTotal: 1600, accumulatedInput: 1200, accumulatedOutput: 340
});

function insertGooseRow(db, row = {}) {
  const value = { ...GOOSE_ROW, ...row };
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    value.id, JSON.stringify({ model_name: value.model }), 'anthropic', value.createdAt,
    value.total, value.input, value.output,
    value.accumulatedTotal, value.accumulatedInput, value.accumulatedOutput
  );
}

function writeGooseDatabase(file, rows = [{}], { wal = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, model_config_json TEXT, provider_name TEXT,
      created_at TEXT, total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER,
      accumulated_output_tokens INTEGER
    )`);
    for (const row of rows) insertGooseRow(db, row);
    // Retain the writer for an uncheckpointed WAL test; ordinary fixtures close.
    if (wal) return db;
  } catch (error) {
    db.close();
    throw error;
  }
  db.close();
}

module.exports = { GOOSE_ROW, insertGooseRow, writeGooseDatabase };
