'use strict';

// What the edge dock shows, as a persisted list. Shared by the main process
// (settings normalization, cell projection) and the settings composer, so the
// stored shape is validated by the same code that reads it.
//
// `edgeDockItems` is either null — the automatic default, which follows the
// connected limit providers — or an ordered list the user composed:
//   { type: 'limit', provider, hiddenAccounts: [accountKey], showUsage,
//     accountMode: 'active' | 'lowest' }
//   { type: 'stat', metric }   metric: a usage period, 'liveRate', or 'sessions'
//                              ('sessions' additionally carries runningOnly
//                              and groupBy; see normalizeItem)
(function exposeEdgeDockItems(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('../../../shared/limitProviders') : root?.TokenMonitorLimitProviders);
  if (node) module.exports = api;
  if (root) root.TokenMonitorEdgeDockItems = api;
})(typeof window !== 'undefined' ? window : null, function createEdgeDockItems(limitProviders) {
  // Usage readouts follow the widget's own period choices; each shows tokens
  // with its cost beneath, so tokens and cost are no longer separate items.
  const USAGE_PERIODS = Object.freeze(['today', 'week', 'last7', 'last30', 'month', 'allTime']);
  // Periods the collector does not report directly; they are summed from History.
  const DERIVED_PERIODS = Object.freeze(['week', 'last7', 'last30']);
  // 'sessions' is a readout too, but of the tracked clients' own sessions rather
  // than of a usage period: it is the one item that lists work every client can
  // answer for, including the clients that have no limits provider at all.
  const SESSIONS_METRIC = 'sessions';
  const STAT_METRICS = Object.freeze([...USAGE_PERIODS, 'liveRate', SESSIONS_METRIC]);
  const STAT_METRIC_SET = new Set(STAT_METRICS);
  // Earlier development builds split tokens and cost into separate metrics.
  const LEGACY_METRICS = Object.freeze({
    todayTokens: 'today',
    todayCost: 'today',
    monthTokens: 'month',
    monthCost: 'month'
  });
  // The resting column stays short: three covers the common Claude/Codex/Cursor
  // setup, and a fourth row pushed the rail tall enough to feel like a wall.
  const DEFAULT_LIMIT_COUNT = 3;
  const MAX_ITEMS = 24;
  const MAX_HIDDEN_ACCOUNTS = 32;
  const PROVIDER_IDS = new Set(limitProviders?.LIMIT_PROVIDER_IDS || []);

  function normalizedId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function itemId(item) {
    if (item?.type === 'limit') return `limit:${item.provider}`;
    if (item?.type === 'stat') return `stat:${item.metric}`;
    return '';
  }

// What a sessions item can put on the rail cell's third line. `clients` draws the
// tools with work in flight; `rate` draws the live token rate instead. It is the
// item's own choice rather than a global one: a second sessions item may want the
// other reading, exactly as each limit item carries its own account mode.
const SESSION_CELL_DETAILS = Object.freeze(['clients', 'rate']);

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type === 'limit') {
      const provider = normalizedId(raw.provider);
      if (!provider || (PROVIDER_IDS.size && !PROVIDER_IDS.has(provider))) return null;
      const hiddenAccounts = Array.isArray(raw.hiddenAccounts)
        ? [...new Set(raw.hiddenAccounts.map((key) => String(key || '').trim()).filter((key) => key && key.length <= 200))]
          .slice(0, MAX_HIDDEN_ACCOUNTS)
        : [];
      return {
        type: 'limit',
        provider,
        hiddenAccounts,
        showUsage: raw.showUsage !== false,
        showSessions: raw.showSessions !== false,
        // Codex has a meaningful local "current account", so its glance value
        // follows that account unless the user explicitly asks for the tightest
        // visible account. Other providers have no local-login identity.
        accountMode: provider === 'codex' && raw.accountMode !== 'lowest' ? 'active' : 'lowest'
      };
    }
    if (raw.type === 'stat') {
      const rawMetric = String(raw.metric || '');
      const metric = LEGACY_METRICS[rawMetric] || rawMetric;
      if (!STAT_METRIC_SET.has(metric)) return null;
      if (metric === SESSIONS_METRIC) {
        // A plain item omits both: `runningOnly: false` keeps the timeline and
        // `groupBy: 'none'` keeps it in one list, which is what the item did
        // before either choice existed, so an older stored item loads unchanged.
        return {
          type: 'stat',
          metric,
          runningOnly: raw.runningOnly === true,
          groupBy: raw.groupBy === 'client' ? 'client' : 'none',
          cellDetail: raw.cellDetail === 'rate' ? 'rate' : 'clients'
        };
      }
      return { type: 'stat', metric };
    }
    return null;
  }

  // null stays null (automatic); anything else becomes a clean, de-duplicated
  // list. An empty list is a valid explicit choice and is kept as such.
  function normalizeEdgeDockItems(value) {
    if (value === null || value === undefined || value === '') return null;
    if (!Array.isArray(value)) return null;
    const seen = new Set();
    const items = [];
    for (const raw of value) {
      const item = normalizeItem(raw);
      const id = itemId(item);
      if (!item || seen.has(id)) continue;
      seen.add(id);
      items.push(item);
      if (items.length >= MAX_ITEMS) break;
    }
    return items;
  }

  function defaultEdgeDockItems(providerIds = []) {
    return providerIds.slice(0, DEFAULT_LIMIT_COUNT).map((provider) => ({
      type: 'limit',
      provider,
      hiddenAccounts: [],
      showUsage: true,
      showSessions: true,
      accountMode: provider === 'codex' ? 'active' : 'lowest'
    }));
  }

  // Applies a drag order to the list. The shared drag sort hands ids back
  // lower-cased (it was written for provider ids) while usage metrics are
  // camelCase (`stat:liveRate`), so ids match case-insensitively; anything the
  // order does not name keeps its place at the end instead of being dropped.
  function reorderEdgeDockItems(items, order) {
    const list = Array.isArray(items) ? items : [];
    const byId = new Map(list.map((item) => [itemId(item).toLowerCase(), item]));
    const ordered = [];
    for (const id of Array.isArray(order) ? order : []) {
      const item = byId.get(String(id).toLowerCase());
      if (item && !ordered.includes(item)) ordered.push(item);
    }
    for (const item of list) if (!ordered.includes(item)) ordered.push(item);
    return ordered;
  }

  return {
    DEFAULT_LIMIT_COUNT,
    DERIVED_PERIODS,
    SESSIONS_METRIC,
    SESSION_CELL_DETAILS,
    STAT_METRICS,
    USAGE_PERIODS,
    defaultEdgeDockItems,
    itemId,
    normalizeEdgeDockItems,
    reorderEdgeDockItems
  };
});
