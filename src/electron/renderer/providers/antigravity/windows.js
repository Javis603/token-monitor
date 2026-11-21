// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).antigravity = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { document, tagUsageItem, limitWindowNode, usageItems, windowsForKind, presentationApi, providerWindowLabel } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    windows.classList.add('limit-windows-antigravity');
    const quotaGroups = antigravityQuotaGroups(provider);
    if (quotaGroups.length > 0) {
      windows.classList.add('limit-windows-antigravity-grouped');
      for (const group of quotaGroups) {
        const groupNode = document.createElement('div');
        groupNode.className = 'limit-window-group';
        groupNode.setAttribute('role', 'group');
        groupNode.setAttribute('aria-label', group.label);
        const title = document.createElement('div');
        title.className = 'limit-window-group-title';
        title.textContent = group.label;
        const groupWindows = document.createElement('div');
        groupWindows.className = 'limit-window-group-items';
        for (const entry of group.windows) {
          const opacity = entry.window.kind === 'session' ? 0.95 : 0.78;
          groupWindows.append(tagUsageItem(
            limitWindowNode(entry.windowLabel, { ...entry.window, label: entry.windowLabel }, color, opacity),
            usageItems.limitUsageItemId(entry.window),
            `${group.label} · ${entry.windowLabel}`
          ));
        }
        groupNode.append(title, groupWindows);
        windows.append(groupNode);
      }
    } else {
      const weeklyWindows = windowsForKind(provider, 'weekly');
      const visibleWindows = weeklyWindows.length > 0
        ? weeklyWindows.filter(presentationApi.antigravityQuotaWindowVisible)
        : [null];
      for (const quotaWindow of visibleWindows) {
        const node = limitWindowNode(providerWindowLabel(provider, quotaWindow, 'Weekly'), quotaWindow, color, 0.78);
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
    }
  }

  /** @param {any} provider @returns {any} */ function antigravityQuotaGroups(provider) {
    const entries = (provider?.windows || [])
      .filter(/** @param {any} window @returns {any} */ (window) => window.kind === 'session' || window.kind === 'weekly')
      .map(/** @param {any} window @returns {any} */ (window) => {
        const presentation = presentationApi.antigravityQuotaWindow(window);
        return presentation ? { ...presentation, window } : null;
      });
    // Legacy GetUserStatus pools have model names rather than group + period
    // labels. Keep their existing flat layout instead of guessing a hierarchy.
    if (entries.length === 0 || entries.some(/** @param {any} entry @returns {any} */ (entry) => entry === null)) return [];
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.groupLabel)) groups.set(entry.groupLabel, []);
      groups.get(entry.groupLabel).push(entry);
    }
    // Keep the original quota pairs in place even when normalization places
    // Argon beside the other Gemini windows. This order belongs to the view.
    const groupOrder = ['Gemini', 'Claude/GPT', 'Gemini 4 Argon'];
    const rank = /** @param {any} options0 @returns {any} */ ({ label }) => {
      const index = groupOrder.indexOf(label);
      return index < 0 ? groupOrder.length : index;
    };
    return [...groups].map(/** @param {any} entry @returns {any} */ ([label, windows]) => ({ label, windows }))
      .sort(/** @param {any} a @param {any} b @returns {any} */ (a, b) => rank(a) - rank(b));
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: grouped ? { showIcon: false } : {}
  });

  return { renderWindows, antigravityQuotaGroups, rowPolicy };
});
