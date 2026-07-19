'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  weekStartKey, dailyBarsChart, candleChart, computeHeatmapIntensities, contribHeatmap, statsCards, sparklinePreview,
  areaLineChart, areaLineSvg, heatmapSvg, rollingYearHeatmap
} = require('../../src/electron/renderer/usageCharts');

test('computeHeatmapIntensities derives independent metrics from raw values', () => {
  const daily = [
    { date: '2026-06-01', tokens: 100, cost: 1, intensity: 4, costIntensity: 4 },
    { date: '2026-06-02', tokens: 25, cost: 4, intensity: 1, costIntensity: 1 }
  ];
  const rows = computeHeatmapIntensities(daily);

  assert.deepEqual(rows.map((row) => row.tokenIntensity), [4, 2]);
  assert.deepEqual(rows.map((row) => row.costIntensity), [2, 4]);
  assert.deepEqual(rows.map((row) => row.intensity), [2, 4]);
  assert.equal(daily[0].tokenIntensity, undefined);
  assert.equal(daily[0].costIntensity, 4);
});

test('computeHeatmapIntensities handles preview rows with one empty metric', () => {
  const tokenOnly = computeHeatmapIntensities([{ date: 'a', tokens: 10, cost: 0 }]);
  assert.deepEqual(tokenOnly[0], { date: 'a', tokens: 10, cost: 0, intensity: 0, costIntensity: 0, tokenIntensity: 4 });
  const costOnly = computeHeatmapIntensities([{ date: 'a', tokens: 0, cost: 2 }]);
  assert.deepEqual(costOnly[0], { date: 'a', tokens: 0, cost: 2, intensity: 4, costIntensity: 4, tokenIntensity: 0 });
});

test('weekStartKey returns the Monday of the given date (UTC)', () => {
  assert.equal(weekStartKey('2026-06-08'), '2026-06-08'); // Monday -> itself
  assert.equal(weekStartKey('2026-06-07'), '2026-06-01'); // Sunday -> prior Monday
  assert.equal(weekStartKey('2026-06-03'), '2026-06-01'); // Wednesday -> Monday
});

const BAR_OPTS = { width: 100, height: 100, padTop: 0, padRight: 0, padBottom: 0, padLeft: 0, gap: 0 };

test('dailyBarsChart stacks segments bottom-up in global key order, scaled to max total', () => {
  const series = [
    { date: 'd1', perClient: { claude: { tokens: 50 }, codex: { tokens: 50 } } }, // total 100 (the max)
    { date: 'd2', perClient: { claude: { tokens: 25 } } }                          // total 25
  ];
  const c = dailyBarsChart(series, { ...BAR_OPTS, stackBy: 'client', metric: 'tokens' });

  assert.equal(c.maxTotal, 100);
  assert.deepEqual(c.keys, ['claude', 'codex']); // claude 75 total > codex 50
  assert.equal(c.bars.length, 2);

  const b0 = c.bars[0];
  assert.equal(b0.label, 'd1');
  assert.equal(b0.x, 0);
  assert.equal(b0.width, 50);
  assert.equal(b0.total, 100);
  assert.deepEqual(b0.segments[0], { key: 'claude', value: 50, x: 0, width: 50, y: 50, height: 50 });
  assert.deepEqual(b0.segments[1], { key: 'codex', value: 50, x: 0, width: 50, y: 0, height: 50 });

  const b1 = c.bars[1];
  assert.equal(b1.x, 50);
  assert.deepEqual(b1.segments, [{ key: 'claude', value: 25, x: 50, width: 50, y: 75, height: 25 }]);
});

test('dailyBarsChart tolerates empty series', () => {
  const c = dailyBarsChart([], BAR_OPTS);
  assert.deepEqual(c.bars, []);
  assert.deepEqual(c.keys, []);
  assert.equal(c.maxTotal, 1); // never divides by zero
});

test('candleChart groups days into bucketDays-wide OHLC candles anchored to the latest day', () => {
  // 9 consecutive days, values 1..9, bucketed 3-at-a-time anchored to 06-09:
  //   [06-01,02,03] [06-04,05,06] [06-07,08,09]
  const daily = Array.from({ length: 9 }, (_, i) => ({ date: `2026-06-0${i + 1}`, tokens: i + 1 }));
  const c = candleChart(daily, { width: 100, height: 100, padTop: 0, padRight: 0, padBottom: 0, padLeft: 0, gap: 0, metric: 'tokens', bucketDays: 3 });

  assert.equal(c.bucketDays, 3);
  assert.equal(c.maxVal, 9);
  assert.equal(c.candles.length, 3);

  const b0 = c.candles[0]; // oldest bucket, left-most
  assert.deepEqual([b0.key, b0.endKey, b0.days], ['2026-06-01', '2026-06-03', 3]);
  assert.deepEqual([b0.open, b0.high, b0.low, b0.close, b0.up], [1, 3, 1, 3, true]);

  const b2 = c.candles[2]; // newest bucket, right-most
  assert.deepEqual([b2.key, b2.endKey], ['2026-06-07', '2026-06-09']);
  assert.deepEqual([b2.open, b2.high, b2.low, b2.close], [7, 9, 7, 9]);
  assert.equal(b2.yHigh, 0); // high == maxVal → top of plot
});

