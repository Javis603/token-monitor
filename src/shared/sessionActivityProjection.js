'use strict';

// Local activity is metadata, not a new accounting observation. Each usage
// snapshot keeps bounded lookup caches; polls address reported IDs and leases
// needing clearing. Historical accounting maps remain the source of truth.
(function expose(root, factory) {
  const live = typeof module === 'object' && module.exports ? require('./sessionLive') : root.TokenMonitorSessionLive;
  const providers = typeof module === 'object' && module.exports ? require('./sessionActivityProviders') : root.TokenMonitorSessionActivityProviders;
  const api = factory(live, providers);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSessionActivityProjection = api;
})(typeof window !== 'undefined' ? window : null, function createApi(live, providers) {
  const indexes = new WeakMap();
  const names = ['today', 'month', 'allTime'];
  const LOOKUP_CACHE_LIMIT = 512;
  const clients = providers.SESSION_ACTIVITY_CLIENTS;
  const { isSessionActivityClient } = providers;
  function periods(summary) { return summary?.periods || summary; }
  function remember(cache, key, value) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > LOOKUP_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return value;
  }
  function cached(cache, key) {
    if (!cache.has(key)) return;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }
  function indexFor(summary) {
    let index = indexes.get(summary);
    if (index) return index;
    index = { lookup: { rows: new Map(), hints: new Map(), hintSize: 0, legacyPeriods: new Set() },
      leased: new Map(clients.map((client) => [client, new Set()])) };
    // A copied/materialized publication can carry live leases. Recover only
    // those observations, without retaining historical identities or locations
    // and without allocating Object.entries() for the full accounting maps.
    const clock = Date.parse(summary?.updatedAt);
    for (const name of names) {
      const period = periods(summary)?.[name];
      for (const key in period?.sessions) {
        if (!Object.prototype.hasOwnProperty.call(period.sessions, key)) continue;
        const row = period.sessions[key];
        if (!index.leased.has(row?.client)) continue;
        if (key !== `${row.client}:${row.sessionId}`) index.lookup.legacyPeriods.add(name);
        if (live.isArchivedSession(row)) continue;
        const reading = live.normalizeLiveActivity(period.sessionActivity?.[key] || row.liveActivity);
        if (reading && reading.state !== 'unknown'
          && (!Number.isFinite(clock) || Date.parse(reading.observedAt) + live.LIVE_ACTIVITY_TTL_MS > clock)) {
          index.leased.get(row.client).add(row.sessionId);
        }
      }
    }
    indexes.set(summary, index);
    return index;
  }
  function locationsFor(summary, client, id) {
    const { rows: lookup, legacyPeriods } = indexFor(summary).lookup;
    const key = `${client}:${id}`;
    const hit = cached(lookup, key);
    if (hit) return hit;
    const result = [];
    // Collector and normalized presentation maps already use client:sessionId
    // keys. No second identity index is needed, even for an old resumed session.
    for (const name of names) {
      const sessions = periods(summary)?.[name]?.sessions;
      if (legacyPeriods.has(name)) {
        // Raw, unnormalized callers can use arbitrary keys. Only those maps
        // require a cold lookup; they still share the same bounded cache.
        for (const rawKey in sessions) {
          if (!Object.prototype.hasOwnProperty.call(sessions, rawKey)) continue;
          const row = sessions[rawKey];
          if (row?.client === client && row.sessionId === id) result.push({ name, key: rawKey });
        }
      } else {
        const row = sessions?.[key];
        if (row?.client === client && row.sessionId === id) result.push({ name, key });
      }
    }
    return remember(lookup, key, result);
  }
  function hasKnownSession(summary, client, id, periodName) {
    const locations = locationsFor(summary, client, id);
    return periodName ? locations.some((row) => row.name === periodName) : locations.length > 0;
  }
  function nativeSessionsForPeriod(summary, client, sessions, name) {
    return Object.fromEntries(Object.entries(sessions).filter(([, row]) =>
      !hasKnownSession(summary, client, row.sessionId, name)));
  }
  function activityEntries(summary, client, ids, includeLeased = true) {
    const index = indexFor(summary);
    const selected = new Set(ids);
    if (includeLeased) for (const id of index.leased.get(client) || []) selected.add(id);
    const result = [];
    for (const id of selected) for (const location of locationsFor(summary, client, id)) {
      const session = live.sessionWithActivity(periods(summary)[location.name], location.key);
      if (session && !live.isArchivedSession(session)) result.push({ ...location, session });
    }
    return result;
  }
  function rememberHint(lookup, id, matches) {
    const previous = lookup.hints.get(id);
    if (previous) {
      lookup.hintSize -= Math.max(1, previous.length);
      lookup.hints.delete(id);
    }
    const size = Math.max(1, matches.length);
    if (size > LOOKUP_CACHE_LIMIT) return;
    while (lookup.hintSize + size > LOOKUP_CACHE_LIMIT) {
      const oldest = lookup.hints.keys().next().value;
      lookup.hintSize -= Math.max(1, lookup.hints.get(oldest).length);
      lookup.hints.delete(oldest);
    }
    lookup.hints.set(id, matches);
    lookup.hintSize += size;
  }
  function codexActivityCandidates(summary, ids, files = new Map()) {
    const lookup = indexFor(summary).lookup;
    const pending = new Map();
    const result = new Set();
    const wanted = new Set(ids);
    const verified = new Map();
    for (const [id, file] of files) if (wanted.has(file.nativeId) && hasKnownSession(summary, 'codex', id)) {
      if (!verified.has(file.nativeId)) verified.set(file.nativeId, []);
      verified.get(file.nativeId).push(id);
    }
    for (const id of wanted) {
      const matches = verified.get(id) || cached(lookup.hints, id);
      if (matches) {
        for (const candidate of matches) result.add(candidate);
        if (verified.has(id)) rememberHint(lookup, id, matches);
      } else if (hasKnownSession(summary, 'codex', id)) {
        result.add(id);
        rememberHint(lookup, id, [id]);
      } else pending.set(id, new Set());
    }
    // Catalog/header matches are the common path. If an old rollout is absent
    // from discovery, search the existing maps once for just the missing native
    // IDs. Cache hits and misses with a bound on total retained candidate IDs.
    if (pending.size) for (const name of names) {
      const sessions = periods(summary)?.[name]?.sessions;
      for (const key in sessions) {
        if (!Object.prototype.hasOwnProperty.call(sessions, key)) continue;
        const row = sessions[key];
        if (row?.client !== 'codex' || live.isArchivedSession(row)) continue;
        // Filenames can include more than one UUID. These are candidates only;
        // the adapter verifies session_meta before accepting a native identity.
        const suffix = String(row.sessionId).match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/)?.[1] || row.sessionId;
        const hints = String(suffix).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [suffix];
        for (const hint of hints) pending.get(hint)?.add(row.sessionId);
      }
    }
    for (const [id, matches] of pending) {
      const candidates = [...matches];
      rememberHint(lookup, id, candidates);
      for (const candidate of candidates) result.add(candidate);
    }
    return result;
  }
  function rememberProjection(previous, next, observations = []) {
    if (!next) return;
    const old = indexFor(previous);
    const leased = new Map([...old.leased].map(([client, ids]) => [client, new Set(ids)]));
    for (const row of observations) {
      if (row.liveActivity.state === 'unknown') leased.get(row.client)?.delete(row.sessionId);
      else leased.get(row.client)?.add(row.sessionId);
    }
    const sameAccounting = names.every((name) => periods(previous)?.[name]?.sessions === periods(next)?.[name]?.sessions);
    if (sameAccounting) indexes.set(next, { lookup: old.lookup, leased });
  }
  function activityPatch(previous, next) {
    const observations = new Map();
    for (const client of clients) {
      const ids = new Set([...indexFor(previous).leased.get(client), ...indexFor(next).leased.get(client)]);
      for (const { name, key, session } of activityEntries(next, client, ids)) {
        const before = live.sessionWithActivity(periods(previous)?.[name], key)?.liveActivity;
        if (session.liveActivity && (before?.state !== session.liveActivity.state || before?.observedAt !== session.liveActivity.observedAt)) {
          observations.set(`${client}:${session.sessionId}`, { client, sessionId: session.sessionId, liveActivity: session.liveActivity });
        }
      }
    }
    const nativeSessions = {};
    for (const name of names) nativeSessions[name] = Object.fromEntries(Object.entries(next.nativeSessions?.[name] || {})
      .filter(([, row]) => isSessionActivityClient(row.client)));
    return { observations: [...observations.values()], nativeSessions };
  }
  function applyActivityPatch(summary, patch) {
    if (!summary || !patch) return summary;
    const source = periods(summary);
    let result = summary;
    const maps = new Map();
    const accepted = [];
    for (const row of patch.observations || []) {
      if (!isSessionActivityClient(row.client)) continue;
      const observation = live.normalizeLiveActivity(row.liveActivity);
      if (!observation) continue;
      for (const { name, key, session } of activityEntries(summary, row.client, [row.sessionId], false)) {
        if (!live.canReplaceLiveActivity(session.liveActivity, observation)) continue;
        if (session.liveActivity?.state === observation.state && session.liveActivity?.observedAt === observation.observedAt) continue;
        if (!maps.has(name)) maps.set(name, compactActivity(source[name], Date.parse(observation.observedAt)));
        maps.get(name)[key] = observation;
        accepted.push({ ...row, liveActivity: observation });
      }
    }
    if (maps.size) {
      const nextPeriods = { ...source };
      for (const [name, sessionActivity] of maps) nextPeriods[name] = { ...source[name], sessionActivity };
      result = summary.periods ? { ...summary, periods: nextPeriods } : nextPeriods;
    }
    if (patch.nativeSessions) {
      const nativeSessions = {};
      for (const name of names) {
        const other = Object.fromEntries(Object.entries(summary.nativeSessions?.[name] || {})
          .filter(([, row]) => !isSessionActivityClient(row.client)));
        nativeSessions[name] = { ...other, ...patch.nativeSessions[name] };
      }
      result = { ...result, nativeSessions };
    }
    rememberProjection(summary, result, accepted);
    return result;
  }
  function compactActivity(period, clock) {
    return Object.fromEntries(Object.entries(period?.sessionActivity || {}).filter(([, reading]) =>
      Date.parse(reading.observedAt) + live.LIVE_ACTIVITY_TTL_MS > clock));
  }
  function needsActivityRenewal(summary) {
    if (!summary) return false;
    for (const client of clients) for (const { session } of activityEntries(summary, client, [])) {
      const state = session.liveActivity?.state;
      if (state === 'running' || state === 'waiting') return true;
      if (state === 'idle' && ['running', 'waiting'].includes(live.sessionActivityState({ ...session, liveActivity: undefined }))) return true;
    }
    return Object.values(summary.nativeSessions?.today || {}).some((row) =>
      isSessionActivityClient(row.client) && ['running', 'waiting'].includes(live.sessionActivityState(row)));
  }
  function materializeActivity(summary) {
    if (!summary) return summary;
    const source = periods(summary);
    let result = summary;
    for (const name of names) {
      const period = source[name];
      if (!period?.sessionActivity) continue;
      const sessions = { ...period.sessions };
      for (const key of Object.keys(period.sessionActivity)) if (sessions[key]) sessions[key] = live.sessionWithActivity(period, key, sessions[key]);
      const next = { ...period, sessions };
      delete next.sessionActivity;
      if (result === summary) result = summary.periods ? { ...summary, periods: { ...source } } : { ...summary };
      periods(result)[name] = next;
    }
    return result;
  }
  function invalidateActivityIndex(summary) { if (summary) indexes.delete(summary); }
  return { hasKnownSession, nativeSessionsForPeriod, activityEntries, codexActivityCandidates, rememberProjection, activityPatch, applyActivityPatch,
    compactActivity, needsActivityRenewal, materializeActivity, invalidateActivityIndex };
});
