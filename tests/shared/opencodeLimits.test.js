'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// node:sqlite is stable on Node >=22.15.0 and Node >=23.5.0; older 23.x builds
// need --experimental-sqlite. Guard the import so the whole suite does not crash
// on those versions — tests that need a real DB are skipped automatically.
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) {}
const sqliteAvailable = DatabaseSync != null;
const sqliteSkip = sqliteAvailable ? false : 'node:sqlite unavailable (run with --experimental-sqlite on Node <23.5)';

const oc = require('../../src/shared/opencodeLimits');

// ---------------------------------------------------------------------------
// Helper: build a synthetic opencode.db in a temp dir
// ---------------------------------------------------------------------------
const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb(messages) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocdb-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  const ins = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
  let i = 0;
  for (const m of messages) {
    const data = JSON.stringify({ role: m.role || 'assistant', providerID: m.providerID, cost: m.cost, time: { created: m.createdMs } });
    ins.run('m' + (i++), 's1', m.createdMs, m.createdMs, data);
  }
  db.close();
  return file;
}

// ---------------------------------------------------------------------------
// Test 1: weekStartMs returns UTC Monday 00:00
// ---------------------------------------------------------------------------
test('weekStartMs returns UTC Monday 00:00 for a Thursday', () => {
  // 2026-06-04 09:30 UTC is a Thursday
  const thursday = Date.UTC(2026, 5, 4, 9, 30);
  const result = oc.weekStartMs(thursday);
  // 2026-06-01 00:00 UTC is the preceding Monday
  assert.strictEqual(result, Date.UTC(2026, 5, 1, 0, 0, 0));
});

// ---------------------------------------------------------------------------
// Test 2: monthBoundsMs anchors to first-usage day
// ---------------------------------------------------------------------------
test('monthBoundsMs anchors to first-usage day', () => {
  const anchor = Date.UTC(2026, 0, 20, 8, 0, 0); // 2026-01-20 08:00 UTC
  const now = Date.UTC(2026, 5, 4);               // 2026-06-04
  const { startMs, endMs } = oc.monthBoundsMs(now, anchor);
  assert.strictEqual(startMs, Date.UTC(2026, 4, 20, 8, 0, 0)); // 2026-05-20 08:00
  assert.strictEqual(endMs, Date.UTC(2026, 5, 20, 8, 0, 0));   // 2026-06-20 08:00
});

// ---------------------------------------------------------------------------
// Test 3: goLimits parses env override or falls back to defaults
// ---------------------------------------------------------------------------
test('goLimits parses env override', () => {
  assert.deepStrictEqual(
    oc.goLimits({ TOKEN_MONITOR_OPENCODE_GO_LIMITS: '5,15,40' }),
    { session: 5, weekly: 15, monthly: 40 }
  );
});

test('goLimits returns DEFAULT_GO_LIMITS on empty env', () => {
  assert.deepStrictEqual(oc.goLimits({}), oc.DEFAULT_GO_LIMITS);
});

test('goLimits returns DEFAULT_GO_LIMITS on bad override', () => {
  assert.deepStrictEqual(
    oc.goLimits({ TOKEN_MONITOR_OPENCODE_GO_LIMITS: 'bad' }),
    oc.DEFAULT_GO_LIMITS
  );
});

// ---------------------------------------------------------------------------
// Test 4: sumCost only counts rows in [start, end)
// ---------------------------------------------------------------------------
test('sumCost only counts rows in [start, end)', () => {
  const rows = [
    { createdMs: 100, cost: 1 },
    { createdMs: 200, cost: 2 },
    { createdMs: 300, cost: 4 },
    { createdMs: 400, cost: 8 }
  ];
  assert.strictEqual(oc.sumCost(rows, 100, 300), 3);   // includes 100, excludes 300
  assert.strictEqual(oc.sumCost(rows, 200, 400), 6);   // includes 200, excludes 400
  assert.strictEqual(oc.sumCost(rows, 0, 500), 15);    // all
  assert.strictEqual(oc.sumCost(rows, 500, 600), 0);   // none
});