test('candleChart high/low protrude past the body when a mid-bucket day spikes', () => {
  // open=1, close=2, but the middle day spikes to 9 → upper wick reaches 9.
  const daily = [
    { date: '2026-06-07', tokens: 1 },
    { date: '2026-06-08', tokens: 9 },
    { date: '2026-06-09', tokens: 2 }
  ];
  const c = candleChart(daily, { metric: 'tokens', bucketDays: 3 });
  assert.equal(c.candles.length, 1);
  assert.deepEqual(
    [c.candles[0].open, c.candles[0].high, c.candles[0].low, c.candles[0].close],
    [1, 9, 1, 2]
  );
  assert.ok(c.candles[0].high > Math.max(c.candles[0].open, c.candles[0].close)); // real wick
});

test('candleChart tolerates empty input', () => {
  const c = candleChart([], { metric: 'tokens' });
  assert.deepEqual(c.candles, []);
  assert.equal(c.maxVal, 1);
});

test('contribHeatmap lays days on a Sunday-started week grid, filling gaps with 0', () => {
  const daily = [
    { date: '2026-06-01', intensity: 4 }, // Mon -> col 0, row 1
    { date: '2026-06-07', intensity: 2 }, // Sun -> col 1, row 0
    { date: '2026-06-08', intensity: 1 }  // Mon -> col 1, row 1
  ];
  const h = contribHeatmap(daily, { cell: 11, gap: 2 });

  assert.equal(h.cells.length, 9);   // 05-31 (prior Sunday) .. 06-08 inclusive
  assert.equal(h.weeks, 2);

  const byDate = Object.fromEntries(h.cells.map((c) => [c.date, c]));
  assert.deepEqual(
    { col: byDate['2026-06-01'].col, row: byDate['2026-06-01'].row, intensity: byDate['2026-06-01'].intensity, x: byDate['2026-06-01'].x, y: byDate['2026-06-01'].y },
    { col: 0, row: 1, intensity: 4, x: 0, y: 13 }
  );
  assert.equal(byDate['2026-05-31'].row, 0);     // grid starts on the prior Sunday
  assert.equal(byDate['2026-06-07'].col, 1);
  assert.equal(byDate['2026-06-07'].row, 0);
  assert.equal(byDate['2026-06-07'].tokens, 0);
  assert.equal(byDate['2026-06-08'].col, 1);
  assert.equal(byDate['2026-06-08'].x, 13);
  assert.equal(byDate['2026-06-03'].intensity, 0); // gap day filled with 0
  // June is labelled at the column that contains the 1st (col 0 here), so the first
  // month sits flush at the grid's left edge; cell/gap are exposed for label placement.
  assert.deepEqual(h.monthLabels, [{ col: 0, label: '2026-06' }]);
  assert.equal(h.cell, 11);
  assert.equal(h.gap, 2);
});

test('contribHeatmap carries daily token values for hover titles', () => {
  const h = contribHeatmap([{ date: '2026-06-01', intensity: 4, tokens: 1234, cost: 0.5 }], { cell: 11, gap: 2 });
  const cell = h.cells.find((c) => c.date === '2026-06-01');
  assert.equal(cell.tokens, 1234);
  assert.equal(cell.cost, 0.5);
});

test('contribHeatmap tolerates empty input', () => {
  const h = contribHeatmap([], {});
  assert.deepEqual(h.cells, []);
  assert.equal(h.weeks, 0);
});

test('heatmapSvg scales its corner radius for compact variants', () => {
  const svg = heatmapSvg({
    width: 9,
    height: 9,
    cell: 9,
    gap: 3,
    cells: [{ date: '2026-06-22', intensity: 4, x: 0, y: 0, size: 9 }],
    monthLabels: []
  }, { radius: 2 });

  assert.match(svg, /rx="2"/);
});

