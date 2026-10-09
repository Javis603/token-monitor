'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { buildLocalUsageView } = require('../../src/shared/providers/codex/localUsage');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');
const { parseGraphResult, normalizeHistory } = require('../../src/shared/history');

const rendererDir = path.resolve(__dirname, '../../src/electron/renderer');
function functionSource(file, first, next) {
  const source = fs.readFileSync(path.join(rendererDir, file), 'utf8');
  const start = source.indexOf(`function ${first}(`);
  assert.ok(start >= 0);
  const end = source.indexOf(next, start);
  assert.ok(end > start);
  return source.slice(start, end);
}

function dotsView(models) {
  const now = new Date(2026, 9, 7, 12);
  return buildLocalUsageView(models.map((model, i) => ({
    threadId: `dots-${i}`, model, observedAt: now.toISOString(), cwd: '/fixture',
    title: `Dots ${i}`, usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 100 }
  })), { now, projectIdentity: () => ({}), pricingByModel: {
    'gpt-test': { inputCostPerToken: 0.01, outputCostPerToken: 0.02 }
  } });
}

test('Dots catalog prices and missing tokens survive Dock period, provider and session projection', () => {
  for (const models of [['unknown'], ['gpt-test'], ['unknown', 'gpt-test']]) {
    const view = dotsView(models);
    const stats = { periods: { today: view.today, month: view.month, allTime: view.allTime } };
    const [period, provider, sessions] = buildEdgeDockCells(stats, { items: [
      { type: 'stat', metric: 'today' }, { type: 'limit', provider: 'codex' },
      { type: 'stat', metric: 'sessions' }
    ] });
    const missing = models.includes('unknown') ? 100 : 0;
    const cost = models.includes('gpt-test') ? 1.2 : 0;
    assert.ok(Math.abs(period.costUsd - cost) < 1e-9);
    assert.equal(period.unpricedTokens || 0, missing);
    assert.equal(period.clients[0].unpricedTokens || 0, missing);
    assert.equal(period.models.reduce((sum, row) => sum + (row.unpricedTokens || 0), 0), missing);
    assert.equal(provider.usage.today.unpricedTokens || 0, missing);
    assert.equal(sessions.sessions.reduce((sum, row) => sum + (row.unpricedTokens || 0), 0), missing);
  }
});

test('Dock keeps omissions in the existing tooltip and never prints zero for an entirely unpriced period', () => {
  const formatCost = (cost) => `$${cost.toFixed(2)}`;
  const nodes = [];
  const context = {
    el: (_tag, className, text) => ({ className, text, children: [], classList: { add() {} }, append(...children) { this.children.push(...children); } }),
    formatCost, formatCardTokens: String, t: (_key, params) => `${params.tokens} excluded`,
    limitWindowsView: { setDetailTooltip(node, entries) { node.entries = entries; nodes.push(node); } }
  };
  vm.runInNewContext(functionSource('edgeDock/dock.js', 'usageCostNode', '// Low and critical colours'), context);
  const unknown = context.usageCostNode('', { costUsd: 0, unpricedTokens: 100 });
  assert.equal(unknown.children[0].text, '—');
  const mixed = context.usageCostNode('', { costUsd: 1.2, unpricedTokens: 100 });
  assert.equal(mixed.children[0].text, '$1.20');
  assert.equal(nodes[1].entries[0].full, '100 excluded');
  const priced = context.usageCostNode('', { costUsd: 0 });
  assert.equal(priced.children[0].text, '$0.00');
  assert.equal(priced.children.length, 1);
});

test('Dashboard heat tooltip distinguishes known cost, missing price and a genuine zero rate', () => {
  const tooltip = {};
  const context = {
    state: { locale: 'en' }, els: { tooltip }, longDate: String, formatCompact: String,
    currencyApi: { normalizeCurrency: () => 'USD', formatCurrencyFromUsd: (cost) => `$${cost.toFixed(2)}` },
    t: (_key, params) => `${params.tokens} excluded`, positionTooltip() {}
  };
  vm.runInNewContext(functionSource('dashboard.js', 'formatCost', 'function formatCostCompact(')
    + functionSource('dashboard.js', 'showHeatTooltip', '\nlet refreshRunning'), context);
  const view = dotsView(['unknown']);
  const history = normalizeHistory(parseGraphResult(view.graph), { todayKey: '2026-10-07' });
  context.showHeatTooltip('2026-10-07', history.daily[0], {});
  assert.match(tooltip.innerHTML, /100 excluded/);
  assert.match(tooltip.innerHTML, /—/);
  assert.doesNotMatch(tooltip.innerHTML, /\$0\.00/);
  context.showHeatTooltip('2026-10-07', { tokens: 200, cost: 1.2, unpricedTokens: 100 }, {});
  assert.match(tooltip.innerHTML, /\$1\.20/);
  assert.match(tooltip.innerHTML, /100 excluded/);
  assert.equal(context.formatCost(0, 0), '$0.00');
});
