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
//   balance                            limitBalanceDisplay
//   windowLabels, windowText           the shared wording modules
//   format*, limitFillPercent, …       the page's own number formatting
//   tooltip                            { hasOpened(), markOpened(), release() },
//                                      the host's render-hold bookkeeping
(function exposeLimitWindowsView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitWindowsView = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLimitWindowsViewApi() {
  function createLimitWindowsView(deps) {
    const {
      t,
      settings,
      currentLocale,
      presentation: presentationApi,
      motion,
      tooltip: tooltipHost,
      formatCompact,
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
      creditsMeterPercent,
      isCreditsWindow,
      spendWindow,
      limitWindowLabel,
      limitWindowText
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

  function codexResetCreditsNode(resetCredits) {
    const valueText = formatCodexResetCreditsValue(resetCredits);
    if (!valueText) return null;
    const expirationDates = codexResetCreditExpirationDates(resetCredits);
    const item = document.createElement('div');
    item.className = 'limit-window limit-window-wide limit-window-note limit-reset-credits';
    const line = document.createElement('div');
    line.className = 'limit-reset-credits-line';
    const value = document.createElement('span');
    value.className = 'limit-reset-credits-value';
    value.textContent = valueText;
    line.append(value);
    if (expirationDates.length > 0) {
      const expiryGroup = document.createElement('span');
      expiryGroup.className = 'limit-reset-credits-expiry-group';
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
      if (expirationDates.length > 0) {
        // A date paired with a bare duration doesn't read as `<name>: <value>`, so
        // the spoken label is supplied rather than derived from the cells. Keep
        // this detail available for a single reset as well as multiple resets.
        const infoNode = limitDetailInfoNode(
          expirationDates.map((date) => [expiryDateLabel(date), codexResetCreditExpiryLabel(date)]),
          '',
          expirationDates.map((date, index) => `Reset ${index + 1}: ${codexResetCreditExpiryDetailLabel(date)}`).join(', ')
        );
        if (infoNode) expiryGroup.append(infoNode);
      }
      line.append(expiryGroup);
    }
    item.append(line);
    item.setAttribute('aria-label', ['Reset credits', valueText, expirationDates.map(codexResetCreditExpiryDetailLabel).join(', ')].filter(Boolean).join(', '));
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

  // Entries are rows of cells: `[label, value]`, or `[label, middle, value]` when
  // a row carries an extra field. Rows are grid cells (`display: contents`), so a
  // short row would slide into the next row's columns — pad every row to the
  // widest one and widen the grid to match. `ariaLabel` overrides the spoken label
  // for callers whose cells don't read as `<name>: <value>` on their own.
  function limitDetailInfoNode(entries, extraClass = '', ariaLabel = '') {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const columns = entries.reduce((widest, entry) => Math.max(widest, entry.length), 0);
    const infoWrap = document.createElement('span');
    infoWrap.className = ['limit-detail-tooltip-wrap', extraClass].filter(Boolean).join(' ');
    infoWrap.classList.toggle('has-opened', tooltipHost.hasOpened());
    const info = document.createElement('span');
    info.className = 'limit-detail-tooltip-trigger';
    info.textContent = 'i';
    info.tabIndex = 0;
    info.setAttribute(
      'aria-label',
      ariaLabel || entries.map(([entryLabel, ...rest]) => `${entryLabel}: ${rest.filter(Boolean).join(' ')}`).join(', ')
    );
    const tooltip = document.createElement('span');
    tooltip.className = ['limit-detail-tooltip', columns > 2 ? 'limit-detail-tooltip-triple' : '']
      .filter(Boolean).join(' ');
    tooltip.setAttribute('role', 'tooltip');
    entries.forEach((entry) => {
      const row = document.createElement('span');
      row.className = 'limit-detail-tooltip-row';
      for (let column = 0; column < columns; column += 1) {
        const cell = document.createElement('span');
        cell.textContent = entry[column] ?? '';
        row.append(cell);
      }
      tooltip.append(row);
    });
    const markOpened = () => {
      tooltipHost.markOpened();
      infoWrap.classList.add('has-opened');
    };
    const release = () => tooltipHost.release();
    infoWrap.addEventListener('pointerenter', markOpened);
    infoWrap.addEventListener('focusin', markOpened);
    infoWrap.addEventListener('pointerleave', release);
    infoWrap.addEventListener('focusout', release);
    infoWrap.append(info, tooltip);
    return infoWrap;
  }

  function providerSpendNode(balance) {
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
    } else if (provider.provider === 'deepseek') {
      // DeepSeek does not expose a fixed quota denominator. This intentionally
      // visualizes the balance relative to this month's inferred starting funds:
      // current / (current + observed month spend).
      windows.classList.add('limit-windows-deepseek');
      const balance = provider.balance || null;
      if (balance) {
        const currency = balance.currency;
        const balanceNode = limitWindowNode(
          'Balance',
          { remainingPercent: creditsMeterPercent(provider, null) },
          color,
          0.95,
          formatMoney(balance.amount, currency)
        );
        balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(balanceNode);

        const spendNode = providerSpendNode(balance);
        if (spendNode) windows.append(spendNode);
      }
    } else if (provider.provider === 'mimo') {
      windows.classList.add('limit-windows-mimo');
      const balance = provider.balance || null;
      const tokenPlan = windowForKind(provider, 'billing') || mimoTokenPlanWindowFromBalance(balance);
      if (tokenPlan) {
        const node = limitWindowNode(tokenPlan.label || 'Token Plan', tokenPlan, color, 0.68);
        node.classList.add('limit-window-wide');
        windows.append(node);
      } else if (balance?.planStatus === 'expired') {
        const node = limitWindowNode('Token Plan', { showMeter: false }, color, 0.68, t('limits.mimo.planExpired'));
        node.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(node);
      }
      const amount = optionalFiniteNumber(balance?.amount);
      const giftBalance = optionalFiniteNumber(balance?.giftBalance);
      const cashBalance = optionalFiniteNumber(balance?.cashBalance);
      if (amount !== null || giftBalance !== null || cashBalance !== null) {
        const detailParts = [];
        if (giftBalance !== null) detailParts.push(`Gift ${formatMoney(giftBalance, balance.currency)}`);
        if (cashBalance !== null) detailParts.push(`Cash ${formatMoney(cashBalance, balance.currency)}`);
        const balanceText = formatMoney(amount, balance.currency) || '—';
        const balanceNode = limitWindowNode(
          'Balance',
          { showMeter: false },
          color,
          0.68,
          balanceText,
          detailParts.join(' · ')
        );
        balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(balanceNode);
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

    return {
      antigravityQuotaGroups,
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
