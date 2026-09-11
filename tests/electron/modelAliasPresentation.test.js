'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeModelAliases, createModelAliasResolver, projectModelAliasStats, projectModelAliasHistory } = require('../../src/electron/modelAliasPresentation');

const aliases = { 'anthropic/claude-opus-5': 'claude-opus-5' };
const period = {
  totalTokens: 100, costUsd: 7, clients: { claude: 60, opencode: 40 }, clientCosts: { claude: 3, opencode: 4 },
  models: { 'anthropic/claude-opus-5': 40, 'claude-opus-5': 30, 'gpt-5.5-pro': 30 },
  modelCosts: { 'anthropic/claude-opus-5': 2, 'claude-opus-5': 1, 'gpt-5.5-pro': 4 },
  modelCacheReads: { 'anthropic/claude-opus-5': 4, 'claude-opus-5': 3 },
  modelCacheWrites: { 'anthropic/claude-opus-5': 2, 'claude-opus-5': 1 },
  modelOutputs: { 'anthropic/claude-opus-5': 8, 'claude-opus-5': 6 },
  modelUnclassifiedTokens: { 'anthropic/claude-opus-5': 1, 'claude-opus-5': 2 },
  clientModels: { claude: { 'anthropic/claude-opus-5': 40, 'claude-opus-5': 20 }, opencode: { 'claude-opus-5': 10, 'gpt-5.5-pro': 30 } },
  clientModelCosts: { claude: { 'anthropic/claude-opus-5': 2, 'claude-opus-5': 1 }, opencode: { 'gpt-5.5-pro': 4 } },
  sessions: { s1: { client: 'claude', sessionId: 's1', totalTokens: 40, costUsd: 2, models: { 'anthropic/claude-opus-5': 40 }, modelCosts: { 'anthropic/claude-opus-5': 2 } } },
  projects: { p1: { projectId: 'p1', models: { 'anthropic/claude-opus-5': 40, 'claude-opus-5': 30 } } }
};

test('empty or malformed aliases are a reference-preserving no-op', () => {
  const stats = { periods: { today: period } };
  for (const input of [undefined, null, [], 'x', {}, { x: 3, ' ': 'x', y: '' }]) {
    assert.deepEqual(normalizeModelAliases(input), {});
    assert.strictEqual(projectModelAliasStats(stats, input), stats);
  }
});

test('explicit aliases match case and separators once, without stripping versions or tiers', () => {
  const resolve = createModelAliasResolver({ ' OPENAI/GPT-5-5 ': 'gpt-5.5', 'gpt-5.5': 'next', next: 'OPENAI/GPT-5-5' });
  assert.equal(resolve('openai/gpt-5.5'), 'gpt-5.5');
  assert.equal(resolve('gpt-5.5'), 'next');
  for (const model of ['gpt-5.6', 'gpt-5.5-pro', 'gpt-5.5 (ExtraHigh)', 'openai/gpt-5.5-20260901']) assert.equal(resolve(model), model);
  assert.equal(createModelAliasResolver({ toString: 'safe' })('toString'), 'safe');
  assert.equal(createModelAliasResolver({})('constructor'), 'constructor');
  const parsed = JSON.parse('{"__proto__":"safe"}');
  assert.equal(createModelAliasResolver(parsed)('__proto__'), 'safe');
});

test('projection conserves priced totals and components in every period, client, session and device', () => {
  const stats = { periods: { today: period, month: period, allTime: period }, devices: [{ deviceId: 'one', periods: { today: period } }], allTimeSessionsView: period.sessions, nativeSessions: { today: period.sessions }, nativeProjects: { today: period.projects }, limits: { providers: [{ provider: 'anthropic', model: 'anthropic/claude-opus-5' }] } };
  const before = structuredClone(stats);
  const projected = projectModelAliasStats(stats, aliases);
  for (const row of [...Object.values(projected.periods), projected.devices[0].periods.today]) {
    assert.deepEqual(row.models, { 'claude-opus-5': 70, 'gpt-5.5-pro': 30 });
    assert.deepEqual(row.modelCosts, { 'claude-opus-5': 3, 'gpt-5.5-pro': 4 });
    assert.deepEqual([row.modelCacheReads, row.modelCacheWrites, row.modelOutputs, row.modelUnclassifiedTokens], [{ 'claude-opus-5': 7 }, { 'claude-opus-5': 3 }, { 'claude-opus-5': 14 }, { 'claude-opus-5': 3 }]);
    assert.deepEqual(row.clientModels.claude, { 'claude-opus-5': 60 });
    assert.deepEqual(row.clientModelCosts.claude, { 'claude-opus-5': 3 });
    assert.deepEqual(row.sessions.s1.models, { 'claude-opus-5': 40 });
    assert.deepEqual(row.projects.p1.models, { 'claude-opus-5': 70 });
    assert.deepEqual([row.totalTokens, row.costUsd, row.clients, row.clientCosts], [100, 7, period.clients, period.clientCosts]);
  }
  assert.deepEqual(projected.allTimeSessionsView.s1.models, { 'claude-opus-5': 40 });
  assert.deepEqual(projected.nativeSessions.today.s1.models, { 'claude-opus-5': 40 });
  assert.deepEqual(projected.nativeProjects.today.p1.models, { 'claude-opus-5': 70 });
  assert.deepEqual(projected.limits, stats.limits);
  assert.deepEqual(stats, before);
  assert.strictEqual(projectModelAliasStats(stats, {}), stats);
  assert.deepEqual(projectModelAliasStats(stats, { 'anthropic/claude-opus-5': 'separate' }).periods.today.models, { separate: 40, 'claude-opus-5': 30, 'gpt-5.5-pro': 30 });
});

