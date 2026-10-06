'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const policy = require('../../src/electron/usageCostPolicy');
const presentation = require('../../src/electron/modelAliasPresentation');
const titles = require('../../src/electron/sessionTitleDisplay');
const { createStatsPresentationCache } = require('../../src/electron/statsPublisher');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const rules = [{ client: 'codex', modelPrefix: 'chatgpt-web/', included: false }];
function mainFunction(name, dependencies) {
  const body = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(body);
  return vm.runInNewContext(`(${body})`, { ...policy, ...presentation, ...titles, ...dependencies });
}

test('tool preference rendering reacts independently to cost rules and custom scan paths', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const body = renderer.match(/function toolPreferenceRenderSignature\([^]*?\n\}/)?.[0];
  assert.ok(body);
  const state = { settings: {} };
  const signature = vm.runInNewContext(`(${body})`, {
    state,
    localClientStatus: () => ({}),
    localClientHealth: () => ({}),
    localDevice: () => ({ deviceId: 'local' }),
    enabledClientSet: () => new Set(['codex']),
    toolPreferenceQuery: () => '',
    KNOWN_CLIENTS: [{ id: 'codex' }]
  });
  const initial = signature();
  assert.equal(signature(), initial);
  state.settings.usageCostRules = rules;
  const costsChanged = signature();
  assert.notEqual(costsChanged, initial);
  state.settings.customScanPaths = { codex: ['/custom/sessions'] };
  const bothChanged = signature();
  assert.notEqual(bothChanged, costsChanged);
  state.settings.usageCostRules = [];
  assert.notEqual(signature(), bothChanged);
  assert.notEqual(signature(), initial);
  state.settings.customScanPaths = {};
  assert.equal(signature(), initial);
});

test('normalized cost rules remain available to the renderer settings UI', () => {
  const settings = { usageCostRules: policy.normalizeUsageCostRules(rules) };
  const project = mainFunction('settingsForRenderer', {
    settings,
    credentialSettingsForRenderer: () => ({}),
    getSyncContentRuntime: () => ({ status: () => ({}) }),
    rendererOmittedAccountKeys: () => [],
    trayMenuLocale: () => 'en',
    effectiveSubscriptions: () => [],
    subscriptionsAreShared: () => false,
    currentHubIdentity: () => '',
    subscriptionsDocumentFor: () => null,
    subscriptionDocumentVersion: () => null,
    pendingOrphanedSubscriptions: () => [],
    accountFieldProjection: () => ({}),
    codexAccountsForRenderer: () => [],
    antigravityAccountsForRenderer: () => [],
    mimoAccountsForRenderer: () => [],
    accountStatusProjection: () => ({}),
    limitAccountFormsForRenderer: () => ({}),
    effectiveRates: {},
    resolveEffectiveRates: () => ({}),
    rateCache: null,
    currentWindowToggleShortcutStatus: () => null,
    process: { env: {} }
  });
  assert.equal(JSON.stringify(project().usageCostRules), JSON.stringify(settings.usageCostRules));
});

test('main process projects cached stats and restoring the setting needs no rescan', () => {
  const raw = { periods: { today: { totalTokens: 100, costUsd: 9, clientCosts: { codex: 9 }, modelCosts: { 'chatgpt-web/pro': 9 }, clientModelCosts: { codex: { 'chatgpt-web/pro': 9 } } } } };
  const settings = { usageCostRules: rules };
  const project = mainFunction('electronPresentationStats', {
    settings,
    syncProvenanceActive: () => false,
    projectLimitStatsForDisplay: (stats) => stats,
    presentationCache: createStatsPresentationCache()
  });
  assert.equal(project(raw).periods.today.costUsd, 0);
  assert.equal(raw.periods.today.costUsd, 9);
  settings.usageCostRules = [];
  assert.equal(project(raw), raw);
});

