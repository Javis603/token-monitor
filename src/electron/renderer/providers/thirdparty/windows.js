// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).thirdparty = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { optionalFiniteNumber, formatMoney, creditsMeterPercent, limitWindowNode, tagUsageItem, t, providerSpendEntries, limitNoteRowNode, presentationApi, namedApiAccountTitle } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    windows.classList.add('limit-windows-thirdparty');
    const balance = provider.balance || null;
    const currency = balance?.currency || 'USD';
    const balanceAmount = optionalFiniteNumber(balance?.amount);
    const quotaWindow = thirdPartyQuotaWindow(provider);
    const balanceLabel = quotaWindow?.label || 'Balance';
    if (balanceAmount !== null) {
      const balanceValue = formatMoney(balanceAmount, currency);
      // Balance presets without a fixed quota denominator (Sub2API reports the
      // remaining USD balance plus an observed monthSpend) get the same
      // display-layer meter DeepSeek uses: balance / (balance + month spend).
      // Windows that already carry provider percentages pass through unchanged.
      const meterPercent = creditsMeterPercent(provider, quotaWindow);
      const balanceNode = limitWindowNode(
        balanceLabel,
        {
          ...(quotaWindow || { showMeter: false }),
          label: balanceLabel,
          ...(meterPercent !== null ? { remainingPercent: meterPercent, showMeter: true } : {})
        },
        color,
        0.95,
        balanceValue
      );
      tagUsageItem(balanceNode, 'credits', balanceLabel);
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);
    } else if (quotaWindow?.showMeter === false && quotaWindow.detail) {
      const value = String(quotaWindow.detail).toLowerCase() === 'unlimited'
        ? t('settings.thirdparty.unlimited')
        : quotaWindow.detail;
      const balanceNode = limitWindowNode(
        balanceLabel,
        { ...quotaWindow, label: balanceLabel },
        color,
        0.95,
        value
      );
      tagUsageItem(balanceNode, 'credits', balanceLabel);
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);
    }
    const spendNode = thirdPartySpendNode(provider, quotaWindow);
    if (spendNode) windows.append(spendNode);
  }

  /** @param {any} provider @param {any} quotaWindow @returns {any} */ function thirdPartySpendNode(provider, quotaWindow) {
    const balance = provider?.balance || null;
    const usage = provider?.usageSummary || null;
    const currency = balance?.currency || 'USD';
    const entries = [];
    const total = optionalFiniteNumber(quotaWindow?.limit);
    const requestCount = optionalFiniteNumber(balance?.requestCount);
    const quotaGroup = String(balance?.quotaGroup || '').trim();
    if (total !== null) entries.push([t('settings.thirdparty.totalQuota'), formatMoney(total, currency)]);
    if (requestCount !== null) {
      entries.push([t('settings.thirdparty.requests'), Math.max(0, Math.trunc(requestCount)).toLocaleString()]);
    }
    if (quotaGroup) entries.push([t('settings.thirdparty.group'), quotaGroup]);
    const expiresAt = balance?.expiresAt ? new Date(balance.expiresAt) : null;
    if (expiresAt && !Number.isNaN(expiresAt.getTime())) {
      entries.push([t('settings.thirdparty.expires'), expiresAt.toLocaleDateString()]);
    }
    const usageCountEntry = /** @param {any} key @param {any} value @returns {any} */ (key, value) => {
      const number = optionalFiniteNumber(value);
      if (number !== null) entries.push([t(key), Math.max(0, Math.trunc(number)).toLocaleString()]);
    };
    if (usage) {
      usageCountEntry('settings.thirdparty.monthRequests', usage.requests);
      usageCountEntry('settings.thirdparty.monthTokens', usage.totalTokens);
      usageCountEntry('settings.thirdparty.inputTokens', usage.inputTokens);
      usageCountEntry('settings.thirdparty.outputTokens', usage.outputTokens);
      const cacheTokens = [usage.cacheReadTokens, usage.cacheCreationTokens]
        .map(optionalFiniteNumber)
        .filter(/** @param {any} value @returns {any} */ (value) => value !== null)
        .reduce(/** @param {any} sum @param {any} value @returns {any} */ (sum, value) => sum + value, 0);
      if (cacheTokens > 0) usageCountEntry('settings.thirdparty.cacheTokens', cacheTokens);
      const averageDurationMs = optionalFiniteNumber(usage.averageDurationMs);
      if (averageDurationMs !== null) {
        const duration = averageDurationMs < 1000
          ? `${Math.round(averageDurationMs)} ms`
          : `${(averageDurationMs / 1000).toFixed(averageDurationMs < 10000 ? 1 : 0)} s`;
        entries.push([t('settings.thirdparty.avgResponse'), duration]);
      }
      const standardCost = optionalFiniteNumber(usage.standardCost);
      if (standardCost !== null) entries.push([t('settings.thirdparty.standardCost'), formatMoney(standardCost, currency)]);
    }
    // Only New API account dashboards add period details. Other adapters keep
    // their existing Month/All time summary and account-only tooltip.
    const isNewApiAccount = provider?.adapterId === 'newapi-account';
    const spendValues = providerSpendEntries(balance)
      .filter(/** @param {any} entry @returns {any} */ ([label]) => isNewApiAccount || label === 'Month' || label === 'All time');
    const spendRows = spendValues.map(/** @param {any} entry @returns {any} */ ([label, value]) => [label, formatMoney(value, currency)]);
    if (spendRows.length === 0 && entries.length === 0) return null;
    // Without a spend figure the row has nothing to summarize, so it retitles
    // itself and leans entirely on the tooltip.
    const preferredSpend = isNewApiAccount
      ? spendValues.filter(/** @param {any} entry @returns {any} */ ([label]) => label === 'Today' || label === 'Month')
      : spendValues;
    const summaryValues = preferredSpend.length > 0 ? preferredSpend : spendValues.slice(0, 2);
    const summary = summaryValues
      .map(/** @param {any} entry @returns {any} */ ([label, value]) => `${label} ${formatMoney(value, currency)}`)
      .join(' · ');
    const periodDetails = isNewApiAccount && spendRows.length > summaryValues.length ? spendRows : [];
    const detailEntries = [
      ...entries,
      ...(entries.length > 0 && periodDetails.length > 0 ? [{ full: '', separated: true }] : []),
      ...periodDetails
    ];
    const node = limitNoteRowNode({
      label: summary ? 'Spend' : 'Details',
      summary,
      detailEntries: detailEntries.length > 0 ? detailEntries : null,
      ariaParts: [
        ...entries.map(/** @param {any} entry @returns {any} */ ([entryLabel, value]) => `${entryLabel} ${value}`),
        ...spendRows.map(/** @param {any} entry @returns {any} */ ([entryLabel, value]) => `${entryLabel} ${value}`)
      ]
    });
    return tagUsageItem(node, 'spend', summary ? 'Spend' : 'Details');
  }

  /** @param {any} provider @returns {any} */ function thirdPartyQuotaWindow(provider) {
    const windows = Array.isArray(provider?.windows) ? provider.windows : [];
    return windows.find(/** @param {any} window @returns {any} */ (window) => window?.metric === 'credits') || null;
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped, sharedFamily }) => {
    const visual = presentationApi.thirdPartyAdapterVisual(provider, color);
    // One mark per adapter, not one per group. With several adapters in the
    // group each row's mark is the only thing telling New API from Sub2API, so
    // the rows keep theirs and the header falls back to the generic mark; with
    // a single adapter there is nothing to tell apart and it moves up.
    const perRowMark = !(grouped && sharedFamily);
    return {
      color: visual.color,
      options: {
        planText: presentationApi.thirdPartyGroupPlanText(provider),
        ...(perRowMark ? { markId: visual.markId, showIcon: true } : { showIcon: false })
      }
    };
  };

  const groupPolicy = /** @param {any} providers @returns {any} */ (providers) => {
    const family = presentationApi.thirdPartySharedAdapterFamily(providers);
    return { markId: family || 'thirdparty', sharedFamily: family };
  };

  const accountTitle = /** @param {any} provider @param {any} index @returns {any} */ (provider, index) => provider?.accountDisplayName || namedApiAccountTitle(provider, index, 'thirdparty');

  return { renderWindows, thirdPartySpendNode, thirdPartyQuotaWindow, rowPolicy, groupPolicy, accountTitle };
});
