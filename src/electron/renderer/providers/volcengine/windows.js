// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).volcengine = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, limitWindowNode, providerWindowLabel, limitAccountDefaultTitle } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    const session = windowForKind(provider, 'session');
    const daily = windowForKind(provider, 'daily');
    const weekly = windowForKind(provider, 'weekly');
    const monthly = windowForKind(provider, 'billing');
    const nodes = [
      session && limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95),
      daily && limitWindowNode(providerWindowLabel(provider, daily), daily, color, 0.78),
      weekly && limitWindowNode('Weekly', weekly, color, 0.68),
      monthly && limitWindowNode(providerWindowLabel(provider, monthly), monthly, color, 0.68)
    ].filter(Boolean);
    if (nodes.length % 2 === 1) nodes.at(-1).classList.add('limit-window-wide');
    windows.append(...nodes);
  }

  /** @param {any} provider @param {any} index @param {any} providers @returns {any} */ function volcenginePlanAccountTitle(provider, index, providers) {
    return provider?.accountDisplayName || limitAccountDefaultTitle(provider, index, providers);
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: grouped ? { planText: provider?.status === 'ok' ? provider.accountLabel || undefined : undefined } : {}
  });

  const accountTitle = /** @param {any} provider @param {any} index @param {any} providers @returns {any} */ (provider, index, providers) => volcenginePlanAccountTitle(provider, index, providers);

  return { renderWindows, volcenginePlanAccountTitle, rowPolicy, accountTitle, groupCountKey: 'settings.volcengine.nPlans' };
});
