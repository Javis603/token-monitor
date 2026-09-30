'use strict';

// Per-provider "visible usage items": the rows a provider's limits card may
// draw, and the user's hidden selection among them.
//
// The checklist enumerates the provider's actual rows — every window the
// payload carries, plus the non-window rows the card draws when their data
// is present (the reset-credits line, the spend note, MiMo's Token Plan) —
// so the settings list names exactly what the card draws, one checkbox per
// row, the same model the edge dock's window picker uses.
//
// `settings.limitProviderHiddenItems` stores the hidden half —
// `{ providerId: [rowKey, ...] }` — so a row introduced later defaults to
// shown instead of silently disappearing for upgraded installs. Window rows
// key by `limitWindowKey`, the same identity the dock's pinned-window picker
// uses; synthesized rows carry stable plain ids ('resets', 'spend',
// 'monthly').
//
// Pure data and pure functions, no DOM and no Node built-ins: the widget
// renderer and the edge dock load it as a plain <script>, the main process
// requires it to normalize the setting, and node:test can require it.
(function exposeLimitUsageItems(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(
    node ? require('./providers') : root?.TokenMonitorLimitProviders,
    node ? require('./windowLabels') : root?.TokenMonitorLimitWindowLabels
  );
  if (node) module.exports = api;
  if (root) root.TokenMonitorLimitUsageItems = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLimitUsageItemsApi(limitProviders, windowLabels) {
  function normalizedId(value) {
    return String(value || '').trim().toLowerCase();
  }

  // ---- Window keys: the per-row identity ----------------------------------
  // The same key the dock's pinned-window picker writes. `limitId` is a
  // backend id that survives display-name changes; the legacy shape falls
  // back to kind/label/metric/additional for windows that carry none.
  function legacyLimitWindowKey(window) {
    if (!window || typeof window !== 'object' || !window.kind) return '';
    return JSON.stringify([
      String(window.kind), String(window.label || ''),
      String(window.metric || ''), window.additional === true
    ]);
  }

  function limitWindowKey(window) {
    const legacy = legacyLimitWindowKey(window);
    if (!legacy) return '';
    const limitId = String(window.limitId || '').trim();
    if (!limitId) return legacy;
    const minutes = Number(window.windowMinutes);
    return JSON.stringify([
      'id', limitId, String(window.kind), String(window.metric || ''),
      window.additional === true,
      Number.isFinite(minutes) && minutes > 0 ? minutes : null
    ]);
  }

  function limitWindowKeys(window) {
    return [...new Set([limitWindowKey(window), legacyLimitWindowKey(window)])].filter(Boolean);
  }

  // Validates a stored key and returns its canonical form, or '' when the
  // value is not a key `limitWindowKey` could have produced.
  function normalizeWindowKey(value) {
    if (typeof value !== 'string' || value.length > 400) return '';
    try {
      const parts = JSON.parse(value);
      if (!Array.isArray(parts)) return '';
      if (parts.length === 6 && parts[0] === 'id') {
        const [, limitId, kind, metric, additional, windowMinutes] = parts;
        if (typeof limitId !== 'string' || !limitId.trim() || typeof kind !== 'string' || !kind
          || typeof metric !== 'string' || typeof additional !== 'boolean'
          || !(windowMinutes === null || (typeof windowMinutes === 'number' && windowMinutes > 0))) return '';
        return limitWindowKey({ limitId, kind, metric, additional, windowMinutes });
      }
      if (parts.length === 4) {
        const [kind, label, metric, additional] = parts;
        if (typeof kind !== 'string' || !kind || typeof label !== 'string'
          || typeof metric !== 'string' || typeof additional !== 'boolean') return '';
        return legacyLimitWindowKey({ kind, label, metric, additional });
      }
      return '';
    } catch {
      return '';
    }
  }

  // ---- Row ids -------------------------------------------------------------
  // Rows whose rendered identity survives a change of payload
  // representation: the money rows ('credits' for the balance row — a
  // `metric: 'credits'` window or the provider-level balanceUsd fallback;
  // 'spend' for the spend line — a `metric: 'spend'` window or the
  // balance-fields note), 'resets' for the reset-credits line, and 'monthly'
  // for MiMo's Token Plan (a billing window or a balance-synthesized
  // fallback). Everything else keys by its window key.
  const SYNTH_ROW_IDS = new Set(['resets', 'spend', 'monthly', 'credits']);

  function limitUsageRowId(providerId, window) {
    const metric = String(window?.metric || '').trim().toLowerCase();
    if (metric === 'credits') return 'credits';
    // Mirrors `balanceDisplay.spendWindow`'s old-hub fallback: a metric-less
    // billing window carrying the canonical spend label is the same row.
    if (metric === 'spend'
      || (!metric && window?.kind === 'billing' && window?.label === 'Usage credits')) return 'spend';
    if (normalizedId(providerId) === 'mimo' && window?.kind === 'billing') return 'monthly';
    return limitWindowKey(window);
  }

  // Reconstruct enough of a window from its stored key to name the row —
  // used to keep hidden-but-absent rows listed so they can be unhidden.
  function windowFromKey(key) {
    try {
      const parts = JSON.parse(key);
      if (!Array.isArray(parts)) return null;
      if (parts.length === 6 && parts[0] === 'id') {
        const [, limitId, kind, metric, additional, windowMinutes] = parts;
        return { limitId, kind, metric, additional, windowMinutes };
      }
      if (parts.length === 4) {
        const [kind, label, metric, additional] = parts;
        return { kind, label, metric, additional };
      }
      return null;
    } catch {
      return null;
    }
  }

  // The i18n label for a synthesized row that isn't currently drawn — the
  // same key a live row's descriptor carries.
  const SYNTH_ROW_LABEL_KEYS = {
    credits: 'settings.limits.items.credits',
    resets: 'settings.limits.items.resets',
    spend: 'settings.limits.items.spend',
    monthly: 'settings.limits.capability.tokenPlan'
  };

  // A stored row key: a window key, or one of the synthesized-row ids.
  function normalizeRowKey(value) {
    if (typeof value !== 'string') return '';
    const key = value.trim();
    if (!key) return '';
    if (SYNTH_ROW_IDS.has(key)) return key;
    return normalizeWindowKey(key);
  }

  // ---- The checklist -------------------------------------------------------
  // Same presence rule the renderer's `optionalFiniteNumber` uses: null,
  // undefined and '' mean "no reading", not zero.
  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  // Whether the provider's current data produces a spend note row. Mirrors
  // the renderer's spend builders: typesafe summarizes `usageSummary`, the
  // rest read spend figures off the balance.
  function providerHasSpendRow(provider) {
    if (!provider || typeof provider !== 'object') return false;
    if (normalizedId(provider.provider) === 'typesafe') {
      const usage = provider.usageSummary;
      return usage?.period === 'month' && finiteNumber(usage?.totalTokens) !== null;
    }
    const balance = provider.balance;
    if (!balance || typeof balance !== 'object') return false;
    return ['todaySpend', 'weekSpend', 'monthSpend', 'allTimeSpend']
      .some((key) => finiteNumber(balance[key]) !== null);
  }

  // Whether the balance can synthesize MiMo's Token Plan row — the same
  // fields the renderer's `mimoTokenPlanWindowFromBalance` fallback reads,
  // plus the expired-plan notice that stands in for it.
  function mimoHasTokenPlan(provider) {
    const balance = provider?.balance;
    if (!balance || typeof balance !== 'object') return false;
    if (balance.planStatus === 'expired') return true;
    return ['planUsed', 'planLimit', 'planPercent']
      .some((key) => finiteNumber(balance[key]) !== null);
  }

  // The rows the provider's card can draw — exactly what the checklist
  // offers. Codex's additional pools answer to their own
  // `showCodexAdditionalLimits` switch, so they stay off the list; every
  // other window enumerates with the label the card shows, and the
  // synthesized rows appear only when their data is present. `hiddenValue`
  // keeps already-hidden rows listed while their data is away, so a row
  // that drops off the payload can still be unhidden.
  function limitProviderUsageRows(provider, hiddenValue = null) {
    if (!provider || typeof provider !== 'object') return [];
    const providerId = normalizedId(provider.provider);
    const rows = [];
    const seen = new Set();
    for (const window of provider.windows || []) {
      if (providerId === 'codex' && window?.additional === true) continue;
      const id = limitUsageRowId(providerId, window);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        label: windowLabels?.limitWindowLabel(providerId, window) || String(window?.label || '').trim()
      });
    }
    // Rows that are not windows in the payload but still draw: the balance
    // fallback off `balanceUsd`/balance fields, the reset-credits line, the
    // spend note, and MiMo's balance-synthesized plan.
    if (!seen.has('credits')
      && (finiteNumber(provider.balance?.amount) !== null
        || finiteNumber(provider.balanceUsd) !== null)) {
      rows.push({ id: 'credits', labelKey: 'settings.limits.items.credits' });
    }
    if (provider.resetCredits) {
      rows.push({ id: 'resets', labelKey: 'settings.limits.items.resets' });
    }
    if (!seen.has('spend') && providerHasSpendRow(provider)) {
      rows.push({ id: 'spend', labelKey: 'settings.limits.items.spend' });
    }
    if (providerId === 'mimo' && !seen.has('monthly') && mimoHasTokenPlan(provider)) {
      rows.push({ id: 'monthly', labelKey: 'settings.limits.capability.tokenPlan' });
    }
    for (const key of hiddenLimitUsageItemSet(hiddenValue, providerId)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (SYNTH_ROW_IDS.has(key)) {
        rows.push({ id: key, labelKey: SYNTH_ROW_LABEL_KEYS[key] });
        continue;
      }
      const window = windowFromKey(key);
      if (window && !(providerId === 'codex' && window.additional === true)) {
        rows.push({
          id: key,
          label: windowLabels?.limitWindowLabel(providerId, window)
            || String(window.label || '').trim()
        });
      }
    }
    return rows;
  }

  // ---- The hidden selection --------------------------------------------------
  // The whole setting object: `{ providerId: [rowKey, ...] }`. Unknown
  // providers, malformed keys and empty selections are dropped; a legacy CSV
  // value is tolerated (kind ids it carried just fall away).
  function normalizeLimitProviderHiddenItems(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    const providerIds = new Set(
      (limitProviders?.LIMIT_PROVIDER_IDS || []).map((id) => String(id).toLowerCase())
    );
    for (const [key, raw] of Object.entries(value)) {
      const provider = normalizedId(key);
      if (!providerIds.has(provider)) continue;
      const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
      const keys = [...new Set(list.map(normalizeRowKey).filter(Boolean))];
      if (keys.length) result[provider] = keys;
    }
    return result;
  }

  // The hidden set for one provider row. Missing/invalid input reads as
  // "everything visible" — the default every fresh install starts from.
  function hiddenLimitUsageItemSet(value, providerId) {
    const raw = value && typeof value === 'object' && !Array.isArray(value)
      ? value[normalizedId(providerId)]
      : null;
    const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
    return new Set(list.map(normalizeRowKey).filter(Boolean));
  }

  // One checkbox flip: returns the next map for the whole setting.
  function toggleLimitUsageItem(value, providerId, itemId) {
    const provider = normalizedId(providerId);
    const hidden = hiddenLimitUsageItemSet(value, provider);
    if (hidden.has(itemId)) hidden.delete(itemId);
    else hidden.add(itemId);
    return normalizeLimitProviderHiddenItems({ ...(value || {}), [provider]: [...hidden] });
  }

  // The provider's windows minus the ones rendering as hidden rows — the
  // shared filter the card, the Home module and the dock pin picker all use.
  // Codex's additional pools stay out of the checklist entirely (they answer
  // to `showCodexAdditionalLimits`), so a stored key can never hide them.
  function visibleLimitUsageWindows(provider, value) {
    const hidden = hiddenLimitUsageItemSet(value, provider?.provider);
    if (hidden.size === 0) return (provider?.windows || []).slice();
    const providerId = normalizedId(provider?.provider);
    return (provider?.windows || [])
      .filter((window) => (providerId === 'codex' && window?.additional === true)
        || !hidden.has(limitUsageRowId(providerId, window)));
  }

  return {
    SYNTH_ROW_IDS,
    hiddenLimitUsageItemSet,
    legacyLimitWindowKey,
    limitProviderUsageRows,
    limitUsageRowId,
    limitWindowKey,
    limitWindowKeys,
    normalizeLimitProviderHiddenItems,
    normalizeWindowKey,
    toggleLimitUsageItem,
    visibleLimitUsageWindows
  };
});
