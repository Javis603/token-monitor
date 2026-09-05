'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  moveLimitProvider,
  normalizeLimitProviderOrder,
  normalizeLimitProviderSelection,
  orderedLimitProviders,
  reorderLimitProvider
} = require('../../src/electron/renderer/limitProviderOrder');
const { LIMIT_PROVIDER_CATALOG } = require('../../src/shared/limitProviders');

const providers = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'antigravity', label: 'Antigravity' }
];

// The expected list stays spelled out rather than derived: this order is the
// default a fresh install writes to settings.limitProviderOrder, so changing it
// is a compatibility decision that should have to be made in a diff. Since the
// catalog became the single source for both the ids and the renderer's list,
// this hand-written copy is the only independent check left on that order —
// comparing the catalog against anything derived from it proves nothing.
test('default provider order follows tracked tools, named services, then third-party fallback', () => {
  const ids = LIMIT_PROVIDER_CATALOG.map((provider) => provider.id);

  assert.deepEqual(ids, [
    'claude',
    'codex',
    'opencode',
    'cursor',
    'antigravity',
    'kimi',
    'grok',
    'copilot',
    'zed',
    'commandcode',
    'mimo',
    'zai',
    'zaiteam',
    'kiro',
    'workbuddy',
    'qoder',
    'deepseek',
    'openrouter',
    'minimax',
    'volcengine',
    'ollama',
    'trae',
    'alibaba',
    'thirdparty'
  ]);
});

test('normalizeLimitProviderOrder drops invalid entries and appends missing providers', () => {
  assert.deepEqual(
    normalizeLimitProviderOrder('codex,unknown,codex,claude', providers),
    ['codex', 'claude', 'cursor', 'antigravity']
  );
});

test('normalizeLimitProviderSelection preserves disabled providers', () => {
  assert.deepEqual(
    normalizeLimitProviderSelection('codex,unknown,codex', providers),
    ['codex']
  );
});

test('orderedLimitProviders returns provider objects in the saved order', () => {
  assert.deepEqual(
    orderedLimitProviders(providers, 'cursor,codex').map((provider) => provider.id),
    ['cursor', 'codex', 'claude', 'antigravity']
  );
});

test('moveLimitProvider swaps a provider with its neighbor only when possible', () => {
  assert.equal(
    moveLimitProvider('claude,codex,cursor,antigravity', providers, 'cursor', 'up'),
    'claude,cursor,codex,antigravity'
  );
  assert.equal(
    moveLimitProvider('claude,codex,cursor,antigravity', providers, 'claude', 'up'),
    'claude,codex,cursor,antigravity'
  );
});

test('reorderLimitProvider moves a provider to a target index', () => {
  assert.equal(
    reorderLimitProvider('claude,codex,cursor,antigravity', providers, 'cursor', 0),
    'cursor,claude,codex,antigravity'
  );
  assert.equal(
    reorderLimitProvider('claude,codex,cursor,antigravity', providers, 'claude', 99),
    'codex,cursor,antigravity,claude'
  );
  assert.equal(
    reorderLimitProvider('claude,codex,cursor,antigravity', providers, 'unknown', 1),
    'claude,codex,cursor,antigravity'
  );
});
