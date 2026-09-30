'use strict';

// `settings.limitProviderHiddenItems` stores the hidden half of each
// provider's "visible usage items" checklist. The checklist enumerates the
// provider's real rows — every window it reports, plus the non-window rows
// (reset credits, spend, MiMo's Token Plan) whose data is present — so these
// tests pin row identity, data-driven enumeration, and the setting
// normalizer that the card, Home module and dock pin picker all share.

const assert = require('node:assert/strict');
const test = require('node:test');

const usageItems = require('../../src/shared/limits/usageItems');

const keyOf = (providerId, window) => usageItems.limitUsageRowId(providerId, window);

test('a window keys itself, and MiMo\'s plan row keeps one id across its two sources', () => {
  const sessionKey = usageItems.limitWindowKey({ kind: 'session', label: 'Session' });
  assert.equal(keyOf('claude', { kind: 'session', label: 'Session' }), sessionKey);
  assert.equal(
    keyOf('factory', { kind: 'session', label: 'Core 5-hour', additional: true }),
    usageItems.limitWindowKey({ kind: 'session', label: 'Core 5-hour', additional: true })
  );
  // MiMo's Token Plan renders from a billing window or a balance-synthesized
  // fallback — one row, one id ('monthly') either way.
  assert.equal(keyOf('mimo', { kind: 'billing', label: 'Token Plan' }), 'monthly');
  // Money windows carry their row ids too: one id for the balance row and
  // one for the spend line, whatever payload shape they arrive in.
  assert.equal(keyOf('mimo', { kind: 'billing', label: 'Balance', metric: 'credits' }), 'credits');
  assert.equal(keyOf('cline', { kind: 'billing', label: 'Usage credits', metric: 'spend' }), 'spend');
  // The old-hub fallback: a metric-less billing window with the spend label.
  assert.equal(keyOf('cline', { kind: 'billing', label: 'Usage credits' }), 'spend');
  assert.equal(keyOf('claude', null), '');
  assert.equal(keyOf('claude', {}), '');
});

test('window keys distinguish rows of the same kind', () => {
  const standard = { kind: 'session', label: '5-hour' };
  const core = { kind: 'session', label: 'Core 5-hour', additional: true };
  assert.notEqual(usageItems.limitWindowKey(standard), usageItems.limitWindowKey(core));
  // A backend limitId keys a row by identity, not display name.
  const withId = { limitId: 'rate-5h', kind: 'session', label: '5-hour', windowMinutes: 300 };
  assert.equal(
    usageItems.normalizeWindowKey(usageItems.limitWindowKey(withId)),
    usageItems.limitWindowKey(withId)
  );
});

test('the checklist enumerates the provider\'s real rows, one checkbox each', () => {
  const provider = {
    provider: 'factory',
    windows: [
      { kind: 'session', label: '5-hour' },
      { kind: 'weekly', label: 'Weekly' },
      { kind: 'billing', label: 'Monthly' },
      { kind: 'session', label: 'Core 5-hour', additional: true },
      { kind: 'weekly', label: 'Core Weekly', additional: true },
      { kind: 'billing', label: 'Core Monthly', additional: true },
      { kind: 'billing', label: 'Balance', metric: 'credits' }
    ]
  };
  const rows = usageItems.limitProviderUsageRows(provider);
  assert.deepEqual(rows.map((row) => row.label), [
    '5-hour', 'Weekly', 'Monthly', 'Core 5-hour', 'Core Weekly', 'Core Monthly', 'Balance'
  ]);
  assert.deepEqual(rows.map((row) => row.id).at(-1), 'credits');
  assert.equal(rows.length, 7);
  assert.deepEqual(usageItems.limitProviderUsageRows(null), []);
  assert.deepEqual(usageItems.limitProviderUsageRows({ provider: 'claude' }), []);
});

