'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeUsageCostRules, projectUsageCosts, projectHistoryCosts, costIncluded, codexWebCostRule, updateCodexWebCostRule } = require('../../src/electron/usageCostPolicy');
const { normalizeHistory, parseGraphResult, mergeHistories, historyPreview } = require('../../src/shared/history');

const rules = [{ client: 'codex', modelPrefix: 'chatgpt-web/', included: true, models: { 'chatgpt-web/extra-high': false } }];
const period = {
  totalTokens: 600, costUsd: 15,
  clients: { codex: 300, claude: 300 }, clientCosts: { codex: 9, claude: 6 },
  models: { 'chatgpt-web/extra-high': 200, 'chatgpt-web/pro': 400 },
  modelCosts: { 'chatgpt-web/extra-high': 5, 'chatgpt-web/pro': 10 },
  clientModels: { codex: { 'chatgpt-web/extra-high': 100, 'chatgpt-web/pro': 200 }, claude: { 'chatgpt-web/extra-high': 100, 'chatgpt-web/pro': 200 } },
  clientModelCosts: { codex: { 'chatgpt-web/extra-high': 3, 'chatgpt-web/pro': 6 }, claude: { 'chatgpt-web/extra-high': 2, 'chatgpt-web/pro': 4 } },
  sessions: { 'codex:s': { client: 'codex', sessionId: 's', projectId: 'p', projectLabel: 'project', totalTokens: 300, costUsd: 9, models: { 'chatgpt-web/extra-high': 100, 'chatgpt-web/pro': 200 }, modelCosts: { 'chatgpt-web/extra-high': 3, 'chatgpt-web/pro': 6 } } },
  projects: { project: { totalTokens: 300, costUsd: 9 } }
};

test('default preserves identity; scoped exclusions change costs but never tokens or source data', () => {
  const stats = { periods: { today: period, month: period, allTime: period }, devices: [{ periods: { today: period } }] };
  const before = JSON.stringify(stats);
  assert.equal(projectUsageCosts(stats, []), stats);
  const result = projectUsageCosts(stats, rules);
  for (const p of Object.values(result.periods)) {
    assert.equal(p.costUsd, 12);
    assert.equal(p.excludedCostUsd, 3);
    assert.equal(p.totalTokens, 600);
    assert.deepEqual(p.models, period.models);
    assert.deepEqual(p.clientCosts, { codex: 6, claude: 6 });
    assert.equal(p.modelCosts['chatgpt-web/extra-high'], 2);
    assert.equal(p.clientModelCosts.codex['chatgpt-web/extra-high'], 0);
    assert.equal(p.sessions['codex:s'].costUsd, 6);
    assert.equal(p.projects.project.costUsd, 6);
  }
  assert.equal(result.devices[0].periods.today.costUsd, 12);
  assert.notEqual(result.historyRevision, stats.historyRevision);
  assert.notEqual(result.deviceHistoryRevision, stats.deviceHistoryRevision);
  assert.equal(JSON.stringify(stats), before);
  assert.equal(projectUsageCosts(stats, []).periods.today.costUsd, 15);
});

test('master switch overrides stored per-model selections without erasing them; other tools untouched', () => {
  const disabled = updateCodexWebCostRule(rules, { included: false });
  assert.equal(costIncluded(disabled, 'codex', 'chatgpt-web/pro'), false);
  assert.equal(costIncluded(disabled, 'claude', 'chatgpt-web/pro'), true);
  assert.equal(costIncluded(disabled, 'codex', 'gpt-5.5'), true);
  const enabled = updateCodexWebCostRule(disabled, { included: true });
  assert.equal(costIncluded(enabled, 'codex', 'chatgpt-web/pro'), true);
  assert.equal(costIncluded(enabled, 'codex', 'chatgpt-web/extra-high'), false);
  assert.equal(costIncluded(enabled, 'codex', 'chatgpt-web/future-tier'), true);
  assert.equal(codexWebCostRule([]).included, true);
});

test('invalid settings fail open and prototype keys never become rules', () => {
  assert.deepEqual(normalizeUsageCostRules(null), []);
  assert.deepEqual(normalizeUsageCostRules([{ client: '', modelPrefix: '', included: false }]), []);
  assert.deepEqual(normalizeUsageCostRules([{ client: '__proto__', modelPrefix: 'x/', included: false }]), []);
  assert.equal(costIncluded([{ client: 'codex', modelPrefix: 'x/', included: 'false' }], 'codex', 'x/a'), true);
});

