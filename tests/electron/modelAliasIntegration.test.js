'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const presentation = require('../../src/electron/modelAliasPresentation');
const { inUseModelIds } = require('../../src/electron/renderer/customPricingForm');
const { upsertModelAliasBatch } = require('../../src/electron/renderer/modelAliases');
const { classifySettingsChange } = require('../../src/electron/runtimeConfig');
const { createStatsPresentationCache } = require('../../src/electron/statsPublisher');
const { normalizePeriod } = require('../../src/shared/usage');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const aliases = { 'anthropic/claude-opus-5': 'claude-opus-5' };
function mainFunction(name, dependencies) {
  const body = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(body);
  return vm.runInNewContext(`(${body})`, { ...presentation, ...require('../../src/electron/sessionDeviceSources'), ...dependencies });
}

test('saved first-party aliases still apply after persisted period normalization', () => {
  for (const label of ['Work model', 'GPT 5']) {
    const aliases = { 'openai/gpt-5': label, 'openrouter/gpt-5': 'Router model' };
    const before = JSON.stringify(aliases);
    const period = normalizePeriod({ totalTokens: 150, models: { 'openai/gpt-5': 100, gpt_5: 50 } });
    const stats = { periods: { today: period } };
    for (const grouping of ['off', 'duplicates', 'prefix']) {
      const projected = presentation.projectModelAliasStats(stats, aliases, { grouping });
      assert.equal(projected.periods.today.models[label], 150);
      assert.equal(period.models['gpt-5'], 100, 'presentation does not change canonical accounting');
      const preferred = presentation.projectModelAliasStats(stats, { ...aliases, 'gpt-5': 'Current name' }, { grouping });
      assert.equal(preferred.periods.today.models['Current name'], 150, 'direct canonical alias wins');
    }
    assert.equal(presentation.projectModelAliasStats(stats, { 'openrouter/gpt-5': 'Router model' }).periods.today, period);
    const history = { daily: [{ date: '2026-07-18', perModel: { 'gpt-5': { tokens: 100 } } }] };
    assert.equal(presentation.projectModelAliasHistory(history, aliases).daily[0].perModel[label].tokens, 100);
    assert.equal(JSON.stringify(aliases), before, 'saved preferences remain unchanged');
  }
  const stats = { periods: { today: normalizePeriod({ totalTokens: 10, models: { 'openai/gpt-5.5': 10 } }) } };
  assert.equal(presentation.projectModelAliasStats(stats, { 'openai/gpt-5-5': 'GPT 5.5' }).periods.today.models['GPT 5.5'], 10);
});

test('Electron presentation applies aliases after limit projection without changing cached stats', () => {
  const raw = { periods: { today: { models: { 'anthropic/claude-opus-5': 20, 'claude-opus-5': 30 }, modelCosts: { 'anthropic/claude-opus-5': 8, 'claude-opus-5': 1 }, totalTokens: 50, costUsd: 9 } } };
  const settings = { modelAliases: aliases, modelAliasGrouping: 'off' };
  const project = mainFunction('electronPresentationStats', {
    settings,
    // The projection reads its own sync state now rather than the `mode`
    // variable, so the sandbox stands in for the helper instead.
    syncProvenanceActive: () => false,
    projectLimitStatsForDisplay: (stats) => stats,
    presentationCache: createStatsPresentationCache()
  });
  assert.deepEqual(project(raw).periods.today.models, { 'claude-opus-5': 50 });
  assert.equal(project(raw).periods.today.costUsd, 9);
  // Every reader of one published snapshot shares a single projection.
  assert.equal(project(raw), project(raw));
  settings.modelAliases = {};
  assert.deepEqual(project(raw).periods.today.models, { 'anthropic/claude-opus-5': 20, 'claude-opus-5': 30 });
  settings.modelAliasGrouping = 'duplicates';
  assert.deepEqual(project(raw).periods.today.models, { 'claude-opus-5': 50 });
  assert.equal(raw.periods.today.models['anthropic/claude-opus-5'], 20);
});

