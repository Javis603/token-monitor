'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

test('native periods a History fallback replaced keep the session title policy', () => {
  const start = source.indexOf('let localSessionActivity = null;');
  const end = source.indexOf('\nfunction render(', start);
  const titled = { sessions: { 'claude:s': { client: 'claude', sessionId: 's', title: 'Private title', totalTokens: 1 } } };
  const state = { settings: { sessionTitlesEnabled: false }, stats: { periods: { last7: { derived: true } } } };
  const context = { state, window: { TokenMonitorSessionTitleDisplay: require('../../src/electron/sessionTitleDisplay') } };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.saved = replacedNativeRangePeriods;\nglobalThis.restore = statsWithNativeRangePeriods;\nglobalThis.derive = replaceDerivedStats;`, context);
  context.saved.set(state.stats, { last7: titled });

  context.derive({ periods: { last7: { derived: true } } });
  const restored = context.restore(state.stats).periods.last7;
  assert.equal(restored.sessions['claude:s'].title, undefined);
  assert.equal(restored.sessions['claude:s'].totalTokens, 1);
});

test('changing the default range in Settings moves an open session detail with it', async () => {
  const start = source.indexOf('async function saveDefaultUsageRange(');
  const end = source.indexOf('\n}\n', start) + 2;
  const calls = [];
  const state = { settings: {}, period: 'last7' };
  const context = {
    state,
    fixedPeriodRangesApi: { normalizeMonthMode: (value) => value, slotForSelection: () => 'month' },
    setPeriod: (value) => { calls.push(`set:${value}`); state.period = value; return true; },
    followOpenSessionToPeriod: () => calls.push('follow'),
    syncPeriodTabs: () => {},
    render: () => calls.push('render'),
    saveSettings: async () => {}
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.save = saveDefaultUsageRange;`, context);
  await context.save('last30');
  assert.deepEqual(calls, ['set:last30', 'follow', 'render']);
});
