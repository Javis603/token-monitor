'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  hiddenUsageItemSet,
  isLimitWindowHidden,
  limitUsageItemId,
  limitWindowKey,
  normalizeLimitProviderHiddenItems,
  restoreUsageItemDefaults,
  setUsageItemHidden,
  usageItemFallbackLabel
} = require('../../src/shared/limits/usageItems');

const weekly = { kind: 'weekly', label: 'Weekly', remainingPercent: 40 };
const weeklyKey = limitWindowKey(weekly);

test('balance and spend rows keep one id however the payload carries them', () => {
  assert.equal(limitUsageItemId({ kind: 'billing', metric: 'credits', label: 'Balance' }), 'credits');
  assert.equal(limitUsageItemId({ kind: 'billing', metric: 'spend', label: 'Usage credits' }), 'spend');
  assert.equal(limitUsageItemId(weekly), weeklyKey);
});

test('a window with a backend id keeps its item across a relabel', () => {
  const before = { kind: 'weekly', label: 'Weekly', limitId: 'premium', windowMinutes: 10080 };
  assert.equal(limitUsageItemId(before), limitUsageItemId({ ...before, label: 'Premium weekly' }));
});

test('the stored setting drops unknown providers, bad ids, duplicates and empty lists', () => {
  assert.deepEqual(normalizeLimitProviderHiddenItems({
    Codex: ['resets', 'resets', weeklyKey, 'nonsense', '["weekly"]', 42],
    claude: [],
    notAProvider: ['credits'],
    zai: 'credits'
  }), { codex: ['resets', weeklyKey] });
  assert.deepEqual(normalizeLimitProviderHiddenItems(null), {});
  assert.deepEqual(normalizeLimitProviderHiddenItems(['codex']), {});
});

test('the stored list is capped so a hand-edited file cannot grow it without bound', () => {
  const ids = Array.from({ length: 100 }, (_, index) => limitWindowKey({ kind: 'billing', label: `Pool ${index}` }));
  assert.equal(normalizeLimitProviderHiddenItems({ codex: ids }).codex.length, 64);
});

test('hiding, showing and restoring touch only the one provider', () => {
  let value = setUsageItemHidden({}, 'codex', weeklyKey, true);
  value = setUsageItemHidden(value, 'claude', 'credits', true);
  assert.deepEqual(value, { codex: [weeklyKey], claude: ['credits'] });
  assert.deepEqual([...hiddenUsageItemSet(value, 'CODEX')], [weeklyKey]);
  value = setUsageItemHidden(value, 'codex', weeklyKey, false);
  assert.deepEqual(value, { claude: ['credits'] });
  value = setUsageItemHidden(value, 'codex', 'resets', true);
  assert.deepEqual(restoreUsageItemDefaults(value, 'codex'), { claude: ['credits'] });
});

test('a window is hidden only by its own provider\'s list, Codex additional pools included', () => {
  const value = { codex: [weeklyKey, limitWindowKey({ kind: 'session', label: 'Spark', additional: true })] };
  assert.equal(isLimitWindowHidden(value, 'codex', weekly), true);
  assert.equal(isLimitWindowHidden(value, 'claude', weekly), false);
  assert.equal(isLimitWindowHidden(value, 'codex', { kind: 'session', label: 'Spark', additional: true }), true);
  assert.equal(isLimitWindowHidden(undefined, 'codex', weekly), false);
});

// Home and the dock picker filter raw windows, so they must land on the item
// the card drew them under.
test('a window drawn under another item is hidden with that item', () => {
  const clineSpend = { kind: 'billing', metric: 'spend', label: 'Monthly spend' };
  assert.equal(isLimitWindowHidden({ cline: ['credits'] }, 'cline', clineSpend), true);
  assert.equal(isLimitWindowHidden({ cline: ['spend'] }, 'cline', clineSpend), false);
  const legacyClaudeSpend = { kind: 'billing', label: 'Usage credits' };
  assert.equal(isLimitWindowHidden({ claude: ['spend'] }, 'claude', legacyClaudeSpend), true);
  assert.equal(limitUsageItemId(legacyClaudeSpend), limitWindowKey(legacyClaudeSpend));
  const legacyOpenRouterBalance = { kind: 'billing', label: 'Credits', remaining: 4 };
  assert.equal(isLimitWindowHidden({ openrouter: ['credits'] }, 'openrouter', legacyOpenRouterBalance), true);
});

test('a hidden window the payload no longer draws is still named', () => {
  assert.equal(usageItemFallbackLabel('codex', weeklyKey), 'Weekly');
  assert.equal(
    usageItemFallbackLabel('codex', limitWindowKey({ kind: 'weekly', limitId: 'codex_spark', windowMinutes: 10080, additional: true })),
    'codex_spark · Weekly',
    'an unreported additional pool keeps its backend id, not just a period that reads like the main window'
  );
  assert.equal(usageItemFallbackLabel('codex', 'credits'), 'Balance', 'fixed items keep the card\'s English name');
});

test('main stores the setting normalized and pushes it to the dock', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  assert.match(main, /limitProviderHiddenItems: \{\},/);
  assert.match(main, /merged\.limitProviderHiddenItems = normalizeLimitProviderHiddenItems\(merged\.limitProviderHiddenItems\);/);
  assert.match(main, /limitProviderHiddenItems: normalizeLimitProviderHiddenItems\(patch\.limitProviderHiddenItems \?\? settings\.limitProviderHiddenItems\)/);
});
