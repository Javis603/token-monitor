'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { groupSessionRows, sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
function period(tokens) {
  const sessions = { 'codex:review': { client: 'codex', sessionId: 'review', sessionKind: 'background-review',
    totalTokens: 10, models: { 'gpt-5': 10 } } };
  if (tokens) sessions['cursor:sand-subagent-run'] = { client: 'cursor', sessionId: 'sand-subagent-run',
    totalTokens: tokens, models: { 'grok-bot-automation': tokens } };
  return { sessions };
}
const rowsForPeriod = value => groupSessionRows(sessionRowsForPeriod(value));

test('group activation resolves the clicked group when Codex and Grok coexist', () => {
  let activate;
  let rendered;
  const state = { breakdown: 'session', period: 'today', stats: { periods: { today: period(20) } } };
  const start = source.indexOf("els.breakdown.addEventListener('click',");
  const end = source.indexOf('\n});', start) + 4;
  vm.runInNewContext(source.slice(start, end), { state, els: { breakdown: {
    addEventListener(_type, handler) { activate = handler; }
  } }, sessionRowsForPeriod: rowsForPeriod, renderSessionGroupDetail(request) { rendered = request; } });
  for (const id of ['cursor-grok-bot', 'codex-auto-review']) {
    const key = `session-group:${id}`;
    activate({ target: { closest: () => ({ dataset: { key, sessionGroup: id } }) } });
    assert.equal(state.openSession.summary.key, key);
    assert.strictEqual(rendered, state.openSession);
  }
});

test('period switches keep the same group and return to Sessions when that group is absent', () => {
  const state = { period: 'today', stats: { periods: { today: period(20), month: period(50), allTime: period(0) } },
    openSession: { kind: 'session-group', summary: rowsForPeriod(period(20)).find(row => row.sessionGroup === 'cursor-grok-bot') } };
  let activate;
  const tab = { dataset: { period: 'month' } };
  const periodTabs = { addEventListener(_type, callback) { activate = callback; } };
  let renders = 0;
  const noop = () => {};
  // The tab handler and the open-session follow-up it shares with the range menu.
  const start = source.indexOf('function followOpenSessionToPeriod()');
  const end = source.indexOf('\nfor (const button of els.monthPeriodMenu', start);
  vm.runInNewContext(source.slice(start, end), { state, periodTabs, els: { monthPeriodTab: tab },
    fixedPeriodRangesApi: { slotForSelection: value => value, supportsBreakdown: () => true },
    pagedSessionsPending: () => false,
    currentNativeRangeSnapshot: () => null,
    captureBreakdownMotion: noop, setPeriod: value => { state.period = value; return true; }, syncPeriodTabs: noop,
    setPeriodMenuOpen: noop, sessionRowsForPeriod: rowsForPeriod, render: () => { renders += 1; },
    periodBreakdownMotionDuration: () => 800, animateBreakdownFrom: noop });
  activate({ target: { closest: () => tab }, stopPropagation: noop });
  assert.equal(state.openSession.summary.key, 'session-group:cursor-grok-bot');
  assert.equal(state.openSession.summary.value, 50);
  assert.equal(state.openSession.period, 'month');
  activate({ target: { closest: () => ({ dataset: { period: 'allTime' } }) }, stopPropagation: noop });
  assert.equal(state.period, 'allTime');
  assert.equal(state.openSession, null, 'the remaining Codex group does not replace a missing Grok group');
  assert.equal(renders, 2);
});

