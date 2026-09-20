'use strict';

// Projects presentation stats into the edge dock's cell list. Shared by the
// main process (which needs the cell count and ids to size the rail and resolve
// the hovered cell) and the dock renderer (which formats the same cells), so
// the two can never disagree about what cell N is.
(function exposeEdgeDockPresentation(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(
    node ? require('../../../shared/trayText') : root?.TokenMonitorTrayText,
    node ? require('../../../shared/limitBalanceDisplay') : root?.TokenMonitorLimitBalanceDisplay,
    node ? require('../../../shared/limitProviders') : root?.TokenMonitorLimitProviders,
    node ? require('./items') : root?.TokenMonitorEdgeDockItems,
    node ? require('../accountIdentity') : root?.TokenMonitorAccountIdentity,
    node ? require('../../../shared/sessionLive') : root?.TokenMonitorSessionLive
  );
  if (node) module.exports = api;
  if (root) root.TokenMonitorEdgeDockPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createEdgeDockPresentation(trayText, balanceDisplay, limitProviders, dockItems, accountIdentity, sessionLive) {
  // Every account is listed; the card scrolls when they outgrow the screen.
  const MAX_BUBBLE_ACCOUNTS = 50;

  function normalizedId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function csv(value) {
    return (Array.isArray(value) ? value : String(value || '').split(','))
      .map(normalizedId)
      .filter(Boolean);
  }

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clampPercent(value) {
    const number = finite(value);
    return number === null ? null : Math.max(0, Math.min(100, number));
  }

  function providerOrder(providers, options = {}) {
    const present = [];
    const seen = new Set();
    for (const provider of providers) {
      const id = normalizedId(provider?.provider);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      present.push(id);
    }
    const enabled = options.limitProviders === undefined || options.limitProviders === null
      ? null
      : new Set(csv(options.limitProviders));
    const ordered = [];
    const placed = new Set();
    for (const id of [...csv(options.limitProviderOrder), ...present]) {
      if (placed.has(id) || !seen.has(id) || (enabled && !enabled.has(id))) continue;
      placed.add(id);
      ordered.push(id);
    }
    return ordered;
  }

  function accountSummary(provider) {
    const selection = trayText.compactLimitSelection(provider);
    return {
      status: provider?.status === 'ok' && !provider?.stale ? 'ok' : (provider?.stale ? 'stale' : 'error'),
      planLabel: String(provider?.planLabel || provider?.accountLabel || ''),
      accountKey: String(provider?.accountKey || ''),
      accountName: String(provider?.accountName || ''),
      accountEmail: String(provider?.accountEmail || ''),
      updatedAt: provider?.updatedAt || provider?.checkedAt || null,
      stale: provider?.stale === true,
      primaryRemaining: selection ? selection.primaryPercent : null,
      primaryWindow: selection ? selection.primaryWindow : null,
      // The card renders its quota rows from the shared Limits view, which
      // reads the collector record itself. Projecting the windows here is what
      // made the card a second, less-informed implementation of the same rows:
      // it could only show what this function had remembered to copy.
      record: provider || null
    };
  }

  // A glance rail is only worth its space for accounts that report something.
  // Enabled-but-unconfigured providers (and automatic ones the user never signed
  // in to) arrive as rows with no windows; listing them would fill the rail with
  // placeholders. A failing account that still carries last-known windows stays.
  function hasReportableData(provider) {
    if (provider?.status === 'ok') return true;
    return Array.isArray(provider?.windows) && provider.windows.length > 0;
  }

  // Which limits provider a tracked client's tokens belong to. Asked of the
  // shared catalog's own client→provider mapping rather than copied, so a client
  // folded under a differently named provider (droid → factory) stays aligned.
  const providerForClientCache = new Map();
  function providerForClient(client) {
    if (providerForClientCache.has(client)) return providerForClientCache.get(client);
    const [provider = null] = limitProviders?.limitProvidersForDetectedClients?.({
      clients: { [client]: { source: { state: 'detected' } } }
    }) || [];
    providerForClientCache.set(client, provider);
    return provider;
  }

  function periodUsageFor(period, provider) {
    let tokens = 0;
    let costUsd = 0;
    let seen = false;
    for (const [client, value] of Object.entries(period?.clients || {})) {
      if (providerForClient(normalizedId(client)) !== provider) continue;
      seen = true;
      tokens += finite(value) || 0;
      costUsd += finite(period?.clientCosts?.[client]) || 0;
    }
    return seen ? { tokens, costUsd } : null;
  }

  const RECENT_SESSION_COUNT = 3;

  // The sessions a provider card lists. Month detail includes today's sessions;
  // today's collection is the fallback for payloads that only carry today.
  //
  // Running is decided here rather than at the renderer, so the count and the
  // rows are one derivation and cannot disagree. `now` is passed in so the
  // caller can pin a clock in tests; the renderer recomputes from the same
  // shared predicate when it repaints between pushes.
  function recentSessionsFor(stats, provider) {
    const byKey = new Map();
    for (const periodKey of ['month', 'today']) {
      for (const [key, session] of Object.entries(stats?.periods?.[periodKey]?.sessions || {})) {
        if (byKey.has(key)) continue;
        if (providerForClient(normalizedId(session?.client)) !== provider) continue;
        if (session?.sessionKind === 'background-review') continue;
        const lastUsedMs = Date.parse(session?.lastUsedAt || session?.startedAt || '');
        if (!Number.isFinite(lastUsedMs)) continue;
        byKey.set(key, { session, lastUsedMs });
      }
    }
    // The canonical `client:sessionId` key identifies a record, not the bare
    // sessionId: two clients can carry the same id, and collapsing them onto one
    // key made their states overwrite each other while the rows stayed distinct.
    const ordered = [...byKey.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.lastUsedMs - a.lastUsedMs);
    // One derivation for the run/quiet split and for the field the rows carry,
    // from the same shared function the card repaints with.
    const stateByKey = new Map(ordered.map(({ key, session }) => [key, sessionLive.sessionActivityState(session)]));
    const running = ordered.filter(({ key }) => stateByKey.get(key) === 'running');
    // The cap is a budget for the whole list, not a second allowance stacked on
    // top of the running rows. Adding the running ones to a full quiet tail made
    // the card grow by one the moment a session went live - three idle rows plus
    // the running one, when the session that started was already one of the
    // three. Running rows are kept preferentially (dropping one would leave the
    // card's "N running" count with no matching row), and the tail fills whatever
    // budget they leave; if more than the cap is running, all of them show and the
    // list scrolls rather than hiding live work.
    const quiet = ordered
      .filter(({ key }) => stateByKey.get(key) !== 'running')
      .slice(0, Math.max(0, RECENT_SESSION_COUNT - running.length));
    return [...running, ...quiet]
      .map(({ key, session }) => {
        const models = Object.entries(session.models || {}).sort((a, b) => (finite(b[1]) || 0) - (finite(a[1]) || 0));
        return {
          title: String(session.title || ''),
          projectLabel: String(session.projectLabel || ''),
          // Carried so the renderer keys its state map and its flare cache on
          // the same identity this projection used, instead of re-deriving one
          // from sessionId and colliding two clients.
          key,
          sessionId: String(session.sessionId || ''),
          model: models[0]?.[0] || '',
          totalTokens: finite(session.totalTokens) || 0,
          costUsd: finite(session.costUsd) || 0,
          lastUsedAt: session.lastUsedAt || session.startedAt || null,
          // Carried onto the projected row, not just used here: the dock renderer
          // re-derives the state at paint time and needs the boundary to do it.
          turnEnded: session.turnEnded === true,
          running: stateByKey.get(key) === 'running',
          // The same gate the Sessions list uses, so one surface cannot show a
          // gauge for a session the other has already dropped it from.
          context: sessionLive.sessionContextForRow(session) || null
        };
      });
  }

  function providerUsage(stats, provider) {
    const today = periodUsageFor(stats?.periods?.today, provider);
    const month = periodUsageFor(stats?.periods?.month, provider);
    return today || month ? { today, month } : null;
  }

  function providerCell(id, records, options = {}) {
    const hidden = new Set(options.hiddenAccounts || []);
    const accounts = records
      .filter((record) => !record?.accountKey || !hidden.has(record.accountKey))
      .map((record) => ({ record, summary: accountSummary(record) }));
    // Accounts keep the collector's order, as the Limits view lists them. The
    // live Codex account is taken from this device's records alone, so a synced
    // device's login is never marked as the one in use here.
    const live = id === 'codex'
      ? accountIdentity?.localLiveCodexProvider?.(options.stats, options.localDeviceId) || null
      : null;
    // The managed account a card row could switch this device to, as the Limits
    // view's Switch button resolves it: only for Codex, only off the account
    // already in use here, and only when it maps to an enabled managed login.
    // The id is resolved here because the dock renderer has no settings access;
    // it reports the id back and the main process owns the swap.
    const managedAccounts = id === 'codex' && Array.isArray(options.codexManagedAccounts)
      ? options.codexManagedAccounts
      : [];
    // The Limits view only hides the Switch button on the account already in
    // use when the provider is grouped as several accounts; a lone Codex row
    // still offers it, which is how the local login gets re-activated. Mirror
    // that gate rather than inventing a stricter one.
    const grouped = accounts.length > 1;
    const projected = accounts.map((account) => {
      const managed = managedAccounts.find((entry) => (
        entry?.enabled !== false && accountIdentity?.codexAccountMatchesProvider?.(entry, account.record)
      )) || null;
      const active = id === 'codex' && options.activeCodexAccountId
        ? managed?.id === options.activeCodexAccountId
        : Boolean(live && (
          (live.accountKey && live.accountKey === account.record.accountKey)
          || (!live.accountKey && live.accountEmail && live.accountEmail === account.record.accountEmail)
        ));
      const switchable = (grouped ? !active : true)
        ? managed
        : null;
      return {
        ...account,
        summary: {
          ...account.summary,
          active,
          switchAccountId: switchable ? String(switchable.id || '') : ''
        }
      };
    });
    // Codex defaults to the account this machine is using. Users who monitor a
    // pool can opt back into the previous tightest-visible-account headline.
    // If the active row is hidden or has no usable value, fall back to the
    // tightest visible account rather than leaving the rail blank.
    let tightest = null;
    for (const account of projected) {
      if (account.summary.primaryRemaining === null) continue;
      if (!tightest || account.summary.primaryRemaining < tightest.summary.primaryRemaining) tightest = account;
    }
    const activeHeadline = id === 'codex' && options.accountMode !== 'lowest'
      ? projected.find((account) => account.summary.active && account.summary.primaryRemaining !== null) || null
      : null;
    const headline = activeHeadline || tightest;
    const headlineWindow = headline?.summary.primaryWindow || null;
    const headlineCredits = headlineWindow && balanceDisplay.isCreditsWindow(headlineWindow)
      ? {
        amount: balanceDisplay.creditsAmount(headline.record, headlineWindow),
        currency: balanceDisplay.creditsCurrency(headline.record, headlineWindow)
      }
      : null;
    const sessions = options.showSessions === false ? [] : recentSessionsFor(options.stats, id);
    return {
      id,
      kind: 'provider',
      provider: id,
      status: headline ? 'ok' : (accounts.some((account) => account.summary.status === 'stale') ? 'stale' : 'error'),
      remainingPercent: headline ? headline.summary.primaryRemaining : null,
      windowKind: headlineWindow ? String(headlineWindow.kind || '') : '',
      credits: headlineCredits,
      accountCount: accounts.length,
      accounts: projected.slice(0, MAX_BUBBLE_ACCOUNTS).map((account) => account.summary),
      // Every account the provider has, hidden and non-reporting ones included.
      // Hiding an account is a choice about what this card draws, and so is the
      // rail's own "only accounts that report something" rule, while a
      // subscription binds to the account itself — and matchProviderAccount()
      // falls back to "the provider has exactly one account, so there is no
      // ambiguity", so a universe narrowed to the drawn rows puts an account's
      // record on whichever row is left.
      subscriptionAccounts: options.subscriptionAccounts || records,
      usage: options.showUsage === false ? null : providerUsage(options.stats, id),
      // The month's cost per client, for the subscription card on this card's
      // plan cell. It is the same map the Limits page reads — the card cannot
      // compute it from `usage` above, which sums every client that maps to the
      // provider while the page charges one client id — and it rides the cell
      // because it moves with every stats push.
      monthClientCosts: options.stats?.periods?.month?.clientCosts || {},
      // What a row needs to name the device its reading came from: which device
      // this is, and whether syncing is on at all. Both are the main process's
      // to know and neither is in a collector record, so they ride the cell the
      // way the subscription universe and the month's cost do — the dock window
      // holds no settings and no device list of its own.
      provenanceContext: {
        localDeviceId: String(options.localDeviceId || ''),
        syncActive: options.syncActive === true
      },
      sessions,
      forecast: id === 'codex' ? options.codexResetForecast || null : null
    };
  }

  function clientBreakdown(period, metric) {
    return Object.entries(period?.clients || {})
      .map(([client, tokens]) => ({
        client: normalizedId(client),
        tokens: finite(tokens) || 0,
        costUsd: finite(period?.clientCosts?.[client]) || 0
      }))
      .filter((entry) => entry.client && (metric === 'cost' ? entry.costUsd > 0 : entry.tokens > 0))
      .sort((a, b) => (metric === 'cost' ? b.costUsd - a.costUsd : b.tokens - a.tokens));
  }

  function statCell(stats, metric, options = {}) {
    if (metric === 'liveRate') {
      const sample = options.liveRate || null;
      return {
        id: `stat:${metric}`,
        kind: 'stat',
        metric,
        rateMode: options.tokenRateMode === 'burn' ? 'burn' : 'speed',
        rate: sample ? (options.tokenRateMode === 'burn' ? sample.burn : sample.speed) : null,
        speed: sample ? finite(sample.speed) : null,
        burn: sample ? finite(sample.burn) : null,
        deviceCount: sample ? Math.max(0, Math.round(finite(sample.deviceCount) || 0)) : 0,
        idle: !sample || sample.idle === true
      };
    }
    // Native periods come straight from stats; week/last7/last30 are summed from
    // History by the caller and arrive as `derivedPeriods`, or not at all while
    // History is unavailable — which renders as unknown, never as zero.
    const derived = dockItems.DERIVED_PERIODS.includes(metric);
    const period = derived ? options.derivedPeriods?.[metric] || null : stats?.periods?.[metric] || null;
    const clients = period ? clientBreakdown(period, 'tokens') : [];
    return {
      id: `stat:${metric}`,
      kind: 'stat',
      metric,
      period: metric,
      available: Boolean(period),
      totalTokens: period ? finite(period.totalTokens) || 0 : null,
      costUsd: period ? finite(period.costUsd) || 0 : null,
      clients: clients.slice(0, 6),
      clientCount: clients.length
    };
  }

  // Two answers, because the rail and the subscription matcher want different
  // ones. `byId` is what the cell draws, so it is gated on `hasReportableData`.
  // `allById` is every account the provider has, gate ignored, because a
  // subscription binds to the account rather than to the row.
  //
  // The matcher's universe is wider than the rail's in two directions, and only
  // the first is a gate. `stats.limits.providers` is the *aggregate*, which drops
  // a stale account the moment the same provider has a fresh one (limits/core.js
  // collapses by provider name, and the same login hashes differently per
  // platform). An account the aggregate no longer names is one the matcher
  // cannot see, so a record bound to it falls through matchProviderAccount()'s
  // sole-account fallback onto whichever account is left — which is why the page
  // reads the local device's own records beside the aggregate, and why this does
  // too. Display does not: an account the aggregate collapsed away is not a row.
  function groupedProviders(stats, options = {}) {
    const providers = Array.isArray(stats?.limits?.providers) ? stats.limits.providers : [];
    const byId = new Map();
    const allById = new Map();
    const local = accountIdentity.localDeviceLimitsProviders(stats, options.localDeviceId);
    // Local first, so this device wins a tie on an account both lists name. The
    // two lists are deduped by the matcher's own identity rule rather than by a
    // value built out of the record, because the two copies of one account are
    // two records and disagree about anything the rule does not read — and over
    // the whole list rather than pair by pair, since which records are distinct
    // accounts is a property of the list (accountIdentity.dedupeAccounts).
    const seen = accountIdentity.dedupeAccounts([...(local || []), ...providers]);
    for (const provider of seen) {
      const id = normalizedId(provider?.provider);
      if (!id) continue;
      if (!allById.has(id)) allById.set(id, []);
      allById.get(id).push(provider);
    }
    for (const provider of providers) {
      const id = normalizedId(provider?.provider);
      if (!id || !hasReportableData(provider)) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(provider);
    }
    return { providers: providers.filter(hasReportableData), byId, allById };
  }

  // Limit providers that currently report something, in the user's limits order.
  function connectedLimitProviders(stats, options = {}) {
    if (options.limitsEnabled === false) return [];
    return providerOrder(groupedProviders(stats).providers, options);
  }

  function buildEdgeDockCells(stats, options = {}) {
    const { byId, allById } = groupedProviders(stats, options);
    const items = Array.isArray(options.items)
      ? options.items
      : dockItems.defaultEdgeDockItems(connectedLimitProviders(stats, options));
    const cells = [];
    for (const item of items) {
      if (item.type === 'stat') {
        cells.push(statCell(stats, item.metric, options));
      } else if (item.type === 'limit' && options.limitsEnabled !== false) {
        // An explicitly chosen provider keeps its slot while it has nothing to
        // report (it renders as `--`), so the user's layout does not reshuffle
        // every time an account refreshes or signs out.
        cells.push(providerCell(item.provider, byId.get(item.provider) || [], {
          ...item,
          subscriptionAccounts: allById.get(item.provider) || [],
          stats,
          localDeviceId: options.localDeviceId,
          syncActive: options.syncActive,
          codexManagedAccounts: options.codexManagedAccounts,
          activeCodexAccountId: options.activeCodexAccountId,
          codexResetForecast: options.codexResetForecast
        }));
      }
    }
    return cells;
  }

  // Structural identity of the rail: ids in order. The main process resizes and
  // re-resolves hover only when this changes, not on every value update.
  function edgeDockCellSignature(cells) {
    return (cells || []).map((cell) => cell.id).join(',');
  }

  function displayPercent(remainingPercent, showUsed) {
    const remaining = clampPercent(remainingPercent);
    if (remaining === null) return null;
    return showUsed ? 100 - remaining : remaining;
  }

  // Severity is keyed on what is left regardless of the used/remaining display
  // mode, so flipping the mode never recolours a healthy quota as a warning.
  function remainingSeverity(remainingPercent) {
    const remaining = clampPercent(remainingPercent);
    if (remaining === null) return 'unknown';
    if (remaining <= 10) return 'critical';
    if (remaining <= 25) return 'low';
    return 'ok';
  }

  function formatResetDuration(ms) {
    const totalMinutes = Math.max(0, Math.round(Number(ms || 0) / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return '<1m';
  }

  return {
    buildEdgeDockCells,
    connectedLimitProviders,
    displayPercent,
    edgeDockCellSignature,
    formatResetDuration,
    remainingSeverity
  };
});
