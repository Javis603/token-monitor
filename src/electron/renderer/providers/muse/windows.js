// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).muse = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { tagUsageItem, limitNoteRowNode, formatCompact, usageItems, renderGenericWindows, limitAccountDefaultTitle, presentationApi, provenanceContext, limitAccountTitle, subscriptionsForProviderGroup, t } = deps;

  /** @param {any} provider @param {any} creditsWindow @param {any} windows @returns {any} */ function appendCredits(provider, creditsWindow, windows) {
    // Muse supplies the token balance as display text; keep it ahead of the
    // monetary fallback without changing the underlying credits reading.
    if ( creditsWindow.resetDescription?.endsWith(' tokens left')) {
      const label = 'Additional tokens';
      const tokenText = creditsWindow.resetDescription.replace(/ tokens left$/u, '');
      const amount = /^(\d+(?:\.\d+)?)([KMB])?$/iu.exec(tokenText);
      // Convert the displayed abbreviation only for unit formatting; this
      // rounded website value never becomes a measured token count.
      const tokenCount = amount && Number(amount[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[amount[2]?.toUpperCase()] || 1);
      windows.append(tagUsageItem(limitNoteRowNode({
        label,
        summary: amount ? formatCompact(tokenCount) : tokenText,
        ariaParts: [creditsWindow.resetDescription]
      }), usageItems.limitUsageItemId(creditsWindow), label));
      return true;
    }

    return false;
  }

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) { renderGenericWindows(provider, color, windows, { appendCredits }); }

  /** @param {any} provider @param {any} index @param {any} providers @returns {any} */ function museSourceTitle(provider, index, providers = [provider]) {
    if (provider?.accountDisplayName) return provider.accountDisplayName;
    const title = provider?.source === 'cli' ? 'Muse Code' : provider?.source === 'web' ? 'Muse' : '';
    if (!title) return limitAccountDefaultTitle(provider, index, providers);
    if (providers.filter(/** @param {any} row @returns {any} */ (row) => row.source === provider.source).length < 2) return title;
    const device = presentationApi.limitProviderProvenance(provider, provenanceContext()).selectedDeviceLabel;
    return [title, device].filter(Boolean).join(' · ');
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: grouped ? { showIcon: false } : provider?.source ? { title: limitAccountTitle('muse', provider, 0) } : {}
  });

  const accountTitle = museSourceTitle;

  /** @param {any} providers @returns {any} */ function groupPlanText(providers) { return subscriptionsForProviderGroup('muse', providers).length ? t('settings.subscriptions.title') : ''; }

  return { renderWindows, museSourceTitle, rowPolicy, accountTitle, hideGroupCount: true, groupPlanText };
});
