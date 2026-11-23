// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).deepseek = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { isCreditsWindow, formatMoney, limitWindowNode, creditsMeterPercent, tagUsageItem, providerSpendNode } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // DeepSeek does not expose a fixed quota denominator. This intentionally
    // visualizes the balance relative to this month's inferred starting funds:
    // current / (current + observed month spend).
    windows.classList.add('limit-windows-deepseek');
    const balance = provider.balance || null;
    if (balance) {
      const currency = balance.currency;
      const creditsWindow = (provider.windows || []).find(/** @param {any} window @returns {any} */ (window) => isCreditsWindow(window));
      const nextGrant = provider.provider === 'typesafe' && Array.isArray(balance.tranches)
        ? balance.tranches.find(/** @param {any} grant @returns {any} */ (grant) => grant.expiresAt && Date.parse(grant.expiresAt) > Date.now())
        : null;
      const boundaryAt = provider.provider === 'typesafe' ? nextGrant?.expiresAt : creditsWindow?.resetsAt;
      const expiringAmount = nextGrant && Math.abs(nextGrant.amount - balance.amount) >= 0.005
        ? formatMoney(nextGrant.amount, nextGrant.currency || currency)
        : '';
      const balanceNode = limitWindowNode(
        'Balance',
        { remainingPercent: creditsMeterPercent(provider, creditsWindow),
          resetsAt: boundaryAt, boundaryKind: creditsWindow?.boundaryKind },
        color,
        0.95,
        formatMoney(balance.amount, currency),
        expiringAmount
      );
      tagUsageItem(balanceNode, 'credits', 'Balance');
      balanceNode.classList.add('limit-window-wide');
      if (!boundaryAt) balanceNode.classList.add('limit-window-no-reset');
      windows.append(balanceNode);

      const spendNode = providerSpendNode(balance, provider);
      if (spendNode) windows.append(spendNode);
    }
  }

  return { renderWindows };
});