test('stats repaint refreshes the open group by identity and retires a removed group', () => {
  const key = 'session-group:cursor-grok-bot';
  const state = { openSession: { kind: 'session-group', summary: rowsForPeriod(period(20)).find(row => row.sessionGroup === 'cursor-grok-bot') } };
  let rendered;
  let closed = false;
  let pending = false;
  const start = source.indexOf("    if (state.openSession.kind === 'session-group') {");
  const end = source.indexOf('    refreshSessionDetailHeading();', start);
  const repaint = Function('state', 'period', 'sessionRowsForPeriod', 'closeSessionDetail',
    'sessionTooltipShouldHoldRender', 'renderSessionGroupDetail', 'pagedSessionsPending',
    source.slice(start, end));
  const close = () => { closed = true; state.openSession = null; };
  repaint(state, period(80), rowsForPeriod, close, () => false, request => { rendered = request; });
  assert.equal(rendered.summary.key, key);
  assert.equal(rendered.summary.value, 80);
  repaint(state, period(100), rowsForPeriod, close, () => true, request => { rendered = request; });
  assert.equal(rendered.summary.value, 100, 'hover no longer postpones group updates');
  assert.equal(state.openSession.summary.value, 100);
  pending = true;
  repaint(state, period(0), rowsForPeriod, close, () => false, request => { rendered = request; },
    () => pending);
  assert.equal(state.openSession.summary.value, 100, 'keep the open group while paging');
  const previousGroup = state.openSession;
  state.settings = { sessionTitlesEnabled: false };
  repaint(state, period(0), rowsForPeriod, close, () => false, () => assert.fail('cached titles must close'),
    () => pending);
  assert.equal(state.openSession, null);
  state.openSession = previousGroup;
  state.settings = { sessionTitlesEnabled: true };
  pending = false;
  repaint(state, period(0), rowsForPeriod, close, () => false, () => assert.fail('removed group must close'),
    () => pending);
  assert.equal(closed, true);
  assert.equal(state.openSession, null);
});

test('historical bot evidence refreshes in Today and Month without opening TOTAL', async () => {
  const { createAllTimeSessionsLoader } = require('../../src/electron/renderer/allTimeSessions');
  const { attachLocalPresentationNativeViews } = require('../../src/electron/syncDisplayStats');
  const { rendererStats } = require('../../src/electron/statsPublisher');
  const state = { breakdown: 'session', period: 'today', stats: { snapshot: { id: 1, source: 'local' } } };
  let history = {};
  const calls = [];
  let loader;
  const start = source.indexOf('function allTimeSessionsNeeded()');
  const end = source.indexOf('const allTimeSessions =', start);
  const needed = Function('state', 'allTimeSessions', 'isSettingsPanelOpen',
    `${source.slice(start, end)}; return allTimeSessionsNeeded;`)(state, { loaded: () => loader.loaded() }, () => false);
  loader = createAllTimeSessionsLoader({ currentSnapshot: () => state.stats.snapshot, needed,
    fetchSessions: id => { calls.push(id); return history; },
    onLoaded: () => { state.stats = loader.attach(state.stats); } });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  loader.ensure();
  await settle();
  assert.equal(loader.loaded(), true, 'the initial empty history is already loaded');
  const id = 'uuid-bot';
  const chat = { client: 'cursor', sessionId: id, totalTokens: 10, costUsd: 1, models: { 'claude-opus-5-5-medium': 10 } };
  const current = { sessions: { [`cursor:${id}`]: chat } };
  const past = { [`cursor:${id}`]: { ...chat, models: { 'grok-bot-default': 20 } } };
  for (const [index, selected] of ['today', 'month'].entries()) {
    state.period = selected;
    const stats = { snapshot: { id: index + 2, source: 'local' },
      periods: { today: current, month: current, allTime: {} } };
    attachLocalPresentationNativeViews(stats, { mode: 'local',
      lastCollectedDevice: { today: current, month: current, allTime: { sessions: past } } });
    state.stats = loader.attach(rendererStats(stats));
    loader.invalidate();
    loader.ensure();
    await settle();
    const rows = groupSessionRows(sessionRowsForPeriod(current, {
      sourcePeriods: state.stats.periods, grokBotSessionIds: state.stats.grokBotSessionIds
    }));
    assert.equal(rows[0].sessionGroup, 'cursor-grok-bot');
    assert.equal(rows[0].value, 10);
    assert.equal(rows[0].cost, 1);
    assert.equal(state.period, selected, 'no navigation was needed');
  }
  assert.deepEqual(calls, [1], 'DAY/MONTH stats updates never pull full history again');
  state.period = 'allTime';
  history = past;
  loader.ensure();
  await settle();
  assert.deepEqual(calls, [1, 3], 'TOTAL still refreshes its full list on demand');
  state.breakdown = 'tool';
  assert.equal(needed(), false, 'unrelated views do not refresh history');
  state.period = 'allTime';
  state.breakdown = 'project';
  assert.equal(needed(), true);
});




