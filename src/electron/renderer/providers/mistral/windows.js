// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).mistral = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { isCreditsWindow, limitWindowNode, providerWindowLabel, providerWindowText, creditsBalanceValue, tagUsageItem, limitNoteRowNode } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // Keep API and Vibe allowances on separate full-width rows. The wallet
    // has no quota denominator and must not become a percentage meter.
    const quotaNodes = (provider.windows || [])
      .filter(/** @param {any} window @returns {any} */ (window) => !isCreditsWindow(window))
      .map(/** @param {any} window @returns {any} */ (window) => {
        const node = limitWindowNode(
          providerWindowLabel(provider, window), window, color, 0.78,
          null, providerWindowText(provider, window).detail
        );
        node.classList.add('limit-window-wide');
        return node;
      });
    windows.append(...quotaNodes);
    for (const wallet of (provider.windows || []).filter(isCreditsWindow)) {
      const value = creditsBalanceValue(provider, wallet);
      if (!value) continue;
      const label = providerWindowLabel(provider, wallet, 'Balance');
      windows.append(tagUsageItem(limitNoteRowNode({ label, summary: value, ariaParts: [value] }), 'credits', label));
    }
  }

  return { renderWindows };
});
