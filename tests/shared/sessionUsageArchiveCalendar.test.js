'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { applySessionUsageArchive, normalizeSessionUsageArchive, updateSessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { normalizePeriod } = require('../../src/shared/usage');
const { localDate, localIso } = require('../helpers/localTime');

// The six cases below are adapted from upstream #1063 at 0dedead14528.

// A capture that runs while the summary's `today` window is stale — collection
// stalled and the capture read the previous day's rows — writes a `today`
// bucket whose contents are from an earlier day (token-monitor#986). The
// bucket keeps claiming today on every later capture, so replaying it adds
// those tokens to today forever and the max-wins merge locks the figure in.
function archiveSession(client, sessionId, totalTokens, lastUsedAt) {
  return {
    client,
    sessionId,
    totalTokens,
    costUsd: 0,
    messageCount: 1,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: { 'claude-opus-4-8': totalTokens },
    modelCosts: { 'claude-opus-4-8': 0 },
    lastUsedAt
  };
}

function periodWith(sessions) {
  return normalizePeriod({ sessions });
}

function emptyDeviceSummary() {
  return {
    deviceId: 'test-device',
    today: periodWith({}),
    month: periodWith({}),
    allTime: periodWith({})
  };
}

test('a today bucket written from a stale window does not replay into today', () => {
  const captureAt = localDate(2026, 10, 15, 11, 25);
  const stale = emptyDeviceSummary();
  stale.today = periodWith({ 'claude:s-stale': archiveSession('claude', 's-stale', 1000, localIso(2026, 10, 14, 20, 0)) });
  stale.month = stale.today;
  stale.allTime = stale.today;

  const { archive } = updateSessionUsageArchive({ version: 1, sessions: {} }, stale, captureAt);
  const entry = archive.sessions['claude:s-stale'];
  // The bucket still claims the capture's day, and the window records the
  // frame that day was cut in — only its replay is refused.
  assert.equal(entry.periodWindows.today.day, '2026-10-15');
  assert.equal(entry.periodWindows.today.utcOffsetMinutes, -captureAt.getTimezoneOffset());
  assert.equal(entry.periods.today.totalTokens, 1000);

  // A later capture that no longer sees the session must not add its tokens
  // to today; the month and lifetime periods still carry them.
  const visible = applySessionUsageArchive(emptyDeviceSummary(), archive, { now: captureAt });
  assert.equal(visible.today.sessions['claude:s-stale'], undefined);
  assert.equal(visible.today.totalTokens, 0);
  assert.equal(visible.month.sessions['claude:s-stale'].totalTokens, 1000);
  assert.equal(visible.allTime.sessions['claude:s-stale'].totalTokens, 1000);
});

test('a live observation with older activity metadata is not moved', () => {
  // The counter-case the review asked for: the scanner reports the session in
  // the current period, so its row is live and wins before the archive is
  // consulted — older activity metadata must not evict or alter it.
  const now = localDate(2026, 10, 15, 12, 0);
  const archive = {
    version: 1,
    sessions: {
      'claude:s-live': {
        client: 'claude',
        sessionId: 's-live',
        capturedAt: localIso(2026, 10, 15, 11, 0),
        day: '2026-10-15',
        month: '2026-10',
        periodWindows: { today: { capturedAt: localIso(2026, 10, 15, 11, 0), day: '2026-10-15' } },
        periods: {
          today: archiveSession('claude', 's-live', 400, localIso(2026, 10, 14, 20, 0))
        }
      }
    }
  };
  const summary = emptyDeviceSummary();
  summary.today = periodWith({ 'claude:s-live': archiveSession('claude', 's-live', 500, localIso(2026, 10, 14, 20, 0)) });

  const visible = applySessionUsageArchive(summary, archive, { now });

  // The live row stands, exactly once, at its own value: the archived copy is
  // skipped rather than replayed on top of it.
  assert.equal(visible.today.sessions['claude:s-live'].totalTokens, 500);
  assert.equal(visible.today.sessions['claude:s-live'].archived, undefined);
  assert.deepEqual(Object.keys(visible.today.sessions), ['claude:s-live']);
});

