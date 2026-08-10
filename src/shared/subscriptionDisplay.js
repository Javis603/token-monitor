'use strict';

// Manual subscription metadata: the single entry point for normalizing, matching
// and deriving everything shown from a user-entered subscription. Home, the
// limits page and the settings section all read from here.
//
// Everything in this module is display-layer derivation, deliberately kept out of
// the wire shape — the same rule that keeps `creditsMeterPercent()` in
// limitBalanceDisplay.js rather than in a collector.
(function exposeSubscriptionDisplay(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSubscriptionDisplay = api;
})(typeof window !== 'undefined' ? window : globalThis, function createSubscriptionDisplayApi() {
  const INTERVALS = Object.freeze(['month', 'year']);
  // What the user is recording. A subscription is one recurring charge, fully
  // described by a price and a cadence. A top-up is not: it is a series of
  // irregular payments of varying size, and the only faithful record of it is
  // the list of those payments. Same record, two shapes.
  //
  // The kind is chosen by the user, seeded from the account's balance marker but
  // never dictated by it — z.ai bills a coding plan and API credits through one
  // account, so no per-provider rule gets this right for everyone.
  const KINDS = Object.freeze(['subscription', 'topup']);
  const MS_PER_DAY = 86400000;

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function cleanText(value) {
    return String(value === null || value === undefined ? '' : value).trim();
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  // ---------------------------------------------------------------------------
  // Calendar dates
  //
  // Dates are plain 'YYYY-MM-DD' strings throughout, never Date objects or
  // timestamps. A subscription date is a square on a calendar, not a point on a
  // timeline: storing it as an instant makes "12 days left" shift by one whenever
  // the user travels, and that misreads every day rather than twice a year.
  //
  // The fixed-width format also means lexicographic order is chronological order,
  // so comparisons never need parsing at all.
  // ---------------------------------------------------------------------------

  function isDateString(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(cleanText(value));
  }

  function parseDate(value) {
    if (!isDateString(value)) return null;
    const [year, month, day] = cleanText(value).split('-').map(Number);
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day };
  }

  function formatDate(parts) {
    return parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` : '';
  }

  function daysInMonth(year, month) {
    // Day 0 of the next month is the last day of this one.
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function todayString(now = new Date()) {
    // Local calendar fields on purpose — the user's "today" is their wall
    // calendar, not UTC's.
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }

  // Both endpoints are UTC midnight, so the difference is always a whole number
  // of days with no DST or offset drift.
  function daysBetween(fromDate, toDate) {
    const from = parseDate(fromDate);
    const to = parseDate(toDate);
    if (!from || !to) return null;
    const fromMs = Date.UTC(from.year, from.month - 1, from.day);
    const toMs = Date.UTC(to.year, to.month - 1, to.day);
    return Math.round((toMs - fromMs) / MS_PER_DAY);
  }

  // Add months to an anchor, clamping to the target month's last day.
  //
  // The anchor day is always the ORIGINAL day of month, never the previous
  // period's clamped result. This is what makes a Jan-31 subscription read
  // 1/31 → 2/28 → 3/31 → 4/30 → 5/31 rather than collapsing to the 28th forever
  // after its first short month. Stripe calls this the billing cycle anchor, and
  // Apple and Google Play behave the same way — most AI subscriptions bill
  // through one of the three.
  function addMonthsAnchored(anchor, monthsToAdd) {
    const totalMonths = (anchor.year * 12) + (anchor.month - 1) + monthsToAdd;
    const year = Math.floor(totalMonths / 12);
    const month = (totalMonths % 12) + 1;
    return { year, month, day: Math.min(anchor.day, daysInMonth(year, month)) };
  }

  // ---------------------------------------------------------------------------
  // Normalization
  // ---------------------------------------------------------------------------

  function normalizeInterval(value) {
    const interval = cleanText(value).toLowerCase();
    return INTERVALS.includes(interval) ? interval : 'month';
  }

  function normalizeIntervalCount(value) {
    const count = finiteNumber(value);
    if (count === null) return 1;
    return Math.max(1, Math.min(24, Math.round(count)));
  }

  // Amounts are integer hundredths of a unit so that summing many subscriptions
  // never accumulates float error. Every supported currency is two-decimal, so
  // the fixed ×100 holds; see normalizeSubscriptionCurrency.
  function normalizeAmountMinor(value) {
    const amount = finiteNumber(value);
    if (amount === null) return 0;
    return Math.max(0, Math.round(amount));
  }

  function normalizeBinding(input) {
    return {
      profileName: cleanText(input?.profileName),
      accountKey: cleanText(input?.accountKey),
      accountEmail: cleanText(input?.accountEmail).toLowerCase()
    };
  }

  function normalizeDateField(value) {
    return isDateString(value) && parseDate(value) ? cleanText(value) : null;
  }

  // Currency is validated against the shared display currencies, which is the
  // only set carrying exchange rates — subscriptions have to be summable and
  // comparable against usage cost, so a code with no rate is not usable here.
  // The caller passes the currency API so this module stays dependency-free in
  // both the CommonJS and browser-global loading paths.
  function normalizeSubscriptionCurrency(value, currencyApi) {
    if (currencyApi && typeof currencyApi.normalizeCurrency === 'function') {
      return currencyApi.normalizeCurrency(value, 'USD');
    }
    const code = cleanText(value).toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : 'USD';
  }

  function normalizeKind(value) {
    const kind = cleanText(value).toLowerCase();
    return KINDS.includes(kind) ? kind : 'subscription';
  }

  function isTopUp(record) {
    return normalizeKind(record?.kind) === 'topup';
  }

  function normalizeTopUp(input) {
    const date = normalizeDateField(input?.date);
    if (!date) return null;
    return {
      id: cleanText(input?.id) || `top_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      date,
      amountMinor: normalizeAmountMinor(input?.amountMinor)
    };
  }

  // Newest first, so "the last top-up" is always entry zero and the window a
  // burn rate is measured over always ends at the array's head.
  function normalizeTopUps(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const entry of input) {
      const topUp = normalizeTopUp(entry);
      if (topUp) out.push(topUp);
    }
    return out.sort((a, b) => (a.date === b.date ? 0 : (a.date < b.date ? 1 : -1)));
  }

  function normalizeSubscription(input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const provider = cleanText(input.provider).toLowerCase();
    const kind = normalizeKind(input.kind);
    const startDate = normalizeDateField(input.startDate);
    const topUps = normalizeTopUps(input.topUps);
    if (!provider) return null;
    // Each kind has its own anchor, and a record without one derives nothing.
    if (kind === 'topup' ? topUps.length === 0 : !startDate) return null;

    return {
      id: cleanText(input.id) || `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      provider,
      kind,
      binding: normalizeBinding(input.binding),
      planName: cleanText(input.planName),
      amountMinor: normalizeAmountMinor(input.amountMinor),
      currency: normalizeSubscriptionCurrency(input.currency, options.currencyApi),
      interval: normalizeInterval(input.interval),
      intervalCount: normalizeIntervalCount(input.intervalCount),
      startDate,
      topUps,
      autoRenew: input.autoRenew !== false,
      nextRenewalOverride: normalizeDateField(input.nextRenewalOverride),
      endDate: normalizeDateField(input.endDate),
      note: cleanText(input.note),
      updatedAt: cleanText(input.updatedAt) || new Date().toISOString()
    };
  }

  function normalizeSubscriptions(input, options = {}) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of input) {
      const subscription = normalizeSubscription(entry, options);
      if (!subscription || seen.has(subscription.id)) continue;
      seen.add(subscription.id);
      out.push(subscription);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Shared document
  //
  // A subscription describes an account, not a machine, so when devices share a
  // hub they share ONE list rather than each carrying their own copy inside its
  // device record. That choice is what keeps the arithmetic honest: account keys
  // are not stable across platforms (see the collapse pass in limits.js — the
  // same OAuth login hashes differently on macOS and Windows), so a per-device
  // copy could not be reliably deduped and the monthly total would double on
  // exactly the two-machine setup this exists for. One list also means a delete
  // is a delete, with no tombstone needed to stop another device resurrecting it.
  // ---------------------------------------------------------------------------

  // A hub that has never been written to. The empty `updatedAt` is meaningful:
  // it is what lets the very first write through the staleness check below.
  function emptySubscriptionDocument() {
    return { version: 1, updatedAt: '', subscriptions: [] };
  }

  // Both hubs build the stored document through here so the Node and Worker
  // implementations cannot drift, and so a list is re-normalized on the way in
  // rather than trusted — it arrives from a device, over the network.
  function subscriptionDocument(subscriptions, options = {}) {
    const explicit = cleanText(options.updatedAt);
    const previous = cleanText(options.previousUpdatedAt);
    let updatedAt = explicit || new Date().toISOString();
    // updatedAt doubles as the optimistic-concurrency token below, so two writes
    // landing in the same millisecond must not produce the same one — the second
    // would read as "not stale" against the first and overwrite it unnoticed.
    // Both are fixed-width UTC ISO strings, so lexicographic order is chronological.
    if (!explicit && previous && updatedAt <= previous) {
      // A stored document could carry a malformed or legacy timestamp, and
      // Date.parse would then hand toISOString() a NaN and throw — turning a
      // save into a crash. An unparseable previous simply cannot be compared
      // against, so the fresh stamp stands.
      const bumped = Date.parse(previous) + 1;
      if (Number.isFinite(bumped)) updatedAt = new Date(bumped).toISOString();
    }
    return { version: 1, updatedAt, subscriptions: normalizeSubscriptions(subscriptions, options) };
  }

  // Optimistic concurrency, and the reason writes are a full list rather than a
  // patch. A device that has been showing a stale copy would otherwise erase
  // every record added elsewhere since it last looked, silently and with no way
  // to get them back — this data exists nowhere else. An empty base is the first
  // write against an empty hub, which cannot clobber anything.
  function isStaleSubscriptionWrite(stored, baseUpdatedAt) {
    const storedAt = cleanText(stored?.updatedAt);
    if (!storedAt) return false;
    return cleanText(baseUpdatedAt) !== storedAt;
  }

  // ---------------------------------------------------------------------------
  // Renewal schedule
  // ---------------------------------------------------------------------------

  function intervalMonths(subscription) {
    const count = normalizeIntervalCount(subscription?.intervalCount);
    return normalizeInterval(subscription?.interval) === 'year' ? count * 12 : count;
  }

  // The period boundary on or after `today`, ignoring whether it will actually
  // be charged. Derived from the anchor every time rather than rolled forward on
  // a timer: rolling state would stall while the app is closed and drift apart
  // across devices.
  function scheduledRenewalDate(subscription, today = todayString()) {
    // A top-up ledger has no cadence to project from — the whole reason it is a
    // ledger is that the next one is not scheduled.
    if (isTopUp(subscription)) return '';
    const override = normalizeDateField(subscription?.nextRenewalOverride);
    // An override that has already passed is ignored rather than rolled, so a
    // one-off correction can never become a permanently wrong fixed date.
    if (override && override >= today) return override;

    const anchor = parseDate(subscription?.startDate);
    if (!anchor) return '';
    const step = intervalMonths(subscription);
    const todayParts = parseDate(today);
    if (!todayParts) return '';

    // Jump straight to the neighbourhood, then step the last period or two.
    const monthsElapsed = ((todayParts.year - anchor.year) * 12) + (todayParts.month - anchor.month);
    let periods = Math.max(0, Math.floor(monthsElapsed / step));
    let candidate = formatDate(addMonthsAnchored(anchor, periods * step));
    while (candidate < today) {
      periods += 1;
      candidate = formatDate(addMonthsAnchored(anchor, periods * step));
    }
    while (periods > 0) {
      const previous = formatDate(addMonthsAnchored(anchor, (periods - 1) * step));
      if (previous < today) break;
      periods -= 1;
      candidate = previous;
    }
    return candidate;
  }

  // The next charge, which only exists while the plan renews. Auto-renew off
  // means no further money is taken, so the schedule stops rather than rolling:
  // a cancelled plan that keeps projecting charges is the same lie whether it
  // shows the date or counts them.
  function nextRenewalDate(subscription, today = todayString()) {
    if (subscription?.autoRenew === false) return '';
    return scheduledRenewalDate(subscription, today);
  }

  // The boundary where charges stop for good, or '' while the plan still
  // renews. A boundary, not a covered day: coverage runs [startDate, stop) and
  // the renewal falling on the boundary is exactly the one that does not happen.
  //
  // Without auto-renew the user paid for one period and stopped, so the boundary
  // is one period after the first charge. An explicit `endDate` wins, which is
  // how a plan cancelled after several renewals says when it actually lapses.
  function coverageStopDate(subscription) {
    if (isTopUp(subscription)) return '';
    const endDate = normalizeDateField(subscription?.endDate);
    if (endDate) return endDate;
    if (subscription?.autoRenew !== false) return '';
    const anchor = parseDate(subscription?.startDate);
    return anchor ? formatDate(addMonthsAnchored(anchor, intervalMonths(subscription))) : '';
  }

  // How long the current money lasts: the stop date once there is one, and the
  // next renewal while the plan keeps going.
  function coverageEndDate(subscription, today = todayString()) {
    if (isTopUp(subscription)) return '';
    return coverageStopDate(subscription) || scheduledRenewalDate(subscription, today);
  }

  function daysUntilRenewal(subscription, today = todayString()) {
    const target = coverageEndDate(subscription, today);
    return target ? daysBetween(today, target) : null;
  }

  // How many payments have actually been taken, counting the first one on the
  // start date. `startDate` is the first real charge, never a trial start — a
  // trial period is a one-off event and would otherwise inflate this count by a
  // period the user never paid for.
  function elapsedPeriods(subscription, today = todayString()) {
    if (isTopUp(subscription)) return 0;
    const anchor = parseDate(subscription?.startDate);
    const todayParts = parseDate(today);
    if (!anchor || !todayParts) return 0;
    if (formatDate(anchor) > today) return 0;

    const step = intervalMonths(subscription);
    const monthsElapsed = ((todayParts.year - anchor.year) * 12) + (todayParts.month - anchor.month);
    let periods = Math.max(0, Math.floor(monthsElapsed / step));
    while (formatDate(addMonthsAnchored(anchor, (periods + 1) * step)) <= today) periods += 1;
    while (periods > 0 && formatDate(addMonthsAnchored(anchor, periods * step)) > today) periods -= 1;

    // Coverage that ends stops accruing charges at its boundary — the renewal
    // falling on that day is the one that was cancelled, so it is dropped rather
    // than counted. This is what keeps a plan bought once and never renewed at
    // one charge instead of billing it forever.
    const end = coverageStopDate(subscription);
    if (end) {
      while (periods > 0 && formatDate(addMonthsAnchored(anchor, periods * step)) >= end) periods -= 1;
    }
    return periods + 1;
  }

  function paidToDateMinor(subscription, today = todayString()) {
    return normalizeAmountMinor(subscription?.amountMinor) * elapsedPeriods(subscription, today);
  }

  // Whole months of coverage since the start date, for "subscribed for N months".
  function subscribedMonths(subscription, today = todayString()) {
    if (isTopUp(subscription)) return 0;
    const anchor = parseDate(subscription?.startDate);
    const todayParts = parseDate(today);
    if (!anchor || !todayParts) return 0;
    let months = ((todayParts.year - anchor.year) * 12) + (todayParts.month - anchor.month);
    if (todayParts.day < anchor.day) months -= 1;
    return Math.max(0, months);
  }

  // ---------------------------------------------------------------------------
  // Money
  // ---------------------------------------------------------------------------

  function amountUnits(subscription) {
    return normalizeAmountMinor(subscription?.amountMinor) / 100;
  }

  // currency.js only converts USD → X, so the inverse divides by the same active
  // rate. Kept here rather than inlined at call sites so every subscription
  // total goes through one conversion path.
  function amountUsd(subscription, currencyApi) {
    const units = amountUnits(subscription);
    const code = normalizeSubscriptionCurrency(subscription?.currency, currencyApi);
    if (code === 'USD' || !currencyApi?.convertUsd) return units;
    const oneUnitInCurrency = currencyApi.convertUsd(1, code);
    return oneUnitInCurrency > 0 ? units / oneUnitInCurrency : units;
  }

  // Move money between two of the display currencies. currency.js only converts
  // USD → X, so anything else is two hops through USD. A ledger is kept in the
  // user's own currency while a provider reports its balance in whatever it
  // bills in; subtracting one from the other unconverted is what would make a
  // "runs out on" date meaningless.
  function convertMinor(amountMinor, fromCurrency, toCurrency, currencyApi) {
    const usd = amountUsd({ amountMinor, currency: fromCurrency }, currencyApi);
    const target = normalizeSubscriptionCurrency(toCurrency, currencyApi);
    if (target === 'USD' || !currencyApi?.convertUsd) return Math.round(usd * 100);
    return Math.round(currencyApi.convertUsd(usd, target) * 100);
  }

  // ---------------------------------------------------------------------------
  // Top-up ledger
  // ---------------------------------------------------------------------------

  function topUpEntries(record) {
    return normalizeTopUps(record?.topUps);
  }

  function lastTopUp(record) {
    return topUpEntries(record)[0] || null;
  }

  function firstTopUpDate(record) {
    const entries = topUpEntries(record);
    return entries.length > 0 ? entries[entries.length - 1].date : '';
  }

  function topUpTotalMinor(record) {
    return topUpEntries(record).reduce((total, entry) => total + entry.amountMinor, 0);
  }

  // Everything put in during the calendar month `today` falls in. Calendar month
  // on purpose: this is the figure compared against a month's usage cost, and a
  // trailing window would compare two different spans.
  function topUpMonthMinor(record, today = todayString()) {
    const month = cleanText(today).slice(0, 7);
    return topUpEntries(record)
      .filter((entry) => entry.date.slice(0, 7) === month)
      .reduce((total, entry) => total + entry.amountMinor, 0);
  }

  // Every record reduced to a common monthly figure so mixed shapes can be
  // summed. A yearly plan is shown as its yearly price in the tooltip; only the
  // aggregate normalizes. A ledger contributes what it actually took this month,
  // which is the same question asked of a subscription: what is this costing me
  // this month.
  function monthlyAmountUsd(subscription, currencyApi, today = todayString()) {
    if (isTopUp(subscription)) {
      return amountUsd(
        { amountMinor: topUpMonthMinor(subscription, today), currency: subscription?.currency },
        currencyApi
      );
    }
    const months = intervalMonths(subscription);
    return months > 0 ? amountUsd(subscription, currencyApi) / months : 0;
  }

  // What is still being paid for. A plan whose coverage has run out costs
  // nothing this month, so it drops out of every total while its record stays on
  // the list as history.
  function activeSubscriptions(subscriptions, today = todayString()) {
    return (subscriptions || []).filter((subscription) => {
      const stop = coverageStopDate(subscription);
      return !stop || stop > today;
    });
  }

  function monthlyTotalUsd(subscriptions, currencyApi, today = todayString()) {
    return activeSubscriptions(subscriptions, today)
      .reduce((total, subscription) => total + monthlyAmountUsd(subscription, currencyApi, today), 0);
  }

  // ---------------------------------------------------------------------------
  // Account binding
  //
  // `accountKey` is a stable identifier for only some providers. For anything
  // keyed on the credential itself — openrouter hashes the API key, qoder and
  // opencode hash the cookie, grok and kimi hash the token — it is really a
  // credential fingerprint, and re-pasting an expired cookie changes it. Those
  // are exactly the providers whose credentials rotate most often, so binding on
  // accountKey alone would orphan a subscription every time.
  //
  // So match through a ladder and write the current key back on a hit.
  // ---------------------------------------------------------------------------

  function providerAccounts(providers, providerId) {
    const id = cleanText(providerId).toLowerCase();
    return (providers || []).filter((provider) => cleanText(provider?.provider).toLowerCase() === id);
  }

  function accountIdentityKeys(account) {
    return new Set([
      account?.accountKey,
      account?.webAccountKey,
      ...(Array.isArray(account?.accountKeyAliases) ? account.accountKeyAliases : [])
    ].map(cleanText).filter(Boolean));
  }

  function matchProviderAccount(subscription, providers) {
    const accounts = providerAccounts(providers, subscription?.provider);
    if (accounts.length === 0) return null;
    const binding = normalizeBinding(subscription?.binding);

    // Exact identifiers first. A key that has rotated simply fails to match and
    // falls through to the rungs below, so the healing this ladder exists for is
    // unaffected — but while a precise identifier is available it has to win, or
    // two accounts sharing a profile name bind to whichever happens to be first.
    if (binding.accountKey) {
      const byKey = accounts.find((account) => accountIdentityKeys(account).has(binding.accountKey));
      if (byKey) return byKey;
    }
    if (binding.accountEmail) {
      const byEmail = accounts.find(
        (account) => cleanText(account?.accountEmail || account?.email).toLowerCase() === binding.accountEmail
      );
      if (byEmail) return byEmail;
    }
    // A named profile is the user's own label for the account, so it survives
    // credential changes that every hashed key does not — but only when it names
    // exactly one account. Two profiles called "work" is a real ambiguity, and
    // guessing puts the cost on the wrong row; returning nothing surfaces the
    // rebind prompt, which asks the one person who knows.
    if (binding.profileName) {
      const named = accounts.filter((account) => cleanText(account?.accountName) === binding.profileName);
      if (named.length === 1) return named[0];
    }
    // Nothing matched, but the provider has exactly one account, so there is no
    // ambiguity about what the user meant. This is the case that silently heals
    // a re-pasted cookie.
    return accounts.length === 1 ? accounts[0] : null;
  }

  function bindingFromAccount(account) {
    return normalizeBinding({
      profileName: account?.accountName,
      accountKey: account?.accountKey,
      accountEmail: account?.accountEmail || account?.email
    });
  }

  // True only when the provider is present with several accounts and none of
  // them match — the one case where the user genuinely has to choose. A provider
  // that is simply not configured right now is not an orphan; the subscription
  // is kept and re-binds as soon as the account reappears.
  function needsRebinding(subscription, providers) {
    const accounts = providerAccounts(providers, subscription?.provider);
    if (accounts.length <= 1) return false;
    return matchProviderAccount(subscription, providers) === null;
  }

  // ---------------------------------------------------------------------------
  // Balance accounts
  // ---------------------------------------------------------------------------

  // True only when an account's ENTIRE quota is money, which is what makes it a
  // top-up rather than a subscription.
  //
  // Carrying a credits window is not enough: Claude Pro reports session and
  // weekly quotas plus a prepaid balance for overflow usage, and z.ai bills API
  // credits alongside a coding plan. Those are subscriptions that happen to have
  // a balance attached, and treating them as balance accounts would hide the
  // very accounts most people want to record.
  //
  // `metric` is the wire marker owned by limitBalanceDisplay.js — 'credits' is
  // remaining money, 'spend' is money already used, and a window with neither is
  // a real percentage quota.
  function isBalanceOnlyAccount(provider) {
    const windows = Array.isArray(provider?.windows) ? provider.windows : [];
    if (!windows.some((window) => window?.metric === 'credits')) return false;
    return !windows.some((window) => window?.metric !== 'credits' && window?.metric !== 'spend');
  }

  // ---------------------------------------------------------------------------
  // Provider rollup
  //
  // tokscale reads local transcripts, which record which CLIENT produced the
  // tokens but never which signed-in ACCOUNT did. Three Codex logins all land in
  // month.clientCosts['codex'] as one figure, and switching accounts mid-month
  // is invisible.
  //
  // So a value multiple must never be shown per account: three accounts would
  // each claim the whole usage, counting it three times. Aggregate to the
  // provider — the granularity the usage data actually has — and label it.
  // ---------------------------------------------------------------------------

  function providerRollup(subscriptions, providerId, currencyApi, today = todayString()) {
    const id = cleanText(providerId).toLowerCase();
    const matching = activeSubscriptions(subscriptions, today)
      .filter((subscription) => cleanText(subscription?.provider).toLowerCase() === id);
    return {
      count: matching.length,
      monthlyUsd: matching.reduce(
        (total, subscription) => total + monthlyAmountUsd(subscription, currencyApi, today),
        0
      )
    };
  }

  // How many times over the month's equivalent API cost covers what was paid.
  // `usageCostUsd` is tokscale's equivalent pricing, not money owed — under a
  // subscription nothing is billed per token — so this is a ratio and never a
  // difference or a sum.
  function valueMultiple(monthlyUsd, usageCostUsd) {
    const paid = finiteNumber(monthlyUsd);
    const usage = finiteNumber(usageCostUsd);
    if (paid === null || usage === null || paid <= 0 || usage <= 0) return null;
    return usage / paid;
  }

  // ---------------------------------------------------------------------------
  // Top-up projection (credits accounts)
  // ---------------------------------------------------------------------------

  // Pairing the recorded ledger with the live balance gives a burn rate and a
  // projected exhaustion date — a real forecast, and the only reason this
  // feature earns its place on a credits account at all, since the balance
  // itself is already on the limits page.
  //
  // Measured across the WHOLE ledger, never just the last entry: with two
  // top-ups on the books, "last top-up minus current balance" goes negative and
  // silently reports no burn at all.
  //
  // The window opens at the first recorded top-up and assumes the balance was
  // zero just before it. Money carried in from before that point is invisible
  // here, which understates the burn — that is the safe direction for a "runs
  // out on" date, and it corrects itself as the ledger fills in.
  function topUpProjection(record, balanceAmount, today = todayString(), options = {}) {
    const from = firstTopUpDate(record);
    const remaining = finiteNumber(balanceAmount);
    if (!from || remaining === null) return null;

    const balanceCurrency = options.balanceCurrency || record?.currency;
    const poured = convertMinor(
      topUpTotalMinor(record),
      record?.currency,
      balanceCurrency,
      options.currencyApi
    ) / 100;
    if (poured <= 0) return null;

    const elapsedDays = daysBetween(from, today);
    if (elapsedDays === null || elapsedDays <= 0) return null;
    const spent = poured - remaining;
    if (spent <= 0) return { dailyBurn: 0, exhaustDate: '', daysRemaining: null };

    const dailyBurn = spent / elapsedDays;
    const daysRemaining = Math.floor(remaining / dailyBurn);
    const todayParts = parseDate(today);
    const exhaustDate = todayParts ? formatDate(shiftDays(todayParts, daysRemaining)) : '';
    return { dailyBurn, exhaustDate, daysRemaining };
  }

  function shiftDays(parts, days) {
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate()
    };
  }

  return {
    INTERVALS,
    KINDS,
    activeSubscriptions,
    addMonthsAnchored,
    amountUnits,
    amountUsd,
    bindingFromAccount,
    convertMinor,
    coverageEndDate,
    coverageStopDate,
    daysBetween,
    daysUntilRenewal,
    elapsedPeriods,
    emptySubscriptionDocument,
    firstTopUpDate,
    intervalMonths,
    isBalanceOnlyAccount,
    isStaleSubscriptionWrite,
    isTopUp,
    lastTopUp,
    matchProviderAccount,
    monthlyAmountUsd,
    monthlyTotalUsd,
    needsRebinding,
    nextRenewalDate,
    normalizeSubscription,
    normalizeSubscriptions,
    normalizeTopUps,
    paidToDateMinor,
    providerRollup,
    subscribedMonths,
    subscriptionDocument,
    todayString,
    topUpEntries,
    topUpMonthMinor,
    topUpProjection,
    topUpTotalMinor,
    valueMultiple
  };
});
