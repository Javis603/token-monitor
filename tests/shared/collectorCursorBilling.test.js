'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cursorAuth = require('../../src/shared/providers/cursor/auth');
const { billingAccountKey, billingIdentityHash } = require('../../src/shared/providers/cursor/billingLedger');
const ledger = rows => ({ version: 2, accountKey: billingAccountKey('user_test'), identityHash: billingIdentityHash('owner@example.test'), rows });
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
const { normalizeDeviceRecord } = require('../../src/shared/usage');

test('failed optional Cursor detail reads preserve accounting and other client details', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-detail-error-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(cursorAuth, 'runCursorSync', async () => {});
  t.mock.method(require('../../src/shared/providers/cursor/localSessions'), 'readCursorLocalSessions', () => {
    throw new Error('Local metadata unavailable');
  });
  const sessions = { today: { 'reasonix:session': { totalTokens: 7 } }, month: {}, allTime: {} };
  const projects = { today: {}, month: {}, allTime: {} };
  const messages = [];
  const result = await collectUsageOnce({ clients: 'cursor,reasonix', homeDir: dir, env: {},
    now: new Date(2026, 9, 21, 12), osInfo: {}, wslScanEnabled: false, historyEnabled: false,
    runTokscale: async () => ({ entries: [{ client: 'reasonix', model: 'test', totalTokens: 7 }] }),
    reasonixNativeSessionsEnabled: true, reasonixNativeSessionCache: { getView: () => ({ sessions, projects }) },
    logger: message => messages.push(message) });
  assert.equal(result.today.totalTokens, 7);
  assert.equal(result.nativeSessions.today['reasonix:session'].totalTokens, 7);
  assert.ok(messages.some(message => message.includes('cursor local session scan failed: Local metadata unavailable')));
});

test('Cursor local turns fill missing accounting while connected billing retains precedence', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-detail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(cursorAuth, 'runCursorSync', async () => {});
  t.mock.method(cursorAuth, 'readCursorDesktopAccessToken', () => 'user_test::test-token');
  const now = new Date(2026, 9, 21, 12);
  const time = new Date(2026, 9, 21, 9).getTime();
  const log = path.join(dir, '.config/Cursor/logs/20261021T090000/window1/output_090000/cursor.hooks.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const row = { conversation_id: 'conversation', generation_id: 'turn', model: 'grok-4.7-high', user_email: 'owner@example.test',
    workspace_roots: ['/work/project'], input_tokens: 30, output_tokens: 5, cache_read_tokens: 20, cache_write_tokens: 0 };
  const block = (time, event) => `[${new Date(time).toISOString()}] Running hook\nINPUT:\n${JSON.stringify({ ...row, hook_event_name: event }, null, 2)}\n\nOUTPUT:\n(empty)\n`;
  fs.writeFileSync(log, block(time, 'beforeSubmitPrompt') + block(time + 2000, 'stop'));
  const billingPath = path.join(dir, 'billing.json');
  fs.writeFileSync(billingPath, JSON.stringify(ledger([{ id: 'bill', eventTime: time + 1500,
    model: row.model, inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 35 }])));
  const options = { clients: 'cursor', deviceId: 'test', homeDir: dir, env: {}, platform: 'linux', now,
    osInfo: {}, wslScanEnabled: false, projectsEnabled: true, includeHistory: false,
    cursorBillingAccounts: [{ accountId: 'user_test', filePath: billingPath }], runTokscale: async () => ({ entries: [] }),
    pricingRevision: 'cursor-detail-pricing',
    lookupModelPricing: async () => ({ pricing: { inputCostPerToken: 0.000002, outputCostPerToken: 0.000006, cacheReadInputTokenCost: 5e-7 } }) };
  const result = await collectUsageOnce(options);
  assert.equal(result.today.clients.cursor, 35);
  assert.equal(result.today.sessions['cursor:conversation'], undefined);
  assert.equal(result.nativeSessions?.today['cursor:conversation']?.totalTokens, 35);
  assert.equal(Object.values(result.nativeProjects.today)[0].tokens, 35);
  const direct = await collectUsageOnce({ ...options, cursorBillingAccounts: [] });
  assert.equal(direct.nativeSessions?.today['cursor:conversation']?.totalTokens, 35,
    'local Cursor details must not depend on connecting Grok billing');
  assert.equal(Object.values(direct.nativeProjects.today)[0].tokens, 35);
  assert.equal(direct.today.totalTokens, 35, 'complete local turns must fill missing native usage without Grok');
  assert.equal(direct.today.models.unknown, 35, 'the selected model does not establish billing attribution');
  assert.equal(direct.today.unpricedTokens, 35);
  const wire = normalizeDeviceRecord(direct);
  assert.equal(wire.nativeSessions, undefined);
  assert.equal(wire.nativeProjects, undefined);
  assert.equal(wire.periods.today.totalTokens, 35);
  const project = Object.values(result.nativeProjects.today)[0];
  for (const billingRows of [JSON.parse(fs.readFileSync(billingPath)).rows, []]) {
    fs.writeFileSync(billingPath, JSON.stringify(ledger(billingRows)));
    const nativeProjects = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, {
      [project.projectId]: { ...project, tokens: 50, clients: { reasonix: 50 },
        models: { 'claude-sonnet-4': 50 } }
    }]));
    const combined = await collectUsageOnce({ ...options, clients: 'cursor,reasonix',
      reasonixNativeSessionsEnabled: true, reasonixNativeSessionCache: { getView: () => ({
        sessions: { today: {}, month: {}, allTime: {} }, projects: nativeProjects
      }) } });
    for (const name of ['today', 'month', 'allTime']) {
      const merged = combined.nativeProjects[name][project.projectId];
      assert.equal(merged.tokens, 85, 'Cursor details must retain the other tool subtotal');
      assert.equal(merged.clients.reasonix, 50);
      assert.equal(merged.clients.cursor, 35);
      assert.equal(merged.models['claude-sonnet-4'], 50);
      assert.equal(combined[name].clients.cursor || 0, billingRows.length ? 35 : 0,
        'local project details must not add accounting');
      assert.equal(nativeProjects[name][project.projectId].tokens, 50, 'the other provider snapshot stays immutable');
    }
  }
  const disabled = await collectUsageOnce({ ...options, clients: 'claude' });
  assert.equal(disabled.nativeSessions?.today['cursor:conversation'], undefined);
});

