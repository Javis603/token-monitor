// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).minimax = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowsForKind, providerWindowText, limitWindowNode, providerWindowLabel, providerSpendNode, renderGenericWindows, limitAccountDefaultTitle, usageItems, settings, limitProviderUsageItems, limitAccountRowPolicy, renderLimitProviderRow, document, renderLimitProviderGroupFrame, subscriptionForProvider, t } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function appendWeekly(provider, color, windows) {
    for (const weekly of windowsForKind(provider, 'weekly')) {
      const detail = providerWindowText(provider, weekly).detail;
      const node = limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68, null, detail);
      if (!weekly.resetsAt && !weekly.resetDescription && !detail) node.classList.add('limit-window-no-reset');
      windows.append(node);
    }}
  /** @param {any} provider @param {any} windows @returns {any} */ function appendSpend(provider, windows) {
    const spendNode = provider.balance && providerSpendNode(provider.balance, provider);
    if (spendNode) windows.append(spendNode);
  }
  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) { renderGenericWindows(provider, color, windows, { omitEmptyReset: true, appendWeekly, appendSpend }); }

  /** @param {any} providers @returns {any} */ function minimaxAccountGroups(providers) {
    const groups = new Map();
    for (const provider of providers) {
      const code = provider.source === 'api' && providers.find(/** @param {any} row @returns {any} */ row => row.source === 'oauth'
        && row.accountKey && provider.accountKey && row.region && row.region === provider.region
        && provider.relatedAccountKey === row.accountKey);
      const key = code?.accountKey || provider.accountKey || provider;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(provider);
    }
    // The Code row owns plan and subscription identity, so it leads its group.
    return [...groups.values()].map(/** @param {any} group @returns {any} */ (group) => group.sort(
      /** @param {any} a @param {any} b @returns {any} */ (a, b) => Number(b.source === 'oauth') - Number(a.source === 'oauth')
    ));
  }

  /** @param {any} provider @param {any} index @param {any} providers @returns {any} */ function minimaxAccountTitle(provider, index, providers) {
    const groups = minimaxAccountGroups(providers);
    if (providers.length > 1 && groups.length === 1) return '';
    const representatives = groups.map(/** @param {any} group @returns {any} */ group => group[0]);
    const groupIndex = groups.findIndex(/** @param {any} group @returns {any} */ group => group.includes(provider));
    return limitAccountDefaultTitle(representatives[groupIndex], groupIndex, representatives);
  }

  /** @param {any} label @param {any} providers @param {any} color @param {any} grouped @returns {any} */ function renderMinimaxAccount(label, providers, color, grouped = false) {
    const [lead, ...rest] = providers;
    const hidden = usageItems.hiddenUsageItemSet(settings()?.limitProviderHiddenItems, 'minimax');
    const fullyHidden = /** @param {any} provider @returns {any} */ (provider) => {
      const items = limitProviderUsageItems([provider]);
      return items.length > 0 && items.every(/** @param {any} item @returns {any} */ (item) => hidden.has(item.id));
    };
    const leadPolicy = limitAccountRowPolicy('minimax', lead, color, { grouped, sharedFamily: null });
    const row = renderLimitProviderRow('minimax', label, lead, color, {
      accountRow: grouped, accountLabel: label, ...leadPolicy.options
    });
    if (rest.some(/** @param {any} provider @returns {any} */ (provider) => provider.stale)) row.classList.add('stale');
    const lanes = [];
    if (rest.length) {
      const list = document.createElement('div');
      list.className = 'limit-account-list';
      const windows = [...row.children].find(/** @param {any} node @returns {any} */ (node) => node.classList.contains('limit-windows'));
      if (windows) {
        const leadLane = document.createElement('div');
        leadLane.className = 'limit-row limit-account-row';
        // This is the lead account's own quota, not a separate history row.
        leadLane.dataset.limitLead = '';
        windows.remove();
        leadLane.append(windows);
        list.append(leadLane);
        lanes.push({ node: leadLane, windows, provider: lead });
      }
      for (const provider of rest) {
        const policy = limitAccountRowPolicy('minimax', provider, color, { grouped: true, sharedFamily: null });
        const lane = renderLimitProviderRow('minimax', '', provider, policy.color, {
          accountRow: true,
          ...policy.options
        });
        list.append(lane);
        lanes.push({ node: lane, windows: lane.querySelector('.limit-windows'), provider });
      }
      row.append(list);
    } else {
      const windows = [...row.children].find(/** @param {any} node @returns {any} */ (node) => node.classList.contains('limit-windows'));
      if (windows) lanes.push({ node: row, windows, provider: lead });
    }
    const emptied = lanes.filter(/** @param {any} options0 @returns {any} */ ({ windows, provider }) => windows?.children.length === 0 && fullyHidden(provider));
    if (lanes.length > 0 && emptied.length === lanes.length) return null;
    for (const { node } of emptied) node.remove();
    return row;
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: { accountTitle: true, ...(grouped ? { showIcon: false } : {}) }
  });

  const accountTitle = minimaxAccountTitle;

  /** @param {any} label @param {any} providers @param {any} color @returns {any} */ function renderGroup(label, providers, color) { const providerId = 'minimax';

    const groups = minimaxAccountGroups(providers);
    if (groups.length === 1 && providers.length > 1) {
      const account = renderMinimaxAccount(label, groups[0], color);
      if (account) return account;
      const { row } = renderLimitProviderGroupFrame(providerId, label, providers, color, { count: 0 });
      row.style.display = 'none';
      return row;
    }
    if (groups.some(/** @param {any} group @returns {any} */ group => group.length > 1)) {
      const representatives = groups.map(/** @param {any} group @returns {any} */ group => group[0]);
      const accounts = groups.map(/** @param {any} group @param {any} index @returns {any} */ (group, index) => renderMinimaxAccount(
        limitAccountDefaultTitle(representatives[index], index, representatives), group, color, true
      )).filter(Boolean);
      const { row, list } = renderLimitProviderGroupFrame(providerId, label, providers, color, { count: accounts.length });
      accounts.forEach(/** @param {any} account @returns {any} */ (account) => list.append(account));
      if (accounts.length === 0) row.style.display = 'none';
      return row;
    }

    return null;
  }

  /** @param {any} plan @param {any} provider @param {any} options @returns {any} */ function decoratePlan(plan, provider, options) { if (!plan.textContent && options.planText === undefined && subscriptionForProvider(provider)) plan.textContent = t('settings.subscriptions.title'); }

  return { renderWindows, minimaxAccountGroups, minimaxAccountTitle, renderMinimaxAccount, rowPolicy, accountTitle, renderGroup, decoratePlan };
});