test('graph attribution survives device merge and preview; daily monthly and lifetime costs agree', () => {
  const raw = { contributions: [{ date: '2026-09-11', clients: [
    { client: 'codex', modelId: 'chatgpt-web/extra-high', tokens: { input: 100 }, cost: 3 },
    { client: 'codex', modelId: 'chatgpt-web/pro', tokens: { input: 200 }, cost: 6 },
    { client: 'claude', modelId: 'chatgpt-web/extra-high', tokens: { input: 300 }, cost: 2 }
  ] }] };
  const history = normalizeHistory(parseGraphResult(raw), { todayKey: '2026-09-11' });
  const merged = mergeHistories([history, history], { todayKey: '2026-09-11' });
  const before = JSON.stringify(merged);
  assert.equal(merged.daily[0].clientModelCosts.codex['chatgpt-web/extra-high'], 6);
  const projected = projectHistoryCosts(merged, rules);
  assert.equal(projected.daily[0].cost, 16);
  assert.equal(projected.monthly[0].cost, 16);
  assert.equal(projected.summary.totalCost, 16);
  assert.equal(projected.daily[0].perClient.codex.cost, 12);
  assert.equal(projected.daily[0].perModel['chatgpt-web/extra-high'].cost, 4);
  assert.equal(projected.summary.totalTokens, 1200);
  assert.equal(projectHistoryCosts(historyPreview(merged), rules).daily[0].cost, 16);
  assert.equal(JSON.stringify(merged), before);
});

test('legacy ambiguous history keeps costs and reports incomplete attribution, never guesses a tool', () => {
  const history = { daily: [{ date: '2026-09-11', cost: 11, tokens: 600, perClient: { codex: { cost: 9 }, claude: { cost: 2 } }, perModel: { 'chatgpt-web/extra-high': { cost: 5 }, 'chatgpt-web/pro': { cost: 6 } } }], monthly: [] };
  const result = projectHistoryCosts(history, rules);
  assert.equal(result.daily[0].cost, 11);
  assert.equal(result.costPolicyIncomplete, true);
});

test('synced project costs without retained sessions are explicitly qualified, not silently filtered', () => {
  const raw = { periods: { allTime: { ...period, sessions: {} } } };
  const result = projectUsageCosts(raw, rules);
  assert.equal(result.periods.allTime.projects.project.costUsd, 9);
  assert.equal(result.periods.allTime.projects.project.costPolicyIncomplete, true);
  assert.equal(result.costPolicyIncomplete, true);
});

test('capped previews subtract old excluded months from the lifetime summary', () => {
  const history = normalizeHistory(parseGraphResult({ contributions: [
    { date: '2024-01-01', clients: [{ client: 'codex', modelId: 'chatgpt-web/extra-high', tokens: { input: 100 }, cost: 3 }] },
    { date: '2026-09-11', clients: [{ client: 'codex', modelId: 'chatgpt-web/pro', tokens: { input: 200 }, cost: 6 }] }
  ] }), { todayKey: '2026-09-11' });
  const result = projectHistoryCosts(historyPreview(history, { monthlyMonths: 1 }), rules);
  assert.equal(result.monthly.length, 1);
  assert.equal(result.summary.totalCost, 6);
  assert.equal(result.summary.totalTokens, 300);
});

test('merging recoverable single-tool legacy history keeps projected lifetime and month in agreement', () => {
  const legacy = { daily: [{ date: '2026-09-11', tokens: 100, cost: 3, perClient: { codex: { tokens: 100, cost: 3 } }, perModel: { 'chatgpt-web/extra-high': { tokens: 100, cost: 3 } } }] };
  legacy.monthly = [{ ...legacy.daily[0], month: '2026-09' }];
  const current = normalizeHistory(parseGraphResult({ contributions: [{ date: '2026-09-11', clients: [{ client: 'codex', modelId: 'chatgpt-web/pro', tokens: { input: 200 }, cost: 6 }] }] }), { todayKey: '2026-09-11' });
  const result = projectHistoryCosts(mergeHistories([legacy, current], { todayKey: '2026-09-11' }), rules);
  assert.equal(result.daily[0].cost, 6);
  assert.equal(result.monthly[0].cost, 6);
  assert.equal(result.summary.totalCost, 6);
});
