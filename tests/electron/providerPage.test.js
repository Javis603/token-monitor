'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const page = require('../../src/electron/renderer/providerPage');
const { modelRowsForTool } = require('../../src/electron/renderer/toolDetails');

test('provider usage follows tool identity and preserves unpriced/model residuals', () => {
  const period = { clients: { droid: 100, claude: 200 }, clientCosts: { droid: 1, claude: 8 },
    clientUnpricedTokens: { droid: 30 }, clientModels: { droid: { 'claude-sonnet': 60 } },
    clientModelCosts: { droid: { 'claude-sonnet': 1 } },
    sessions: { a: { client: 'droid', projectLabel: 'Shared', totalTokens: 100 }, b: { client: 'claude', projectLabel: 'Shared', totalTokens: 200 } } };
  const result = page.providerUsage(period, 'factory', modelRowsForTool);
  assert.equal(result.totalTokens, 100);
  assert.equal(result.costUsd, 1);
  assert.equal(result.unpricedTokens, 30);
  assert.equal(result.models.reduce((sum, row) => sum + row.value, 0), 100);
  assert.deepEqual(result.projects, [{ name: 'Shared', value: 100 }]);
  assert.equal(result.sessions.length, 1);
  assert.equal(page.providerUsage(period, 'claude', modelRowsForTool).totalTokens, 200);
});

test('quota-only providers remain selectable without inventing usage', () => {
  const providers = [{ id: 'codex', label: 'Codex' }];
  assert.deepEqual(page.providerOptions({ providers, clients: [], enabledIds: ['codex'], stats: {} }), providers);
  assert.equal(page.providerUsage({}, 'codex', modelRowsForTool).available, false);
});

test('provider selection survives periods without current usage; client-only products are included', () => {
  const result = page.providerOptions({ providers: [{ id: 'factory', label: 'Factory' }],
    clients: [{ id: 'droid', label: 'Droid' }, { id: 'hermes', label: 'Hermes' }], enabledIds: [],
    stats: { periods: { today: {}, allTime: { clients: { droid: 100, hermes: 30 } } } } });
  assert.deepEqual(result.map(row => row.id), ['factory', 'hermes']);
});

test('unified activity retains session families and never counts group members twice', () => {
  const parent = { key: 'session:codex:p', value: 100, cost: 1 };
  const child = { key: 'session:codex:c', value: 30, cost: .3 };
  const family = { ...parent, key: 'family:p', subagentGroup: true, value: 130, cost: 1.3, groupRows: [parent, child], sortTime: 2 };
  const other = { key: 'session:codex:o', value: 50, cost: .5, sortTime: 1 };
  const groups = page.projectActivityGroups([family, other], {
    'codex:p': { projectLabel: 'App' }, 'codex:c': { projectLabel: 'App/worktree' }, 'codex:o': { projectLabel: 'App' }
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'App');
  assert.equal(groups[0].rows.length, 2);
  assert.equal(groups[0].rows[0], family);
  assert.equal(groups[0].value, 180);
});
test('cross-project review groups stay intact and unnamed activity stays separate', () => {
  const rows = [{ key: 'review', groupRows: [{ key: 'session:a' }, { key: 'session:b' }], value: 7 }, { key: 'session:c', value: 4 }];
  const groups = page.projectActivityGroups(rows, { a: { projectLabel: 'One' }, b: { projectLabel: 'Two' } });
  assert.equal(groups.length, 2);
  assert.equal(groups.find(g => g.multiple).rows[0], rows[0]);
  assert.equal(groups.reduce((sum, g) => sum + g.value, 0), 11);
});
