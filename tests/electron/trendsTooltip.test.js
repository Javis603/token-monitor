'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const charts = require('../../src/electron/renderer/usageCharts');
const currencyApi = require('../../src/shared/currency');
const compactTokens = require('../../src/shared/compactTokens');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const binding = source.slice(source.indexOf('function hideTrendTooltip('), source.indexOf('function renderTrends('));
const heatmapTooltip = source.slice(source.indexOf('function homeActivityTooltipEl('), source.indexOf('function setupHomeActivityHover('));
const homeTrendBinding = source.slice(source.indexOf('function bindHomeTrendTooltip('), source.indexOf('const rendererDom ='));
const periodMenuKeys = source.slice(source.lastIndexOf("document.addEventListener('keydown'", source.indexOf("els.breakdown.addEventListener('scroll'")),
  source.indexOf("els.breakdown.addEventListener('scroll'"));
const hidePeriodContent = source.slice(source.indexOf('function hidePeriodContentForMessage('), source.indexOf('function periodMenuButtons('));

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
  insertBefore(child, reference) { this.children.splice(this.children.indexOf(reference), 0, child); }
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
  removeEventListener(name, callback) { this.handlers[name] = (this.handlers[name] || []).filter(handler => handler !== callback); }
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

test('retained Trends bindings update readings and keyboard navigation across two pushes', () => {
  const { spark, context, tooltip } = fixture();
  spark.fire('focusin');
  const listenerCount = Object.values(spark.handlers).flat().length;
  for (let i = 1; i <= 2; i++) {
    const points = [{ date: '2026-10-22', tokens: 10 * i }, { date: '2026-10-23', tokens: 100 * i }];
    context.bindTrendTooltip(spark, charts.sparklinePreview(points, { width: 300, gap: 0.3 }), points, 'date', 'tokens');
    assert.equal(tooltip.dataset.visible, 'true');
    assert.equal(tooltip.textContent, `${100 * i}tokens2026-10-23`);
    assert.equal(Object.values(spark.handlers).flat().length, listenerCount);
    spark.fire('keydown', { key: 'Home', preventDefault() {} });
    assert.equal(tooltip.textContent, `${10 * i}tokens2026-10-22`);
    spark.fire('keydown', { key: 'End', preventDefault() {} });
  }
});

test('window blur hides Trends details without a delayed repaint', () => {
  const { spark, context, tooltip, renders } = fixture();
  context.state.breakdown = 'trends';
  context.els = { trendsPanel: { querySelector: () => spark } };
  spark.fire('pointerenter', { clientX: 130, clientY: 200 });
  // Use the handler actually registered on window, rather than a chart focusout.
  const handler = source.match(/window\.addEventListener\('blur', (\w+)\);/)[1];
  context[handler]();
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(renders(), 0);
  context[handler]();
  assert.equal(renders(), 0);
});

