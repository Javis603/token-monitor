'use strict';

// The Limits view's provider rows, as a builder both windowed surfaces call.
//
// The Limits page and the edge dock card show the same thing — the same
// windows, the same meters, the same spend and balance rows, the same info
// tooltips — and they used to build all of it twice. That is how the card came
// to show a balance with no spend line under it, and a money pool with no
// denominator: not a different design, just a second implementation that had
// been told less.
//
// So the DOM itself is shared, not only the wording. Each surface supplies its
// own renderer state through `deps` and styles the result with its own CSS;
// nothing in here reads a global.
//
// deps:
//   t, currentLocale                   i18n
//   settings()                         the live settings object
//   presentation, motion               renderer modules, injected so this file
//                                      does not care which page loaded them
//   provenanceContext()                what naming a reading's device needs:
//                                      this host's own device id, whether it is
//                                      syncing, and its device list. Read at
//                                      paint time, because a row repaints while
//                                      the stats behind it change
//   balance                            limitBalanceDisplay
//   windowLabels, windowText           the shared wording modules
//   subscriptionApi, subscriptionText  the recorded subscriptions and how they
//                                      read, for the plan cell's hover card
//   format*, limitFillPercent, …       the page's own number formatting
//   tooltip                            { hasOpened(), markOpened(), release() },
//                                      the host's tooltip entrance bookkeeping
//
// The one exception to "everything arrives through deps" is the provider
// catalog: which client a provider's tokens are recorded under is the same
// answer on every host, so it is imported rather than passed. A dep would only
// give three hosts three chances to supply a different one.
(function exposeLimitWindowsView(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(
    node ? require('../../../shared/limits/providers') : root?.TokenMonitorLimitProviders,
    node ? require('../../../shared/limits/usageItems') : root?.TokenMonitorLimitUsageItems,
    node ? require('../../../shared/limits/accountScope') : root?.TokenMonitorLimitAccountScope,
    node ? require('../pressActivation') : root?.TokenMonitorPressActivation,
    node ? require('../domReconcile') : root?.TokenMonitorDomReconcile,
    node ? require('./windowOwners') : root?.TokenMonitorLimitWindowOwners
  );
  if (node) module.exports = api;
  if (root) root.TokenMonitorLimitWindowsView = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLimitWindowsViewApi(limitProviders, usageItems, accountScope, pressActivation, domApi, ownerRegistry) {
  function createLimitWindowsView(deps) {
    const {
      t,
      settings,
      currentLocale,
      presentation: presentationApi,
      // The row shows which device a reading came from, and only the host knows
      // what that device is called. No default: a host that supplied nothing
      // would not fail, it would render every row as if it were this device's —
      // the same silent-less drift the subscription block below exists to stop,
      // and the dock card had exactly that gap while this had a default.
      provenanceContext,
      motion,
      tooltip: tooltipHost,
      formatCompact,
      compactTokenThreshold,
      formatMoney,
      formatCompactMoney,
      formatPercent,
      formatDuration,
      formatLimitBoundary,
      limitFillPercent,
      limitModeSuffix,
      optionalFiniteNumber,
      colorWithAlpha,
      applyBarScale,
      creditsAmount,
      creditsCurrency,
      creditsMeterPercent,
      isCreditsWindow,
      spendWindow,
      limitWindowLabel,
      limitWindowText,
      mimoAccountGroups,
      mimoProductLabel,
      accountIdentity,
      accountControl,
      codexAccounts,
      hasMark,
      formatAgo,
      openExternal,
      // Subscriptions — everything the plan cell's hover card is built from.
      // None of these has a default: a host that supplied nothing would not fail
      // loudly, it would render a plan label with no card under it, which is
      // exactly the drift this list exists to prevent (the dock showed a bare
      // plan label while the page showed the card for as long as the decoration
      // was a hook only the widget passed).
      subscriptionApi,
      subscriptionText,
      currencyApi,
      formatCost,
      subscriptions,
      subscriptionAccounts,
      monthClientCosts,
      // `{ enabled, busy, forecast }` — the Codex reset forecast as this host
      // currently holds it, read at paint time because the widget refreshes it
      // on its own timer.
      resetForecast = () => ({ busy: false, forecast: null }),
      // `{ available(provider), probes(), refresh(provider) }` — a host that can
      // refresh limits puts a button on each row's "Updated" line. `probes()` is
      // the limits runtime's probes in flight, so a refresh the user did not
      // start spins the row too. A surface without one draws no button.
      accountRefresh = null
    } = deps;
    const document = deps.document || globalThis.document;
    const windowOwners = ownerRegistry.createOwners({
      accountIdentity,
      codexAccounts,
      compactTokenThreshold,
      creditsAmount,
      creditsBalanceValue,
      creditsCurrency,
      creditsMeterPercent,
      currentLocale,
      document,
      expiryDateLabel,
      formatAgo,
      formatBalanceSpendAmount,
      formatCompact,
      formatDuration,
      formatLimitAmount,
      formatMoney,
      isCreditsWindow,
      limitAccountDefaultTitle,
      limitAccountEmailsMasked,
      limitAccountRowPolicy,
      limitAccountTitle,
      limitDetailInfoNode,
      limitNoteRowNode,
      limitProviderUsageItems,
      limitWindowNode,
      mimoAccountGroups,
      mimoProductLabel,
      namedApiAccountTitle,
      openExternal,
      optionalFiniteNumber,
      presentationApi,
      provenanceContext,
      providerSpendEntries,
      providerSpendNode,
      providerWindowLabel,
      providerWindowText,
      renderGenericWindows,
      renderLimitProviderGroupFrame,
      renderLimitProviderHead,
      renderLimitProviderRow,
      renderProviderWindows,
      repairWindowPairs,
      resetCreditsNode,
      resetForecast,
      settings,
      spendWindow,
      subscriptionAccounts,
      subscriptionForProvider,
      subscriptionsForProviderGroup,
      t,
      tagUsageItem,
      usageItems,
      windowForKind,
      windowsForKind
    });

  function windowForKind(provider, kind) {
    return (provider?.windows || []).find((window) => window.kind === kind) || null;
  }

  function windowsForKind(provider, kind) {
    return (provider?.windows || []).filter((window) => window.kind === kind);
  }

  function formatLimitAmount(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return `$${number.toFixed(2)}`;
  }

  function formatBalanceAmount(value, source) {
    return formatMoney(value, source?.currency);
  }

  function formatBalanceSpendAmount(value, balance) {
    return formatBalanceAmount(value, balance);
  }

  // Absolute count for windows that expose units (credits). It follows the same
  // display mode as percent bars: remaining/total in quota mode, used/total in
  // used mode.
  function formatResetCreditsValue(resetCredits) {
    const available = Number(resetCredits?.availableCount);
    if (!Number.isFinite(available)) return '';
    const count = Math.max(0, Math.floor(available));
    if (count <= 0) return '';
    return `${count} reset${count === 1 ? '' : 's'}`;
  }

  function resetCreditExpirationDates(resetCredits) {
    const values = Array.isArray(resetCredits?.expirations) ? resetCredits.expirations : [];
    const dates = values
      .map((value) => new Date(value))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    if (dates.length > 0) return dates;
    const fallback = resetCredits?.nextExpiresAt ? new Date(resetCredits.nextExpiresAt) : null;
    return fallback && !Number.isNaN(fallback.getTime()) ? [fallback] : [];
  }

  function resetCreditExpiryLabel(date) {
    const diffMs = date.getTime() - Date.now();
    return diffMs <= 0 ? 'now' : formatDuration(diffMs);
  }

  function resetCreditExpiryDetailLabel(date) {
    const diffMs = date.getTime() - Date.now();
    return diffMs <= 0 ? 'Expires now' : `Expires in ${formatDuration(diffMs)}`;
  }

  // Shared by Codex reset credits and Claude prepaid grants.
  function expiryDateLabel(date) {
    return new Intl.DateTimeFormat(currentLocale(), {
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
  }

  // Marks `node` as the row of usage item `id` (see shared/limits/usageItems),
  // which is what lets the user hide it and what the settings checklist lists.
  // `label` is the row's name there. An empty id leaves the row untagged —
  // always drawn, never listed.
  function tagUsageItem(node, id, label = '') {
    if (!node) return node;
    if (id) {
      node.dataset.usageItem = id;
      node.dataset.usageItemLabel = label;
    } else {
      delete node.dataset.usageItem;
      delete node.dataset.usageItemLabel;
    }
    return node;
  }

  // `detail` optionally replaces the ⓘ tooltip's contents: Claude's reset
  // grants carry a label, the windows they clear, and a usability state, which
  // is more than the bare expiry dates Codex has to work with.
  function resetCreditsNode(resetCredits, detail = null) {
    const valueText = formatResetCreditsValue(resetCredits);
    if (!valueText) return null;
    const expirationDates = resetCreditExpirationDates(resetCredits);
    const detailEntries = Array.isArray(detail?.entries) && detail.entries.length > 0
      ? detail.entries
      : null;
    const item = document.createElement('div');
    item.className = 'limit-window limit-window-wide limit-window-note limit-reset-credits';
    // The line has no name of its own; the checklist calls it `Resets`.
    tagUsageItem(item, 'resets', 'Resets');
    const line = document.createElement('div');
    line.className = 'limit-reset-credits-line';
    const value = document.createElement('span');
    value.className = 'limit-reset-credits-value';
    value.textContent = valueText;
    line.append(value);
    if (expirationDates.length > 0 || detailEntries) {
      const expiryGroup = document.createElement('span');
      expiryGroup.className = 'limit-reset-credits-expiry-group';
      if (expirationDates.length > 0) {
        const timeline = document.createElement('span');
        timeline.className = 'limit-reset-credits-timeline';
        const summaryParts = expirationDates.slice(0, 3).map(resetCreditExpiryLabel);
        const hiddenExpirationCount = expirationDates.length - summaryParts.length;
        if (hiddenExpirationCount > 0) summaryParts.push(`+${hiddenExpirationCount}`);
        summaryParts.forEach((text, index) => {
          const time = document.createElement('span');
          time.className = 'limit-reset-credits-time';
          if (index > 0) {
            const separator = document.createElement('span');
            separator.className = 'limit-reset-credits-separator';
            separator.textContent = '·';
            separator.setAttribute('aria-hidden', 'true');
            time.append(separator);
          }
          time.append(document.createTextNode(text));
          timeline.append(time);
        });
        expiryGroup.append(timeline);
      }
      // A date paired with a bare duration doesn't read as `<name>: <value>`, so
      // the spoken label is supplied rather than derived from the cells. Keep
      // this detail available for a single reset as well as multiple resets.
      const infoNode = detailEntries
        ? limitDetailInfoNode(detailEntries, '', detail?.ariaLabel || '')
        : limitDetailInfoNode(
          expirationDates.map((date) => [expiryDateLabel(date), resetCreditExpiryLabel(date)]),
          '',
          expirationDates.map((date, index) => `Reset ${index + 1}: ${resetCreditExpiryDetailLabel(date)}`).join(', ')
        );
      if (infoNode) expiryGroup.append(infoNode);
      line.append(expiryGroup);
    }
    item.append(line);
    item.setAttribute('aria-label', ['Reset credits', valueText, expirationDates.map(resetCreditExpiryDetailLabel).join(', ')].filter(Boolean).join(', '));
    return item;
  }

  function providerSpendEntries(balance) {
    return [
      ['Today', optionalFiniteNumber(balance?.todaySpend)],
      ['Week', optionalFiniteNumber(balance?.weekSpend)],
      ['Month', optionalFiniteNumber(balance?.monthSpend)],
      ['All time', optionalFiniteNumber(balance?.allTimeSpend)]
    ].filter(([, value]) => value !== null);
  }

  // The meter-less note row every balance/spend provider draws: a label on the
  // left, then an optional summary and an optional ⓘ tooltip on the right. The
  // wording stays with the callers — each provider says something different about
  // the same layout — so the spoken label is `label` plus whatever parts they pass.
  function limitNoteRowNode({ label, summary = '', detailEntries = null, ariaParts = [] }) {
    const item = document.createElement('div');
    item.className = 'limit-window limit-window-wide limit-window-note limit-spend';
    const line = document.createElement('div');
    line.className = 'limit-window-text limit-spend-line';
    const labelNode = document.createElement('span');
    labelNode.textContent = label;
    const right = document.createElement('span');
    right.className = 'limit-spend-right';
    if (summary) {
      const summaryNode = document.createElement('span');
      summaryNode.className = 'limit-spend-summary';
      summaryNode.textContent = summary;
      right.append(summaryNode);
    }
    const infoNode = detailEntries ? limitDetailInfoNode(detailEntries, 'limit-spend-info-wrap') : null;
    if (infoNode) right.append(infoNode);
    line.append(labelNode, right);
    item.append(line);
    item.setAttribute('aria-label', [label, ...ariaParts].join(', '));
    return item;
  }

  // Tooltips paint in the top layer, as popovers. Both surfaces that draw these
  // rows scroll inside a clipping box — the limits panel and the dock card's
  // account list — and an absolutely positioned tooltip was cut off by it, or
  // covered by the header above it. A popover escapes every ancestor's overflow
  // and stacking context at once, so this is the one place that has to know.
  //
  // What the top layer does NOT escape is the window, and a 280px dock card
  // often has nothing above its first row, so the flip below is still measured —
  // against the viewport now rather than against a clip box, which is why both
  // surfaces can share one measurement.
  let tooltipAnchorSeq = 0;

  function positionCenteredDetailTooltip(tooltip) {
    if (!tooltip.classList.contains('is-centered') || !tooltip.matches(':popover-open')) return;
    tooltip.style.setProperty('--tooltip-shift', '0px');
    const rect = tooltip.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const shift = rect.left < 8 ? 8 - rect.left
      : rect.right > viewportWidth - 8 ? viewportWidth - 8 - rect.right : 0;
    tooltip.style.setProperty('--tooltip-shift', `${shift}px`);
  }

  function attachLimitDetailTooltip(wrap, tooltip) {
    wrap.setAttribute('data-dom-kind', 'detail-tooltip');
    // A popover has no positioned ancestor to lay out against, so it is anchored
    // to its own trigger. Anchor names are per-element and the panel draws many
    // of these, so each pair gets its own rather than a name declared in CSS.
    const anchorName = `--limit-detail-anchor-${tooltipAnchorSeq += 1}`;
    wrap.style.setProperty('anchor-name', anchorName);
    tooltip.style.setProperty('position-anchor', anchorName);
    // 'manual' rather than 'auto': these are hover affordances, not dismissible
    // dialogs, and light-dismiss would close them on the first click anywhere.
    tooltip.setAttribute('popover', 'manual');

    const open = () => {
      if (!tooltip.childElementCount) return;
      tooltipHost.markOpened();
      wrap.classList.add('has-opened');
      if (!wrap.isConnected) return;
      tooltip.showPopover?.();
      // Measured after opening: a closed popover has no box to measure.
      const top = deps.tooltipTop?.() ?? 0;
      tooltip.classList.toggle('is-below', wrap.getBoundingClientRect().top - top < tooltip.offsetHeight + 8);
      positionCenteredDetailTooltip(tooltip);
    };
    const close = () => {
      tooltip.hidePopover?.();
      tooltipHost.release();
    };
    wrap.addEventListener('pointerenter', open);
    wrap.addEventListener('focusin', open);
    wrap.addEventListener('pointerleave', close);
    wrap.addEventListener('focusout', close);
    wrap.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  }

  // Entries are rows of cells: `[label, value]`, or `[label, middle, value]` when
  // a row carries an extra field. Rows are grid cells (`display: contents`), so a
  // short row would slide into the next row's columns — pad every row to the
  // widest one and widen the grid to match. An entry that is not an array but
  // `{full: 'text'}` renders one full-width line that wraps in place — a long
  // sentence in a nowrap cell would push the popover past the window edge —
  // and `{separated: true}` draws a divider above it for a second block.
  // `{caption: true}` marks secondary text; `{heading: true}` marks a section
  // title whose emphasis is styled by the caller's wrapper.
  // `ariaLabel` overrides the spoken label for callers whose cells don't read
  // as `<name>: <value>` on their own.
  function limitDetailInfoNode(entries, extraClass = '', ariaLabel = '') {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const columns = entries.reduce(
      (widest, entry) => Math.max(widest, Array.isArray(entry) ? entry.length : 0),
      0
    );
    const infoWrap = document.createElement('span');
    infoWrap.className = ['limit-detail-tooltip-wrap', extraClass].filter(Boolean).join(' ');
    infoWrap.classList.toggle('has-opened', tooltipHost.hasOpened());
    const info = document.createElement('span');
    info.className = 'limit-detail-tooltip-trigger';
    info.textContent = 'i';
    info.tabIndex = 0;
    info.setAttribute(
      'aria-label',
      ariaLabel || entries
        .map((entry) => Array.isArray(entry)
          ? `${entry[0]}: ${entry.slice(1).filter(Boolean).join(' ')}`
          : entry?.full)
        .filter(Boolean)
        .join(', ')
    );
    const tooltip = detailTooltipNode(entries, columns);
    infoWrap.append(info, tooltip);
    attachLimitDetailTooltip(infoWrap, tooltip);
    return infoWrap;
  }

  function detailTooltipNode(entries, columns = 2) {
    const tooltip = document.createElement('span');
    tooltip.className = ['limit-detail-tooltip', columns > 2 ? 'limit-detail-tooltip-triple' : '']
      .filter(Boolean).join(' ');
    tooltip.setAttribute('role', 'tooltip');
    entries.forEach((entry) => {
      if (!Array.isArray(entry)) {
        const full = document.createElement('span');
        full.className = [
          'limit-detail-tooltip-full',
          entry?.caption === true ? 'is-caption' : '',
          entry?.heading === true ? 'is-heading' : '',
          entry?.separated === true ? 'is-separated' : ''
        ].filter(Boolean).join(' ');
        full.textContent = String(entry?.full ?? '');
        tooltip.append(full);
        return;
      }
      const row = document.createElement('span');
      row.className = 'limit-detail-tooltip-row';
      for (let column = 0; column < columns; column += 1) {
        const cell = document.createElement('span');
        cell.textContent = entry[column] ?? '';
        row.append(cell);
      }
      tooltip.append(row);
    });
    return tooltip;
  }

  // A gauge or plan label can be the trigger itself; no extra info icon needed.
  function setDetailTooltip(wrap, entries, { centered = false } = {}) {
    let tooltip = wrap.querySelector('.limit-detail-tooltip');
    if (!entries?.length) {
      tooltip?.hidePopover?.();
      tooltip?.replaceChildren();
      wrap.classList.remove('limit-detail-tooltip-wrap');
      wrap.removeAttribute('data-dom-kind');
      wrap.removeAttribute('tabindex');
      wrap.removeAttribute('aria-label');
      wrap.style.removeProperty('-webkit-app-region');
      return;
    }
    // The popover replaces whatever native tooltip the element had; do this on
    // attach only — on detach the caller may have already restored `title` for
    // its own fallback (the marquee's reduced-motion tooltip, say).
    wrap.removeAttribute('title');
    wrap.classList.add('limit-detail-tooltip-wrap');
    wrap.style.setProperty('-webkit-app-region', 'no-drag');
    wrap.setAttribute('aria-label', entries.map((entry) => Array.isArray(entry) ? entry.join(': ') : entry.full).join(', '));
    wrap.tabIndex = 0;
    // Widen to the triple-column layout when an entry carries a middle cell
    // (e.g. model name · tokens · share) the same way limitDetailInfoNode does.
    const columns = entries.reduce(
      (widest, entry) => Math.max(widest, Array.isArray(entry) ? entry.length : 0),
      0
    );
    const next = detailTooltipNode(entries, columns);
    next.classList.toggle('is-centered', centered);
    if (tooltip) {
      // Sync only the layout class: is-below is positional state the tooltip
      // manages itself, and overwriting it mid-hover flips an open popover.
      tooltip.classList.toggle('limit-detail-tooltip-triple', next.classList.contains('limit-detail-tooltip-triple'));
      tooltip.classList.toggle('is-centered', centered);
      tooltip.replaceChildren(...next.children);
      positionCenteredDetailTooltip(tooltip);
    } else {
      tooltip = next;
      wrap.append(tooltip);
      attachLimitDetailTooltip(wrap, tooltip);
    }
  }

  function providerSpendNode(balance, provider = null) {
    if (windowOwners[provider?.provider]?.spendNode) return windowOwners[provider.provider].spendNode(balance, provider);
    const entries = providerSpendEntries(balance);
    if (entries.length === 0) return null;
    const preferredSummary = entries.filter(([label]) => label === 'Today' || label === 'Month');
    const summaryEntries = preferredSummary.length > 0 ? preferredSummary : entries.slice(0, 2);
    const formatted = entries.map(([entryLabel, value]) => [entryLabel, formatBalanceSpendAmount(value, balance)]);
    if (balance?.searchSpend > 0) formatted.push(['Search', formatBalanceSpendAmount(balance.searchSpend, balance)]);
    if (balance?.fetchSpend > 0) formatted.push(['Fetch', formatBalanceSpendAmount(balance.fetchSpend, balance)]);
    return tagUsageItem(limitNoteRowNode({
      label: 'Spend',
      summary: summaryEntries
        .map(([label, value]) => `${label} ${formatBalanceSpendAmount(value, balance)}`)
        .join(' · '),
      // Only worth a tooltip when it would say more than the summary already does.
      detailEntries: formatted.length > summaryEntries.length ? formatted : null,
      ariaParts: formatted.map(([entryLabel, value]) => `${entryLabel} ${value}`)
    }), 'spend', 'Spend');
  }

  // What a window's headline and sub-line read, from the module the edge dock
  // also paints from. Only the two renderer-state inputs are supplied here; the
  // wording itself is not this file's business any more.
  function providerWindowText(provider, window) {
    return limitWindowText(provider, window, {
      showLimitUsed: Boolean(settings()?.showLimitUsed),
      formatCompact: (value) => formatCompact(value)
    });
  }

  // The name of one of `provider`'s windows. Only the kind-derived defaults live
  // in the shared helper; a provider that names its pool something of its own
  // ("Credits", "Token Spend") still passes that in as the fallback.
  function providerWindowLabel(provider, window, fallback = '') {
    return limitWindowLabel(provider?.provider, window, fallback);
  }

  function formatLimitWindowValue(window, fillPercent, hasPercent, showUsed) {
    if (hasPercent) return `${formatPercent(fillPercent)} ${limitModeSuffix(showUsed)}`;
    if (!window) return '--';
    if (String(window.detail || '').toLowerCase() === 'unlimited') return t('settings.thirdparty.unlimited');
    const remaining = optionalFiniteNumber(window?.remaining);
    if (remaining !== null) {
      return window?.showMeter === false ? formatLimitAmount(remaining) : `${formatLimitAmount(remaining)} left`;
    }
    const limit = optionalFiniteNumber(window?.limit);
    if (limit !== null) return `${formatLimitAmount(limit)} cap`;
    return window.detail || '';
  }

  function creditsBalanceValue(provider, credits) {
    const amount = creditsAmount(provider, credits);
    if (amount !== null) {
      return formatCompactMoney(amount, credits?.currency || provider?.balance?.currency);
    }
    return String(credits?.detail || '').toLowerCase() === 'unlimited'
      ? t('settings.thirdparty.unlimited')
      : '';
  }

  function limitMeterNode(color, percent, tone = 1) {
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    const meter = document.createElement('div');
    meter.className = 'limit-meter';
    meter.style.background = colorWithAlpha(color, 0.16);
    meter.style.setProperty('--mark-glow-color', colorWithAlpha(color, 0.55));
    const fill = document.createElement('div');
    fill.className = 'limit-meter-fill';
    applyBarScale(fill, safePercent / 100);
    fill.style.background = color;
    fill.style.opacity = tone;
    meter.append(fill);
    return meter;
  }

  function limitWindowNode(label, window, color, tone = 1, valueOverride = null, detailText = '') {
    const remaining = Number(window?.remainingPercent);
    const used = Number(window?.usedPercent);
    const motionRemaining = motion.remainingPercent(window);
    const showMeter = window?.showMeter !== false;
    const hasPercent = showMeter && (Number.isFinite(remaining) || Number.isFinite(used));
    // valueOverride windows carry a fixed (money/amount) label — keep their meter
    // on "remaining" so bar and label stay consistent; only percent-labelled
    // windows honour the used-mode flip.
    const showUsed = Boolean(settings()?.showLimitUsed) && valueOverride == null;
    const fillPercent = motion.displayPercent(
      limitFillPercent(remaining, used, showUsed)
    );
    const item = document.createElement('div');
    item.className = 'limit-window';
    item.dataset.limitMotionKey = motion.windowKey(label, window);
    item.dataset.limitRemainingPercent = hasPercent && motionRemaining !== null
      ? String(Math.max(0, Math.min(100, motionRemaining)))
      : '';
    item.dataset.limitDisplayPercent = hasPercent && fillPercent !== null ? String(fillPercent) : '';
    item.dataset.limitResetAt = window?.resetsAt || '';
    const text = document.createElement('div');
    text.className = 'limit-window-text';
    const name = document.createElement('span');
    name.textContent = window?.label || label;
    const value = document.createElement('span');
    value.textContent = valueOverride != null ? valueOverride : formatLimitWindowValue(window, fillPercent, hasPercent, showUsed);
    if (valueOverride == null && hasPercent && fillPercent !== null) {
      value.dataset.limitMotionValue = String(fillPercent);
      value.dataset.limitMotionSuffix = limitModeSuffix(showUsed);
    }
    text.append(name, value);
    const meter = limitMeterNode(color, fillPercent, tone);
    const reset = document.createElement('div');
    reset.className = 'limit-reset';
    const resetText = window?.resetsAt
      ? formatLimitBoundary(window)
      : window?.resetDescription || '';
    if (detailText) {
      // Keep the reset text left-aligned (consistent with every other provider)
      // and add the absolute count on the right, under the top-line percentage.
      reset.classList.add('limit-reset-split');
      const resetSpan = document.createElement('span');
      resetSpan.textContent = resetText;
      const detailSpan = document.createElement('span');
      detailSpan.className = 'limit-detail';
      detailSpan.textContent = detailText;
      reset.append(resetSpan, detailSpan);
    } else {
      reset.textContent = resetText;
    }
    if (showMeter) {
      item.append(text, meter, reset);
    } else {
      item.classList.add('limit-window-note');
      item.append(text, reset);
    }
    // Rows drawn straight from a payload window name their own item; callers
    // that draw from a synthesized or relabelled window retag the row.
    return tagUsageItem(item, usageItems.limitUsageItemId(window), name.textContent);
  }

  function quotaDetailEntries(rows) {
    return (rows || []).map(row => [row.label, typeof row.value === 'string'
      ? row.value : formatMoney(row.value.amount, row.value.currency)]);
  }

  function genericCreditWindowNode(provider, creditsWindow, color) {
    const amount = creditsAmount(provider, creditsWindow);
    if (amount === null) return null;
    const display = creditsWindow.creditsDisplay;
    const explicitDisplay = display === 'percent' || display === 'balance';
    const total = creditsWindow.limit;
    const percentDisplay = display === 'percent' && creditsWindow.showMeter !== false
      && Number.isFinite(total) && total > 0 && amount >= 0 && amount <= total;
    const remainingPercent = percentDisplay ? amount / total * 100 : null;
    const displayWindow = explicitDisplay
      ? { ...creditsWindow, showMeter: percentDisplay, remainingPercent,
        usedPercent: percentDisplay ? 100 - remainingPercent : null }
      : { ...creditsWindow, remainingPercent: creditsMeterPercent(provider, creditsWindow) };
    const currency = creditsCurrency(provider, creditsWindow);
    const detailAmount = settings()?.showLimitUsed ? total - amount : amount;
    const balanceNode = limitWindowNode(
      providerWindowLabel(provider, creditsWindow, 'Balance'),
      displayWindow,
      color,
      0.95,
      percentDisplay ? null : formatMoney(amount, currency),
      percentDisplay ? `${formatMoney(detailAmount, currency)} / ${formatMoney(total, currency)}` : ''
    );
    balanceNode.classList.add('limit-window-wide');
    if (!creditsWindow.resetsAt && !creditsWindow.resetDescription && !percentDisplay) balanceNode.classList.add('limit-window-no-reset');
    return balanceNode;
  }

  function positionPluginQuotaInfo(info) {
    if (!info) return;
    info.classList.add('plugin-quota-info');
    info.querySelector('.limit-detail-tooltip').classList.add('is-centered');
  }

  function pluginQuotaWindowNode(provider, window, color) {
    const node = isCreditsWindow(window) ? genericCreditWindowNode(provider, window, color)
      : limitWindowNode(providerWindowLabel(provider, window), window, color, window.kind === 'session' ? 0.95 : 0.68, null, window.detail);
    if (!node) return null;
    if (window.span !== undefined) {
      node.dataset.limitSpan = String(window.span);
      node.classList.toggle('limit-window-wide', window.span === 2);
    }
    const info = limitDetailInfoNode(quotaDetailEntries(window.infoRows));
    if (info) {
      positionPluginQuotaInfo(info);
      const name = node.querySelector('.limit-window-text').children[0];
      name.classList.add('limit-window-label');
      name.append(info);
    }
    return node;
  }

  // `showAllUsageItems` draws the rows the user hid as well: the settings
  // checklist is read off that render.
  function renderProviderWindows(provider, color, options = {}) {
    const windows = document.createElement('div');
    windows.className = 'limit-windows';
    const owner = windowOwners[provider.provider];
    if (owner?.renderWindows) owner.renderWindows(provider, color, windows, options);
    else if (provider.provider?.startsWith('plugin:')) {
      for (const window of provider.windows || []) {
        const node = pluginQuotaWindowNode(provider, window, color);
        if (node) windows.append(node);
      }
      repairWindowPairs(windows);
      for (const note of provider.notes || []) {
        const summary = note.value === undefined ? '' : typeof note.value === 'string'
          ? note.value : formatMoney(note.value.amount, note.value.currency);
        const node = limitNoteRowNode({ label: note.label, summary,
          detailEntries: quotaDetailEntries(note.infoRows), ariaParts: summary ? [summary] : [] });
        positionPluginQuotaInfo(node.querySelector('.limit-detail-tooltip-wrap'));
        windows.append(node);
      }
    }
    else renderGenericWindows(provider, color, windows);
    if (!options.showAllUsageItems) hideUsageItems(windows, usageItems.hiddenUsageItemSet(settings()?.limitProviderHiddenItems, provider?.provider));
    return windows;
  }

  function renderGenericWindows(provider, color, windows, policy = {}) {
      // Default: render only the windows the provider actually has. Providers
      // that only expose a single window shouldn't leave a half-empty bar next to
      // the real one. Credits windows carry money rather than quota percentages;
      // their display meter is derived without changing the provider reading.
      const session = windowForKind(provider, 'session');
      if (session) {
        const node = limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95);
        if (policy.omitEmptyReset && !session.resetsAt && !session.resetDescription) node.classList.add('limit-window-no-reset');
        windows.append(node);
      }
      if (policy.appendWeekly) policy.appendWeekly(provider, color, windows);
      else {
        const weekly = windowForKind(provider, 'weekly');
        if (weekly) windows.append(limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68));
      }
      for (const creditsWindow of (provider.windows || []).filter(isCreditsWindow)) {
        if (policy.appendCredits?.(provider, creditsWindow, windows)) continue;
        const balanceNode = genericCreditWindowNode(provider, creditsWindow, color);
        if (balanceNode) windows.append(balanceNode);
      }
      policy.appendSpend?.(provider, windows);
      repairWindowPairs(windows);
    }

  // Removes the rows of hidden items. Each branch above pairs its rows for a
  // full set, so a row whose partner was hidden would sit in a half-empty grid
  // row; the rows left behind are re-paired instead.
  function hideUsageItems(container, hidden) {
    if (hidden.size === 0) return;
    let removed = false;
    for (const child of [...container.children]) {
      if (child.dataset?.usageItem && hidden.has(child.dataset.usageItem)) {
        child.remove();
        removed = true;
      } else if (child.classList.contains('limit-window-group')) {
        const items = [...child.children].find((node) => node.classList.contains('limit-window-group-items'));
        if (!items) continue;
        hideUsageItems(items, hidden);
        if (items.children.length === 0) {
          child.remove();
          removed = true;
        }
      }
    }
    if (removed) repairWindowPairs(container);
  }

  // A run of half-width rows with an odd count leaves its last row alone on a
  // grid row, so that row spans it. An explicit plugin span keeps its width.
  function repairWindowPairs(container) {
    let run = [];
    const closeRun = () => {
      if (run.length % 2 === 1 && run.at(-1).dataset.limitSpan !== '1') run.at(-1).classList.add('limit-window-wide');
      run = [];
    };
    for (const child of container.children) {
      if (child.classList.contains('limit-window') && !child.classList.contains('limit-window-wide')) run.push(child);
      else closeRun();
    }
    closeRun();
  }

  // The usage items `records` (one provider's accounts) draw, in card order,
  // each once: what the settings checklist offers.
  function limitProviderUsageItems(records, color = '') {
    const items = new Map();
    const collect = (container) => {
      for (const child of container.children) {
        const id = child.dataset?.usageItem;
        if (id && !items.has(id)) items.set(id, child.dataset.usageItemLabel || '');
        if (child.classList.contains('limit-window-group')) collect(child);
        else if (child.classList.contains('limit-window-group-items')) collect(child);
      }
    };
    for (const record of records || []) {
      if (record) collect(renderProviderWindows(record, color, { showAllUsageItems: true }));
      for (const item of windowOwners[record?.provider]?.extraUsageItems?.(record) || []) items.set(item.id, item.label);
    }
    return [...items].map(([id, label]) => ({ id, label }));
  }

  // Every limits surface (the limits panel and the Home cards) resolves account
  // titles here. One table keeps a provider from masking its email on one surface
  // while leaking it on the other, and from rendering two different titles for the
  // same account. Providers identified by email need no entry — the default below
  // already masks them.

  // Fallback names for `provider.source`, used when the provider has no override
  // of its own in limitProviderSourceLabel.
  const LIMIT_SOURCE_LABELS = { oauth: 'OAuth', cli: 'CLI', web: 'Web', rpc: 'RPC', local: 'Local', api: 'API' };

  function limitStatusLabel(status) {
    if (status === 'ok') return 'Live';
    if (status === 'disabled') return 'Disabled';
    if (status === 'notConfigured') return 'Not signed in';
    if (status === 'noSyncedData') return 'No synced data';
    if (status === 'unauthorized') return 'Sign in again';
    if (status === 'rateLimited') return 'Limited';
    if (status === 'sourceRateLimited') return 'Usage API limited';
    if (status === 'unavailable') return 'Unavailable';
    return 'Error';
  }

  function limitProviderFailureLabel(provider) {
    return presentationApi.limitProviderFailureLabel(provider, t) ?? limitStatusLabel(provider?.status);
  }

  function limitProviderMeta(provider, provenance = null) {
    const sourceDevice = presentationApi.limitProviderMainDeviceLabel(provenance, { showSource: Boolean(settings()?.showLimitSource) });
    // The freshness wording is shared with the edge dock so a row cannot read as
    // stale on one surface and merely old on the other.
    const freshness = presentationApi.limitProviderFreshness(provider);
    if (provider.stale) {
      const parts = [freshness.text];
      if (sourceDevice) parts.push(sourceDevice);
      return parts.join(' · ');
    }
    if (provider.status === 'ok') {
      const parts = [];
      if (settings()?.showLimitSource) {
        const sourceLabel = presentationApi.limitProviderSourceLabel(provider) || LIMIT_SOURCE_LABELS[provider.source];
        if (sourceLabel) parts.push(sourceLabel);
      }
      if (sourceDevice) parts.push(sourceDevice);
      return `${freshness.text}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
    }
    return limitProviderFailureLabel(provider);
  }

  function limitProviderPlan(provider) {
    if (provider?.status && provider.status !== 'ok' && !provider.stale) return limitProviderFailureLabel(provider);
    const owned = presentationApi.limitProviderPlanValue(provider, { mimoProductLabel });
    // An explicitly empty owner value suppresses legacy account-label fallback.
    if (owned !== undefined) return owned ? presentationApi.limitProviderPlanDisplayLabel(provider, owned) : '';
    const label = String(provider?.planLabel || '').trim() || presentationApi.limitProviderLegacyPlanLabel(provider);
    if (label) return presentationApi.limitProviderPlanDisplayLabel(provider, label);
    return provider?.status && provider.status !== 'ok' ? limitStatusLabel(provider.status) : '';
  }

  function limitPlanText(provider, options = {}) {
    return options.planText ?? limitProviderPlan(provider);
  }

  function renderLimitProviderMark(id, color) {
    const pluginMark = deps.pluginMark?.(id);
    if (pluginMark) return pluginMark;
    const mark = document.createElement('span');
    if (hasMark(id)) {
      // .limit-icon sizes the mark, .row-icon-<id> supplies the mask: one table,
      // shared with the breakdown rows, instead of a second copy per provider.
      mark.className = `limit-icon row-icon-${id}`;
    } else {
      mark.className = 'dot';
      mark.style.background = color;
    }
    return mark;
  }

  // Rows whose own button is waiting on the host, keyed like the rows' motion
  // keys so the spinner survives the list's periodic repaint.
  const pendingAccountRefreshes = new Set();
  // Each drawn button's row and status line, so a probe starting or finishing
  // can update them in place instead of waiting for the list's next repaint.
  const refreshButtonStatus = new WeakMap();

  function limitRowRefreshing(provider) {
    if (pendingAccountRefreshes.has(motion.providerKey(provider))) return true;
    return (accountRefresh.probes() || []).some((probe) => accountScope.probeCoversRow(probe, provider));
  }

  // Most probes answer in a few hundred milliseconds, so following them
  // exactly flashes a spinner the eye cannot read, and a background poll
  // blinks rows the user never touched. The usual spin-delay remedy: a
  // background refresh shows only once it has outlasted SPIN_DELAY_MS, and a
  // spinner once shown — at once, for a click — stays at least SPIN_MIN_MS.
  const SPIN_DELAY_MS = 400;
  const SPIN_MIN_MS = 800;
  // How long a click that brought nothing back says so before the row
  // returns to its plain "Updated" line.
  const FAILURE_HOLD_MS = 4000;
  // Per row key: when its refresh began and when its spinner appeared.
  const spinStates = new Map();
  // Per row key: why the user's last refresh brought nothing back, and until when to say so.
  const refreshFailures = new Map();
  let syncTimer = null;
  let syncTimerAt = Infinity;

  function scheduleButtonSync(at) {
    if (at >= syncTimerAt) return;
    if (syncTimer !== null) clearTimeout(syncTimer);
    syncTimerAt = at;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncTimerAt = Infinity;
      syncLimitRefreshButtons();
    }, Math.max(0, at - Date.now()));
  }

  function limitRowSpinning(key, provider, now) {
    let spin = spinStates.get(key);
    if (limitRowRefreshing(provider)) {
      if (!spin) spinStates.set(key, spin = { since: now, shownAt: null });
      if (spin.shownAt === null && pendingAccountRefreshes.has(key)) spin.shownAt = now;
      if (spin.shownAt === null) {
        if (now - spin.since >= SPIN_DELAY_MS) spin.shownAt = now;
        else scheduleButtonSync(spin.since + SPIN_DELAY_MS);
      }
      return spin.shownAt !== null;
    }
    if (spin?.shownAt != null && now - spin.shownAt < SPIN_MIN_MS) {
      scheduleButtonSync(spin.shownAt + SPIN_MIN_MS);
      return true;
    }
    spinStates.delete(key);
    return false;
  }

  // Called only once the row's spinner has cleared, so the hold is counted
  // from the moment the reason first shows, not from when the request settled
  // under a spinner still serving its minimum. A failure not shown well past
  // that minimum (a hold's length of slack for late timers) is stale: its row
  // was replaced unseen (the dock swaps cards), or a newer probe kept it
  // spinning and now answers for it.
  function limitRowFailure(key, now) {
    const failure = refreshFailures.get(key);
    if (!failure) return null;
    if (failure.until === null) {
      if (now - failure.settledAt > SPIN_MIN_MS + FAILURE_HOLD_MS) {
        refreshFailures.delete(key);
        return null;
      }
      failure.until = now + FAILURE_HOLD_MS;
    }
    if (now >= failure.until) {
      refreshFailures.delete(key);
      return null;
    }
    scheduleButtonSync(failure.until);
    return failure;
  }

  const FAILURE_KEYS = {
    cooldown: 'limits.refreshAccountCooldown',
    failed: 'limits.refreshAccountFailed',
    unavailable: 'limits.refreshAccountFailed'
  };

  function syncLimitRefreshButton(button) {
    const provider = domApi.data(button);
    if (!provider) return;
    const key = motion.providerKey(provider);
    const now = Date.now();
    const busy = limitRowSpinning(key, provider, now);
    // A spinner is newer news than a failure, so it wins while it shows.
    const failure = busy ? null : limitRowFailure(key, now);
    button.classList.toggle('is-refreshing', busy);
    button.classList.toggle('is-refresh-error', Boolean(failure));
    button.classList.toggle('is-refresh-cooldown', failure?.reason === 'cooldown');
    // Not `disabled`: that would drop keyboard focus out from under the user.
    button.setAttribute('aria-disabled', String(busy));
    const status = refreshButtonStatus.get(button);
    if (status) {
      const text = failure ? t(FAILURE_KEYS[failure.reason] || FAILURE_KEYS.failed) : '';
      if (status.textContent !== text) status.textContent = text;
    }
  }

  // Read current buttons from the DOM, without retaining retired views.
  function syncLimitRefreshButtons(root = document) {
    for (const button of root.querySelectorAll('.limit-refresh-button')) syncLimitRefreshButton(button);
  }

  // The button and the status line that reports a click that came back empty.
  // The status line is a polite live region from the moment it is drawn, so a
  // screen reader hears the failure the sighted user sees.
  function limitRefreshControl(provider, name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'limit-refresh-button';
    // Named after the row it sits on, so a group's buttons can be told apart.
    button.setAttribute('aria-label', t('limits.refreshAccount', { name }));
    const icon = document.createElement('span');
    icon.className = 'limit-refresh-icon';
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    const status = document.createElement('span');
    status.className = 'limit-refresh-status';
    status.setAttribute('role', 'status');
    domApi.data(button, provider);
    refreshButtonStatus.set(button, status);
    syncLimitRefreshButton(button);
    // The row's own click handler ignores clicks on buttons.
    pressActivation.activateOnPress(button, () => {
      const provider = domApi.data(button);
      const key = motion.providerKey(provider);
      // The spinner is the row's state, not the request's: a click while it
      // still shows (a refresh in flight, or one just settled) does nothing.
      if (pendingAccountRefreshes.has(key) || button.classList.contains('is-refreshing')) return;
      refreshFailures.delete(key);
      pendingAccountRefreshes.add(key);
      syncLimitRefreshButton(button);
      void Promise.resolve()
        .then(() => accountRefresh.refresh(provider))
        .then((result) => result, () => ({ ok: false, reason: 'failed' }))
        .then((result) => {
          if (result?.ok === false) {
            refreshFailures.set(key, { reason: result.reason || 'failed', settledAt: Date.now(), until: null });
          }
        })
        .finally(() => {
          pendingAccountRefreshes.delete(key);
          // The row may have been repainted meanwhile; settle whichever button
          // stands for it now.
          syncLimitRefreshButtons();
        });
    });
    return [button, status];
  }

  function renderLimitProviderHead(id, label, provider, color, options = {}) {
    const head = document.createElement('div');
    head.className = 'limit-head';
    const titleBlock = document.createElement('div');
    titleBlock.className = 'limit-title';
    const name = document.createElement('div');
    name.className = 'limit-name';
    if (options.showIcon !== false) name.append(renderLimitProviderMark(options.markId || id, color));
    // A row that names nothing renders without the title line at all — its meta
    // line ("Updated · source") becomes the row's first text — instead of
    // leaving a blank heading behind.
    const titleText = options.title || label;
    const title = titleText ? document.createElement('span') : null;
    if (title) {
      title.className = 'limit-name-title';
      title.textContent = titleText;
    }
    const provenance = presentationApi.limitProviderProvenance(provider, provenanceContext());
    // The ✓ marks the account THIS device's Codex is signed into
    // (state.codexActiveAccount, derived locally by codexActiveAccountFromStats).
    // It only disambiguates rows in the multi-account group, so it's gated on
    // showActiveBadge. Never re-derive "live" from the row being rendered — in
    // sync mode that row can be a remote device's record for a different account,
    // which would move the ✓ onto the wrong one.
    const controlOptions = windowOwners[id]?.accountControlOptions?.(provider, options) || { active: false, switchAccount: null };
    const control = accountControl.render({
      titleNode: title,
      ...controlOptions,
      // Who the switch would move this device to, named by the caller that knows
      // it (see renderLimitProviderSolo/Group). The control used to read the name
      // off the object switchTarget() resolved, which only the page's managed
      // entries carry — so the same control named the account on one surface and
      // fell back to the unnamed placeholder on the other.
      accountLabel: options.accountLabel || ''
    });
    // A named row hands the title through the control (which returns it unchanged
    // when there is nothing to switch); an unnamed row appends nothing.
    if (control) name.append(control);
    titleBlock.append(name);
    // The multi-account group header has no quota of its own, and its accounts can
    // update at different times (different devices too), so it omits the meta line
    // entirely — each account row below shows its own "Updated" time.
    if (!options.hideMeta) {
      const meta = document.createElement('div');
      meta.className = 'limit-meta';
      const metaParts = [];
      // A single Codex account stays clean like every other provider (just the
      // "Updated" line). The email only matters when several accounts share the
      // group, where it's each subrow's title (options.accountTitle) — not here.
      if (provider.status === 'ok' || provider.stale) metaParts.push(limitProviderMeta(provider, provenance));
      const metaText = metaParts.filter(Boolean).join(' · ');
      // A reading synced from another device can only be refreshed there.
      const refreshControl = metaText && accountRefresh?.available(provider) && !provenance.selectedIsRemote
        ? limitRefreshControl(provider, titleText || limitProviders.LIMIT_PROVIDER_LABELS?.[provider.provider] || provider.provider)
        : null;
      if (refreshControl) {
        const text = document.createElement('span');
        text.className = 'limit-meta-text';
        text.textContent = metaText;
        meta.classList.add('has-refresh');
        meta.append(text, ...refreshControl);
      } else if (metaText) meta.append(document.createTextNode(metaText));
      titleBlock.append(meta);
    }
    const plan = document.createElement('div');
    plan.className = 'limit-plan';
    plan.textContent = limitPlanText(provider, options);
    windowOwners[provider.provider]?.decoratePlan?.(plan, provider, options);
    // A record binds to one account, so the provider-wide rollup belongs on the
    // row that stands for the provider as a whole — the header of a group, or a
    // provider's single row — and not on each member of a group, which would
    // repeat the same three lines once per account. Which of those this row is,
    // is what it just told us: an account row inside a group says so, and the
    // group header carries `accountGroup`.
    head.append(titleBlock, decoratePlanWithSubscription(plan, provider, !options.accountRow));
    return head;
  }

  function renderLimitProviderRow(id, label, provider, color, options = {}) {
    const row = document.createElement('div');
    const classes = ['limit-row'];
    if (options.accountRow) classes.push('limit-account-row');
    if (provider.stale) classes.push('stale');
    row.className = classes.join(' ');
    row.dataset.limitMotionKey = motion.providerKey(provider);
    row.append(
      renderLimitProviderHead(id, label, provider, color, options),
      renderProviderWindows(provider, color)
    );
    if (!options.accountRow) windowOwners[id]?.decorateRow?.(row);
    if (deps.history && settings()?.limitsHistoryOpenMode !== 'off' && (provider.windows || []).some(window => (
      !usageItems.isLimitWindowHidden(settings()?.limitProviderHiddenItems, provider.provider, window)
      && (windowOwners[id]?.historyWindowVisible?.(window) ?? true)
      && (typeof window.usedPercent === 'number' || window.metric === 'credits' && typeof window.remaining === 'number'
      || window.metric === 'spend' && typeof window.used === 'number')
    ))) {
      const key = deps.history.key(provider);
      const openHistory = (interactive) => {
        if (!row.isConnected) return;
        if (!interactive && windowOwners[id]?.historyHoverBlocked?.(row)) return;
        const rect = row.getBoundingClientRect();
        void deps.history.open(key, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, interactive).catch(() => {});
      };
      let hoverTimer = null;
      row.addEventListener('pointerenter', () => {
        deps.history.enter(key);
        if (settings()?.limitsHistoryOpenMode === 'click') return;
        if (deps.history.activeKey?.()) openHistory(false);
        else hoverTimer = setTimeout(() => openHistory(false), 160);
      });
      windowOwners[id]?.bindHistoryHover?.(row, () => clearTimeout(hoverTimer), () => { hoverTimer = setTimeout(() => openHistory(false), 160); });
      row.addEventListener('pointerleave', () => { clearTimeout(hoverTimer); deps.history.leave(key); });
      row.dataset.limitHistory = key;
      row.classList.toggle('is-history-active', deps.history.activeKey?.() === key);
      row.tabIndex = 0;
      row.setAttribute('aria-description', t('limits.history.open'));
      row.addEventListener('keydown', event => {
        if (event.target !== row || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        if (event.repeat) return;
        clearTimeout(hoverTimer); openHistory(true);
      });
      row.addEventListener('click', event => {
        const clickedRow = event.target.closest('.limit-row');
        if (clickedRow && clickedRow !== row && clickedRow.dataset?.limitLead === undefined) return;
        if (event.target.closest('button, a, input, select, summary, [role="button"]')) return;
        clearTimeout(hoverTimer); openHistory(true);
      });
    }
    return row;
  }

  function limitAccountRowPolicy(id, provider, color, context) {
    const policy = windowOwners[String(id || '').trim().toLowerCase()]?.rowPolicy;
    const resolved = policy ? policy(provider, color, context) : {};
    return { color: resolved.color || color, options: { ...(context.grouped ? { showIcon: false } : {}), ...resolved.options } };
  }

  // Compact surfaces keep the same plan-cell policy as the full account rows.
  function limitAccountPlan(provider, { grouped = false } = {}) {
    const policy = limitAccountRowPolicy(provider?.provider, provider, '', { grouped, sharedFamily: null });
    return limitPlanText(provider, policy.options);
  }

  // A provider's row standing on its own. Both surfaces call this rather than
  // renderLimitProviderRow, so the policy cannot be skipped by a caller that did
  // not know there was one to pass.
  function renderLimitProviderSolo(id, label, provider, color) {
    // Keep the same provider frame when only one MiMo product remains.
    const custom = windowOwners[id]?.renderSolo?.(label, provider, color);
    if (custom) return custom;
    const policy = limitAccountRowPolicy(id, provider, color, { grouped: false, sharedFamily: null });
    // Standing alone, the row is titled with the provider's name, so the account
    // name is resolved here instead: the switch control still has to say which
    // account it would move this device to.
    return renderLimitProviderRow(id, label, provider, policy.color, {
      ...policy.options,
      accountLabel: limitAccountTitle(id, provider, 0, [provider])
    });
  }

  // maskLimitAccountEmails is display-only: it hides the address on the limits
  // surfaces without changing what is collected, synced, or stored.
  function limitAccountEmailsMasked() {
    return settings()?.maskLimitAccountEmails === true;
  }

  function limitAccountDefaultTitle(provider, index, providerEntries = [provider]) {
    return accountIdentity.accountTitleLabel(provider, providerEntries, {
      maskEmail: limitAccountEmailsMasked(),
      index
    }) || t('settings.limits.accountFallback', { number: index + 1 });
  }

  function namedApiAccountTitle(provider, index, providerId) {
    const accountName = String(provider?.accountName || provider?.accountLabel || '').trim();
    if (accountName.toLowerCase() === 'environment') return t(`settings.${providerId}.environment`);
    return accountName || `Account ${index + 1}`;
  }

  function limitAccountTitle(id, provider, index, providerEntries = [provider]) {
    const resolve = windowOwners[String(id || '').trim().toLowerCase()]?.accountTitle;
    return resolve
      ? resolve(provider, index, providerEntries)
      : limitAccountDefaultTitle(provider, index, providerEntries);
  }

  // "4 accounts" on the group header. A caller that has a better phrase passes
  // one; leaving it to the caller is what let the dock card render a group with
  // no count at all while the page showed one.
  function limitGroupCountText(providerId, count) {
    // Muse rows name product sources, not linked accounts.
    if (windowOwners[providerId]?.hideGroupCount) return '';
    const key = windowOwners[providerId]?.groupCountKey || `settings.${providerId}.nAccounts`;
    const text = t(key, { count });
    // A provider with no key of its own would otherwise print the key itself.
    return text === key ? t('settings.limits.nAccounts', { count }) : text;
  }

  function renderLimitProviderGroupFrame(providerId, label, providers, color, { count, markId } = {}) {
    const row = document.createElement('div');
    row.className = `limit-row limit-row-group${providers.some((provider) => provider.stale) ? ' stale' : ''}`;
    // The header stands for the rows it draws, including when a card hides
    // another row of this provider. Subscription rollups use that exact set.
    const groupProvider = {
      provider: providerId,
      status: 'ok',
      windows: [],
      accountGroup: true,
      groupAccounts: providers
    };
    row.append(renderLimitProviderHead(providerId, label, groupProvider, color, {
      planText: windowOwners[providerId]?.groupPlanText?.(providers) || (count ? limitGroupCountText(providerId, count) : ''),
      hideMeta: true,
      ...(markId ? { markId } : {})
    }));
    const list = document.createElement('div');
    list.className = 'limit-account-list';
    row.append(list);
    return { row, list, groupProvider };
  }

  // A provider's several accounts, as the page's group header plus one row each.
  // No options: what the header wears and what each row says is the provider's
  // policy above, so a second surface cannot render the same group differently by
  // passing a different set.
  function renderLimitProviderGroup(providerId, label, providers, color) {
    const owner = windowOwners[providerId];
    const custom = owner?.renderGroup?.(label, providers, color);
    if (custom) return custom;
    const policy = owner?.groupPolicy || (() => ({}));
    const { markId, sharedFamily, forecastOnGroup } = policy(providers);
    const { row, list: accountList } = renderLimitProviderGroupFrame(
      providerId, label, providers, color, { count: providers.length, markId }
    );
    owner?.decorateGroup?.(row, accountList, providers, color);
    providers.forEach((provider, index) => {
      const account = limitAccountRowPolicy(providerId, provider, color, { grouped: true, sharedFamily });
      // The row's own title is also the name the switch control offers, so the
      // account is named one way on both surfaces — and named the same way the
      // row under the button is.
      const title = limitAccountTitle(providerId, provider, index, providers);
      accountList.append(renderLimitProviderRow(
        providerId,
        title,
        provider,
        account.color,
        { accountRow: true, accountLabel: title, ...account.options }
      ));
    });
    if (forecastOnGroup) owner?.appendCodexResetForecast(row);
    return row;
  }

  // ---- The plan cell's subscription card ------------------------------------
  //
  // Recording what an account costs buys a hover card on its plan label: what
  // the plan is, when it renews, what it has cost so far, and — for a provider
  // whose tokens we also count — what those tokens would have cost instead.
  //
  // It used to be the widget's own decoration, handed to the row through a
  // `decoratePlan` hook a second surface had nothing to pass, so the dock card
  // showed the plan as dead text while the page showed the card. The plan cell
  // is this file's DOM on both surfaces either way, so the card is built here
  // and the hook is gone: there is no longer a way to render the cell without
  // it. Everything it reads is a dep, and none of the subscription deps has a
  // default, so a host that forgets one fails rather than rendering less.

  function subscriptionList() {
    return subscriptionApi.normalizeSubscriptions(subscriptions(), { currencyApi });
  }

  // The account identity rule lives with the rest of them (accountIdentity.js),
  // because the dock's matcher universe is deduped with it before this file ever
  // sees it: two copies of "which account is this" is how one of them ends up
  // counting an account twice. It is the rule the matcher itself binds with —
  // and it is a comparison rather than a value, because the account a record
  // resolved to and the record being drawn are two objects, not one.
  function subscriptionAccountMatches(account, provider) {
    return accountIdentity.sameAccount(account, provider);
  }

  // Usage cost is keyed by client, so the comparison is the sum of what this
  // provider's clients cost this month — resolved through the catalog, because
  // a provider is not always named after the client that produces its tokens
  // and reading the provider id straight out of a client-keyed map compares
  // Factory against nothing while Droid's tokens sit one key away. A provider
  // with no client at all (openrouter, thirdparty…) sums to nothing, which is
  // the correct answer: its spend is either pay-as-you-go or spread across
  // clients with no way to attribute it.
  function subscriptionUsageCostUsd(providerId) {
    const provider = String(providerId || '').trim().toLowerCase();
    if (!provider) return null;
    let cost = 0;
    for (const [client, value] of Object.entries(monthClientCosts() || {})) {
      if (limitProviders.limitProviderForClient(client) !== provider) continue;
      cost += Number(value) || 0;
    }
    return cost > 0 ? cost : null;
  }

  // Matched against every account the provider has, never against a one-element
  // list of the row being rendered: matchProviderAccount() falls back to "the
  // provider has exactly one account, so there is no ambiguity", and a
  // single-row universe makes that fallback true for every sibling. That is what
  // put one Codex subscription's card on all three Codex accounts.
  function subscriptionForProvider(provider) {
    const id = String(provider?.provider || '').toLowerCase();
    const accounts = subscriptionAccounts();
    for (const subscription of subscriptionList()) {
      if (subscription.provider !== id) continue;
      const account = subscriptionApi.matchProviderAccount(subscription, accounts);
      if (account && subscriptionAccountMatches(account, provider)) return subscription;
    }
    return null;
  }

  // Every subscription recorded against a provider, paired with the account it
  // resolves to, and narrowed to the accounts this header draws — the group
  // header stands for its own rows, not for the provider's whole account list.
  // Matching still happens against that whole list, because a row is the wrong
  // universe for it; the filter is what keeps a record on the account it belongs
  // to, out of a summary of accounts that do not include it. An unbound record
  // (nothing resolved) stays: there is no account to have hidden.
  function subscriptionsForProviderGroup(providerId, drawn) {
    const id = String(providerId || '').toLowerCase();
    const accounts = subscriptionAccounts();
    const drawnAccounts = Array.isArray(drawn) ? drawn : null;
    return subscriptionList()
      .filter((subscription) => subscription.provider === id)
      .map((subscription) => ({
        subscription,
        account: subscriptionApi.matchProviderAccount(subscription, accounts)
      }))
      .filter((entry) => (
        !entry.account
        || !drawnAccounts
        || drawnAccounts.some((account) => subscriptionAccountMatches(entry.account, account))
      ));
  }

  // Rows are {label, value} pairs so the tooltip stays a table and the caller
  // does not have to know which shape it is looking at.
  // Keyed off what the user recorded, never off the account's balance marker:
  // the marker only seeds the choice, and reading it here would show
  // subscription rows for a ledger the moment a provider started reporting a
  // balance.
  function subscriptionTooltipRows(subscription, provider, includeRollup) {
    const today = subscriptionApi.todayString();
    return subscriptionApi.isTopUp(subscription)
      ? topUpTooltipRows(subscription, provider, today, includeRollup)
      : subscriptionPlanTooltipRows(subscription, provider, today, includeRollup);
  }

  function subscriptionPlanTooltipRows(subscription, provider, today, includeRollup) {
    const rows = [];
    rows.push({ label: t('subscription.tooltip.price'), value: subscriptionText.priceText(t, currencyApi, subscription) });

    const endDate = subscriptionApi.coverageEndDate(subscription, today);
    const daysLeft = subscriptionApi.daysUntilRenewal(subscription, today);
    const whenLabel = subscription.autoRenew
      ? t('subscription.tooltip.nextCharge')
      : t('subscription.tooltip.validUntil');
    // A lapsed plan has no days left to count down. Saying so beats a negative
    // number, and beats the silent roll-forward that used to keep a cancelled
    // plan permanently four days from renewing.
    const whenSuffix = daysLeft === null
      ? ''
      : ` · ${daysLeft < 0 ? t('subscription.tooltip.expired') : subscriptionText.daysText(t, daysLeft)}`;
    rows.push({ label: whenLabel, value: `${subscriptionText.dateText(currentLocale(), endDate)}${whenSuffix}` });
    if (!subscription.autoRenew) {
      rows.push({ label: t('subscription.tooltip.autoRenew'), value: t('subscription.tooltip.autoRenewOff') });
    }

    rows.push({
      label: t('subscription.tooltip.subscribed'),
      value: subscriptionText.elapsedText(t, currencyApi, subscription, today)
    });

    // The rollup covers every account of the provider at once, so it belongs on
    // whichever row stands for the provider as a whole. When a group header is
    // rendered that is the header, and repeating the same three lines under each
    // member is the noise the header exists to avoid.
    if (!includeRollup) return rows;

    // tokscale records which client produced the tokens, never which signed-in
    // account did, so three logins share one usage figure. Charging that figure
    // against a single account would claim it three times over; the rollup is
    // the only honest denominator.
    const usageCostUsd = subscriptionUsageCostUsd(subscription.provider);
    if (usageCostUsd === null) return rows;
    const rollup = subscriptionApi.providerRollup(subscriptionList(), subscription.provider, currencyApi, today);
    const multiple = subscriptionApi.valueMultiple(rollup.monthlyUsd, usageCostUsd);
    if (multiple === null) return rows;

    rows.push({ separator: true });
    if (rollup.count > 1) {
      rows.push({
        label: t('subscription.tooltip.providerTotal', { provider: subscriptionText.providerLabel(subscription.provider) }),
        value: t('subscription.tooltip.providerTotalValue', {
          count: rollup.count,
          total: formatCost(rollup.monthlyUsd)
        })
      });
    }
    rows.push({
      label: t('subscription.tooltip.monthUsage'),
      // Prefixed with "≈" and titled below: this is tokscale's equivalent API
      // pricing, not money owed. Under a subscription nothing is billed per token.
      value: `≈ ${formatCost(usageCostUsd)}${rollup.count > 1 ? ` · ${t('subscription.tooltip.allAccounts')}` : ''}`,
      title: t('subscription.tooltip.monthUsageNote')
    });
    rows.push({
      label: t('subscription.tooltip.valueMultiple'),
      value: `${multiple.toFixed(1)}×`
    });
    return rows;
  }

  function topUpTooltipRows(subscription, provider, today, includeRollup) {
    const rows = [];
    const last = subscriptionApi.lastTopUp(subscription);
    if (last) {
      rows.push({
        label: t('subscription.tooltip.lastTopUp'),
        value: `${subscriptionText.dateText(currentLocale(), last.date)} · ${subscriptionText.topUpMinorText(currencyApi, subscription, last.amountMinor)}`
      });
    }
    const monthMinor = subscriptionApi.topUpMonthMinor(subscription, today);
    if (monthMinor > 0) {
      rows.push({
        label: t('subscription.tooltip.topUpMonth'),
        value: subscriptionText.topUpMinorText(currencyApi, subscription, monthMinor)
      });
    }
    const entries = subscriptionApi.topUpEntries(subscription);
    if (entries.length > 1) {
      rows.push({
        label: t('subscription.tooltip.topUpTotal'),
        value: `${subscriptionText.topUpMinorText(currencyApi, subscription, subscriptionApi.topUpTotalMinor(subscription))} · ${t('subscription.tooltip.topUpCount', { count: entries.length })}`
      });
    }

    const creditsWindow = (provider?.windows || []).find(isCreditsWindow) || null;
    const balance = creditsAmount(provider, creditsWindow);
    if (balance === null) return topUpRollupRows(rows, subscription, today, includeRollup);
    const balanceCurrency = String(creditsWindow?.currency || provider?.balance?.currency || subscription.currency);
    rows.push({ label: t('subscription.tooltip.balance'), value: formatMoney(balance, balanceCurrency) });

    const projection = subscriptionApi.topUpProjection(subscription, balance, today, {
      currencyApi,
      balanceCurrency
    });
    if (!projection || projection.dailyBurn <= 0) return topUpRollupRows(rows, subscription, today, includeRollup);
    rows.push({
      label: t('subscription.tooltip.burnRate'),
      value: t('subscription.tooltip.perDay', { amount: formatMoney(projection.dailyBurn, balanceCurrency) })
    });
    if (projection.exhaustDate) {
      rows.push({
        label: t('subscription.tooltip.exhausts'),
        value: `${subscriptionText.dateText(currentLocale(), projection.exhaustDate)} · ${subscriptionText.daysText(t, projection.daysRemaining)}`
      });
    }
    return topUpRollupRows(rows, subscription, today, includeRollup);
  }

  // A ledger earns the same provider-level comparison a plan gets: what went in
  // this month against what the month's tokens would have cost.
  function topUpRollupRows(rows, subscription, today, includeRollup) {
    if (!includeRollup) return rows;
    const usageCostUsd = subscriptionUsageCostUsd(subscription.provider);
    if (usageCostUsd === null) return rows;
    const rollup = subscriptionApi.providerRollup(subscriptionList(), subscription.provider, currencyApi, today);
    const multiple = subscriptionApi.valueMultiple(rollup.monthlyUsd, usageCostUsd);
    if (multiple === null) return rows;
    rows.push({ separator: true });
    rows.push({
      label: t('subscription.tooltip.monthUsage'),
      value: `≈ ${formatCost(usageCostUsd)}`,
      title: t('subscription.tooltip.monthUsageNote')
    });
    rows.push({ label: t('subscription.tooltip.valueMultiple'), value: `${multiple.toFixed(1)}×` });
    return rows;
  }

  // The group header stands for all of its accounts at once, so it summarises
  // rather than picking one of them.
  //
  // The summary's money is the provider's, not the header's drawn set, and that
  // is deliberate — it is the same scope the per-account card's rollup and the
  // ledger's use, and it has to be, because the usage figure it is read against
  // cannot be split per account at all: tokscale records the client, never the
  // signed-in login. A narrowed price over a provider-wide usage would be a
  // ratio of two different scopes. What the drawn set does narrow is the cards,
  // since a card is about one account.
  function subscriptionGroupTooltipRows(providerId, today) {
    const rollup = subscriptionApi.providerRollup(subscriptionList(), providerId, currencyApi, today);
    const rows = [{
      label: t('subscription.tooltip.providerTotal', { provider: subscriptionText.providerLabel(providerId) }),
      value: t('subscription.tooltip.providerTotalValue', {
        count: rollup.count,
        total: formatCost(rollup.monthlyUsd)
      })
    }];

    const usageCostUsd = subscriptionUsageCostUsd(providerId);
    if (usageCostUsd === null) return rows;
    rows.push({ separator: true });
    rows.push({
      label: t('subscription.tooltip.monthUsage'),
      value: `≈ ${formatCost(usageCostUsd)} · ${t('subscription.tooltip.allAccounts')}`,
      title: t('subscription.tooltip.monthUsageNote')
    });
    const multiple = subscriptionApi.valueMultiple(rollup.monthlyUsd, usageCostUsd);
    if (multiple !== null) {
      rows.push({ label: t('subscription.tooltip.valueMultiple'), value: `${multiple.toFixed(1)}×` });
    }
    return rows;
  }

  // No heading. The card is already reached by hovering a plan label, and every
  // row names itself — a "Subscription" line above them only repeats what the
  // gesture said, and the other tooltips in this panel carry no title either.
  function subscriptionCardNode(rows) {
    if (rows.length === 0) return null;
    const card = document.createElement('span');
    card.className = 'limit-detail-tooltip subscription-tooltip';
    card.setAttribute('role', 'tooltip');
    const notes = new Set();
    for (const row of rows) {
      if (row.separator) {
        const rule = document.createElement('span');
        rule.className = 'subscription-tooltip-rule';
        card.append(rule);
        continue;
      }
      // display:contents on the row lets label and value land directly in the
      // card's two-column grid, so the existing tooltip cell styling applies.
      const line = document.createElement('span');
      line.className = 'limit-detail-tooltip-row';
      const label = document.createElement('span');
      label.textContent = row.label;
      const value = document.createElement('span');
      if (row.warn) value.className = 'subscription-tooltip-warn';
      value.textContent = row.value;
      if (row.title) notes.add(row.title);
      line.append(label, value);
      card.append(line);
    }
    if (notes.size) card.setAttribute('aria-description', [...notes].join(' '));
    return card;
  }

  // An account row shows its own subscription and nothing else. A group header
  // stands for all of them, so it summarises — except when only one account is
  // recorded, where the summary would just restate that one card with less in it.
  function subscriptionCardForRow(provider, includeRollup) {
    if (provider?.accountGroup === true) {
      const entries = subscriptionsForProviderGroup(provider.provider, provider.groupAccounts);
      if (entries.length === 0) return null;
      // Either shape rolls up the whole provider: one recorded subscription
      // still restates that account's own card, several become a summary of
      // them, and both are read against the provider's usage. Splitting them
      // would put two different answers on the same header.
      if (entries.length === 1) {
        return subscriptionCardNode(
          subscriptionTooltipRows(entries[0].subscription, entries[0].account || provider, true)
        );
      }
      return subscriptionCardNode(
        subscriptionGroupTooltipRows(provider.provider, subscriptionApi.todayString())
      );
    }
    const subscription = subscriptionForProvider(provider);
    if (!subscription) return null;
    return subscriptionCardNode(subscriptionTooltipRows(subscription, provider, includeRollup));
  }

  // Wraps a visible plan label so hovering it reveals the subscription card. Reuses the
  // limit-detail tooltip plumbing, which already holds off the list re-render
  // while the pointer is inside.
  //
  // Deliberately not behind a preference: an account with no record decorates
  // nothing, so having recorded one IS the switch. A separate toggle only made it
  // possible to enter the data and see nothing happen.
  function decoratePlanWithSubscription(plan, provider, includeRollup) {
    if (!plan.textContent) return plan;
    const card = subscriptionCardForRow(provider, includeRollup);
    if (!card) return plan;

    const wrap = document.createElement('div');
    wrap.className = 'limit-plan limit-detail-tooltip-wrap subscription-plan-wrap';
    wrap.classList.toggle('has-opened', tooltipHost.hasOpened());
    wrap.tabIndex = 0;
    const description = card.getAttribute('aria-description');
    if (description) wrap.setAttribute('aria-description', description);
    const trigger = document.createElement('span');
    trigger.className = 'subscription-plan-trigger';
    trigger.textContent = plan.textContent;
    wrap.append(trigger, card);
    // The same plumbing as every other tooltip here: top layer, anchored to its
    // own trigger, flipped below when the row has no room above it.
    attachLimitDetailTooltip(wrap, card);
    return wrap;
  }

  return {
    antigravityQuotaGroups: windowOwners.antigravity.antigravityQuotaGroups,
    attachLimitDetailTooltip,
    setDetailTooltip,
    codexResetForecastExpired: windowOwners.codex.codexResetForecastExpired,
    limitAccountTitle,
    limitAccountPlan,
    limitProviderMeta,
    limitProviderPlan,
    limitStatusLabel,
    renderLimitProviderGroup,
    renderLimitProviderHead,
    renderLimitProviderMark,
    renderLimitProviderRow,
    renderLimitProviderSolo,
    syncLimitRefreshButtons,
    claudeBalanceNode: windowOwners.claude.claudeBalanceNode,
    codexAdditionalWindowLabel: windowOwners.codex.codexAdditionalWindowLabel,
    codexResetCreditsNode: resetCreditsNode,
    creditsBalanceValue,
    expiryDateLabel,
    formatLimitAmount,
    formatLimitWindowValue,
    limitDetailInfoNode,
    limitMeterNode,
    limitNoteRowNode,
    limitWindowNode,
    mimoTokenPlanWindowFromBalance: windowOwners.mimo.mimoTokenPlanWindowFromBalance,
    openrouterCreditsWindow: windowOwners.openrouter.openrouterCreditsWindow,
    providerSpendNode,
    providerWindowLabel,
    providerWindowText,
    renderProviderWindows,
    limitProviderUsageItems,
    thirdPartyQuotaWindow: windowOwners.thirdparty.thirdPartyQuotaWindow,
    workbuddyCombinedProvider: windowOwners.workbuddy.workbuddyCombinedProvider,
    collapseWorkbuddyAccounts: windowOwners.workbuddy.collapseWorkbuddyAccounts,
    thirdPartySpendNode: windowOwners.thirdparty.thirdPartySpendNode,
    windowForKind,
    windowsForKind
  };
  }

  return { createLimitWindowsView };
});
