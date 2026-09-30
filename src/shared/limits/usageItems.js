'use strict';

// Per-provider "visible usage items": which rows a provider's limits card may
// draw, and the user's hidden selection among them.
//
// The limits card renders several kinds of rows — quota windows by kind
// (session/daily/weekly/billing), money rows (credits balances, spend
// summaries), and the reset-credits line. CodexBar lets the user pick which of
// these each provider shows; this module is the vocabulary for that pick: the
// canonical item ids, which items each provider offers, and the mapping that
// turns a window object into the item it renders as.
//
// `settings.limitProviderHiddenItems` stores the hidden half — `{ providerId:
// 'item,item' }` — rather than the visible half, so a row introduced later
// defaults to shown instead of silently disappearing for upgraded installs.
//
// Pure data and pure functions, no DOM and no Node built-ins: the widget
// renderer and the edge dock load it as a plain <script>, the main process
// requires it to normalize the setting, and node:test can require it.
(function exposeLimitUsageItems(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./providers') : root?.TokenMonitorLimitProviders);
  if (node) module.exports = api;
  if (root) root.TokenMonitorLimitUsageItems = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLimitUsageItemsApi(limitProviders) {
  // What one card row counts as, in the order the checklist shows them.
  // 'monthly' is every quota window of billing kind that is not a money row:
  // monthly quotas, plan buckets, token plans and grant pools all land here.
  const LIMIT_USAGE_ITEM_IDS = Object.freeze([
    'session', 'daily', 'weekly', 'monthly', 'credits', 'spend', 'resets'
  ]);

  // `additional` marks a provider's extra quota pools. Codex's answer to their
  // own `showCodexAdditionalLimits` setting, so the id stays off its checklist
  // — two switches on one row could disagree — but a provider with no such
  // switch (Factory's Core pools) offers it as a regular checklist item.
  const EXTRA_ITEM_IDS = new Set(['additional']);
  const VALID_ITEM_IDS = new Set([...LIMIT_USAGE_ITEM_IDS, ...EXTRA_ITEM_IDS]);

  function normalizeItemId(value) {
    const id = String(value || '').trim().toLowerCase();
    return VALID_ITEM_IDS.has(id) ? id : null;
  }

  // The item one window renders as. A window's kind alone cannot place it:
  // `metric` marks money windows that share the billing kind, and `additional`
  // pools are their own item regardless of kind.
  function limitUsageItemIdForWindow(window) {
    if (!window || typeof window !== 'object') return null;
    if (window.additional === true) return 'additional';
    const metric = String(window.metric || '').trim().toLowerCase();
    if (metric === 'credits') return 'credits';
    if (metric === 'spend') return 'spend';
    const kind = String(window.kind || '').trim().toLowerCase();
    if (kind === 'session') return 'session';
    if (kind === 'daily') return 'daily';
    if (kind === 'weekly') return 'weekly';
    if (kind === 'billing') return 'monthly';
    return null;
  }

  // labelKey defaults to `settings.limits.items.<id>`; a provider only supplies
  // one when its own wording would make the canonical label wrong (Kimi's
  // billing window really is a Credits pool, Claude's spend row is "Usage
  // credits").
  function item(id, labelKey = '') {
    return Object.freeze({ id, labelKey });
  }

  // The checklist each provider offers, in display order — the same rows the
  // provider's card can draw. Providers not listed simply have nothing to
  // configure; a provider whose every row is one item still gets its (single)
  // checkbox, since hiding it keeps the account configured unlike the
  // provider switch.
  const LIMIT_PROVIDER_USAGE_ITEMS = Object.freeze({
    claude: [
      item('session'),
      item('weekly'),
      item('spend', 'settings.limits.items.usageCredits'),
      item('credits', 'settings.limits.prepaidBalance'),
      item('resets')
    ],
    codex: [
      item('session'),
      item('weekly'),
      item('monthly'),
      item('resets')
    ],
    opencode: [
      item('session'),
      item('weekly'),
      item('monthly'),
      item('credits')
    ],
    cursor: [
      item('monthly', 'settings.limits.items.includedUsage'),
      item('weekly'),
      item('spend', 'settings.limits.items.onDemandSpend')
    ],
    antigravity: [item('session'), item('weekly')],
    cline: [
      item('session'),
      item('weekly'),
      item('monthly'),
      item('credits', 'settings.limits.items.creditsLabel'),
      item('spend', 'settings.limits.items.usageCredits')
    ],
    factory: [
      item('session'),
      item('weekly'),
      item('monthly'),
      // Core pools ship `additional: true` like Codex's extras, but Factory
      // has no own switch for them — 'additional' is their checklist item.
      item('additional', 'settings.limits.items.corePools'),
      item('credits', 'settings.limits.items.extraUsageBalance')
    ],
    kimi: [item('session'), item('weekly'), item('monthly')],
    grok: [item('monthly')],
    copilot: [item('monthly')],
    zed: [item('monthly')],
    commandcode: [
      item('session'),
      item('weekly'),
      item('credits', 'settings.limits.items.monthlyGrant')
    ],
    mimo: [
      item('monthly', 'settings.limits.capability.tokenPlan'),
      item('credits')
    ],
    zai: [
      item('session'),
      item('daily'),
      item('weekly'),
      item('monthly', 'settings.limits.items.plans'),
      item('credits'),
      item('spend')
    ],
    zaiteam: [
      item('session'),
      item('daily'),
      item('weekly'),
      item('monthly', 'settings.limits.items.plans'),
      item('credits'),
      item('spend')
    ],
    kiro: [item('monthly', 'settings.limits.items.monthlyCredits')],
    workbuddy: [item('credits', 'settings.limits.items.creditsLabel')],
    qoder: [item('monthly', 'settings.limits.items.creditsLabel')],
    deepseek: [item('credits'), item('spend')],
    devin: [
      item('daily'),
      item('weekly'),
      item('credits', 'settings.limits.items.extraUsageBalance')
    ],
    typesafe: [item('credits'), item('spend', 'settings.limits.items.tokens')],
    openrouter: [
      item('session', 'settings.limits.items.dailyLimit'),
      item('weekly'),
      item('credits'),
      item('monthly'),
      item('spend')
    ],
    minimax: [item('session'), item('weekly')],
    volcengine: [item('session'), item('daily'), item('weekly'), item('monthly')],
    ollama: [item('session'), item('weekly')],
    trae: [item('credits', 'settings.limits.items.creditsLabel')],
    alibaba: [item('session'), item('weekly'), item('monthly')],
    stepfun: [item('session'), item('weekly'), item('monthly')],
    thirdparty: [item('credits'), item('spend')]
  });

  function limitProviderUsageItems(providerId) {
    const id = String(providerId || '').trim().toLowerCase();
    return (LIMIT_PROVIDER_USAGE_ITEMS[id] || []).slice();
  }

  // A stored CSV trimmed to the ids this provider actually offers, in
  // checklist order. Ids a provider does not offer are kept out of the saved
  // string so the file never carries a switch the UI cannot show.
  function normalizeProviderItemCsv(value, providerId) {
    const offered = new Set(limitProviderUsageItems(providerId).map((entry) => entry.id));
    const requested = new Set(
      (Array.isArray(value) ? value : String(value || '').split(','))
        .map(normalizeItemId)
        .filter(Boolean)
    );
    return [...VALID_ITEM_IDS]
      .filter((id) => offered.has(id) && requested.has(id))
      .join(',');
  }

  // The whole setting object: `{ providerId: 'item,item' }`, unknown providers
  // and empty selections dropped.
  function normalizeLimitProviderHiddenItems(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    const providerIds = new Set(
      (limitProviders?.LIMIT_PROVIDER_IDS || []).map((id) => String(id).toLowerCase())
    );
    for (const [key, raw] of Object.entries(value)) {
      const provider = String(key || '').trim().toLowerCase();
      if (!providerIds.has(provider)) continue;
      const csv = normalizeProviderItemCsv(raw, provider);
      if (csv) result[provider] = csv;
    }
    return result;
  }

  // The hidden set for one provider row. Missing/invalid input reads as
  // "everything visible" — the default every fresh install starts from.
  function hiddenLimitUsageItemSet(value, providerId) {
    const items = value && typeof value === 'object' && !Array.isArray(value)
      ? value[String(providerId || '').trim().toLowerCase()]
      : '';
    return new Set(
      String(items || '')
        .split(',')
        .map(normalizeItemId)
        .filter(Boolean)
    );
  }

  // One checkbox flip: returns the next map for the whole setting.
  function toggleLimitUsageItem(value, providerId, itemId) {
    const provider = String(providerId || '').trim().toLowerCase();
    const hidden = hiddenLimitUsageItemSet(value, provider);
    if (hidden.has(itemId)) hidden.delete(itemId);
    else hidden.add(itemId);
    const next = normalizeLimitProviderHiddenItems({ ...(value || {}), [provider]: [...hidden].join(',') });
    return next;
  }

  // The provider's windows minus the ones rendering as hidden items — the
  // shared filter the card, the Home module and the dock pin picker all use.
  function visibleLimitUsageWindows(provider, value) {
    const hidden = hiddenLimitUsageItemSet(value, provider?.provider);
    if (hidden.size === 0) return (provider?.windows || []).slice();
    return (provider?.windows || [])
      .filter((window) => !hidden.has(limitUsageItemIdForWindow(window)));
  }

  return {
    LIMIT_USAGE_ITEM_IDS,
    LIMIT_PROVIDER_USAGE_ITEMS,
    hiddenLimitUsageItemSet,
    limitProviderUsageItems,
    limitUsageItemIdForWindow,
    normalizeLimitProviderHiddenItems,
    normalizeProviderItemCsv,
    toggleLimitUsageItem,
    visibleLimitUsageWindows
  };
});
