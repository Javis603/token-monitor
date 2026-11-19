// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).zai = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, windowsForKind, limitWindowNode, providerWindowLabel, providerWindowText, creditsMeterPercent, formatMoney, tagUsageItem, providerSpendNode } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // Billing-kind windows are one of three things: the subscription MCP
    // monthly bucket (no metric, no limitId), ZCode Start/Weekend plan
    // buckets (limitId set, per-model labels), or the cash balance
    // (metric 'credits'). Each renders in its own slot below.
    const session = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    const billingWindows = windowsForKind(provider, 'billing');
    const dailyWindows = windowsForKind(provider, 'daily');
    const planBuckets = billingWindows.filter(/** @param {any} window @returns {any} */ (window) => window?.limitId && !window?.metric);
    const monthlyWindows = billingWindows.filter(/** @param {any} window @returns {any} */ (window) => !window?.metric && !window?.limitId);
    const balanceWindow = (provider.windows || []).find(/** @param {any} window @returns {any} */ (window) => window?.metric === 'credits');
    const nodes = [
      session && limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95),
      ...dailyWindows.map(/** @param {any} window @param {any} index @returns {any} */ (window, index) => limitWindowNode(
        window.label || (dailyWindows.length > 1 ? `Daily ${index + 1}` : 'Daily'),
        window,
        color,
        0.78,
        null,
        providerWindowText(provider, window).detail
      )),
      weekly && limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68),
      ...planBuckets.map(/** @param {any} window @returns {any} */ (window) => limitWindowNode(
        window.label || 'Start Plan',
        window,
        color,
        0.68,
        null,
        providerWindowText(provider, window).detail
      ))
    ].filter(Boolean);
    if (nodes.length % 2 === 1) nodes.at(-1).classList.add('limit-window-wide');
    windows.append(...nodes);
    // Monthly subscription buckets stay full width, independent of the
    // paired quota count. Preserve all legacy billing windows without ids.
    for (const monthly of monthlyWindows) {
      const node = limitWindowNode(monthly.label || 'MCP', monthly, color, 0.68, null, monthly.detail || '');
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
    // Balance sits at the bottom on its own full-width row: coding-plan quota
    // is consumed before the cash pool, so the money line reads as the last
    // resort.
    if (balanceWindow) {
      const balanceNode = limitWindowNode(
        'Balance',
        { remainingPercent: creditsMeterPercent(provider, balanceWindow) },
        color,
        0.95,
        formatMoney(balanceWindow.remaining, balanceWindow.currency)
      );
      tagUsageItem(balanceNode, 'credits', 'Balance');
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);
      const spendNode = provider.balance && providerSpendNode(provider.balance);
      if (spendNode) windows.append(spendNode);
    }
  }

  return { renderWindows };
});
