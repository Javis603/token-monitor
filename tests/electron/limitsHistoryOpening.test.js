'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('history opening reports its size without paint callbacks; visible switches still wait for paint', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/limits/history.js'), 'utf8');
  const content = source.slice(source.indexOf('  function renderContent('), source.indexOf('  reducedMotionMedia.addEventListener('));
  const sizing = source.slice(source.indexOf('  const cardLayout ='), source.indexOf('  new ResizeObserver(() => scheduleSize())'));
  const frames = new Map(), reports = [];
  let sequence = 0;
  const context = vm.createContext({
    payload: { renderToken: 5 },
    window: { addEventListener() {} },
    bridge: { resize: (...args) => reports.push(args) },
    reduceMotion: () => false,
    $: () => ({ getBoundingClientRect: () => ({ height: 320 }), animate: () => ({ finished: Promise.resolve(), cancel() {} }) }),
    getComputedStyle: () => ({ paddingTop: '12px', paddingBottom: '12px', borderTopWidth: '1px', borderBottomWidth: '1px' }),
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: id => frames.delete(id)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/cardLayout.js'), 'utf8'), context);
  vm.runInContext(`const cardSwitch = { capture: () => null, play() {}, cancel() {} }; let animateMeasurement = false;
    function render() {}
    ${content}\n${sizing}`, context);
  const paint = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback());
  };

  vm.runInContext('renderContent(true, true)', context);
  assert.deepEqual(reports, [[346, 5, false, false]], 'a hidden window must not depend on a paint to become visible');
  assert.equal(frames.size, 0, 'opening cancels its pending measurement frame');

  vm.runInContext('payload.renderToken = 6; renderContent(true, false)', context);
  assert.equal(reports.length, 1, 'a visible switch waits for the new content to paint');
  paint();
  assert.equal(reports.length, 1);
  paint();
  assert.deepEqual(reports[1], [346, 6, true, false]);

  vm.runInContext('payload.renderToken = 7; renderContent(true, false); renderContent(true, true)', context);
  assert.deepEqual(reports[2], [346, 7, false, false], 'reopening also releases an already queued measurement');
  assert.equal(frames.size, 0);
});

function renderTrendForTest(entry, provider = 'qoder', entries = [entry]) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/limits/history.js'), 'utf8');
  const baseline = source.slice(source.indexOf('  function withLeadingBaseline('), source.indexOf('  function overlayEntries('));
  const trend = source.slice(source.indexOf('  function drawTrend()'), source.indexOf('  function drawDistribution('));
  const elements = {
    trend: { children: [], attrs: {}, getBoundingClientRect: () => ({ width: 300 }),
      replaceChildren() { this.children = []; }, append(node) { this.children.push(node); },
      setAttribute(name, value) { this.attrs[name] = value; } },
    'trend-heading': { textContent: 'Trend' }, empty: {}, 'guide-caption': {}
  };
  const context = {
    $: id => elements[id], current: () => entry, overlayEntries: () => entries,
    model: require('../../src/electron/renderer/limits/historyModel'), payload: { provider },
    trendScaleMode: 'normalized', trendRangeMode: 'cycle',
    unit: item => item.unit, label: item => item.window.label, currentTrendView: () => 'normalized',
    t: key => key, number: value => String(value), date: () => 'date', seriesColor: () => 'blue',
    svgNode: (tag, attrs, text) => ({ tag, attrs, text }), paintSvg: node => node
  };
  vm.runInNewContext(`${baseline}\n${trend}\ndrawTrend();`, context);
  return elements;
}

for (const type of ['qoder', 'money']) test(`the default progress view retains ${type} history without cycle bounds`, () => {
  const now = Date.now();
  const money = type === 'money';
  const unit = money ? 'USD' : 'pp';
  const entry = { unit, balance: false, window: money
    ? { kind: 'billing', label: 'Spend', metric: 'spend', used: 30, currency: 'USD' }
    : { kind: 'billing', label: 'Team credits', usedPercent: 30 },
  points: [20, 30].map((value, index) => ({ at: now - (2 - index) * 3_600_000, value, unit, balance: false, reset: null })) };
  const elements = renderTrendForTest(entry);
  assert.equal(elements.empty.hidden, true);
  assert.ok(elements.trend.children.some(node => node.tag === 'path' && node.attrs.class === 'quota-history-curve'));
});