test('cost rules match raw model IDs before display aliases are applied', () => {
  const raw = { periods: { today: { totalTokens: 100, costUsd: 9, clientCosts: { codex: 9 }, modelCosts: { 'chatgpt-web/extra-high': 9 }, clientModelCosts: { codex: { 'chatgpt-web/extra-high': 9 } } } } };
  const settings = {
    usageCostRules: [{ client: 'codex', modelPrefix: 'chatgpt-web/', included: true, models: { 'chatgpt-web/extra-high': false } }],
    modelAliases: { 'chatgpt-web/extra-high': 'web-extra-high' },
    modelAliasGrouping: 'off'
  };
  const project = mainFunction('electronPresentationStats', {
    settings,
    syncProvenanceActive: () => false,
    projectLimitStatsForDisplay: (stats) => stats,
    presentationCache: createStatsPresentationCache()
  });
  const result = project(raw);
  assert.equal(result.periods.today.costUsd, 0);
  assert.deepEqual(result.periods.today.modelCosts, { 'web-extra-high': 0 });
  assert.equal(raw.periods.today.costUsd, 9);
});

test('pulled all-time sessions use the same cost and alias projection', () => {
  const raw = {
    periods: {
      allTime: {
        sessions: {
          one: {
            client: 'codex',
            costUsd: 9,
            models: { 'chatgpt-web/pro': 100 },
            modelCosts: { 'chatgpt-web/pro': 9 }
          }
        }
      }
    }
  };
  const settings = {
    usageCostRules: rules,
    modelAliases: { 'chatgpt-web/pro': 'web-pro' },
    modelAliasGrouping: 'off'
  };
  const project = mainFunction('rendererAllTimeSessions', {
    settings,
    allTimeSessionsCache: createStatsPresentationCache(),
    completeLocalSyncStats: (stats) => stats,
    snapshotLocalDevices: new WeakMap(),
    mergedLocalAllTimeSessions: () => ({})
  });
  const sessions = project(raw);
  assert.equal(sessions.one.costUsd, 0);
  assert.deepEqual(sessions.one.models, { 'web-pro': 100 });
  assert.equal(raw.periods.allTime.sessions.one.costUsd, 9);
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

test('cost and title preferences independently reproject one cached snapshot and its all-time sessions', () => {
  const session = { client: 'codex', title: 'Private title', preview: 'Private preview',
    costUsd: 9, models: { 'chatgpt-web/pro': 100 }, modelCosts: { 'chatgpt-web/pro': 9 } };
  const period = { totalTokens: 100, costUsd: 9, clientCosts: { codex: 9 },
    modelCosts: { 'chatgpt-web/pro': 9 }, clientModelCosts: { codex: { 'chatgpt-web/pro': 9 } },
    sessions: { one: session } };
  const raw = { periods: { today: period, allTime: period } };
  const before = structuredClone(raw);
  const settings = { usageCostRules: rules, sessionTitlesEnabled: false,
    modelAliases: { 'chatgpt-web/pro': 'web-pro' }, modelAliasGrouping: 'off' };
  const dependencies = { settings, syncProvenanceActive: () => false,
    projectLimitStatsForDisplay: (stats) => stats, presentationCache: createStatsPresentationCache(),
    allTimeSessionsCache: createStatsPresentationCache(), completeLocalSyncStats: (stats) => stats,
    snapshotLocalDevices: new WeakMap() };
  const project = mainFunction('electronPresentationStats', dependencies);
  const pull = mainFunction('rendererAllTimeSessions', dependencies);
  for (const [included, visible] of [[false, false], [true, false], [true, true], [false, true]]) {
    settings.usageCostRules = included ? [] : rules;
    settings.sessionTitlesEnabled = visible;
    const shown = project(raw);
    const sessions = pull(raw);
    assert.equal(shown.periods.today.costUsd, included ? 9 : 0);
    assert.equal(sessions.one.costUsd, included ? 9 : 0);
    assert.equal(shown.periods.today.sessions.one.title, visible ? 'Private title' : undefined);
    assert.equal(sessions.one.preview, visible ? 'Private preview' : undefined);
    assert.deepEqual(sessions.one.models, { 'web-pro': 100 });
    assert.strictEqual(project(raw), shown);
  }
  assert.deepEqual(raw, before);
});
