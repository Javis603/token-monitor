// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).grok = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, limitWindowNode, providerWindowLabel } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // Grok exposes a single Monthly billing window (no session/weekly). Render it
    // full-width so it doesn't share a row with an empty placeholder. This mirrors
    // how Cursor's billing cycle and OpenCode's Monthly are handled.
    windows.classList.add('limit-windows-grok');
    const monthly = windowForKind(provider, 'billing');
    if (monthly) {
      const node = limitWindowNode(providerWindowLabel(provider, monthly), monthly, color, 0.68);
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  }

  return { renderWindows };
});
