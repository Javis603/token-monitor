// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).typesafe = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { currentLocale, compactTokenThreshold, formatCompact, t, optionalFiniteNumber, tagUsageItem, limitNoteRowNode } = deps;

  /** @param {any} balance @param {any} provider @returns {any} */ function spendNode(balance, provider) {
    const usage = provider.usageSummary;
    if (usage?.period !== 'month' || usage.totalTokens === null) return null;
    const count = /** @param {any} value @returns {any} */ (value) => Number(value).toLocaleString(currentLocale());
    // Summary numbers compact at the same threshold every other token
    // surface uses — 1K western, 1萬 localized — and honor the compact-units
    // setting. The tooltip keeps exact counts.
    const threshold = compactTokenThreshold();
    const brief = /** @param {any} value @returns {any} */ (value) => (Number.isFinite(value) && Math.abs(value) >= threshold
      ? formatCompact(value)
      : count(value));
    const details = [];
    if (Number.isFinite(usage.todayTokens)) details.push([t('settings.typesafe.today'), count(usage.todayTokens)]);
    if (Number.isFinite(usage.weekTokens)) details.push([t('settings.typesafe.lastSevenDays'), count(usage.weekTokens)]);
    details.push({ full: t('settings.typesafe.month'), caption: true, separated: details.length > 0 });
    details.push([t('settings.typesafe.tokens'), count(usage.totalTokens)]);
    if (usage.inputTokens !== null) details.push([t('settings.thirdparty.inputTokens'), count(usage.inputTokens)]);
    if (usage.outputTokens !== null) details.push([t('settings.thirdparty.outputTokens'), count(usage.outputTokens)]);
    if (usage.requests !== null) details.push([t('settings.thirdparty.requests'), count(usage.requests)]);
    const cost = optionalFiniteNumber(usage.standardCost);
    if (cost !== null) details.push([t('settings.typesafe.estimatedSpend'), cost > 0 && cost < 0.00005 ? '<$0.0001' : `$${cost.toFixed(4)}`]);
    const summaryParts = [
      Number.isFinite(usage.todayTokens) ? `Today ${brief(usage.todayTokens)}` : '',
      `Month ${brief(usage.totalTokens)}`
    ].filter(Boolean);
    return tagUsageItem(limitNoteRowNode({
      // Row labels on this page are fixed English ('Balance', 'Spend',
      // 'Reset'); the token row mirrors the Spend row's Today · Month shape.
      // Only the tooltip stays localized, matching the third-party rows.
      label: 'Tokens',
      summary: summaryParts.join(' · '),
      detailEntries: details,
      ariaParts: details.filter(Array.isArray).map(/** @param {any} entry @returns {any} */ ([label, value]) => `${label} ${value}`)
    }), 'spend', 'Tokens');
  }
  const renderWindows = deps.reuseRenderWindows;

  return { spendNode, renderWindows };
});
