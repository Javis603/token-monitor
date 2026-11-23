// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).kiro = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowsForKind, limitWindowNode, providerWindowText } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // Kiro exposes monthly credits (plus an optional bonus pool), both billing
    // windows. Render them full-width like Copilot's quota windows.
    windows.classList.add('limit-windows-kiro');
    const billingWindows = windowsForKind(provider, 'billing');
    for (const billing of billingWindows) {
      if (billing?.showMeter === false) {
        // Overage: a single compact line like Cursor's "Credits $0.00" (no bar,
        // no reset) with the credits used and estimated cost joined on the right.
        const node = limitWindowNode(billing.label || 'Overage', billing, color, 0.6, providerWindowText(provider, billing).value);
        node.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(node);
      } else {
        const node = limitWindowNode(
          billing?.label || 'Credits',
          billing,
          color,
          0.68,
          null,
          providerWindowText(provider, billing).detail
        );
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
    }
  }

  return { renderWindows };
});
