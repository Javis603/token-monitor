'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const presentation = require('../../src/electron/modelAliasPresentation');
const { inUseModelIds } = require('../../src/electron/renderer/customPricingForm');
const { classifySettingsChange } = require('../../src/electron/runtimeConfig');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const aliases = { 'anthropic/claude-opus-5': 'claude-opus-5' };
function mainFunction(name, dependencies) {
  const body = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(body);
  return vm.runInNewContext(`(${body})`, { ...presentation, ...dependencies });
}

test('Electron presentation applies aliases after limit projection without changing cached stats', () => {
  const raw = { periods: { today: { models: { 'anthropic/claude-opus-5': 20, 'claude-opus-5': 30 }, modelCosts: { 'anthropic/claude-opus-5': 8, 'claude-opus-5': 1 }, totalTokens: 50, costUsd: 9 } } };
  const settings = { modelAliases: aliases };
  const project = mainFunction('electronPresentationStats', { settings, mode: 'local', projectLimitStatsForDisplay: (stats) => stats });
  assert.deepEqual(project(raw).periods.today.models, { 'claude-opus-5': 50 });
  assert.equal(project(raw).periods.today.costUsd, 9);
  settings.modelAliases = {};
  assert.deepEqual(project(raw).periods.today.models, { 'claude-opus-5': 50 });
  assert.equal(raw.periods.today.models['anthropic/claude-opus-5'], 20);
});

test('complete dashboard history uses local mappings for offline and multi-device history', async () => {
  const raw = { daily: [{ date: '2026-09-10', perModel: { 'anthropic/claude-opus-5': { tokens: 20, cost: 8 }, 'claude-opus-5': { tokens: 30, cost: 1 } } }], monthly: [], summary: {} };
  const settings = { modelAliases: aliases };
  const getHistory = mainFunction('getDashboardHistory', { settings, historyResolverOptions: () => ({}), resolveCompleteHistoryWithDevices: async () => ({ history: raw, deviceHistories: [{ deviceId: 'one', history: raw }] }), getCompleteHistory: async () => raw, completeHistorySource: () => 'remote', fixedPeriodHistoryMeta: () => ({ source: 'remote' }) });
  const projected = await getHistory({ includeDevices: true });
  assert.deepEqual(projected.daily[0].perModel, { 'claude-opus-5': { tokens: 50, cost: 9, unclassifiedTokens: 50 } });
  assert.deepEqual(projected.deviceHistories[0].history.daily[0].perModel, projected.daily[0].perModel);
  settings.modelAliases = {};
  assert.deepEqual((await getHistory()).daily[0].perModel, {
    'claude-opus-5': { tokens: 50, cost: 9, unclassifiedTokens: 50 }
  });
});

test('custom pricing still offers original model IDs when reporting aliases are enabled', () => {
  const raw = { periods: { today: { models: { 'anthropic/claude-opus-5': 20, 'claude-opus-5': 30 } } } };
  assert.deepEqual(inUseModelIds(presentation.projectModelAliasStats(raw, aliases)), ['anthropic/claude-opus-5', 'claude-opus-5']);
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
    completeHistorySource: () => 'local', macWidgetPresentation: () => ({})
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
