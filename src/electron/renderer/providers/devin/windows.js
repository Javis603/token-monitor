// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).devin = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, isCreditsWindow, limitWindowNode, providerWindowLabel, creditsAmount, formatMoney } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    const daily = windowForKind(provider, 'daily');
    const weekly = windowForKind(provider, 'weekly');
    const balanceWindow = (provider.windows || []).find(isCreditsWindow) || null;
    const quotaNodes = [
      daily && limitWindowNode(providerWindowLabel(provider, daily), daily, color, 0.95),
      weekly && limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68)
    ].filter(Boolean);
    if (quotaNodes.length === 1) quotaNodes[0].classList.add('limit-window-wide');
    windows.append(...quotaNodes);
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
