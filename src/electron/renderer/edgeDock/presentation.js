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

  // The standalone Sessions card is a timeline rather than a glance at one
  // provider, so it carries a longer tail than a provider card's three rows.
  const SESSIONS_RECENT_COUNT = 6;
  // Marks the rail can draw before it starts counting instead: three fits the
  // 56px cell beside its headline. The count beside them is the whole answer.

  // Every session the widget knows about, newest first, as one list. Both the
  // provider cards and the Sessions item read this instead of walking the
  // periods themselves, so "which sessions exist and in what order" is decided
  // once. Month detail includes today's sessions; today is the fallback for
  // payloads that only carry today.
  //
  // Newest activity first, and that order is what every card prints: a caller that picks
  // a subset out of this list hands it back in this order rather than re-sorting it,
  // which is what the "single timeline" layout promises.
  //
  // `periods.today`/`month` are the source rather than allTime: under sync the
  // aggregate drops all-time session detail (the sessions there are one
  // machine's own view), so a list built from it would silently mean "some"
  // rather than "all".
  function sessionSourceRows(stats) {
    const byKey = new Map();
    for (const periodKey of ['month', 'today']) {
      for (const [key, session] of Object.entries(stats?.periods?.[periodKey]?.sessions || {})) {
        if (byKey.has(key)) continue;
        if (session?.sessionKind === 'background-review') continue;
        const lastUsedMs = Date.parse(session?.lastUsedAt || session?.startedAt || '');
        if (!Number.isFinite(lastUsedMs)) continue;
        byKey.set(key, { session, lastUsedMs });
      }
    }
    return [...byKey.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.lastUsedMs - a.lastUsedMs);
  }

  // One row shape for both callers. `client` rides the row because the Sessions
  // item is a mixed list: it is what the row's mark is drawn from, and without
  // it the card could not say which tool a row belongs to.
  function sessionRowsFor(entries, stateByKey) {
    return entries.map(({ key, session }) => {
      const models = Object.entries(session.models || {}).sort((a, b) => (finite(b[1]) || 0) - (finite(a[1]) || 0));
      return {
        title: String(session.title || ''),
        projectLabel: String(session.projectLabel || ''),
        // Carried so the renderer keys its state map and its flare cache on
        // the same identity this projection used, instead of re-deriving one
        // from sessionId and colliding two clients.
        key,
        sessionId: String(session.sessionId || ''),
        client: normalizedId(session.client),
        model: models[0]?.[0] || '',
        totalTokens: finite(session.totalTokens) || 0,
        costUsd: finite(session.costUsd) || 0,
        lastUsedAt: session.lastUsedAt || session.startedAt || null,
        // Carried onto the projected row, not just used here: the dock renderer
        // re-derives the state at paint time and needs the boundary to do it.
        turnEnded: session.turnEnded === true,
        // The archive flags ride along for the same reason, and their absence was a
        // real bug: `sessionActivityState()` reads them first, so a projection that
        // dropped them let an archived row - idle by definition, whatever its
        // timestamp says - come back as running in the card that re-derives state
        // from this row. All three are carried rather than one alias, because three
        // separate fields are what the shared predicate reads.
        archived: session.archived === true,
        deleted: session.deleted === true,
        sourceDeleted: session.sourceDeleted === true,
        running: stateByKey.get(key) === 'running',
        // The same gate the Sessions list uses, so one surface cannot show a
        // gauge for a session the other has already dropped it from.
        context: sessionLive.sessionContextForRow(session) || null
      };
    });
  }

  // Split into the rows a card draws, with running rows kept preferentially:
  // the cap is a budget for the whole list rather than an allowance stacked on
  // top of the running ones, and a running row is never dropped (that would
  // leave the card's "N running" count with no matching row).
  // The rows a card draws, with running rows kept preferentially: the cap is a budget for
  // the whole list rather than an allowance stacked on top of the running ones, and a
  // running row is never dropped (that would leave the card's "N running" count with no
  // matching row).
  //
  // `order` decides how the chosen rows are printed. The default is running-first, which
  // is the provider card's long-standing behaviour; the standalone Sessions item asks for
  // `timeline`, printing them newest-first instead. Selection does not change either way,
  // so the cap protects live work in both.
  function cappedSessionRows(entries, cap, runningOnly = false, order = 'running-first') {
    const stateByKey = new Map(entries.map(({ key, session }) => [key, sessionLive.sessionActivityState(session)]));
    const running = entries.filter(({ key }) => stateByKey.get(key) === 'running');
    const quiet = runningOnly
      ? []
      : entries
        .filter(({ key }) => stateByKey.get(key) !== 'running')
        .slice(0, Math.max(0, cap - running.length));
    let ordered = [...running, ...quiet];
    if (order === 'timeline') {
      // `entries` arrives newest-first (see sessionSourceRows) and a timeline prints in
      // that order. Composing the selection directly would hoist every running row above
      // every quiet one, so a session active nine minutes ago would be listed above one
      // active a minute ago - an order the layout does not claim.
      const chosen = new Set(ordered.map((entry) => entry.key));
      ordered = entries.filter((entry) => chosen.has(entry.key));
    }
    return { rows: sessionRowsFor(ordered, stateByKey), running, stateByKey };
  }

  // The running reading, derived from the projected rows at the clock the caller
  // passes rather than frozen into the cell.
  //
  // Running is a function of time, not of the last push: a session crosses the
  // ten-minute window with no new data at all, so a count computed once at
  // projection time went stale on a rail that nothing re-projected - it promised
  // "1 running" and then opened a card showing no running row, because the card
  // has always re-derived its own state at paint time. This is that same
  // derivation, shared so the rail, the card and the grouped sections answer
  // identically, and so a caller can ask the same rows at a later clock.
  //
  // Every running row survives the cap (see cappedSessionRows), so the rows a cell
  // carries are complete for this reading however many sessions are quiet.
  function runningSessionSummary(sessions, now = Date.now()) {
    const rows = Array.isArray(sessions) ? sessions : [];
    const running = rows.filter((row) => sessionLive.sessionActivityState(row, now) === 'running');
    // One entry per tool, in the row order the list already carries (newest
    // first), so the rail's marks match the order the card shows.
    const clients = [...new Set(running.map((row) => normalizedId(row?.client)).filter(Boolean))];
    return { count: running.length, clients, clientCount: clients.length, rows: running };
  }

  // When the earliest still-running row stops reading as running, so the caller
  // can re-project at that moment instead of leaving a stale count on screen.
  // 0 when nothing is running: a quiet row never becomes running on its own, so
  // there is nothing to wait for and a scheduler reading this cannot loop.
  function nextRunningExpiryAt(sessions, now = Date.now()) {
    let soonest = 0;
    for (const row of runningSessionSummary(sessions, now).rows) {
      const last = Date.parse(String(row?.lastUsedAt || ''));
      if (!Number.isFinite(last)) continue;
      // The first millisecond at which this row is NOT running, not the last one at
      // which it is. sessionActivityState() reads `now - last <= window`, so
      // `last + window` is still running; a caller that woke exactly then would
      // re-project a cell that still counted the row and carry no next expiry for
      // it, leaving that reading on screen until the next real push.
      const expiry = last + sessionLive.RUNNING_WINDOW_MS + 1;
      if (expiry <= now) continue;
      if (!soonest || expiry < soonest) soonest = expiry;
    }
    return soonest;
  }

  // The sessions a provider card lists. Month detail includes today's sessions;
  // today's collection is the fallback for payloads that only carry today.
  //
  // Running is decided here rather than at the renderer, so the count and the
  // rows are one derivation and cannot disagree. `now` is passed in so the
  // caller can pin a clock in tests; the renderer recomputes from the same
  // shared predicate when it repaints between pushes.
  function recentSessionsFor(stats, provider) {
    // The canonical `client:sessionId` key identifies a record, not the bare
    // sessionId: two clients can carry the same id, and collapsing them onto one
    // key made their states overwrite each other while the rows stayed distinct.
    const entries = sessionSourceRows(stats)
      .filter(({ session }) => providerForClient(normalizedId(session?.client)) === provider);
    // One derivation for the run/quiet split and for the field the rows carry,
    // from the same shared function the card repaints with.
    return cappedSessionRows(entries, RECENT_SESSION_COUNT).rows;
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
    // The recent rows are two readings at once: the card lists them, and the rail's
    // running mark and its expiry clock are derived from them. So `showSessions` is a
    // choice about what the card draws and rides the cell as one, rather than being
    // applied here - emptying the rows here turned a switch labelled "Show recent
    // sessions in card" into an off switch for the rail's activity mark, which is a
    // reading the card was never asked about.
    const sessions = recentSessionsFor(options.stats, id);
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
      // What the card draws of those rows. The rail's mark reads them whatever this
      // says, because whether a tool is working is not the card's question.
      showSessions: options.showSessions !== false,
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
    if (metric === dockItems.SESSIONS_METRIC) {
      // Every tracked client, not just the ones with a limits provider: this is
      // the item that answers for the clients no quota card can show.
      const rows = sessionSourceRows(stats);
      // Only a cell that draws the rate carries one: attaching the sample to every
      // sessions item would put live figures in a projection nothing reads them
      // from, and would make "this cell shows marks" indistinguishable in the cell.
      const wantsRate = options.cellDetail === 'rate';
      const sample = wantsRate ? options.liveRate || null : null;
      const stateByKey = new Map(rows.map(({ key, session }) => [key, sessionLive.sessionActivityState(session)]));
      const runningEntries = rows.filter(({ key }) => stateByKey.get(key) === 'running');
      const { rows: sessions } = cappedSessionRows(
        rows,
        options.runningOnly === true ? runningEntries.length : SESSIONS_RECENT_COUNT,
        options.runningOnly === true,
        // A timeline prints newest-first; the provider card keeps running-first.
        'timeline'
      );
      // No frozen count: the cell carries its rows and the renderer asks them at
      // paint time, so a rail left on screen stops claiming a running session the
      // moment that session crosses the window. `expiresAt` lets the main process
      // re-project at exactly that moment instead of waiting for the next push.
      const expiryAt = nextRunningExpiryAt(sessions);
      return {
        id: `stat:${metric}`,
        kind: 'stat',
        metric,
        runningOnly: options.runningOnly === true,
        groupBy: options.groupBy === 'client' ? 'client' : 'none',
        // The rail's third line: the tools that are working, or the live rate.
        // The sample rides the cell because it moves on its own timer, and the
        // dock renderer has no stats access to derive one from.
        cellDetail: options.cellDetail === 'rate' ? 'rate' : 'clients',
        rateMode: options.tokenRateMode === 'burn' ? 'burn' : 'speed',
        rate: sample ? finite(options.tokenRateMode === 'burn' ? sample.burn : sample.speed) : null,
        rateIdle: !sample || sample.idle === true,
        // When the newest reading in this cell stops being running, in epoch ms,
        // or 0 when nothing is running (a quiet row never becomes running on its
        // own, so nothing has to wake for it).
        runningExpiresAt: expiryAt,
        sessions
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
        // The item's own choices ride along: they are what a stored `sessions`
        // item was configured with, and the projection is the only place that
        // knows how to apply them.
        cells.push(statCell(stats, item.metric, { ...options, ...item }));
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
    SESSIONS_METRIC: dockItems.SESSIONS_METRIC,
    buildEdgeDockCells,
    nextRunningExpiryAt,
    runningSessionSummary,
    connectedLimitProviders,
    displayPercent,
    edgeDockCellSignature,
    formatResetDuration,
    remainingSeverity
  };
});