test('hidden-but-absent rows stay listed so they can be unhidden', () => {
  // CodexBar's includingHidden semantics: a row that drops off the payload
  // while hidden keeps its checkbox — otherwise it could never be unhidden.
  const weekly = { kind: 'weekly', label: 'Weekly' };
  const weeklyKey = usageItems.limitWindowKey(weekly);
  const provider = { provider: 'claude', windows: [{ kind: 'session', label: 'Session' }] };
  const rows = usageItems.limitProviderUsageRows(provider, { claude: [weeklyKey, 'resets'] });
  assert.deepEqual(rows.map((row) => row.id), [usageItems.limitWindowKey({ kind: 'session', label: 'Session' }), weeklyKey, 'resets']);
  assert.deepEqual(rows.map((row) => row.label), ['Session', 'Weekly', undefined]);
  assert.equal(rows.at(-1).labelKey, 'settings.limits.items.resets');
  // Codex additional windows still never enumerate, even from a stored key.
  const sparkKey = usageItems.limitWindowKey({ kind: 'daily', label: 'Spark', additional: true });
  const codex = usageItems.limitProviderUsageRows(
    { provider: 'codex', windows: [] },
    { codex: [sparkKey] }
  );
  assert.deepEqual(codex, []);
});

test('Codex additional pools stay off the checklist — their own switch owns them', () => {
  const rows = usageItems.limitProviderUsageRows({
    provider: 'codex',
    windows: [
      { kind: 'session', label: 'Session' },
      { kind: 'session', label: 'Code review', additional: true }
    ]
  });
  assert.deepEqual(rows.map((row) => row.label), ['Session']);
});

test('non-window rows appear only when their data is present', () => {
  // resetCredits -> a resets row; spend fields -> a spend row; MiMo balance
  // plan fields -> the Token Plan row even without a plan window.
  const rows = usageItems.limitProviderUsageRows({
    provider: 'claude',
    windows: [{ kind: 'session', label: 'Session' }],
    resetCredits: { availableCount: 1 },
    balance: { monthSpend: 12.34 }
  });
  assert.deepEqual(rows.map((row) => row.id).slice(1), ['resets', 'spend']);
  // No spend figures, no spend row — the dead-checkbox case stays hidden.
  const bare = usageItems.limitProviderUsageRows({
    provider: 'workbuddy',
    windows: [{ kind: 'billing', label: 'Balance', metric: 'credits' }],
    balance: { monthSpend: null, todaySpend: null }
  });
  assert.deepEqual(bare.map((row) => row.id), ['credits']);
  // Typesafe's spend summary lives off balance.
  const typesafe = usageItems.limitProviderUsageRows({
    provider: 'typesafe',
    windows: [],
    usageSummary: { period: 'month', totalTokens: 1000 }
  });
  assert.deepEqual(typesafe.map((row) => row.id), ['spend']);
});

test('MiMo checklists its Token Plan from a real window or the balance fallback', () => {
  const fromWindow = usageItems.limitProviderUsageRows({
    provider: 'mimo',
    windows: [
      { kind: 'billing', label: 'Token Plan' },
      { kind: 'billing', label: 'Balance', metric: 'credits' }
    ]
  });
  assert.deepEqual(fromWindow.map((row) => row.id), ['monthly', 'credits']);
  const fromBalance = usageItems.limitProviderUsageRows({
    provider: 'mimo',
    windows: [{ kind: 'billing', label: 'Balance', metric: 'credits' }],
    balance: { planUsed: 10, planLimit: 100 }
  });
  assert.deepEqual(fromBalance.map((row) => row.id), ['credits', 'monthly']);
});

test('checklist labels resolve in every shipped locale where they localize', () => {
  const i18n = require('../../src/electron/renderer/i18n');
  const locales = i18n.LANGUAGE_OPTIONS.map(({ value }) => value);
  const provider = {
    provider: 'claude',
    windows: [{ kind: 'session', label: 'Session' }],
    resetCredits: { availableCount: 1 },
    balance: { monthSpend: 1 }
  };
  for (const entry of usageItems.limitProviderUsageRows(provider)) {
    if (!entry.labelKey) continue;
    for (const locale of locales) {
      const text = i18n.translate(locale, entry.labelKey);
      assert.ok(text && text !== entry.labelKey, `${locale} is missing ${entry.labelKey}`);
    }
  }
});

