'use strict';

const { computePeriodWindows, configFingerprint, localTodayKey } = require('./collector');
const { mergePeriods } = require('./usage');

// The collector persists every full scan to collector-anchor.json so it can
// derive month/allTime from a `--today` scan after a restart. A widget cold
// start reuses that same file for a second purpose: putting real numbers on
// screen immediately instead of zeros for the length of the first full scan
// (today + month + `--since allTimeSince`, run serially to avoid the CPU spike
// from issue #15).
//
// The validation here has to be startCollector's, not a subset of it. An anchor
// the collector is about to discard, because the tracked-client list or
// allTimeSince changed, would otherwise show the previous configuration's
// totals for a minute and then drop them, which reads as a counting bug rather
// than a seed being replaced. Returns a device record, or null when the anchor
// cannot be trusted.
function deviceRecordFromAnchor(saved, options = {}) {
  const {
    envelope = {},
    clients = '',
    allTimeSince = '',
    projectsEnabled = true,
    wslScanEnabled = true,
    hostname = '',
    platform = '',
    now = new Date()
  } = options;
  if (!saved || saved.dateKey !== localTodayKey(now)) return null;
  if (!saved.today || !saved.month || !saved.allTime) return null;
  if (saved.configFingerprint !== configFingerprint(clients, allTimeSince, projectsEnabled)) return null;
  // startCollector trusts fullScanAt only when it parses and is not in the
  // future, and refuses to reuse the anchor otherwise. Seeding is stricter still
  // and declines outright: the timestamp becomes this record's updatedAt and the
  // window the archive projection is evaluated against, so a snapshot of unknown
  // age must not be presented as one taken now.
  const capturedAtMs = Date.parse(saved.fullScanAt || '');
  if (!Number.isFinite(capturedAtMs) || capturedAtMs > now.getTime()) return null;
  // The anchor keeps host periods and the WSL bundle apart, the way
  // collectUsageOnce does before summing them. Same local day is established
  // above, so all three windows are safe to merge.
  const wsl = wslScanEnabled !== false ? saved.wslBundle : null;
  const withWsl = (period, wslPeriod) => (wslPeriod ? mergePeriods(period, wslPeriod) : period);
  const at = new Date(capturedAtMs).toISOString();
  return {
    ...envelope,
    hostname,
    platform,
    updatedAt: at,
    receivedAt: at,
    trackedClients: String(clients || '').split(',').filter(Boolean),
    // Required, not decorative. Without them aggregateDevices falls back to
    // comparing UTC days, and anywhere ahead of UTC a local day that has not
    // rolled over in UTC yet reads as an expired window: today's tokens get
    // dropped and the card shows the zero this whole path exists to avoid.
    periodWindows: computePeriodWindows(now),
    today: withWsl(saved.today, wsl?.today),
    month: withWsl(saved.month, wsl?.month),
    allTime: withWsl(saved.allTime, wsl?.allTime)
  };
}

module.exports = {
  deviceRecordFromAnchor
};
