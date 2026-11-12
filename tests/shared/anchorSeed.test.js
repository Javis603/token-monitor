'use strict';

// UTC+8 with no DST. The timezone matters: the whole point of the periodWindows
// assertion below is a local day that has not rolled over in UTC yet, which only
// exists ahead of UTC.
process.env.TZ = 'Asia/Shanghai';

const assert = require('node:assert/strict');
const test = require('node:test');

const { deviceRecordFromAnchor, seedWithColdPreview } = require('../../src/shared/anchorSeed');
const { collectorAnchorTrust, configFingerprint, collectionCalendarKey } = require('../../src/shared/collector');
const { qoderCnDataPaths } = require('../../src/shared/providers/qodercn/paths');
const { aggregateDevices, emptyPeriod } = require('../../src/shared/usage');

const CLIENTS = 'claude,codex';
const ALL_TIME_SINCE = '2024-01-01';

function periodWith(totalTokens) {
  const period = emptyPeriod();
  period.totalTokens = totalTokens;
  return period;
}

// Local 2026-08-08 02:00 (UTC 2026-08-07T18:00), so the anchor lands on a local
// day whose UTC day is still the one before.
const FULL_SCAN_AT = '2026-08-07T18:00:00.000Z';
const NOW = new Date(2026, 7, 8, 10, 0, 0); // local 2026-08-08 10:00, UTC 02:00

function anchorFixture(overrides = {}) {
  return {
    dateKey: '2026-08-08',
    calendarKey: collectionCalendarKey(NOW),
    today: periodWith(1_000),
    month: periodWith(30_000),
    allTime: periodWith(900_000),
    configFingerprint: configFingerprint(CLIENTS, ALL_TIME_SINCE, true),
    fullScanAt: FULL_SCAN_AT,
    ...overrides
  };
}

function seedOptions(overrides = {}) {
  return {
    envelope: { deviceId: 'device-a', agentVersion: '9.9.9', agentRuntime: 'electron-widget' },
    clients: CLIENTS,
    allTimeSince: ALL_TIME_SINCE,
    projectsEnabled: true,
    wslScanEnabled: true,
    hostname: 'host-a',
    platform: 'darwin-arm64',
    now: NOW,
    ...overrides
  };
}

test('a matching anchor seeds a full device record', () => {
  const record = deviceRecordFromAnchor(anchorFixture(), seedOptions());

  assert.equal(record.deviceId, 'device-a');
  // Straight from the envelope. A record without them reaches the renderer as an
  // unidentified device, which is worse than the zeros this path replaces.
  assert.equal(record.agentVersion, '9.9.9');
  assert.equal(record.agentRuntime, 'electron-widget');
  assert.equal(record.hostname, 'host-a');
  assert.deepEqual(record.trackedClients, ['claude', 'codex']);
  assert.equal(record.updatedAt, FULL_SCAN_AT);
  assert.equal(record.today.totalTokens, 1_000);
  assert.equal(record.month.totalTokens, 30_000);
  assert.equal(record.allTime.totalTokens, 900_000);
  // Drives whether the all-time project breakdown is flagged incomplete, so a
  // seed without it renders differently from the record that replaces it.
  assert.equal(record.projectsEnabled, true);
  // Not a Windows host, so no WSL status at all rather than an empty one.
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'wslStatus'), false);
});

test('WSL status follows the platform and the toggle, the way a collected record does', () => {
  const wslStatus = { state: 'active', detected: ['claude'], withData: ['claude'] };

  const restored = deviceRecordFromAnchor(
    anchorFixture({ wslStatus }),
    seedOptions({ wslSupported: true, platform: 'win32-x64' })
  );
  assert.deepEqual(restored.wslStatus, wslStatus);

  // Disabled is a state the panel renders, not the same as not knowing yet.
  const off = deviceRecordFromAnchor(
    anchorFixture({ wslStatus }),
    seedOptions({ wslSupported: true, wslScanEnabled: false, platform: 'win32-x64' })
  );
  assert.deepEqual(off.wslStatus, { state: 'disabled', detected: [], withData: [] });

  const noSnapshot = deviceRecordFromAnchor(
    anchorFixture(),
    seedOptions({ wslSupported: true, platform: 'win32-x64' })
  );
  assert.equal(Object.prototype.hasOwnProperty.call(noSnapshot, 'wslStatus'), false);
});

