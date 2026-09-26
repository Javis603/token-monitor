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
//                                      the host's render-hold bookkeeping
//
// The one exception to "everything arrives through deps" is the provider
// catalog: which client a provider's tokens are recorded under is the same
// answer on every host, so it is imported rather than passed. A dep would only
// give three hosts three chances to supply a different one.
(function exposeLimitWindowsView(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('../../../shared/limits/providers') : root?.TokenMonitorLimitProviders);
  if (node) module.exports = api;
  if (root) root.TokenMonitorLimitWindowsView = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLimitWindowsViewApi(limitProviders) {
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
      isMimoMembershipProduct,
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
      resetForecast = () => ({ busy: false, forecast: null })
    } = deps;
    const document = deps.document || globalThis.document;

  function windowForKind(provider, kind) {
    return (provider?.windows || []).find((window) => window.kind === kind) || null;
  }

  function windowsForKind(provider, kind) {
    return (provider?.windows || []).filter((window) => window.kind === kind);
  }

  function codexCanonicalWindow(provider, kind) {
    return windowsForKind(provider, kind).find((window) => window?.additional !== true) || null;
  }

  function codexAdditionalWindowLabel(window, siblingWindows = []) {
    const name = String(window?.label || '').trim();
    const period = codexAdditionalWindowPeriodLabel(window);
    if (!name) return period || 'Additional limit';
    const normalizedName = name.toLowerCase();
    const matchingWindowCount = siblingWindows.filter((candidate) => (
      String(candidate?.label || '').trim().toLowerCase() === normalizedName
    )).length;
    const displayName = presentationApi.codexAdditionalQuotaDisplayName(name);
    return matchingWindowCount > 1 && period ? `${displayName} · ${period}` : displayName;
  }

  function codexAdditionalWindowPeriodLabel(window) {
    const minutes = Number(window?.windowMinutes);
    if (Number.isFinite(minutes) && minutes > 0 && Number.isInteger(minutes)) {
      if (minutes === 30 * 24 * 60) return 'Monthly';
      if (minutes % (7 * 24 * 60) === 0) {
        const weeks = minutes / (7 * 24 * 60);
        return weeks === 1 ? 'Weekly' : `${weeks}-week`;
      }
      if (minutes % (24 * 60) === 0) {
        const days = minutes / (24 * 60);
        return days === 1 ? 'Daily' : `${days}-day`;
      }
      if (minutes % 60 === 0) return `${minutes / 60}-hour`;
      return `${minutes}-minute`;
    }
    if (window?.kind === 'daily') return 'Daily';
    if (window?.kind === 'weekly') return 'Weekly';
    if (window?.kind === 'billing') return 'Monthly';
    if (window?.kind === 'session') return 'Session';
    return '';
  }

  function antigravityQuotaGroups(provider) {
    const entries = (provider?.windows || [])
      .filter((window) => window.kind === 'session' || window.kind === 'weekly')
      .map((window) => {
        const presentation = presentationApi.antigravityQuotaWindow(window);
        return presentation ? { ...presentation, window } : null;
      });
    // Legacy GetUserStatus pools have model names rather than group + period
    // labels. Keep their existing flat layout instead of guessing a hierarchy.
    if (entries.length === 0 || entries.some((entry) => entry === null)) return [];
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.groupLabel)) groups.set(entry.groupLabel, []);
      groups.get(entry.groupLabel).push(entry);
    }
    return [...groups].map(([label, windows]) => ({ label, windows }));
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
  function formatCodexResetCreditsValue(resetCredits) {
    const available = Number(resetCredits?.availableCount);
    if (!Number.isFinite(available)) return '';
    const count = Math.max(0, Math.floor(available));
    if (count <= 0) return '';
    return `${count} reset${count === 1 ? '' : 's'}`;
  }

  function codexResetCreditExpirationDates(resetCredits) {
    const values = Array.isArray(resetCredits?.expirations) ? resetCredits.expirations : [];
    const dates = values
      .map((value) => new Date(value))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    if (dates.length > 0) return dates;
    const fallback = resetCredits?.nextExpiresAt ? new Date(resetCredits.nextExpiresAt) : null;
    return fallback && !Number.isNaN(fallback.getTime()) ? [fallback] : [];
  }

  function codexResetCreditExpiryLabel(date) {
    const diffMs = date.getTime() - Date.now();
    return diffMs <= 0 ? 'now' : formatDuration(diffMs);
  }

  function codexResetCreditExpiryDetailLabel(date) {
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

  // `detail` optionally replaces the ⓘ tooltip's contents: Claude's reset
  // grants carry a label, the windows they clear, and a usability state, which
  // is more than the bare expiry dates Codex has to work with.
  function codexResetCreditsNode(resetCredits, detail = null) {
    const valueText = formatCodexResetCreditsValue(resetCredits);
    if (!valueText) return null;
    const expirationDates = codexResetCreditExpirationDates(resetCredits);
    const detailEntries = Array.isArray(detail?.entries) && detail.entries.length > 0
      ? detail.entries
      : null;
    const item = document.createElement('div');
    item.className = 'limit-window limit-window-wide limit-window-note limit-reset-credits';
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
        const summaryParts = expirationDates.slice(0, 3).map(codexResetCreditExpiryLabel);
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
          expirationDates.map((date) => [expiryDateLabel(date), codexResetCreditExpiryLabel(date)]),
          '',
          expirationDates.map((date, index) => `Reset ${index + 1}: ${codexResetCreditExpiryDetailLabel(date)}`).join(', ')
        );
      if (infoNode) expiryGroup.append(infoNode);
      line.append(expiryGroup);
    }
    item.append(line);
    item.setAttribute('aria-label', ['Reset credits', valueText, expirationDates.map(codexResetCreditExpiryDetailLabel).join(', ')].filter(Boolean).join(', '));
    return item;
  }

  // Window ids a Claude reset grant reports in `clears`, in the same words the
  // provider's own windows use. An id this table does not know still reads as
  // words rather than vanishing, since Anthropic adds scoped windows over time.
  function claudeResetClearLabel(key) {
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

  // One block per grant: the label opens as a small caption — Anthropic
  // labels are full sentences, so they wrap on a full-width line rather
  // than a grid cell — then name:value rows for expiry, coverage, and
  // any spending restriction.
  function claudeResetGrantRows(grants) {
    const rows = [];
    grants.forEach((grant, index) => {
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
        .filter((key) => key !== 'seven_day_overage_included' || !clearKeys.includes('seven_day'))
        .map(claudeResetClearLabel)
        .filter(Boolean);
      const clearsText = clears.join(' · ');
      if (clearsText) rows.push(['Clears', clearsText]);
      if (grant?.useRequiresLimit === true) rows.push(['Usable', 'at a limit only']);
      else if (grant?.usableNow === false) rows.push(['Usable', 'not right now']);
    });
    return rows;
  }

  // Claude's reset grants share Codex's compact "N resets · time" line; the ⓘ
  // tooltip carries what Codex cannot say — why each reset exists, what it
  // clears, and whether it can be spent right now.
  function claudeResetCreditsNode(resetCredits) {
    const grants = Array.isArray(resetCredits?.grants) ? resetCredits.grants : [];
    if (grants.length === 0) return codexResetCreditsNode(resetCredits);
    const ariaLabel = grants.map((grant, index) => {
      const left = Number(grant?.resetsLeft);
      const count = Number.isFinite(left) ? `${Math.max(0, Math.floor(left))} left` : '';
      // Speak the same rows the tooltip shows — expiry, cleared windows,
      // usability — so a restriction like 'not right now' is not silent.
      const details = claudeResetGrantRows([grant])
        .map((row) => (Array.isArray(row) ? `${row[0]}: ${row[1]}` : row.full))
        .filter(Boolean)
        .join(', ');
      return [`Reset ${index + 1}`, count, details]
        .filter(Boolean)
        .join(', ');
    }).join('; ');
    return codexResetCreditsNode(resetCredits, { entries: claudeResetGrantRows(grants), ariaLabel });
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

  function attachLimitDetailTooltip(wrap, tooltip) {
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
      tooltipHost.markOpened();
      wrap.classList.add('has-opened');
      if (!wrap.isConnected) return;
      tooltip.showPopover?.();
      // Measured after opening: a closed popover has no box to measure.
      tooltip.classList.toggle('is-below', wrap.getBoundingClientRect().top < tooltip.offsetHeight + 8);
    };
    const close = () => {
      tooltip.hidePopover?.();
      tooltipHost.release();
    };
    wrap.addEventListener('pointerenter', open);
    wrap.addEventListener('focusin', open);
    wrap.addEventListener('pointerleave', close);
    wrap.addEventListener('focusout', close);
  }

  // Entries are rows of cells: `[label, value]`, or `[label, middle, value]` when
  // a row carries an extra field. Rows are grid cells (`display: contents`), so a
  // short row would slide into the next row's columns — pad every row to the
  // widest one and widen the grid to match. An entry that is not an array but
  // `{full: 'text'}` renders one full-width line that wraps in place — a long
  // sentence in a nowrap cell would push the popover past the window edge —
  // and `{separated: true}` draws a divider above it for a second block.
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
        .filter(Array.isArray)
        .map(([entryLabel, ...rest]) => `${entryLabel}: ${rest.filter(Boolean).join(' ')}`)
        .join(', ')
    );
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
    infoWrap.append(info, tooltip);
    attachLimitDetailTooltip(infoWrap, tooltip);
    return infoWrap;
  }

  function providerSpendNode(balance, provider = null) {
    if (provider?.provider === 'typesafe') {
      const usage = provider.usageSummary;
      if (usage?.period !== 'month' || usage.totalTokens === null) return null;
      const count = (value) => Number(value).toLocaleString(currentLocale());
      // Summary numbers compact at the same threshold every other token
      // surface uses — 1K western, 1萬 localized — and honor the compact-units
      // setting. The tooltip keeps exact counts.
      const threshold = compactTokenThreshold();
      const brief = (value) => (Number.isFinite(value) && Math.abs(value) >= threshold
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
      return limitNoteRowNode({
        // Row labels on this page are fixed English ('Balance', 'Spend',
        // 'Reset'); the token row mirrors the Spend row's Today · Month shape.
        // Only the tooltip stays localized, matching the third-party rows.
        label: 'Tokens',
        summary: summaryParts.join(' · '),
        detailEntries: details,
        ariaParts: details.filter(Array.isArray).map(([label, value]) => `${label} ${value}`)
      });
    }
    const entries = providerSpendEntries(balance);
    if (entries.length === 0) return null;
    const preferredSummary = entries.filter(([label]) => label === 'Today' || label === 'Month');
    const summaryEntries = preferredSummary.length > 0 ? preferredSummary : entries.slice(0, 2);
    const formatted = entries.map(([entryLabel, value]) => [entryLabel, formatBalanceSpendAmount(value, balance)]);
    return limitNoteRowNode({
      label: 'Spend',
      summary: summaryEntries
        .map(([label, value]) => `${label} ${formatBalanceSpendAmount(value, balance)}`)
        .join(' · '),
      // Only worth a tooltip when it would say more than the summary already does.
      detailEntries: entries.length > summaryEntries.length ? formatted : null,
      ariaParts: formatted.map(([entryLabel, value]) => `${entryLabel} ${value}`)
    });
  }

  function thirdPartySpendNode(provider, quotaWindow) {
    const balance = provider?.balance || null;
    const usage = provider?.usageSummary || null;
    const currency = balance?.currency || 'USD';
    const allTimeSpend = optionalFiniteNumber(balance?.allTimeSpend);
    const monthSpend = optionalFiniteNumber(balance?.monthSpend);
    const entries = [];
    const total = optionalFiniteNumber(quotaWindow?.limit);
    const requestCount = optionalFiniteNumber(balance?.requestCount);
    const quotaGroup = String(balance?.quotaGroup || '').trim();
    const expiresAt = balance?.expiresAt ? new Date(balance.expiresAt) : null;
    if (total !== null) entries.push([t('settings.thirdparty.totalQuota'), formatMoney(total, currency)]);
    if (requestCount !== null) {
      entries.push([t('settings.thirdparty.requests'), Math.max(0, Math.trunc(requestCount)).toLocaleString()]);
    }
    if (quotaGroup) entries.push([t('settings.thirdparty.group'), quotaGroup]);
    if (expiresAt && !Number.isNaN(expiresAt.getTime())) {
      entries.push([t('settings.thirdparty.expires'), expiresAt.toLocaleDateString()]);
    }
    const usageCountEntry = (key, value) => {
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
        .filter((value) => value !== null)
        .reduce((sum, value) => sum + value, 0);
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
    if (allTimeSpend === null && monthSpend === null && entries.length === 0) return null;
    // Without a spend figure the row has nothing to summarize, so it retitles
    // itself and leans entirely on the tooltip.
    const summary = [
      ...(monthSpend !== null ? [`Month ${formatMoney(monthSpend, currency)}`] : []),
      ...(allTimeSpend !== null ? [`All time ${formatMoney(allTimeSpend, currency)}`] : [])
    ].join(' · ');
    return limitNoteRowNode({
      label: summary ? 'Spend' : 'Details',
      summary,
      detailEntries: entries,
      ariaParts: [
        ...(summary ? [summary] : []),
        ...entries.map(([entryLabel, value]) => `${entryLabel} ${value}`)
      ]
    });
  }

  // One tooltip row per prepaid grant: amount, expiry date, time left, the same
  // shape Codex's reset credits use. `aria` spells the expiry out, since the
  // terse columns no longer say what the date and duration mean.
  function claudePrepaidGrantRows(tranches, currency) {
    return tranches
      .filter((tranche) => optionalFiniteNumber(tranche?.amount) !== null)
      .map((tranche) => {
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

  // Claude's prepaid credits. Deliberately meter-less: the headline is a sum of
  // grants whose expiries belong to its parts, so a bar would need a denominator
  // this pool doesn't report. Expiries live in the tooltip instead.
  function claudeBalanceNode(provider) {
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
    return limitNoteRowNode({
      label: 'Balance',
      summary: formatMoney(amount, currency),
      detailEntries: grants.map((grant) => grant.cells),
      ariaParts: [formatMoney(amount, currency), ...grants.map((grant) => grant.aria)]
    });
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

  function openrouterCreditsWindow(provider) {
    const windows = Array.isArray(provider?.windows) ? provider.windows : [];
    // Older hubs normalized windows before `metric` existed. Keep the label
    // fallback only for those mixed-version payloads.
    return windows.find((window) => window?.metric === 'credits')
      || windows.find((window) => !window?.metric && window?.label === 'Credits')
      || null;
  }

  function thirdPartyQuotaWindow(provider) {
    const windows = Array.isArray(provider?.windows) ? provider.windows : [];
    return windows.find((window) => window?.metric === 'credits') || null;
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

  function clineCreditsNode(provider, credits, spend) {
    const value = creditsBalanceValue(provider, credits);
    if (!value) return null;
    const monthSpend = optionalFiniteNumber(spend?.used);
    const spendValue = monthSpend === null ? '' : formatBalanceSpendAmount(monthSpend, spend);
    return limitNoteRowNode({
      label: credits.label || 'Credits',
      summary: value,
      detailEntries: spendValue ? [['Month spent', spendValue]] : null,
      ariaParts: [value, ...(spendValue ? [`Month spent ${spendValue}`] : [])]
    });
  }

  function mimoTokenPlanWindowFromBalance(balance) {
    if (!balance) return null;
    if (balance.planStatus === 'expired') return null;
    const used = optionalFiniteNumber(balance.planUsed);
    const limit = optionalFiniteNumber(balance.planLimit);
    const percent = optionalFiniteNumber(balance.planPercent);
    const hasUsed = used !== null;
    const hasLimit = limit !== null;
    const hasPercent = percent !== null;
    if (!hasUsed && !hasLimit && !hasPercent) return null;
    const resolvedPercent = hasPercent
      ? Math.max(0, Math.min(100, percent))
      : (hasUsed && hasLimit && limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : null);
    return {
      kind: 'billing',
      label: 'Token Plan',
      used: hasUsed ? used : null,
      limit: hasLimit ? limit : null,
      remaining: hasUsed && hasLimit ? Math.max(0, limit - used) : null,
      usedPercent: resolvedPercent,
      remainingPercent: resolvedPercent == null ? null : Math.max(0, Math.min(100, 100 - resolvedPercent)),
      showMeter: true
    };
  }

  function limitMeterNode(color, percent, tone = 1) {
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    const meter = document.createElement('div');
    meter.className = 'limit-meter';
    meter.style.background = colorWithAlpha(color, 0.16);
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
    return item;
  }

  function renderProviderWindows(provider, color) {
    const windows = document.createElement('div');
    windows.className = 'limit-windows';
    if (provider.provider === 'codex') {
      const session = codexCanonicalWindow(provider, 'session');
      const weekly = codexCanonicalWindow(provider, 'weekly');
      const monthly = codexCanonicalWindow(provider, 'billing');
      const additionalWindows = settings()?.showCodexAdditionalLimits === false
        ? []
        : (provider.windows || []).filter((window) => window?.additional === true);
      if (session) {
        const sessionNode = limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95);
        if (!weekly && !monthly) sessionNode.classList.add('limit-window-wide');
        windows.append(sessionNode);
      }
      if (weekly) {
        const weeklyNode = limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68);
        if (!session && !monthly) weeklyNode.classList.add('limit-window-wide');
        windows.append(weeklyNode);
      }
      if (monthly) {
        const monthlyNode = limitWindowNode(providerWindowLabel(provider, monthly), monthly, color, 0.68);
        monthlyNode.classList.add('limit-window-wide');
        windows.append(monthlyNode);
      }
      for (const additional of additionalWindows) {
        const additionalNode = limitWindowNode(
          codexAdditionalWindowLabel(additional, additionalWindows),
          { ...additional, label: '' },
          color,
          0.78
        );
        additionalNode.classList.add('limit-window-wide');
        windows.append(additionalNode);
      }
      const resetNode = codexResetCreditsNode(provider.resetCredits);
      if (resetNode) windows.append(resetNode);
    } else if (provider.provider === 'cursor') {
      windows.classList.add('limit-windows-cursor');
      for (const quotaWindow of provider.windows || []) {
        const text = providerWindowText(provider, quotaWindow);
        const node = limitWindowNode(quotaWindow.label || 'Quota', quotaWindow, color, 0.68, text.value, text.detail);
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
    } else if (provider.provider === 'antigravity') {
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
            groupWindows.append(limitWindowNode(
              entry.windowLabel,
              { ...entry.window, label: entry.windowLabel },
              color,
              opacity
            ));
          }
          groupNode.append(title, groupWindows);
          windows.append(groupNode);
        }
      } else {
        const weeklyWindows = windowsForKind(provider, 'weekly');
        const visibleWindows = weeklyWindows.length > 0 ? weeklyWindows : [null];
        for (const quotaWindow of visibleWindows) {
          const node = limitWindowNode(providerWindowLabel(provider, quotaWindow, 'Weekly'), quotaWindow, color, 0.78);
          node.classList.add('limit-window-wide');
          windows.append(node);
        }
      }
    } else if (provider.provider === 'opencode') {
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
      const balanceWindow = (provider.windows || []).find((window) => isCreditsWindow(window)) || null;
      const monthly = (provider.windows || [])
        .find((window) => window.kind === 'billing' && window !== balanceWindow) || null;
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
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
    } else if (provider.provider === 'openrouter') {
      windows.classList.add('limit-windows-openrouter');
      const balance = provider.balance || null;
      const currency = balance?.currency || 'USD';
      const balanceAmount = optionalFiniteNumber(balance?.amount);
      const creditsWindow = openrouterCreditsWindow(provider);
      if (balanceAmount !== null) {
        const balanceWindow = creditsWindow || (balanceAmount === 0
          ? { usedPercent: 100, remainingPercent: 0, showMeter: true }
          : { showMeter: false });
        const balanceNode = limitWindowNode(
          'Balance',
          { ...balanceWindow, label: 'Balance' },
          color,
          0.95,
          formatMoney(balanceAmount, currency)
        );
        balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(balanceNode);
      }
      for (const quotaWindow of (provider.windows || []).filter((window) => window !== creditsWindow)) {
        const hasMeter = quotaWindow?.showMeter !== false;
        const remaining = optionalFiniteNumber(quotaWindow?.remaining);
        const limit = optionalFiniteNumber(quotaWindow?.limit);
        const absoluteDetail = hasMeter && remaining !== null && limit !== null
          ? `${formatMoney(remaining, 'USD')} left · ${formatMoney(limit, 'USD')} total`
          : '';
        const valueOverride = hasMeter ? null : (quotaWindow?.detail || '—');
        const node = limitWindowNode(
          quotaWindow?.label || 'Usage',
          quotaWindow,
          color,
          hasMeter ? 0.85 : 0.6,
          valueOverride,
          absoluteDetail
        );
        node.classList.add('limit-window-wide');
        if (!hasMeter) node.classList.add('limit-window-no-reset');
        windows.append(node);
      }
      const spendNode = providerSpendNode(balance);
      if (spendNode) windows.append(spendNode);
    } else if (provider.provider === 'thirdparty') {
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
        balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(balanceNode);
      }
      const spendNode = thirdPartySpendNode(provider, quotaWindow);
      if (spendNode) windows.append(spendNode);
    } else if (provider.provider === 'deepseek' || provider.provider === 'typesafe') {
      // DeepSeek does not expose a fixed quota denominator. This intentionally
      // visualizes the balance relative to this month's inferred starting funds:
      // current / (current + observed month spend).
      windows.classList.add('limit-windows-deepseek');
      const balance = provider.balance || null;
      if (balance) {
        const currency = balance.currency;
        const creditsWindow = (provider.windows || []).find((window) => isCreditsWindow(window));
        const nextGrant = provider.provider === 'typesafe' && Array.isArray(balance.tranches)
          ? balance.tranches.find((grant) => grant.expiresAt && Date.parse(grant.expiresAt) > Date.now())
          : null;
        const boundaryAt = provider.provider === 'typesafe' ? nextGrant?.expiresAt : creditsWindow?.resetsAt;
        const expiringAmount = nextGrant && Math.abs(nextGrant.amount - balance.amount) >= 0.005
          ? formatMoney(nextGrant.amount, nextGrant.currency || currency)
          : '';
        const balanceNode = limitWindowNode(
          'Balance',
          { remainingPercent: creditsMeterPercent(provider, creditsWindow),
            resetsAt: boundaryAt, boundaryKind: creditsWindow?.boundaryKind },
          color,
          0.95,
          formatMoney(balance.amount, currency),
          expiringAmount
        );
        balanceNode.classList.add('limit-window-wide');
        if (!boundaryAt) balanceNode.classList.add('limit-window-no-reset');
        windows.append(balanceNode);

        const spendNode = providerSpendNode(balance, provider);
        if (spendNode) windows.append(spendNode);
      }
    } else if (provider.provider === 'mimo') {
      windows.classList.add('limit-windows-mimo');
      // A Desktop membership answers with a single weekly window and no balance.
      // The arms below draw a Token Plan and a balance only, so without one of
      // its own the membership row would render empty. It takes the full width
      // for the reason Grok's single Monthly does.
      const weekly = windowForKind(provider, 'weekly');
      if (weekly) {
        const node = limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68);
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
      const balance = provider.balance || null;
      // A balance is money and carries no percentage, so it is never the plan:
      // reading it as one draws a plan row at 0% beside the balance row that
      // shows the same money. The provider marks it `metric: 'credits'`, and this
      // is the branch that has to honour that mark.
      const tokenPlan = windowsForKind(provider, 'billing').find((window) => window.metric !== 'credits')
        || mimoTokenPlanWindowFromBalance(balance);
      if (tokenPlan) {
        const node = limitWindowNode(tokenPlan.label || 'Token Plan', tokenPlan, color, 0.68);
        node.classList.add('limit-window-wide');
        windows.append(node);
      } else if (balance?.planStatus === 'expired') {
        const node = limitWindowNode('Token Plan', { showMeter: false }, color, 0.68, t('limits.mimo.planExpired'));
        node.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(node);
      }
      const creditsWindow = (provider.windows || []).find(isCreditsWindow) || null;
      const amount = creditsAmount(provider, creditsWindow);
      const currency = creditsCurrency(provider, creditsWindow);
      const giftBalance = optionalFiniteNumber(balance?.giftBalance);
      const cashBalance = optionalFiniteNumber(balance?.cashBalance);
      if (amount !== null || giftBalance !== null || cashBalance !== null) {
        const detailParts = [];
        if (giftBalance !== null) detailParts.push(`Gift ${formatMoney(giftBalance, currency)}`);
        if (cashBalance !== null) detailParts.push(`Cash ${formatMoney(cashBalance, currency)}`);
        const balanceText = formatMoney(amount, currency) || '—';
        // A wallet is money and carries no percentage of its own, so its meter is
        // derived here from the console's reported month spend (`amount /
        // (amount + monthSpend)`) — the display-only rule deepseek's and
        // openrouter's balances follow, never a wire value.
        const balanceNode = limitWindowNode(
          'Balance',
          { remainingPercent: creditsMeterPercent(provider, creditsWindow) },
          color,
          0.68,
          balanceText,
          detailParts.join(' · ')
        );
        balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(balanceNode);
        const spendNode = providerSpendNode(balance);
        if (spendNode) windows.append(spendNode);
      }
    } else if (provider.provider === 'grok') {
      // Grok exposes a single Monthly billing window (no session/weekly). Render it
      // full-width so it doesn't share a row with an empty placeholder. This mirrors
      // how Cursor's billing cycle and OpenCode's Monthly are handled.
      windows.classList.add('limit-windows-grok');
      const monthly = windowForKind(provider, 'billing');
      if (monthly) {
        const node = limitWindowNode(providerWindowLabel(provider, monthly), monthly, color, 0.68);
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
    } else if (provider.provider === 'copilot') {
      windows.classList.add('limit-windows-copilot');
      const billingWindows = windowsForKind(provider, 'billing');
      for (const billing of billingWindows) {
        const node = limitWindowNode(providerWindowLabel(provider, billing), billing, color, 0.68);
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
    } else if (provider.provider === 'zed') {
      windows.classList.add('limit-windows-zed');
      for (const billing of windowsForKind(provider, 'billing')) {
        const unlimitedEditPredictions = billing?.limitId === 'zed.edit-predictions'
          && String(billing?.detail || '').trim().toLowerCase() === 'unlimited';
        const node = limitWindowNode(
          billing?.label || 'Token Spend',
          billing,
          color,
          0.95,
          null,
          providerWindowText(provider, billing).detail
        );
        node.classList.add('limit-window-wide');
        if (unlimitedEditPredictions) node.classList.add('limit-window-no-reset');
        windows.append(node);
      }
    } else if (provider.provider === 'zai' || provider.provider === 'zaiteam') {
      // Billing-kind windows are one of three things: the subscription MCP
      // monthly bucket (no metric, no limitId), ZCode Start/Weekend plan
      // buckets (limitId set, per-model labels), or the cash balance
      // (metric 'credits'). Each renders in its own slot below.
      const session = windowForKind(provider, 'session');
      const weekly = windowForKind(provider, 'weekly');
      const billingWindows = windowsForKind(provider, 'billing');
      const dailyWindows = windowsForKind(provider, 'daily');
      const planBuckets = billingWindows.filter((window) => window?.limitId && !window?.metric);
      const monthlyWindows = billingWindows.filter((window) => !window?.metric && !window?.limitId);
      const balanceWindow = (provider.windows || []).find((window) => window?.metric === 'credits');
      const nodes = [
        session && limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95),
        ...dailyWindows.map((window, index) => limitWindowNode(
          window.label || (dailyWindows.length > 1 ? `Daily ${index + 1}` : 'Daily'),
          window,
          color,
          0.78,
          null,
          providerWindowText(provider, window).detail
        )),
        weekly && limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68),
        ...planBuckets.map((window) => limitWindowNode(
          window.label || 'Start Plan',
          window,
          color,
          0.68,
          null,
          providerWindowText(provider, window).detail
        ))
      ].filter(Boolean);
      if (nodes.length % 2 === 1) nodes.at(-1).classList.add('limit-window-wide');
      windows.append(...nodes);
      // Monthly subscription buckets stay full width, independent of the
      // paired quota count. Preserve all legacy billing windows without ids.
      for (const monthly of monthlyWindows) {
        const node = limitWindowNode(monthly.label || 'MCP', monthly, color, 0.68, null, monthly.detail || '');
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
      // Balance sits at the bottom on its own full-width row: coding-plan quota
      // is consumed before the cash pool, so the money line reads as the last
      // resort.
      if (balanceWindow) {
        const balanceNode = limitWindowNode(
          'Balance',
          { remainingPercent: creditsMeterPercent(provider, balanceWindow) },
          color,
          0.95,
          formatMoney(balanceWindow.remaining, balanceWindow.currency)
        );
        balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(balanceNode);
        const spendNode = provider.balance && providerSpendNode(provider.balance);
        if (spendNode) windows.append(spendNode);
      }
    } else if (provider.provider === 'volcengine') {
      const session = windowForKind(provider, 'session');
      const daily = windowForKind(provider, 'daily');
      const weekly = windowForKind(provider, 'weekly');
      const monthly = windowForKind(provider, 'billing');
      const nodes = [
        session && limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95),
        daily && limitWindowNode(providerWindowLabel(provider, daily), daily, color, 0.78),
        weekly && limitWindowNode('Weekly', weekly, color, 0.68),
        monthly && limitWindowNode(providerWindowLabel(provider, monthly), monthly, color, 0.68)
      ].filter(Boolean);
      if (nodes.length % 2 === 1) nodes.at(-1).classList.add('limit-window-wide');
      windows.append(...nodes);
    } else if (provider.provider === 'devin') {
      const daily = windowForKind(provider, 'daily');
      const weekly = windowForKind(provider, 'weekly');
      const balanceWindow = (provider.windows || []).find(isCreditsWindow) || null;
      const quotaNodes = [
        daily && limitWindowNode(providerWindowLabel(provider, daily), daily, color, 0.95),
        weekly && limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68)
      ].filter(Boolean);
      if (quotaNodes.length === 1) quotaNodes[0].classList.add('limit-window-wide');
      windows.append(...quotaNodes);
      if (balanceWindow) {
        const amount = creditsAmount(provider, balanceWindow);
        if (amount !== null) {
          const balanceNode = limitWindowNode(
            providerWindowLabel(provider, balanceWindow, 'Extra usage balance'),
            { ...balanceWindow, showMeter: false },
            color,
            0.68,
            formatMoney(amount, balanceWindow.currency || provider.balance?.currency)
          );
          balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
          windows.append(balanceNode);
        }
      }
    } else if (provider.provider === 'kiro') {
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
    } else if (provider.provider === 'qoder') {
      windows.classList.add('limit-windows-qoder');
      const credits = windowForKind(provider, 'billing');
      if (credits) {
        const node = limitWindowNode(
          credits?.label || 'Credits',
          credits,
          color,
          0.68,
          null,
          providerWindowText(provider, credits).detail
        );
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
    } else if (provider.provider === 'workbuddy' || provider.provider === 'trae') {
      const credits = windowForKind(provider, 'billing');
      const balance = provider.balance || null;
      const value = creditsBalanceValue(provider, credits);
      if (credits && value) {
        const displayWindow = {
          ...credits,
          label: credits.label || 'Credits'
        };
        const node = limitWindowNode(
          displayWindow.label,
          displayWindow,
          color,
          0.95,
          value
        );
        node.classList.add('limit-window-wide');
        if (!displayWindow.resetsAt && !displayWindow.resetDescription) {
          node.classList.add('limit-window-no-reset');
        }
        windows.append(node);
        const spendNode = providerSpendNode(balance);
        if (spendNode) windows.append(spendNode);
      }
    } else if (provider.provider === 'commandcode') {
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
    } else if (provider.provider === 'kimi') {
      const fiveHour = windowForKind(provider, 'session');
      const weekly = windowForKind(provider, 'weekly');
      const monthly = windowForKind(provider, 'billing');
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
      if (monthly) {
        const node = limitWindowNode(
          providerWindowLabel(provider, monthly),
          monthly,
          color,
          0.5,
          null,
          providerWindowText(provider, monthly).detail
        );
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
    } else if (provider.provider === 'alibaba') {
      // Team returns one credit pool; Personal/Solo returns rolling 5-hour and
      // weekly windows. Both are the same provider, so the shape decides the
      // layout rather than the configured variant — a device syncing another
      // machine's row has no access to that setting.
      const billing = windowForKind(provider, 'billing');
      const session = windowForKind(provider, 'session');
      const weekly = windowForKind(provider, 'weekly');
      if (billing) {
        const node = limitWindowNode(providerWindowLabel(provider, billing), billing, color, 0.68);
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
      if (session) {
        const node = limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95);
        if (!weekly) node.classList.add('limit-window-wide');
        windows.append(node);
      }
      if (weekly) windows.append(limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68));
    } else if (provider.provider === 'ollama') {
      const session = windowForKind(provider, 'session');
      const weekly = windowForKind(provider, 'weekly');
      if (session) {
        const node = limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95);
        if (!weekly) node.classList.add('limit-window-wide');
        windows.append(node);
      }
      if (weekly) windows.append(limitWindowNode('Weekly', weekly, color, 0.68));
    } else if (provider.provider === 'claude') {
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
        const node = limitWindowNode(
          'Usage credits',
          usageCredits,
          color,
          0.5,
          providerWindowText(provider, usageCredits).value
        );
        node.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(node);
      }
      const balanceNode = claudeBalanceNode(provider);
      if (balanceNode) windows.append(balanceNode);
      // Usage-limit reset grants (Anthropic's "reset coupon") share Codex's
      // compact line; the ⓘ tooltip carries each grant's label and coverage.
      const resetNode = claudeResetCreditsNode(provider.resetCredits);
      if (resetNode) windows.append(resetNode);
    } else if (provider.provider === 'cline') {
      // ClinePass measures three quota windows, and the account's credit arrives as
      // a fourth "billing" window — told apart by its metric rather than by its
      // kind, and rendered the way WorkBuddy's and Trae's balance is. The default
      // branch below renders session and weekly only, which would silently drop a
      // third of the subscription.
      const clineSession = windowForKind(provider, 'session');
      const clineWeekly = windowForKind(provider, 'weekly');
      const clineBilling = windowsForKind(provider, 'billing');
      const clineMonthly = clineBilling.find((window) => !isCreditsWindow(window) && window.metric !== 'spend') || null;
      const clineCredits = clineBilling.find((window) => isCreditsWindow(window)) || null;
      const clineSpend = clineBilling.find((window) => window.metric === 'spend') || null;
      if (clineSession) {
        windows.append(limitWindowNode(providerWindowLabel(provider, clineSession), clineSession, color, 0.95));
      }
      if (clineWeekly) {
        windows.append(limitWindowNode(providerWindowLabel(provider, clineWeekly), clineWeekly, color, 0.68));
      }
      if (clineMonthly) {
        const node = limitWindowNode(providerWindowLabel(provider, clineMonthly), clineMonthly, color, 0.5);
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
      if (clineCredits) {
        const node = clineCreditsNode(provider, clineCredits, clineSpend);
        if (node) windows.append(node);
      }
    } else {
      // Default: render only the windows the provider actually has. Providers
      // that only expose a single window shouldn't leave a half-empty bar next to
      // the real one. (Grok is handled above; this branch covers minimax's
      // session + weekly pair and any future session/weekly provider.)
      const session = windowForKind(provider, 'session');
      const weekly = windowForKind(provider, 'weekly');
      if (session) windows.append(limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95));
      if (weekly) windows.append(limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68));
    }
    return windows;
  }

  // Every limits surface (the limits panel and the Home cards) resolves account
  // titles here. One table keeps a provider from masking its email on one surface
  // while leaking it on the other, and from rendering two different titles for the
  // same account. Providers identified by email need no entry — the default below
  // already masks them.
  const LIMIT_ACCOUNT_TITLES = {
    codex: codexAccountTitle,
    opencode: opencodeAccountTitle,
    openrouter: (provider, index) => namedApiAccountTitle(provider, index, 'openrouter'),
    thirdparty: (provider, index) => namedApiAccountTitle(provider, index, 'thirdparty'),
    volcengine: (provider, index, providers) => planAccountTitle(provider, index, providers),
    mimo: (provider, index, providers) => mimoAccountTitle(provider, index, providers)
  };

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

  function providerStatusLabel(provider) {
    if (provider?.provider === 'mimo' && provider?.sourceDetail === 'app' && provider?.status === 'unauthorized') {
      return t('settings.mimo.desktopRelogin');
    }
    if (provider?.provider === 'mimo' && provider?.sourceDetail === 'managed' && provider?.status === 'unauthorized') {
      return t('settings.mimo.repasteCookie');
    }
    return limitStatusLabel(provider?.status);
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
    return providerStatusLabel(provider);
  }

  function limitProviderPlan(provider) {
    if (provider?.status && provider.status !== 'ok' && !provider.stale) return providerStatusLabel(provider);
    const mimoProduct = provider?.provider === 'mimo' ? mimoProductLabel(provider) : '';
    if (mimoProduct) {
      const plan = String(provider?.planLabel || '').trim();
      if (isMimoMembershipProduct(provider)
        && provider?.status === 'ok'
        && !plan && !provider?.windows?.length) return t('limits.mimo.noPlan');
      // Current MiMo rows keep the product in accountLabel and the plan in
      // planLabel. Falling back to accountLabel would repeat the product in the
      // plan cell when the app deliberately has no plan name. Legacy rows take
      // the generic path below.
      return plan ? presentationApi.limitProviderPlanDisplayLabel(provider, plan) : '';
    }
    const label = String(provider?.planLabel || provider?.accountLabel || '').trim();
    if (label) return presentationApi.limitProviderPlanDisplayLabel(provider, label);
    return provider?.status && provider.status !== 'ok' ? providerStatusLabel(provider) : '';
  }

  function renderLimitProviderMark(id, color) {
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

  function renderLimitProviderHead(id, label, provider, color, options = {}) {
    const head = document.createElement('div');
    head.className = 'limit-head';
    const titleBlock = document.createElement('div');
    titleBlock.className = 'limit-title';
    const name = document.createElement('div');
    name.className = 'limit-name';
    if (options.showIcon !== false) name.append(renderLimitProviderMark(options.markId || id, color));
    const title = document.createElement('span');
    title.className = 'limit-name-title';
    title.textContent = options.title || label;
    const provenance = presentationApi.limitProviderProvenance(provider, provenanceContext());
    // The ✓ marks the account THIS device's Codex is signed into
    // (state.codexActiveAccount, derived locally by codexActiveAccountFromStats).
    // It only disambiguates rows in the multi-account group, so it's gated on
    // showActiveBadge. Never re-derive "live" from the row being rendered — in
    // sync mode that row can be a remote device's record for a different account,
    // which would move the ✓ onto the wrong one.
    const activeCodexAccount = options.showActiveBadge && codexAccounts.matchesActive(provider);
    const switchAccount = options.allowSystemSwitch && !activeCodexAccount ? codexAccounts.switchTarget(provider) : null;
    name.append(accountControl.render({
      titleNode: title,
      active: Boolean(activeCodexAccount),
      switchAccount: codexAccounts.canSwitchSystemAccount() ? switchAccount : null,
      // Who the switch would move this device to, named by the caller that knows
      // it (see renderLimitProviderSolo/Group). The control used to read the name
      // off the object switchTarget() resolved, which only the page's managed
      // entries carry — so the same control named the account on one surface and
      // fell back to the unnamed placeholder on the other.
      accountLabel: options.accountLabel || ''
    }));
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
      if (metaText) meta.append(document.createTextNode(metaText));
      titleBlock.append(meta);
    }
    const plan = document.createElement('div');
    plan.className = 'limit-plan';
    plan.textContent = options.planText ?? limitProviderPlan(provider);
    // A record binds to one account, so the provider-wide rollup belongs on the
    // row that stands for the provider as a whole — the header of a group, or a
    // provider's single row — and not on each member of a group, which would
    // repeat the same three lines once per account. Which of those this row is,
    // is what it just told us: an account row inside a group says so, and the
    // group header carries `accountGroup`.
    head.append(titleBlock, decoratePlanWithSubscription(plan, provider, !options.accountRow));
    return head;
  }


  function codexResetForecastDate(value, options = {}) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const locale = options.locale || currentLocale();
    const timeZone = options.timeZone;
    const dayNumber = (input) => {
      const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        ...(timeZone ? { timeZone } : {})
      }).formatToParts(input);
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day));
    };
    const dayDelta = Math.round((dayNumber(date) - dayNumber(new Date(nowMs))) / 86_400_000);
    if (dayDelta >= -1 && dayDelta <= 1) {
      const time = new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit',
        ...(locale.startsWith('zh') ? { hourCycle: 'h23' } : {}),
        ...(timeZone ? { timeZone } : {})
      }).format(date);
      const relativeDay = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(dayDelta, 'day');
      return `${relativeDay} ${time}`;
    }
    return expiryDateLabel(date);
  }

  function codexResetForecastTimeUntil(value, options = {}) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const remainingMs = date.getTime() - nowMs;
    if (remainingMs <= 0) return '';
    const locale = options.locale || currentLocale();
    const hours = remainingMs / 3_600_000;
    const unit = hours >= 48 ? 'day' : (hours >= 1 ? 'hour' : 'minute');
    const divisor = unit === 'day' ? 86_400_000 : (unit === 'hour' ? 3_600_000 : 60_000);
    const amount = Math.max(1, Math.round(remainingMs / divisor));
    const duration = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'long'
    }).format(amount);
    return t('limits.codexResetForecast.approximately', { duration });
  }

  function codexResetForecastAge(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    return formatAgo(Math.max(0, Date.now() - date.getTime()));
  }

  function codexResetForecastSourceAuthor(value) {
    const author = String(value || '').trim().replace(/^@+/, '');
    return author ? `@${author}` : '';
  }

  function codexResetForecastPercent(value, locale = currentLocale()) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  }

  function codexResetForecastType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (type !== 'banked' && type !== 'regular') return '';
    return t(`limits.codexResetForecast.resetType.${type}`);
  }

  function codexResetForecastTooltip(forecast) {
    const entries = [];
    const disclaimer = t('limits.codexResetForecast.disclaimer');
    const resetType = codexResetForecastType(
      forecast?.status === 'scheduled' ? forecast?.scheduledResetType : forecast?.latestResetType
    );
    if (resetType) {
      entries.push([t('limits.codexResetForecast.resetType'), resetType]);
    }
    const scheduledFor = codexResetForecastDate(forecast?.scheduledFor);
    const scheduledIn = codexResetForecastTimeUntil(forecast?.scheduledFor);
    if (scheduledFor) {
      entries.push([
        t('limits.codexResetForecast.scheduledFor'),
        [scheduledFor, scheduledIn].filter(Boolean).join(' · ')
      ]);
    }
    const latestReset = codexResetForecastDate(forecast?.latestResetAt);
    if (latestReset) {
      const age = codexResetForecastAge(forecast.latestResetAt);
      entries.push([t('limits.codexResetForecast.lastReset'), [latestReset, age].filter(Boolean).join(' · ')]);
    }
    const sourceObservedAt = forecast?.status === 'scheduled'
      ? forecast?.scheduledAnnouncedAt
      : forecast?.observedAt;
    const source = [
      codexResetForecastSourceAuthor(forecast?.sourceAuthor),
      codexResetForecastAge(sourceObservedAt)
    ].filter(Boolean).join(' · ');
    if (source) {
      const sourceLabel = forecast?.status === 'scheduled'
        ? 'limits.codexResetForecast.sourceAnnouncement'
        : 'limits.codexResetForecast.sourceSignal';
      entries.push([t(sourceLabel), source]);
    }
    const expiresAt = codexResetForecastDate(forecast?.expiresAt);
    const expiresIn = codexResetForecastTimeUntil(forecast?.expiresAt);
    if (expiresAt) {
      entries.push([
        t('limits.codexResetForecast.expiresLabel'),
        [expiresAt, expiresIn].filter(Boolean).join(' · ')
      ]);
    }
    if (forecast?.error && forecast.errorKind !== 'invalid-response') {
      entries.push([
        t('limits.codexResetForecast.connectionFailed'),
        t('limits.codexResetForecast.connectionHelp')
      ]);
    }
    if (forecast?.error) {
      const lastAttempt = codexResetForecastAge(forecast.checkedAt);
      if (lastAttempt) entries.push([t('limits.codexResetForecast.lastAttempt'), lastAttempt]);
    }
    if (entries.length === 0) return null;
    const info = limitDetailInfoNode(
      entries,
      'codex-reset-forecast-info-wrap',
      [...entries.map(([label, value]) => `${label}: ${value}`), disclaimer].join(', ')
    );
    const tooltip = info.querySelector('.limit-detail-tooltip');
    if (tooltip) {
      const footer = document.createElement('span');
      footer.className = 'codex-reset-forecast-disclaimer';
      footer.textContent = disclaimer;
      tooltip.append(footer);
    }
    return info;
  }

  function renderCodexResetForecast() {
    if (settings()?.codexResetForecastEnabled !== true) return null;
    const forecast = resetForecast().forecast;
    const expired = codexResetForecastExpired(forecast);
    const item = document.createElement('div');
    item.className = 'codex-reset-forecast';
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'codex-reset-forecast-open';
    openButton.addEventListener('click', () => openExternal('https://codex-resets.com/'));

    const head = document.createElement('span');
    head.className = 'codex-reset-forecast-head';
    const title = document.createElement('span');
    title.className = 'codex-reset-forecast-title';
    const label = document.createElement('span');
    label.className = 'codex-reset-forecast-label';
    label.textContent = t('limits.codexResetForecast.title');
    title.append(label);
    const forecastInfo = codexResetForecastTooltip(forecast);
    if (forecastInfo) title.append(forecastInfo);
    const value = document.createElement('span');
    value.className = 'codex-reset-forecast-value';

    const detail = document.createElement('span');
    detail.className = 'codex-reset-forecast-detail';
    if (resetForecast().busy && !forecast) {
      item.classList.add('is-loading');
      value.textContent = t('limits.codexResetForecast.loading');
    } else if (forecast?.status === 'scheduled') {
      value.textContent = t('limits.codexResetForecast.scheduled');
      const scheduledFor = codexResetForecastDate(forecast.scheduledFor);
      const scheduledIn = codexResetForecastTimeUntil(forecast.scheduledFor);
      detail.textContent = [
        scheduledFor
          ? t('limits.codexResetForecast.expected', {
              date: [scheduledFor, scheduledIn].filter(Boolean).join(' · ')
            })
          : t('limits.codexResetForecast.schedulePending'),
        forecast.stale ? t('limits.codexResetForecast.stale') : ''
      ].filter(Boolean).join(' · ');
    } else if (forecast?.status === 'active' && !expired) {
      const chance = forecast.chancePercent;
      value.textContent = Number.isFinite(chance)
        ? t('limits.codexResetForecast.chance', { percent: codexResetForecastPercent(chance) })
        : t('limits.codexResetForecast.signal');
      const predictedAt = codexResetForecastDate(forecast.predictedAt);
      const expiresAt = codexResetForecastDate(forecast.expiresAt);
      detail.textContent = [
        predictedAt
          ? t('limits.codexResetForecast.expected', { date: predictedAt })
          : (expiresAt || ''),
        forecast.stale ? t('limits.codexResetForecast.stale') : ''
      ].filter(Boolean).join(' · ');
    } else if (forecast?.status === 'inactive' || expired) {
      value.textContent = t('limits.codexResetForecast.noSignal');
      detail.textContent = forecast.stale ? t('limits.codexResetForecast.stale') : '';
    } else {
      item.classList.add('is-unavailable');
      value.textContent = forecast?.error && forecast.errorKind !== 'invalid-response'
        ? t('limits.codexResetForecast.connectionFailed')
        : t('limits.codexResetForecast.unavailable');
    }

    head.append(title, value);
    item.append(openButton, head, detail);
    openButton.title = t('limits.codexResetForecast.openSource');
    openButton.setAttribute('aria-label', [label.textContent, value.textContent, detail.textContent, t('limits.codexResetForecast.openSource')].filter(Boolean).join(', '));
    return item;
  }

  function appendCodexResetForecast(parent) {
    const node = renderCodexResetForecast();
    if (node) parent.append(node);
  }

  function codexResetForecastExpired(forecast, nowMs = Date.now()) {
    if (forecast?.status !== 'active') return false;
    const expiresAtMs = Date.parse(forecast.expiresAt || '');
    return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
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
    if (id === 'codex' && !options.accountRow) appendCodexResetForecast(row);
    return row;
  }

  // How each provider's accounts are drawn, read by every surface that draws
  // them. The Limits page and the dock card are two callers of one builder, and
  // every option a caller had to remember to pass was a way for the two to drift
  // apart — the card passed none, so a third-party group wore the generic mark
  // with no adapter name on its rows, and a Codex group lost the switch
  // affordance and the reset forecast below it. Which mark, which colour and
  // which plan text a provider's accounts take is a fact about the provider, not
  // about the surface, so it lives with the builder that paints them.
  //
  // Each entry returns `{ color?, options }` for one account row. `grouped` is
  // the one thing the surface decides: inside a group the header already names
  // the provider and the ✓ badge is what separates one row from another;
  // standing alone, the row keeps its own mark and has nothing to be told apart
  // from.
  //
  // Every rule that takes something away is therefore gated on `grouped`. Drop
  // the mark unconditionally and the provider loses it in both shapes, which is
  // exactly what a policy that reads as if it were about the account did: a solo
  // Claude row is the card's whole identity and it came back to the page with no
  // mark at all. The same holds for a rule that replaces the plan cell — a group
  // row has a sibling to be told apart from, a solo row's plan cell is its own.
  const LIMIT_ACCOUNT_ROW_POLICIES = {
    codex: (provider, color, { grouped }) => ({
      options: {
        accountTitle: true,
        allowSystemSwitch: true,
        ...(grouped ? { showActiveBadge: true, showIcon: false } : {})
      }
    }),
    claude: (provider, color, { grouped }) => ({
      options: { accountTitle: true, ...(grouped ? { showIcon: false } : {}) }
    }),
    mimo: (provider, color, { grouped }) => ({
      options: {
        accountTitle: true,
        ...(grouped ? { showIcon: false } : {})
      }
    }),
    cursor: (provider, color, { grouped }) => ({
      options: { accountTitle: true, ...(grouped ? { showIcon: false } : {}) }
    }),
    opencode: (provider, color, { grouped }) => ({
      options: {
        // A profile name that is neither Go nor Zen predates accountName, and it
        // is the only label the row has — repeating it in the plan cell says
        // nothing. Only a group row has a sibling whose plan cell it could be
        // mistaken for.
        ...(grouped && legacyOpencodeProfileLabel(provider) ? { planText: '' } : {}),
        ...(grouped ? { showIcon: false } : {})
      }
    }),
    // The Coding Plan and the Agent Plan are two subscriptions on one Volcengine
    // account, so they are rows of one card rather than two provider cards. The
    // title carries the plan, so the cell stays empty while the account is
    // healthy and hands back over to the status label once it is not.
    volcengine: (provider, color, { grouped }) => ({
      options: grouped ? { planText: provider?.status === 'ok' ? '' : undefined, showIcon: false } : {}
    }),
    // One login per row, under a header that already wears the mark, so a row
    // only repeats it. Standing alone the row has nothing else to be recognised
    // by and keeps its own.
    openrouter: (provider, color, { grouped }) => ({
      options: grouped ? { showIcon: false } : {}
    }),
    antigravity: (provider, color, { grouped }) => ({
      options: grouped ? { showIcon: false } : {}
    }),
    thirdparty: (provider, color, { grouped, sharedFamily }) => {
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
          ...(perRowMark ? { markId: visual.markId } : { showIcon: false })
        }
      };
    }
  };

  // The part only a multi-account group needs: the mark its header wears, and the
  // adapter family its rows share (null when they differ).
  const LIMIT_GROUP_POLICIES = {
    thirdparty: (providers) => {
      const family = presentationApi.thirdPartySharedAdapterFamily(providers);
      return { markId: family || 'thirdparty', sharedFamily: family };
    },
    // A Codex group's forecast describes the account set, not one account, so it
    // is appended once below the rows instead of on each of them.
    codex: () => ({ forecastOnGroup: true })
  };

  function limitAccountRowPolicy(id, provider, color, context) {
    const policy = LIMIT_ACCOUNT_ROW_POLICIES[String(id || '').trim().toLowerCase()];
    const resolved = policy ? policy(provider, color, context) : {};
    return { color: resolved.color || color, options: resolved.options || {} };
  }

  // A provider's row standing on its own. Both surfaces call this rather than
  // renderLimitProviderRow, so the policy cannot be skipped by a caller that did
  // not know there was one to pass.
  function renderLimitProviderSolo(id, label, provider, color) {
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

  // Before accountName existed, an OpenCode account's profile name was stored as
  // its accountLabel. Go and Zen are plan names, not profiles, so anything else
  // in that field is a user label the row's title already shows.
  function legacyOpencodeProfileLabel(provider) {
    const label = String(provider?.accountLabel || '').trim();
    return !String(provider?.accountName || '').trim()
      && Boolean(label)
      && label !== 'Go'
      && label !== 'Zen';
  }

  function limitAccountDefaultTitle(provider, index, providerEntries = [provider]) {
    return accountIdentity.accountTitleLabel(provider, providerEntries, {
      maskEmail: limitAccountEmailsMasked(),
      index
    }) || `Account ${index + 1}`;
  }

  function codexAccountTitle(provider, index, providers = [provider]) {
    const label = accountIdentity.codexAccountDisplayLabel(provider, providers, {
      maskEmail: limitAccountEmailsMasked(),
      index,
      // Limits presents raw account data such as email and Plus/Pro labels, so
      // keep the provider's canonical English workspace name on this surface.
      personalWorkspaceLabel: 'Personal'
    });
    if (label) return label;
    // Never fall back to the plan label here — "Plus" as a title reads like an
    // account name. The plan still shows on the right via limitProviderPlan().
    return `Account ${index + 1}`;
  }

  function opencodeAccountTitle(provider, index) {
    const name = String(provider?.accountName || '').trim();
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

  function namedApiAccountTitle(provider, index, providerId) {
    const accountName = String(provider?.accountName || provider?.accountLabel || '').trim();
    if (accountName.toLowerCase() === 'environment') return t(`settings.${providerId}.environment`);
    return accountName || `Account ${index + 1}`;
  }

  // Volcengine carries the plan in accountLabel; without it, both rows would
  // be named "Account N".
  function planAccountTitle(provider, index, providers) {
    return String(provider?.accountLabel || '').trim() || limitAccountDefaultTitle(provider, index, providers);
  }

  function mimoAccountTitle(provider, index, providers) {
    const product = mimoProductLabel(provider);
    if (product) {
      const identity = accountIdentity.accountEmailLabel(provider, providers || [provider], {
        maskEmail: limitAccountEmailsMasked(),
        suffix: String(provider?.accountName || '').trim()
      }) || String(provider?.accountName || '').trim();
      return [identity, product].filter(Boolean).join(' · ') || `Account ${index + 1}`;
    }
    // Compatibility for rows from versions that put the product in accountName
    // and the plan in accountLabel.
    const peers = (providers || [provider]).map((row) => ({
      ...row,
      accountName: String(row?.accountName || row?.accountLabel || '').trim()
    }));
    return accountIdentity.accountTitleLabel(peers[index], peers, {
      maskEmail: limitAccountEmailsMasked(),
      index
    }) || `Account ${index + 1}`;
  }

  function limitAccountTitle(id, provider, index, providerEntries = [provider]) {
    const resolve = LIMIT_ACCOUNT_TITLES[String(id || '').trim().toLowerCase()];
    return resolve
      ? resolve(provider, index, providerEntries)
      : limitAccountDefaultTitle(provider, index, providerEntries);
  }

  // Volcengine's two rows are one account's two subscriptions, and MiMo's are
  // the platform console and the Desktop membership of one account, so both
  // headers count plans; every other group counts accounts.
  const GROUP_COUNT_KEYS = {
    volcengine: 'settings.volcengine.nPlans',
    mimo: 'settings.mimo.nProducts'
  };

  // "4 accounts" on the group header. A caller that has a better phrase passes
  // one; leaving it to the caller is what let the dock card render a group with
  // no count at all while the page showed one.
  function limitGroupCountText(providerId, count) {
    const key = GROUP_COUNT_KEYS[providerId] || `settings.${providerId}.nAccounts`;
    const text = t(key, { count });
    // A provider with no key of its own would otherwise print the key itself.
    return text === key ? '' : text;
  }

  // A provider's several accounts, as the page's group header plus one row each.
  // No options: what the header wears and what each row says is the provider's
  // policy above, so a second surface cannot render the same group differently by
  // passing a different set.
  function renderLimitProviderGroup(providerId, label, providers, color) {
    const policy = LIMIT_GROUP_POLICIES[providerId] || (() => ({}));
    const { markId, sharedFamily, forecastOnGroup } = policy(providers);
    const row = document.createElement('div');
    row.className = `limit-row limit-row-group${providers.some((provider) => provider.stale) ? ' stale' : ''}`;
    // `groupAccounts` is the accounts this header stands for. The head is drawn
    // from a synthetic record, so without it a subscription resolved against the
    // wider universe could summarise an account the row does not draw — the
    // card's composer can hide one from the group it is still part of.
    const groupProvider = {
      provider: providerId,
      status: 'ok',
      windows: [],
      accountGroup: true,
      groupAccounts: providers
    };
    const head = renderLimitProviderHead(providerId, label, groupProvider, color, {
      planText: limitGroupCountText(providerId, providers.length),
      hideMeta: true,
      ...(markId ? { markId } : {})
    });
    const accountList = document.createElement('div');
    accountList.className = 'limit-account-list';
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
    row.append(head, accountList);
    if (forecastOnGroup) appendCodexResetForecast(row);
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
      if (row.title) {
        label.title = row.title;
        value.title = row.title;
      }
      line.append(label, value);
      card.append(line);
    }
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

  // Wraps the plan label so hovering it reveals the subscription card. Reuses the
  // limit-detail tooltip plumbing, which already holds off the list re-render
  // while the pointer is inside.
  //
  // Deliberately not behind a preference: an account with no record decorates
  // nothing, so having recorded one IS the switch. A separate toggle only made it
  // possible to enter the data and see nothing happen.
  function decoratePlanWithSubscription(plan, provider, includeRollup) {
    const card = subscriptionCardForRow(provider, includeRollup);
    if (!card) return plan;

    const wrap = document.createElement('div');
    wrap.className = 'limit-plan limit-detail-tooltip-wrap subscription-plan-wrap';
    wrap.classList.toggle('has-opened', tooltipHost.hasOpened());
    wrap.tabIndex = 0;
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
    antigravityQuotaGroups,
    attachLimitDetailTooltip,
    codexResetForecastExpired,
    limitAccountTitle,
    limitProviderMeta,
    limitProviderPlan,
    limitStatusLabel,
    renderLimitProviderGroup,
    renderLimitProviderHead,
    renderLimitProviderMark,
    renderLimitProviderRow,
    renderLimitProviderSolo,
    claudeBalanceNode,
    codexAdditionalWindowLabel,
    codexResetCreditsNode,
    creditsBalanceValue,
    expiryDateLabel,
    formatLimitAmount,
    formatLimitWindowValue,
    limitDetailInfoNode,
    limitMeterNode,
    limitNoteRowNode,
    limitWindowNode,
    mimoTokenPlanWindowFromBalance,
    openrouterCreditsWindow,
    providerSpendNode,
    providerWindowLabel,
    providerWindowText,
    renderProviderWindows,
    thirdPartyQuotaWindow,
    thirdPartySpendNode,
    windowForKind,
    windowsForKind
  };
  }

  return { createLimitWindowsView };
});
