'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const charts = require('../../src/electron/renderer/usageCharts');
const {
  clientColors, modelVendorFor, modelColor, clampDaily,
  dailyBarsChart, candleChart, contribHeatmap, statsCards,
  barsChartSvg, candleChartSvg, heatmapSvg, statsCardsHtml, statCardColumnWidths
} = charts;

test('usageCharts exports every symbol app.js destructures from it', () => {
  // Guards against a renderer ReferenceError that node --check / unit tests cannot
  // see because app.js is never executed (it needs the DOM).
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  const m = /const \{ ([^}]+) \} = window\.TokenMonitorUsageCharts;/.exec(app);
  assert.ok(m, 'app.js should destructure from window.TokenMonitorUsageCharts');
  for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.ok(name in charts, `usageCharts must export "${name}" (app.js destructures it)`);
  }
});

test('clientColors carries the known palette and a default', () => {
  assert.equal(clientColors.claude, '#cc7c5e');
  assert.equal(clientColors.codex, '#49a3b0');
  assert.equal(clientColors.cline, '#323B43');
  assert.equal(clientColors.volcengine, '#006EFF');
  assert.equal(clientColors.qoder, '#2ADB5C');
  assert.equal(typeof clientColors.default, 'string');
});

test('modelVendorFor maps families and modelColor falls back deterministically', () => {
  assert.equal(modelVendorFor('claude-sonnet-4'), 'claude');
  assert.equal(modelVendorFor('gpt-5'), 'codex');
  assert.equal(modelVendorFor('doubao-seed-1.6'), 'doubao');
  assert.equal(modelColor('claude-opus'), clientColors.claude);
  assert.equal(modelColor('totally-unknown'), modelColor('totally-unknown')); // stable
});

test('clampDaily keeps the last N days, or all for falsy/all', () => {
  const daily = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, tokens: i }));
  assert.equal(clampDaily(daily, 7).length, 7);
  assert.equal(clampDaily(daily, 30).length, 30);
  assert.equal(clampDaily(daily, 'all').length, 40);
  assert.equal(clampDaily(daily, 0).length, 40);
  assert.deepEqual(clampDaily(daily, 7).map((d) => d.date).slice(0, 1), ['d33']);
});

test('barsChartSvg renders one rect per segment with colorFor fill and a per-bar title', () => {
  const model = dailyBarsChart(
    [{ date: '2026-06-01', perClient: { claude: { tokens: 10 }, codex: { tokens: 5 } } }],
    { width: 100, height: 100, padTop: 0, padRight: 0, padBottom: 0, padLeft: 0, gap: 0, stackBy: 'client', metric: 'tokens' }
  );
  const svg = barsChartSvg(model, {
    colorFor: (k) => clientColors[k] || clientColors.default,
    titleOf: (bar) => `total ${bar.total}`,
    axisLabel: () => ''
  });
  assert.match(svg, /^<svg /);
  assert.equal((svg.match(/class="bar-seg"/g) || []).length, 2); // one shape per stacked segment
  assert.match(svg, /<path d="M[\d.,\sLQZ-]+" fill="#49a3b0" class="bar-seg">/); // top segment gets a rounded-top cap
  assert.equal((svg.match(/class="bar-hover"/g) || []).length, 1); // plus a transparent hover overlay
  assert.match(svg, /fill="#cc7c5e"/);
  assert.match(svg, /<title>total 15<\/title>/);
});

