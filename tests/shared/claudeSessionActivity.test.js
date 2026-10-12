'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const activity = require('../../src/shared/providers/claude/sessionActivity');
const linuxIdentity = require('../../src/shared/providers/claude/linuxProcessIdentity');
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
  const cleanups = [];
  t.after(() => { for (const cleanup of cleanups) cleanup(); fs.rmSync(home, { recursive: true, force: true }); });
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
  return { home, root, write, options, cleanups, read: (extra = {}) => activity.readSessionActivity(new Set(['test-session']), { ...options, ...extra }) };
}

test('activity after midnight preserves the accounting timestamp and scan windows', async t => {
  const f = fixture(t); f.write();
  const collectedAt = new Date(2026, 9, 8, 23, 59, 59);
  const observedAt = new Date(2026, 9, 9, 0, 0, 1);
  t.mock.method(Date, 'now', () => observedAt.getTime());
  let anchor;
  const summary = await require('../../src/shared/collector').collectUsageOnce({
    clients: 'claude', deviceId: 'midnight', agentVersion: 'test', now: collectedAt,
    homeDir: f.home, env: {}, platform: 'darwin', historyEnabled: false, limitsEnabled: false,
    projectsEnabled: false, codexLocalUsageEnabled: false, anchorPersistenceEnabled: false,
    sessionMetadataDeps: { readProcessStarts: f.options.readProcessStarts },
    runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 'test-session', model: 'test',
      input: 100, output: 0, cost: 0 }] }), onAnchorComputed: value => { anchor = value; }
  });
  assert.equal(summary.updatedAt, collectedAt.toISOString());
  assert.deepEqual(summary.periodWindows, require('../../src/shared/collector').computePeriodWindows(collectedAt));
  assert.equal(anchor.windowsPeriods.today.totalTokens, 100);
  assert.equal(anchor.windowsPeriods.today.sessions['claude:test-session'].liveActivity, undefined);
  assert.equal(summary.today.totalTokens, 100);
  assert.equal(summary.today.sessions['claude:test-session'].liveActivity.observedAt, observedAt.toISOString());
});

test('resumed historical Claude waiting appears in Today before new usage without duplicating other periods', async t => {
  const f = fixture(t); f.write();
  const clock = new Date(2026, 9, 9, 0, 1).getTime();
  const key = 'claude:test-session';
  const prior = session('unknown', { lastUsedAt: new Date(clock - 120_000).toISOString(), liveActivity: undefined });
  const summary = { today: usage.emptyPeriod(), month: { ...usage.emptyPeriod(), sessions: { [key]: prior } },
    allTime: { ...usage.emptyPeriod(), sessions: { [key]: prior } } };
  const options = { ...f.options, now: clock };
  const next = activity.projectActivity(summary, await activity.readSummaryActivity(summary, options), clock);
  const [row] = sessionRows.sessionRowsForPeriod(next.today, { nativeSessions: next.nativeSessions.today, now: new Date(clock) });
  assert.equal(row.activityState, 'waiting');
  assert.equal(row.tokenDataUnavailable, true);
  assert.equal(next.today.totalTokens, 0);
  assert.equal(next.nativeSessions.month[key], undefined);
  assert.equal(next.nativeSessions.allTime[key], undefined);
  const accounted = { ...next, today: { ...summary.today, sessions: { [key]: { ...prior, totalTokens: 10 } } } };
  const replaced = activity.projectActivity(accounted, await activity.readSummaryActivity(accounted, options), clock + 1000);
  assert.equal(replaced.nativeSessions.today[key], undefined);
  assert.equal(sessionRows.sessionRowsForPeriod(replaced.today, { nativeSessions: replaced.nativeSessions.today }).length, 1);
});

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

