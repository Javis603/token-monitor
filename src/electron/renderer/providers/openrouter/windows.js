// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).openrouter = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { optionalFiniteNumber, limitWindowNode, formatMoney, tagUsageItem, providerSpendNode, namedApiAccountTitle } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    windows.classList.add('limit-windows-openrouter');
    const balance = provider.balance || null;
    const currency = balance?.currency || 'USD';
    const balanceAmount = optionalFiniteNumber(balance?.amount);
    const creditsWindow = openrouterCreditsWindow(provider);
    if (balanceAmount !== null) {
      const balanceWindow = creditsWindow || (balanceAmount === 0
        ? { usedPercent: 100, remainingPercent: 0, showMeter: true }
        : { showMeter: false });
      const balanceNode = limitWindowNode(
        'Balance',
        { ...balanceWindow, label: 'Balance' },
        color,
        0.95,
        formatMoney(balanceAmount, currency)
      );
      tagUsageItem(balanceNode, 'credits', 'Balance');
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);
    }
    for (const quotaWindow of (provider.windows || []).filter(/** @param {any} window @returns {any} */ (window) => window !== creditsWindow)) {
      const hasMeter = quotaWindow?.showMeter !== false;
      const remaining = optionalFiniteNumber(quotaWindow?.remaining);
      const limit = optionalFiniteNumber(quotaWindow?.limit);
      const absoluteDetail = hasMeter && remaining !== null && limit !== null
        ? `${formatMoney(remaining, 'USD')} left · ${formatMoney(limit, 'USD')} total`
        : '';
      const valueOverride = hasMeter ? null : (quotaWindow?.detail || '—');
      const node = limitWindowNode(
        quotaWindow?.label || 'Usage',
        quotaWindow,
        color,
        hasMeter ? 0.85 : 0.6,
        valueOverride,
        absoluteDetail
      );
      node.classList.add('limit-window-wide');
      if (!hasMeter) node.classList.add('limit-window-no-reset');
      windows.append(node);
    }
    const spendNode = providerSpendNode(balance);
    if (spendNode) windows.append(spendNode);
  }

  /** @param {any} provider @returns {any} */ function openrouterCreditsWindow(provider) {
    const windows = Array.isArray(provider?.windows) ? provider.windows : [];
    // Older hubs normalized windows before `metric` existed. Keep the label
    // fallback only for those mixed-version payloads.
    return windows.find(/** @param {any} window @returns {any} */ (window) => window?.metric === 'credits')
      || windows.find(/** @param {any} window @returns {any} */ (window) => !window?.metric && window?.label === 'Credits')
      || null;
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: grouped ? {
      showIcon: false,
      // A credits-only response has no key plan; accountLabel then repeats
      // the profile title. Keep explicit plans and recovery status visible.
      ...((provider?.status === 'ok' || provider?.stale)
          && !String(provider?.planLabel || '').trim()
          && String(provider?.accountName || '').trim()
          && String(provider?.accountName || '').trim() === String(provider?.accountLabel || '').trim()
        ? { planText: '' } : {})
    } : {}
  });

  const accountTitle = /** @param {any} provider @param {any} index @returns {any} */ (provider, index) => provider?.accountDisplayName || namedApiAccountTitle(provider, index, 'openrouter');

  return { renderWindows, openrouterCreditsWindow, rowPolicy, accountTitle };
});
