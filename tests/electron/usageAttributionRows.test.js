'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  attributionRows,
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

test('Tool and Model breakdowns consume the shared token-or-cost rows', () => {
  const index = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.ok(index.indexOf('usageAttributionRows.js') < index.indexOf('app.js'));
  assert.match(app, /attributionRows\(period\?\.clients, period\?\.clientCosts,/);
  assert.match(app, /attributionRows\(period\?\.models, period\?\.modelCosts,/);
  assert.match(app, /attributionValue\(/);
});
