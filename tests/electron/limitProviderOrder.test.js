'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  moveLimitProvider,
  normalizeLimitProviderOrder,
  normalizeLimitProviderSelection,
  orderedLimitProviders,
  reorderLimitProvider
} = require('../../src/electron/renderer/limitProviderOrder');
const { parseLimitProviders } = require('../../src/shared/limitCollector');

const rootDir = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

const providers = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'antigravity', label: 'Antigravity' }
];

test('default provider order follows tracked tools, named services, then third-party fallback', () => {
  const app = read('src/electron/renderer/app.js');
  const block = app.slice(
    app.indexOf('const LIMIT_PROVIDERS = ['),
    app.indexOf('const TRAY_ICON_VARIANTS')
  );
  const ids = [...block.matchAll(/\{ id: '([^']+)'/g)].map((match) => match[1]);

  assert.deepEqual(ids, [
    'claude',
    'codex',
    'opencode',
    'cursor',
    'antigravity',
    'kimi',
    'grok',
    'copilot',
    'mimo',
    'zai',
    'zaiteam',
    'kiro',
    'deepseek',
    'openrouter',
    'minimax',
    'volcengine',
    'qoder',
    'ollama',
    'thirdparty'
  ]);
});

test('renderer provider order matches the collector default for new settings', () => {
  const app = read('src/electron/renderer/app.js');
  const block = app.slice(
    app.indexOf('const LIMIT_PROVIDERS = ['),
    app.indexOf('const TRAY_ICON_VARIANTS')
  );
  const ids = [...block.matchAll(/\{ id: '([^']+)'/g)].map((match) => match[1]);

  assert.deepEqual(ids, parseLimitProviders());
});

test('account groups derive their order from the default limits provider order', () => {
  const app = read('src/electron/renderer/app.js');
  const start = app.indexOf('function orderAccountProviderGroups()');
  const end = app.indexOf('function refreshIntervalLabel', start);
  const body = app.slice(start, end);

  assert.match(body, /for \(const provider of LIMIT_PROVIDERS\)/);
  assert.match(body, /provider\.id === 'opencode'\s*\? 'opencodeCookieGroup'\s*: `\$\{provider\.id\}AccountGroup`/);
  assert.match(body, /if \(group\?\.parentElement === container\) container\.append\(group\)/);
  assert.ok(app.indexOf('orderAccountProviderGroups();') < app.indexOf('initSettingsAnimationWrappers();'));
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