test('the setting normalizer drops unknown providers, bad keys and empty selections', () => {
  const weekly = usageItems.limitWindowKey({ kind: 'weekly', label: 'Weekly' });
  assert.deepEqual(
    usageItems.normalizeLimitProviderHiddenItems({
      codex: [weekly, 'bogus', 'also bad'],
      'not-a-provider': [weekly],
      claude: [],
      grok: ['spend']
    }),
    { codex: [weekly], grok: ['spend'] }
  );
  assert.deepEqual(usageItems.normalizeLimitProviderHiddenItems(null), {});
  assert.deepEqual(usageItems.normalizeLimitProviderHiddenItems('weekly'), {});
  assert.deepEqual(usageItems.normalizeLimitProviderHiddenItems(['weekly']), {});
  // A legacy CSV value is tolerated: synthesized-row ids survive, kind ids
  // and junk fall away.
  assert.deepEqual(
    usageItems.normalizeLimitProviderHiddenItems({ claude: 'resets,session,bogus' }),
    { claude: ['resets'] }
  );
});

test('a missing or malformed entry reads as everything visible', () => {
  assert.equal(usageItems.hiddenLimitUsageItemSet(undefined, 'codex').size, 0);
  assert.equal(usageItems.hiddenLimitUsageItemSet({}, 'codex').size, 0);
  const weekly = usageItems.limitWindowKey({ kind: 'weekly', label: 'Weekly' });
  assert.equal(usageItems.hiddenLimitUsageItemSet({ codex: [weekly] }, 'codex').has(weekly), true);
  // A cased lookup key still resolves.
  assert.equal(usageItems.hiddenLimitUsageItemSet({ codex: [weekly] }, 'Codex').has(weekly), true);
  assert.equal(usageItems.hiddenLimitUsageItemSet({ claude: 'resets' }, 'claude').has('resets'), true);
});

test('toggling composes on the stored map and cleans up empty entries', () => {
  const sessionKey = usageItems.limitWindowKey({ kind: 'session', label: 'Session' });
  const weeklyKey = usageItems.limitWindowKey({ kind: 'weekly', label: 'Weekly' });
  const hidden = usageItems.toggleLimitUsageItem({}, 'codex', weeklyKey);
  assert.deepEqual(hidden, { codex: [weeklyKey] });
  const also = usageItems.toggleLimitUsageItem(hidden, 'codex', sessionKey);
  // Newly hidden rows append to the stored selection.
  assert.deepEqual(also, { codex: [weeklyKey, sessionKey] });
  const unhidden = usageItems.toggleLimitUsageItem(also, 'codex', weeklyKey);
  assert.deepEqual(unhidden, { codex: [sessionKey] });
  // Unhiding the last item removes the provider's entry entirely.
  assert.deepEqual(usageItems.toggleLimitUsageItem(unhidden, 'codex', sessionKey), {});
  // A malformed key cannot be toggled in.
  assert.deepEqual(usageItems.toggleLimitUsageItem({}, 'codex', 'not-a-key'), {});
});

