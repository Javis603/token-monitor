'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  attributionRows,
  visibleAttributionRows,
  attributionValue,
  normalizeRankingMetric,
  rankRowsWithValues,
  rankingValue,
  UNATTRIBUTED_KEY
} = require('../../src/electron/renderer/usageAttributionRows');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

test('attribution rows retain a cost-only tool or model', () => {
  assert.deepEqual(attributionRows({ codex: 0 }, { codex: 2.5 }), [
    { key: 'codex', value: 0, cost: 2.5 }
  ]);
});

test('attribution rows use the union of token and cost keys', () => {
  assert.deepEqual(
    attributionRows({ codex: 100, claude: 50 }, { codex: 1.25, opencode: 0.5 }),
    [
      { key: 'codex', value: 100, cost: 1.25 },
      { key: 'claude', value: 50, cost: 0 },
      { key: 'opencode', value: 0, cost: 0.5 }
    ]
  );
});

test('attribution rows discard empty and invalid entries', () => {
  assert.deepEqual(
    attributionRows({ empty: 0, invalid: 'nope' }, { empty: 0, invalid: Infinity }),
    []
  );
});

test('attribution rows expose totals without a tool or model identity as Unclassified', () => {
  assert.deepEqual(
    attributionRows({ codex: 100 }, { codex: 1 }, { totalValue: 200, totalCost: 3 }),
    [
      { key: 'codex', value: 100, cost: 1 },
      { key: UNATTRIBUTED_KEY, value: 100, cost: 2, unattributed: true }
    ]
  );
  assert.equal(attributionValue({ codex: 60 }, 90, UNATTRIBUTED_KEY), 30);
  assert.equal(attributionValue({ codex: 60 }, 90, 'codex'), 60);
});

test('display rows hide a zero-token synthetic residual that formats as zero', () => {
  const rows = attributionRows(
    { codex: 100 },
    { codex: 1 },
    { totalValue: 100, totalCost: 1.000001 }
  );

  assert.deepEqual(
    visibleAttributionRows(rows, (value) => `$${Number(value || 0).toFixed(4)}`),
    [{ key: 'codex', value: 100, cost: 1 }]
  );
});

test('display rows hide zero-token synthetic residuals with a custom key', () => {
  const rows = attributionRows(
    { codex: 100 },
    { codex: 1 },
    { totalValue: 100, totalCost: 1.000001, unattributedKey: 'custom-unclassified' }
  );

  assert.deepEqual(
    visibleAttributionRows(rows, (value) => `$${Number(value || 0).toFixed(4)}`),
    [{ key: 'codex', value: 100, cost: 1 }]
  );
});

test('display rows retain meaningful synthetic and known cost-only rows', () => {
  const synthetic = attributionRows(
    { codex: 100 },
    { codex: 1 },
    { totalValue: 100, totalCost: 1.01 }
  );
  const knownCostOnly = attributionRows({ codex: 0 }, { codex: 2.5 });
  const formatCost = (value) => `$${Number(value || 0).toFixed(4)}`;

  assert.equal(visibleAttributionRows(synthetic, formatCost).at(-1).key, UNATTRIBUTED_KEY);
  assert.deepEqual(visibleAttributionRows(knownCostOnly, formatCost), [
    { key: 'codex', value: 0, cost: 2.5 }
  ]);
});

test('model ranking defaults to tokens and rejects unsupported metrics', () => {
  assert.equal(normalizeRankingMetric(undefined), 'tokens');
  assert.equal(normalizeRankingMetric('tokens'), 'tokens');
  assert.equal(normalizeRankingMetric('cost'), 'cost');
  assert.equal(normalizeRankingMetric('latency'), 'tokens');
});

test('cost ranking orders known costs first and uses tokens as a stable tie-break', () => {
  const rows = [
    { key: 'many-tokens-no-price', value: 9_000, cost: 0 },
    { key: 'lower-cost', value: 8_000, cost: 2 },
    { key: 'higher-cost-fewer-tokens', value: 500, cost: 8 },
    { key: 'higher-cost-more-tokens', value: 700, cost: 8 }
  ];

  assert.deepEqual(rankRowsWithValues(rows, 'cost').map((row) => row.key), [
    'higher-cost-more-tokens',
    'higher-cost-fewer-tokens',
    'lower-cost',
    'many-tokens-no-price'
  ]);
  assert.deepEqual(rows.map((row) => row.key), [
    'many-tokens-no-price',
    'lower-cost',
    'higher-cost-fewer-tokens',
    'higher-cost-more-tokens'
  ]);
});