test('same-day archived Claude resumes across the patch lane without losing usage or duplicating Sessions', async t => {
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const projection = require('../../src/shared/sessionActivityProjection');
  const key = 'claude:test-session';
  for (const flag of ['archived', 'deleted', 'sourceDeleted']) {
    clock = now;
    const f = fixture(t); f.write();
    const original = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, {
      ...usage.emptyPeriod(), totalTokens: 100, costUsd: 1,
      sessions: { [key]: session('unknown', { liveActivity: undefined, costUsd: 1, models: { test: 100 } }) }
    }]));
    const retained = archive.captureSessionUsageArchive({}, original, new Date(now));
    const summary = archive.applySessionUsageArchive(Object.fromEntries(['today', 'month', 'allTime']
      .map(name => [name, usage.emptyPeriod()])), retained, { now: new Date(now) });
    assert.equal(summary.today.sessions[key].archived, true, 'use the actual archive producer');
    if (flag !== 'archived') for (const name of ['today', 'month', 'allTime']) {
      delete summary[name].sessions[key].archived; summary[name].sessions[key][flag] = true;
    }
    const before = JSON.stringify(summary);
    let current = summary;
    for (const [status, expected, offset] of [['waiting', 'waiting', 0], ['busy', 'running', 1000], ['idle', 'idle', 2000]]) {
      clock = now + offset; f.write({ status });
      const projected = activity.projectActivity(current, await activity.readSummaryActivity(current, { ...f.options, now: clock }), clock);
      current = projection.applyActivityPatch(current, projection.activityPatch(current, projected));
      for (const name of ['today', 'month', 'allTime']) {
        const list = sessionRows.sessionRowsForPeriod(current[name], { nativeSessions: current.nativeSessions[name], now: new Date(clock) });
        assert.equal(list.length, 1, `${flag}/${name}`);
        assert.equal(list[0].activityState, expected);
        assert.equal(list[0].value, 100); assert.equal(list[0].cost, 1);
        assert.equal(current[name].sessions, summary[name].sessions);
        assert.equal(current[name].totalTokens, 100); assert.equal(current[name].costUsd, 1);
      }
      const home = presentation.recentSessionRows({ periods: current, nativeSessions: current.nativeSessions });
      assert.equal(home.length, 1);
      assert.equal(live.sessionActivityState(home[0], clock), expected);
      assert.equal(presentation.waitingSessionSummary(home, clock).count, expected === 'waiting' ? 1 : 0);
    }
    assert.equal(JSON.stringify(summary), before, 'neither the archive nor accounting rows are changed by presentation');
  }
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

function linuxFixture(t, { pid = 4321, ticks = '987654321', machineId = 'machine-a', namespace = 'pid:[4026532001]' } = {}) {
  const f = fixture(t);
  const procRoot = path.join(f.home, 'proc');
  const procPid = path.join(procRoot, String(pid));
  fs.mkdirSync(path.join(procRoot, 'self', 'ns'), { recursive: true });
  fs.mkdirSync(procPid, { recursive: true });
  fs.writeFileSync(path.join(f.home, 'machine-id'), machineId);
  fs.symlinkSync(namespace, path.join(procRoot, 'self', 'ns', 'pid'));
  const statFields = ['S', ...Array(18).fill('0'), ticks];
  fs.writeFileSync(path.join(procPid, 'stat'), `${pid} (claude (test) process) ${statFields.join(' ')}\n`);
  const pidDomain = `linux:${machineId}:${namespace}`;
  const writeLinux = (extra = {}, recordPid = pid) => fs.writeFileSync(path.join(f.root, `${pid}.json`), JSON.stringify({
    pid: recordPid, sessionId: 'test-session', status: 'waiting', pidDomain, procStart: ticks, ...extra
  }));
  const options = { homeDir: f.home, env: {}, platform: 'linux', now,
    linuxProcRoot: procRoot, linuxMachineIdFile: path.join(f.home, 'machine-id') };
  return { ...f, pid, ticks, pidDomain, procRoot, writeLinux, options,
    readLinux: (extra = {}) => activity.readSessionActivity(new Set(['test-session']), { ...options, ...extra }) };
}

test('Linux registry validates machine, PID namespace, PID and proc start ticks', { skip: process.platform === 'win32' }, async t => {
  const f = linuxFixture(t);
  f.writeLinux();
  assert.deepEqual((await f.readLinux()).get('test-session'), { state: 'waiting', observedAt: new Date(now).toISOString() });
  for (const record of [
    { pidDomain: 'linux:machine-b:pid:[4026532001]' },
    { pidDomain: 'linux:machine-a:pid:[4026532002]' },
    { procStart: '987654322' },
    { pid: f.pid + 1 }
  ]) {
    f.writeLinux(record);
    assert.equal((await f.readLinux()).size, 0, JSON.stringify(record));
  }
  f.writeLinux();
  fs.unlinkSync(path.join(f.procRoot, String(f.pid), 'stat'));
  assert.equal((await f.readLinux()).size, 0, 'unreadable proc start falls back without registry evidence');
});

