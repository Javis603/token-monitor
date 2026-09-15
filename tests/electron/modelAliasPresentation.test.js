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

test('empty or malformed alias settings are a no-op until automatic grouping is on', () => {
  const stats = { periods: { today: period } };
  for (const input of [undefined, null, [], 'x', {}, { x: 3, ' ': 'x', y: '' }]) {
    assert.deepEqual(normalizeModelAliases(input), {});
    assert.strictEqual(projectModelAliasStats(stats, input), stats);
    assert.deepEqual(projectModelAliasStats(stats, input, { grouping: 'duplicates' }).periods.today.models, {
      'claude-opus-5': 70,
      'gpt-5.5-pro': 30
    });
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
  assert.deepEqual(projectModelAliasStats(stats, {}, { grouping: 'duplicates' }).periods.today.models, { 'claude-opus-5': 70, 'gpt-5.5-pro': 30 });
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
  const perModel = { alias: { tokens: 70, cost: 5, unclassifiedTokens: 0 }, rival: { tokens: 60, cost: 1 } };
  const history = { daily: [{ date: '2026-09-10', perModel }], monthly: [{ month: '2026-09', perModel }], summary: { totalTokens: 130, totalCost: 6, favoriteModel: 'alias' } };
  const projected = projectModelAliasHistory(history, { alias: '__proto__' });
  assert.equal(projected.summary.favoriteModel, '__proto__');
  assert.deepEqual(Object.keys(projected.monthly[0].perModel), ['__proto__', 'rival']);
});

// mergeHistories() ranks summary.favoriteModel over its 370-day-capped daily tier
// while monthly stays uncapped, so a lifetime leader older than the cap is absent
// from the window that produced the stored value. daily and monthly agree here
// before the alias and disagree after it.
const divergentHistory = () => ({
  daily: [{ date: '2026-09-10', tokens: 130, perModel: { a: { tokens: 60 }, b: { tokens: 40 }, x: { tokens: 30 } } }],
  monthly: [
    { month: '2024-01', perModel: { a: { tokens: 100 } } },
    { month: '2026-09', perModel: { a: { tokens: 60 }, b: { tokens: 40 }, x: { tokens: 30 } } }
  ],
  summary: { totalTokens: 230, favoriteModel: 'a' }
});

test('an aggregate history takes its grouped leader from daily, not from uncapped monthly', () => {
  // aggregateHistory -> mergeHistories ranks the capped daily tier: b = 40 + 30 > a.
  assert.equal(projectModelAliasHistory(divergentHistory(), { x: 'b' }).summary.favoriteModel, 'b');
});

test('a device history keeps its stored leader when the capped and uncapped windows disagree', () => {
  // A device record is normalizeHistory (uncapped: a = 160 > b = 70) for one graph
  // source but mergeHistories (capped: b wins) for several, so neither window can be
  // assumed. Keep the stored leader rather than picking one of the two answers.
  const history = { daily: [], monthly: [], summary: {}, deviceHistories: [{ deviceId: 'one', history: divergentHistory() }] };
  assert.equal(projectModelAliasHistory(history, { x: 'b' }).deviceHistories[0].history.summary.favoriteModel, 'a');
  const stats = { devices: [{ deviceId: 'one', history: divergentHistory() }] };
  assert.equal(projectModelAliasStats(stats, { x: 'b' }).devices[0].history.summary.favoriteModel, 'a');
  // An alias that renames the stored leader still renames it inside a device history.
  assert.equal(projectModelAliasHistory(history, { a: 'anthropic/a' }).deviceHistories[0].history.summary.favoriteModel, 'anthropic/a');
});

test('an unrelated alias leaves the favorite model of a capped history alone', () => {
  const history = divergentHistory();
  const projected = projectModelAliasHistory(history, { 'totally/unrelated-model': 'whatever' });
  assert.equal(projected.summary.favoriteModel, 'a');
  assert.strictEqual(projected.summary, history.summary);
});

test('a compact preview only renames its stored leader and never ranks all-time models', () => {
  const stats = {
    periods: { allTime: { models: { x: 900, a: 10 } } },
    historyPreview: { daily: [{ date: '2026-09-10', tokens: 2 }], monthly: [], summary: { favoriteModel: 'a' } }
  };
  assert.equal(projectModelAliasStats(stats, { x: 'b' }).historyPreview.summary.favoriteModel, 'a');
  assert.equal(projectModelAliasStats(stats, { a: 'anthropic/a' }).historyPreview.summary.favoriteModel, 'anthropic/a');
});

test('a missing history revision stays missing so the Home signature keeps its preview fallback', () => {
  const stats = { periods: { allTime: period }, historyPreview: { daily: [{ date: '2026-09-10', tokens: 2 }], monthly: [], summary: {} } };
  const projected = projectModelAliasStats(stats, aliases);
  assert.ok(!('historyRevision' in projected), 'absent historyRevision must not be invented');
  assert.ok(!('deviceHistoryRevision' in projected), 'absent deviceHistoryRevision must not be invented');
  const decorated = projectModelAliasStats({ ...stats, historyRevision: 'raw' }, aliases);
  assert.ok(decorated.historyRevision.startsWith('raw:aliases:'));
  assert.notEqual(projectModelAliasStats({ ...stats, historyRevision: 'raw' }, { 'a/b': 'c' }).historyRevision, decorated.historyRevision);
});

test('an alias that matches nothing in the payload copies no part of the stats tree', () => {
  const unaliased = {
    totalTokens: 10, models: { 'gpt-5.5-pro': 10 }, modelCosts: { 'gpt-5.5-pro': 1 },
    clientModels: { opencode: { 'gpt-5.5-pro': 10 } },
    sessions: { s1: { models: { 'gpt-5.5-pro': 10 } } }
  };
  const history = { daily: [{ date: '2026-09-10', tokens: 10, perModel: { 'gpt-5.5-pro': { tokens: 10 } } }], monthly: [], summary: { favoriteModel: 'gpt-5.5-pro' } };
  const stats = {
    periods: { today: unaliased, allTime: unaliased },
    devices: [{ deviceId: 'one', periods: { today: unaliased }, history }],
    allTimeSessionsView: { s1: { models: { 'gpt-5.5-pro': 10 } } },
    nativeSessions: { today: { s1: { models: { 'gpt-5.5-pro': 10 } } } },
    historyRevision: 'raw'
  };
  const projected = projectModelAliasStats(stats, { 'anthropic/claude-opus-5': 'claude-opus-5' });
  assert.strictEqual(projected.periods, stats.periods);
  assert.strictEqual(projected.devices, stats.devices);
  assert.strictEqual(projected.allTimeSessionsView, stats.allTimeSessionsView);
  assert.strictEqual(projected.nativeSessions, stats.nativeSessions);
  // The root is the one object the projection must rebuild: it carries the
  // pricing-picker inventory and the decorated revision.
  assert.notStrictEqual(projected, stats);
  assert.deepEqual(projected.modelAliasSourceIds, ['gpt-5.5-pro']);
  assert.ok(projected.historyRevision.startsWith('raw:aliases:'));
});
