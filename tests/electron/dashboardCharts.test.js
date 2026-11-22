'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const charts = require('../../src/electron/renderer/usageCharts');
const {
  clientColors, fallbackModelColors, modelVendorFor, modelColor, clampDaily, dailyWindow,
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
  assert.equal(clientColors.cline, '#9D4EDD');
  assert.equal(clientColors.cherrystudio, '#EA5E5D');
  assert.equal(clientColors.commandcode, '#8C4EDD');
  assert.equal(clientColors.volcengine, '#006EFF');
  assert.equal(clientColors.qoder, '#2ADB5C');
  assert.equal(clientColors.ollama, '#888888');
  assert.equal(clientColors.hunyuan, '#0053E0');
  assert.equal(typeof clientColors.default, 'string');
});

test('fallbackModelColors never collides with a named provider color', () => {
  const providerColors = new Set(
    Object.entries(clientColors)
      .filter(([key]) => key !== 'default')
      .map(([, color]) => color.toLowerCase())
  );
  for (const color of fallbackModelColors) {
    assert.ok(!providerColors.has(color.toLowerCase()), `${color} collides with a named provider color`);
  }
});

test('modelVendorFor maps families and modelColor falls back deterministically', () => {
  assert.equal(modelVendorFor('claude-sonnet-4'), 'claude');
  assert.equal(modelVendorFor('gpt-5'), 'codex');
  assert.equal(modelVendorFor('muse-spark-1.2-contributor-free'), 'meta');
  assert.equal(modelVendorFor('muse-spark-1.3-contributor-free'), 'meta');
  assert.equal(modelVendorFor('opencode/muse-spark-1.3-contributor-free'), 'meta');
  assert.equal(modelVendorFor('muse-wonder-1.0'), 'meta');
  assert.equal(modelVendorFor('openrouter/muse-wonder-1.0'), 'meta');
  assert.equal(modelVendorFor('muse-glimmer'), 'meta');
  assert.equal(modelVendorFor('muse-image'), 'meta');
  assert.equal(modelVendorFor('muse-voice-transcribe'), 'meta');
  assert.equal(modelVendorFor('muse-spark-open'), 'meta');
  assert.equal(modelVendorFor('amuse-wonder-1.0'), null);
  assert.equal(modelVendorFor('muse-wonderful'), null);
  assert.equal(modelVendorFor('kimi-k2'), 'kimi');
  assert.equal(modelVendorFor('moonshot-v1'), 'kimi');
  assert.equal(modelVendorFor('k2d6-agent'), 'kimi');
  assert.equal(modelVendorFor('k3-agent'), 'kimi');
  assert.equal(modelVendorFor('k3-agent-swarm'), 'kimi');
  assert.equal(modelVendorFor('qmodel-38max'), 'qwen');
  assert.equal(modelVendorFor('qmodel_latest'), 'qwen');
  assert.equal(modelVendorFor('dashscope_qmodel'), 'qwen'); // via qmodel, not a dashscope alias
  assert.equal(modelVendorFor('dashscope_qwen3_coder'), 'qwen');
  assert.equal(modelVendorFor('dashscope_qwen_max_latest'), 'qwen');
  assert.equal(modelVendorFor('dashscope/kimi-k2'), 'kimi'); // must not be swallowed by a dashscope alias
  assert.equal(modelVendorFor('qwen3-max'), 'qwen');
  assert.equal(modelVendorFor('nemotron-70b-instruct'), 'nvidia');
  assert.equal(modelVendorFor('nvidia/nemotron-nano-9b-v2'), 'nvidia');
  assert.equal(modelColor('qmodel-38max'), clientColors.qwen);
  assert.equal(modelColor('nemotron-70b-instruct'), clientColors.nvidia);
  assert.equal(modelVendorFor('stepfun'), 'stepfun');
  assert.equal(modelVendorFor('step-2'), 'stepfun');
  assert.equal(modelVendorFor('step-1-flash'), 'stepfun');
  assert.equal(modelColor('step-2'), clientColors.stepfun);
  // Kimi's coding-plan catalog serves bare `k2`/`k3` ids with no `kimi` prefix,
  // and the token has to stay delimited so a name that merely contains one is
  // left unclassified.
  assert.equal(modelVendorFor('k3'), 'kimi');
  assert.equal(modelVendorFor('k3-256k'), 'kimi');
  assert.equal(modelVendorFor('kimi/k3-256k'), 'kimi');
  assert.equal(modelVendorFor('kimi-for-coding'), 'kimi');
  assert.equal(modelVendorFor('sk3-256k'), null);
  assert.equal(modelVendorFor('k3flash'), null);
  assert.equal(modelVendorFor('doubao-seed-1.6'), 'doubao');
  assert.equal(modelVendorFor('hy3'), 'hunyuan');
  assert.equal(modelVendorFor('hy4-preview'), 'hunyuan');
  assert.equal(modelVendorFor('hunyuan-t1'), 'hunyuan');
  // Thinking Machines Lab: bare Inkling ids, the OpenRouter vendor prefix, and
  // the spaced form — while a `-thinking` suffix alone must not match.
  assert.equal(modelVendorFor('inkling'), 'thinkingmachines');
  assert.equal(modelVendorFor('inkling-small'), 'thinkingmachines');
  assert.equal(modelVendorFor('inkling-2-small'), 'thinkingmachines');
  assert.equal(modelVendorFor('thinkingmachines/inkling'), 'thinkingmachines');
  assert.equal(modelVendorFor('thinking-machines/inkling'), 'thinkingmachines');
  assert.equal(modelVendorFor('acme-thinking'), null); // a `-thinking` suffix alone must not match
  assert.equal(modelColor('inkling-2-small'), clientColors.thinkingmachines);
  assert.equal(modelColor('claude-opus'), clientColors.claude);
  assert.equal(modelColor('hy3'), clientColors.hunyuan);
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

test('dailyWindow keeps every calendar day, so zero-usage days stay in the range', () => {
  const daily = [
    { date: '2026-06-01', tokens: 10, perClient: { claude: { tokens: 10 } } },
    { date: '2026-06-04', tokens: 30, perClient: { claude: { tokens: 30 } } }
  ];
  const window = dailyWindow(daily, { days: 7, todayKey: '2026-06-07' });

  assert.deepEqual(window.map((day) => day.date), [
    '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07'
  ]);
  assert.deepEqual(window.map((day) => day.tokens), [10, 0, 0, 30, 0, 0, 0]);
  assert.deepEqual(window.map((day) => day.hasRecord), [true, false, false, true, false, false, false]);
  assert.equal(window[0].perClient.claude.tokens, 10, 'recorded rows keep their attribution');
  assert.equal(window[1].perClient, undefined, 'a gap has no recorded attribution');
});

test('dailyWindow spans the whole recorded run through today, never just the rows', () => {
  const daily = [{ date: '2026-06-01', tokens: 10 }, { date: '2026-06-02', tokens: 5 }];
  assert.deepEqual(
    dailyWindow(daily, { days: 0, todayKey: '2026-06-04' }).map((day) => day.date),
    ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']
  );
  // A device whose local today is ahead of ours keeps its row instead of being cut off.
  assert.deepEqual(
    dailyWindow([{ date: '2026-06-09', tokens: 5 }], { days: 0, todayKey: '2026-06-07' }).map((day) => day.date),
    ['2026-06-09']
  );
  assert.deepEqual(dailyWindow([], { days: 7, todayKey: '2026-06-07' }), []);
});

test('dailyWindow ignores impossible calendar dates and retains a recorded zero', () => {
  const rows = [
    { date: '2026-02-29', tokens: 100 },
    { date: '2026-03-01', tokens: 0, messages: 1 },
    { date: '2026-13-01', tokens: 100 }
  ];
  const window = dailyWindow(rows, { days: 2, todayKey: '2026-03-02' });
  assert.deepEqual(window, [
    { date: '2026-03-01', tokens: 0, messages: 1, hasRecord: true },
    { date: '2026-03-02', tokens: 0, cost: 0, hasRecord: false }
  ]);
  const model = dailyBarsChart(window);
  assert.deepEqual(model.bars.map((bar) => [bar.total, bar.hasRecord]), [[0, true], [0, false]]);
  assert.deepEqual(dailyWindow([rows[0]], { todayKey: '2026-03-02' }), []);
});

test('candleChart preserves calendar slots and calculates OHLC from recorded days', () => {
  const week = [
    { date: '2026-06-01', tokens: 0, hasRecord: false },
    { date: '2026-06-02', tokens: 10 },
    { date: '2026-06-03', tokens: 0, hasRecord: false },
    { date: '2026-06-04', tokens: 30 },
    { date: '2026-06-05', tokens: 0, hasRecord: false },
    { date: '2026-06-06', tokens: 0, hasRecord: false },
    { date: '2026-06-07', tokens: 0, hasRecord: false }
  ];
  const options = { width: 100, height: 100, padTop: 0, padRight: 0, padBottom: 0, padLeft: 0, bucketDays: 7 };
  const model = candleChart(week, options);

  assert.equal(model.candles.length, 1);
  assert.deepEqual(
    [model.candles[0].open, model.candles[0].high, model.candles[0].low, model.candles[0].close],
    [10, 30, 10, 30],
    'missing days leave the bucket low unchanged'
  );
  assert.equal(model.candles[0].key, '2026-06-01');
  assert.equal(model.candles[0].endKey, '2026-06-07');
  assert.equal(model.candles[0].hasRecord, true);

  const weekWithZero = week.map((day) => day.date === '2026-06-03' ? { ...day, hasRecord: true } : day);
  assert.equal(candleChart(weekWithZero, options).candles[0].low, 0, 'a recorded zero counts towards OHLC');

  const gaps = week.map((day) => ({ ...day, tokens: 0, hasRecord: false }));
  const quiet = candleChart(gaps, options);
  assert.equal(quiet.candles.length, 1);
  assert.deepEqual([quiet.candles[0].open, quiet.candles[0].high, quiet.candles[0].low, quiet.candles[0].close], [0, 0, 0, 0]);
  assert.equal(quiet.candles[0].hasRecord, false);
  const quietSvg = candleChartSvg(quiet, { axisLabel: () => '' });
  assert.doesNotMatch(quietSvg, /candle-body/);
  assert.match(quietSvg, /class="bar-hover"/);

  const zero = candleChart([{ ...gaps[0], hasRecord: true }, ...gaps.slice(1)], options);
  assert.equal(zero.candles[0].hasRecord, true);
  assert.match(candleChartSvg(zero), /candle-body/);
});

test('barsChartSvg makes all 365 days hoverable at the narrow dashboard width', () => {
  const series = Array.from({ length: 365 }, (_, i) => ({ date: `day-${i}` }));
  const model = dailyBarsChart(series, { width: 532, padLeft: 52, padRight: 14, gap: 0.3 });
  const svg = barsChartSvg(model);
  const slots = [...svg.matchAll(/<rect data-i="\d+" x="([^"]+)" y="[^"]+" width="([^"]+)"[^>]+class="bar-hover"/g)];
  assert.equal(slots.length, 365);
  for (const [, x, width] of slots) {
    const left = Number(x);
    assert.ok(Math.ceil(left) < left + Number(width), `slot at ${left} needs a whole-pixel hover target`);
  }
});

test('barsChartSvg renders one rect per segment with colorFor fill and a per-bar description', () => {
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
  assert.match(svg, /class="bar-stack" data-motion-key="2026-06-01"/); // entry motion grows the whole stack from one baseline
  assert.match(svg, /<path d="M[\d.,\sLQZ-]+" fill="#49a3b0" class="bar-seg">/); // top segment gets a rounded-top cap
  assert.equal((svg.match(/class="bar-hover"/g) || []).length, 1); // plus a transparent hover overlay
  assert.match(svg, /fill="#cc7c5e"/);
  assert.match(svg, /<desc>total 15<\/desc>/);
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
  assert.doesNotMatch(plain, /<desc>/);
  // yTicks -> gridlines + y-axis labels.
  const withAxis = barsChartSvg(model, { colorFor: () => '#fff', yTicks: 4, formatTick: (v) => `${v}` });
  assert.equal((withAxis.match(/class="grid-line"/g) || []).length, 5); // 0..4 inclusive
  assert.match(withAxis, /class="axis-label y-axis"/);
});

test('candleChartSvg marks up/down candles and splits each wick from the body midpoint', () => {
  const model = candleChart(
    [{ date: '2026-06-01', tokens: 10 }, { date: '2026-06-07', tokens: 30 }],
    { width: 100, height: 100, padTop: 0, padRight: 0, padBottom: 0, padLeft: 0, gap: 0, metric: 'tokens' }
  );
  const svg = candleChartSvg(model, { titleOf: (c) => `o${c.open}c${c.close}`, axisLabel: () => '' });
  assert.match(svg, /candle-body candle-up/);
  assert.match(svg, /class="candle-stack" data-motion-key="2026-06-01"/);
  assert.match(svg, /candle-wick candle-wick-high candle-up/);
  assert.match(svg, /candle-wick candle-wick-low candle-up/);
  assert.match(svg, /<desc>o10c30<\/desc>/);
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
  assert.match(svg, /<desc>2026-06-01<\/desc>/);
});

test('heatmapSvg can hide entry cells in the initial SVG markup', () => {
  const model = contribHeatmap([{ date: '2026-06-01', intensity: 2 }], { cell: 10, gap: 2 });
  const svg = heatmapSvg(model, { initialHidden: true });
  assert.match(svg, /data-motion-hidden="true" opacity="0"/);
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
