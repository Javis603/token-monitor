'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { collectUsageOnce, clientsForWatchPath, watchAttributionRootsForClients, watchIgnoreMatcher, watchPathsForClients } = require('../../src/shared/collector');
const { emptyWslBundle } = require('../../src/shared/wslUsage');
const { readCcSwitchClaudeRows, loadCcSwitchClaudeRows, admittedCcSwitchClaudeRows, ccSwitchClaudeGraph } = require('../../src/shared/providers/claude/ccSwitch');

function fixture(t) {
  const root = path.join(process.cwd(), '.runtime', '.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cc-switch-test-'));
  const dbPath = path.join(dir, 'cc-switch.db');
  const cachePath = path.join(dir, 'usage.json');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE usage_daily_rollups (
      date TEXT, app_type TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_creation_tokens INTEGER, total_cost_usd REAL, success_count INTEGER
    );
    CREATE TABLE proxy_request_logs (
      request_id TEXT, app_type TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_creation_tokens INTEGER, total_cost_usd REAL,
      status_code INTEGER, data_source TEXT, created_at INTEGER
    );
  `);
  t.after(() => {
    try { db.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dbPath, cachePath };
}

function addRollup(db, date, app, input, cacheRead = 0) {
  db.prepare('INSERT INTO usage_daily_rollups VALUES (?, ?, ?, ?, 0, ?, 0, 0, 1)')
    .run(date, app, 'claude-sonnet', input, cacheRead);
}

function addLog(db, id, app, date, input, status = 200, source = 'proxy') {
  const timestamp = Math.floor(new Date(`${date}T12:00:00`).getTime() / 1000);
  db.prepare('INSERT INTO proxy_request_logs VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?)')
    .run(id, app, 'claude-sonnet', input, status, source, timestamp);
}

test('CC-Switch Claude rollups and successful proxy logs add disjoint requests', (t) => {
  const { db, dbPath } = fixture(t);
  addRollup(db, '2026-05-04', 'claude', 10, 40);
  addRollup(db, '2026-05-04', 'claude-desktop', 20, 80);
  addRollup(db, '2026-05-05', 'claude', 100);
  addLog(db, 'same-day', 'claude-desktop', '2026-05-05', 200);
  addLog(db, 'failed', 'claude-desktop', '2026-05-06', 999, 429);
  addLog(db, 'codex', 'codex', '2026-05-07', 9999);
  addLog(db, 'session-import', 'claude', '2026-05-07', 9999, 200, 'claude_session');
  const rows = readCcSwitchClaudeRows(dbPath);
  assert.equal(rows.reduce((sum, row) => sum + row.input + row.cacheRead, 0), 450);
  assert.deepEqual([...new Set(rows.map((row) => row.date))].sort(), ['2026-05-04', '2026-05-05']);
  assert.equal(ccSwitchClaudeGraph(rows).contributions.length, 2);
});

test('CC-Switch snapshot survives deletion of the original database', (t) => {
  const { db, dbPath, cachePath } = fixture(t);
  addRollup(db, '2026-05-04', 'claude', 25);
  assert.equal(loadCcSwitchClaudeRows({ dbPath, cachePath }).length, 1);
  db.close();
  fs.unlinkSync(dbPath);
  assert.equal(loadCcSwitchClaudeRows({ dbPath, cachePath })[0].input, 25);
});

test('a successful empty CC-Switch read clears the previous snapshot', (t) => {
  const { db, dbPath, cachePath } = fixture(t);
  addRollup(db, '2026-05-04', 'claude', 25);
  assert.equal(loadCcSwitchClaudeRows({ dbPath, cachePath }).length, 1);
  db.exec('DELETE FROM usage_daily_rollups');
  assert.deepEqual(loadCcSwitchClaudeRows({ dbPath, cachePath }), []);
  db.close();
  fs.unlinkSync(dbPath);
  assert.deepEqual(loadCcSwitchClaudeRows({ dbPath, cachePath }), []);
});

test('CC-Switch snapshot cannot supply rows for another database path', (t) => {
  const { db, dbPath, cachePath } = fixture(t);
  addRollup(db, '2026-05-04', 'claude', 25);
  assert.equal(loadCcSwitchClaudeRows({ dbPath, cachePath }).length, 1);
  const moved = path.join(path.dirname(dbPath), 'other.db');
  assert.deepEqual(loadCcSwitchClaudeRows({ dbPath: moved, cachePath }), []);
});

test('a cache write failure does not hide a live CC-Switch reading', (t) => {
  const { db, dbPath, cachePath } = fixture(t);
  addRollup(db, '2026-05-04', 'claude', 25);
  fs.mkdirSync(cachePath);
  assert.equal(loadCcSwitchClaudeRows({ dbPath, cachePath })[0].input, 25);
});

test('local Claude sessions exclude overlapping CC-Switch days; unattributed totals fail closed', () => {
  const rows = [
    { date: '2026-05-04', input: 10 },
    { date: '2026-05-05', input: 20 },
    { date: '2026-05-06', input: 30 }
  ];
  const local = {
    clients: { claude: 5 },
    sessions: { 'claude:s1': {
      client: 'claude', totalTokens: 5,
      startedAt: '2026-05-05T08:00:00', lastUsedAt: '2026-05-06T08:00:00'
    } }
  };
  assert.deepEqual(admittedCcSwitchClaudeRows(rows, local).map((row) => row.date), ['2026-05-04']);
  assert.deepEqual(admittedCcSwitchClaudeRows(rows, { ...local, clients: { claude: 6 } }), []);
  assert.deepEqual(admittedCcSwitchClaudeRows(rows, {
    ...local,
    sessions: { 'claude:s1': { ...local.sessions['claude:s1'], lastUsedAt: '' } }
  }), []);
});

test('CC-Switch database and WAL are watched and attributed only to Claude', (t) => {
  const { dbPath } = fixture(t);
  const options = { platform: 'win32', ccSwitchClaudeEnabled: true, ccSwitchDbPath: dbPath };
  const parent = path.dirname(dbPath);
  assert.ok(watchPathsForClients('claude', options).includes(parent));
  const attribution = watchAttributionRootsForClients('claude', null, options);
  const ignored = watchIgnoreMatcher('claude', options);
  assert.deepEqual(clientsForWatchPath(dbPath, attribution), ['claude']);
  assert.deepEqual(clientsForWatchPath(`${dbPath}-wal`, attribution), ['claude']);
  assert.deepEqual(clientsForWatchPath(path.join(parent, 'unrelated.json'), attribution), []);
  assert.equal(ignored(dbPath), false);
  assert.equal(ignored(`${dbPath}-wal`), false);
  assert.equal(ignored(`${dbPath}-shm`), true);
  assert.equal(ignored(path.join(parent, 'unrelated.json')), true);
});

test('collector adds CC-Switch Claude history to all-time and keeps Codex out', async (t) => {
  const { db, dbPath, cachePath } = fixture(t);
  addRollup(db, '2026-05-04', 'claude', 10, 40);
  addLog(db, 'codex', 'codex', '2026-05-04', 9999);
  const summary = await collectUsageOnce({
    clients: 'claude,codex', allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000, deviceId: 'dev1',
    now: new Date('2026-09-27T12:00:00'),
    platform: 'win32', ccSwitchClaudeEnabled: true, ccSwitchDbPath: dbPath, ccSwitchCachePath: cachePath,
    historyEnabled: true, includeHistory: true, dailyHistoryArchiveEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => ({ entries: [] }),
    runGraph: async () => ({ contributions: [] }),
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] })
  });
  assert.equal(summary.allTime.clients.claude, 50);
  assert.equal(summary.allTime.clients.codex || 0, 0);
  assert.equal(summary.today.totalTokens, 0);
  assert.equal(summary.history.daily.find((day) => day.date === '2026-05-04')?.tokens, 50);
});

test('anchored refresh changes CC-Switch Claude today by delta without counting it twice', async (t) => {
  const { db, dbPath, cachePath } = fixture(t);
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  addLog(db, 'first', 'claude-desktop', date, 10);
  let captured;
  const options = {
    clients: 'claude,codex', allTimeSince: '2024-01-01', now,
    commandTimeoutMs: 1000, deviceId: 'dev1',
    platform: 'win32', ccSwitchClaudeEnabled: true, ccSwitchDbPath: dbPath, ccSwitchCachePath: cachePath,
    historyEnabled: false, wslScanEnabled: false,
    runTokscale: async () => ({ entries: [] }),
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    onAnchorComputed: (value) => { captured = value; }
  };
  const first = await collectUsageOnce(options);
  assert.equal(first.today.clients.claude, 10);
  addLog(db, 'second', 'claude-desktop', date, 5);
  const anchored = await collectUsageOnce({
    ...options,
    todayOnlyAnchor: {
      dateKey: date,
      today: captured.windowsPeriods.today,
      month: captured.windowsPeriods.month,
      allTime: captured.windowsPeriods.allTime,
      todayPartitions: captured.todayPartitions,
      ccSwitchAdmittedRows: captured.ccSwitchAdmittedRows,
      ccSwitchTodayAdmitted: captured.ccSwitchTodayAdmitted
    }
  });
  assert.equal(anchored.today.clients.claude, 15);
  assert.equal(anchored.month.clients.claude, 15);
  assert.equal(anchored.allTime.clients.claude, 15);
  const unrelated = await collectUsageOnce({
    ...options,
    targetClients: ['codex'], historyEnabled: true, includeHistory: true,
    runGraph: async () => ({ contributions: [] }),
    todayOnlyAnchor: {
      dateKey: date,
      today: captured.windowsPeriods.today,
      month: captured.windowsPeriods.month,
      allTime: captured.windowsPeriods.allTime,
      todayPartitions: captured.todayPartitions,
      ccSwitchAdmittedRows: captured.ccSwitchAdmittedRows,
      ccSwitchTodayAdmitted: captured.ccSwitchTodayAdmitted
    }
  });
  assert.equal(unrelated.allTime.clients.claude, 15);
  assert.equal(unrelated.history.daily.find((day) => day.date === date)?.tokens, 15);
});

test('anchored refresh keeps CC-Switch today excluded when the full scan cannot date local Claude usage', async (t) => {
  const { db, dbPath, cachePath } = fixture(t);
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  addRollup(db, date, 'claude', 10);
  let captured;
  const options = {
    clients: 'claude', allTimeSince: '2024-01-01', now,
    commandTimeoutMs: 1000, deviceId: 'dev1',
    platform: 'win32', ccSwitchClaudeEnabled: true, ccSwitchDbPath: dbPath, ccSwitchCachePath: cachePath,
    historyEnabled: false, wslScanEnabled: false,
    runTokscale: async ({ flags }) => flags.includes('--since')
      ? { entries: [{ client: 'claude', model: 'claude-sonnet', input: 5, output: 0, cost: 0 }] }
      : { entries: [] },
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    onAnchorComputed: (value) => { captured = value; }
  };
  const full = await collectUsageOnce(options);
  assert.equal(captured.ccSwitchTodayAdmitted, false);
  assert.equal(full.today.clients.claude || 0, 0);
  assert.equal(full.allTime.clients.claude, 5);
  addRollup(db, date, 'claude', 5);
  const anchored = await collectUsageOnce({
    ...options,
    todayOnlyAnchor: {
      dateKey: date,
      today: captured.windowsPeriods.today,
      month: captured.windowsPeriods.month,
      allTime: captured.windowsPeriods.allTime,
      todayPartitions: captured.todayPartitions,
      ccSwitchAdmittedRows: captured.ccSwitchAdmittedRows,
      ccSwitchTodayAdmitted: captured.ccSwitchTodayAdmitted
    }
  });
  assert.equal(anchored.today.clients.claude || 0, 0);
  assert.equal(anchored.allTime.clients.claude, 5);
});
