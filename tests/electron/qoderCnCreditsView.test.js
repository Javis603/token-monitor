'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { summarizeQoderCnCredits } = require('../../src/shared/providers/qodercn/creditUsage');
const { MESSAGES, translate } = require('../../src/electron/renderer/i18n');
const fixedPeriodRangesApi = require('../../src/electron/renderer/fixedPeriodRanges');
const usageAttributionRowsApi = require('../../src/electron/renderer/usageAttributionRows');
const preferences = require('../../src/electron/renderer/homeModulePreferences');
const { barScaleMax } = require('../../src/electron/renderer/breakdownRenderPolicy');
const app = fs.readFileSync(path.resolve(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const records = [{ qoderCnCredits: { days: {
  '2026-09-30': { qfmodel: { credits: 2.5, requests: 10 } },
  '2026-10-14': { qfmodel: { credits: 0.5, requests: 2 } },
  '2026-10-15': { qfmodel: { credits: 0.25, requests: 1 }, other: { credits: 0.1, requests: 1 } }
} } }];

function harness(rows = []) {
  const state = { stats: { devices: structuredClone(records) }, period: 'today' };
  const context = vm.createContext({
    state, t: (key, params) => translate('en', key, params), formatNumber: String,
    currentLocale: () => 'en', currentCalendarLocale: () => state.calendarLocale || 'en',
    fixedPeriodRangesApi: { ...fixedPeriodRangesApi, localDayKey: () => '2026-10-15' },
    qoderCnCreditsApi: { summarizeQoderCnCredits }, usageAttributionRowsApi,
    modelRowsForPeriod: () => rows, modelColor: () => 'blue'
  });
  vm.runInContext(app.slice(app.indexOf('function modelCreditsSummary('), app.indexOf('function renderHomeModelModule(')), context);
  return context;
}

test('Models uses the existing row list, selected range and calendar locale for reported credits', () => {
  const h = harness();
  for (const [period, expected] of [['today', 0.35], ['month', 0.85], ['allTime', 3.35], ['last7', 0.85], ['last30', 3.35], ['week', 0.85]]) {
    h.state.period = period;
    const rows = h.modelRowsWithCredits({});
    assert.equal(rows.reduce((sum, row) => sum + row.reportedCredits.credits, 0), expected, period);
    assert.ok(rows.every((row) => row.value === 0 && row.cost === 0 && row.barValue === 0));
    assert.match(rows[0].subtitle, /Qoder CN CLI.*requests/);
  }
  h.state.stats.devices[0].qoderCnCredits.days['2026-10-11'] = { qfmodel: { credits: 2, requests: 1 } };
  h.state.period = 'week'; h.state.calendarLocale = 'en-GB';
  assert.equal(h.modelCreditsSummary().credits, 0.85);
  h.state.calendarLocale = 'en-US';
  assert.equal(h.modelCreditsSummary().credits, 2.85);
  assert.match(app, /if \(state.breakdown === 'model'\) return modelRowsWithCredits\(period, credits\)/);
  assert.match(app, /if \(credits\?\.failed\) incompleteHint = 'qoderCnCredits.failed'/);
});

test('matching models retain one row and existing token/cost rankings and bar scale', () => {
  const original = usageAttributionRowsApi.rankRowsWithValues([
    { key: 'qfmodel', name: 'qfmodel', value: 120, cost: 0.1 },
    { key: 'claude', name: 'claude', value: 200, cost: 0.5 }
  ], 'cost');
  const before = structuredClone(original);
  const rows = harness(original).modelRowsWithCredits({});
  assert.deepEqual(Array.from(rows, (row) => row.key), ['claude', 'qfmodel', 'other']);
  assert.equal(rows.filter((row) => row.key === 'qfmodel').length, 1);
  assert.equal(rows[1].reportedCredits.credits, 0.25);
  assert.deepEqual(rows.map(({ key, value, cost, barValue }) => ({ key, value, cost, barValue })).slice(0, 2), before.map(({ key, value, cost, barValue }) => ({ key, value, cost, barValue })));
  assert.equal(barScaleMax(rows), barScaleMax(original));
  assert.deepEqual(original, before);
});

test('unknown or empty producers do not add a false zero row; explicit zero-credit requests remain visible', () => {
  const h = harness();
  for (const devices of [[], [{ qoderCnCredits: { days: {} } }], [{ qoderCnCredits: { error: 'collection-failed' } }]]) {
    h.state.stats.devices = devices;
    assert.equal(h.modelRowsWithCredits({}).length, 0);
  }
  assert.equal(h.modelCreditsSummary().failed, true);
  h.state.stats.devices = [{ qoderCnCredits: { days: { '2026-10-15': { qfmodel: { credits: 0, requests: 1 } } } } }];
  assert.equal(h.modelRowsWithCredits({})[0].reportedCredits.credits, 0);
  assert.equal(h.formatCredits(0), '0 credits');
});

test('all locale dictionaries retain credit units, request counts and reported billing semantics', () => {
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    for (const key of ['requests', 'source', 'failed']) assert.ok(messages[`qoderCnCredits.${key}`], `${locale}: ${key}`);
    assert.match(messages['qoderCnCredits.source'], /billable:false/);
    assert.ok(messages['settings.tools.health.code.qodercn-credits-collected'], locale);
    assert.doesNotMatch(translate(locale, 'qoderCnCredits.requests', { n: 12 }), /\{n\}/);
  }
});

test('credits-only collection health reports actual requests in the Models surface', () => {
  const { clientHealthDetail } = require('../../src/electron/renderer/clientHealthPresentation');
  const detail = clientHealthDetail({ clients: { qodercn: {
    overall: 'healthy', source: { state: 'detected' }, collection: { state: 'direct' },
    data: { liveTokens: 0, creditRequests: 3 }, diagnostics: [{ code: 'no-usage-observed' }]
  } } }, 'qodercn');
  assert.equal(detail.overall, 'healthy');
  assert.deepEqual(detail.notes, [{ code: 'qodercn-credits-collected', group: 'data', tone: 'neutral' }]);
});

test('Home preferences and module inventory are unchanged; no separate credit view component is loaded', () => {
  assert.equal(preferences.DEFAULT_HOME_MODULE_ORDER, 'limits,tool,model,session,device,trends');
  const home = app.slice(app.indexOf('function renderHome()'), app.indexOf('function setRendererSettings('));
  assert.doesNotMatch(home, /renderHomeCreditsModule|id === 'credits'/);
  const index = fs.readFileSync(path.resolve(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
  assert.match(index, /providers\/qodercn\/creditUsage\.js/);
  assert.doesNotMatch(index, /qoderCnCreditsView/);
});

test('the shared row renderer displays credit-only and combined readings without false token/USD values', () => {
  class Node {
    constructor() {
      this.dataset = {}; this.style = {}; this.className = ''; this.textContent = '';
      this.classList = {
        contains: (name) => this.className.split(' ').includes(name),
        toggle: (name, enabled) => { this.className = this.className.split(' ').filter((x) => x !== name).concat(enabled ? [name] : []).join(' '); },
        remove: (name) => this.classList.toggle(name, false), add: (name) => this.classList.toggle(name, true)
      };
    }
    hasAttribute() { return false; }
    replaceChildren() {}
  }
  const row = new Node();
  const nodes = new Map();
  row.querySelector = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); };
  let semantics;
  const h = harness();
  Object.assign(h, {
    state: { breakdown: 'model' }, rowWidth: () => 0, rowNumberAnimations: new Map(),
    cancelRowNumberAnimation() {}, setHoverMarqueeText(el, text) { el.textContent = text || ''; },
    iconKindFor: () => ({ kind: 'dot' }), updateRowContext() {}, updateRowLive() {}, applyBarScale() {},
    formatCost: (n) => `$${n.toFixed(2)}`, renderToolDetailAccordion() {},
    sessionRowsApi: { applyBreakdownRowSemantics(_row, _head, value) { semantics = value; } }
  });
  vm.runInContext(app.slice(app.indexOf('function updateRow(row,'), app.indexOf('function applyHomeListMark(')), h);
  const reading = { name: 'qfmodel', subtitle: 'Qoder CN CLI · 1 request', value: 0, cost: 0,
    tokenDataUnavailable: true, reportedCredits: { credits: 0.25, requests: 1 } };
  h.updateRow(row, reading);
  assert.equal(row.querySelector('.row-value').textContent, 'Unavailable');
  assert.equal(row.querySelector('.row-cost').textContent, '0.25 credits');
  assert.equal(row.dataset.tokenDataUnavailable, 'true');
  assert.match(semantics.ariaLabel, /0.25 credits/);
  h.updateRow(row, { ...reading, tokenDataUnavailable: false, value: 120, cost: 0.1 });
  assert.equal(row.querySelector('.row-value').textContent, '120');
  assert.equal(row.querySelector('.row-cost').textContent, '$0.10 · 0.25 credits');
  assert.equal(row.dataset.tokenDataUnavailable, undefined);
  h.updateRow(row, { ...reading, tokenDataUnavailable: false, reportedCredits: undefined, value: 240, cost: 0.2 });
  assert.equal(row.querySelector('.row-value').textContent, '240');
  assert.equal(row.querySelector('.row-cost').textContent, '$0.20');
  assert.equal(row.title, '');
});
