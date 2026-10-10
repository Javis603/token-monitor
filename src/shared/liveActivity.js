'use strict';

// Live Activity content state v3: the Hub push builder emits data only — usage,
// quota and running agents — and the iOS widget extension owns every
// presentation choice (layout, currency, language), reading it from the app
// group. Nothing presentational crosses the wire, so a new layout option never
// needs a Hub change. Keep the field names identical to the Swift
// TokenMonitorActivityAttributes.ContentState.

const { creditsMeterPercent } = require('./limits/balanceDisplay');
const { LIMIT_PROVIDER_IDS } = require('./limits/providers');
const { limitWindowLabel } = require('./limits/windowLabels');
const { RUNNING_WINDOW_MS, sessionActivityState } = require('./sessionLive');

const DATE_REFERENCE_SECONDS = 978307200;
const STALE_AGE_SECONDS = 15 * 60;
// ActivityKit caps the whole push at 4 KB, so the quota list is bounded and
// null fields are omitted: three ranked records plus whatever the device's
// layout names explicitly.
const RANKED_QUOTAS = 3;
const MAX_QUOTAS = 8;
const MAX_WINDOWS = 3;
const MAX_ACCOUNTS_PER_PROVIDER = 3;
const MAX_AGENT_CLIENTS = 3;
const MAX_HIDDEN_PROVIDERS = 64;
const MAX_REFERENCES = 8;

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[%,$]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizedString(value, maxLength = 128) {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function normalizedProvider(value) {
  const provider = normalizedString(value, 64).toLowerCase();
  return provider || null;
}

function normalizeLiveActivityRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_live_activity_registration');
  }
  const activityID = typeof input.activityID === 'string' ? input.activityID.trim() : '';
  const token = typeof input.token === 'string' ? input.token.trim().toLowerCase() : '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(activityID) || !/^(?:[0-9a-f]{2}){16,2048}$/.test(token)) {
    throw new Error('invalid_live_activity_registration');
  }

  const raw = input.preferences && typeof input.preferences === 'object'
    ? input.preferences
    : {};
  const ids = (value, max, normalize) => [...new Set((Array.isArray(value) ? value : [])
    .filter((id) => typeof id === 'string').map(normalize).filter(Boolean))].slice(0, max);

  return {
    activityID,
    token,
    registeredAt: new Date().toISOString(),
    preferences: {
      liveActivityEnabled: raw.liveActivityEnabled !== false,
      hiddenLimitProviders: ids(raw.hiddenLimitProviders, MAX_HIDDEN_PROVIDERS, normalizedProvider),
      // Providers and accounts the device layout names explicitly; the Hub
      // includes them beside the ranked records so every slot can resolve.
      providerIDs: ids(raw.providerIDs, MAX_REFERENCES, normalizedProvider),
      accountKeys: ids(raw.accountKeys, MAX_REFERENCES, (key) => normalizedString(key, 128))
    }
  };
}

function providerWindowRemaining(provider, window) {
  if (window?.metric === 'credits') return creditsMeterPercent(provider, window);
  const explicit = asNumber(window?.remainingPercent);
  if (explicit !== null) return clamp(explicit, 0, 100);
  const usedPercent = asNumber(window?.usedPercent);
  return usedPercent === null ? null : clamp(100 - usedPercent, 0, 100);
}

function displayWindows(provider) {
  return (Array.isArray(provider?.windows) ? provider.windows : []).filter((window) => (
    window?.metric === 'credits'
      || providerWindowRemaining(provider, window) !== null
      || asNumber(window?.remaining) !== null
      || asNumber(window?.used) !== null
      || String(window?.detail || '').trim() !== ''
  ));
}

// The shared views show the canonical lanes only; promo/additional windows
// never reach the island or lock screen.
function canonicalWindows(provider) {
  return displayWindows(provider).filter((window) => window?.additional !== true);
}

function lowestRemaining(provider) {
  const values = canonicalWindows(provider)
    .map((window) => providerWindowRemaining(provider, window))
    .filter((value) => value !== null);
  return values.length ? Math.min(...values) : null;
}

function providerStatus(provider) {
  return normalizedProvider(provider?.status) || 'ok';
}

function catalogIndex(provider) {
  const index = LIMIT_PROVIDER_IDS.indexOf(normalizedProvider(provider?.provider));
  return index === -1 ? LIMIT_PROVIDER_IDS.length : index;
}

function compareRemaining(left, right) {
  const leftRemaining = lowestRemaining(left);
  const rightRemaining = lowestRemaining(right);
  if (leftRemaining !== null && rightRemaining !== null && leftRemaining !== rightRemaining) {
    return leftRemaining - rightRemaining;
  }
  if (leftRemaining !== null && rightRemaining === null) return -1;
  if (leftRemaining === null && rightRemaining !== null) return 1;
  return catalogIndex(left) - catalogIndex(right);
}

