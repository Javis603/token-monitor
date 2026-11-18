// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).kimi = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, limitWindowNode, providerWindowLabel, providerWindowText } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    const fiveHour = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    const monthly = windowForKind(provider, 'billing');
    if (fiveHour) {
      const node = limitWindowNode(providerWindowLabel(provider, fiveHour), fiveHour, color, 0.95);
      if (!weekly) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    if (weekly) {
      const node = limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68);
      if (!fiveHour) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    if (monthly) {
      const node = limitWindowNode(
        providerWindowLabel(provider, monthly),
        monthly,
        color,
        0.5,
        null,
        providerWindowText(provider, monthly).detail
      );
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  }

  return { renderWindows };
});
