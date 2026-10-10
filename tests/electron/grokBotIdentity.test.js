'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { grokBotSessionIdsForMaps, groupSessionRows, sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');
const { attachLocalNativeViews, attachLocalPresentationNativeViews, composeLocalSyncSummary } = require('../../src/electron/syncDisplayStats');
const { rendererStats } = require('../../src/electron/statsPublisher');
const { projectModelAliasStats } = require('../../src/electron/modelAliasPresentation');

function chat(id, model = 'claude-opus-5-5-medium') {
  return { client: 'cursor', sessionId: id, totalTokens: 10, costUsd: 0.1, models: { [model]: 10 } };
}

function statsWith(sessions) {
  return { periods: { today: { sessions }, month: { sessions }, allTime: { sessions: {} } } };
}

test('compact bot identity uses current candidates only and caches immutable snapshot maps', () => {
  const current = { 'cursor:bot': chat('bot'), 'cursor:ordinary': chat('ordinary'),
    'cursor:sand-subagent-run': chat('sand-subagent-run'),
    'codex:bot': { ...chat('bot'), client: 'codex' } };
  const old = { 'cursor:bot': chat('bot', 'grok-bot-default'),
    'cursor:inactive': chat('inactive', 'grok-bot-default') };
  let reads = 0;
  const history = new Proxy(old, {
    ownKeys() { assert.fail('history must not be enumerated'); },
    get(target, key) { reads += 1; return target[key]; }
  });
  const ids = grokBotSessionIdsForMaps([current], [history]);
  assert.deepEqual(ids.sort(), ['bot', 'sand-subagent-run']);
  assert.equal(reads, 2);
  assert.strictEqual(grokBotSessionIdsForMaps([current], [history]), ids);
  assert.equal(reads, 2, 'a repaint does not repeat historical lookups');
  assert.deepEqual(grokBotSessionIdsForMaps([current], [{}]), ['sand-subagent-run'], 'new history invalidates cached evidence');
  const newer = { ...current, 'cursor:new': chat('new', 'grok-bot-cua') };
  assert.deepEqual(grokBotSessionIdsForMaps([newer], [history]).sort(), ['bot', 'new', 'sand-subagent-run']);
});

test('bounded bot identity survives renderer IPC, aliases and a source switch without changing accounting', () => {
  const sessions = { 'cursor:bot': chat('bot'), 'cursor:ordinary': chat('ordinary'),
    'cursor:direct': chat('direct', 'grok-bot-default') };
  const stats = statsWith(sessions);
  const device = { periods: { allTime: { sessions: { 'cursor:bot': chat('bot', 'grok-bot-default') } } } };
  const before = JSON.stringify({ sessions, device });
  attachLocalNativeViews(stats, device);
  const visible = rendererStats(projectModelAliasStats(stats, { 'claude-opus-5-5-medium': 'Claude', 'grok-bot-default': 'Claude' }));
  assert.equal(visible.periods.allTime.sessions, undefined);
  assert.deepEqual(visible.grokBotSessionIds.sort(), ['bot', 'direct']);
  const rows = groupSessionRows(sessionRowsForPeriod(visible.periods.today, visible));
  assert.equal(rows.find(row => row.sessionGroup === 'cursor-grok-bot').value, 20);
  assert.equal(rows.reduce((sum, row) => sum + row.cost, 0), 0.30000000000000004);
  assert.equal(JSON.stringify({ sessions, device }), before);
  // A prior TOTAL pull must not reintroduce another source's evidence.
  const switched = statsWith({ 'cursor:bot': chat('bot') });
  switched.grokBotSessionIds = ['bot'];
  attachLocalPresentationNativeViews(switched, { mode: 'client', seededLocalDevice: device });
  assert.deepEqual(switched.grokBotSessionIds, []);
  const ordinary = sessionRowsForPeriod(switched.periods.today, {
    grokBotSessionIds: switched.grokBotSessionIds,
    sourcePeriods: { allTime: device.periods.allTime }
  });
  assert.equal(ordinary[0].grokBot, undefined);
});

test('100,000 historical sessions require only current Cursor lookups, no completion or history IPC', () => {
  const history = {};
  for (let index = 0; index < 100_000; index += 1) {
    history[`cursor:old-${index}`] = chat(`old-${index}`, 'grok-bot-default');
  }
  const current = { 'cursor:old-12345': chat('old-12345'), 'cursor:ordinary': chat('ordinary') };
  let reads = 0;
  let enumerations = 0;
  const guarded = new Proxy(history, {
    // The existing tray activity projection scans this source once. Grouping
    // must not add another full scan or trigger lazy summary completion.
    ownKeys(target) { enumerations += 1; return Reflect.ownKeys(target); },
    get(target, key) { reads += 1; return target[key]; }
  });
  const local = { deviceId: 'local', today: { sessions: current }, month: { sessions: current },
    allTime: { sessions: guarded } };
  const summary = composeLocalSyncSummary(null, local);
  assert.equal(reads, 100_002, 'only two bot lookups beyond the existing tray scan');
  assert.equal(enumerations, 1);
  const visible = rendererStats(summary);
  assert.deepEqual(visible.grokBotSessionIds, ['old-12345']);
  assert.ok(JSON.stringify(visible).length < 10_000, 'IPC does not include historical rows');
  assert.deepEqual(summary.periods.allTime.sessions, {});
  for (let index = 0; index < 10; index += 1) {
    const rows = groupSessionRows(sessionRowsForPeriod(visible.periods.today, visible));
    assert.equal(rows.find(row => row.sessionGroup === 'cursor-grok-bot').value, 10);
  }
  // Also exercise the fallback API with a full source map: no full scan.
  sessionRowsForPeriod(visible.periods.today, { sourcePeriods: { allTime: { sessions: guarded } } });
  assert.equal(reads, 100_004);
  assert.equal(enumerations, 1, 'renderer grouping never enumerates the history');
});

test('TOTAL derives inactive bot rows from its own sessions while current identity remains bounded', () => {
  const stats = statsWith({ 'cursor:current': chat('current') });
  stats.periods.allTime.sessions = { 'cursor:inactive': chat('inactive', 'grok-bot-default'),
    'cursor:ordinary': chat('ordinary') };
  attachLocalNativeViews(stats, null);
  assert.deepEqual(stats.grokBotSessionIds, []);
  const rows = groupSessionRows(sessionRowsForPeriod(stats.periods.allTime, stats));
  assert.equal(rows.find(row => row.sessionGroup === 'cursor-grok-bot').value, 10);
  assert.equal(rows.find(row => row.key === 'session:cursor:ordinary').value, 10);
});