// Identical to the Swift ranking: healthy (status ok / absent) non-stale
// providers first, lowest canonical remaining % wins, ties and meterless rows
// fall back to the default catalog order.
function rankedProviders(stats, preferences) {
  const hidden = new Set(preferences?.hiddenLimitProviders || []);
  const providers = (Array.isArray(stats?.limits?.providers) ? stats.limits.providers : [])
    .filter((provider) => {
      const id = normalizedProvider(provider?.provider);
      return id && !hidden.has(id);
    });
  const healthy = (provider) => providerStatus(provider) === 'ok' && provider?.stale !== true;
  return [
    ...providers.filter(healthy).sort(compareRemaining),
    ...providers.filter((provider) => !healthy(provider)).sort(compareRemaining)
  ];
}

// The records a push carries: the three most constrained, then each named
// provider's lowest accounts, named accounts and the recent client's records.
function liveActivityProviders(stats, preferences, recentClient) {
  const ranked = rankedProviders(stats, preferences);
  const selected = ranked.slice(0, RANKED_QUOTAS);
  const add = (provider) => {
    if (provider && !selected.includes(provider) && selected.length < MAX_QUOTAS) selected.push(provider);
  };
  const named = [...(preferences?.providerIDs || []), recentClient].filter(Boolean);
  for (const id of named) {
    ranked.filter((provider) => normalizedProvider(provider.provider) === id)
      .slice(0, MAX_ACCOUNTS_PER_PROVIDER)
      .forEach(add);
  }
  for (const key of preferences?.accountKeys || []) {
    add(ranked.find((provider) => normalizedString(provider.accountKey, 128) === key));
  }
  return selected;
}

function sourceTimestamp(value, nowMs) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs ? parsed : null;
}

function appleSeconds(timestampMs) {
  return timestampMs === null ? null
    : Math.floor(timestampMs / 1000) - DATE_REFERENCE_SECONDS;
}

// The top-level timestamp describes the usage feed (devices first, then the
// stats envelope) — the quota carries its own updatedAt/stale.
function activitySource(stats, nowMs) {
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  let milliseconds;
  let stale;
  if (devices.length) {
    const timestamps = devices.map((device) => sourceTimestamp(device?.updatedAt, nowMs))
      .filter((value) => value !== null);
    milliseconds = timestamps.length ? Math.max(...timestamps) : null;
    stale = devices.every((device) => device?.stale === true);
  } else {
    milliseconds = sourceTimestamp(stats?.updatedAt, nowMs);
    stale = false;
  }
  return {
    // An unknown source must never acquire the transport's current timestamp.
    updatedAt: appleSeconds(milliseconds) ?? -DATE_REFERENCE_SECONDS,
    sourceStale: stale || milliseconds === null || nowMs - milliseconds >= STALE_AGE_SECONDS * 1000
  };
}

function liveActivityStaleDate(contentState, timestamp) {
  const updatedAt = contentState?.updatedAt;
  const sourceSeconds = typeof updatedAt === 'number' && Number.isFinite(updatedAt)
    ? Math.floor(updatedAt + DATE_REFERENCE_SECONDS)
    : null;
  if (sourceSeconds === null || sourceSeconds > timestamp) return timestamp;
  const deadline = sourceSeconds + STALE_AGE_SECONDS;
  // Explicit stale status can precede the fifteen-minute age threshold.
  return contentState?.sourceStale === true ? Math.min(deadline, timestamp) : deadline;
}

function timestampMs(value) {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : null;
}

// Drops null and empty fields so the push stays well inside 4 KB; the Swift
// decoder treats a missing optional as nil.
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function quotaWindow(provider, providerID, window) {
  const isCredits = window?.metric === 'credits';
  const credits = isCredits
    ? asNumber(window?.remaining) ?? asNumber(provider?.balance?.amount)
    : null;
  const currency = isCredits
    ? normalizedString(window?.currency, 8).toUpperCase()
      || normalizedString(provider?.balance?.currency, 8).toUpperCase() || null
    : null;
  const windowMinutes = asNumber(window?.windowMinutes);
  return compact({
    label: limitWindowLabel(providerID, window, 'Quota'),
    // The kind lets a slot ask for "the weekly window" rather than a position.
    kind: normalizedString(window?.kind, 24).toLowerCase() || null,
    remainingPercent: providerWindowRemaining(provider, window),
    resetsAt: appleSeconds(sourceTimestamp(window?.resetsAt, Number.MAX_SAFE_INTEGER)),
    windowMinutes: windowMinutes !== null && windowMinutes > 0 ? windowMinutes : null,
    creditsAmount: credits,
    creditsCurrency: currency
  });
}

