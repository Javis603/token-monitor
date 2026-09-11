'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const policy = require('../../src/electron/usageCostPolicy');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const rules = [{ client: 'codex', modelPrefix: 'chatgpt-web/', included: false }];
function mainFunction(name, dependencies) {
  const body = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(body);
  return vm.runInNewContext(`(${body})`, { ...policy, ...dependencies });
}

test('main process projects cached stats and restoring the setting needs no rescan', () => {
  const raw = { periods: { today: { totalTokens: 100, costUsd: 9, clientCosts: { codex: 9 }, modelCosts: { 'chatgpt-web/pro': 9 }, clientModelCosts: { codex: { 'chatgpt-web/pro': 9 } } } } };
  const settings = { usageCostRules: rules };
  const project = mainFunction('electronPresentationStats', { settings, mode: 'local', projectLimitStatsForDisplay: (stats) => stats });
  assert.equal(project(raw).periods.today.costUsd, 0);
  assert.equal(raw.periods.today.costUsd, 9);
  settings.usageCostRules = [];
  assert.equal(project(raw), raw);
});

test('dashboard history and per-device fixed periods use policy; export bypass stays raw', async () => {
  const row = { cost: 9, clientModelCosts: { codex: { 'chatgpt-web/pro': 9 } } };
  const history = { daily: [{ date: '2026-09-11', ...row }], monthly: [{ month: '2026-09', ...row }], summary: { totalCost: 9 } };
  const raw = { history, deviceHistories: [{ deviceId: 'one', history, periods: { today: { costUsd: 9, clientModelCosts: row.clientModelCosts } } }] };
  const getHistory = mainFunction('getDashboardHistory', {
    settings: { usageCostRules: rules }, historyResolverOptions: () => ({}),
    resolveCompleteHistoryWithDevices: async () => raw, getCompleteHistory: async () => history,
    completeHistorySource: () => 'remote', fixedPeriodHistoryMeta: () => ({ source: 'remote' })
  });
  const result = await getHistory({ includeDevices: true });
  assert.equal(result.summary.totalCost, 0);
  assert.equal(result.deviceHistories[0].history.daily[0].cost, 0);
  assert.equal(result.deviceHistories[0].periods.today.costUsd, 0);
  assert.equal((await getHistory({ raw: true })).daily[0].cost, 9);
  assert.equal(raw.history.summary.totalCost, 9);
});
