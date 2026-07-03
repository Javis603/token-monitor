'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  csvEscape, toCsv, buildSnapshotRows, buildDailyRows,
  renderSnapshotCsv, renderExportJson, exportFileSet, exportSignature, EXPORT_FILENAMES
} = require('../../src/shared/exporter');

const PERIODS = {
  today: {
    totalTokens: 30, costUsd: 3,
    clients: { codex: 20, 'claude-code': 10 },
    clientCosts: { codex: 2, 'claude-code': 1 },
    models: { 'gpt-5': 20, opus: 10 },
    modelCosts: { 'gpt-5': 2, opus: 1 }
  },
  month: { totalTokens: 0, costUsd: 0, clients: {}, clientCosts: {}, models: {}, modelCosts: {} },
  allTime: { totalTokens: 100, costUsd: 9, clients: { codex: 100 }, clientCosts: { codex: 9 }, models: {}, modelCosts: {} }
};

const HISTORY = {
  daily: [
    { date: '2026-07-02', tokens: 5, cost: 1, perClient: { codex: { tokens: 5, cost: 1, messages: 1 } }, perModel: {} },
    { date: '2026-07-03', tokens: 12, cost: 2, perClient: { codex: { tokens: 7, cost: 1 }, 'claude-code': { tokens: 5, cost: 1 } }, perModel: {} }
  ],
  monthly: [{ month: '2026-07', tokens: 17, cost: 3, perClient: {}, perModel: {} }],
  summary: { totalTokens: 17, totalCost: 3 }
};

test('csvEscape quotes fields with comma, quote, or newline', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('she said "hi"'), '"she said ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape(42), '42');
  assert.equal(csvEscape(null), '');
});

test('toCsv prepends a UTF-8 BOM and uses CRLF', () => {
  const csv = toCsv([{ a: 1, b: 2 }], ['a', 'b']);
  assert.ok(csv.startsWith('﻿'), 'starts with BOM');
  assert.ok(csv.includes('a,b\r\n1,2\r\n'), 'header + row with CRLF');
});

test('toCsv can omit the BOM', () => {
  const csv = toCsv([{ a: 1 }], ['a'], { bom: false });
  assert.ok(!csv.startsWith('﻿'));
});

test('buildSnapshotRows emits tidy tool+model rows per period, skipping empty periods', () => {
  const rows = buildSnapshotRows(PERIODS);
  assert.deepEqual(
    rows.filter((r) => r.period === 'today' && r.dimension === 'tool'),
    [
      { period: 'today', dimension: 'tool', name: 'codex', tokens: 20, cost_usd: 2 },
      { period: 'today', dimension: 'tool', name: 'claude-code', tokens: 10, cost_usd: 1 }
    ]
  );
  assert.ok(rows.some((r) => r.period === 'today' && r.dimension === 'model' && r.name === 'gpt-5'));
  assert.ok(!rows.some((r) => r.period === 'month'), 'empty period contributes no rows');
});

test('buildDailyRows emits one row per date x tool', () => {
  const rows = buildDailyRows(HISTORY);
  assert.deepEqual(rows, [
    { date: '2026-07-02', tool: 'codex', tokens: 5, cost_usd: 1 },
    { date: '2026-07-03', tool: 'codex', tokens: 7, cost_usd: 1 },
    { date: '2026-07-03', tool: 'claude-code', tokens: 5, cost_usd: 1 }
  ]);
});

test('renderSnapshotCsv has the expected header', () => {
  const csv = renderSnapshotCsv(PERIODS);
  assert.ok(csv.includes('period,dimension,name,tokens,cost_usd\r\n'));
});

test('renderExportJson has the documented shape', () => {
  const json = JSON.parse(renderExportJson({ periods: PERIODS, history: HISTORY, meta: { generatedAt: 'X', app: { name: 'token-monitor', version: '1.2.3' } } }));
  assert.equal(json.generatedAt, 'X');
  assert.deepEqual(json.app, { name: 'token-monitor', version: '1.2.3' });
  assert.equal(json.snapshot.today.totalTokens, 30);
  assert.equal(json.daily.length, 2);
  assert.equal(json.monthly.length, 1);
});

