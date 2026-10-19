'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeDeepTutorLedger(home) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(home, 'deeptutor-fixture', 'data', 'user');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'usage.sqlite3'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS llm_calls (call_id TEXT PRIMARY KEY, started_at REAL, session_id TEXT, turn_id TEXT, source TEXT, usage_json TEXT)');
    const insert = db.prepare('INSERT OR IGNORE INTO llm_calls VALUES (?, ?, ?, ?, ?, ?)');
    for (const estimated of [false, true]) {
      insert.run(`fixture-${estimated}`, 1792368000, 'dt-fixture-session', 'dt-fixture-turn', 'fixture', JSON.stringify({
        model: 'fixture-model', provider: 'openai_codex', status: 'completed', estimated,
        prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
        cache_read_input_tokens: 40, cache_creation_input_tokens: 10, reasoning_tokens: 5
      }));
    }
  } finally { db.close(); }
}

module.exports = { writeDeepTutorLedger };