test('Linux dead registry owners clear Waiting even when their start ticks are retained', { skip: process.platform === 'win32' }, async t => {
  const f = linuxFixture(t); f.writeLinux();
  const key = 'claude:test-session';
  for (const state of ['Z', 'X', 'x']) {
    fs.writeFileSync(path.join(f.procRoot, String(f.pid), 'stat'),
      `${f.pid} (claude (test) process) ${[state, ...Array(18).fill('0'), f.ticks].join(' ')}\n`);
    assert.equal(linuxIdentity.readLinuxProcessStarts([f.pid], { procRoot: f.procRoot }).size, 0);
    const readings = await f.readLinux();
    assert.equal(readings.size, 0);
    const summary = { today: { sessions: { [key]: session() }, totalTokens: 100 } };
    const next = activity.projectSessionActivity(summary, readings, now + 1000);
    assert.equal(live.sessionWithActivity(next.today, key).liveActivity.state, 'unknown');
    assert.equal(sessionRows.sessionRowsForPeriod(next.today, { now: new Date(now + 1000) })[0].activityState, 'idle');
    assert.equal(next.today.totalTokens, 100);
  }
});

test('Linux live PID registry fixture matches this process on Linux CI', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t);
  const pid = process.pid;
  const pidDomain = linuxIdentity.readLinuxPidDomain();
  const ticks = linuxIdentity.readLinuxProcessStarts([pid]).get(pid);
  assert.ok(pidDomain);
  assert.ok(ticks);
  fs.writeFileSync(path.join(f.root, `${pid}.json`), JSON.stringify({
    pid, sessionId: 'test-session', status: 'busy', pidDomain, procStart: ticks
  }));
  const reading = await activity.readSessionActivity(new Set(['test-session']), { homeDir: f.home, env: {}, platform: 'linux', now });
  assert.deepEqual(reading.get('test-session'), { state: 'running', observedAt: new Date(now).toISOString() });
});

test('activity applies to every period, renews without token changes, and explicitly clears missing evidence', () => {
  const original = Object.fromEntries(['today', 'month', 'allTime'].map(name =>
    [name, { sessions: { 'claude:test-session': session() } }]));
  let summary = original;
  const readings = new Map([['test-session', { state: 'running' }]]);
  summary = activity.projectSessionActivity(summary, readings, now + 1000);
  assert.ok(summary);
  for (const name of ['today', 'month', 'allTime']) {
    const row = live.sessionWithActivity(summary[name], 'claude:test-session');
    assert.equal(row.totalTokens, 100);
    assert.equal(row.turnEnded, true);
    assert.equal(row.liveActivity.state, 'running');
    assert.equal(summary[name].sessions, original[name].sessions);
  }
  assert.equal(activity.projectSessionActivity(summary, readings, now + 2000), null);
  summary = activity.projectSessionActivity(summary, readings, now + 12_000);
  assert.ok(summary);
  summary = activity.projectSessionActivity(summary, new Map(), now + 13_000);
  assert.equal(live.sessionWithActivity(summary.today, 'claude:test-session').liveActivity.state, 'unknown');
  assert.equal(activity.projectSessionActivity(summary, new Map(), now + 14_000), null);
  assert.equal(original.today.sessions['claude:test-session'].liveActivity.state, 'waiting');
});

