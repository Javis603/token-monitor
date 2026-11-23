// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).cursor = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { providerWindowText, providerWindowLabel, limitWindowNode, tagUsageItem, usageItems } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    windows.classList.add('limit-windows-cursor');
    for (const quotaWindow of provider.windows || []) {
      const text = providerWindowText(provider, quotaWindow);
      const label = providerWindowLabel(provider, quotaWindow, 'Quota');
      const node = limitWindowNode(label, { ...quotaWindow, label }, color, 0.68, text.value, text.detail);
      tagUsageItem(node, usageItems.limitUsageItemId(quotaWindow), label);
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: { accountTitle: true, ...(grouped ? { showIcon: false } : {}) }
  });

  return { renderWindows, rowPolicy };
});