test('conflicting absent parents split a shared native identity into stable independently navigable groups', () => {
  const nativeSessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const at = new Date().toISOString();
  const sessions = {
    'codex:a': { client: 'codex', sessionId: 'a', nativeSessionId, parentSessionId: 'absent-a', totalTokens: 10, lastUsedAt: at },
    'codex:b': { client: 'codex', sessionId: 'b', nativeSessionId, parentSessionId: 'absent-b', totalTokens: 20, lastUsedAt: at },
    'codex:ca': { client: 'codex', sessionId: 'ca', parentSessionId: 'a', totalTokens: 30, lastUsedAt: at },
    'codex:cb': { client: 'codex', sessionId: 'cb', parentSessionId: 'b', totalTokens: 40, lastUsedAt: at }
  };
  const rows = rowsForPeriod({ sessions });
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map(row => row.key)).size, 2, 'DOM and detail lookup keys are distinct');
  const reversed = rowsForPeriod({ sessions: Object.fromEntries(Object.entries(sessions).reverse()) });
  assert.deepEqual(rows.map(row => row.key).sort(), reversed.map(row => row.key).sort(), 'input order does not affect identities');
  let activate;
  const state = { breakdown: 'session', period: 'month', stats: { periods: { month: { sessions } } } };
  const start = source.indexOf("els.breakdown.addEventListener('click',");
  const end = source.indexOf('\n});', start) + 4;
  vm.runInNewContext(source.slice(start, end), { state, els: { breakdown: { addEventListener(_event, callback) { activate = callback; } } },
    sessionRowsForPeriod: rowsForPeriod, renderSessionGroupDetail() {} });
  for (const row of rows) {
    activate({ target: { closest: () => ({ dataset: { key: row.key, sessionGroup: row.sessionGroup } }) } });
    assert.deepEqual(state.openSession.summary.groupRows.map(member => member.key), row.groupRows.map(member => member.key));
  }
  const dock = require('../../src/electron/renderer/edgeDock/presentation').recentSessionRows({ periods: { month: { sessions } } }, 100);
  assert.equal(new Set(dock.map(row => row.key)).size, 2, 'Dock expansion keys also remain distinct');
  assert.equal(dock.reduce((sum, row) => sum + row.totalTokens, 0), 100);
});

