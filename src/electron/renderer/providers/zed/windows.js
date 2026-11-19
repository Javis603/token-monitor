// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).zed = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowsForKind, limitWindowNode, providerWindowText } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    windows.classList.add('limit-windows-zed');
    for (const billing of windowsForKind(provider, 'billing')) {
      const unlimitedEditPredictions = billing?.limitId === 'zed.edit-predictions'
          && String(billing?.detail || '').trim().toLowerCase() === 'unlimited';
      const node = limitWindowNode(
        billing?.label || 'Token Spend',
        billing,
        color,
        0.95,
        null,
        providerWindowText(provider, billing).detail
      );
      node.classList.add('limit-window-wide');
      if (unlimitedEditPredictions) node.classList.add('limit-window-no-reset');
      windows.append(node);
    }
  }

  return { renderWindows };
});