test('unchanged polling keeps object identity and changed observations share the accounting maps', () => {
  const row = session();
  const codex = { ...session(), client: 'codex', sessionId: 'codex-session' };
  const summary = { today: { totalTokens: 200, sessions: { claude: row, codex } }, month: usage.emptyPeriod() };
  const readings = new Map([['test-session', { state: 'waiting' }]]);
  assert.equal(activity.projectSessionActivity(summary, readings, now + 1000), null);
  readings.get('test-session').state = 'running';
  const next = activity.projectSessionActivity(summary, readings, now + 2000);
  assert.notEqual(next, summary);
  assert.equal(next.today.sessions, summary.today.sessions);
  assert.equal(live.sessionWithActivity(next.today, 'claude').liveActivity.state, 'running');
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
  assert.equal(live.sessionActivityState(session('waiting', { ...recent, client: 'opencode' }), now), 'running');
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
  assert.equal(period(session('waiting', { client: 'opencode' })).sessions['opencode:test-session'].liveActivity, undefined);
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

test('collector publishes waiting changes without rescanning usage or mutating earlier snapshots', { timeout: 20_000 }, async (t) => {
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

test('zero-token registry sessions reach local rows without changing accounting or sync', async t => {
  const f = fixture(t); f.write();
  const empty = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, usage.emptyPeriod()]));
  const observed = await activity.readSummaryActivity(empty, f.options);
  const next = activity.projectSessionActivity(empty, observed.readings, now, observed.sessions);
  const key = 'claude:test-session';
  assert.equal(next.nativeSessions.today[key].tokenDataUnavailable, true);
  assert.equal(next.nativeSessions.today[key].sessionDetailAvailable, false);
  const [row] = sessionRows.sessionRowsForPeriod(next.today, { nativeSessions: next.nativeSessions.today, clientLabels: { claude: 'Claude Code' }, now: new Date(now) });
  assert.equal(row.activityState, 'waiting');
  assert.equal(row.client, 'claude');
  assert.match(row.title, /Claude Code/);
  const saved = Date.now; Date.now = () => now;
  try {
    const dockRows = presentation.recentSessionRows({ periods: { today: next.today, month: next.month }, nativeSessions: next.nativeSessions });
    assert.equal(dockRows.length, 1);
    assert.equal(dockRows[0].client, 'claude');
    assert.equal(presentation.waitingSessionSummary(dockRows, now).count, 1);
    const withUsage = presentation.recentSessionRows({ periods: { today: { sessions: { [key]: session() } } }, nativeSessions: next.nativeSessions });
    assert.equal(withUsage.length, 1, 'usage rows replace native rows rather than duplicating them');
  } finally { Date.now = saved; }
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(next[name], empty[name]);
    assert.equal(next[name].totalTokens, 0);
    assert.equal(Object.keys(next[name].sessions).length, 0);
  }
  const { serializeSyncPayload } = require('../../src/shared/syncPayload');
  assert.equal(Object.hasOwn(serializeSyncPayload(next).payload, 'nativeSessions'), false);
  const unchanged = await activity.readSummaryActivity(next, { ...f.options, now: now + 1000 });
  assert.equal(activity.projectSessionActivity(next, unchanged.readings, now + 1000, unchanged.sessions), null);
  f.write({ status: 'idle' });
  const ended = await activity.readSummaryActivity(next, f.options);
  assert.equal(Object.keys(activity.projectSessionActivity(next, ended.readings, now + 1000, ended.sessions).nativeSessions.today).length, 0);
});

test('only unarchived usage suppresses temporary rows and other native clients are preserved', async t => {
  const f = fixture(t); f.write();
  const previous = { nativeSessions: { today: { reasonix: { client: 'reasonix' } } }, today: usage.emptyPeriod() };
  const observed = await activity.readSummaryActivity(previous, f.options);
  const projected = activity.projectSessionActivity(previous, observed.readings, now, observed.sessions);
  for (const archived of [false, true]) {
    const summary = { ...projected, today: { sessions: { 'claude:test-session': session('waiting', { archived }) } } };
    const withUsage = await activity.readSummaryActivity(summary, f.options);
    assert.equal(Object.keys(withUsage.sessions).length, archived ? 1 : 0);
    const next = activity.projectSessionActivity(summary, withUsage.readings, now, withUsage.sessions) || summary;
    assert.equal(next.nativeSessions.today.reasonix, previous.nativeSessions.today.reasonix);
    assert.equal(next.nativeSessions.today['claude:test-session']?.liveActivity.state, archived ? 'waiting' : undefined);
  }
  assert.equal(Object.keys((await activity.readSummaryActivity(previous, { ...f.options, readProcessStarts: async () => new Map() })).sessions).length, 0);
  assert.equal(Object.keys((await activity.readSummaryActivity(previous, { ...f.options, scopedHome: true })).sessions).length, 0);
});

