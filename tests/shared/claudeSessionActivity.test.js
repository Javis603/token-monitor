'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const activity = require('../../src/shared/providers/claude/sessionActivity');
const live = require('../../src/shared/sessionLive');
const usage = require('../../src/shared/usage');
const archive = require('../../src/shared/usage/sessionUsageArchive');
const presentation = require('../../src/electron/renderer/edgeDock/presentation');
const sessionRows = require('../../src/electron/renderer/sessionRows');

const now = Date.parse('2026-10-08T12:00:00Z');
const start = now - 60_000;
const session = (state = 'waiting', extra = {}) => ({
  client: 'claude', sessionId: 'test-session', totalTokens: 100,
  lastUsedAt: new Date(now - 3600_000).toISOString(), turnEnded: true,
  liveActivity: { state, observedAt: new Date(now).toISOString() }, ...extra
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-activity-'));
  const root = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (extra = {}, pid = 1234) => {
    const record = {
      pid, sessionId: 'test-session', status: 'waiting', pidDomain: 'darwin',
      procStart: new Date(start).toUTCString().replace(',', '').replace(' GMT', ''),
      cwd: '/private-project', name: 'private name', waitingFor: 'private question',
      messagingSocketPath: '/private-socket', ...extra
    };
    fs.writeFileSync(path.join(root, `${pid}.json`), JSON.stringify(record));
  };
  const options = {
    homeDir: home, env: {}, platform: 'darwin', now,
    readProcessStarts: async (pids) => new Map(pids.map((pid) => [pid, start]))
  };
  return { home, root, write, options, read: (extra = {}) => activity.readSessionActivity(new Set(['test-session']), { ...options, ...extra }) };
}

test('registry recognizes explicit states and publishes only a sanitized observation', async (t) => {
  const f = fixture(t);
  for (const [fields, state] of [
    [{ status: 'waiting' }, 'waiting'], [{ status: 'busy' }, 'running'],
    [{ status: 'idle' }, 'idle'], [{ status: '', tempo: 'blocked' }, 'waiting'],
    [{ status: '', tempo: 'active' }, 'running'], [{ status: '', tempo: 'idle' }, 'idle']
  ]) {
    f.write(fields);
    assert.deepEqual((await f.read()).get('test-session'), { state, observedAt: new Date(now).toISOString() });
  }
  fs.writeFileSync(path.join(f.root, '1234.key'), 'not a JSON record');
  assert.equal((await f.read()).size, 1);
});

test('dead, reused, foreign and unrecognized registry records fall back', async (t) => {
  const f = fixture(t);
  f.write();
  assert.equal((await f.read({ readProcessStarts: async () => new Map() })).size, 0);
  assert.equal((await f.read({ readProcessStarts: async () => new Map([[1234, start + 2000]]) })).size, 0);
  assert.equal((await f.read({ readProcessStarts: async () => { throw new Error('unavailable'); } })).size, 0);
  for (const fields of [
    { pidDomain: 'linux' }, { status: 'new-status' }, { procStart: 'invalid' },
    { sessionId: 'another-session' }, { entrypoint: 'claude-desktop' },
    { entrypoint: 'claude-desktop-3p' }, { pid: 99 }, { pid: '1234' }
  ]) {
    f.write(fields);
    assert.equal((await f.read()).size, 0, JSON.stringify(fields));
  }
});

test('registry ignores partial, oversized, symlink and missing files, and uses the configured root', async (t) => {
  const f = fixture(t);
  f.write();
  assert.equal((await f.read({ scopedHome: true })).size, 0);
  const custom = path.join(f.home, 'custom');
  fs.mkdirSync(path.join(custom, 'sessions'), { recursive: true });
  fs.renameSync(path.join(f.root, '1234.json'), path.join(custom, 'sessions', '1234.json'));
  assert.equal((await f.read()).size, 0);
  assert.equal((await f.read({ env: { CLAUDE_CONFIG_DIR: custom } })).size, 1);
  const target = path.join(custom, 'sessions', '1234.json');
  fs.writeFileSync(path.join(f.root, '1234.json'), '{');
  assert.equal((await f.read()).size, 0);
  fs.writeFileSync(path.join(f.root, '1234.json'), ' '.repeat(65537));
  assert.equal((await f.read()).size, 0);
  fs.unlinkSync(path.join(f.root, '1234.json'));
  if (process.platform !== 'win32') {
    fs.symlinkSync(target, path.join(f.root, '1234.json'));
    assert.equal((await f.read()).size, 0);
  }
});

test('newest live process wins when a resumed session has two records', async (t) => {
  const f = fixture(t);
  f.write();
  const newer = start + 10_000;
  f.write({ status: 'busy', procStart: new Date(newer).toUTCString().replace(',', '').replace(' GMT', '') }, 2345);
  assert.equal((await f.read({ readProcessStarts: async () => new Map([[1234, start], [2345, newer]]) })).get('test-session').state, 'running');
});

test('activity applies to every period, renews without token changes, and explicitly clears missing evidence', () => {
  const periods = [1, 2, 3].map(() => ({ sessions: { 'claude:test-session': session() } }));
  const readings = new Map([['test-session', { state: 'running' }]]);
  assert.equal(activity.applySessionActivity(periods, readings, now + 1000, true), true);
  for (const period of periods) {
    const row = period.sessions['claude:test-session'];
    assert.equal(row.totalTokens, 100);
    assert.equal(row.turnEnded, true);
    assert.equal(row.liveActivity.state, 'running');
  }
  assert.equal(activity.applySessionActivity(periods, readings, now + 2000, true), false);
  assert.equal(activity.applySessionActivity(periods, readings, now + 12_000, true), true);
  assert.equal(activity.applySessionActivity(periods, new Map(), now + 13_000, true), true);
  assert.equal(periods[0].sessions['claude:test-session'].liveActivity.state, 'unknown');
  assert.equal(activity.applySessionActivity(periods, new Map(), now + 14_000, true), false);
});

test('unchanged polling keeps object identity and changed observations clone only affected session maps', () => {
  const row = session();
  const codex = { ...session(), client: 'codex', sessionId: 'codex-session' };
  const summary = { today: { totalTokens: 200, sessions: { claude: row, codex } }, month: usage.emptyPeriod() };
  const readings = new Map([['test-session', { state: 'waiting' }]]);
  assert.equal(activity.projectSessionActivity(summary, readings, now + 1000), null);
  readings.get('test-session').state = 'running';
  const next = activity.projectSessionActivity(summary, readings, now + 2000);
  assert.notEqual(next, summary);
  assert.notEqual(next.today.sessions, summary.today.sessions);
  assert.equal(next.today.sessions.codex, codex);
  assert.equal(next.month, summary.month);
  assert.equal(summary.today.sessions.claude.liveActivity.state, 'waiting');
});

test('explicit activity overrides transcript recency but expires, clears and respects archives', () => {
  assert.equal(live.sessionActivityState(session(), now), 'waiting');
  assert.equal(live.isRunningSession(session(), now), false);
  assert.equal(live.sessionActivityState(session('running'), now), 'running');
  assert.equal(live.sessionActivityState(session('idle'), now), 'idle');
  assert.equal(live.sessionActivityState(session(), now + live.LIVE_ACTIVITY_TTL_MS - 1), 'waiting');
  assert.equal(live.sessionActivityState(session(), now + live.LIVE_ACTIVITY_TTL_MS), 'idle');
  assert.equal(live.sessionActivityState(session(), now - 1), 'idle');
  for (const flag of ['archived', 'deleted', 'sourceDeleted']) {
    assert.equal(live.sessionActivityState(session('waiting', { [flag]: true }), now), 'idle');
  }
  const recent = { lastUsedAt: new Date(now).toISOString(), turnEnded: false };
  assert.equal(live.sessionActivityState(session('unknown', recent), now), 'running');
  assert.equal(live.sessionActivityState(session('waiting', { ...recent, client: 'codex' }), now), 'running');
  assert.equal(live.nextSessionStatusChangeAt([session()], now), now + live.LIVE_ACTIVITY_TTL_MS);
});

test('normalization strips private fields and merging follows the activity clock independently of token time', () => {
  const old = session('waiting', { liveActivity: { state: 'waiting', observedAt: new Date(now).toISOString(), pid: 1234, waitingFor: 'private' } });
  const fresh = session('unknown', { liveActivity: { state: 'unknown', observedAt: new Date(now + 1000).toISOString() } });
  const period = (row) => usage.normalizePeriod({ sessions: { 'claude:test-session': row } });
  const normalized = period(old).sessions['claude:test-session'];
  assert.deepEqual(normalized.liveActivity, { state: 'waiting', observedAt: new Date(now).toISOString() });
  for (const rows of [[old, fresh], [fresh, old]]) {
    assert.deepEqual(usage.mergePeriods(...rows.map(period)).sessions['claude:test-session'].liveActivity, fresh.liveActivity);
  }
  const without = session(); delete without.liveActivity;
  assert.equal(usage.mergePeriods(period(old), period(without)).sessions['claude:test-session'].liveActivity.state, 'waiting');
  const record = usage.normalizeDeviceRecord({ deviceId: 'test', today: { sessions: { 'claude:test-session': old } } });
  assert.deepEqual(record.periods.today.sessions['claude:test-session'].liveActivity, normalized.liveActivity);
  assert.equal(period(session('waiting', { client: 'codex' })).sessions['codex:test-session'].liveActivity, undefined);
});

test('historical archives omit transient activity and heartbeat updates do not rewrite history', () => {
  const row = session();
  const record = { today: { sessions: { 'claude:test-session': row } } };
  const first = archive.updateSessionUsageArchive(null, record, now);
  assert.equal(first.archive.sessions['claude:test-session'].periods.today.liveActivity, undefined);
  row.liveActivity.observedAt = new Date(now + 10_000).toISOString();
  assert.equal(archive.updateSessionUsageArchive(first.archive, record, now + 10_000).changedKeys.size, 0);
  const restored = archive.applySessionUsageArchive({ today: usage.emptyPeriod() }, first.archive, { now });
  const retained = restored.today.sessions['claude:test-session'];
  assert.equal(live.sessionActivityState(retained, now), 'idle');
  assert.equal(retained.liveActivity, undefined);
});

test('waiting survives normal row caps, is excluded from running counts and falls back on the shared expiry clock', () => {
  const previousNow = Date.now;
  Date.now = () => now;
  try {
    const waiting = session();
    const stats = { periods: { month: { sessions: {
      'claude:new': session('idle', { sessionId: 'new', lastUsedAt: new Date(now).toISOString() }),
      'claude:test-session': waiting
    } } } };
    const rows = presentation.recentSessionRows(stats, 1);
    assert.equal(rows[0].sessionId, 'test-session');
    assert.equal(presentation.waitingSessionSummary(rows, now).count, 1);
    assert.equal(presentation.runningSessionSummary(rows, now).count, 0);
    assert.equal(presentation.nextRunningExpiryAt(rows, now), now + live.LIVE_ACTIVITY_TTL_MS);
    assert.equal(presentation.recentSessionRows(stats, 1, { runningOnly: true }).length, 0);
    const [row] = sessionRows.sessionRowsForPeriod({ sessions: { 'claude:test-session': waiting } }, { now: new Date(now) });
    assert.equal(row.activityState, 'waiting');
    assert.equal(row.running, undefined);
  } finally { Date.now = previousNow; }
});

test('collector publishes waiting changes without rescanning usage or mutating earlier snapshots', { timeout: 12_000 }, async (t) => {
  const f = fixture(t);
  f.write();
  const { startCollector } = require('../../src/shared/collector');
  let scans = 0;
  let nextUpdate;
  const updates = [];
  const collector = startCollector({
    clients: 'claude', allTimeSince: '2024-01-01', commandTimeoutMs: 1000,
    deviceId: 'test', agentVersion: 'test', historyEnabled: false,
    limitsEnabled: false, projectsEnabled: false, watchEnabled: false,
    intervalMs: 300_000, codexLocalUsageEnabled: false,
    anchorPersistenceEnabled: false,
    homeDir: f.home, platform: 'darwin', env: {},
    sessionMetadataDeps: { readProcessStarts: f.options.readProcessStarts },
    runTokscale: async () => {
      scans += 1;
      return { entries: [{ client: 'claude', sessionId: 'test-session', model: 'claude-sonnet-4-6', input: 100, output: 0, cost: 0 }] };
    },
    onUpdate: (summary, reason) => {
      updates.push({ summary, reason });
      nextUpdate?.();
    },
    onError: (error) => { throw error; }
  });
  t.after(async () => { collector.stop(); await collector.whenIdle(); });
  await collector.whenIdle();
  assert.equal(updates.length, 1);
  const first = updates[0].summary;
  assert.equal(first.today.sessions['claude:test-session'].liveActivity.state, 'waiting');
  assert.equal(scans, 3);
  // The polling lane works even with native usage watching disabled.
  const changed = new Promise((resolve) => { nextUpdate = resolve; });
  f.write({ status: 'busy' });
  await changed;
  assert.equal(scans, 3);
  assert.equal(updates[1].reason, 'session-activity');
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(updates[1].summary[name].sessions['claude:test-session'].liveActivity.state, 'running');
    assert.equal(updates[1].summary[name].totalTokens, first[name].totalTokens);
    assert.equal(first[name].sessions['claude:test-session'].liveActivity.state, 'waiting');
    assert.notEqual(updates[1].summary[name], first[name]);
  }
  const cleared = new Promise((resolve) => { nextUpdate = resolve; });
  fs.unlinkSync(path.join(f.root, '1234.json'));
  await cleared;
  assert.equal(scans, 3);
  assert.equal(updates[2].summary.month.sessions['claude:test-session'].liveActivity.state, 'unknown');
  collector.stop();
  await collector.whenIdle();
  assert.equal(collector.getDiagnostics().state, 'stopped');
});