function liveActivityQuota(provider, nowMs) {
  const providerID = normalizedProvider(provider.provider);
  return compact({
    providerID,
    accountKey: normalizedString(provider.accountKey, 128) || null,
    planLabel: normalizedString(provider.planLabel) || normalizedString(provider.accountLabel) || null,
    updatedAt: appleSeconds(sourceTimestamp(provider.updatedAt, nowMs)),
    stale: provider.stale === true || null,
    windows: canonicalWindows(provider).slice(0, MAX_WINDOWS)
      .map((window) => quotaWindow(provider, providerID, window))
  });
}

// Mirrors UsagePeriod.averageOutputTokensPerSecond: only output that carries
// its own duration counts, capped at the period's output.
function outputTokensPerSecond(period) {
  if (period?.capabilities?.throughput === false) return null;
  const timedOutput = asNumber(period?.timedOutputTokens);
  const durationMs = asNumber(period?.timedDurationMs);
  if (timedOutput === null || timedOutput <= 0 || durationMs === null || durationMs <= 0) return null;
  const output = asNumber(period?.outputTokens);
  const speed = Math.min(timedOutput, output !== null && output >= 0 ? output : timedOutput) / (durationMs / 1000);
  return Number.isFinite(speed) && speed > 0 ? Math.round(speed * 10) / 10 : null;
}

function periodUsage(period) {
  return compact({
    tokens: asNumber(period?.totalTokens),
    costUSD: asNumber(period?.costUsd),
    outputTPS: outputTokensPerSecond(period)
  });
}

function sessionEntries(stats) {
  const seen = new Set();
  const entries = [];
  for (const period of ['today', 'month']) {
    const sessions = stats?.periods?.[period]?.sessions;
    if (!sessions || typeof sessions !== 'object') continue;
    for (const [key, session] of Object.entries(sessions)) {
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(session);
    }
  }
  return entries;
}

// The most recently used client — the desktop's "most recently active tool" —
// with its own share of each period, for slots scoped to that tool.
function liveRecent(stats) {
  let client = null;
  let latest = -Infinity;
  for (const session of sessionEntries(stats)) {
    const id = normalizedProvider(session?.client);
    const at = timestampMs(session?.lastUsedAt);
    if (id && at !== null && at > latest) {
      latest = at;
      client = id;
    }
  }
  if (!client) return null;
  const share = (period) => compact({
    tokens: asNumber(stats?.periods?.[period]?.clients?.[client]),
    costUSD: asNumber(stats?.periods?.[period]?.clientCosts?.[client])
  });
  return { client, today: share('today'), month: share('month') };
}

function runningSessions(stats, nowMs) {
  return sessionEntries(stats)
    .filter((session) => sessionActivityState(session, nowMs) === 'running')
    .map((session) => ({ client: normalizedProvider(session?.client), lastMs: timestampMs(session?.lastUsedAt) }))
    .sort((left, right) => right.lastMs - left.lastMs);
}

// Running agents, most recent first. Clients are distinct ids for the marks;
// `running` counts sessions, so two Claude sessions read as 2.
function liveAgents(stats, nowMs) {
  const running = runningSessions(stats, nowMs);
  const clients = [...new Set(running.map((session) => session.client).filter(Boolean))]
    .slice(0, MAX_AGENT_CLIENTS);
  return { running: running.length, clients };
}

// When the running count next changes on its own. A session that goes quiet
// writes nothing, so no ingest would trigger the push that clears it.
function liveActivityRefreshAt(stats, nowMs = Date.now()) {
  const expiries = runningSessions(stats, nowMs)
    .map((session) => session.lastMs + RUNNING_WINDOW_MS + 1)
    .filter((expiry) => expiry > nowMs);
  return expiries.length ? Math.min(...expiries) : null;
}

function buildLiveActivityContentState(stats, registration, nowMs = Date.now()) {
  const preferences = registration?.preferences || {};
  const recent = liveRecent(stats);
  return compact({
    ...activitySource(stats, nowMs),
    usage: {
      today: periodUsage(stats?.periods?.today),
      month: periodUsage(stats?.periods?.month)
    },
    recent,
    quotas: liveActivityProviders(stats, preferences, recent?.client)
      .map((provider) => liveActivityQuota(provider, nowMs)),
    agents: liveAgents(stats, nowMs)
  });
}

module.exports = {
  liveActivityRefreshAt,
  liveActivityStaleDate,
  buildLiveActivityContentState,
  normalizeLiveActivityRegistration
};
