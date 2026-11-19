// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).ollama = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { spendWindow, usageItems, settings, windowForKind, limitWindowNode, providerWindowLabel, windowsForKind, isCreditsWindow, creditsAmount, creditsMeterPercent, formatMoney, creditsCurrency, limitNoteRowNode, tagUsageItem } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @param {any} options @returns {any} */ function renderWindows(provider, color, windows, options = {}) {
    const spent = spendWindow(provider);
    const visibleSpend = options.showAllUsageItems || !usageItems.isLimitWindowHidden(settings()?.limitProviderHiddenItems, 'ollama', spent)
      ? spent : null;
    let hasWallet = false;
    const session = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    if (session) {
      const node = limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95);
      if (!weekly) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    if (weekly) windows.append(limitWindowNode('Weekly', weekly, color, 0.68));
    for (const monthly of windowsForKind(provider, 'billing').filter(/** @param {any} window @returns {any} */ (window) => !window.metric)) {
      const node = limitWindowNode(providerWindowLabel(provider, monthly), monthly, color, 0.95);
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
    // Included credits have a real denominator. Wallet balances do not;
    // their showMeter:false survives both local and synced presentation.
    for (const creditsWindow of (provider.windows || []).filter(/** @param {any} window @returns {any} */ (window) => isCreditsWindow(window) && window.showMeter !== false)) {
      const amount = creditsAmount(provider, creditsWindow);
      if (amount === null) continue;
      const node = limitWindowNode(
        providerWindowLabel(provider, creditsWindow, 'Balance'),
        { ...creditsWindow, remainingPercent: creditsMeterPercent(provider, creditsWindow, { inferBalance: creditsWindow.showMeter !== false }) },
        color,
        0.95,
        formatMoney(amount, creditsCurrency(provider, creditsWindow))
      );
      node.classList.add('limit-window-wide');
      if (!creditsWindow.resetsAt && !creditsWindow.resetDescription) node.classList.add('limit-window-no-reset');
      windows.append(node);
    }
    for (const wallet of (provider.windows || []).filter(/** @param {any} window @returns {any} */ (window) => isCreditsWindow(window) && window.showMeter === false)) {
      if (!options.showAllUsageItems && usageItems.isLimitWindowHidden(settings()?.limitProviderHiddenItems, 'ollama', wallet)) continue;
      const amount = creditsAmount(provider, wallet);
      if (amount === null) continue;
      const details = [];
      if (visibleSpend && Number.isFinite(visibleSpend.used)) details.push([visibleSpend.label || 'Monthly credits used', formatMoney(visibleSpend.used, visibleSpend.currency)]);
      if (wallet.resetDescription) details.push({ full: wallet.resetDescription });
      const label = providerWindowLabel(provider, wallet, 'Credit balance');
      const value = formatMoney(amount, creditsCurrency(provider, wallet));
      const node = limitNoteRowNode({ label, summary: value, detailEntries: details.length ? details : null, ariaParts: [value] });
      tagUsageItem(node, 'credits', label);
      windows.append(node);
      hasWallet = true;
    }
    if (!hasWallet && spent && Number.isFinite(spent.used)) {
      const node = limitWindowNode(spent.label || 'Monthly credits used', { ...spent, showMeter: false }, color, 0.68, formatMoney(spent.used, spent.currency));
      node.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(node);
    }
  }

  // Spending remains selectable when the wallet folds it into a tooltip.
  /** @param {any} record */
  function extraUsageItems(record) {
    const spent = spendWindow(record);
    return spent && Number.isFinite(spent.used) ? [{ id: 'spend', label: spent.label || 'Monthly credits used' }] : [];
  }

  return { extraUsageItems, renderWindows };
});