test('a future-dated activity stamp still lands on the capture day', () => {
  // A source whose clock runs ahead of the capture: the bucket claims the
  // capture day and keeps it. The tokens land on that day rather than
  // vanishing, and the capture-day stamp retires the bucket at the next
  // boundary instead of resurrecting it on the future date.
  const captureAt = localDate(2026, 10, 15, 11, 25);
  const ahead = emptyDeviceSummary();
  ahead.today = periodWith({ 'claude:s-ahead': archiveSession('claude', 's-ahead', 700, localIso(2026, 10, 16, 9, 0)) });
  ahead.month = ahead.today;
  ahead.allTime = ahead.today;

  const { archive } = updateSessionUsageArchive({ version: 1, sessions: {} }, ahead, captureAt);
  const entry = archive.sessions['claude:s-ahead'];
  assert.equal(entry.periodWindows.today.day, '2026-10-15');

  const visible = applySessionUsageArchive(emptyDeviceSummary(), archive, { now: captureAt });
  assert.equal(visible.today.sessions['claude:s-ahead'].totalTokens, 700);

  // And it is gone the next day rather than reappearing on the 16th.
  const nextDay = updateSessionUsageArchive(archive, {}, localDate(2026, 10, 16, 9, 0)).archive;
  assert.equal(nextDay.sessions['claude:s-ahead'].periods.today, undefined);
});

test('an activity stamp that only looks earlier in another frame is retained', () => {
  // The counter-case that exercises the frame comparison: the window was cut
  // at UTC+8, where the activity falls on the day the bucket claims, but read
  // at an offset behind UTC+8 the same instant is the previous day. The
  // summary carries no row for the session, so the replay decision is the
  // only thing between this bucket and today.
  const now = localDate(2026, 10, 15, 12, 0);
  const archive = {
    version: 1,
    sessions: {
      'claude:s-frame': {
        client: 'claude',
        sessionId: 's-frame',
        capturedAt: '2026-10-15T03:25:00.000Z',
        day: '2026-10-15',
        month: '2026-10',
        periodWindows: {
          today: { capturedAt: '2026-10-15T03:25:00.000Z', day: '2026-10-15', utcOffsetMinutes: 480 }
        },
        periods: {
          today: archiveSession('claude', 's-frame', 900, '2026-10-14T16:30:00.000Z')
        }
      }
    }
  };

  const visible = applySessionUsageArchive(emptyDeviceSummary(), archive, { now });

  // 00:30 on the 15th at UTC+8 is the day the bucket claims, so it replays.
  assert.equal(visible.today.sessions['claude:s-frame'].totalTokens, 900);
});

test('a window with no recorded frame is ambiguous and retained', () => {
  // Rows written before the offset was recorded carry no frame evidence, so
  // the activity comparison cannot be made safely and the bucket replays
  // exactly as it did before.
  const now = localDate(2026, 10, 15, 12, 0);
  const archive = {
    version: 1,
    sessions: {
      'claude:s-legacy': {
        client: 'claude',
        sessionId: 's-legacy',
        capturedAt: localIso(2026, 10, 15, 11, 0),
        day: '2026-10-15',
        month: '2026-10',
        periodWindows: { today: { capturedAt: localIso(2026, 10, 15, 11, 0), day: '2026-10-15' } },
        periods: {
          today: archiveSession('claude', 's-legacy', 300, localIso(2026, 10, 14, 20, 0))
        }
      }
    }
  };

  const visible = applySessionUsageArchive(emptyDeviceSummary(), archive, { now });
  assert.equal(visible.today.sessions['claude:s-legacy'].totalTokens, 300);
});

test('a today bucket without an activity stamp is retained as ambiguous', () => {
  // Legacy rows carry no `lastUsedAt`; they keep replaying exactly as before.
  const now = localDate(2026, 10, 15, 12, 0);
  const legacySession = archiveSession('claude', 's-legacy', 300, '');
  delete legacySession.lastUsedAt;
  const archive = {
    version: 1,
    sessions: {
      'claude:s-legacy': {
        client: 'claude',
        sessionId: 's-legacy',
        capturedAt: localIso(2026, 10, 15, 11, 0),
        day: '2026-10-15',
        month: '2026-10',
        periodWindows: {
          today: {
            capturedAt: localIso(2026, 10, 15, 11, 0),
            day: '2026-10-15',
            utcOffsetMinutes: -now.getTimezoneOffset()
          }
        },
        periods: { today: legacySession }
      }
    }
  };

  const visible = applySessionUsageArchive(emptyDeviceSummary(), archive, { now });
  assert.equal(visible.today.sessions['claude:s-legacy'].totalTokens, 300);
});