test('historical daily/monthly/device buckets and favorite model are regrouped without repricing', () => {
  const perModel = { 'anthropic/claude-opus-5': { tokens: 40, cost: 2, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 2, unclassifiedTokens: 1 }, 'claude-opus-5': { tokens: 30, cost: 1, outputTokens: 6, cacheReadTokens: 3, cacheWriteTokens: 1, unclassifiedTokens: 2 }, rival: { tokens: 60, cost: 7 } };
  const row = { tokens: 130, cost: 10, perClient: { claude: { tokens: 130, cost: 10 } }, perModel };
  const history = { daily: [{ date: '2026-09-10', ...row }], monthly: [{ month: '2026-09', ...row }], summary: { totalTokens: 130, totalCost: 10, favoriteModel: 'rival' } };
  const raw = structuredClone(history);
  history.deviceHistories = [{ deviceId: 'one', history: raw }];
  const projected = projectModelAliasHistory(history, aliases);
  assert.deepEqual(projected.daily[0].perModel['claude-opus-5'], { tokens: 70, cost: 3, outputTokens: 14, cacheReadTokens: 7, cacheWriteTokens: 3, unclassifiedTokens: 3 });
  assert.deepEqual(projected.monthly[0].perModel, projected.daily[0].perModel);
  assert.equal(projected.summary.favoriteModel, 'claude-opus-5');
  assert.equal(projected.deviceHistories[0].history.summary.favoriteModel, 'claude-opus-5');
  assert.deepEqual([projected.summary.totalTokens, projected.summary.totalCost, projected.daily[0].perClient], [130, 10, row.perClient]);
  assert.deepEqual(history.daily, raw.daily);
});

test('preview without model attribution does not invent a favorite from a truncated daily window', () => {
  const preview = { daily: [{ date: '2026-09-10', tokens: 2, cost: 1 }], monthly: [], summary: { favoriteModel: 'anthropic/claude-opus-5' } };
  assert.equal(projectModelAliasHistory(preview, aliases).summary.favoriteModel, 'claude-opus-5');
  const stats = { periods: { allTime: period }, historyPreview: preview, historyRevision: 'raw', deviceHistoryRevision: 'devices' };
  const projected = projectModelAliasStats(stats, aliases);
  assert.notEqual(projected.historyRevision, 'raw');
  assert.notEqual(projected.deviceHistoryRevision, 'devices');
  assert.equal(stats.historyRevision, 'raw');
});

test('fixed-range device histories project their live overlay periods as well as archived rows', () => {
  const history = { daily: [], monthly: [], summary: {}, deviceHistories: [{ deviceId: 'one', periods: { today: period }, history: null }] };
  const projected = projectModelAliasHistory(history, aliases);
  assert.deepEqual(projected.deviceHistories[0].periods.today.models, { 'claude-opus-5': 70, 'gpt-5.5-pro': 30 });
  assert.equal(projected.deviceHistories[0].history, null);
  assert.strictEqual(history.deviceHistories[0].periods.today, period);
});

test('merging a legacy unknown component bucket cannot turn its tokens into known input', () => {
  const history = { daily: [{ date: '2026-09-10', tokens: 70, perModel: { alias: { tokens: 20, cost: 2 }, canonical: { tokens: 50, cost: 3, outputTokens: 10, unclassifiedTokens: 0 } } }], monthly: [], summary: {} };
  const projected = projectModelAliasHistory(history, { alias: 'canonical' });
  assert.deepEqual(projected.daily[0].perModel.canonical, { tokens: 70, cost: 5, outputTokens: 10, unclassifiedTokens: 20 });
});

test('prototype-like canonical IDs remain ordinary grouped model names in history', () => {
  const history = { daily: [], monthly: [{ month: '2026-09', perModel: { alias: { tokens: 70, cost: 5, unclassifiedTokens: 0 }, rival: { tokens: 60, cost: 1 } } }], summary: { totalTokens: 130, totalCost: 6, favoriteModel: 'rival' } };
  const projected = projectModelAliasHistory(history, { alias: '__proto__' });
  assert.equal(projected.summary.favoriteModel, '__proto__');
  assert.deepEqual(Object.keys(projected.monthly[0].perModel), ['__proto__', 'rival']);
});
