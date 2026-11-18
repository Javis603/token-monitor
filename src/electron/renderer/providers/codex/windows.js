// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).codex = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { codexAccounts, settings, limitWindowNode, providerWindowLabel, tagUsageItem, usageItems, resetCreditsNode, windowsForKind, presentationApi, currentLocale, expiryDateLabel, t, formatAgo, limitDetailInfoNode, document, resetForecast, openExternal, accountIdentity, limitAccountEmailsMasked } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    const session = codexCanonicalWindow(provider, 'session');
    const weekly = codexCanonicalWindow(provider, 'weekly');
    const monthly = codexCanonicalWindow(provider, 'billing');
    // Each additional pool is a checklist item of its own. An install still
    // carrying the retired `showCodexAdditionalLimits: false` hides them all
    // until main carries the switch over (codexAdditionalLimitsMigration.js).
    const additionalWindows = settings()?.showCodexAdditionalLimits === false
      ? []
      : (provider.windows || []).filter(/** @param {any} window @returns {any} */ (window) => window?.additional === true);
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
      const additionalLabel = codexAdditionalWindowLabel(additional, additionalWindows);
      const additionalNode = limitWindowNode(additionalLabel, { ...additional, label: '' }, color, 0.78);
      // Drawn from a relabelled copy, so the row is named by the pool itself.
      tagUsageItem(additionalNode, usageItems.limitUsageItemId(additional), additionalLabel);
      additionalNode.classList.add('limit-window-wide');
      windows.append(additionalNode);
    }
    const resetNode = resetCreditsNode(provider.resetCredits);
    if (resetNode) windows.append(resetNode);
  }

  /** @param {any} provider @param {any} kind @returns {any} */ function codexCanonicalWindow(provider, kind) {
    return windowsForKind(provider, kind).find(/** @param {any} window @returns {any} */ (window) => window?.additional !== true) || null;
  }

  /** @param {any} window @param {any} siblingWindows @returns {any} */ function codexAdditionalWindowLabel(window, siblingWindows = []) {
    const name = String(window?.label || '').trim();
    const period = codexAdditionalWindowPeriodLabel(window);
    if (!name) return period || 'Additional limit';
    const normalizedName = name.toLowerCase();
    const matchingWindowCount = siblingWindows.filter(/** @param {any} candidate @returns {any} */ (candidate) => (
      String(candidate?.label || '').trim().toLowerCase() === normalizedName
    )).length;
    const displayName = presentationApi.codexAdditionalQuotaDisplayName(name);
    return matchingWindowCount > 1 && period ? `${displayName} · ${period}` : displayName;
  }

  /** @param {any} window @returns {any} */ function codexAdditionalWindowPeriodLabel(window) {
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

  /** @param {any} value @param {any} options @returns {any} */ function codexResetForecastDate(value, options = {}) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const locale = options.locale || currentLocale();
    const timeZone = options.timeZone;
    const dayNumber = /** @param {any} input @returns {any} */ (input) => {
      const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        ...(timeZone ? { timeZone } : {})
      }).formatToParts(input);
      const values = Object.fromEntries(parts.map(/** @param {any} part @returns {any} */ (part) => [part.type, part.value]));
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

  /** @param {any} value @param {any} options @returns {any} */ function codexResetForecastTimeUntil(value, options = {}) {
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

  /** @param {any} value @returns {any} */ function codexResetForecastAge(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    return formatAgo(Math.max(0, Date.now() - date.getTime()));
  }

  /** @param {any} value @returns {any} */ function codexResetForecastSourceAuthor(value) {
    const author = String(value || '').trim().replace(/^@+/, '');
    return author ? `@${author}` : '';
  }

  /** @param {any} value @param {any} locale @returns {any} */ function codexResetForecastPercent(value, locale = currentLocale()) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  }

  /** @param {any} value @returns {any} */ function codexResetForecastType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (type !== 'banked' && type !== 'regular') return '';
    return t(`limits.codexResetForecast.resetType.${type}`);
  }

  /** @param {any} forecast @returns {any} */ function codexResetForecastTooltip(forecast) {
    const entries = [];
    const disclaimer = t('limits.codexResetForecast.disclaimer');
    const isScheduled = forecast?.status === 'scheduled';
    const isActiveForecast = forecast?.status === 'active' && !codexResetForecastExpired(forecast);
    if (isScheduled) {
      const resetType = codexResetForecastType(forecast.scheduledResetType);
      entries.push({
        full: [t('limits.codexResetForecast.scheduled'), resetType].filter(Boolean).join(' · '),
        heading: true
      });
      const scheduledFor = codexResetForecastDate(forecast.scheduledFor);
      const scheduledIn = codexResetForecastTimeUntil(forecast.scheduledFor);
      if (scheduledFor) {
        entries.push({ full: [scheduledFor, scheduledIn].filter(Boolean).join(' · ') });
      }
    } else if (isActiveForecast) {
      entries.push({ full: t('limits.codexResetForecast.signal'), heading: true });
      const expiresAt = codexResetForecastDate(forecast.expiresAt);
      const expiresIn = codexResetForecastTimeUntil(forecast.expiresAt);
      if (expiresAt) {
        entries.push({
          full: `${t('limits.codexResetForecast.expiresLabel')} ${[expiresAt, expiresIn].filter(Boolean).join(' · ')}`
        });
      }
    }
    if (isScheduled || isActiveForecast) {
      const sourceObservedAt = isScheduled ? forecast.scheduledAnnouncedAt : forecast.observedAt;
      const source = [
        codexResetForecastSourceAuthor(forecast.sourceAuthor),
        codexResetForecastAge(sourceObservedAt)
      ].filter(Boolean).join(' · ');
      if (source) entries.push({ full: source, caption: true });
    }
    const latestReset = codexResetForecastDate(forecast?.latestResetAt);
    const latestResetType = codexResetForecastType(forecast?.latestResetType);
    if (latestReset || latestResetType) {
      const age = latestReset ? codexResetForecastAge(forecast.latestResetAt) : '';
      entries.push({
        full: [t('limits.codexResetForecast.lastReset'), age].filter(Boolean).join(' · '),
        heading: true,
        separated: entries.length > 0
      });
      entries.push({ full: [latestResetType, latestReset].filter(Boolean).join(' · ') });
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
      [...entries.map(/** @param {any} entry @returns {any} */ (entry) => Array.isArray(entry) ? `${entry[0]}: ${entry[1]}` : entry.full), disclaimer].join(', ')
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
    openButton.setAttribute('aria-label', t('limits.codexResetForecast.openSource'));
    openButton.setAttribute('aria-label', [label.textContent, value.textContent, detail.textContent, t('limits.codexResetForecast.openSource')].filter(Boolean).join(', '));
    return item;
  }

  /** @param {any} parent @returns {any} */ function appendCodexResetForecast(parent) {
    const node = renderCodexResetForecast();
    if (node) parent.append(node);
  }

  /** @param {any} forecast @param {any} nowMs @returns {any} */ function codexResetForecastExpired(forecast, nowMs = Date.now()) {
    if (forecast?.status !== 'active') return false;
    const expiresAtMs = Date.parse(forecast.expiresAt || '');
    return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
  }

  /** @param {any} provider @param {any} index @param {any} providers @returns {any} */ function codexAccountTitle(provider, index, providers = [provider]) {
    if (provider?.accountDisplayName) return provider.accountDisplayName;
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

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: {
      accountTitle: true,
      allowSystemSwitch: true,
      ...(grouped ? { showActiveBadge: true, showIcon: false } : {})
    }
  });

  const groupPolicy = () => ({ forecastOnGroup: true });

  const accountTitle = codexAccountTitle;

  const decorateRow = appendCodexResetForecast;

  /** @param {any} window @returns {any} */ function historyWindowVisible(window) { return !(settings()?.showCodexAdditionalLimits === false && window.additional === true); }

  /** @param {any} provider @param {any} options */
  function accountControlOptions(provider, options) {
    const active = options.showActiveBadge && codexAccounts.matchesActive(provider);
    const target = options.allowSystemSwitch && !active ? codexAccounts.switchTarget(provider) : null;
    return { active: Boolean(active), switchAccount: codexAccounts.canSwitchSystemAccount() ? target : null };
  }

  return { accountControlOptions, renderWindows, codexCanonicalWindow, codexAdditionalWindowLabel, codexAdditionalWindowPeriodLabel, codexResetForecastDate, codexResetForecastTimeUntil, codexResetForecastAge, codexResetForecastSourceAuthor, codexResetForecastPercent, codexResetForecastType, codexResetForecastTooltip, renderCodexResetForecast, appendCodexResetForecast, codexResetForecastExpired, codexAccountTitle, rowPolicy, groupPolicy, accountTitle, decorateRow, historyWindowVisible };
});