// ---------------------------------------------------------------------------
// Test 5: discoverDbPaths respects OPENCODE_DB env pointing at an existing file
// ---------------------------------------------------------------------------
test('discoverDbPaths respects OPENCODE_DB override', { skip: sqliteSkip }, () => {
  const file = makeDb([]);
  const result = oc.discoverDbPaths({ OPENCODE_DB: file });
  assert.deepStrictEqual(result, [file]);
});

// ---------------------------------------------------------------------------
// Test 6: discoverDbPaths scans synthetic data dir, filters correctly
// ---------------------------------------------------------------------------
test('discoverDbPaths scans data dir and filters filenames correctly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocdir-'));
  tmpDirs.push(tmp);
  const dataDir = path.join(tmp, '.local', 'share', 'opencode');
  fs.mkdirSync(dataDir, { recursive: true });

  // Should be discovered (sorted):
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), '');
  fs.writeFileSync(path.join(dataDir, 'opencode-stable.db'), '');
  // Should NOT be discovered:
  fs.writeFileSync(path.join(dataDir, 'opencode.db-wal'), '');
  fs.writeFileSync(path.join(dataDir, 'opencode.db-shm'), '');
  fs.writeFileSync(path.join(dataDir, 'notes.txt'), '');

  const result = oc.discoverDbPaths({ HOME: tmp });
  const basenames = result.map((p) => path.basename(p));
  // sorted alphabetically: opencode-stable.db < opencode.db
  assert.deepStrictEqual(basenames, ['opencode-stable.db', 'opencode.db']);
});

// ---------------------------------------------------------------------------
// Test 7: collectGo sums opencode-go cost, ignores opencode
// ---------------------------------------------------------------------------
test('collectGo sums opencode-go cost into session/weekly/monthly windows', { skip: sqliteSkip }, () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const file = makeDb([
    { providerID: 'opencode-go', cost: 3, createdMs: now - 60 * 60 * 1000 },         // 1h ago → in session
    { providerID: 'opencode-go', cost: 6, createdMs: Date.UTC(2026, 5, 2) },         // Jun 2 → in week, in month
    { providerID: 'opencode', cost: 99, createdMs: now - 1000 }                      // should be ignored
  ]);
  const result = oc.collectGo({ env: { OPENCODE_DB: file }, now: () => now });
  assert.strictEqual(result.status, 'ok');

  const session = result.windows.find((w) => w.kind === 'session');
  const weekly = result.windows.find((w) => w.kind === 'weekly');
  const monthly = result.windows.find((w) => w.kind === 'monthly');

  assert.strictEqual(session.used, 3);
  assert.strictEqual(session.limit, 12);
  assert.strictEqual(session.usedPercent, 25);
  assert.strictEqual(weekly.used, 9);
  assert.strictEqual(monthly.used, 9);
});

// ---------------------------------------------------------------------------
// Test 8: collectGo → notConfigured when only non-go usage exists
// ---------------------------------------------------------------------------
test('collectGo returns notConfigured when only opencode (non-go) usage exists', { skip: sqliteSkip }, () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const file = makeDb([
    { providerID: 'opencode', cost: 5, createdMs: now - 1000 }
  ]);
  const result = oc.collectGo({ env: { OPENCODE_DB: file }, now: () => now });
  assert.strictEqual(result.status, 'notConfigured');
});

// ---------------------------------------------------------------------------
// Test 8b: collectGo → unavailable when node:sqlite is absent
// ---------------------------------------------------------------------------
test('collectGo returns unavailable when sqlite module is absent', { skip: sqliteSkip }, () => {
  const file = makeDb([{ providerID: 'opencode-go', cost: 1, createdMs: Date.now() }]);
  const result = oc.collectGo({ env: { OPENCODE_DB: file }, now: () => Date.now(), sqlite: null });
  assert.strictEqual(result.status, 'unavailable');
});

// ---------------------------------------------------------------------------
// Test 9: collectGo → notConfigured when no db exists
// ---------------------------------------------------------------------------
test('collectGo returns notConfigured when no db exists', () => {
  const result = oc.collectGo({
    env: { OPENCODE_DB: '/no/such.db', HOME: '/no/such/home' },
    now: () => Date.UTC(2026, 5, 4)
  });
  assert.strictEqual(result.status, 'notConfigured');
});