function homeTrendFixture(points = [
  { date: '2026-10-21', tokens: 100, cost: 1.25 },
  { date: '2026-10-22', tokens: 0, cost: 0 },
  { date: '2026-10-23', tokens: 40 }
]) {
  const body = new Element();
  const document = { createElement: () => new Element(), body, querySelector: selector => body.querySelector(selector) };
  const homePanel = new Element();
  const chart = new Element(); chart.className = 'home-area-chart';
  const module = new Element(); module.className = 'home-module'; module.tabIndex = 0;
  module.setAttribute('role', 'button'); module.setAttribute('aria-label', 'Activity');
  chart.closest = () => module;
  module.append(chart);
  const svg = new Element(); svg.className = 'area-line';
  svg.bounds = { left: 20, top: 100, width: 300, height: 70 };
  const crosshair = new Element(); crosshair.className = 'home-trend-crosshair';
  const marker = new Element(); marker.className = 'home-trend-marker';
  chart.append(svg, crosshair, marker);
  const state = {};
  const context = { state, document, els: { homePanel }, window: { innerWidth: 340, innerHeight: 180 }, currencyApi,
    usageAttributionRowsApi: require('../../src/electron/renderer/usageAttributionRows'),
    t: key => key === 'home.activity' ? 'Activity' : 'Trend',
    formatCompact: n => compactTokens.formatCompactTokens(n, state.settings?.compactTokenUnits, 'zh-HK'),
    formatNumber: n => Number(n).toLocaleString('en-US') };
  assert.ok(source.includes('function bindHomeTrendTooltip('), 'Home trend hover binding exists');
  const currentCurrency = source.match(/^function currentCurrency\(\).*$/m)[0];
  vm.runInNewContext(`${currentCurrency}\n${heatmapTooltip}\n${homeTrendBinding}`, context);
  let documentKeyDown;
  document.addEventListener = (name, listener) => {
    assert.equal(name, 'keydown');
    documentKeyDown = listener;
  };
  vm.runInNewContext(periodMenuKeys, context);
  const escape = () => documentKeyDown({ key: 'Escape' });
  const bind = rows => context.bindHomeTrendTooltip(chart,
    charts.areaLineChart(rows, { width: 300, height: 70, padTop: 4, padRight: 3, padBottom: 4, padLeft: 3, curve: true }), rows);
  bind(points);
  const tooltip = body.querySelector('.home-trend-tooltip');
  tooltip.bounds = { width: 120, height: 50 };
  return { chart, module, homePanel, crosshair, marker, tooltip, bind, state, context, escape };
}

function visibleHomeTrendText(tooltip) {
  const [reading, cost, date] = tooltip.children;
  return reading.children.filter(child => !child.classList.contains('token-number-reading'))
    .map(child => child.textContent).join('') + cost.textContent + date.textContent;
}

test('Home trend hover snaps across the full plot, including zero and edge days', () => {
  const { chart, crosshair, marker, tooltip } = homeTrendFixture();
  chart.fire('pointerenter', { clientX: 20, clientY: 130 });
  assert.equal(visibleHomeTrendText(tooltip), '100tokens$1.25002026-10-21');
  assert.equal(chart.getAttribute('data-active'), 'true');
  assert.equal(crosshair.style.left, '1%');
  assert.equal(marker.style.left, '1%');
  chart.fire('pointermove', { clientX: 170, clientY: 169 });
  assert.equal(visibleHomeTrendText(tooltip), '0tokens$0.00002026-10-22');
  assert.equal(crosshair.style.left, '50%');
  assert.equal(marker.style.top, `${(66 / 70) * 100}%`);
  chart.fire('pointermove', { clientX: 500, clientY: 110 });
  assert.equal(visibleHomeTrendText(tooltip), '40tokens2026-10-23');
  assert.equal(crosshair.style.left, '99%');
  chart.fire('pointerleave');
  assert.equal(chart.getAttribute('data-active'), null);
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(tooltip.getAttribute('aria-hidden'), 'true');
});

test('Home trend tooltip remains within the window and refreshes hovered values', () => {
  const { chart, tooltip, bind, state, context } = homeTrendFixture();
  chart.fire('pointermove', { clientX: 319, clientY: 175 });
  assert.equal(tooltip.style.transform, 'translate(214px, 82px)');
  context.window.innerHeight = 100;
  chart.fire('pointermove', { clientX: 319, clientY: 175 });
  assert.equal(tooltip.style.transform, 'translate(214px, 44px)');
  bind([
    { date: '2026-10-21', tokens: 100, cost: 1.25 },
    { date: '2026-10-22', tokens: 0, cost: 0 },
    { date: '2026-10-23', tokens: 55, cost: 2 }
  ]);
  assert.equal(visibleHomeTrendText(tooltip), '55tokens$2.00002026-10-23');
  assert.equal(Object.values(chart.handlers).flat().length, 3);
  context.hideHomeTrendTooltip();
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(chart.getAttribute('data-active'), null);
  assert.equal(state.homeTrendTooltipBinding.chart, chart);
});

