'use strict';

// What a recorded subscription reads: its price, its cadence, the dates it
// runs between, and what it has cost so far.
//
// This is the third of the wording modules the limits surfaces share, beside
// `limitWindowLabels.js` (what a window is called) and `limitWindowText.js`
// (what a window reads). The split is the same: formatting only, no DOM, no
// renderer state. `t`, the currency table and the locale are handed in at call
// time, because the widget and the edge dock each hold their own.
//
// It exists because the Subscriptions settings list and the plan-cell tooltip
// describe the same record, and having each build its own sentence is how the
// two came to disagree — the settings row quoting a price the tooltip did not,
// the tooltip a date the settings row rounded differently. One record, one
// wording, whichever surface is asking.
(function exposeSubscriptionText(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(
    node ? require('./limitProviders') : root?.TokenMonitorLimitProviders,
    node ? require('./subscriptionDisplay') : root?.TokenMonitorSubscriptionDisplay
  );
  if (node) module.exports = api;
  if (root) root.TokenMonitorSubscriptionText = api;
})(typeof window !== 'undefined' ? window : globalThis, function createSubscriptionTextApi(limitProviders, subscriptionApi) {
  const CATALOG = limitProviders?.LIMIT_PROVIDER_CATALOG || [];

  // The provider's own name, preferring the `settingsLabel` a provider carries
  // only when it differs from its display label (Claude Code vs Claude). The
  // catalog's LIMIT_PROVIDER_LABELS map drops that distinction, so it is read
  // off the entries here instead.
  function providerLabel(providerId) {
    const entry = CATALOG.find((provider) => provider.id === providerId);
    return entry?.settingsLabel || entry?.label || providerId;
  }

  function symbolFor(currencyApi, currency) {
    const code = currencyApi.normalizeCurrency(currency);
    return currencyApi.CURRENCY_RATES[code]?.symbol || `${code} `;
  }

  function amountText(currencyApi, subscription) {
    return `${symbolFor(currencyApi, subscription?.currency)}${subscriptionApi.amountUnits(subscription).toFixed(2)}`;
  }

  function cadenceText(t, subscription) {
    const count = Number(subscription?.intervalCount) || 1;
    const unit = subscription?.interval === 'year'
      ? t('settings.subscriptions.unitYear')
      : t('settings.subscriptions.unitMonth');
    return count === 1 ? unit : t('settings.subscriptions.everyN', { count, unit });
  }

  function priceText(t, currencyApi, subscription) {
    return `${amountText(currencyApi, subscription)} / ${cadenceText(t, subscription)}`;
  }

  // "0 days left" reads like a bug on the day itself, which is exactly the day
  // the user is most likely to be looking.
  function daysText(t, days) {
    return days === 0
      ? t('subscription.tooltip.today')
      : t('subscription.tooltip.daysLeft', { days });
  }

  function localDate(dateString) {
    const [year, month, day] = String(dateString).split('-').map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    // Construct in local time from the calendar parts so the rendered day always
    // matches the stored one, whatever the timezone.
    return new Date(year, month - 1, day);
  }

  function dateText(locale, dateString) {
    if (!dateString) return '';
    return localDate(dateString)?.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }) || '';
  }

  // The settings rows are two dense lines inside a ~300px panel and the date is
  // the longest thing on the second one, so there it is the numeric short form
  // the locale itself defines. Everywhere with room to spell it out — the
  // tooltip above all — uses dateText().
  function shortDateText(locale, dateString) {
    if (!dateString) return '';
    return localDate(dateString)?.toLocaleDateString(locale, { dateStyle: 'short' }) || '';
  }

  // How long the user has been paying, plus what that adds up to. Months is the
  // unit people quote a subscription in, but it rounds a three-week-old plan
  // down to "0 months" — which reads as a bug beside a non-zero total, and does
  // so for most of the first month of every subscription anyone records. Below a
  // month the honest unit is days. A start date that has not arrived yet has no
  // elapsed time and nothing paid, so it says so instead of reporting zero of
  // both.
  //
  // Once coverage has lapsed the clock stops there: a plan bought for one month
  // and never renewed stays "1 month", it does not keep ageing after it ended.
  function elapsedText(t, currencyApi, subscription, today) {
    const stop = subscriptionApi.coverageStopDate(subscription);
    const asOf = stop && stop < today ? stop : today;
    const daysSinceStart = subscriptionApi.daysBetween(subscription.startDate, asOf);
    if (daysSinceStart !== null && daysSinceStart < 0) return t('subscription.tooltip.notStarted');

    const months = subscriptionApi.subscribedMonths(subscription, asOf);
    const elapsed = months >= 1
      ? t('subscription.tooltip.months', { months })
      : t('subscription.tooltip.daysCount', { days: Math.max(0, daysSinceStart || 0) });
    const paid = subscriptionApi.paidToDateMinor(subscription, today) / 100;
    return `${elapsed} · ${t('subscription.tooltip.paidTotal', { total: `${symbolFor(currencyApi, subscription.currency)}${paid.toFixed(2)}` })}`;
  }

  // A top-up is stored in minor units, like every amount the record holds.
  function topUpMinorText(currencyApi, subscription, amountMinor) {
    return `${symbolFor(currencyApi, subscription?.currency)}${(amountMinor / 100).toFixed(2)}`;
  }

  return {
    amountText,
    cadenceText,
    dateText,
    daysText,
    elapsedText,
    localDate,
    priceText,
    providerLabel,
    shortDateText,
    topUpMinorText
  };
});
