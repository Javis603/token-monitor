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
