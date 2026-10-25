'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { collectCredits, candidateDbPaths } = require('../../src/shared/providers/workbuddy/credits');

function createFixtureHome({ malformed = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-wb-credits-'));
  const dir = path.join(home, '.workbuddy');
  fs.mkdirSync(dir, { recursive: true });
  const sqlite = require('node:sqlite');
  const db = new sqlite.DatabaseSync(path.join(dir, 'workbuddy.db'));
  db.exec(`
    CREATE TABLE session_usage (
      session_id TEXT, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, model TEXT, created_at INTEGER, updated_at INTEGER
    );
  `);
  db.prepare('INSERT INTO sessions (id, cwd, model) VALUES (?, ?, ?)')
    .run('s1', 'E:/1project/demo', 'deepseek-v4.1-flash');
  db.prepare('INSERT INTO sessions (id, cwd, model) VALUES (?, ?, ?)')
    .run('s2', 'E:/20_xuexi', 'hy4-preview');
  db.prepare('INSERT INTO session_usage VALUES (?, ?, ?, ?, ?)')
    .run('s1', 398901, 1000000, 1792645435803, '{"a1":25.78,"a2":19.29}');
  db.prepare('INSERT INTO session_usage VALUES (?, ?, ?, ?, ?)')
    .run('s2', 641687, 1000000, 1792328555975, malformed ? '{oops' : '{"b1":3.7}');
  db.close();
  return home;
}

test('collectCredits explodes credit_json into a negative-credit ledger', () => {
  const home = createFixtureHome();
  try {
    const result = collectCredits({ home });
    assert.equal(result.available, true);
    assert.equal(result.events.length, 3);
    const s1a1 = result.events.find((e) => e.dedupKey === 's1:a1');
    assert.equal(s1a1.credits, -25.78);
    assert.equal(s1a1.model, 'deepseek-v4.1-flash');
    assert.equal(s1a1.updatedAt, 1792645435803);
    assert.equal(result.totals.credits, 48.77);
    assert.equal(result.totals.requests, 3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collectCredits joins session models and keeps token counters for calibration', () => {
  const home = createFixtureHome();
  try {
    const result = collectCredits({ home });
    const s2 = result.sessions.find((s) => s.sessionId === 's2');
    assert.equal(s2.model, 'hy4-preview');
    assert.equal(s2.usedTokens, 641687);
    assert.equal(s2.sizeTokens, 1000000);
    assert.equal(s2.credits, 3.7);
    assert.equal(result.totals.byModel['hy4-preview'], 3.7);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collectCredits skips malformed credit_json rows with a warning', () => {
  const home = createFixtureHome({ malformed: true });
  try {
    const result = collectCredits({ home });
    assert.equal(result.events.length, 2);
    assert.ok(result.warnings.length >= 1);
    assert.equal(result.totals.credits, 45.07);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collectCredits reports unavailable when the database is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-wb-empty-'));
  try {
    const result = collectCredits({ home });
    assert.equal(result.available, false);
    assert.match(result.reason, /not found/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('candidateDbPaths covers both WorkBuddy homes, legacy first', () => {
  const paths = candidateDbPaths('/home/u');
  assert.deepEqual(paths, [
    path.join('/home/u', '.workbuddy', 'workbuddy.db'),
    path.join('/home/u', '.workbuddy-ai', 'workbuddy.db')
  ]);
});
