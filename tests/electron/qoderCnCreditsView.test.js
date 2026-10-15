'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { summarizeQoderCnCredits } = require('../../src/shared/providers/qodercn/creditUsage');
const { renderQoderCnCredits } = require('../../src/electron/renderer/qoderCnCreditsView');
const { MESSAGES, translate } = require('../../src/electron/renderer/i18n');
const fixedPeriodRangesApi = require('../../src/electron/renderer/fixedPeriodRanges');
const preferences = require('../../src/electron/renderer/homeModulePreferences');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this[name] = value; }
}
const options = {
  document: { createElement: (tag) => new Element(tag) },
  t: (key, params) => translate('en', key, params),
  formatNumber: (value) => String(value),
  formatCredits: (value) => String(value)
};
function text(element) {
  return [element.textContent || '', ...element.children.map(text)].join(' ');
}
const records = [{ qoderCnCredits: { days: {
  '2026-09-30': { qfmodel: { credits: 2.5, requests: 10 } },
  '2026-10-14': { qfmodel: { credits: 0.5, requests: 2 } },
  '2026-10-15': { qfmodel: { credits: 0.25, requests: 1 }, other: { credits: 0.1, requests: 1 } }
} } }];

test('Credits has an independent summary/model display with explicit units and reported-value semantics', () => {
  const summary = summarizeQoderCnCredits(records, { start: '2026-10-01', end: '2026-10-15' });
  const view = renderQoderCnCredits(summary, options);
  assert.equal(view.tagName, 'section');
  assert.equal(view.className, 'home-module home-module-credits');
  assert.match(text(view), /0.85 credits/);
  assert.match(text(view), /4 requests/);
  assert.match(text(view), /qfmodel/);
  assert.match(text(view), /other/);
  assert.match(text(view), /billable:false/);
  assert.doesNotMatch(text(view), /tokens|\$/);
});

test('old producers remain unknown while an enabled empty source has an explicit waiting state', () => {
  assert.equal(renderQoderCnCredits(summarizeQoderCnCredits([]), options), null);
  const empty = renderQoderCnCredits(summarizeQoderCnCredits([{ qoderCnCredits: { days: {} } }]), options);
  assert.match(text(empty), /0 credits/);
  assert.match(text(empty), /Waiting/);
});

test('credit read failures are visible and never render an unavailable baseline as zero', () => {
  const summary = summarizeQoderCnCredits([{ qoderCnCredits: { error: 'collection-failed' } }]);
  const view = renderQoderCnCredits(summary, options);
  assert.match(text(view), /— credits/);
  assert.match(text(view), /collection failed/);
  assert.doesNotMatch(text(view), /0 credits/);
  const partial = summarizeQoderCnCredits([...records, { qoderCnCredits: { error: 'collection-failed' } }]);
  assert.equal(partial.failed, true);
  assert.equal(partial.hasData, true);
  assert.match(text(renderQoderCnCredits(partial, options)), /3\.35 credits/);
});

test('actual Home renderer connects the selected period and locale to the credits summary', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const source = app.slice(app.indexOf('function renderHomeCreditsModule('), app.indexOf('function renderHomeModelModule('));
  const state = { stats: { devices: records }, period: 'today' };
  const context = vm.createContext({
    state, document: options.document, t: options.t, formatNumber: options.formatNumber, currentLocale: () => 'en',
    currentCalendarLocale: () => state.calendarLocale || 'en',
    fixedPeriodRangesApi: { ...fixedPeriodRangesApi, localDayKey: () => '2026-10-15' },
    qoderCnCreditsApi: { summarizeQoderCnCredits },
    qoderCnCreditsViewApi: { renderQoderCnCredits }
  });
  vm.runInContext(source, context);
  for (const [period, expected] of [['today', '0.35'], ['month', '0.85'], ['allTime', '3.35'], ['last7', '0.85'], ['last30', '3.35'], ['week', '0.85']]) {
    state.period = period;
    assert.match(text(context.renderHomeCreditsModule()), new RegExp(`${expected.replace('.', '\\.')} credits`), period);
  }
  state.stats = { devices: JSON.parse(JSON.stringify(records)) };
  state.stats.devices[0].qoderCnCredits.days['2026-10-11'] = { qfmodel: { credits: 2, requests: 1 } };
  state.period = 'week';
  state.calendarLocale = 'en-GB';
  assert.match(text(context.renderHomeCreditsModule()), /0\.85 credits/);
  state.calendarLocale = 'en-US';
  assert.match(text(context.renderHomeCreditsModule()), /2\.85 credits/);
  const home = app.slice(app.indexOf('function renderHome()'), app.indexOf('function setRendererSettings('));
  assert.match(home, /id === 'credits'.*renderHomeCreditsModule/);
  const index = fs.readFileSync(path.resolve(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
  assert.match(index, /providers\/qodercn\/creditUsage\.js/);
  assert.match(index, /qoderCnCreditsView\.js/);
});

test('all locale dictionaries contain explicit credit labels, request counts and billing guidance', () => {
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    for (const key of ['title', 'requests', 'source', 'empty']) assert.ok(messages[`qoderCnCredits.${key}`], `${locale}: ${key}`);
    assert.match(messages['qoderCnCredits.source'], /billable:false/);
    assert.ok(messages['settings.tools.health.code.qodercn-credits-collected'], locale);
    assert.doesNotMatch(translate(locale, 'qoderCnCredits.requests', { n: 12 }), /\{n\}/);
  }
});

test('credits-only collection health reports observed usage and explains the separate display', () => {
  const { clientHealthDetail } = require('../../src/electron/renderer/clientHealthPresentation');
  const detail = clientHealthDetail({ clients: { qodercn: {
    overall: 'healthy', source: { state: 'detected' }, collection: { state: 'direct' },
    data: { liveTokens: 0, creditRequests: 3 }, diagnostics: [{ code: 'no-usage-observed' }]
  } } }, 'qodercn');
  assert.equal(detail.overall, 'healthy');
  assert.deepEqual(detail.notes, [{ code: 'qodercn-credits-collected', group: 'data', tone: 'neutral' }]);
});

test('legacy default Home order gains Credits visibly; custom ordering and hiding stay usable', () => {
  const modules = ['limits', 'credits', 'tool', 'model', 'session', 'device', 'trends'].map((id) => ({ id }));
  assert.deepEqual(preferences.normalizeHomeModuleOrder('limits,tool,model,session,device,trends', modules), modules.map(({ id }) => id));
  assert.deepEqual(preferences.normalizeHomeModuleOrder('trends,model,limits', modules), ['trends', 'model', 'limits', 'credits', 'tool', 'session', 'device']);
  assert.equal(preferences.normalizeHiddenHomeModules('credits,device', modules), 'credits,device');
});
