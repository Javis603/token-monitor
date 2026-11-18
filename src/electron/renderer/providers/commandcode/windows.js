// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).commandcode = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, limitWindowNode, providerWindowLabel, windowsForKind, providerWindowText } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // 5-hour and weekly are rate-limit windows (percent); the monthly grant and
    // any rollover top-up are money, so they get the amount on the right of the
    // reset line and span the row like Kimi's Monthly.
    const fiveHour = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
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
    for (const credits of windowsForKind(provider, 'billing')) {
      const node = limitWindowNode(
        providerWindowLabel(provider, credits),
        credits,
        color,
        0.5,
        null,
        providerWindowText(provider, credits).detail
      );
      node.classList.add('limit-window-wide');
      // A grant with no known plan allowance has no meter, so there is no bar
      // for a reset line to sit under either.
      if (credits.showMeter === false) node.classList.add('limit-window-no-reset');
      windows.append(node);
    }
  }

  return { renderWindows };
});