function capturedRows(rows, capturedAt, reportingDay) {
  const summary = emptyDeviceSummary();
  for (const name of ['today', 'month', 'allTime']) summary[name] = periodWith(rows);
  if (reportingDay !== undefined) summary.periodWindows = { today: { key: reportingDay } };
  return { summary, ...updateSessionUsageArchive({}, summary, capturedAt) };
}

test('stalled captures reject stale rows individually without changing Month, Total or stored data', () => {
  const now = localDate(2026, 10, 17, 11, 25);
  const { archive } = capturedRows({
    'claude:stale': archiveSession('claude', 'stale', 1000, localIso(2026, 10, 14, 20)),
    'claude:current': archiveSession('claude', 'current', 250, localIso(2026, 10, 17, 10))
  }, now);
  const stored = JSON.stringify(archive);
  for (const options of [{}, { canonical: true, canonicalSummary: true, mutate: true }]) {
    const visible = applySessionUsageArchive(emptyDeviceSummary(), archive, { now, ...options });
    assert.equal(visible.today.totalTokens, 250);
    assert.deepEqual(Object.keys(visible.today.sessions), ['claude:current']);
    assert.equal(visible.month.totalTokens, 1250);
    assert.equal(visible.allTime.totalTokens, 1250);
    assert.deepEqual(Object.keys(visible.allTime.sessions).sort(), ['claude:current', 'claude:stale']);
  }
  assert.equal(JSON.stringify(archive), stored);
});

test('a current reporting window retains archived usage with older activity and no live row', () => {
  const now = localDate(2026, 10, 17, 11, 25);
  const { archive } = capturedRows({
    'claude:current': archiveSession('claude', 'current', 500, localIso(2026, 10, 14, 20))
  }, now, '2026-10-17');
  const reloaded = normalizeSessionUsageArchive(JSON.parse(JSON.stringify(archive)));
  const visible = applySessionUsageArchive(emptyDeviceSummary(), reloaded, { now });
  assert.equal(visible.today.totalTokens, 500);
  assert.equal(visible.today.sessions['claude:current'].archived, true);
  assert.equal(visible.month.totalTokens, 500);
  assert.equal(visible.allTime.totalTokens, 500);
});

test('an explicitly stale reporting window cannot be refreshed by newer activity metadata', () => {
  const now = localDate(2026, 10, 17, 11, 25);
  const { archive } = capturedRows({
    'claude:stale': archiveSession('claude', 'stale', 1000, localIso(2026, 10, 17, 10))
  }, now, '2026-10-14');
  const visible = applySessionUsageArchive(emptyDeviceSummary(), archive, { now });
  assert.equal(visible.today.totalTokens, 0);
  assert.equal(visible.month.totalTokens, 1000);
  assert.equal(visible.allTime.totalTokens, 1000);
  // Refusing replay must never re-key or delete the stored observation.
  assert.equal(archive.sessions['claude:stale'].periodWindows.today.day, '2026-10-17');
  assert.equal(archive.sessions['claude:stale'].periods.today.totalTokens, 1000);
});

test('a fresh reporting window replaces stale evidence even when session counters are unchanged', () => {
  const before = localDate(2026, 10, 17, 11);
  const { archive, summary } = capturedRows({
    'claude:current': archiveSession('claude', 'current', 500, localIso(2026, 10, 14, 20))
  }, before, '2026-10-14');
  summary.periodWindows.today.key = '2026-10-17';
  const after = localDate(2026, 10, 17, 12);
  const update = updateSessionUsageArchive(archive, summary, after);
  assert.equal(update.changedKeys.size, 1);
  assert.equal(applySessionUsageArchive(emptyDeviceSummary(), archive, { now: after }).today.totalTokens, 500);
});

