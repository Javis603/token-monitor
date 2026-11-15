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
  const hashState = { h1: 0, h2: 0 };
  const numberView = new DataView(new ArrayBuffer(8));

  function feedCode(code) {
    hashState.h1 = Math.imul(hashState.h1 ^ code, 0x01000193) >>> 0;
    hashState.h2 = Math.imul(hashState.h2 ^ code, 0x85ebca6b) >>> 0;
  }

  function feedString(text) {
    for (let i = 0; i < text.length; i += 1) feedCode(text.charCodeAt(i));
    feedCode(0);
  }

  function feedNumber(value) {
    numberView.setFloat64(0, value);
    feedCode(numberView.getUint32(0));
    feedCode(numberView.getUint32(4));
  }

  // Hash the row in place instead of JSON.stringify-ing it: a visible widget
  // pushes every few seconds, and allocating a ~2 MB string tree on the main
  // thread was itself a heap-churn source. The tags keep values of different
  // types distinct; object key order is whatever the immutable row has.
  function hashValue(value, depth) {
    if (depth > 20) throw new Error('stats row too deep');
    if (value === null) { feedCode(0x6e); return; }
    const type = typeof value;
    if (type === 'number') { feedCode(0x64); feedNumber(value); return; }
    if (type === 'string') { feedCode(0x73); feedString(value); return; }
    if (type === 'boolean') { feedCode(value ? 0x74 : 0x66); return; }
    if (type === 'undefined') { feedCode(0x75); return; }
    if (type === 'bigint') { feedCode(0x62); feedString(value.toString()); return; }
    if (Array.isArray(value)) {
      feedCode(0x61);
      feedNumber(value.length);
      for (const item of value) hashValue(item, depth + 1);
      return;
    }
    if (type === 'object') {
      feedCode(0x6f);
      const keys = Object.keys(value);
      feedNumber(keys.length);
      for (const key of keys) {
        feedString(key);
        hashValue(value[key], depth + 1);
      }
      return;
    }
    feedCode(0x78);
  }

  function hashRow(row) {
    hashState.h1 = 0x811c9dc5;
    hashState.h2 = 0x9e3779b9;
    try {
      hashValue(row, 0);
    } catch (_) {
      return null;
    }
    return `${hashState.h1.toString(36)}:${hashState.h2.toString(36)}`;
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
        const remove = changes?.remove;
        const upsert = changes?.upsert;
        const upsertKeys = upsert ? Object.keys(upsert) : [];
        if (remove?.length || upsertKeys.length) {
          const sessions = { ...(previousPeriod.sessions || {}) };
          for (const key of remove || []) delete sessions[key];
          for (const key of upsertKeys) sessions[key] = upsert[key];
          periods[period] = { ...summary, sessions };
        } else if (previousPeriod.sessions !== undefined) {
          // No row changes: reuse the map. Cloning the all-time table on every
          // push would allocate a large tree only for the caller to discard it.
          periods[period] = { ...summary, sessions: previousPeriod.sessions };
        } else if (changes) {
          periods[period] = { ...summary, sessions: {} };
        } else {
          periods[period] = summary;
        }
      } else if (changes) {
        periods[period] = { ...summary, sessions: { ...(changes.upsert || {}) } };
      } else {
        periods[period] = summary;
      }
    }
    return { ...delta.stats, snapshot: delta.snapshot, periods };
  }

  return { applyStatsDelta, buildStatsDelta, fingerprintStats };
});