test('the seed reports the project setting it was built under', () => {
  const off = deviceRecordFromAnchor(
    anchorFixture({ configFingerprint: configFingerprint(CLIENTS, ALL_TIME_SINCE, false) }),
    seedOptions({ projectsEnabled: false })
  );
  assert.equal(off.projectsEnabled, false);
});

test('an omitted WSL setting does not restore WSL usage or active status', () => {
  const record = deviceRecordFromAnchor(anchorFixture({
    wslBundle: { today: periodWith(9), month: periodWith(9), allTime: periodWith(9) },
    wslStatus: { state: 'active', detected: ['claude'], withData: ['claude'] }
  }), seedOptions({ wslSupported: true, wslScanEnabled: undefined }));
  assert.equal(record.today.totalTokens, 1_000);
  assert.deepEqual(record.wslStatus, { state: 'disabled', detected: [], withData: [] });
});

test('the cold-start seed accepts an anchor configured for Qoder CN', () => {
  const homeDir = '/tmp/token-monitor-qodercn-home';
  const cnPaths = qoderCnDataPaths({ homeDir });
  const clients = 'claude,qodercn';
  const anchor = anchorFixture({
    configFingerprint: configFingerprint(clients, ALL_TIME_SINCE, true, cnPaths.dbPaths[0], cnPaths.projectsDir)
  });

  const record = deviceRecordFromAnchor(anchor, seedOptions({ clients, homeDir }));
  assert.equal(record.today.totalTokens, 1_000);
  assert.deepEqual(record.trackedClients, ['claude', 'qodercn']);
});

test('the seed refuses a Qoder CN anchor that predates the JSONL source', () => {
  // A DB-only fingerprint cannot cover transcript usage: reusing it would show
  // month/allTime from before the storage migration while only today's JSONL
  // is scanned. The projects dir must be part of the trusted fingerprint.
  const homeDir = '/tmp/token-monitor-qodercn-home';
  const cnPaths = qoderCnDataPaths({ homeDir });
  const clients = 'claude,qodercn';
  const legacyAnchor = anchorFixture({
    configFingerprint: configFingerprint(clients, ALL_TIME_SINCE, true, cnPaths.dbPaths[0])
  });
  assert.equal(deviceRecordFromAnchor(legacyAnchor, seedOptions({ clients, homeDir })), null);
});

test('the seed carries local-only native Reasonix views when the anchor has them', () => {
  const nativeSessions = { today: { 'reasonix:session': { client: 'reasonix', totalTokens: 12 } }, month: {}, allTime: {} };
  const nativeProjects = { today: { 'token monitor': { label: 'Token Monitor', tokens: 12, clients: { reasonix: 12 } } }, month: {}, allTime: {} };
  const record = deviceRecordFromAnchor(anchorFixture({ nativeSessions, nativeProjects }), seedOptions());

  assert.deepEqual(record.nativeSessions, nativeSessions);
  assert.deepEqual(record.nativeProjects, nativeProjects);
});

test('the seed removes legacy Reasonix stats paths from ordinary period sessions', () => {
  const leaked = 'reasonix:reasonix-stats:/Users/test/.reasonix/stats/2026-08-09.jsonl';
  const month = periodWith(10);
  month.sessions = {
    [leaked]: { client: 'reasonix', sessionId: leaked, totalTokens: 10 }
  };
  const record = deviceRecordFromAnchor(anchorFixture({ month }), seedOptions());

  assert.deepEqual(record.month.sessions, {});
});

test('an unusable anchor is refused', () => {
  assert.equal(deviceRecordFromAnchor(null, seedOptions()), null);
  assert.equal(deviceRecordFromAnchor(anchorFixture({ month: null }), seedOptions()), null);
  // From a later day than now: a clock that went backwards, not a snapshot.
  assert.equal(deviceRecordFromAnchor(anchorFixture({ dateKey: '2026-08-09' }), seedOptions()), null);
  assert.equal(deviceRecordFromAnchor(anchorFixture({ dateKey: 'yesterday' }), seedOptions()), null);
});

// Local 2026-08-07 20:00: the last full scan before the app was closed.
const YESTERDAY_SCAN_AT = '2026-08-07T12:00:00.000Z';