test('midnight expires Today while preserving Month, Total and every historical session', () => {
  const before = localDate(2026, 10, 17, 23, 59, 59);
  const after = localDate(2026, 10, 18, 0, 0, 1);
  const { archive } = capturedRows({
    'claude:previous': archiveSession('claude', 'previous', 700, before.toISOString())
  }, before);
  assert.equal(applySessionUsageArchive(emptyDeviceSummary(), archive, { now: before }).today.totalTokens, 700);
  const visible = applySessionUsageArchive(emptyDeviceSummary(), archive, { now: after });
  assert.equal(visible.today.totalTokens, 0);
  assert.equal(visible.month.totalTokens, 700);
  assert.equal(visible.allTime.sessions['claude:previous'].totalTokens, 700);
  updateSessionUsageArchive(archive, null, after);
  assert.equal(archive.sessions['claude:previous'].periods.today, undefined);
  assert.equal(archive.sessions['claude:previous'].periods.month.totalTokens, 700);
  assert.equal(archive.sessions['claude:previous'].periods.allTime.totalTokens, 700);
});

test('month rollover keeps lifetime sessions without replaying expired short periods', () => {
  const before = localDate(2026, 10, 31, 23, 59, 59);
  const after = localDate(2026, 11, 1, 0, 0, 1);
  const { archive } = capturedRows({
    'claude:previous': archiveSession('claude', 'previous', 700, before.toISOString())
  }, before);
  updateSessionUsageArchive(archive, null, after);
  const visible = applySessionUsageArchive(emptyDeviceSummary(), archive, { now: after });
  assert.equal(visible.today.totalTokens, 0);
  assert.equal(visible.month.totalTokens, 0);
  assert.equal(visible.allTime.sessions['claude:previous'].totalTokens, 700);
});

test('SQLite close and reopen preserve the capture frame and row-level replay decisions', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-calendar-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const now = localDate(2026, 10, 17, 11);
  const { summary } = capturedRows({
    'claude:stale': archiveSession('claude', 'stale', 1000, localIso(2026, 10, 14, 20)),
    'claude:current': archiveSession('claude', 'current', 250, localIso(2026, 10, 17, 10))
  }, now);
  const writer = createSessionUsageArchiveStore(options);
  stores.push(writer);
  assert.equal(writer.capture(summary, now).error, null);
  writer.close();
  const reader = createSessionUsageArchiveStore(options);
  stores.push(reader);
  const archive = reader.read(now);
  assert.equal(archive.sessions['claude:stale'].periodWindows.today.utcOffsetMinutes, -now.getTimezoneOffset() || 0);
  const stored = JSON.stringify(archive);
  const visible = applySessionUsageArchive(emptyDeviceSummary(), archive, { now });
  assert.equal(visible.today.totalTokens, 250);
  assert.equal(visible.month.totalTokens, 1250);
  assert.equal(visible.allTime.totalTokens, 1250);
  assert.equal(JSON.stringify(archive), stored);
  assert.equal(reader.capture(emptyDeviceSummary(), now).changedKeys.size, 0);
});

test('SQLite reload retains an explicit current observation after its live row disappears', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-calendar-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const now = localDate(2026, 10, 17, 11);
  const { summary } = capturedRows({
    'claude:current': archiveSession('claude', 'current', 500, localIso(2026, 10, 14, 20))
  }, now, '2026-10-17');
  const writer = createSessionUsageArchiveStore(options);
  stores.push(writer);
  assert.equal(writer.capture(summary, now).error, null);
  writer.close();
  const reader = createSessionUsageArchiveStore(options);
  stores.push(reader);
  assert.equal(applySessionUsageArchive(emptyDeviceSummary(), reader.read(now), { now }).today.totalTokens, 500);
});