test('Cursor billing fills periods and history while native anchors stay free of supplements', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-billing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(cursorAuth, 'runCursorSync', async () => {});
  t.mock.method(cursorAuth, 'readCursorDesktopAccessToken', () => 'user_test::test-token');
  const now = new Date(2026, 9, 20, 12);
  const billingPath = path.join(dir, 'billing.json');
  const row = (day, totalTokens) => ({
    id: `day-${day}`, eventTime: new Date(2026, 9, day, 9).getTime(), model: 'cursor-auto',
    inputTokens: totalTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens
  });
  const rows = [row(19, 20), row(20, 10)];
  fs.writeFileSync(billingPath, JSON.stringify(ledger(rows)));
  const options = {
    clients: 'cursor,claude', deviceId: 'test', homeDir: dir, env: {}, now,
    allTimeSince: '2026-01-01', osInfo: {}, wslScanEnabled: false, projectsEnabled: false,
    codexLocalUsageEnabled: false, includeHistory: true, cursorBillingAccounts: [{ accountId: 'user_test', filePath: billingPath }],
    runTokscale: async () => ({ entries: [] }), runGraph: async () => ({ contributions: [] }),
    pricingRevision: 'cursor-billing-pricing',
    lookupModelPricing: async () => ({ pricing: { inputCostPerToken: 0.000002 } }),
    dailyHistoryArchiveEnabled: true, dailyHistoryArchiveOptions: { path: path.join(dir, 'history.json') }
  };
  let captured;
  const first = await collectUsageOnce({ ...options, onAnchorComputed: value => { captured = value; } });
  assert.equal(first.today.clients.cursor, 10);
  assert.equal(Number(first.today.costUsd.toFixed(8)), 0.00002);
  assert.equal(first.month.clients.cursor, 30);
  assert.equal(first.allTime.clients.cursor, 30);
  assert.equal(first.history?.summary.totalTokens, 30);
  assert.equal(first.history.daily.find(day => day.date === '2026-10-19').perClient.cursor.tokens, 20);
  assert.equal(captured.windowsPeriods.today.totalTokens, 0, 'supplements must not pollute exact native deltas');
  const anchor = { dateKey: localTodayKey(now), ...captured.windowsPeriods, todayPartitions: captured.todayPartitions,
    cursorBillingNativeSignature: captured.cursorBillingNativeSignature };
  rows.push(row(18, 40));
  fs.writeFileSync(billingPath, JSON.stringify(ledger(rows)));
  for (const targetClients of [['claude'], ['cursor'], []]) {
    const next = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients });
    assert.equal(next.today.clients.cursor, 10);
    assert.equal(next.month.clients.cursor, 70, 'historical backfill appears even during a targeted watch tick');
    assert.equal(next.history.summary.totalTokens, 70, 'retained history must not double count the supplement');
  }
  const disabled = await collectUsageOnce({ ...options, clients: 'claude' });
  assert.equal(disabled.today.totalTokens, 0);
  assert.equal(disabled.history, undefined);
});