test('Home trend cost marks days with unpriced tokens as incomplete', () => {
  const { chart, tooltip } = homeTrendFixture([
    { date: '2026-10-21', tokens: 100, cost: 1.5, unpricedTokens: 20 },
    { date: '2026-10-22', tokens: 40, cost: 0, unpricedTokens: 40 }
  ]);
  chart.fire('pointerenter', { clientX: 20 });
  assert.equal(visibleHomeTrendText(tooltip), '100tokens$1.5000 + ?2026-10-21');
  chart.fire('pointermove', { clientX: 320 });
  assert.equal(visibleHomeTrendText(tooltip), '40tokens—2026-10-22');
});

test('Home trend defaults to compact units and can refresh a visible reading to exact tokens', () => {
  const rows = [{ date: '2026-10-21', tokens: 610_123 }];
  const { chart, module, tooltip, state, bind } = homeTrendFixture(rows);
  const count = tooltip.querySelector('[data-home-activity-tooltip-count]');

  chart.fire('pointerenter', { clientX: 20 });
  assert.equal(count.textContent, '610.1K');
  assert.equal(count.getAttribute('aria-hidden'), 'true');
  assert.equal(tooltip.querySelector('.token-number-reading')?.textContent, '610,123');
  assert.match(module.getAttribute('aria-label'), /610,123 tokens/);

  state.settings = { compactTokenUnits: 'localized' };
  bind(rows);
  assert.equal(count.textContent, '61萬');
  module.fire('keydown', { target: module, key: 'Home', preventDefault() {} });
  assert.equal(tooltip.querySelector('.token-number-reading').textContent, '610,123');

  state.settings.showExactHomeTrendTokens = true;
  bind(rows);
  assert.equal(count.textContent, '610,123');

  state.settings.showExactHomeTrendTokens = false;
  bind(rows);
  assert.equal(count.textContent, '61萬');
});

test('opening Settings dismisses focused Home trend details before refreshing the panel', () => {
  const { module, chart, tooltip, context } = homeTrendFixture();
  module.fire('focusin', { target: module });
  assert.equal(tooltip.dataset.visible, 'true');
  context.els.settingsPanel = new Element();
  context.els.shell = new Element();
  context.syncPluginLimitsDemand = () => {};
  context.syncSettingsForm = () => assert.equal(tooltip.dataset.visible, 'false');
  context.ensureServiceStatusTicker = () => {};
  context.requestAnimationFrame = callback => callback();
  vm.runInNewContext(source.slice(source.indexOf('function openSettingsPanel('),
    source.indexOf('function openViewFromTray(')), context);
  context.openSettingsPanel();
  assert.equal(chart.getAttribute('data-active'), null);
});

test('Home trend cost follows the display currency and leaves the date on the last line', () => {
  const { chart, tooltip, state } = homeTrendFixture();
  state.settings = { currency: 'HKD' };
  chart.fire('pointerenter', { clientX: 20 });
  assert.equal(visibleHomeTrendText(tooltip), '100tokensHK$9.752026-10-21');
  const cost = tooltip.querySelector('.home-trend-tooltip-cost');
  assert.equal(cost.hidden, false);
  chart.fire('pointermove', { clientX: 320 });
  assert.equal(cost.hidden, true);
  assert.equal(visibleHomeTrendText(tooltip), '40tokens2026-10-23');
});

test('Home trend module exposes day selection by keyboard without changing Enter navigation', () => {
  const { module, chart, tooltip, bind, context, escape } = homeTrendFixture();
  module.fire('focusin', { target: module });
  assert.equal(visibleHomeTrendText(tooltip), '40tokens2026-10-23');
  assert.match(module.getAttribute('aria-label'), /Activity.*Trend.*40 tokens.*2026-10-23/);
  assert.equal(module.getAttribute('aria-keyshortcuts'), 'ArrowLeft ArrowRight Home End');
  let prevented = 0;
  const press = key => module.fire('keydown', { target: module, key, preventDefault: () => { prevented++; } });
  press('Home');
  assert.equal(visibleHomeTrendText(tooltip), '100tokens$1.25002026-10-21');
  press('ArrowRight');
  assert.equal(visibleHomeTrendText(tooltip), '0tokens$0.00002026-10-22');
  chart.fire('pointermove', { clientX: 320 });
  chart.fire('pointerleave');
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(chart.getAttribute('data-active'), null);
  press('Home');
  assert.equal(tooltip.dataset.visible, 'true');
  assert.equal(visibleHomeTrendText(tooltip), '100tokens$1.25002026-10-21');
  press('End');
  assert.equal(visibleHomeTrendText(tooltip), '40tokens2026-10-23');
  bind([
    { date: '2026-10-22', tokens: 0, cost: 0 },
    { date: '2026-10-23', tokens: 55, cost: 2 },
    { date: '2026-10-24', tokens: 7, cost: 0.1 }
  ]);
  assert.equal(visibleHomeTrendText(tooltip), '55tokens$2.00002026-10-23');
  press('Enter');
  assert.equal(prevented, 4);
  escape();
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(module.getAttribute('aria-label'), 'Activity');
  module.fire('focusout', { target: module });
  assert.equal(tooltip.getAttribute('aria-hidden'), 'true');
  assert.equal(Object.values(module.handlers).flat().length, 3);
  context.hideHomeTrendTooltip();
});

