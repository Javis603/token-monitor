'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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

test('unpriced counts missing from attribution maps stay on the remainder row', () => {
  const rows = attributionRows({}, {}, {
    totalValue: 50,
    totalUnpricedTokens: 50
  });

  assert.deepEqual(rows, [
    {
      key: UNATTRIBUTED_KEY,
      value: 50,
      cost: 0,
      unpricedTokens: 50,
      unattributed: true
    }
  ]);

  const zeroValueRemainder = attributionRows({ codex: 100 }, { codex: 1 }, {
    totalValue: 100,
    totalCost: 1,
    totalUnpricedTokens: 50
  });
  assert.equal(zeroValueRemainder.at(-1).unpricedTokens, 50);
  assert.deepEqual(
    visibleAttributionRows(zeroValueRemainder, (value) => `$${Number(value || 0).toFixed(4)}`),
    zeroValueRemainder
  );
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
  assert.match(app, /periodAttributionRows\(period, period\?\.clients, period\?\.clientCosts, period\?\.clientUnpricedTokens\)/);
  assert.match(app, /periodAttributionRows\(period, period\?\.models, period\?\.modelCosts, period\?\.modelUnpricedTokens\)/);
  assert.match(app, /visibleAttributionRows\(rows, formatCost\)/);
  assert.match(app, /attributionValue\(/);
  assert.match(app, /totalUnpricedTokens:\s*period\?\.unpricedTokens/);
  assert.match(app, /cost:\s*Number\(period\.costUsd \|\| 0\),\s*unpricedTokens:\s*Number\(period\.unpricedTokens \|\| 0\),/);
});

test('Model settings expose and persist the ranking metric without changing the default', () => {
  const index = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');

  assert.match(index, /role="radiogroup" aria-labelledby="modelRankingMetricLabel"/);
  assert.match(index, /name="modelRankingMetric" value="tokens"[^>]*><span data-i18n="settings\.modelRanking\.tokens"/);
  assert.match(index, /name="modelRankingMetric" value="cost"[^>]*><span data-i18n="settings\.modelRanking\.cost"/);
  assert.match(main, /modelRankingMetric:\s*'tokens'/);
  assert.match(main, /normalizeRankingMetric\(merged\.modelRankingMetric\)/);
  assert.match(main, /modelRankingMetric: normalizeRankingMetric\(patch\.modelRankingMetric \?\? settings\.modelRankingMetric\)/);
  assert.match(app, /input\.checked = input\.value === modelRankingMetric/);
  assert.match(app, /saveSettings\(\{ modelRankingMetric: usageAttributionRowsApi\.normalizeRankingMetric\(input\.value\) \}\)/);
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


test('unknown prices show a missing subtotal instead of a free cost', () => {
  const { usageCostLabel } = require('../../src/electron/renderer/usageAttributionRows');
  const money = (value) => `$${value.toFixed(2)}`;
  const tokens = (value) => String(value);
  assert.equal(usageCostLabel(0, 200, money, tokens, 'unpriced tokens'), '— (200 unpriced tokens)');
  assert.equal(usageCostLabel(1.5, 200, money, tokens, 'unpriced tokens'), '$1.50 + 200 unpriced tokens');
  assert.equal(usageCostLabel(0, 0, money, tokens, 'unpriced tokens'), '$0.00');
  assert.equal(attributionRows({ unknown: 200 }, {}, { unpricedTokens: { unknown: 200 } })[0].unpricedTokens, 200);
});

test('compact costs retain missing-cost semantics without an inline token count', () => {
  const { compactUsageCostLabel } = require('../../src/electron/renderer/usageAttributionRows');
  const money = (value) => `$${value.toFixed(2)}`;
  assert.equal(compactUsageCostLabel(0, 200, money), '—');
  assert.equal(compactUsageCostLabel(1.5, 200, money), '$1.50 + ?');
  assert.equal(compactUsageCostLabel(1.5, 0, money), '$1.50');
});

test('unknown source requires complete Codex attribution and rejects mixed or missing attribution', () => {
  const { unknownModelSource } = require('../../src/electron/renderer/usageAttributionRows');
  assert.equal(unknownModelSource({ models: { unknown: 200 }, clientModels: { codex: { unknown: 200 } } }), 'codex');
  for (const clientModels of [undefined, {}, { codex: { unknown: 150 } },
    { codex: { unknown: 200 }, claude: { unknown: 10 } }, { opencode: { unknown: 200 } }]) {
    assert.equal(unknownModelSource({ models: { unknown: 200 }, clientModels }), null);
  }
  assert.equal(unknownModelSource({ models: { unknown: 0 }, clientModels: { codex: { unknown: 0 } } }), null);
});

test('headline tooltip follows unpriced usage and clears on priced or unavailable periods', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const body = app.slice(app.indexOf('function setTotalCost('), app.indexOf('function applyEffectiveCurrencyRates('));
  const cost = {
    classList: { toggle(_name, enabled) { cost.hasUnpriced = enabled; } },
    querySelector: (selector) => selector === '.usage-cost-info' ? cost.info : cost.label,
    replaceChildren(label) { this.label = label; },
    append(info) { this.info = info; }
  };
  const context = vm.createContext({
    els: { cost }, document: { createElement: () => ({}) },
    usageAttributionRowsApi: require('../../src/electron/renderer/usageAttributionRows'),
    formatCost: (value, missing) => `$${value.toFixed(2)}${missing > 0 ? ` + ${missing} unpriced tokens` : ''}`,
    formatNumber: String,
    t: (_key, { tokens }) => `${tokens} tokens excluded from the cost estimate`,
    limitWindowsView: { setDetailTooltip(element, entries) { element.tooltip = entries; } }
  });
  vm.runInContext(body, context);
  context.setTotalCost(1.5, 200);
  assert.equal(cost.label.textContent, '$1.50');
  assert.equal(cost.hasUnpriced, true);
  assert.equal(cost.info.hidden, false);
  assert.equal(cost.info.tooltip.length, 1);
  assert.equal(cost.info.tooltip[0].full, '200 tokens excluded from the cost estimate');
  const label = cost.label;
  context.setTotalCost(0, 200);
  assert.equal(cost.label, label);
  assert.equal(cost.label.textContent, '—');
  context.setTotalCost(1.5, 0);
  assert.equal(cost.label.textContent, '$1.50');
  assert.equal(cost.info.tooltip, null);
  assert.equal(cost.info.hidden, true);
  assert.equal(cost.hasUnpriced, false);
  context.setTotalCost(1.5, 200, false);
  assert.equal(cost.label.textContent, '');
  assert.equal(cost.info.tooltip, null);
  assert.equal(cost.hasUnpriced, false);
});
