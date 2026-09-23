'use strict';

// What one quota window's headline value and sub-line say, shared by the Limits
// view and the edge dock.
//
// This is the second half of what those two surfaces used to decide separately.
// `limitWindowLabels.js` answers what a window is called; this answers what it
// reads. Both are display-layer: nothing here is written onto the wire, because
// the same window is worded differently by the surface that has room for a
// denominator and the one that does not.
//
// Layout is not here — it is in `limitWindowsView.js`, the row builder both
// surfaces call. This module answers only what a window reads, which is the
// question a Node-side caller (the tray, the macOS widget snapshot) can ask
// without a DOM.
//
// `value` is an override: `null` means "render the percentage the meter shows",
// which is the common case. `detail` is the absolute figure that sits under the
// bar beside the reset time, and is '' when the window has no second line.
(function exposeLimitWindowText(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(
    node ? require('./limitBalanceDisplay') : root?.TokenMonitorLimitBalanceDisplay
  );
  if (node) module.exports = api;
  if (root) root.TokenMonitorLimitWindowText = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLimitWindowTextApi(balanceDisplay) {
  const EMPTY = Object.freeze({ value: null, detail: '', percentLeads: false });

  function normalizedId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function money(value, currency) {
    return balanceDisplay.formatMoney(value, currency || 'USD');
  }

  // USD with two decimals, for the figures that are dollars regardless of what
  // currency the account is billed in (Kiro's estimated overage cost).
  function usd(value) {
    const number = finite(value);
    return number === null ? '' : `$${number.toFixed(2)}`;
  }

  // "124M / 305M" for a token pool. Token compaction is locale- and
  // unit-system-dependent, so the caller supplies the formatter rather than
  // this module reaching for renderer state.
  function counted(window, showUsed, formatCompact) {
    const remaining = finite(window?.remaining);
    const limit = finite(window?.limit);
    if (remaining === null || limit === null || limit <= 0) return '';
    const shown = showUsed ? Math.max(0, limit - remaining) : remaining;
    return `${formatCompact(shown)} / ${formatCompact(limit)}`;
  }

  // "120/500" — raw units, for a pool whose numbers are counts rather than
  // tokens or money (Kiro credits, Qoder credits, Zed edit predictions).
  function rawCount(window, showUsed) {
    const used = finite(window?.used);
    const limit = finite(window?.limit);
    if (used === null || limit === null || limit <= 0) return '';
    const trim = (n) => Number(Math.max(0, n).toFixed(2)).toString();
    return `${trim(showUsed ? used : limit - used)}/${trim(limit)}`;
  }

  // "$47.42 / $70.00" from a remaining-plus-limit pair, following the display
  // mode so the figure under the bar can never contradict the bar's direction.
  function moneyOfRemaining(window, showUsed) {
    const remaining = finite(window?.remaining);
    const limit = finite(window?.limit);
    if (remaining === null || limit === null || limit <= 0) return '';
    const shown = showUsed ? Math.max(0, limit - remaining) : remaining;
    return `${money(shown, window?.currency)} / ${money(limit, window?.currency)}`;
  }

  // The same pair read off `used` instead, for a meter that counts spend up.
  function moneyOfUsed(window, showUsed) {
    const used = finite(window?.used);
    const limit = finite(window?.limit);
    if (used === null || limit === null || limit <= 0) return '';
    const shown = showUsed ? used : Math.max(0, limit - used);
    return `${money(shown, window?.currency)} / ${money(limit, window?.currency)}`;
  }

  // A spend meter's headline is the money itself: "$12.40 / $20.00" against a
  // configured cap, "$12.40 spent" without one. The bare amount is ambiguous on
  // its own — Claude already said "spent" here and Cursor did not, which is the
  // kind of split this module exists to close.
  function spendValue(window) {
    const used = finite(window?.used);
    if (used === null) return '';
    const limit = finite(window?.limit);
    const usedText = money(used, window?.currency);
    return limit !== null && limit > 0 ? `${usedText} / ${money(limit, window?.currency)}` : `${usedText} spent`;
  }

  // "12.5 credits · $3.20" — units consumed, then their estimated cost. Either
  // half may be missing.
  function overageValue(window) {
    const parts = [];
    const credits = finite(window?.used);
    if (credits !== null) parts.push(`${Number(credits.toFixed(2))} credits`);
    const cost = finite(window?.remaining);
    if (cost !== null) parts.push(usd(cost));
    return parts.filter(Boolean).join(' · ');
  }

  // `percentLeads` is for a money window whose headline is nevertheless the
  // meter's percentage, because it has a real denominator and the amount is
  // the line underneath. Without it a surface that shows balances as money
  // (the dock card) would put the amount on top and disagree with the bar's
  // own label — which is exactly how Command Code's grant came to read
  // "$47.42" on one surface and "68% left" on the other.
  function result(value, detail, percentLeads = false) {
    return { value: value || null, detail: detail || '', percentLeads };
  }

  // options: { showLimitUsed, formatCompact }
  // `formatCompact` is only consulted for token pools; a caller with none gets
  // the percentage-only look those windows fall back to anyway.
  function limitWindowText(provider, window, options = {}) {
    if (!window || typeof window !== 'object') return EMPTY;
    const id = normalizedId(provider?.provider);
    const showUsed = options.showLimitUsed === true;
    const compact = typeof options.formatCompact === 'function' ? options.formatCompact : null;
    const metric = normalizedId(window.metric);
    const kind = normalizedId(window.kind);

    // A spend meter is money already consumed, whatever provider reports it.
    // Keyed on the wire marker rather than an id list, so a provider that grows
    // one does not need a line here.
    if (metric === 'spend') return result(spendValue(window), '');

    // Every rule below is scoped to the window kind its provider applies it to.
    // The scoping is not decoration: Command Code's 5-hour and weekly windows
    // are USD rate limits, so an unscoped money rule gave them a "$13.90 /
    // $14.00" line the Limits view never showed, and in a narrow card that
    // second figure pushed the reset time into an ellipsis.
    const billing = kind === 'billing';

    if (id === 'commandcode') {
      // The grant is money but the bar is a percentage, so the amount goes
      // under the bar rather than replacing the headline. A pool with no known
      // allowance has no denominator and so no second line.
      if (!billing) return EMPTY;
      return result(null, moneyOfRemaining(window, showUsed), window.showMeter !== false);
    }

    if (id === 'kiro') {
      if (!billing) return EMPTY;
      // Overage has no meter and no denominator: one compact line, no bar.
      if (window.showMeter === false) return result(overageValue(window), '');
      return result(null, rawCount(window, showUsed));
    }

    if (id === 'qoder') return billing ? result(null, rawCount(window, showUsed)) : EMPTY;

    if (id === 'zed') {
      if (!billing) return EMPTY;
      if (window.limitId === 'zed.edit-predictions') return result(null, rawCount(window, showUsed));
      return result(null, moneyOfUsed(window, showUsed));
    }

    if (id === 'zai' || id === 'zaiteam') {
      // Token pools only: the daily windows and the plan buckets, which are the
      // billing windows carrying a plan id. The rolling 5-hour and weekly
      // windows are percentages and stay bare, as does the MCP bucket.
      const pool = kind === 'daily' || (billing && Boolean(window.limitId));
      if (!pool) return EMPTY;
      return result(null, window.detail || (compact ? counted(window, showUsed, compact) : ''));
    }

    // Kimi's single shared membership meter ships its Kimi-vs-Code composition
    // as `detail` and is the only other provider that shows one.
    if (id === 'kimi') return billing ? result(null, window.detail || '') : EMPTY;

    // Everything else has no second line. `detail` is deliberately NOT surfaced
    // by default: several providers carry one for a different purpose — Zed and
    // third-party presets read "unlimited" out of it, OpenRouter promotes it to
    // the headline of a meterless window — so echoing it under every bar would
    // invent rows that were never there.
    return EMPTY;
  }

  return {
    limitWindowText,
    // Exported for the surfaces that still build a row by hand.
    overageValue,
    rawCount,
    spendValue
  };
});
