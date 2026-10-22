'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const charts = require('../../src/electron/renderer/usageCharts');
const { createLimitWindowsView } = require('../../src/electron/renderer/limits/windowsView');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const binding = source.slice(source.indexOf('function bindTrendTooltip('), source.indexOf('function renderTrends('));

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
  querySelector(selector) { return this.children.find(child => child.classList.contains(selector.slice(1))) || null; }
  getBoundingClientRect() { return { left: 10, top: 150, width: 300, right: 310 }; }
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
  const document = { createElement: () => new Element(), documentElement: { clientWidth: 340 } };
  const limitWindowsView = createLimitWindowsView({ document, tooltip: { markOpened() {}, release() {} } });
  const spark = new Element();
  spark.className = 'trends-spark';
  spark.setAttribute('role', 'button');
  const svg = new Element(); svg.className = 'sparkline'; spark.append(svg);
  let renders = 0;
  const context = {
    limitWindowsView, t: () => 'Open dashboard', formatNumber: n => Number(n).toLocaleString('en-US'),
    document, renderTrends: () => { renders += 1; }, requestAnimationFrame: callback => callback()
  };
  assert.ok(binding, 'the renderer binds custom Trends details');
  vm.runInNewContext(binding, context);
  context.bindTrendTooltip(spark, charts.sparklinePreview(points, { width: 300, gap: 0.3 }), points, labelKey, 'tokens');
  return { spark, tooltip: spark.querySelector('.limit-detail-tooltip'), renders: () => renders };
}

test('Trends hover shows exact date and token count, including zero days and chart gaps', () => {
  const { spark, tooltip } = fixture();
  spark.fire('pointerenter', { clientX: 15 });
  assert.equal(tooltip.open, true);
  assert.equal(tooltip.textContent, '2026-10-2112,345,678 tokens');
  assert.equal(tooltip.getAttribute('role'), 'tooltip');
  assert.equal(tooltip.getAttribute('popover'), 'manual');
  assert.equal(spark.getAttribute('title'), null);
  spark.fire('pointermove', { clientX: 110 }); // gap at the start of the zero day's column
  assert.equal(tooltip.textContent, '2026-10-220 tokens');
  spark.fire('pointermove', { clientX: 500 }); // clamp at the chart edge
  assert.equal(tooltip.textContent, '2026-10-2342 tokens');
  spark.fire('pointerleave');
  assert.equal(tooltip.open, false);
});

test('Trends focus and arrow keys expose each day while Escape and blur dismiss details', () => {
  const { spark, tooltip } = fixture();
  spark.fire('focusin');
  assert.equal(tooltip.open, true);
  let prevented = 0;
  const press = key => spark.fire('keydown', { key, preventDefault: () => { prevented += 1; } });
  press('ArrowLeft');
  assert.match(spark.getAttribute('aria-label'), /Open dashboard.*2026-10-22.*0 tokens/);
  press('Home');
  assert.match(spark.getAttribute('aria-label'), /2026-10-21.*12,345,678 tokens/);
  press('ArrowLeft');
  assert.match(tooltip.textContent, /^2026-10-21/);
  press('End'); press('ArrowRight');
  assert.match(tooltip.textContent, /^2026-10-23/);
  assert.equal(prevented, 5);
  press('Enter'); press(' '); // existing dashboard activation keeps these keys
  assert.equal(prevented, 5);
  press('Escape');
  assert.equal(tooltip.open, false);
  spark.fire('focusin'); spark.fire('focusout');
  assert.equal(tooltip.open, false);
  assert.equal(spark.tabIndex, 0);
  assert.equal(spark.getAttribute('role'), 'button');
});

test('Trends monthly and single-column views retain their own labels and positions', () => {
  const { spark, tooltip } = fixture([{ month: '2026-10', tokens: 987_654_321 }], 'month');
  spark.fire('pointerenter', { clientX: 10 });
  assert.equal(tooltip.textContent, '2026-10987,654,321 tokens');
  assert.equal(spark.properties['--trend-tooltip-x'], '150px');
});

test('Trends defers live replacement while reading and flushes on pointer leave or blur', () => {
  const { spark, renders } = fixture();
  const render = source.slice(source.indexOf('function renderTrends('), source.indexOf('function viewLabelById('));
  const context = { els: { trendsPanel: { querySelector: () => spark } } };
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
