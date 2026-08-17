'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  attributionRows,
  visibleAttributionRows,
  attributionValue,
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

test('Tool and Model breakdowns consume the shared token-or-cost rows', () => {
  const index = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.ok(index.indexOf('usageAttributionRows.js') < index.indexOf('app.js'));
  assert.match(app, /periodAttributionRows\(period, period\?\.clients, period\?\.clientCosts\)/);
  assert.match(app, /periodAttributionRows\(period, period\?\.models, period\?\.modelCosts\)/);
  assert.match(app, /visibleAttributionRows\(rows, formatCost\)/);
  assert.match(app, /attributionValue\(/);
});
