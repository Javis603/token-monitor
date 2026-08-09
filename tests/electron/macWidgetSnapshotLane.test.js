'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');

function functionSource(name, nextName) {
  const start = mainSource.indexOf(`function ${name}(`);
  const end = mainSource.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} should precede ${nextName}`);
  return mainSource.slice(start, end);
}

function history(label) {
  return { daily: [], monthly: [], summary: { label } };
}

test('the history source key and fetch use one immutable resolver config', async () => {
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  let currentConfig = { source: 'hub-a' };
  const context = vm.createContext({
    completeHistorySource: () => 'remote',
    historyResolverOptions: () => currentConfig,
    hubModeGeneration: 1,
    macWidgetHistorySourceKey: (config) => config.source,
    resolveCompleteHistory: async (config) => config.source,
    resolveMacWidgetHistory: async (options) => {
      await fetchGate;
      return options.fetchHistory();
    }
  });
  vm.runInContext([
    functionSource('getCompleteHistory', 'getMacWidgetHistory'),
    functionSource('getMacWidgetHistory', 'scheduleMacWidgetSnapshot')
  ].join('\n'), context);

  const pending = vm.runInContext("getMacWidgetHistory({ historyRevision: 'r1' })", context);
  currentConfig = { source: 'hub-b' };
  releaseFetch();
  const result = await pending;

  assert.equal(result?.history ?? result, 'hub-a');
  assert.equal(result.sourceToken.sourceKey, 'hub-a');
});

test('a superseded history result never publishes before the queued source', async () => {
  let releaseHubA;
  let markHubAStarted;
  let markHubBPublished;
  const hubAStarted = new Promise((resolve) => { markHubAStarted = resolve; });
  const hubBPublished = new Promise((resolve) => { markHubBPublished = resolve; });
  const published = [];
  const context = vm.createContext({
    compactNumbers: true,
    console: { warn() {} },
    effectiveRates: {},
    getMacWidgetHistory: async (stats) => {
      const sourceToken = { generation: context.hubModeGeneration };
      if (stats.source === 'hub-a') {
        markHubAStarted();
        await new Promise((resolve) => { releaseHubA = resolve; });
      }
      return { history: history(stats.source), sourceToken };
    },
    macWidgetConfiguration: () => ({ snapshotPath: '/tmp/snapshot', widgetKind: 'TokenMonitorWidget' }),
    macWidgetHistorySourceIsCurrent: (token) => token.generation === context.hubModeGeneration,
    normalizeCurrency: (value) => value,
    process: { platform: 'darwin' },
    requestMacWidgetReload() {},
    setImmediate,
    settings: { currency: 'USD' },
    updateMacWidgetSnapshot: async (_stats, options) => {
      const value = options.snapshotOptions.history;
      const label = value.summary?.label || value.history?.summary?.label;
      published.push(label);
      if (label === 'hub-b') markHubBPublished();
      return { ok: true, changed: true };
    }
  });
  vm.runInContext(`
    let pendingMacWidgetStats = null;
    let macWidgetWriteInFlight = false;
    let hubModeGeneration = 1;
    ${functionSource('scheduleMacWidgetSnapshot', 'sendPush')}
  `, context);

  vm.runInContext("scheduleMacWidgetSnapshot({ source: 'hub-a' })", context);
  await hubAStarted;
  vm.runInContext(`
    hubModeGeneration = 2;
    scheduleMacWidgetSnapshot({ source: 'hub-b' });
  `, context);
  context.hubModeGeneration = 2;
  releaseHubA();
  await hubBPublished;

  assert.deepEqual(published, ['hub-b']);
});