test('renderExportJson preserves cache/output/session fields losslessly', () => {
  const periods = {
    today: {
      totalTokens: 30, costUsd: 3,
      clients: { codex: 20 }, clientCosts: { codex: 2 },
      models: { 'gpt-5': 20 }, modelCosts: { 'gpt-5': 2 },
      clientCacheReads: { codex: 15 }, clientOutputs: { codex: 5 },
      modelCacheReads: { 'gpt-5': 15 }, modelOutputs: { 'gpt-5': 5 },
      clientModels: { codex: { 'gpt-5': 20 } },
      sessions: { 'codex:abc': { client: 'codex', totalTokens: 20, costUsd: 2 } }
    }
  };
  const json = JSON.parse(renderExportJson({ periods, history: {} }));
  assert.deepEqual(json.snapshot.today.clientCacheReads, { codex: 15 });
  assert.deepEqual(json.snapshot.today.clientOutputs, { codex: 5 });
  assert.deepEqual(json.snapshot.today.clientModels, { codex: { 'gpt-5': 20 } });
  assert.deepEqual(json.snapshot.today.sessions, { 'codex:abc': { client: 'codex', totalTokens: 20, costUsd: 2 } });
});

test('export never leaks devices/limits/account metadata (privacy hard rule)', () => {
  const json = JSON.parse(renderExportJson({ periods: PERIODS, history: HISTORY }));
  const text = JSON.stringify(json);
  assert.ok(!('devices' in json));
  assert.ok(!('limits' in json));
  assert.ok(!/accountKey|accountEmail|accountLabel|deviceId|hostname/.test(text));
});

test('exportSignature is stable across key order and ignores generatedAt', () => {
  const a = exportSignature({ today: { clients: { codex: 1, opus: 2 } } }, HISTORY);
  const b = exportSignature({ today: { clients: { opus: 2, codex: 1 } } }, HISTORY);
  assert.equal(a, b, 'same data, different key order → same signature');
  // exportSignature takes only periods+history, so the volatile generatedAt in
  // rendered JSON cannot affect it.
  assert.ok(!/generatedAt/.test(a));
});

test('exportSignature changes when usage or history changes', () => {
  const base = exportSignature(PERIODS, HISTORY);
  const moreTokens = exportSignature({ ...PERIODS, today: { ...PERIODS.today, clients: { codex: 21 } } }, HISTORY);
  assert.notEqual(base, moreTokens, 'a tool token change flips the signature');

  const moreDays = exportSignature(PERIODS, { ...HISTORY, daily: [...HISTORY.daily, { date: '2026-07-04', tokens: 1, cost: 0, perClient: { codex: { tokens: 1, cost: 0 } } }] });
  assert.notEqual(base, moreDays, 'a new history day flips the signature');
});

test('exportFileSet omits daily.csv when history has no daily rows', () => {
  const withDaily = exportFileSet({ periods: PERIODS, history: HISTORY });
  assert.deepEqual(withDaily.map((f) => f.name), ['token-monitor-export.json', 'token-monitor-snapshot.csv', 'token-monitor-daily.csv']);

  const noDaily = exportFileSet({ periods: PERIODS, history: { daily: [], monthly: [] } });
  assert.deepEqual(noDaily.map((f) => f.name), ['token-monitor-export.json', 'token-monitor-snapshot.csv']);
});

test('exportFileSet names are always a subset of EXPORT_FILENAMES (writer cleanup relies on this)', () => {
  const known = new Set(EXPORT_FILENAMES);
  for (const set of [exportFileSet({ periods: PERIODS, history: HISTORY }), exportFileSet({ periods: PERIODS, history: { daily: [] } })]) {
    for (const f of set) assert.ok(known.has(f.name), `${f.name} must be in EXPORT_FILENAMES`);
  }
});
