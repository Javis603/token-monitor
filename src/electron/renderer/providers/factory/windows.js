// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).factory = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { isCreditsWindow, limitWindowNode, providerWindowLabel, creditsAmount, formatMoney } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // Token-rate-limit accounts carry a Standard pool and, once it has been
    // used, a Core pool marked `additional` — 5-hour, weekly and monthly
    // each — plus the extra-usage balance as a credits window; legacy
    // accounts carry Standard/Premium billing windows instead. The default
    // branch draws session + weekly only, dropping every monthly row and the
    // balance. normalizeProvider() sorts by kind, which interleaves the two
    // pools, so each pool renders as its own group: rate windows pair up,
    // billing windows span the row.
    const balanceWindow = (provider.windows || []).find(isCreditsWindow) || null;
    const quotaWindows = (provider.windows || []).filter(/** @param {any} window @returns {any} */ (window) => window !== balanceWindow);
    for (const additional of [false, true]) {
      const pool = quotaWindows.filter(/** @param {any} window @returns {any} */ (window) => (window?.additional === true) === additional);
      const rateNodes = pool
        .filter(/** @param {any} window @returns {any} */ (window) => window.kind !== 'billing')
        .map(/** @param {any} window @returns {any} */ (window) => limitWindowNode(
          providerWindowLabel(provider, window),
          window,
          color,
          window.kind === 'session' ? 0.95 : 0.68
        ));
      if (rateNodes.length % 2 === 1) rateNodes.at(-1).classList.add('limit-window-wide');
      const billingNodes = pool
        .filter(/** @param {any} window @returns {any} */ (window) => window.kind === 'billing')
        .map(/** @param {any} window @returns {any} */ (window) => {
          const node = limitWindowNode(providerWindowLabel(provider, window), window, color, 0.5);
          node.classList.add('limit-window-wide');
          return node;
        });
      windows.append(...rateNodes, ...billingNodes);
    }
    if (balanceWindow) {
      const amount = creditsAmount(provider, balanceWindow);
      if (amount !== null) {
        const balanceNode = limitWindowNode(
          providerWindowLabel(provider, balanceWindow, 'Extra usage balance'),
          { ...balanceWindow, showMeter: false },
          color,
          0.68,
          formatMoney(amount, balanceWindow.currency || provider.balance?.currency)
        );
        balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(balanceNode);
      }
    }
  }

  return { renderWindows };
});
