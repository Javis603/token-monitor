'use strict';

const { collectorAnchorTrust, computePeriodWindows, qoderCnDbPathForClients } = require('./collector');
const { mergePeriods } = require('./usage');
const { filterReasonixSyntheticSessions } = require('./reasonixSessionGuard');

// The collector persists every full scan to collector-anchor.json so it can
// derive month/allTime from a `--today` scan after a restart. A widget cold
// start reuses that same file for a second purpose: putting real numbers on
// screen immediately instead of zeros for the length of the first full scan
// (today + month + `--since allTimeSince`, run serially to avoid the CPU spike
// from issue #15).
//
// Whether the anchor may be reused at all is collectorAnchorTrust's call, shared
// with startCollector so the two cannot drift: an anchor the collector is about
// to discard would otherwise show the previous configuration's totals for a
// minute and then drop them, which reads as a counting bug rather than a seed
// being replaced. Seeding then adds one rule of its own, below.
// Returns a device record, or null when the anchor cannot be used.
function deviceRecordFromAnchor(saved, options = {}) {
  const {
    envelope = {},
    clients = '',
    allTimeSince = '',
    projectsEnabled = true,
    qoderCnDbPath: qoderCnDbPathOption,
    homeDir,
    wslScanEnabled = true,
    wslSupported = false,
    hostname = '',
    platform = '',
    now = new Date()
  } = options;
  const qoderCnDbPath = qoderCnDbPathOption === undefined
    ? qoderCnDbPathForClients(clients, { homeDir })
    : qoderCnDbPathOption;
  const trust = collectorAnchorTrust(saved, { clients, allTimeSince, projectsEnabled, qoderCnDbPath, now });
  if (!trust) return null;
  // The seed's own rule, and the one place it is stricter than the collector.
  // A capture time the collector cannot trust only costs it a full scan, but
  // here that timestamp becomes the record's updatedAt and the instant the
  // archive projection is evaluated at, so a snapshot of unknown age must not
  // be presented as one taken now.
  if (trust.capturedAtMs === null) return null;
  // The anchor keeps host periods and the WSL bundle apart, the way
  // collectUsageOnce does before summing them. Same local day is established
  // above, so all three windows are safe to merge.
  const wsl = wslScanEnabled !== false ? saved.wslBundle : null;
  const cleanPeriod = (period) => {
    if (!period || typeof period !== 'object' || !Object.prototype.hasOwnProperty.call(period, 'sessions')) return period;
    const sessions = filterReasonixSyntheticSessions(period.sessions);
    return sessions === period.sessions ? period : { ...period, sessions };
  };
  const withWsl = (period, wslPeriod) => cleanPeriod(wslPeriod ? mergePeriods(period, wslPeriod) : period);
  // Mirrors collectUsageOnce: a non-Windows host reports no WSL status at all,
  // a Windows host with scanning off reports it as disabled rather than absent,
  // and otherwise the anchor's own snapshot stands until the first scan. Absent
  // and disabled are different states downstream, so the distinction is kept.
  const wslStatus = !wslSupported
    ? null
    : wslScanEnabled === false
      ? { state: 'disabled', detected: [], withData: [] }
      : (saved.wslStatus || null);
  const at = new Date(trust.capturedAtMs).toISOString();
  return {
    ...envelope,
    hostname,
    platform,
    updatedAt: at,
    receivedAt: at,
    trackedClients: String(clients || '').split(',').filter(Boolean),
    // Both drive UI beyond the totals: projectsEnabled decides whether the
    // all-time project breakdown is flagged incomplete, wslStatus feeds the
    // attribution panel. Leaving them off makes the seed a record that looks
    // subtly unlike the one replacing it.
    projectsEnabled,
    ...(wslStatus ? { wslStatus } : {}),
    // Required, not decorative. Without them aggregateDevices falls back to
    // comparing UTC days, and anywhere ahead of UTC a local day that has not
    // rolled over in UTC yet reads as an expired window: today's tokens get
    // dropped and the card shows the zero this whole path exists to avoid.
    periodWindows: computePeriodWindows(now),
    today: withWsl(saved.today, wsl?.today),
    month: withWsl(saved.month, wsl?.month),
    allTime: withWsl(saved.allTime, wsl?.allTime),
    ...(Object.prototype.hasOwnProperty.call(saved, 'nativeSessions') ? { nativeSessions: saved.nativeSessions } : {}),
    ...(Object.prototype.hasOwnProperty.call(saved, 'nativeProjects') ? { nativeProjects: saved.nativeProjects } : {})
  };
}

module.exports = {
  deviceRecordFromAnchor
};
