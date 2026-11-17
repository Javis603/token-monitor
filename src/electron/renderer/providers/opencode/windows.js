// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).opencode = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, isCreditsWindow, limitWindowNode, providerWindowLabel, creditsAmount, optionalFiniteNumber, formatLimitAmount, tagUsageItem } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // Go reports session/weekly/monthly windows ($12/$30/$60); Zen reports a prepaid balance (and,
    // when the account is active, rolling/weekly). The monthly window normalizes to kind 'billing'
    // (see normalizeWindowKind). Show only the windows that exist — no empty `--` placeholders — and
    // surface the Zen balance as a full-width, no-meter note when present.
    const session = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    // The Zen balance is a billing-kind `credits` window, so it has to come out
    // of the list before the Go grant is looked up by kind: on a Zen-only
    // account it is the only billing window there is, and metering money as a
    // monthly quota is exactly the mistake the `credits` marker exists to stop.
    const balanceWindow = (provider.windows || []).find(/** @param {any} window @returns {any} */ (window) => isCreditsWindow(window)) || null;
    const monthly = (provider.windows || [])
      .find(/** @param {any} window @returns {any} */ (window) => window.kind === 'billing' && window !== balanceWindow) || null;
    if (session) windows.append(limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95));
    if (weekly) windows.append(limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68));
    // Monthly spans the full row (like Balance) so it never leaves a half-empty grid cell.
    if (monthly) {
      const node = limitWindowNode(providerWindowLabel(provider, monthly), monthly, color, 0.5);
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
    // Balance is a Zen-only concept. Show it only when a real balance number came
    // back (incl. $0.00). It can't key off `source === 'web'` anymore — Go usage is
    // now fetched over the web too, so a pure-Go account (no Zen, balanceUsd null)
    // must not get a phantom `Balance —` line. The window is preferred over the
    // provider-level `balanceUsd`, which stays readable so a record synced from a
    // device on an older build still shows its balance.
    const balanceAmount = balanceWindow
      ? creditsAmount(provider, balanceWindow)
      : optionalFiniteNumber(provider.balanceUsd);
    if (balanceAmount !== null) {
      const node = limitWindowNode(
        providerWindowLabel(provider, balanceWindow, 'Balance'),
        { showMeter: false },
        color,
        0.68,
        formatLimitAmount(balanceAmount)
      );
      tagUsageItem(node, 'credits', providerWindowLabel(provider, balanceWindow, 'Balance'));
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  }

  /** @param {any} provider @returns {any} */ function legacyOpencodeProfileLabel(provider) {
    const label = String(provider?.accountLabel || '').trim();
    return !String(provider?.accountName || '').trim()
      && Boolean(label)
      && label !== 'Go'
      && label !== 'Zen';
  }

  /** @param {any} provider @param {any} index @returns {any} */ function opencodeAccountTitle(provider, index) {
    const name = String(provider?.accountDisplayName || provider?.accountName || '').trim();
    // The collector's canonical name is shown as-is. This column holds account
    // names, which are user strings and almost never translated, so a localized
    // phrase reads as a stray UI label among them — and the plan and source
    // columns beside it are English for the same reason.
    if (name) return name;
    // Older synced clients put the user-defined profile name in accountLabel.
    // Keep those rows identifiable while new clients carry profile and plan in
    // separate fields. Go/Zen are plan labels, never account identities.
    const legacyName = String(provider?.accountLabel || '').trim();
    return legacyName && legacyName !== 'Go' && legacyName !== 'Zen'
      ? legacyName
      : `Account ${index + 1}`;
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: {
      // A profile name that is neither Go nor Zen predates accountName, and it
      // is repeated by the legacy plan fallback. Hide that duplicate only
      // for healthy/stale rows with no explicit plan. Recovery status and
      // known Go/Zen plans must survive.
      ...(grouped && (provider?.status === 'ok' || provider?.stale) && !String(provider?.planLabel || '').trim() && legacyOpencodeProfileLabel(provider) ? { planText: '' } : {}),
      ...(grouped ? { showIcon: false } : {})
    }
  });

  const accountTitle = opencodeAccountTitle;

  return { renderWindows, legacyOpencodeProfileLabel, opencodeAccountTitle, rowPolicy, accountTitle };
});
