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
    'factory',
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

// These hand-wired surfaces used to insert new providers independently of the
// README-backed catalog, making the source and account layout disagree.
test('provider registration and account layout order follows the catalog', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (file) => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
  const canonical = LIMIT_PROVIDER_CATALOG.map(({ id }) => id);
  const check = (ids, label) => {
    assert.ok(ids.length > 0, `${label} must contain providers`);
    assert.deepEqual(ids, canonical.filter((id) => ids.includes(id)), label);
  };
  for (const [file, names, indent] of [
    ['src/electron/renderer/app.js', ['LIMIT_PROVIDER_ACCOUNT_GROUP_IDS', 'LIMIT_PROVIDER_ACCOUNT_STATUS_IDS', 'externalLimitAccountConfig'], '  '],
    ['src/electron/renderer/limitProviderPresentation.js', ['PROVIDER_SOURCE_LABELS', 'CAPABILITY_TAGS'], '    '],
    ['src/electron/runtimeConfig.js', ['LIMIT_PROVIDER_SETTING_KEYS'], '  ']
  ]) {
    const source = read(file);
    for (const name of names) {
      const start = source.indexOf(`const ${name} =`);
      assert.notEqual(start, -1, name);
      const body = source.slice(start).split(new RegExp(`\\n${indent.slice(2)}\\}`))[0];
      check([...body.matchAll(new RegExp(`^${indent}(\\w+):`, 'gm'))].map((match) => match[1]), name);
    }
  }
  const html = read('src/electron/renderer/index.html');
  check([...html.matchAll(/^ {12}<div id="(\w+)(?:AccountGroup|CookieGroup)"/gm)]
    .map((match) => match[1]).filter((id) => canonical.includes(id)), 'HTML account groups');
  const swift = read('native/macos/TokenMonitorWidget/WidgetViewModel.swift');
  const fallback = swift.slice(swift.indexOf('static func provider(')).split('default:')[0];
  check([...fallback.matchAll(/case "(\w+)":/g)].map((match) => match[1])
    .filter((id) => canonical.includes(id)), 'Widget provider labels');
  const collector = read('src/shared/limits/collector.js');
  check([...collector.matchAll(/^ {4}(\w+): \(providerOptions, probeDeps\)/gm)]
    .map((match) => match[1]), 'provider fetchers');
});