test('an anchor from an earlier day seeds, and only the windows still open count', () => {
  const record = deviceRecordFromAnchor(
    anchorFixture({ dateKey: '2026-08-07', fullScanAt: YESTERDAY_SCAN_AT }),
    seedOptions()
  );
  assert.equal(record.updatedAt, YESTERDAY_SCAN_AT);
  // The anchor's own day, so yesterday's Today cannot pass for today's.
  assert.equal(record.periodWindows.today.key, '2026-08-07');

  const seeded = aggregateDevices([record], 0, NOW.getTime());
  assert.equal(seeded.periods.today.totalTokens, 0);
  assert.equal(seeded.periods.month.totalTokens, 30_000);
  assert.equal(seeded.periods.allTime.totalTokens, 900_000);
});

test('an anchor from an earlier month keeps only all-time', () => {
  const record = deviceRecordFromAnchor(
    anchorFixture({ dateKey: '2026-07-31', fullScanAt: '2026-07-31T12:00:00.000Z' }),
    seedOptions()
  );
  const seeded = aggregateDevices([record], 0, NOW.getTime());
  assert.equal(seeded.periods.today.totalTokens, 0);
  assert.equal(seeded.periods.month.totalTokens, 0);
  assert.equal(seeded.periods.allTime.totalTokens, 900_000);
});

test('the collector itself still refuses an anchor from an earlier day', () => {
  // It adds a fresh Today to the anchor's month and all-time, which is only
  // exact on the anchor's own day. The seed opts in; nothing else does.
  const anchor = anchorFixture({ dateKey: '2026-08-07', fullScanAt: YESTERDAY_SCAN_AT });
  const options = { clients: CLIENTS, allTimeSince: ALL_TIME_SINCE, projectsEnabled: true, now: NOW };
  assert.equal(collectorAnchorTrust(anchor, options), null);
  assert.ok(collectorAnchorTrust(anchor, { ...options, allowEarlierDay: true }));
});

test('first-scan previews replace the windows they carry and keep the seed for the rest', () => {
  const seed = deviceRecordFromAnchor(
    anchorFixture({ dateKey: '2026-08-07', fullScanAt: YESTERDAY_SCAN_AT }),
    seedOptions()
  );

  const todayOnly = seedWithColdPreview(seed, { deviceId: 'device-a', today: periodWith(250) }, NOW);
  assert.equal(todayOnly.periodWindows.today.key, '2026-08-08');
  // Still the seed's: the preview has not scanned month yet.
  assert.equal(todayOnly.periodWindows.month.key, '2026-08');
  assert.equal(todayOnly.updatedAt, YESTERDAY_SCAN_AT);
  let shown = aggregateDevices([todayOnly], 0, NOW.getTime());
  assert.equal(shown.periods.today.totalTokens, 250);
  assert.equal(shown.periods.month.totalTokens, 30_000);
  assert.equal(shown.periods.allTime.totalTokens, 900_000);

  const withMonth = seedWithColdPreview(seed, { today: periodWith(250), month: periodWith(41_000) }, NOW);
  shown = aggregateDevices([withMonth], 0, NOW.getTime());
  assert.equal(shown.periods.month.totalTokens, 41_000);
  assert.equal(shown.periods.allTime.totalTokens, 900_000);

  // Composed onto a copy; the seed stays what the next preview is laid over.
  assert.equal(seed.today.totalTokens, 1_000);
  assert.equal(seed.periodWindows.today.key, '2026-08-07');
});

test('a fresh month window replaces an ended one from an earlier month', () => {
  const seed = deviceRecordFromAnchor(
    anchorFixture({ dateKey: '2026-07-31', fullScanAt: '2026-07-31T12:00:00.000Z' }),
    seedOptions()
  );
  const shown = aggregateDevices([
    seedWithColdPreview(seed, { today: periodWith(250), month: periodWith(3_000) }, NOW)
  ], 0, NOW.getTime());
  assert.equal(shown.periods.today.totalTokens, 250);
  assert.equal(shown.periods.month.totalTokens, 3_000);
});

test('an anchor whose capture time cannot be trusted is refused', () => {
  // The timestamp becomes updatedAt and the instant the archive projection is
  // evaluated at, so a snapshot of unknown age must not pass as one taken now.
  assert.equal(deviceRecordFromAnchor(anchorFixture({ fullScanAt: undefined }), seedOptions()), null);
  assert.equal(deviceRecordFromAnchor(anchorFixture({ fullScanAt: 'not-a-timestamp' }), seedOptions()), null);

  const future = new Date(NOW.getTime() + 60_000).toISOString();
  assert.equal(deviceRecordFromAnchor(anchorFixture({ fullScanAt: future }), seedOptions()), null);

  // Old but trustworthy still seeds, and keeps its own timestamp rather than
  // being restamped as fresh.
  const earlier = new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const record = deviceRecordFromAnchor(anchorFixture({ fullScanAt: earlier }), seedOptions());
  assert.equal(record.updatedAt, earlier);
  assert.equal(record.receivedAt, earlier);
});

