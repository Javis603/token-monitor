'use strict';

// `settings.limitProviderHiddenItems` stores the hidden half of each provider's
// "visible usage items" checklist. These tests pin the vocabulary (which item a
// window renders as), the per-provider checklists and the setting normalizer —
// the pieces the card, Home module and dock pin picker all share.

const assert = require('node:assert/strict');
const test = require('node:test');

const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers');
const usageItems = require('../../src/shared/limits/usageItems');

test('every catalog provider offers a checklist of real item ids', () => {
  // Canonical ids plus the extra-pools id — 'additional' is a real item (a
  // window can map to it) even though it stays off the canonical list.
  const known = new Set([...usageItems.LIMIT_USAGE_ITEM_IDS, 'additional']);
  for (const id of LIMIT_PROVIDER_IDS) {
    const items = usageItems.limitProviderUsageItems(id);
    assert.ok(items.length > 0, `${id} should offer at least one item`);
    for (const entry of items) {
      assert.ok(known.has(entry.id), `${id} lists unknown item ${entry.id}`);
      assert.ok(typeof entry.labelKey === 'string', `${id}.${entry.id} needs a labelKey field`);
    }
  }
});

test('every checklist label resolves in every shipped locale', () => {
  const i18n = require('../../src/electron/renderer/i18n');
  const locales = i18n.LANGUAGE_OPTIONS.map(({ value }) => value);
  for (const id of LIMIT_PROVIDER_IDS) {
    for (const entry of usageItems.limitProviderUsageItems(id)) {
      const key = entry.labelKey || `settings.limits.items.${entry.id}`;
      for (const locale of locales) {
        const text = i18n.translate(locale, key);
        assert.ok(text && text !== key, `${locale} is missing ${key} (${id}.${entry.id})`);
      }
    }
  }
});

test('a window maps to the item that renders it', () => {
  const { limitUsageItemIdForWindow } = usageItems;
  assert.equal(limitUsageItemIdForWindow({ kind: 'session' }), 'session');
  assert.equal(limitUsageItemIdForWindow({ kind: 'daily' }), 'daily');
  assert.equal(limitUsageItemIdForWindow({ kind: 'weekly' }), 'weekly');
  assert.equal(limitUsageItemIdForWindow({ kind: 'billing' }), 'monthly');
  // Money kinds beat the billing kind: a credits meter and a spend note are
  // their own items even though they share `kind: 'billing'`.
  assert.equal(limitUsageItemIdForWindow({ kind: 'billing', metric: 'credits' }), 'credits');
  assert.equal(limitUsageItemIdForWindow({ kind: 'billing', metric: 'spend' }), 'spend');
  // Codex's extra pools answer to showCodexAdditionalLimits, not this list.
  assert.equal(limitUsageItemIdForWindow({ kind: 'daily', additional: true }), 'additional');
  assert.equal(limitUsageItemIdForWindow(null), null);
  assert.equal(limitUsageItemIdForWindow({}), null);
});

test('the normalizer keeps only items the provider actually offers', () => {
  assert.equal(usageItems.normalizeProviderItemCsv('weekly,session', 'codex'), 'session,weekly');
  assert.equal(usageItems.normalizeProviderItemCsv('session,spend', 'codex'), 'session');
  assert.equal(usageItems.normalizeProviderItemCsv('additional', 'codex'), '');
  // Factory's Core pools are an `additional` group with no switch of their
  // own, so the id is a real checklist item there — and only there.
  assert.equal(usageItems.normalizeProviderItemCsv('additional', 'factory'), 'additional');
  assert.equal(usageItems.normalizeProviderItemCsv('credits', 'grok'), '');
});

test('Factory checklists Standard rows, the Core pools item and the balance', () => {
  assert.deepEqual(
    usageItems.limitProviderUsageItems('factory').map((entry) => entry.id),
    ['session', 'weekly', 'monthly', 'additional', 'credits']
  );
  const windows = [
    { kind: 'session', label: '5-hour' },
    { kind: 'weekly', label: 'Weekly' },
    { kind: 'billing', label: 'Monthly' },
    { kind: 'session', label: 'Core 5-hour', additional: true },
    { kind: 'weekly', label: 'Core Weekly', additional: true },
    { kind: 'billing', label: 'Core Monthly', additional: true },
    { kind: 'billing', label: 'Balance', metric: 'credits' }
  ];
  assert.deepEqual(
    usageItems.visibleLimitUsageWindows({ provider: 'factory', windows }, { factory: 'additional' })
      .map((window) => window.label),
    ['5-hour', 'Weekly', 'Monthly', 'Balance']
  );
  assert.deepEqual(
    usageItems.visibleLimitUsageWindows({ provider: 'factory', windows }, { factory: 'monthly' })
      .map((window) => window.label),
    ['5-hour', 'Weekly', 'Core 5-hour', 'Core Weekly', 'Core Monthly', 'Balance']
  );
  assert.deepEqual(
    usageItems.visibleLimitUsageWindows({ provider: 'factory', windows }, { factory: 'credits' })
      .map((window) => window.label),
    ['5-hour', 'Weekly', 'Monthly', 'Core 5-hour', 'Core Weekly', 'Core Monthly']
  );
  assert.deepEqual(
    usageItems.visibleLimitUsageWindows({ provider: 'factory', windows }, { factory: 'monthly,additional' })
      .map((window) => window.label),
    ['5-hour', 'Weekly', 'Balance']
  );
});

