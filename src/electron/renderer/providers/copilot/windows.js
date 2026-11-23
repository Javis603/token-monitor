// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).copilot = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowsForKind, limitWindowNode, providerWindowLabel } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    windows.classList.add('limit-windows-copilot');
    const billingWindows = windowsForKind(provider, 'billing');
    for (const billing of billingWindows) {
      const node = limitWindowNode(providerWindowLabel(provider, billing), billing, color, 0.68);
      node.classList.add('limit-window-wide');
      if (!billing.resetsAt && !billing.resetDescription) node.classList.add('limit-window-no-reset');
      windows.append(node);
    }
  }

  return { renderWindows };
});