test('complete dashboard history uses local mappings for offline and multi-device history', async () => {
  const raw = { daily: [{ date: '2026-09-10', perModel: { 'anthropic/claude-opus-5': { tokens: 20, cost: 8 }, 'claude-opus-5': { tokens: 30, cost: 1 } } }], monthly: [], summary: {} };
  const settings = { modelAliases: aliases, modelAliasGrouping: 'off' };
  const getHistory = mainFunction('getDashboardHistory', { settings, historyResolverOptions: () => ({}), resolveCompleteHistoryWithDevices: async () => ({ history: raw, deviceHistories: [{ deviceId: 'one', history: raw }] }), getCompleteHistory: async () => raw, completeHistorySource: () => 'remote', fixedPeriodHistoryMeta: () => ({ source: 'remote' }) });
  const projected = await getHistory({ includeDevices: true });
  assert.deepEqual(projected.daily[0].perModel, { 'claude-opus-5': { tokens: 50, cost: 9, unclassifiedTokens: 50 } });
  assert.deepEqual(projected.deviceHistories[0].history.daily[0].perModel, projected.daily[0].perModel);
  // Clearing the manual alias stops the grouping; turning automatic grouping on
  // restores it from the duplicate evidence in the same history.
  settings.modelAliases = {};
  assert.deepEqual((await getHistory()).daily[0].perModel, raw.daily[0].perModel);
  settings.modelAliasGrouping = 'duplicates';
  assert.deepEqual((await getHistory()).daily[0].perModel, {
    'claude-opus-5': { tokens: 50, cost: 9, unclassifiedTokens: 50 }
  });
});

test('custom pricing still offers original model IDs when reporting aliases are enabled', () => {
  const raw = { periods: { today: { models: { 'anthropic/claude-opus-5': 20, 'claude-opus-5': 30 } } } };
  assert.deepEqual(inUseModelIds(presentation.projectModelAliasStats(raw, aliases)), ['anthropic/claude-opus-5', 'claude-opus-5']);
});

test('multiple aliases share a display target while costs and pricing IDs remain tied to source usage', () => {
  const modelAliases = upsertModelAliasBatch({}, ['provider/a', 'provider/b'], 'canonical');
  const period = { models: { 'provider/a': 20, 'provider/b': 30, canonical: 10 }, modelCosts: { 'provider/a': 8, 'provider/b': 1, canonical: 2 }, totalTokens: 60, costUsd: 11 };
  const raw = { periods: { today: period }, devices: [{ periods: { today: period } }] };
  const projected = presentation.projectModelAliasStats(raw, modelAliases, { grouping: 'off' });
  assert.deepEqual(projected.periods.today.models, { canonical: 60 });
  assert.deepEqual(projected.periods.today.modelCosts, { canonical: 11 });
  assert.deepEqual(projected.devices[0].periods.today.models, { canonical: 60 });
  assert.equal(projected.periods.today.costUsd, 11);
  assert.deepEqual(inUseModelIds(projected), ['canonical', 'provider/a', 'provider/b']);
  assert.deepEqual(raw.periods.today.models, { 'provider/a': 20, 'provider/b': 30, canonical: 10 });
});

test('model alias settings do not restart collection, sync or limits runtimes', () => {
  const changes = classifySettingsChange({ modelAliases: {} }, { modelAliases: aliases });
  for (const field of ['modeStructural', 'usageStructural', 'sinkStructural', 'limitsReconfigure']) assert.equal(changes[field], false);
  assert.deepEqual(changes.limitScopes, []);
});

test('native widget work freezes the alias choice and projects independently resolved history', () => {
  const settings = { modelAliases: { ...aliases } };
  const capture = mainFunction('captureMacWidgetWork', {
    settings, macWidgetConfiguration: () => ({ snapshotPath: '/fixture/snapshot.json', widgetKind: 'fixture' }),
    macWidgetDemand: null, historyResolverOptions: () => ({}), macWidgetHistorySourceKey: () => 'local',
    completeHistorySource: () => 'local', macWidgetActiveCodexAccount: () => null,
    macWidgetPresentation: () => ({})
  });
  const work = capture({ stats: {}, owner: { epoch: 1 } });
  settings.modelAliases['anthropic/claude-opus-5'] = 'changed';
  assert.equal(work.modelAliases?.['anthropic/claude-opus-5'], 'claude-opus-5');
  assert.equal(Object.isFrozen(work.modelAliases), true);
  const controller = mainFunction('ensureMacWidgetSnapshotController', {
    macWidgetRuntimeSupported: () => true, macWidgetSnapshotController: null, macWidgetPublicationReady: true,
    captureMacWidgetWork: capture, createMacWidgetSnapshotController: (options) => options,
    discardMacWidgetSnapshot: () => {}, prepareMacWidgetSnapshotUpdate: (_stats, options) => options.snapshotOptions
  })();
  const history = { daily: [{ perModel: { 'anthropic/claude-opus-5': { tokens: 20, cost: 8, unclassifiedTokens: 0 } } }], monthly: [], summary: {} };
  const prepared = controller.prepareSnapshot(work, history);
  assert.deepEqual(prepared.history.daily[0].perModel, { 'claude-opus-5': { tokens: 20, cost: 8, unclassifiedTokens: 0 } });
  assert.equal(history.daily[0].perModel['anthropic/claude-opus-5'].cost, 8);
});