test('an open session follows a period change with that period\'s row cost', () => {
  const row = cost => ({ sessions: { 'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 10, costUsd: cost } } });
  const state = { period: 'last7', stats: { periods: { month: row(20), last7: row(3) } },
    openSession: { kind: 'session', client: 'claude', sessionId: 's1', sessionCost: 20, period: 'month' } };
  const opened = [];
  const start = source.indexOf('function followOpenSessionToPeriod()');
  const end = source.indexOf("periodTabs.addEventListener('click'", start);
  const sessionStart = source.indexOf('function sessionLiveStatsEntry(');
  const sessionEnd = source.indexOf('function sessionDetailLiveSignature(', sessionStart);
  const context = { state, displayedSessions: key => state.stats?.periods?.[key]?.sessions,
    fixedPeriodRangesApi: { supportsBreakdown: () => true },
    pagedSessionsPending: () => false,
    currentNativeRangeSnapshot: () => ({ range: {} }), sessionRowsForPeriod: rowsForPeriod,
    openSessionDetail: request => opened.push(request) };
  vm.runInNewContext(`${source.slice(sessionStart, sessionEnd)}\n${source.slice(start, end)}\nglobalThis.follow = followOpenSessionToPeriod;`, context);
  context.follow();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].sessionCost, 3);
  assert.equal(opened[0].returnTo, null);
  // A destination without the row carries no cost over from the old period.
  state.stats.periods.last7 = { sessions: {} };
  context.follow();
  assert.equal(opened[1].sessionCost, 0);
});

test('a group follows Today to Month while paged rows are unresolved', () => {
  const summary = { key: 'session-group:example' };
  const state = { period: 'month', stats: { periods: { month: { sessions: {} } } },
    openSession: { kind: 'session-group', period: 'today', summary } };
  const start = source.indexOf('function followOpenSessionToPeriod()');
  const end = source.indexOf("periodTabs.addEventListener('click'", start);
  const context = { state, fixedPeriodRangesApi: { supportsBreakdown: () => true },
    currentNativeRangeSnapshot: () => null, sessionRowsForPeriod: () => [],
    pagedSessionsPending: () => true };
  vm.runInNewContext(source.slice(start, end), context);
  context.followOpenSessionToPeriod();
  assert.equal(state.openSession.period, 'month');
  assert.equal(state.openSession.summary, summary);
});

test('paged groups can wait only for an available request or a scheduled retry', () => {
  const start = source.indexOf('function pagedSessionsPending()');
  const end = source.indexOf('\nfunction ', start + 1);
  const state = {};
  let key = '';
  const context = {
    state, needsPagedSessions: () => true, syncedFixedPeriodKey: () => key,
    window: { tokenMonitor: { getSyncedFixedPeriod() {} } }
  };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.pagedSessionsPending(), false, 'a Hub with no revision cannot start paging');
  key = 'month';
  assert.equal(context.pagedSessionsPending(), true, 'the destination read can start');
  state.syncedFixedPeriod = { key, pending: false, retryAt: Date.now() + 1000 };
  assert.equal(context.pagedSessionsPending(), true, 'a scheduled retry can still resolve the group');
  state.syncedFixedPeriod.retryAt = Infinity;
  assert.equal(context.pagedSessionsPending(), false, 'an exhausted retry must close the missing group');
});

test('an unrelated range revision cannot keep a Today group open in Month', () => {
  const state = {
    breakdown: 'session', period: 'month',
    stats: {
      snapshot: { id: 1, source: 1 }, periods: { month: { sessions: {} } },
      sessionDetailsOmitted: { month: 1 }, fixedRangeRevisions: { complete: 'rev-1' },
      devices: [
        { deviceId: 'legacy', sessionDetailsOmitted: { month: 1 }, periodWindows: { today: { key: '2026-11-25' } } },
        { deviceId: 'complete', periodWindows: { today: { key: '2026-11-25' } } }
      ]
    }
  };
  const extract = name => source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
  const context = {
    state, currentNativeRangeSnapshot: () => null, sessionRowsForPeriod: () => [],
    currentCalendarLocale: () => 'en-GB', fixedPeriodTodayKey: () => '2026-11-25',
    fixedPeriodRangesApi: { isDerived: () => false, supportsBreakdown: () => true, deviceDayState: () => null },
    window: { tokenMonitor: { getSyncedFixedPeriod() {} } }
  };
  vm.runInNewContext(['syncedFixedPeriodKey', 'syncedFixedPeriodScope', 'needsPagedSessions', 'pagedSessionsPending', 'followOpenSessionToPeriod']
    .map(extract).join('\n'), context);
  const todayGroup = { kind: 'session-group', period: 'today', summary: { key: 'session-group:example' } };
  state.openSession = todayGroup;
  assert.equal(context.syncedFixedPeriodKey(), '', 'the complete device has no missing rows to page');
  context.followOpenSessionToPeriod();
  assert.equal(state.openSession, null);
  state.stats.fixedRangeRevisions.complete = 'rev-2';
  assert.equal(context.pagedSessionsPending(), false);

  state.stats.fixedRangeRevisions.legacy = 'rev-3';
  state.openSession = todayGroup;
  assert.equal(context.pagedSessionsPending(), true);
  context.followOpenSessionToPeriod();
  assert.equal(state.openSession.period, 'month');
});
