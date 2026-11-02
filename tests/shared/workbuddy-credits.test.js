'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { collectCredits, candidateDbPaths, sessionTokens } = require('../../src/shared/providers/workbuddy/credits');

function writeTranscript(home, sessionId, records, workspace = 'demo-project') {
  const dir = path.join(home, '.workbuddy', 'projects', workspace);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));
  return file;
}

function usageRecord(usage, extra = {}) {
  return { type: 'function_call', id: `id-${Math.random()}`, message: { usage }, ...extra };
}

function createFixtureHome({ malformed = false, transcripts = false } = {}) {
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
  if (transcripts) {
    writeTranscript(home, 's1', [
      usageRecord({ input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 100, total_tokens: 1100 }),
      usageRecord({ input_tokens: 2000, cache_read_input_tokens: 8000, output_tokens: 200, total_tokens: 2200 })
    ]);
  }
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

test('collectCredits pairs each session with its billed tokens from the transcript', () => {
  const home = createFixtureHome({ transcripts: true });
  try {
    const result = collectCredits({ home });
    const s1 = result.sessions.find((s) => s.sessionId === 's1');
    const s2 = result.sessions.find((s) => s.sessionId === 's2');
    // input + cache_read + output — the same three components the panel shows,
    // and deliberately more than `total_tokens` (which omits the cached read).
    assert.equal(s1.tokens, 1000 + 5000 + 100 + 2000 + 8000 + 200);
    assert.equal(s1.transcriptRequests, 2);
    assert.equal(s1.cacheReadTokens, 13000);
    assert.equal(s1.outputTokens, 300);
    assert.equal(s1.usedTokens, 398901);
    // A session with no transcript is missing data, not a free session.
    assert.equal(s2.tokens, null);
    assert.equal(result.tokenTrackedSessions, 1);
    assert.equal(result.warnings.length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collectCredits warns when the ledger has no token track to calibrate against', () => {
  const home = createFixtureHome();
  try {
    const result = collectCredits({ home });
    assert.equal(result.tokenTrackedSessions, 0);
    assert.ok(result.warnings.some((w) => /calibration unavailable/.test(w)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sessionTokens re-reads only when the transcript changes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-wb-transcript-'));
  try {
    const file = writeTranscript(home, 's9', [
      usageRecord({ input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 })
    ]);
    assert.equal(sessionTokens(home, 's9').tokens, 110);
    // Same file, unchanged: served from cache.
    assert.equal(sessionTokens(home, 's9').tokens, 110);
    fs.writeFileSync(file, [
      usageRecord({ input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 }),
      usageRecord({ input_tokens: 50, cache_read_input_tokens: 0, output_tokens: 5 })
    ].map((r) => JSON.stringify(r)).join('\n'));
    assert.equal(sessionTokens(home, 's9').tokens, 165);
    assert.equal(sessionTokens(home, 'missing'), null);
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