test('document Escape dismisses Home trend hover even when Activity never took focus', () => {
  const { chart, tooltip, escape } = homeTrendFixture();
  chart.fire('pointerenter', { clientX: 170 });
  assert.equal(tooltip.dataset.visible, 'true');
  escape();
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(chart.getAttribute('data-active'), null);
});

test('window blur dismisses a focused Home trend reading', () => {
  const { chart, module, tooltip, context } = homeTrendFixture();
  module.fire('focusin', { target: module });
  assert.equal(tooltip.dataset.visible, 'true');
  const listeners = [...source.matchAll(/window\.addEventListener\('blur', (\w+)\);/g)];
  for (const [, name] of listeners) context[name]?.();
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(chart.getAttribute('data-active'), null);
});

test('unavailable period hides a visible Home trend tooltip with the panel', () => {
  const { chart, tooltip, context } = homeTrendFixture();
  chart.fire('pointerenter', { clientX: 170 });
  const panel = () => new Element();
  context.els = {
    fixedPeriodMessage: panel(), homePanel: panel(), breakdown: panel(), serviceStatusPanel: panel(),
    limitsPanel: panel(), trendsPanel: panel(), sessionDetail: panel(), sessionDetailHead: panel(),
    sessionSearchHost: panel()
  };
  context.renderSessionPager = () => {};
  vm.runInNewContext(hidePeriodContent, context);
  context.hidePeriodContentForMessage('Loading');
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(chart.getAttribute('data-active'), null);
});

test('Home panel scroll dismisses keyboard details and chart replacement removes its listener', () => {
  const { module, homePanel, context, tooltip } = homeTrendFixture();
  module.fire('focusin', { target: module });
  assert.equal(tooltip.dataset.visible, 'true');
  homePanel.fire('scroll');
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(module.getAttribute('aria-label'), 'Activity');
  module.fire('keydown', { target: module, key: 'ArrowLeft', preventDefault() {} });
  assert.equal(visibleHomeTrendText(tooltip), '0tokens$0.00002026-10-22');
  assert.equal(tooltip.dataset.visible, 'true');
  assert.equal((homePanel.handlers.scroll || []).length, 1);
  const chart = new Element(); chart.className = 'home-area-chart'; chart.closest = () => module;
  const svg = new Element(); svg.className = 'area-line';
  svg.bounds = { left: 20, top: 100, width: 300, height: 70 };
  const crosshair = new Element(); crosshair.className = 'home-trend-crosshair';
  const marker = new Element(); marker.className = 'home-trend-marker';
  chart.append(svg, crosshair, marker);
  const rows = [{ date: '2026-10-24', tokens: 7, cost: 0.1 }];
  context.bindHomeTrendTooltip(chart, charts.areaLineChart(rows, { width: 300, height: 70 }), rows);
  assert.equal(Object.values(module.handlers).flat().length, 3);
  assert.equal((homePanel.handlers.scroll || []).length, 1);
  module.fire('focusin', { target: module });
  assert.equal(visibleHomeTrendText(tooltip), '7tokens$0.10002026-10-24');
});
