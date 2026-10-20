'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyModelClientBreakdown,
  clientSharesForModel,
  enrichModelRowWithClientBreakdown
} = require('../../src/electron/renderer/modelClientBreakdown');

const period = {
  models: { 'claude-opus-5-5': 1000, 'gpt-5': 400 },
  modelCosts: { 'claude-opus-5-5': 10, 'gpt-5': 2 },
  clientModels: {
    claude: { 'claude-opus-5-5': 600 },
    'claude-desktop': { 'claude-opus-5-5': 400 },
    cursor: { 'gpt-5': 400 }
  },
  clientModelCosts: {
    claude: { 'claude-opus-5-5': 6 },
    'claude-desktop': { 'claude-opus-5-5': 4 },
    cursor: { 'gpt-5': 2 }
  }
};

const clientLabels = {
  claude: 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor'
};
const clientColors = {
  claude: '#d97757',
  'claude-desktop': '#e3a587',
  cursor: '#73bdf5'
};

test('clientSharesForModel inverts clientModels including Claude Desktop', () => {
  const { clientTokens, clientCosts } = clientSharesForModel(period, 'claude-opus-5-5');
  assert.equal(clientTokens.claude, 600);
  assert.equal(clientTokens['claude-desktop'], 400);
  assert.equal(clientCosts.claude, 6);
  assert.equal(clientCosts['claude-desktop'], 4);
});

test('enrichModelRowWithClientBreakdown paints a segmented bar and legend', () => {
  const row = enrichModelRowWithClientBreakdown(
    { key: 'claude-opus-5-5', name: 'claude-opus-5-5', value: 1000, cost: 10, color: '#aaa' },
    period,
    { clientLabels, clientColors, unknownClientLabel: 'Unknown' }
  );
  assert.ok(String(row.barBackground).includes('linear-gradient'), row.barBackground);
  assert.ok(String(row.barBackground).includes('#d97757'));
  assert.ok(String(row.barBackground).includes('#e3a587'));
  assert.equal(row.accordionRows.length, 2);
  assert.equal(row.accordionRows[0].name, 'Claude Code');
  assert.equal(row.accordionRows[0].value, 600);
  assert.equal(row.accordionRows[0].cost, 6);
  assert.equal(row.accordionRows[1].name, 'Claude Desktop');
  assert.equal(row.accordionRows[1].value, 400);
});

test('applyModelClientBreakdown respects the enabled setting', () => {
  const rows = [
    { key: 'claude-opus-5-5', name: 'claude-opus-5-5', value: 1000, cost: 10, color: '#aaa' }
  ];
  const off = applyModelClientBreakdown(rows, period, { enabled: false, clientLabels, clientColors });
  assert.equal(off[0].barBackground, undefined);
  const on = applyModelClientBreakdown(rows, period, { enabled: true, clientLabels, clientColors });
  assert.ok(on[0].barBackground);
  assert.ok(on[0].accordionRows.length >= 2);
});

test('unattributed remainder becomes an Unknown segment when totals exceed shares', () => {
  const row = enrichModelRowWithClientBreakdown(
    { key: 'claude-opus-5-5', name: 'claude-opus-5-5', value: 1200, cost: 10, color: '#aaa' },
    period,
    { clientLabels, clientColors, unknownClientLabel: 'Unknown' }
  );
  const unknown = row.accordionRows.find((r) => r.key === 'unknown');
  assert.ok(unknown);
  assert.equal(unknown.value, 200);
  assert.equal(unknown.name, 'Unknown');
});

test('missing per-client attribution keeps the plain model bar (no Unknown segment)', () => {
  const row = { key: 'claude-opus-5-5', name: 'claude-opus-5-5', value: 1000, cost: 10, color: '#aaa' };
  const bare = { models: { 'claude-opus-5-5': 1000 } };
  assert.equal(enrichModelRowWithClientBreakdown(row, bare, { clientLabels, clientColors }), row);
  const fixed = { ...period, capabilities: { clientModels: false } };
  assert.equal(enrichModelRowWithClientBreakdown(row, fixed, { clientLabels, clientColors }), row);
  const other = { clientModels: { cursor: { 'gpt-5': 400 } } };
  assert.equal(enrichModelRowWithClientBreakdown(row, other, { clientLabels, clientColors }), row);
});
