'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectUsageOnce, collectionCalendarKey, collectorAnchorTrust, configFingerprint, localTodayKey, startCollector } = require('../../src/shared/collector');
const { emptyPeriod } = require('../../src/shared/usage');

function inZone(t, zone) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
}

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-calendar-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, clients: 'claude', allTimeSince: '2026-01-01', deviceId: 'calendar-test', limitsEnabled: false,
    codexLocalUsageEnabled: false, wslScanEnabled: false, projectsEnabled: false };
}

const usage = () => ({ entries: [{ client: 'claude', model: 'opus', input: 10 }] });

test('usage and graph scans receive one calendar, including explicit WSL home scans', async t => {
  inZone(t, 'Asia/Taipei');
  const scans = [];
  let graphZone;
  const summary = await collectUsageOnce({
    ...fixture(t), now: '2026-11-07T18:00:00Z', includeHistory: true,
    runTokscale: async input => { scans.push(input); return usage(); },
    runGraph: async input => { graphZone = input.timeZone; return { contributions: [] }; },
    collectWslUsage: async ({ runTokscale }) => {
      await runTokscale({ clients: 'claude', flags: ['--today', '--home', '/fixture-wsl-home'] });
      return { bundle: { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() }, detected: [] };
    },
    wslScanEnabled: true
  });
  assert.equal(scans.length, 4);
  assert.ok(scans.every(input => input.timeZone === 'Asia/Taipei'));
  assert.equal(graphZone, 'Asia/Taipei');
  assert.equal(summary.periodWindows.today.key, '2026-11-08');
  assert.equal(summary.periodWindows.today.endsAt, '2026-11-08T16:00:00.000Z');
});

test('a timezone change during serial scans cannot write a mixed-calendar live archive', async t => {
  inZone(t, 'America/Los_Angeles');
  const options = fixture(t);
  const file = path.join(options.homeDir, 'history.json');
  let scans = 0;
  await assert.rejects(collectUsageOnce({ ...options, dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveOptions: { path: file }, now: '2026-11-07T18:00:00Z',
    runTokscale: async () => { scans += 1; process.env.TZ = 'Asia/Taipei'; return usage(); }
  }), /timezone changed/);
  assert.equal(scans, 1);
  assert.equal(fs.existsSync(file), false);
});

test('persisted anchor trust requires the calendar even when the date key is unchanged', t => {
  inZone(t, 'America/Los_Angeles');
  const now = new Date('2026-11-07T12:00:00Z');
  const options = { clients: 'claude', allTimeSince: '2026-01-01', now };
  const saved = { dateKey: localTodayKey(now), calendarKey: collectionCalendarKey(now),
    today: {}, month: {}, allTime: {}, configFingerprint: configFingerprint(options.clients, options.allTimeSince) };
  assert.ok(collectorAnchorTrust(saved, options));
  assert.equal(collectorAnchorTrust({ ...saved, calendarKey: undefined }, options), null);
  process.env.TZ = 'Asia/Taipei';
  assert.equal(saved.dateKey, localTodayKey(now));
  assert.equal(collectorAnchorTrust(saved, options), null);
});

test('same-zone DST offset changes also invalidate anchors', t => {
  inZone(t, 'America/New_York');
  assert.notEqual(collectionCalendarKey(new Date('2026-11-01T05:00:00Z')),
    collectionCalendarKey(new Date('2026-11-01T07:00:00Z')));
});

test('a resident collector rebuilds all periods on a timezone change, then resumes exact watch deltas', async t => {
  inZone(t, 'America/Los_Angeles');
  const options = fixture(t);
  const scans = [];
  const updates = [];
  let ready;
  const first = new Promise(resolve => { ready = resolve; });
  const runtime = startCollector({ ...options, now: '2026-11-07T12:00:00Z',
    historyEnabled: false, anchorPersistenceEnabled: false, sessionActivityPolling: false,
    intervalMs: 600_000, watchEnabled: false,
    runTokscale: async input => { scans.push(input); return usage(); },
    onUpdate: summary => { updates.push(summary); ready(); }
  });
  t.after(() => runtime.stop());
  await first;
  await runtime.whenIdle();
  assert.equal(scans.length, 3);
  await runtime.tick('watch', { todayOnly: true });
  assert.equal(scans.length, 4);
  process.env.TZ = 'Asia/Taipei';
  await runtime.tick('watch', { todayOnly: true });
  assert.equal(scans.length, 7);
  assert.ok(scans.slice(4).every(input => input.timeZone === 'Asia/Taipei'));
  assert.equal(updates.at(-1).periodWindows.timeZone, 'Asia/Taipei');
  await runtime.tick('watch', { todayOnly: true });
  assert.equal(scans.length, 8);
});

test('Smart interval collection notices a calendar change without a usage event', async t => {
  inZone(t, 'America/Los_Angeles');
  const options = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let scans = 0;
  const runtime = startCollector({ ...options, now: '2026-11-07T12:00:00Z',
    historyEnabled: false, anchorPersistenceEnabled: false, sessionActivityPolling: false,
    intervalMs: 1000, watchDebounceMs: 1, watchEnabled: false, intervalRequiresActivity: true,
    runTokscale: async () => { scans += 1; return usage(); }
  });
  t.after(() => runtime.stop());
  await runtime.whenIdle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 3);
  t.mock.timers.tick(1000);
  await runtime.whenIdle();
  assert.equal(scans, 3, 'unchanged calendar remains activity-gated');
  process.env.TZ = 'Asia/Taipei';
  t.mock.timers.tick(1000);
  await runtime.whenIdle();
  assert.equal(scans, 6, 'a calendar change bypasses activity gating and rescans serially');
});

test('a queued collection cannot carry the old calendar live overlay into a new calendar', async t => {
  inZone(t, 'America/Los_Angeles');
  const now = new Date('2026-11-07T12:00:00Z');
  const expectedCalendarKey = collectionCalendarKey(now);
  process.env.TZ = 'Asia/Taipei';
  let scans = 0;
  await assert.rejects(collectUsageOnce({ ...fixture(t), now, expectedCalendarKey,
    runTokscale: async () => { scans += 1; return usage(); }
  }), /timezone changed/);
  assert.equal(scans, 0);
});

test('timezone changes during History fallback still reject the collected snapshot', async t => {
  inZone(t, 'America/Los_Angeles');
  await assert.rejects(collectUsageOnce({ ...fixture(t), now: '2026-11-07T20:00:00Z',
    includeHistory: true, runTokscale: async () => usage(),
    runGraph: async () => { process.env.TZ = 'Asia/Taipei'; return { contributions: [] }; }
  }), /timezone changed/);
});

test('a timezone change during the publication transform cannot re-date the retained Today', async t => {
  inZone(t, 'America/Los_Angeles');
  const options = fixture(t);
  const file = path.join(options.homeDir, 'history.json');
  const runtime = startCollector({ ...options, now: '2026-11-07T20:00:00Z',
    anchorPersistenceEnabled: false, sessionActivityPolling: false, intervalMs: 600_000, watchEnabled: false,
    dailyHistoryArchiveEnabled: true, dailyHistoryArchiveOptions: { path: file },
    runTokscale: async () => usage(), runGraph: async () => ({ contributions: [] }),
    onUpdate: async summary => { process.env.TZ = 'Asia/Taipei'; return summary; }
  });
  t.after(() => runtime.stop());
  await runtime.whenIdle();
  const retained = JSON.parse(fs.readFileSync(file, 'utf8')).calendars['America/Los_Angeles'].liveDays;
  assert.ok(retained['2026-11-07']);
  assert.equal(retained['2026-11-08'], undefined);
});