for (const conflict of [false, true]) test(`progress trends ${conflict ? 'preserve source conflicts' : 'join compatible missing samples'}`, () => {
  const now = Date.now(), end = now + 86_400_000, start = end - 7 * 86_400_000;
  const first = { at: start, value: 20, unit: 'pp', balance: false, reset: end };
  if (conflict) first.uncertainUntil = start + 600_000;
  const second = { at: start + 3_600_000, value: 25, unit: 'pp', balance: false, reset: end,
    ...(conflict ? { breakBefore: true } : {}) };
  const elements = renderTrendForTest({ unit: 'pp', window: { kind: 'weekly', label: 'Weekly',
    resetsAt: new Date(end).toISOString(), usedPercent: 25 }, points: [first, second] }, 'claude');
  const curves = elements.trend.children.filter(node => node.attrs.class === 'quota-history-curve');
  assert.equal(curves.length, conflict ? 2 : 1);
  assert.ok(curves.every(node => node.tag === (conflict ? 'line' : 'path')));
});

test('an unused current cycle without samples draws a full remaining line', () => {
  const end = Date.now() + 86_400_000;
  const entry = { unit: 'pp', window: { kind: 'weekly', label: 'Weekly',
    resetsAt: new Date(end).toISOString(), usedPercent: 0 }, points: [] };
  const elements = renderTrendForTest(entry, 'claude');
  const curve = elements.trend.children.find(node => node.attrs.class === 'quota-history-curve');
  assert.equal(elements.empty.hidden, true);
  assert.equal(curve.attrs.d, 'M26,10L295,10');
});

test('a delayed first reading connects back to a display-only cycle baseline', () => {
  const end = Date.now() + 86_400_000, start = end - 7 * 86_400_000;
  const entry = { unit: 'pp', window: { kind: 'weekly', label: 'Weekly',
    resetsAt: new Date(end).toISOString(), usedPercent: 25 },
  points: [{ at: start + 3_600_000, value: 25, unit: 'pp', balance: false, reset: end }] };
  const elements = renderTrendForTest(entry, 'claude');
  const curve = elements.trend.children.find(node => node.attrs.class === 'quota-history-curve');
  assert.ok(curve.attrs.d.startsWith('M26,10L'));
});

test('a 0% placeholder without a reading does not invent trend observations', () => {
  const end = Date.now() + 86_400_000;
  const entry = { unit: 'pp', placeholder: true, window: { kind: 'weekly', label: 'Weekly',
    resetsAt: new Date(end).toISOString(), usedPercent: null, remainingPercent: null }, points: [] };
  const elements = renderTrendForTest(entry, 'claude');
  assert.equal(elements.empty.hidden, false);
  assert.equal(elements.trend.children.some(node => node.attrs.class === 'quota-history-curve'), false);
});

test('mixed known and unknown cycles keep every percentage lane visible', () => {
  const now = Date.now(), reset = now + 86_400_000;
  const readings = (used, cycleReset) => [used - 5, used].map((value, index) => ({
    at: now - (2 - index) * 3_600_000, value, unit: 'pp', balance: false, reset: cycleReset
  }));
  const weekly = { unit: 'pp', window: { kind: 'weekly', label: 'Weekly', usedPercent: 20,
    resetsAt: new Date(reset).toISOString() }, points: readings(20, reset) };
  const monthly = { unit: 'pp', window: { kind: 'billing', label: 'Monthly', usedPercent: 30 }, points: readings(30, null) };
  const elements = renderTrendForTest(weekly, 'kimi', [weekly, monthly]);
  assert.equal(elements.empty.hidden, true);
  assert.equal(elements.trend.children.filter(node => node.tag === 'path' && node.attrs.class === 'quota-history-curve').length, 2);
});

test('a used cycle without stored samples reaches the current value before reset', () => {
  const end = Date.now() + 86_400_000;
  const entry = { unit: 'pp', window: { kind: 'weekly', label: 'Weekly',
    resetsAt: new Date(end).toISOString(), usedPercent: 40 }, points: [] };
  const elements = renderTrendForTest(entry, 'claude');
  const curve = elements.trend.children.find(node => node.attrs.class === 'quota-history-curve');
  const endpoint = curve.attrs.d.match(/L([^,]+),([^L]+)$/);
  assert.ok(Number(endpoint[1]) < 295, 'the observed current value must not be placed at the future reset');
  assert.ok(Math.abs(Number(endpoint[2]) - 30.8) < 0.001);
});
