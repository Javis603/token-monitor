'use strict';

// `settings.limitProviderHiddenItems` stores the hidden half of each provider's
// "visible usage items" checklist. These tests pin the vocabulary (which item a
// window renders as), the per-provider checklists and the setting normalizer —
// the pieces the card, Home module and dock pin picker all share.

const assert = require('node:assert/strict');
const test = require('node:test');

const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers');
const usageItems = require('../../src/shared/limits/usageItems');

test('every catalog provider offers a checklist of canonical item ids', () => {
  const canonical = new Set(usageItems.LIMIT_USAGE_ITEM_IDS);
  for (const id of LIMIT_PROVIDER_IDS) {
    const items = usageItems.limitProviderUsageItems(id);
    assert.ok(items.length > 0, `${id} should offer at least one item`);
    for (const entry of items) {
      assert.ok(canonical.has(entry.id), `${id} lists unknown item ${entry.id}`);
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
  assert.equal(usageItems.normalizeProviderItemCsv('credits', 'grok'), '');
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