test('visible windows drop hidden rows individually', () => {
  const provider = {
    provider: 'factory',
    windows: [
      { kind: 'session', label: '5-hour' },
      { kind: 'weekly', label: 'Weekly' },
      { kind: 'session', label: 'Core 5-hour', additional: true },
      { kind: 'billing', label: 'Balance', metric: 'credits' }
    ]
  };
  const labels = (value) => usageItems
    .visibleLimitUsageWindows(provider, value)
    .map((window) => window.label);
  assert.deepEqual(labels({}), ['5-hour', 'Weekly', 'Core 5-hour', 'Balance']);
  // Hiding Standard's session no longer lets Core claim the slot — each row
  // is its own key.
  const sessionKey = keyOf('factory', provider.windows[0]);
  const coreKey = keyOf('factory', provider.windows[2]);
  assert.deepEqual(labels({ factory: [sessionKey] }), ['Weekly', 'Core 5-hour', 'Balance']);
  assert.deepEqual(labels({ factory: [coreKey] }), ['5-hour', 'Weekly', 'Balance']);
  assert.deepEqual(labels({ factory: ['credits'] }), ['5-hour', 'Weekly', 'Core 5-hour']);
  assert.deepEqual(labels({ other: [sessionKey] }), ['5-hour', 'Weekly', 'Core 5-hour', 'Balance']);
  assert.deepEqual(usageItems.visibleLimitUsageWindows(null, { factory: [sessionKey] }), []);
});

test('setting normalization is immutable and idempotent across a JSON round trip', () => {
  const weekly = usageItems.limitWindowKey({ kind: 'weekly', label: 'Weekly' });
  const input = Object.freeze({
    ' CODEX ': Object.freeze([weekly, weekly, 'resets']),
    'unknown-provider': [weekly],
    'claude': null
  });
  const expected = { codex: [weekly, 'resets'] };
  const normalized = usageItems.normalizeLimitProviderHiddenItems(input);
  assert.deepEqual(normalized, expected);
  assert.deepEqual(usageItems.normalizeLimitProviderHiddenItems(JSON.parse(JSON.stringify(normalized))), expected);
  assert.deepEqual(input[' CODEX '], [weekly, weekly, 'resets']);
});

test('checklist and hidden-set callers cannot change subsequent reads', () => {
  const provider = { provider: 'codex', windows: [{ kind: 'session', label: 'Session' }] };
  const rows = usageItems.limitProviderUsageRows(provider);
  const original = rows.map((row) => row.id);
  rows.pop();
  rows.reverse();
  assert.deepEqual(usageItems.limitProviderUsageRows(provider).map((row) => row.id), original);
  const weekly = usageItems.limitWindowKey({ kind: 'weekly', label: 'Weekly' });
  const setting = Object.freeze({ codex: [weekly, 'resets', 'bogus'] });
  const hidden = usageItems.hiddenLimitUsageItemSet(setting, ' CODEX ');
  assert.deepEqual([...hidden], [weekly, 'resets']);
  hidden.clear();
  assert.equal(usageItems.hiddenLimitUsageItemSet(setting, 'codex').size, 2);
});

test('toggles preserve other providers and restoring the last item removes only its own entry', () => {
  const weekly = usageItems.limitWindowKey({ kind: 'weekly', label: 'Weekly' });
  const session = usageItems.limitWindowKey({ kind: 'session', label: 'Session' });
  const initial = Object.freeze({ codex: [weekly], deepseek: ['spend'] });
  const hidden = usageItems.toggleLimitUsageItem(initial, ' CODEX ', session);
  assert.deepEqual(hidden, { codex: [weekly, session], deepseek: ['spend'] });
  assert.deepEqual(usageItems.toggleLimitUsageItem(hidden, 'codex', session), initial);
  assert.deepEqual(usageItems.toggleLimitUsageItem(initial, 'codex', weekly), { deepseek: ['spend'] });
  for (const [provider, item] of [['unknown-provider', weekly], ['codex', 'bogus']]) {
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
  // Same-kind rows hide individually: only the named weekly leaves.
  const allModelsKey = keyOf('claude', windows[0]);
  const filtered = usageItems.visibleLimitUsageWindows(provider, { claude: [allModelsKey] });
  assert.deepEqual(filtered, windows.slice(1));
  assert.equal(filtered[0], windows[1]);
  const all = usageItems.visibleLimitUsageWindows(provider, {});
  assert.notEqual(all, windows);
  all.pop();
  assert.equal(windows.length, 4);
  assert.deepEqual(usageItems.visibleLimitUsageWindows({ provider: 'claude' }, { claude: [allModelsKey] }), []);
});