test('the setting normalizer drops unknown providers and empty selections', () => {
  assert.deepEqual(
    usageItems.normalizeLimitProviderHiddenItems({
      codex: 'weekly, bogus',
      'not-a-provider': 'session',
      claude: '',
      grok: 'monthly'
    }),
    { codex: 'weekly', grok: 'monthly' }
  );
  assert.deepEqual(usageItems.normalizeLimitProviderHiddenItems(null), {});
  assert.deepEqual(usageItems.normalizeLimitProviderHiddenItems('weekly'), {});
  assert.deepEqual(usageItems.normalizeLimitProviderHiddenItems(['weekly']), {});
});

test('a missing or malformed entry reads as everything visible', () => {
  assert.equal(usageItems.hiddenLimitUsageItemSet(undefined, 'codex').size, 0);
  assert.equal(usageItems.hiddenLimitUsageItemSet({}, 'codex').size, 0);
  assert.equal(usageItems.hiddenLimitUsageItemSet({ codex: 'weekly' }, 'codex').has('weekly'), true);
  // Keys are stored normalized lowercase; a cased lookup key still resolves.
  assert.equal(usageItems.hiddenLimitUsageItemSet({ codex: 'weekly' }, 'Codex').has('weekly'), true);
});

test('toggling composes on the stored map and cleans up empty entries', () => {
  const hidden = usageItems.toggleLimitUsageItem({}, 'codex', 'weekly');
  assert.deepEqual(hidden, { codex: 'weekly' });
  const also = usageItems.toggleLimitUsageItem(hidden, 'codex', 'session');
  assert.deepEqual(also, { codex: 'session,weekly' });
  const unhidden = usageItems.toggleLimitUsageItem(also, 'codex', 'weekly');
  assert.deepEqual(unhidden, { codex: 'session' });
  // Unhiding the last item removes the provider's entry entirely.
  assert.deepEqual(usageItems.toggleLimitUsageItem(unhidden, 'codex', 'session'), {});
  // An item the provider does not offer cannot be toggled in.
  assert.deepEqual(usageItems.toggleLimitUsageItem({}, 'codex', 'credits'), {});
});

test('visible windows drop the hidden item ids', () => {
  const provider = {
    provider: 'zai',
    windows: [
      { kind: 'session', label: '5-hour' },
      { kind: 'daily', label: 'Daily' },
      { kind: 'weekly', label: 'Weekly' },
      { kind: 'billing', label: 'MCP' },
      { kind: 'billing', metric: 'credits', label: 'Balance' }
    ]
  };
  const labels = (value) => usageItems
    .visibleLimitUsageWindows(provider, value)
    .map((window) => window.label);
  assert.deepEqual(labels({}), ['5-hour', 'Daily', 'Weekly', 'MCP', 'Balance']);
  assert.deepEqual(labels({ zai: 'session,monthly' }), ['Daily', 'Weekly', 'Balance']);
  assert.deepEqual(labels({ zai: 'credits' }), ['5-hour', 'Daily', 'Weekly', 'MCP']);
  assert.deepEqual(labels({ other: 'session' }), ['5-hour', 'Daily', 'Weekly', 'MCP', 'Balance']);
  assert.deepEqual(usageItems.visibleLimitUsageWindows(null, { zai: 'session' }), []);
});

test('window classification normalizes text and gives additional pools precedence over money', () => {
  for (const [window, expected] of [
    [{ kind: ' WEEKLY ' }, 'weekly'],
    [{ kind: 'session', metric: ' CREDITS ' }, 'credits'],
    [{ kind: 'daily', metric: ' Spend ' }, 'spend'],
    [{ kind: 'billing', metric: 'credits', additional: true }, 'additional'],
    [{ kind: 'weekly', additional: false }, 'weekly'],
    [{ kind: 'weekly', additional: 'true' }, 'weekly'],
    [{ kind: 'future-window', metric: 'tokens' }, null],
    [undefined, null],
    ['weekly', null]
  ]) {
    assert.equal(usageItems.limitUsageItemIdForWindow(window), expected, JSON.stringify(window));
  }
});

