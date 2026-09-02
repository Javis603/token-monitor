'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  filterListItems,
  listTextMatches,
  normalizeListQuery
} = require('../../src/electron/renderer/settingsListFilter');

const CLIENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'zai', label: 'z.ai' },
  { id: 'copilot', label: 'GitHub Copilot' }
];

const toText = ({ id, label }) => `${label} ${id}`;

test('an empty query normalizes away and keeps every item', () => {
  assert.equal(normalizeListQuery(''), '');
  assert.equal(normalizeListQuery('   '), '');
  assert.equal(normalizeListQuery(undefined), '');
  assert.deepEqual(filterListItems(CLIENTS, '  ', toText), CLIENTS);
});

test('matching is case-insensitive, trimmed, and a plain substring', () => {
  assert.ok(listTextMatches('Claude Code', '  CLAUDE '));
  assert.ok(listTextMatches('GitHub Copilot', 'hub cop'));
  assert.ok(!listTextMatches('Codex', 'cdx'), 'no fuzzy matching');
  assert.ok(!listTextMatches('Codex', 'codex code'), 'no token splitting');
});

test('the id is searchable alongside the label', () => {
  assert.deepEqual(filterListItems(CLIENTS, 'zai', toText).map((c) => c.id), ['zai']);
  assert.deepEqual(filterListItems(CLIENTS, 'z.ai', toText).map((c) => c.id), ['zai']);
});

test('filtering preserves the incoming display order', () => {
  assert.deepEqual(filterListItems(CLIENTS, 'co', toText).map((c) => c.id), ['claude', 'codex', 'copilot']);
});

test('a query with no match yields an empty list rather than the full one', () => {
  assert.deepEqual(filterListItems(CLIENTS, 'kiro', toText), []);
});

test('missing input is tolerated the way a first render supplies it', () => {
  assert.deepEqual(filterListItems(undefined, '', toText), []);
  assert.deepEqual(filterListItems(undefined, 'claude', toText), []);
  assert.ok(listTextMatches(undefined, ''));
  assert.ok(!listTextMatches(undefined, 'claude'));
});
