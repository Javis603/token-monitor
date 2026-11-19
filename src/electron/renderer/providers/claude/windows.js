// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).claude = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, limitWindowNode, providerWindowLabel, windowsForKind, spendWindow, providerWindowText, tagUsageItem, formatDuration, expiryDateLabel, resetCreditsNode, optionalFiniteNumber, formatMoney, settings, limitNoteRowNode } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // Claude usually shows session + one all-models weekly, but can carry a second
    // model-scoped weekly (the temporary "Fable only" promo cap). Render every
    // weekly the response actually has, and nothing when a bucket is absent — no
    // empty placeholder — so the scoped bar appears only while the promo is live.
    const session = windowForKind(provider, 'session');
    if (session) windows.append(limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95));
    for (const weekly of windowsForKind(provider, 'weekly')) {
      const node = limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68);
      // The all-models weekly pairs with Session in the two-column grid; a
      // model-scoped weekly (the "Fable only" promo cap) has no partner, so span
      // the full row instead of leaving a half-empty cell.
      if (weekly.label) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    // Usage credits: "$2.35 / $20.00" with a meter when a monthly spend limit is
    // set, "$2.35 spent" without one. Absent entirely when credits are off.
    const usageCredits = spendWindow(provider);
    if (usageCredits) {
      // Older hubs send this window without a metric; it is the spend row either way.
      const node = limitWindowNode(
        'Usage credits',
        usageCredits,
        color,
        0.5,
        providerWindowText(provider, usageCredits).value
      );
      tagUsageItem(node, 'spend', 'Usage credits');
      node.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(node);
    }
    const balanceNode = claudeBalanceNode(provider);
    if (balanceNode) windows.append(balanceNode);
    // Usage-limit reset grants (Anthropic's "reset coupon") share Codex's
    // compact line; the ⓘ tooltip carries each grant's label and coverage.
    const resetNode = claudeResetCreditsNode(provider.resetCredits);
    if (resetNode) windows.append(resetNode);
  }

  /** @param {any} key @returns {any} */ function claudeResetClearLabel(key) {
    switch (key) {
    case 'five_hour': return 'Session';
    case 'seven_day': return 'Weekly';
      // The CLI's own label map calls this 'Fable limit' — the
      // credits-backed model's weekly bucket, not a modifier on seven_day.
    case 'seven_day_overage_included': return 'Fable weekly';
    case 'seven_day_opus': return 'Opus weekly';
    case 'seven_day_sonnet': return 'Sonnet weekly';
    case 'seven_day_oauth_apps': return 'OAuth apps weekly';
    case 'seven_day_cowork': return 'Cowork weekly';
    case 'seven_day_omelette': return 'Omelette weekly';
    default: return String(key || '').replace(/_/g, ' ').trim();
    }
  }

  /** @param {any} grants @returns {any} */ function claudeResetGrantRows(grants) {
    /** @type {any[]} */ const rows = [];
    grants.forEach(/** @param {any} grant @param {any} index @returns {any} */ (grant, index) => {
      const endsAt = grant?.endsAt ? new Date(grant.endsAt) : null;
      const hasDate = endsAt && !Number.isNaN(endsAt.getTime());
      const remaining = grant?.paused === true
        ? 'Paused'
        : (hasDate
          ? (endsAt.getTime() - Date.now() <= 0 ? 'Expired' : formatDuration(endsAt.getTime() - Date.now()))
          : '');
      if (grant?.label) rows.push({ full: grant.label, caption: true, separated: index > 0 });
      rows.push(['Expires', hasDate
        ? [expiryDateLabel(endsAt), remaining].filter(Boolean).join(' · ')
        : remaining || 'No expiry']);
      const clearKeys = Array.isArray(grant?.clears) ? grant.clears : [];
      const clears = clearKeys
        // `seven_day_overage_included` is the Fable model's weekly bucket — a
        // distinct limit, but noise next to the general weekly clear that
        // most accounts never see. List it only when it is the only weekly.
        .filter(/** @param {any} key @returns {any} */ (key) => key !== 'seven_day_overage_included' || !clearKeys.includes('seven_day'))
        .map(claudeResetClearLabel)
        .filter(Boolean);
      const clearsText = clears.join(' · ');
      if (clearsText) rows.push(['Clears', clearsText]);
      if (grant?.useRequiresLimit === true) rows.push(['Usable', 'at a limit only']);
      else if (grant?.usableNow === false) rows.push(['Usable', 'not right now']);
    });
    return rows;
  }

  /** @param {any} resetCredits @returns {any} */ function claudeResetCreditsNode(resetCredits) {
    const grants = Array.isArray(resetCredits?.grants) ? resetCredits.grants : [];
    if (grants.length === 0) return resetCreditsNode(resetCredits);
    const ariaLabel = grants.map(/** @param {any} grant @param {any} index @returns {any} */ (grant, index) => {
      const left = Number(grant?.resetsLeft);
      const count = Number.isFinite(left) ? `${Math.max(0, Math.floor(left))} left` : '';
      // Speak the same rows the tooltip shows — expiry, cleared windows,
      // usability — so a restriction like 'not right now' is not silent.
      const details = claudeResetGrantRows([grant])
        .map(/** @param {any} row @returns {any} */ (row) => (Array.isArray(row) ? `${row[0]}: ${row[1]}` : row.full))
        .filter(Boolean)
        .join(', ');
      return [`Reset ${index + 1}`, count, details]
        .filter(Boolean)
        .join(', ');
    }).join('; ');
    return resetCreditsNode(resetCredits, { entries: claudeResetGrantRows(grants), ariaLabel });
  }

  /** @param {any} tranches @param {any} currency @returns {any} */ function claudePrepaidGrantRows(tranches, currency) {
    return tranches
      .filter(/** @param {any} tranche @returns {any} */ (tranche) => optionalFiniteNumber(tranche?.amount) !== null)
      .map(/** @param {any} tranche @returns {any} */ (tranche) => {
        const money = formatMoney(tranche.amount, tranche.currency || currency);
        const expiresAt = tranche.expiresAt ? new Date(tranche.expiresAt) : null;
        if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
          return { cells: [money, '', 'No expiry'], aria: `${money} no expiry` };
        }
        const diffMs = expiresAt.getTime() - Date.now();
        const remaining = diffMs <= 0 ? 'Expired' : formatDuration(diffMs);
        return {
          cells: [money, expiryDateLabel(expiresAt), remaining],
          aria: diffMs <= 0 ? `${money} expired` : `${money} expires in ${remaining}`
        };
      });
  }

  /** @param {any} provider @returns {any} */ function claudeBalanceNode(provider) {
    // Also checked here, not just in the collector: a record collected before the
    // setting was switched off is still in state, and the row should disappear on
    // the toggle rather than on the next refresh.
    if (settings()?.claudePrepaidBalanceEnabled === false) return null;
    const balance = provider?.balance || null;
    const amount = optionalFiniteNumber(balance?.amount);
    if (amount === null) return null;
    const currency = balance?.currency || 'USD';
    const tranches = Array.isArray(balance.tranches) ? balance.tranches : [];
    const grants = claudePrepaidGrantRows(tranches, currency);
    return tagUsageItem(limitNoteRowNode({
      label: 'Balance',
      summary: formatMoney(amount, currency),
      detailEntries: grants.map(/** @param {any} grant @returns {any} */ (grant) => grant.cells),
      ariaParts: [formatMoney(amount, currency), ...grants.map(/** @param {any} grant @returns {any} */ (grant) => grant.aria)]
    }), 'credits', 'Balance');
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: { accountTitle: true, ...(grouped ? { showIcon: false } : {}) }
  });

  return { renderWindows, claudeResetClearLabel, claudeResetGrantRows, claudeResetCreditsNode, claudePrepaidGrantRows, claudeBalanceNode, rowPolicy };
});
