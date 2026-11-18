// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).notion = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { limitWindowNode, providerWindowLabel } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // Both included allowances are percentage quotas. Monthly is a billing
    // window, which the default session/weekly branch would omit.
    const quotaNodes = (provider.windows || [])
      .filter(/** @param {any} window @returns {any} */ (window) => window.kind === 'session' || window.kind === 'billing')
      .map(/** @param {any} window @returns {any} */ (window) => limitWindowNode(
        providerWindowLabel(provider, window), window, color,
        window.kind === 'session' ? 0.95 : 0.68
      ));
    if (quotaNodes.length === 1) quotaNodes[0].classList.add('limit-window-wide');
    windows.append(...quotaNodes);
  }

  return { renderWindows };
});
