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
  const tab = { dataset: { period: 'month', periodSlot: 'month' }, addEventListener(_type, callback) { activate = callback; } };
  let renders = 0;
  const noop = () => {};
  const start = source.indexOf("for (const tab of document.querySelectorAll('.tab'))");
  const end = source.indexOf('\nfor (const button of els.monthPeriodMenu', start);
  vm.runInNewContext(source.slice(start, end), { state, document: { querySelectorAll: () => [tab] },
    fixedPeriodRangesApi: { slotForSelection: value => value, normalizeMonthMode: () => 'month', supportsBreakdown: () => true },
    captureBreakdownMotion: noop, setPeriod: value => { state.period = value; return true; }, syncPeriodTabs: noop,
    setPeriodMenuOpen: noop, sessionRowsForPeriod: rowsForPeriod, render: () => { renders += 1; }, animateBreakdownFrom: noop });
  activate({ stopPropagation: noop });
  assert.equal(state.openSession.summary.key, 'session-group:cursor-grok-bot');
  assert.equal(state.openSession.summary.value, 50);
  assert.equal(state.openSession.period, 'month');
  tab.dataset = { period: 'allTime', periodSlot: 'allTime' };
  activate({ stopPropagation: noop });
  assert.equal(state.period, 'allTime');
  assert.equal(state.openSession, null, 'the remaining Codex group does not replace a missing Grok group');
  assert.equal(renders, 2);
});

test('stats repaint refreshes the open group by identity and retires a removed group', () => {
  const key = 'session-group:cursor-grok-bot';
  const state = { openSession: { kind: 'session-group', summary: rowsForPeriod(period(20)).find(row => row.sessionGroup === 'cursor-grok-bot') } };
  let rendered;
  let closed = false;
  const start = source.indexOf("    if (state.openSession.kind === 'session-group') {");
  const end = source.indexOf('    refreshSessionDetailHeading();', start);
  const repaint = Function('state', 'period', 'sessionRowsForPeriod', 'closeSessionDetail',
    'sessionTooltipShouldHoldRender', 'renderSessionGroupDetail', source.slice(start, end));
  const close = () => { closed = true; state.openSession = null; };
  repaint(state, period(80), rowsForPeriod, close, () => false, request => { rendered = request; });
  assert.equal(rendered.summary.key, key);
  assert.equal(rendered.summary.value, 80);
  repaint(state, period(100), rowsForPeriod, close, () => true, () => assert.fail('hover holds repaint'));
  assert.equal(state.openSession.summary.value, 100);
  repaint(state, period(0), rowsForPeriod, close, () => false, () => assert.fail('removed group must close'));
  assert.equal(closed, true);
  assert.equal(state.openSession, null);
});