test('cost ranking falls back to token order and token bars when no cost is known', () => {
  const rows = [
    { key: 'small', value: 10, cost: 0 },
    { key: 'large', value: 50 },
    { key: 'middle', value: 20, cost: Number.NaN }
  ];

  const rankedRows = rankRowsWithValues(rows, 'cost');
  assert.deepEqual(rankedRows.map((row) => row.key), ['large', 'middle', 'small']);
  assert.deepEqual(rankedRows.map((row) => row.barValue), [50, 20, 10]);
});

test('cost ranking ignores synthetic unattributed cost when deciding whether model costs are known', () => {
  const rows = [
    { key: UNATTRIBUTED_KEY, value: 10, cost: 12, unattributed: true },
    { key: 'known-model', value: 100, cost: 0 }
  ];

  assert.deepEqual(rankRowsWithValues(rows, 'cost').map((row) => row.key), [
    'known-model',
    UNATTRIBUTED_KEY
  ]);
});

test('ranked rows compute matching bar values without requiring a per-row source scan', () => {
  const rows = [
    { key: 'cheap', value: 10_000, cost: 1 },
    { key: 'expensive', value: 100, cost: 12 }
  ];

  assert.deepEqual(rankRowsWithValues(rows, 'cost').map(({ key, barValue }) => ({ key, barValue })), [
    { key: 'expensive', barValue: 12 },
    { key: 'cheap', barValue: 1 }
  ]);
});

test('cost bars use cost while token bars keep token volume', () => {
  const rows = [
    { key: 'cheap', value: 10_000, cost: 1 },
    { key: 'expensive', value: 100, cost: 12 }
  ];

  assert.equal(rankingValue(rows[0], 'tokens'), 10_000);
  assert.equal(rankingValue(rows[0], 'cost'), 1);
  assert.equal(rankingValue(rows[1], 'cost'), 12);
});

test('Tool and Model breakdowns consume the shared token-or-cost rows', () => {
  const index = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.ok(index.indexOf('usageAttributionRows.js') < index.indexOf('app.js'));
  assert.match(app, /periodAttributionRows\(period, period\?\.clients, period\?\.clientCosts\)/);
  assert.match(app, /periodAttributionRows\(period, period\?\.models, period\?\.modelCosts\)/);
  assert.match(app, /visibleAttributionRows\(rows, formatCost\)/);
  assert.match(app, /attributionValue\(/);
});

test('Model settings expose and persist the ranking metric without changing the default', () => {
  const index = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');

  assert.match(index, /id="modelRankingMetricInput"/);
  assert.match(index, /value="tokens"[^>]*data-i18n="settings\.modelRanking\.tokens"/);
  assert.match(index, /value="cost"[^>]*data-i18n="settings\.modelRanking\.cost"/);
  assert.match(main, /modelRankingMetric:\s*'tokens'/);
  assert.match(main, /normalizeRankingMetric\(merged\.modelRankingMetric\)/);
  assert.match(main, /modelRankingMetric: normalizeRankingMetric\(patch\.modelRankingMetric \?\? settings\.modelRankingMetric\)/);
  assert.match(app, /modelRankingMetricInput\.value\s*=\s*usageAttributionRowsApi\.normalizeRankingMetric/);
  assert.match(app, /saveSettings\(\{ modelRankingMetric: selection \}\)/);
});

test('Model rows use the selected ranking metric for order and bar scale', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');

  assert.match(app, /function modelRowsForPeriod\(period, rankingMetric = state\.settings\?\.modelRankingMetric\)/);
  assert.match(app, /rankRowsWithValues\(modelRows, rankingMetric\)/);
  assert.match(app, /unattributed/);
  assert.match(app, /const width = rowWidth\(barValue, max\)/);
  assert.match(app, /const max = barScaleMax\(rows\)/);
  assert.match(app, /homeModelRows\(modelRowsForPeriod\(period, 'tokens'\), period\?\.totalTokens, 5\)/);
});
