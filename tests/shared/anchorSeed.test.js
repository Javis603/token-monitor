'use strict';

// UTC+8 with no DST. The timezone matters: the whole point of the periodWindows
// assertion below is a local day that has not rolled over in UTC yet, which only
// exists ahead of UTC.
process.env.TZ = 'Asia/Shanghai';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { deviceRecordFromAnchor } = require('../../src/shared/anchorSeed');
const { configFingerprint: collectorConfigFingerprint } = require('../../src/shared/collector');

// Match the simulated device OS instead of the CI runner OS.
function configFingerprint(...args) {
  args[7] = { platform: 'darwin', ...args[7] };
  return collectorConfigFingerprint(...args);
}
const { qoderCnDataPaths } = require('../../src/shared/providers/qodercn/paths');
const { aggregateDevices, emptyPeriod, extractUsageFromTokscale } = require('../../src/shared/usage');
const { periodIdentityStateFromSource } = require('../../src/shared/usage/sourceIdentity');

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

test('a Windows cold-start seed reads APPDATA settings without changing its record platform', t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-seed-platform-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const env = { APPDATA: path.join(homeDir, 'roaming') };
  const configDir = path.join(env.APPDATA, 'tokscale');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ scanner: { bucketTimezone: 'America/Los_Angeles' } }));
  const options = seedOptions({ homeDir, env, now: new Date('2026-10-12T04:00Z'),
    dailyHistoryArchiveEnabled: true, pricingRevision: 'fixed' });
  const saved = anchorFixture({ dateKey: '2026-10-11', timeZone: 'America/Los_Angeles',
    fullScanAt: '2026-10-12T03:00Z', configFingerprint: configFingerprint(CLIENTS, ALL_TIME_SINCE, true, '', '', null, 'fixed',
      { platform: 'win32', wslScanEnabled: true }) });
  assert.ok(deviceRecordFromAnchor(saved, { ...options, platform: 'win32' }));
  for (const platform of ['win32-x64', 'win32-arm64']) {
    const record = deviceRecordFromAnchor(saved, { ...options, platform });
    assert.ok(record, platform);
    assert.equal(record.platform, platform);
    assert.equal(record.periodWindows.timeZone, saved.timeZone);
    assert.equal(record.today.totalTokens, 1000);
  }
  const explicit = deviceRecordFromAnchor(saved, { ...options, platform: 'custom-record-label', sourcePlatform: 'win32' });
  assert.ok(explicit);
  assert.equal(explicit.platform, 'custom-record-label');
});