test('heatmapSvg embeds escaped per-cell titles when supplied', () => {
  const svg = heatmapSvg({
    width: 9,
    height: 9,
    cell: 9,
    gap: 3,
    cells: [{ date: '2026-06-22', intensity: 4, tokens: 1234, x: 0, y: 0, size: 9 }],
    monthLabels: []
  }, { titleOf: (cell) => `${cell.date} < ${cell.tokens}` });

  assert.match(svg, /<title>2026-06-22 &lt; 1234<\/title>/);
});

test('heatmapSvg can include a glow filter for hovered cells', () => {
  const svg = heatmapSvg({
    width: 9,
    height: 9,
    cell: 9,
    gap: 3,
    cells: [{ date: '2026-06-22', intensity: 4, tokens: 1234, x: 0, y: 0, size: 9 }],
    monthLabels: []
  }, { glowFilterId: 'homeActivityHeatGlow' });

  assert.match(svg, /<defs><filter id="homeActivityHeatGlow"/);
  assert.match(svg, /<feDropShadow/);
});

test('heatmapSvg can include a spotlight layer with cell data attributes', () => {
  const svg = heatmapSvg({
    width: 9,
    height: 9,
    cell: 9,
    gap: 3,
    cells: [{ date: '2026-06-22', intensity: 4, tokens: 1234, cost: 0.25, x: 0, y: 0, size: 9 }],
    monthLabels: []
  }, { spotlightId: 'homeActivitySpotlight' });

  assert.match(svg, /id="homeActivitySpotlightGradient"/);
  assert.match(svg, /id="homeActivitySpotlightMask"/);
  assert.match(svg, /class="heat-base-layer"/);
  assert.match(svg, /class="heat-bright-layer"/);
  assert.match(svg, /data-d="2026-06-22"/);
  assert.match(svg, /data-t="1234"/);
});

test('statsCards returns ordered descriptors with kinds and coerced values', () => {
  const cards = statsCards({
    totalTokens: 100, totalCost: 1.5, activeDays: 3, currentStreak: 2,
    activeTimeMs: 3600000, longestStreak: 5, peakDayTokens: 40, favoriteModel: 'opus', messages: 12
  });
  assert.deepEqual(cards.map((c) => c.key),
    ['totalTokens', 'totalCost', 'activeDays', 'currentStreak', 'activeTimeMs', 'peakDayTokens', 'favoriteModel', 'messages']);
  assert.deepEqual(cards[0], { key: 'totalTokens', kind: 'tokens', value: 100 });
  assert.deepEqual(cards.find((c) => c.key === 'activeTimeMs'), { key: 'activeTimeMs', kind: 'duration', value: 3600000 });
  assert.equal(cards.find((c) => c.key === 'longestStreak'), undefined);
  assert.deepEqual(cards.find((c) => c.key === 'favoriteModel'), { key: 'favoriteModel', kind: 'model', value: 'opus' });
  assert.deepEqual(cards.find((c) => c.key === 'messages'), { key: 'messages', kind: 'count', value: 12 });
});

test('statsCards coerces a missing/empty summary to zeros and empty model', () => {
  const cards = statsCards(undefined);
  assert.equal(cards.find((c) => c.key === 'totalTokens').value, 0);
  assert.equal(cards.find((c) => c.key === 'favoriteModel').value, '');
});

test('sparklinePreview builds scaled mini bars and flags the last one', () => {
  const points = [{ tokens: 10 }, { tokens: 20 }, { tokens: 5 }];
  const s = sparklinePreview(points, { width: 30, height: 10, gap: 0, metric: 'tokens' });

  assert.equal(s.maxVal, 20);
  assert.equal(s.bars.length, 3);
  assert.deepEqual(s.bars[1], { value: 20, x: 10, width: 10, y: 0, height: 10, last: false });
  assert.equal(s.bars[0].height, 5);  // 10/20 * 10
  assert.equal(s.bars[0].y, 5);
  assert.equal(s.bars[2].last, true);
});

test('sparklinePreview tolerates empty input', () => {
  const s = sparklinePreview([], {});
  assert.deepEqual(s.bars, []);
  assert.equal(s.maxVal, 1);
});

test('areaLineChart maps daily values into bounded points and paths', () => {
  const model = areaLineChart([
    { date: '2026-06-01', tokens: 10 },
    { date: '2026-06-02', tokens: 20 },
    { date: '2026-06-03', tokens: 0 }
  ], { width: 120, height: 60, padTop: 0, padRight: 0, padBottom: 0, padLeft: 0, metric: 'tokens' });

  assert.equal(model.maxVal, 20);
  assert.equal(model.points.length, 3);
  assert.deepEqual(model.points.map((p) => p.value), [10, 20, 0]);
  assert.ok(model.linePath.startsWith('M'));
  assert.ok(model.areaPath.endsWith('Z'));
  assert.ok(model.points.every((p) => p.y >= 0 && p.y <= 60));
});

