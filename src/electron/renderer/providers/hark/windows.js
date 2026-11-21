// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).hark = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { limitWindowNode, providerWindowLabel, providerWindowText, tagUsageItem, limitNoteRowNode, usageItems, repairWindowPairs } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // The default layout only draws session/weekly quotas; Hark has daily/billing pools.
    const quotaNodes = (provider.windows || [])
      .filter(/** @param {any} window @returns {any} */ (window) => window.metric !== 'spend' && (window.kind === 'daily' || window.kind === 'billing'))
      .map(/** @param {any} window @returns {any} */ (window) => limitWindowNode(
        providerWindowLabel(provider, window), window, color, 0.78, null, providerWindowText(provider, window).detail
      ));
    windows.append(...quotaNodes);
    for (const spend of (provider.windows || []).filter(/** @param {any} window @returns {any} */ (window) => window.metric === 'spend')) {
      const value = providerWindowText(provider, spend).value;
      if (!value) continue;
      const label = spend.label || 'Top-up';
      windows.append(tagUsageItem(limitNoteRowNode({
        label,
        summary: value,
        ariaParts: [value]
      }), usageItems.limitUsageItemId(spend), label));
    }
    repairWindowPairs(windows);
  }

  return { renderWindows };
});