test('an anchor the collector would discard is refused here too', () => {
  // Same day, but the config moved. The collector drops this anchor on load, so
  // seeding from it would put the old client set's totals on screen for the
  // length of the first scan and then silently drop them.
  const dropped = deviceRecordFromAnchor(anchorFixture(), seedOptions({ clients: 'claude' }));
  assert.equal(dropped, null);

  const rescoped = deviceRecordFromAnchor(anchorFixture(), seedOptions({ allTimeSince: '2025-01-01' }));
  assert.equal(rescoped, null);

  const reprojected = deviceRecordFromAnchor(anchorFixture(), seedOptions({ projectsEnabled: false }));
  assert.equal(reprojected, null);
});

test('the WSL bundle is summed in, and only while WSL scanning is on', () => {
  // The anchor stores host periods and WSL separately, so a seed that forgot the
  // bundle would read low on Windows and then jump when the first scan lands.
  const wslBundle = { today: periodWith(400), month: periodWith(9_000), allTime: periodWith(100_000) };

  const merged = deviceRecordFromAnchor(anchorFixture({ wslBundle }), seedOptions());
  assert.equal(merged.today.totalTokens, 1_400);
  assert.equal(merged.month.totalTokens, 39_000);
  assert.equal(merged.allTime.totalTokens, 1_000_000);

  const hostOnly = deviceRecordFromAnchor(anchorFixture({ wslBundle }), seedOptions({ wslScanEnabled: false }));
  assert.equal(hostOnly.today.totalTokens, 1_000);
  assert.equal(hostOnly.allTime.totalTokens, 900_000);
});

test('the seeded totals survive aggregation once the UTC day has rolled over', () => {
  // Local 2026-08-08 is still 2026-08-07 in UTC when the anchor is written, so
  // aggregateDevices' fallback comparison would call today's window expired and
  // drop the period entirely, leaving exactly the zero this seeding exists to
  // avoid. periodWindows is what keeps that comparison off the fallback.
  const record = deviceRecordFromAnchor(anchorFixture(), seedOptions());
  assert.equal(record.periodWindows.today.key, '2026-08-08');

  const seeded = aggregateDevices([record], 0, NOW.getTime());
  assert.equal(seeded.periods.today.totalTokens, 1_000);
  assert.equal(seeded.periods.month.totalTokens, 30_000);

  const withoutWindows = { ...record };
  delete withoutWindows.periodWindows;
  const bare = aggregateDevices([withoutWindows], 0, NOW.getTime());
  assert.equal(bare.periods.today.totalTokens, 0, 'guards the fallback this test exists for');
});

test('without a seed, a preview stands alone with windows that start now', () => {
  const preview = { deviceId: 'device-a', updatedAt: NOW.toISOString(), today: periodWith(250) };
  const shown = seedWithColdPreview(preview, preview, NOW);
  assert.equal(shown.periodWindows.today.key, '2026-08-08');
  const aggregate = aggregateDevices([shown], 0, NOW.getTime());
  assert.equal(aggregate.periods.today.totalTokens, 250);
  assert.equal(aggregate.periods.allTime.totalTokens, 0);
});


test('a pricing or tokscale binary change still seeds, but nothing else that moved does', () => {
  const repriced = anchorFixture({
    configFingerprint: configFingerprint(CLIENTS, ALL_TIME_SINCE, true, '', '', null, 'deadbeef')
  });
  assert.equal(deviceRecordFromAnchor(repriced, seedOptions()).allTime.totalTokens, 900_000);
  const options = { clients: CLIENTS, allTimeSince: ALL_TIME_SINCE, projectsEnabled: true, now: NOW };
  assert.equal(collectorAnchorTrust(repriced, options), null, 'the collector itself rescans');

  assert.equal(deviceRecordFromAnchor(repriced, seedOptions({ clients: 'claude' })), null);
  assert.equal(deviceRecordFromAnchor(repriced, seedOptions({ projectsEnabled: false })), null);
  // A fingerprint without a pricing revision cannot prove the rest matches.
  assert.equal(deviceRecordFromAnchor(anchorFixture({ configFingerprint: 'claude,codex|2024-01-01|projects:on' }), seedOptions()), null);
});
