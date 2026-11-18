// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).manus = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { isCreditsWindow, limitWindowNode, providerWindowLabel, creditsBalanceValue, tagUsageItem, limitNoteRowNode } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // The refreshing allowance is a quota with a reset; the spendable total is a
    // points balance without a ceiling. The default branch renders neither a
    // daily window nor a credits balance.
    const balanceWindow = (provider.windows || []).find(isCreditsWindow) || null;
    const quotaNodes = (provider.windows || [])
      .filter(/** @param {any} window @returns {any} */ (window) => window !== balanceWindow && (window.kind === 'daily' || window.kind === 'billing'))
      .map(/** @param {any} window @returns {any} */ (window) => limitWindowNode(providerWindowLabel(provider, window), window, color, 0.78));
    if (quotaNodes.length === 1) quotaNodes[0].classList.add('limit-window-wide');
    windows.append(...quotaNodes);
    const balanceValue = balanceWindow ? creditsBalanceValue(provider, balanceWindow) : '';
    if (balanceValue) {
      const label = balanceWindow.label || 'Credits';
      windows.append(tagUsageItem(limitNoteRowNode({
        label,
        summary: balanceValue,
        ariaParts: [balanceValue]
      }), 'credits', label));
    }
  }

  return { renderWindows };
});
