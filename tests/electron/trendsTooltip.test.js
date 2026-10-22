'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const charts = require('../../src/electron/renderer/usageCharts');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const binding = source.slice(source.indexOf('function hideTrendTooltip('), source.indexOf('function renderTrends('));
const heatmapTooltip = source.slice(source.indexOf('function homeActivityTooltipEl('), source.indexOf('function setupHomeActivityHover('));

class Element {
  constructor() {
    this.children = []; this.attributes = {}; this.dataset = {}; this.handlers = {};
    this.properties = {}; this.isConnected = true; this.offsetHeight = 28;
    this.style = {
      setProperty: (name, value) => { this.properties[name] = value; },
      removeProperty: name => { delete this.properties[name]; }
    };
    this.classList = {
      contains: name => (this.className || '').split(' ').includes(name),
      add: name => { if (!this.classList.contains(name)) this.className = `${this.className || ''} ${name}`.trim(); },
      remove: name => { this.className = (this.className || '').split(' ').filter(value => value !== name).join(' '); },
      toggle: (name, on) => on ? this.classList.add(name) : this.classList.remove(name)
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  get childElementCount() { return this.children.length; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => {
      const matches = selector.startsWith('.') ? child.classList.contains(selector.slice(1))
        : Object.hasOwn(child.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()));
      return [...(matches ? [child] : []), ...child.querySelectorAll(selector)];
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() {
    return this.bounds || (this.classList.contains('home-activity-tooltip')
      ? { width: 120, height: 40 } : { left: 10, top: 150, width: 300, height: 300, right: 310 });
  }
  addEventListener(name, callback) { (this.handlers[name] ||= []).push(callback); }
  fire(name, event = {}) { for (const callback of this.handlers[name] || []) callback(event); }
  showPopover() { this.open = true; }
  hidePopover() { this.open = false; }
  matches(selector) { return selector === ':popover-open' && this.open; }
}

function fixture(points = [
  { date: '2026-10-21', tokens: 12_345_678 },
  { date: '2026-10-22', tokens: 0 },
  { date: '2026-10-23', tokens: 42 }
], labelKey = 'date') {
  const body = new Element();
  const document = { createElement: () => new Element(), body, querySelector: selector => body.querySelector(selector) };
  const spark = new Element();
  spark.className = 'trends-spark';
  spark.setAttribute('role', 'button');
  spark.tabIndex = 0;
  const svg = new Element(); svg.className = 'sparkline'; spark.append(svg);
  for (const _point of points) { const bar = new Element(); bar.className = 'spark-bar'; svg.append(bar); }
  let renders = 0;
  const context = {
    t: () => 'Open dashboard', formatNumber: n => Number(n).toLocaleString('en-US'),
    formatCompact: n => Number(n).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }),
    state: {}, window: { innerWidth: 340, innerHeight: 600 },
    document, renderTrends: () => { renders += 1; }, requestAnimationFrame: callback => callback()
  };
  assert.ok(binding, 'the renderer binds custom Trends details');
  vm.runInNewContext(`${heatmapTooltip}\n${binding}`, context);
  context.bindTrendTooltip(spark, charts.sparklinePreview(points, { width: 300, gap: 0.3 }), points, labelKey, 'tokens');
  return { spark, svg, context, tooltip: body.querySelector('.trends-tooltip'), renders: () => renders };
}

test('Trends hover shows exact date and token count, including zero days and chart gaps', () => {
  const { spark, tooltip } = fixture();
  spark.fire('pointerenter', { clientX: 15, clientY: 200 });
  assert.equal(tooltip.dataset.visible, 'true');
  assert.equal(tooltip.textContent, '12.3Mtokens2026-10-21');
  assert.equal(tooltip.getAttribute('role'), 'tooltip');
  assert.ok(tooltip.classList.contains('home-activity-tooltip'));
  assert.equal(spark.getAttribute('title'), null);
  spark.fire('pointermove', { clientX: 110, clientY: 200 }); // gap at the start of the zero day's column
  assert.equal(tooltip.textContent, '0tokens2026-10-22');
  spark.fire('pointermove', { clientX: 500, clientY: 200 }); // clamp at the chart edge
  assert.equal(tooltip.textContent, '42tokens2026-10-23');
  spark.fire('pointerleave');
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(tooltip.getAttribute('aria-hidden'), 'true');
});

test('Trends focus and arrow keys expose each day while Escape and blur dismiss details', () => {
  const { spark, tooltip } = fixture();
  spark.fire('focusin');
  assert.equal(tooltip.dataset.visible, 'true');
  let prevented = 0;
  const press = key => spark.fire('keydown', { key, preventDefault: () => { prevented += 1; } });
  press('ArrowLeft');
  assert.match(spark.getAttribute('aria-label'), /Open dashboard.*2026-10-22.*0 tokens/);
  press('Home');
  assert.match(spark.getAttribute('aria-label'), /2026-10-21.*12,345,678 tokens/);
  press('ArrowLeft');
  assert.match(tooltip.textContent, /2026-10-21$/);
  press('End'); press('ArrowRight');
  assert.match(tooltip.textContent, /2026-10-23$/);
  assert.equal(prevented, 5);
  press('Enter'); press(' '); // existing dashboard activation keeps these keys
  assert.equal(prevented, 5);
  press('Escape');
  assert.equal(tooltip.dataset.visible, 'false');
  spark.fire('focusin'); spark.fire('focusout');
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(spark.tabIndex, 0);
  assert.equal(spark.getAttribute('role'), 'button');
});

test('Trends monthly and single-column views retain their own labels and positions', () => {
  const { spark, tooltip } = fixture([{ month: '2026-10', tokens: 987_654_321 }], 'month');
  spark.fire('focusin');
  assert.equal(tooltip.textContent, '987.7Mtokens2026-10');
  assert.equal(tooltip.style.transform, 'translate(160px, 101px) translate(-50%, 0)');
});

test('Trends tooltip stays centered above the pointer and avoids window edges', () => {
  const { spark, tooltip } = fixture();
  spark.fire('pointerenter', { clientX: 130, clientY: 200 });
  assert.equal(tooltip.style.transform, 'translate(70px, 146px)');
  spark.fire('pointermove', { clientX: 160, clientY: 250 });
  assert.equal(tooltip.style.transform, 'translate(100px, 196px)');
  assert.equal(tooltip.textContent, '0tokens2026-10-22');
  spark.fire('pointermove', { clientX: 0, clientY: 1 });
  assert.equal(tooltip.style.transform, 'translate(6px, 15px)');
  spark.fire('pointermove', { clientX: 339, clientY: 599 });
  assert.equal(tooltip.style.transform, 'translate(214px, 545px)');
  spark.fire('pointermove', { clientX: 500, clientY: 700 });
  assert.equal(tooltip.style.transform, 'translate(214px, 554px)');
});

test('Trends keyboard interaction returns from pointer placement to the selected bar', () => {
  const { spark, tooltip } = fixture();
  spark.fire('pointerenter', { clientX: 30, clientY: 250 });
  spark.fire('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(tooltip.style.transform, 'translate(66px, 101px) translate(-50%, 0)');
});

test('Trends and Home reuse the same tooltip layout with separate instances and cleanup', () => {
  const { spark, context, tooltip } = fixture();
  const home = context.homeActivityTooltipEl();
  assert.notEqual(home, tooltip);
  assert.ok(home.classList.contains('home-activity-tooltip'));
  spark.fire('focusin');
  context.hideTrendTooltip();
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(context.state.trendTooltipTeardown, null);
  assert.equal(spark.querySelectorAll('.spark-bar').some(bar => bar.getAttribute('data-active')), false);
  assert.equal(home.getAttribute('aria-hidden'), 'true');
});

test('Trends defers live replacement while reading and flushes on pointer leave or blur', () => {
  const { spark, renders } = fixture();
  const render = source.slice(source.indexOf('function renderTrends('), source.indexOf('function viewLabelById('));
  const context = { document: { hasFocus: () => true }, els: { trendsPanel: { querySelector: () => spark } } };
  vm.runInNewContext(`${render}\nrenderTrends();`, context);
  assert.equal(spark.dataset.renderPending, 'true');
  spark.fire('pointerleave');
  assert.equal(renders(), 1);
  assert.equal(spark.dataset.renderPending, undefined);
  spark.fire('pointerleave');
  assert.equal(renders(), 1);
  context.renderTrends(); spark.fire('focusout');
  assert.equal(renders(), 2);
});

test('Trends refreshes an unfocused hovered chart and resumes reading deferral on focus', () => {
  const spark = new Element();
  const panel = { querySelector: () => spark, innerHTML: 'old chart' };
  let focused = false;
  const context = {
    document: { hasFocus: () => focused }, els: { trendsPanel: panel },
    window: { TokenMonitorUsageCharts: charts }, state: { period: 'month', stats: {} },
    captureTrendBarMotion: () => [], fixedPeriodRangesApi: { isDerived: () => false },
    hideTrendTooltip() {}, t: key => key
  };
  const render = source.slice(source.indexOf('function renderTrends('), source.indexOf('function viewLabelById('));
  vm.runInNewContext(`${render}\nrenderTrends();`, context);
  assert.equal(spark.dataset.renderPending, undefined);
  assert.match(panel.innerHTML, /trends-empty/);
  focused = true;
  panel.innerHTML = 'current chart';
  context.renderTrends();
  assert.equal(spark.dataset.renderPending, 'true');
  assert.equal(panel.innerHTML, 'current chart');
});

test('window blur hides Trends details and flushes a pending update without pointer leave', () => {
  const { spark, context, tooltip, renders } = fixture();
  context.state.breakdown = 'trends';
  context.els = { trendsPanel: { querySelector: () => spark } };
  spark.fire('pointerenter', { clientX: 130, clientY: 200 });
  spark.dataset.renderPending = 'true';
  // Use the handler actually registered on window, rather than a chart focusout.
  const handler = source.match(/window\.addEventListener\('blur', (\w+)\);/)[1];
  context[handler]();
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(spark.dataset.renderPending, undefined);
  assert.equal(renders(), 1);
  context[handler]();
  assert.equal(renders(), 1);
});
