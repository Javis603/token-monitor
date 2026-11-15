'use strict';

// A visible widget receives a full stats tree every few seconds. The period
// summaries are small; the session maps are most of the payload. Send only the
// rows that changed and let the renderer splice them into the snapshot it
// already holds. The main process keeps a compact fingerprint (one hash per
// session) instead of a second full tree, and the renderer falls back to a full
// read whenever its base snapshot does not match (reload, Hub switch, a lost
// push).
(function exposeStatsDelta(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorStatsDelta = api;
})(typeof window !== 'undefined' ? window : null, function createStatsDeltaApi() {
  function hashRow(row) {
    let text;
    try {
      text = JSON.stringify(row);
    } catch (_) {
      return null;
    }
    if (typeof text !== 'string') return null;
    // Two independent 32-bit FNV-style accumulators: sessions can be numerous,
    // and a 64-bit fingerprint makes an accidental miss negligible. A row that
    // cannot be stringified is always sent rather than silently skipped.
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
    }
    return `${h1.toString(36)}:${h2.toString(36)}`;
  }

  function fingerprintStats(stats) {
    if (!stats || typeof stats !== 'object' || !stats.snapshot || stats.snapshot.id === undefined) return null;
    const sessions = {};
    for (const [period, value] of Object.entries(stats.periods || {})) {
      if (!value || typeof value !== 'object' || !value.sessions || typeof value.sessions !== 'object') continue;
      const hashes = {};
      for (const [key, row] of Object.entries(value.sessions)) hashes[key] = hashRow(row);
      sessions[period] = hashes;
    }
    return { snapshot: { ...stats.snapshot }, sessions };
  }

  // `previous` is a fingerprint, not a stats tree. Returns `delta: null` when a
  // full snapshot is required (first send, source change, same snapshot), plus
  // the fingerprint of `next` so the caller hashes each row only once.
  function buildStatsDelta(previous, next) {
    const fingerprint = fingerprintStats(next);
    if (!previous || !fingerprint || !previous.snapshot?.id
      || previous.snapshot.id === fingerprint.snapshot.id
      || previous.snapshot.source !== fingerprint.snapshot.source) {
      return { delta: null, fingerprint };
    }
    const stats = { ...next };
    delete stats.snapshot;
    const periods = {};
    const sessions = {};
    for (const [period, value] of Object.entries(next.periods || {})) {
      if (!value || typeof value !== 'object' || !value.sessions || typeof value.sessions !== 'object') {
        periods[period] = value;
        continue;
      }
      const { sessions: rows, ...summary } = value;
      periods[period] = summary;
      const previousHashes = previous.sessions?.[period] || {};
      const nextHashes = fingerprint.sessions?.[period] || {};
      const upsert = {};
      const remove = [];
      for (const [key, row] of Object.entries(rows)) {
        const hash = nextHashes[key];
        if (hash === null || previousHashes[key] !== hash) upsert[key] = row;
      }
      for (const key of Object.keys(previousHashes)) {
        if (!Object.hasOwn(rows, key)) remove.push(key);
      }
      sessions[period] = { upsert, remove };
    }
    stats.periods = periods;
    return {
      delta: {
        baseSnapshot: { ...previous.snapshot },
        snapshot: { ...fingerprint.snapshot },
        stats,
        sessions
      },
      fingerprint
    };
  }

  function applyStatsDelta(current, delta) {
    if (!current || !delta?.baseSnapshot || !delta.snapshot) return null;
    const base = current.snapshot;
    if (!base || base.id !== delta.baseSnapshot.id || base.source !== delta.baseSnapshot.source) return null;
    const periods = {};
    for (const [period, summary] of Object.entries(delta.stats?.periods || {})) {
      const previousPeriod = current.periods?.[period];
      const changes = delta.sessions?.[period];
      if (previousPeriod && typeof previousPeriod === 'object') {
        const sessions = { ...(previousPeriod.sessions || {}) };
        if (changes) {
          for (const key of changes.remove || []) delete sessions[key];
          for (const [key, row] of Object.entries(changes.upsert || {})) sessions[key] = row;
        }
        periods[period] = (previousPeriod.sessions !== undefined || changes)
          ? { ...summary, sessions } : summary;
      } else if (changes) {
        periods[period] = { ...summary, sessions: { ...(changes.upsert || {}) } };
      } else {
        periods[period] = summary;
      }
    }
    return { ...current, ...delta.stats, snapshot: delta.snapshot, periods };
  }

  return { applyStatsDelta, buildStatsDelta, fingerprintStats };
});
