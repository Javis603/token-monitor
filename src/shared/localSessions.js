'use strict';

// `allTime.sessions` is an unbounded, ever-growing collection, so syncPayload drops it
// from uploads to keep them under the hub's ingest limit (#118). That leaves the hub's
// aggregate with no all-time session detail, which would blank the TOTAL session view (it
// falls back to a model list). Rebuild the view-layer all-time session map from what is
// actually available:
//   - the hub's cross-device month sessions as the immediate, always-synced baseline
//     (today ⊆ month, so month already covers today) — this is what shows on the first
//     frame after launch, before this machine's own scan has run;
//   - the local device's authoritative all-time sessions, merged last (free — already
//     collected in-process) so its full history replaces the month-scoped value for the
//     same session once the scan lands (~seconds after launch).
// Passing a null/absent localDevice yields just the month baseline, which is exactly the
// desired startup placeholder.

function asSessions(value) {
  return value && typeof value === 'object' ? value : null;
}

function mergedLocalAllTimeSessions(periods, localDevice) {
  return {
    ...asSessions(periods?.month?.sessions),
    ...asSessions(periods?.allTime?.sessions),
    ...asSessions(localDevice?.allTime?.sessions)
  };
}

module.exports = { mergedLocalAllTimeSessions };