test('areaLineSvg renders line and filled area paths', () => {
  const model = areaLineChart([{ date: '2026-06-01', tokens: 5 }], { width: 80, height: 40 });
  const svg = areaLineSvg(model);
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 80 40"/);
  assert.match(svg, /class="area-line-fill"/);
  assert.match(svg, /class="area-line-stroke"/);
  // The fill is a blue vertical gradient (defined in styles.css), not the accent slab.
  assert.match(svg, /<linearGradient id="area-line-grad"/);
  assert.match(svg, /fill="url\(#area-line-grad\)"|class="area-line-fill"/);
});

test('areaLineChart can smooth a compact trend path', () => {
  const model = areaLineChart([
    { date: '2026-06-01', tokens: 10 },
    { date: '2026-06-02', tokens: 30 },
    { date: '2026-06-03', tokens: 15 }
  ], { width: 120, height: 60, curve: true });

  assert.match(model.linePath, / C/);
  assert.match(model.areaPath, / C/);
});

test('rollingYearHeatmap keeps a full 12-month, seven-row grid at normal cell size', () => {
  const model = rollingYearHeatmap([
    { date: '2025-07-01', intensity: 1 },
    { date: '2026-06-20', intensity: 4 }
  ], { endDate: '2026-06-20', cell: 8, gap: 3 });

  assert.equal(model.height, 74);
  assert.ok(model.weeks >= 51 && model.weeks <= 54);
  assert.ok(model.width > 500);
  assert.equal(model.monthLabels.length, 12);
  assert.ok(model.cells.every((cell) => cell.row >= 0 && cell.row < 7));
});

const { selectPreviewSeries, patchTodayBar, sparklineSvg } = require('../../src/electron/renderer/usageCharts');

const PREVIEW = {
  daily: [
    { date: '2026-05-31', tokens: 1, cost: 0 },
    { date: '2026-06-01', tokens: 2, cost: 0 }, { date: '2026-06-02', tokens: 3, cost: 0 },
    { date: '2026-06-03', tokens: 4, cost: 0 }, { date: '2026-06-04', tokens: 5, cost: 0 },
    { date: '2026-06-05', tokens: 6, cost: 0 }, { date: '2026-06-06', tokens: 7, cost: 0 },
    { date: '2026-06-07', tokens: 8, cost: 0 }, { date: '2026-06-08', tokens: 9, cost: 0 }
  ],
  monthly: [{ month: '2026-05', tokens: 50, cost: 0 }, { month: '2026-06', tokens: 44, cost: 0 }]
};

test('selectPreviewSeries maps period to the right points', () => {
  const day = selectPreviewSeries(PREVIEW, 'today');
  assert.equal(day.points.length, 7);                       // last 7 daily
  assert.deepEqual(day.points.map((p) => p.date), ['2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08']);

  const month = selectPreviewSeries(PREVIEW, 'month');
  assert.deepEqual(month.points.map((p) => p.date), ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08']);

  const total = selectPreviewSeries(PREVIEW, 'allTime');
  assert.deepEqual(total.points.map((p) => p.month), ['2026-05', '2026-06']);
});

test('patchTodayBar overwrites the last point tokens with the live total', () => {
  const points = [{ date: 'a', tokens: 1 }, { date: 'b', tokens: 2 }];
  const out = patchTodayBar(points, 99);
  assert.deepEqual(out[1], { date: 'b', tokens: 99 });
  assert.equal(points[1].tokens, 2);          // original not mutated
  assert.deepEqual(patchTodayBar([], 99), []); // empty safe
});

test('sparklineSvg renders one rect per bar and marks the last', () => {
  const model = sparklinePreview([{ tokens: 1 }, { tokens: 2 }], { width: 20, height: 10, gap: 0, metric: 'tokens' });
  const svg = sparklineSvg(model);
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 20 10"/);
  assert.equal((svg.match(/<rect /g) || []).length, 2);
  assert.match(svg, /spark-bar--last/);
  assert.doesNotMatch(svg, /<title>/); // no titles unless provided
});

test('sparklineSvg embeds per-bar hover titles when supplied and escapes them', () => {
  const model = sparklinePreview([{ tokens: 1 }, { tokens: 2 }], { width: 20, height: 10, gap: 0, metric: 'tokens' });
  const svg = sparklineSvg(model, { titles: ['6/7 · 1', 'a<b&c'] });
  assert.match(svg, /<title>6\/7 · 1<\/title>/);
  assert.match(svg, /<title>a&lt;b&amp;c<\/title>/);
});
