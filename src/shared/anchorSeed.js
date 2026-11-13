'use strict';

const { collectorAnchorTrust, computePeriodWindows, qoderCnSourcesForClients } = require('./collector');
const { mergePeriods } = require('./usage');
const { filterReasonixSyntheticSessions } = require('./providers/reasonix/sessionGuard');

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
// being replaced. Seeding then adds one rule of its own, below. Unlike the
// collector, the seed also takes an anchor from an earlier day: the record keeps
// that day's windows, so aggregation drops a Today (and a Month) that has since
// ended, the way it does for any device that last reported before midnight. It
// also takes one from before a pricing or tokscale binary change (every app
// update is one): the tokens are last-known values like the rest, and the
// costs are the previous prices' until the first scan reprices them.
// Returns a device record, or null when the anchor cannot be used.
function deviceRecordFromAnchor(saved, options = {}) {
  const {
    envelope = {},
    clients = '',
    allTimeSince = '',
    projectsEnabled = true,
    qoderCnDbPath: qoderCnDbPathOption,
    qoderCnProjectsDir: qoderCnProjectsDirOption,
    customScanPaths = null,
    homeDir,
    env,
    sourcePlatform,
    wslScanEnabled = false,
    wslSupported = false,
    hostname = '',
    platform = '',
    now = new Date()
  } = options;
  const qoderCnSources = qoderCnSourcesForClients(clients, { homeDir, env, platform: sourcePlatform });
  const qoderCnDbPath = qoderCnDbPathOption === undefined ? qoderCnSources.dbPath : qoderCnDbPathOption;
  const qoderCnProjectsDir = qoderCnProjectsDirOption === undefined ? qoderCnSources.projectsDir : qoderCnProjectsDirOption;
  const trust = collectorAnchorTrust(saved, { ...options, platform: sourcePlatform || process.platform, clients, allTimeSince, projectsEnabled, qoderCnDbPath, qoderCnProjectsDir, customScanPaths, now, allowEarlierDay: true, allowRepricing: true });
  if (!trust) return null;
  const anchorDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(saved.dateKey);
  if (!anchorDay) return null;
  const anchorWindows = computePeriodWindows(new Date(Number(anchorDay[1]), Number(anchorDay[2]) - 1, Number(anchorDay[3])));
  // Native views are shown per window with no date of their own, so an ended
  // window's views are dropped here rather than left to aggregation.
  const currentWindows = computePeriodWindows(now);
  const ended = ['today', 'month'].filter(period => anchorWindows[period].key !== currentWindows[period].key);
  const nativeView = view => (ended.length && view && typeof view === 'object'
    ? { ...view, ...Object.fromEntries(ended.map(period => [period, {}])) }
    : view);
  // The seed's own rule, and the one place it is stricter than the collector.
  // A capture time the collector cannot trust only costs it a full scan, but
  // here that timestamp becomes the record's updatedAt and the instant the
  // archive projection is evaluated at, so a snapshot of unknown age must not
  // be presented as one taken now.
  if (trust.capturedAtMs === null) return null;
  // The anchor keeps host periods and the WSL bundle apart, the way
  // collectUsageOnce does before summing them. Both were written by the same
  // full scan, so all three windows are safe to merge.
  const wsl = wslScanEnabled === true ? saved.wslBundle : null;
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
    : wslScanEnabled !== true
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
    // They are the anchor's own day, not now: an earlier day's Today must read
    // as ended rather than as today's.
    periodWindows: anchorWindows,
    today: withWsl(saved.today, wsl?.today),
    month: withWsl(saved.month, wsl?.month),
    allTime: withWsl(saved.allTime, wsl?.allTime),
    ...(Object.prototype.hasOwnProperty.call(saved, 'nativeSessions') ? { nativeSessions: nativeView(saved.nativeSessions) } : {}),
    ...(Object.prototype.hasOwnProperty.call(saved, 'nativeProjects') ? { nativeProjects: nativeView(saved.nativeProjects) } : {})
  };
}

// The first scan of a run publishes nothing until all three windows are in, so
// a Today-only preview would otherwise wait behind the much slower all-time
// scan. Each window the preview has replaces the seed's, with the window the
// scan collected it in, and the rest stay the seed's last known values until the
// complete record replaces the lot. Limits fetched meanwhile come along. Without
// a seed, pass the preview as its own base. Display only; the seed's windows are
// never summed with the preview's.
function seedWithColdPreview(seed, preview, now = new Date()) {
  const windows = preview?.periodWindows || computePeriodWindows(now);
  const record = { ...seed, periodWindows: { ...seed.periodWindows } };
  if (Object.prototype.hasOwnProperty.call(preview || {}, 'limits')) record.limits = preview.limits;
  for (const period of ['today', 'month', 'allTime']) {
    if (!Object.prototype.hasOwnProperty.call(preview || {}, period)) continue;
    record[period] = preview[period];
    if (windows[period]) record.periodWindows[period] = windows[period];
  }
  return record;
}

module.exports = {
  deviceRecordFromAnchor,
  seedWithColdPreview
};
