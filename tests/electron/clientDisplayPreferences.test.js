'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyClientDisplayPreferences,
  defaultClientDisplayPreferences,
  hasClientDisplayPreferences,
  moveClientDisplayOrder,
  movePinnedClient,
  normalizeClientDisplayOrder,
  normalizeHiddenClients,
  normalizePinnedClients,
  orderedClients,
  reorderClientDisplayOrder,
  reorderPinnedClient,
  togglePinnedClient
} = require('../../src/electron/renderer/clientDisplayPreferences');

const clients = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'hermes', label: 'Hermes Agent' },
  { id: 'opencode', label: 'OpenCode' }
];

test('normalizeClientDisplayOrder drops invalid entries and appends missing clients', () => {
  assert.deepEqual(
    normalizeClientDisplayOrder('hermes,unknown,hermes,codex', clients),
    ['hermes', 'codex', 'claude', 'opencode']
  );
});

test('normalizeHiddenClients keeps only known hidden clients', () => {
  assert.equal(normalizeHiddenClients('opencode,unknown,opencode,claude', clients), 'opencode,claude');
});

test('normalizePinnedClients keeps only known pinned clients', () => {
  assert.equal(normalizePinnedClients('hermes,unknown,hermes,codex', clients), 'hermes,codex');
});

test('orderedClients returns client objects in the saved display order', () => {
  assert.deepEqual(
    orderedClients(clients, 'hermes,codex').map((client) => client.id),
    ['hermes', 'codex', 'claude', 'opencode']
  );
});

test('orderedClients puts pinned clients first when full manual order is empty', () => {
  assert.deepEqual(
    orderedClients(clients, '', 'hermes,codex').map((client) => client.id),
    ['hermes', 'codex', 'claude', 'opencode']
  );
});

test('moveClientDisplayOrder swaps a client with its neighbor only when possible', () => {
  assert.equal(
    moveClientDisplayOrder('claude,codex,hermes,opencode', clients, 'hermes', 'up'),
    'claude,hermes,codex,opencode'
  );
  assert.equal(
    moveClientDisplayOrder('claude,codex,hermes,opencode', clients, 'claude', 'up'),
    'claude,codex,hermes,opencode'
  );
});

test('reorderClientDisplayOrder moves a client to a target index', () => {
  assert.equal(
    reorderClientDisplayOrder('claude,codex,hermes,opencode', clients, 'hermes', 0),
    'hermes,claude,codex,opencode'
  );
  assert.equal(
    reorderClientDisplayOrder('claude,codex,hermes,opencode', clients, 'claude', 99),
    'codex,hermes,opencode,claude'
  );
  assert.equal(
    reorderClientDisplayOrder('claude,codex,hermes,opencode', clients, 'unknown', 1),
    'claude,codex,hermes,opencode'
  );
});

test('togglePinnedClient appends new pins and removes existing pins', () => {
  assert.equal(togglePinnedClient('hermes', clients, 'codex'), 'hermes,codex');
  assert.equal(togglePinnedClient('hermes,codex', clients, 'hermes'), 'codex');
  assert.equal(togglePinnedClient('hermes', clients, 'unknown'), 'hermes');
});

test('movePinnedClient swaps a pinned client with its pinned neighbor only when possible', () => {
  assert.equal(movePinnedClient('hermes,codex,claude', clients, 'codex', 'up'), 'codex,hermes,claude');
  assert.equal(movePinnedClient('hermes,codex,claude', clients, 'hermes', 'up'), 'hermes,codex,claude');
  assert.equal(movePinnedClient('hermes,codex,claude', clients, 'opencode', 'up'), 'hermes,codex,claude');
});

test('reorderPinnedClient moves a pinned client within the pinned group', () => {
  assert.equal(reorderPinnedClient('hermes,codex,claude', clients, 'claude', 0), 'claude,hermes,codex');
  assert.equal(reorderPinnedClient('hermes,codex,claude', clients, 'hermes', 99), 'codex,claude,hermes');
  assert.equal(reorderPinnedClient('hermes,codex,claude', clients, 'opencode', 1), 'hermes,codex,claude');
});

test('applyClientDisplayPreferences preserves usage sort until a custom order is saved', () => {
  const rows = [
    { key: 'claude', value: 300 },
    { key: 'codex', value: 100 },
    { key: 'hermes', value: 20 }
  ];

  assert.deepEqual(
    applyClientDisplayPreferences(rows, '', 'codex', clients).map((row) => row.key),
    ['claude', 'hermes']
  );
});

test('applyClientDisplayPreferences pins selected clients and leaves the rest usage-sorted', () => {
  const rows = [
    { key: 'claude', value: 300 },
    { key: 'codex', value: 100 },
    { key: 'opencode', value: 60 },
    { key: 'hermes', value: 20 }
  ];

  assert.deepEqual(
    applyClientDisplayPreferences(rows, '', '', clients, 'hermes,codex').map((row) => row.key),
    ['hermes', 'codex', 'claude', 'opencode']
  );
  assert.deepEqual(
    applyClientDisplayPreferences(rows, '', 'hermes', clients, 'hermes,codex').map((row) => row.key),
    ['codex', 'claude', 'opencode']
  );
});

test('applyClientDisplayPreferences applies custom order and hides selected clients', () => {
  const rows = [
    { key: 'claude', value: 300 },
    { key: 'codex', value: 100 },
    { key: 'gemini', value: 50 },
    { key: 'hermes', value: 20 }
  ];

  assert.deepEqual(
    applyClientDisplayPreferences(rows, 'hermes,codex', 'claude', clients).map((row) => row.key),
    ['hermes', 'codex', 'gemini']
  );
});

test('applyClientDisplayPreferences does not mix pinned clients into full manual order', () => {
  const rows = [
    { key: 'claude', value: 300 },
    { key: 'codex', value: 100 },
    { key: 'opencode', value: 60 },
    { key: 'hermes', value: 20 }
  ];

  assert.deepEqual(
    applyClientDisplayPreferences(rows, 'opencode,claude,hermes,codex', '', clients, 'hermes,codex').map((row) => row.key),
    ['opencode', 'claude', 'hermes', 'codex']
  );
});

test('hasClientDisplayPreferences detects custom order or hidden clients', () => {
  assert.equal(hasClientDisplayPreferences('', '', clients), false);
  assert.equal(hasClientDisplayPreferences('unknown', '', clients), false);
  assert.equal(hasClientDisplayPreferences('', 'unknown', clients), false);
  assert.equal(hasClientDisplayPreferences('hermes,codex', '', clients), true);
  assert.equal(hasClientDisplayPreferences('', 'opencode', clients), true);
  assert.equal(hasClientDisplayPreferences('', '', clients, 'unknown'), false);
  assert.equal(hasClientDisplayPreferences('', '', clients, 'codex'), true);
});

test('defaultClientDisplayPreferences clears custom display state', () => {
  assert.deepEqual(defaultClientDisplayPreferences(), {
    clientDisplayOrder: '',
    hiddenClients: '',
    pinnedClients: ''
  });
});
