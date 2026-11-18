// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).qoder = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowsForKind, limitWindowNode, providerWindowText } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    windows.classList.add('limit-windows-qoder');
    for (const credits of windowsForKind(provider, 'billing')) {
      const node = limitWindowNode(
        credits?.label || 'Credits',
        credits,
        color,
        0.68,
        null,
        providerWindowText(provider, credits).detail
      );
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  }

  return { renderWindows };
});