function t3Fixture(f) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(f.home, '.t3', 'userdata');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server-runtime.json'), JSON.stringify({ version: 1, pid: 1234, startedAt: new Date(start).toISOString() }));
  const db = new DatabaseSync(path.join(dir, 'statev2.sqlite'));
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT, updated_at TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, provider TEXT, status TEXT, last_run_ordinal INTEGER, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, provider_thread_id TEXT, ordinal INTEGER, status TEXT, requested_at TEXT, completed_at TEXT);
    CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT PRIMARY KEY, thread_id TEXT, provider_thread_id TEXT, run_id TEXT, status TEXT, completed_at TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (node_id TEXT, thread_id TEXT, status TEXT, resolved_at TEXT, kind TEXT, created_at TEXT, payload_json TEXT);
  `);
  const stamp = new Date(now).toISOString();
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL, ?)').run('app', 'Claude test title', stamp);
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('provider', 'app', 'claudeAgent', 'custom-claude', 'active', 1, stamp, JSON.stringify({ nativeThreadRef: { nativeId: 'test-session' } }));
  db.prepare('INSERT INTO orchestration_v2_projection_runs (run_id, provider_thread_id, ordinal, status, requested_at) VALUES (?, ?, ?, ?, ?)').run('run', 'provider', 1, 'running', stamp);
  db.prepare('INSERT INTO orchestration_v2_projection_nodes VALUES (?, ?, ?, ?, ?, NULL)').run('node', 'app', 'provider', 'run', 'waiting');
  db.prepare('INSERT INTO orchestration_v2_projection_runtime_requests VALUES (?, ?, ?, NULL, ?, ?, ?)').run('node', 'app', 'pending', 'permission', stamp, JSON.stringify({ responseCapability: { type: 'live' }, prompt: 'private question' }));
  // Close before the home cleanup, including on Windows.
  f.cleanups.push(() => db.close());
  return db;
}

test('T3 terminal runs yield to native Claude registry and expire without renewing idle', async t => {
  const f = fixture(t); const db = t3Fixture(f); f.write({ status: 'busy' });
  const completedAt = new Date(now - 1000).toISOString();
  db.prepare("UPDATE orchestration_v2_projection_runs SET status = 'cancelled', completed_at = ?, requested_at = ?")
    .run(completedAt, new Date(now - 5000).toISOString());
  db.exec("UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'");
  const resumed = await activity.readSummaryActivity({}, f.options);
  assert.equal(resumed.readings.get('test-session').state, 'running');
  assert.equal(resumed.sessions['claude:test-session'].liveActivity.state, 'running');
  fs.unlinkSync(path.join(f.root, '1234.json'));
  const reading = await activity.readSummaryActivity({}, f.options);
  assert.deepEqual(reading.readings.get('test-session'), { state: 'idle', observedAt: completedAt });
  const summary = { month: { sessions: { 'claude:test-session': session('running', {
    liveActivity: { state: 'running', observedAt: new Date(now - 2000).toISOString() }
  }) } } };
  const projected = activity.projectActivity(summary, reading, now);
  assert.equal(live.sessionWithActivity(projected.month, 'claude:test-session').liveActivity.observedAt, completedAt);
  const later = { ...f.options, now: now + 12_000 };
  assert.equal(activity.projectActivity(projected, await activity.readSummaryActivity(projected, later), later.now), null);
  const expired = { ...f.options, now: now + 31_000 };
  const cleared = activity.projectActivity(projected, await activity.readSummaryActivity(projected, expired), expired.now);
  assert.equal(live.sessionWithActivity(cleared.month, 'claude:test-session').liveActivity.state, 'unknown');
});

test('T3 Claude formal waiting supersedes registry and resolves without transcript writes', async t => {
  const f = fixture(t); const db = t3Fixture(f); f.write({ status: 'busy' });
  for (const kind of ['command', 'file-read', 'file-change', 'permission', 'mcp-elicitation', 'user_input']) {
    db.prepare('UPDATE orchestration_v2_projection_runtime_requests SET kind = ?').run(kind);
    const result = await activity.readSummaryActivity({}, f.options);
    assert.equal(result.readings.get('test-session').state, 'waiting', kind);
    assert.equal(result.sessions['claude:test-session'].title, 'Claude test title');
    assert.equal(JSON.stringify(result.sessions).includes('private question'), false);
  }
  db.exec("UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'");
  assert.equal((await activity.readSummaryActivity({}, f.options)).readings.get('test-session').state, 'running');
  db.exec("UPDATE orchestration_v2_projection_runs SET status = 'cancelled'");
  f.write({ status: 'idle' });
  assert.equal(Object.keys((await activity.readSummaryActivity({}, f.options)).sessions).length, 0);
  db.exec("UPDATE orchestration_v2_projection_runs SET status = 'running'; UPDATE orchestration_v2_projection_provider_threads SET driver = 'codex'");
  f.write({ status: 'idle' });
  assert.equal(Object.keys((await activity.readSummaryActivity({}, f.options)).sessions).length, 0);
});

test('a late T3 Claude message answer clears newer waiting through projection and patches', async t => {
  const f = fixture(t); const db = t3Fixture(f);
  db.prepare("UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = ?")
    .run(new Date(now).toISOString());
  db.exec("UPDATE orchestration_v2_projection_runtime_requests SET kind = 'user_input'");
  db.prepare('UPDATE orchestration_v2_projection_runtime_requests SET payload_json = ?')
    .run(JSON.stringify({ responseCapability: { type: 'message' } }));
  const key = 'claude:test-session';
  const baseline = { month: { sessions: { [key]: session('running', { liveActivity: undefined }) } } };
  const waitingClock = now + 10_000;
  const projection = require('../../src/shared/sessionActivityProjection');
  const waiting = projection.materializeActivity(activity.projectActivity(baseline,
    await activity.readSummaryActivity(baseline, { ...f.options, now: waitingClock }), waitingClock));
  const resolvedClock = waitingClock + 1000;
  const resolvedAt = new Date(resolvedClock).toISOString();
  db.prepare("UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved', resolved_at = ?").run(resolvedAt);
  const cleared = activity.projectActivity(waiting,
    await activity.readSummaryActivity(waiting, { ...f.options, now: resolvedClock }), resolvedClock);
  const patch = projection.activityPatch(waiting, cleared);
  assert.deepEqual(patch.observations, [{ client: 'claude', sessionId: 'test-session',
    liveActivity: { state: 'idle', observedAt: resolvedAt } }]);
  const received = projection.applyActivityPatch(projection.applyActivityPatch(baseline,
    projection.activityPatch(baseline, waiting)), patch);
  assert.equal(live.sessionActivityState(live.sessionWithActivity(received.month, key), resolvedClock), 'idle');
  assert.equal(received.month.sessions, baseline.month.sessions);
  const later = { ...f.options, now: resolvedClock + 12_000 };
  assert.equal(activity.projectActivity(cleared, await activity.readSummaryActivity(cleared, later), later.now), null);
  assert.equal((await activity.readSummaryActivity(cleared, { ...f.options, now: resolvedClock + 31_000 })).readings.size, 0);
});

test('T3 Claude answerable message questions survive completion until answered', async t => {
  const f = fixture(t); const db = t3Fixture(f);
  db.exec("UPDATE orchestration_v2_projection_runs SET status = 'completed'; UPDATE orchestration_v2_projection_provider_threads SET status = 'idle'; UPDATE orchestration_v2_projection_runtime_requests SET kind = 'user_input'");
  db.prepare('UPDATE orchestration_v2_projection_runtime_requests SET payload_json = ?').run(JSON.stringify({ responseCapability: { type: 'message' } }));
  assert.equal((await activity.readSummaryActivity({}, f.options)).readings.get('test-session').state, 'waiting');
  db.exec("UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'");
  assert.equal(Object.keys((await activity.readSummaryActivity({}, f.options)).sessions).length, 0);
  db.exec("UPDATE orchestration_v2_projection_runtime_requests SET status = 'pending'");
  assert.equal((await activity.readSummaryActivity({}, { ...f.options, readProcessStarts: async () => new Map() })).readings.size, 0);
});

test('collector discovers zero-token Claude waiting and polling removes it without scans or anchor changes', { timeout: 12_000 }, async t => {
  const f = fixture(t); f.write();
  const { startCollector, collectUsageOnce } = require('../../src/shared/collector');
  const updates = [];
  let scans = 0;
  let anchor;
  let resolveUpdate;
  const collector = startCollector({
    clients: 'claude', allTimeSince: '2024-01-01', deviceId: 'zero-claude', agentVersion: 'test',
    homeDir: f.home, env: {}, platform: 'darwin', intervalMs: 300_000,
    historyEnabled: false, limitsEnabled: false, projectsEnabled: false, watchEnabled: false,
    codexLocalUsageEnabled: false, anchorPersistenceEnabled: false,
    sessionMetadataDeps: { readProcessStarts: f.options.readProcessStarts },
    runTokscale: async () => { scans += 1; return { entries: [] }; },
    onAnchorComputed: value => { anchor = value; },
    onUpdate: (summary, reason) => { updates.push({ summary, reason }); resolveUpdate?.(); },
    onError: error => { throw error; }
  });
  f.cleanups.unshift(() => collector.stop());
  await collector.whenIdle();
  assert.equal(scans, 3);
  await collectUsageOnce({ clients: 'claude', deviceId: 'zero-anchor', agentVersion: 'test',
    homeDir: f.home, env: {}, platform: 'darwin', historyEnabled: false, limitsEnabled: false,
    projectsEnabled: false, codexLocalUsageEnabled: false, anchorPersistenceEnabled: false,
    sessionMetadataDeps: { readProcessStarts: f.options.readProcessStarts },
    runTokscale: async () => ({ entries: [] }), onAnchorComputed: value => { anchor = value; } });
  const first = updates[0].summary;
  assert.equal(first.nativeSessions.today['claude:test-session'].liveActivity.state, 'waiting');
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(first[name].totalTokens, 0);
    assert.equal(Object.keys(first[name].sessions).length, 0);
    assert.equal(Object.keys(anchor.windowsPeriods[name].sessions).length, 0);
  }
  assert.equal(anchor.nativeSessions, undefined);
  const changed = new Promise(resolve => { resolveUpdate = resolve; });
  fs.unlinkSync(path.join(f.root, '1234.json'));
  await changed;
  assert.equal(scans, 3);
  assert.equal(updates[1].reason, 'session-activity');
  assert.equal(Object.keys(updates[1].summary.nativeSessions.today).length, 0);
  assert.equal(first.nativeSessions.today['claude:test-session'].liveActivity.state, 'waiting');
  collector.stop(); await collector.whenIdle();
});

test('temporary Claude rows reuse native titles and remain outside recursive subagent discovery', async t => {
  const f = fixture(t); f.write();
  const project = path.join(f.home, '.claude', 'projects', 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'test-session.jsonl'), JSON.stringify({ type: 'custom-title', customTitle: 'Native Claude title', sessionId: 'test-session' }) + '\n');
  const observed = await activity.readSummaryActivity({}, f.options);
  assert.equal(observed.sessions['claude:test-session'].title, 'Native Claude title');
  assert.equal(observed.sessions['claude:test-session'].sessionDetailAvailable, true);
  const nested = path.join(project, 'nested', 'subagents');
  fs.mkdirSync(nested, { recursive: true });
  fs.renameSync(path.join(project, 'test-session.jsonl'), path.join(nested, 'test-session.jsonl'));
  const shallow = await activity.readSummaryActivity({}, f.options);
  assert.equal(shallow.sessions['claude:test-session'].sessionDetailAvailable, false);
});

test('collector patch observers receive state changes without a usage publication or scan', async (t) => {
  const f = fixture(t);
  f.write();
  let scans = 0;
  const updates = [];
  const patches = [];
  let resolvePatch;
  const collector = require('../../src/shared/collector').startCollector({
    clients: 'claude', allTimeSince: '2024-01-01', deviceId: 'test', agentVersion: 'test',
    historyEnabled: false, limitsEnabled: false, projectsEnabled: false, watchEnabled: false,
    intervalMs: 300_000, codexLocalUsageEnabled: false, anchorPersistenceEnabled: false,
    homeDir: f.home, platform: 'darwin', env: {},
    sessionMetadataDeps: { readProcessStarts: f.options.readProcessStarts },
    runTokscale: async () => { scans += 1; return { entries: [{ client: 'claude', sessionId: 'test-session', model: 'claude-sonnet-4-6', input: 100, output: 0, cost: 0 }] }; },
    onUpdate: (summary) => updates.push(summary),
    onSessionActivity: (patch) => { patches.push(patch); resolvePatch?.(); },
    onError: (error) => { throw error; }
  });
  t.after(async () => { collector.stop(); await collector.whenIdle(); });
  await collector.whenIdle();
  const changed = new Promise((resolve) => { resolvePatch = resolve; });
  f.write({ status: 'busy' });
  await changed;
  assert.equal(scans, 3);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].today.sessions['claude:test-session'].liveActivity.state, 'waiting');
  assert.deepEqual(patches[0].observations.map((row) => [row.client, row.sessionId, row.liveActivity.state]), [['claude', 'test-session', 'running']]);
  assert.ok(JSON.stringify(patches[0]).length < 500);
});

test('the existing watcher routes registry changes into activity without scheduling token scans', async (t) => {
  const { EventEmitter } = require('node:events');
  const chokidar = require('chokidar');
  const f = fixture(t); f.write();
  const original = chokidar.watch;
  const prior = process.env.TOKEN_MONITOR_WATCH_IN_PROCESS;
  process.env.TOKEN_MONITOR_WATCH_IN_PROCESS = '1';
  let watchOptions;
  const watcher = new EventEmitter(); watcher.close = async () => {};
  chokidar.watch = (_dirs, options) => { watchOptions = options; queueMicrotask(() => watcher.emit('ready')); return watcher; };
  t.after(() => { chokidar.watch = original; if (prior === undefined) delete process.env.TOKEN_MONITOR_WATCH_IN_PROCESS; else process.env.TOKEN_MONITOR_WATCH_IN_PROCESS = prior; });
  let scans = 0; let updates = 0; let resolvePatch;
  const changed = new Promise(resolve => { resolvePatch = resolve; });
  const collector = require('../../src/shared/collector').startCollector({
    clients: 'claude', allTimeSince: '2024-01-01', deviceId: 'test', agentVersion: 'test',
    historyEnabled: false, limitsEnabled: false, projectsEnabled: false,
    watchEnabled: true, watchTriggersCollection: true, intervalMs: 300_000,
    codexLocalUsageEnabled: false, anchorPersistenceEnabled: false,
    homeDir: f.home, platform: 'darwin', env: {},
    sessionMetadataDeps: { readProcessStarts: f.options.readProcessStarts, t3DbPaths: [] },
    runTokscale: async () => { scans++; return { entries: [{ client: 'claude', sessionId: 'test-session', model: 'claude-sonnet-4-6', input: 100, output: 0, cost: 0 }] }; },
    onUpdate: () => { updates++; }, onSessionActivity: resolvePatch,
    onError: error => { throw error; }
  });
  t.after(async () => { collector.stop(); await collector.whenIdle(); });
  await collector.whenIdle();
  // Watcher events use long paths, even when Windows temp uses an 8.3 alias.
  const registryRoot = require('../../src/shared/clientSources').canonicalWatchPath(f.root);
  const registry = path.join(registryRoot, '1234.json');
  assert.equal(watchOptions.ignored(registry), false);
  assert.equal(watchOptions.ignored(path.join(registryRoot, 'secret.json')), true);
  f.write({ status: 'busy' });
  watcher.emit('all', 'change', registry);
  watcher.emit('all', 'change', registry);
  const patch = await changed; await collector.whenIdle();
  assert.equal(scans, 3); assert.equal(updates, 1);
  assert.deepEqual(patch.observations.map(row => row.liveActivity.state), ['running']);
  collector.stop(); watcher.emit('all', 'change', registry);
  assert.equal(scans, 3);
});

test('a copied archive projection keeps accounting while admitting resumed no-token activity', async (t) => {
  const f = fixture(t); f.write();
  let resolvePatch;
  const patches = [];
  const collector = require('../../src/shared/collector').startCollector({
    clients: 'claude', allTimeSince: '2024-01-01', deviceId: 'test', agentVersion: 'test',
    historyEnabled: false, limitsEnabled: false, projectsEnabled: false, watchEnabled: false,
    intervalMs: 300_000, codexLocalUsageEnabled: false, anchorPersistenceEnabled: false,
    homeDir: f.home, platform: 'darwin', env: {},
    sessionMetadataDeps: { readProcessStarts: f.options.readProcessStarts },
    runTokscale: async () => ({ entries: [] }),
    onUpdate(summary) {
      const visible = { ...summary };
      for (const name of ['today', 'month', 'allTime']) visible[name] = { ...summary[name], sessions: {
        'claude:test-session': { client: 'claude', sessionId: 'test-session', totalTokens: 100, archived: true }
      } };
      return visible;
    },
    onSessionActivity: (patch) => { patches.push(patch); resolvePatch?.(); },
    onError: (error) => { throw error; }
  });
  t.after(async () => { collector.stop(); await collector.whenIdle(); });
  await collector.whenIdle();
  await new Promise((resolve) => { resolvePatch = resolve; });
  assert.deepEqual(patches[0].observations, []);
  assert.equal(patches[0].nativeSessions.today['claude:test-session'].liveActivity.state, 'waiting');
  const list = sessionRows.sessionRowsForPeriod({ sessions: {
    'claude:test-session': { client: 'claude', sessionId: 'test-session', totalTokens: 100, archived: true }
  } }, { nativeSessions: patches[0].nativeSessions.today });
  assert.equal(list.length, 1);
  assert.equal(list[0].activityState, 'waiting');
  assert.equal(list[0].value, 100);
});
