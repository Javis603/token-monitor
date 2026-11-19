// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).cline = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, windowsForKind, isCreditsWindow, limitWindowNode, providerWindowLabel, creditsBalanceValue, optionalFiniteNumber, formatBalanceSpendAmount, tagUsageItem, limitNoteRowNode } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // ClinePass measures three quota windows, and the account's credit arrives as
    // a fourth "billing" window — told apart by its metric rather than by its
    // kind, and rendered the way WorkBuddy's and Trae's balance is. The default
    // branch below renders session and weekly only, which would silently drop a
    // third of the subscription.
    const clineSession = windowForKind(provider, 'session');
    const clineWeekly = windowForKind(provider, 'weekly');
    const clineBilling = windowsForKind(provider, 'billing');
    const clineMonthly = clineBilling.find(/** @param {any} window @returns {any} */ (window) => !isCreditsWindow(window) && window.metric !== 'spend') || null;
    const clineCredits = clineBilling.find(/** @param {any} window @returns {any} */ (window) => isCreditsWindow(window)) || null;
    const clineSpend = clineBilling.find(/** @param {any} window @returns {any} */ (window) => window.metric === 'spend') || null;
    if (clineSession) {
      windows.append(limitWindowNode(providerWindowLabel(provider, clineSession), clineSession, color, 0.95));
    }
    if (clineWeekly) {
      windows.append(limitWindowNode(providerWindowLabel(provider, clineWeekly), clineWeekly, color, 0.68));
    }
    if (clineMonthly) {
      const node = limitWindowNode(providerWindowLabel(provider, clineMonthly), clineMonthly, color, 0.5);
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
    if (clineCredits) {
      const node = clineCreditsNode(provider, clineCredits, clineSpend);
      if (node) windows.append(node);
    }
  }

  /** @param {any} provider @param {any} credits @param {any} spend @returns {any} */ function clineCreditsNode(provider, credits, spend) {
    const value = creditsBalanceValue(provider, credits);
    if (!value) return null;
    const monthSpend = optionalFiniteNumber(spend?.used);
    const spendValue = monthSpend === null ? '' : formatBalanceSpendAmount(monthSpend, spend);
    const label = credits.label || 'Credits';
    // The month's spend is part of this row, so one item covers both.
    return tagUsageItem(limitNoteRowNode({
      label,
      summary: value,
      detailEntries: spendValue ? [['Month spent', spendValue]] : null,
      ariaParts: [value, ...(spendValue ? [`Month spent ${spendValue}`] : [])]
    }), 'credits', label);
  }

  return { renderWindows, clineCreditsNode };
});