test('barsChartSvg always emits a data-indexed hover target and draws y-axis ticks on request', () => {
  const model = dailyBarsChart(
    [{ date: '2026-06-01', perClient: { claude: { tokens: 10 } } }, { date: '2026-06-02', perClient: { claude: { tokens: 4 } } }],
    { width: 200, height: 120, stackBy: 'client', metric: 'tokens' }
  );
  // No titleOf -> still a hover rect carrying data-i (drives the custom tooltip).
  const plain = barsChartSvg(model, { colorFor: () => '#fff' });
  assert.match(plain, /class="bar-hover"/);
  assert.match(plain, /data-i="0"/);
  assert.match(plain, /data-i="1"/);
  assert.doesNotMatch(plain, /<title>/);
  // yTicks -> gridlines + y-axis labels.
  const withAxis = barsChartSvg(model, { colorFor: () => '#fff', yTicks: 4, formatTick: (v) => `${v}` });
  assert.equal((withAxis.match(/class="grid-line"/g) || []).length, 5); // 0..4 inclusive
  assert.match(withAxis, /class="axis-label y-axis"/);
});

test('candleChartSvg marks up/down candles and renders a wick + body each', () => {
  const model = candleChart(
    [{ date: '2026-06-01', tokens: 10 }, { date: '2026-06-07', tokens: 30 }],
    { width: 100, height: 100, padTop: 0, padRight: 0, padBottom: 0, padLeft: 0, gap: 0, metric: 'tokens' }
  );
  const svg = candleChartSvg(model, { titleOf: (c) => `o${c.open}c${c.close}`, axisLabel: () => '' });
  assert.match(svg, /candle-body candle-up/);
  assert.match(svg, /<line /);            // wick
  assert.match(svg, /<title>o10c30<\/title>/);
});

test('contribHeatmap spans a fixed window when startDate/endDate are given', () => {
  // Only two days of data, but the window forces a full month-plus grid.
  const model = contribHeatmap([{ date: '2026-06-01', intensity: 4 }], { cell: 10, gap: 2, startDate: '2026-05-01', endDate: '2026-06-07' });
  const dates = model.cells.map((c) => c.date);
  assert.ok(dates.includes('2026-05-01'), 'window start padded in');
  assert.ok(dates.includes('2026-06-07'), 'window end padded in');
  assert.equal(model.cells.find((c) => c.date === '2026-06-01').intensity, 4); // real data preserved
  assert.equal(model.cells.find((c) => c.date === '2026-05-15').intensity, 0); // empty day filled
  assert.ok(model.weeks >= 6);
});

test('heatmapSvg colors cells by intensity level class', () => {
  const model = contribHeatmap([{ date: '2026-06-01', intensity: 4 }, { date: '2026-06-02', intensity: 0 }], { cell: 10, gap: 2 });
  const svg = heatmapSvg(model, { titleOf: (c) => c.date });
  assert.match(svg, /heat lvl-4/);
  assert.match(svg, /heat lvl-0/);
  assert.match(svg, /data-d="2026-06-01"/); // drives the custom hover tooltip
  assert.match(svg, /<title>2026-06-01<\/title>/);
});

test('statsCardsHtml renders a card per descriptor with label + formatted value', () => {
  const cards = statsCards({ totalTokens: 1500, activeDays: 3, favoriteModel: 'opus', messages: 9 });
  const html = statsCardsHtml(cards, { label: (k) => k.toUpperCase(), format: (c) => String(c.value) });
  assert.match(html, /TOTALTOKENS/);
  assert.match(html, /class="dash-card"/);
  assert.equal((html.match(/dash-card"/g) || []).length, cards.length);
});

test('statCardColumnWidths keeps stat cards equal when content fits', () => {
  assert.deepEqual(statCardColumnWidths([90, 110, 120, 95], { totalWidth: 800 }), [200, 200, 200, 200]);
});

test('statCardColumnWidths borrows width only when content exceeds the average column', () => {
  const widths = statCardColumnWidths([120, 220, 104, 96], { totalWidth: 800, minWidth: 120 });
  assert.equal(widths.length, 4);
  assert.equal(Math.round(widths.reduce((sum, width) => sum + width, 0)), 800);
  assert.ok(widths[1] >= 220);
  assert.ok(widths[1] > widths[0]);
  assert.ok(widths[0] >= 190);
  assert.ok(widths[2] >= 190);
  assert.ok(widths[3] >= 190);
});