test('WSL status follows the platform and the toggle, the way a collected record does', () => {
  const wslStatus = { state: 'active', detected: ['claude'], withData: ['claude'] };
  const windowsFingerprint = enabled => configFingerprint(CLIENTS, ALL_TIME_SINCE, true, '', '', null, undefined,
    { platform: 'win32', wslScanEnabled: enabled });

  const restored = deviceRecordFromAnchor(
    anchorFixture({ wslStatus, configFingerprint: windowsFingerprint(true) }),
    seedOptions({ wslSupported: true, platform: 'win32-x64' })
  );
  assert.deepEqual(restored.wslStatus, wslStatus);

  // Disabled is a state the panel renders, not the same as not knowing yet.
  const off = deviceRecordFromAnchor(
    anchorFixture({ wslStatus, configFingerprint: windowsFingerprint(false) }),
    seedOptions({ wslSupported: true, wslScanEnabled: false, platform: 'win32-x64' })
  );
  assert.deepEqual(off.wslStatus, { state: 'disabled', detected: [], withData: [] });

  const noSnapshot = deviceRecordFromAnchor(
    anchorFixture({ configFingerprint: windowsFingerprint(true) }),
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

test('the cold-start seed accepts an anchor configured for Qoder CN', () => {
  const homeDir = '/tmp/token-monitor-qodercn-home';
  const clients = 'claude,qodercn';
  for (const sourcePlatform of ['darwin', 'linux', 'win32']) {
    const env = {};
    const cnPaths = qoderCnDataPaths({ homeDir, env, platform: sourcePlatform });
    const anchor = anchorFixture({
      configFingerprint: configFingerprint(clients, ALL_TIME_SINCE, true, cnPaths.dbPaths[0], cnPaths.projectsDir, null, undefined,
        { platform: sourcePlatform, wslScanEnabled: true })
    });
    const record = deviceRecordFromAnchor(anchor, seedOptions({ clients, homeDir, env, sourcePlatform }));
    assert.ok(record, sourcePlatform);
    assert.equal(record.today.totalTokens, 1_000);
    assert.deepEqual(record.trackedClients, ['claude', 'qodercn']);
    assert.equal(record.platform, 'darwin-arm64');
  }
});

test('legacy Windows anchors without WSL source configuration cannot seed old mirror accounting', () => {
  const legacy = anchorFixture();
  // Derive the exact old format while keeping pricing and timezone unchanged.
  legacy.configFingerprint = configFingerprint(CLIENTS, ALL_TIME_SINCE, true, '', '', null, undefined,
    { platform: 'win32', wslScanEnabled: true }).replace(/\|wslClaude:on\|wslRoots:\[\]/, '');
  assert.equal(deviceRecordFromAnchor(legacy, seedOptions({ platform: 'win32-x64', wslSupported: true })), null);
});

test('cold seed carries matching accepted full-period claims and deduplicates against another source', () => {
  const eventId = `sha256:${createHash('sha256').update('same Claude event').digest('hex')}`;
  const period = extractUsageFromTokscale({ entries: [{ client: 'claude', sessionId: 's', model: 'claude-opus-4-8', provider: 'anthropic', input: 5, cost: 0.05, messages: 1 }] });
  const source = { version: 2, eventIdentityVersion: 2, capturedAt: FULL_SCAN_AT,
    scopes: [{ id: 'scope', clients: ['claude'], readStatus: 'complete', identityStatus: 'exact' }],
    sessions: [{ client: 'claude', sessionId: 's', scopeId: 'scope', events: [{ id: eventId, observationKind: 'native',
      contributions: [{ timestamp: Date.parse(FULL_SCAN_AT), modelId: 'claude-opus-4-8', providerId: 'anthropic',
        tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.05, messages: 1 }] }] }] };
  const state = periodIdentityStateFromSource(source, period, { timeZone: 'Asia/Shanghai' });
  const saved = anchorFixture({ today: period, month: period, allTime: period,
    nativeIdentityState: { today: state, month: state, allTime: state },
    todayIdentityState: { ...state, events: [] } });
  const record = deviceRecordFromAnchor(saved, seedOptions());
  assert.equal(record.usageIdentity.periods.today.events[0].id, eventId, 'seed uses the saved full capture, not later watch claims');
  const mirror = structuredClone(record);
  mirror.deviceId = 'device-b';
  for (const proof of Object.values(mirror.usageIdentity.periods)) proof.events[0].observationKind = 'mirror';
  const aggregate = aggregateDevices([record, mirror], 0, NOW.getTime());
  assert.equal(aggregate.periods.today.totalTokens, 5);
  assert.equal(aggregate.periods.month.totalTokens, 5);
  assert.equal(aggregate.periods.allTime.totalTokens, 5);
  const oversized = structuredClone(saved);
  oversized.today = emptyPeriod();
  assert.equal(deviceRecordFromAnchor(oversized, seedOptions()).usageIdentity.periods.today, undefined);
  const malformed = anchorFixture({ nativeIdentityState: { today: { events: null } } });
  assert.equal(deviceRecordFromAnchor(malformed, seedOptions()).usageIdentity, undefined);
});

test('the seed refuses a Qoder CN anchor that predates the JSONL source', () => {
  // A DB-only fingerprint cannot cover transcript usage: reusing it would show
  // month/allTime from before the storage migration while only today's JSONL
  // is scanned. The projects dir must be part of the trusted fingerprint.
  const homeDir = '/tmp/token-monitor-qodercn-home';
  const clients = 'claude,qodercn';
  for (const sourcePlatform of ['darwin', 'linux', 'win32']) {
    const env = {};
    const cnPaths = qoderCnDataPaths({ homeDir, env, platform: sourcePlatform });
    const legacyAnchor = anchorFixture({
      configFingerprint: configFingerprint(clients, ALL_TIME_SINCE, true, cnPaths.dbPaths[0])
    });
    assert.equal(deviceRecordFromAnchor(legacyAnchor, seedOptions({ clients, homeDir, env, sourcePlatform })), null, sourcePlatform);
  }
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

test('an anchor from another local day is refused', () => {
  assert.equal(deviceRecordFromAnchor(anchorFixture({ dateKey: '2026-08-07' }), seedOptions()), null);
  assert.equal(deviceRecordFromAnchor(null, seedOptions()), null);
  assert.equal(deviceRecordFromAnchor(anchorFixture({ month: null }), seedOptions()), null);
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