test('CSV normalization accepts arrays, deduplicates and rejects unsupported selections', () => {
  const selections = Object.freeze([' WEEKLY ', 'session', 'weekly', '', null, 'SPEND', 'additional']);
  assert.equal(usageItems.normalizeProviderItemCsv(selections, ' CODEX '), 'session,weekly');
  assert.equal(usageItems.normalizeProviderItemCsv(' , WEEKLY, weekly, Session, ', 'codex'), 'session,weekly');
  for (const value of [undefined, null, false, 0, {}, [], 'bogus']) {
    assert.equal(usageItems.normalizeProviderItemCsv(value, 'codex'), '');
  }
  assert.equal(usageItems.normalizeProviderItemCsv('session,credits', 'unknown-provider'), '');
  for (const provider of ['workbuddy', 'trae']) {
    assert.equal(usageItems.normalizeProviderItemCsv('spend,credits', provider), 'credits');
  }
});

test('setting normalization is immutable and idempotent across a JSON round trip', () => {
  const input = Object.freeze({
    ' CODEX ': Object.freeze([' WEEKLY ', 'session', 'weekly', 'additional']),
    'DeepSeek': ' SPEND,credits,spend ',
    'factory': 'additional,monthly',
    'unknown-provider': 'weekly',
    'claude': null
  });
  const expected = { codex: 'session,weekly', deepseek: 'credits,spend', factory: 'monthly,additional' };
  const normalized = usageItems.normalizeLimitProviderHiddenItems(input);
  assert.deepEqual(normalized, expected);
  assert.deepEqual(usageItems.normalizeLimitProviderHiddenItems(JSON.parse(JSON.stringify(normalized))), expected);
  assert.deepEqual(input[' CODEX '], [' WEEKLY ', 'session', 'weekly', 'additional']);
});

test('checklist and hidden-set callers cannot change subsequent reads', () => {
  const checklist = usageItems.limitProviderUsageItems('codex');
  const original = checklist.map((entry) => entry.id);
  checklist.pop();
  checklist.reverse();
  assert.deepEqual(usageItems.limitProviderUsageItems(' CODEX ').map((entry) => entry.id), original);
  assert.deepEqual(usageItems.limitProviderUsageItems('unknown-provider'), []);
  const setting = Object.freeze({ codex: ' WEEKLY,session,weekly,bogus ' });
  const hidden = usageItems.hiddenLimitUsageItemSet(setting, ' CODEX ');
  assert.deepEqual([...hidden], ['weekly', 'session']);
  hidden.clear();
  assert.equal(usageItems.hiddenLimitUsageItemSet(setting, 'codex').size, 2);
});

test('toggles preserve other providers and restoring the last item removes only its own entry', () => {
  const initial = Object.freeze({ codex: 'weekly', deepseek: 'credits' });
  const hidden = usageItems.toggleLimitUsageItem(initial, ' CODEX ', 'session');
  assert.deepEqual(hidden, { codex: 'session,weekly', deepseek: 'credits' });
  assert.deepEqual(usageItems.toggleLimitUsageItem(hidden, 'codex', 'session'), initial);
  assert.deepEqual(usageItems.toggleLimitUsageItem(initial, 'codex', 'weekly'), { deepseek: 'credits' });
  for (const [provider, item] of [['codex', 'additional'], ['unknown-provider', 'weekly'], ['codex', 'bogus']]) {
    assert.deepEqual(usageItems.toggleLimitUsageItem(initial, provider, item), initial);
  }
});

test('filtering preserves input, window identity and future row types', () => {
  const windows = Object.freeze([
    Object.freeze({ kind: 'weekly', label: 'All models' }),
    Object.freeze({ kind: 'weekly', label: 'Model-specific' }),
    Object.freeze({ kind: 'billing', label: 'New monthly pool' }),
    Object.freeze({ kind: 'future-window', label: 'New kind' })
  ]);
  const provider = Object.freeze({ provider: 'claude', windows });
  const filtered = usageItems.visibleLimitUsageWindows(provider, { claude: 'weekly' });
  assert.deepEqual(filtered, windows.slice(2));
  assert.equal(filtered[0], windows[2]);
  assert.equal(filtered[1], windows[3]);
  const all = usageItems.visibleLimitUsageWindows(provider, {});
  assert.notEqual(all, windows);
  all.pop();
  assert.equal(windows.length, 4);
  assert.deepEqual(usageItems.visibleLimitUsageWindows({ provider: 'claude' }, { claude: 'weekly' }), []);
});