test('legacy windows are retained without inventing frame evidence on an unchanged capture', () => {
  const now = localDate(2026, 10, 17, 11);
  const { archive, summary } = capturedRows({
    'claude:legacy': archiveSession('claude', 'legacy', 300, localIso(2026, 10, 14, 20))
  }, now);
  for (const window of Object.values(archive.sessions['claude:legacy'].periodWindows)) delete window.utcOffsetMinutes;
  const stored = JSON.stringify(archive);
  const update = updateSessionUsageArchive(archive, summary, localDate(2026, 10, 17, 12));
  assert.equal(update.changedKeys.size, 0);
  assert.equal(JSON.stringify(archive), stored);
  assert.equal(applySessionUsageArchive(emptyDeviceSummary(), archive, { now }).today.totalTokens, 300);
});

test('malformed offsets and activity timestamps remain ambiguous instead of throwing or deleting usage', () => {
  const now = localDate(2026, 10, 17, 11);
  const { archive } = capturedRows({
    'claude:ambiguous': archiveSession('claude', 'ambiguous', 300, localIso(2026, 10, 14, 20))
  }, now);
  const entry = archive.sessions['claude:ambiguous'];
  for (const offset of [1e300, -1e300, 2000, '480', null]) {
    entry.periodWindows.today.utcOffsetMinutes = offset;
    assert.equal(applySessionUsageArchive(emptyDeviceSummary(), archive, { now, canonical: true }).today.totalTokens, 300);
  }
  entry.periodWindows.today.utcOffsetMinutes = -now.getTimezoneOffset();
  entry.periods.today.lastUsedAt = 'not-a-timestamp';
  assert.equal(applySessionUsageArchive(emptyDeviceSummary(), archive, { now, canonical: true }).today.totalTokens, 300);
});

test('malformed reporting-day evidence cannot override a proven stale activity date', () => {
  const now = localDate(2026, 10, 17, 11);
  const { archive } = capturedRows({
    'claude:stale': archiveSession('claude', 'stale', 300, localIso(2026, 10, 14, 20))
  }, now, '2026-99-99');
  assert.equal(applySessionUsageArchive(emptyDeviceSummary(), archive, { now }).today.totalTokens, 0);
});

test('a SQLite archive written at UTC+8 replays in UTC using the recorded frame', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-calendar-zones-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `
    const { createSessionUsageArchiveStore } = require('./src/shared/usage/sessionUsageArchiveStore');
    const { applySessionUsageArchive } = require('./src/shared/usage/sessionUsageArchive');
    const { normalizePeriod } = require('./src/shared/usage');
    const [mode, dir] = process.argv.slice(1);
    const store = createSessionUsageArchiveStore({ env: { TOKEN_MONITOR_SHARED_DIR: dir } });
    const now = new Date('2026-10-15T03:25:00.000Z');
    const summary = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, normalizePeriod({})]));
    try {
      if (mode === 'write') {
        const rows = {};
        for (const [id, tokens, at] of [
          ['current', 900, '2026-10-14T16:30:00.000Z'],
          ['stale', 1000, '2026-10-14T15:30:00.000Z']
        ]) rows['claude:' + id] = { client: 'claude', sessionId: id, totalTokens: tokens, lastUsedAt: at };
        for (const name of ['today', 'month', 'allTime']) summary[name] = normalizePeriod({ sessions: rows });
        if (store.capture(summary, now).error) throw new Error('capture failed');
      } else {
        const archive = store.read(now);
        const visible = applySessionUsageArchive(summary, archive, { now });
        console.log(JSON.stringify({
          today: visible.today.totalTokens, month: visible.month.totalTokens, total: visible.allTime.totalTokens,
          sessions: Object.keys(visible.today.sessions),
          offset: archive.sessions['claude:current'].periodWindows.today.utcOffsetMinutes
        }));
      }
    } finally { store.close(); }
  `;
  for (const [mode, zone] of [['write', 'Asia/Shanghai'], ['read', 'UTC']]) {
    const child = spawnSync(process.execPath, ['-e', script, mode, dir], {
      cwd: path.resolve(__dirname, '../..'), env: { ...process.env, TZ: zone }, encoding: 'utf8', timeout: 10000
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    if (mode === 'read') assert.deepEqual(JSON.parse(child.stdout), {
      today: 900, month: 1900, total: 1900, sessions: ['claude:current'], offset: 480
    });
  }
});
