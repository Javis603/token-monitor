// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).workbuddy = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, creditsBalanceValue, limitWindowNode, tagUsageItem, usageItems, providerSpendNode, settings, presentationApi, subscriptionAccounts, renderProviderWindows } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    const credits = windowForKind(provider, 'billing');
    const balance = provider.balance || null;
    const value = creditsBalanceValue(provider, credits);
    if (credits && value) {
      const displayWindow = {
        ...credits,
        label: credits.label || 'Credits'
      };
      const node = limitWindowNode(
        displayWindow.label,
        displayWindow,
        color,
        0.95,
        value
      );
      tagUsageItem(node, usageItems.limitUsageItemId(credits), displayWindow.label);
      node.classList.add('limit-window-wide');
      if (!displayWindow.resetsAt && !displayWindow.resetDescription) {
        node.classList.add('limit-window-no-reset');
      }
      windows.append(node);
      const spendNode = providerSpendNode(balance);
      if (spendNode) windows.append(spendNode);
    }
  }

  /** @param {any} providers @returns {any} */ function workbuddyCombinedProvider(providers) {
    if (settings()?.workbuddyQuotaTotalEnabled !== true) return null;
    const windows = presentationApi.workbuddyCreditTotals(providers);
    if (!windows || windows.length !== 1 || windows[0].currency !== 'CREDITS') return null;
    const first = providers[0];
    const remaining = windows[0].remaining;
    return {
      ...first, accountKey: '', accountName: '', accountEmail: '', accountLabel: '',
      accountGroup: true, groupAccounts: providers,
      updatedAt: providers.map(/** @param {any} provider @returns {any} */ (provider) => provider.updatedAt || '').sort()[0],
      windows,
      balance: { amount: remaining, currency: 'CREDITS' }
    };
  }

  /** @param {any} providers @returns {any} */ function collapseWorkbuddyAccounts(providers) {
    const accounts = providers.filter(/** @param {any} provider @returns {any} */ (provider) => provider.provider === 'workbuddy');
    const combined = workbuddyCombinedProvider(accounts);
    if (!combined) return providers;
    let inserted = false;
    return providers.flatMap(/** @param {any} provider @returns {any} */ (provider) => {
      if (provider.provider !== 'workbuddy') return [provider];
      if (inserted) return [];
      inserted = true;
      return [combined];
    });
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: grouped ? { showIcon: false } : {}
  });

  /** @param {any} row @param {any} accountList @param {any} providers @param {any} color @returns {any} */ function decorateGroup(row, accountList, providers, color) {
    // Dock visibility/reporting filters may omit a failed or unlimited
    // sibling. A total is eligible only when this group covers the complete
    // known identity pool supplied beside the drawn rows.
    const known = subscriptionAccounts().filter(/** @param {any} account @returns {any} */ (account) => account?.provider === 'workbuddy'
        && !presentationApi.isWorkbuddyPlaceholder(account));
    const drawnKeys = new Set(providers.map(/** @param {any} account @returns {any} */ (account) => account.accountKey));
    const complete = known.every(/** @param {any} account @returns {any} */ (account) => account.accountKey && drawnKeys.has(account.accountKey));
    const combined = complete ? workbuddyCombinedProvider(providers) : null;
    if (combined) row.insertBefore(renderProviderWindows(combined, color), accountList);
  }

  return { renderWindows, workbuddyCombinedProvider, collapseWorkbuddyAccounts, rowPolicy, decorateGroup };
});
