'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applySessionDayArchive,
  normalizeSessionUsageArchive,
  updateSessionUsageArchive
} = require('../../src/shared/usage/sessionUsageArchive');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { emptyPeriod, normalizePeriod } = require('../../src/shared/usage');

// Local noon, so day keys cannot straddle midnight in any test timezone.
const NOW = new Date(2026, 10, 24, 12, 0, 0);
const TODAY = '2026-11-24';

function dayKey(offset, from = TODAY) {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function row(sessionId, tokens, extra = {}) {
  return {
    client: 'claude', sessionId, totalTokens: tokens, costUsd: tokens / 100,
    inputTokens: tokens, models: { 'claude-sonnet-4-5': tokens }, modelCosts: { 'claude-sonnet-4-5': tokens / 100 }, ...extra
  };
}

function period(...rows) {
  return normalizePeriod({ sessions: Object.fromEntries(rows.map((value) => [`${value.client}:${value.sessionId}`, value])) });
}

// A full tick: All Time lists every live session, and past days list theirs.
function fullTick({ allTime, days, updatedAt = NOW }) {
  return {
    updatedAt: updatedAt.toISOString(),
    sessionUsageArchiveFullScan: true,
    today: emptyPeriod(),
    month: emptyPeriod(),
    allTime,
    nativeRangeDays: Object.fromEntries(Object.entries(days).map(([day, value]) => [day, { sessions: value.sessions }]))
  };
}

function capture(archive, record, at = NOW) {
  return updateSessionUsageArchive(archive, record, at, { canonicalSummary: true }).archive;
}

function last7(...rows) {
  return { nativeRanges: { last7: period(...rows) }, nativeRangeWindows: { last7: { start: dayKey(6), end: TODAY } } };
}

test('a full tick keeps each past day of every scanned session', () => {
  const archive = capture(normalizeSessionUsageArchive({}), fullTick({
    allTime: period(row('kept', 30, { title: 'Kept session' })),
    days: { [dayKey(1)]: period(row('kept', 10)), [dayKey(3)]: period(row('kept', 20)) }
  }));
  const entry = archive.sessions['claude:kept'];
  assert.deepEqual(Object.keys(entry.days).sort(), [dayKey(3), dayKey(1)]);
  assert.equal(entry.days[dayKey(1)].session.totalTokens, 10);
  // The days survive the archive's own normalization (its read path).
  const reread = normalizeSessionUsageArchive(JSON.parse(JSON.stringify(archive)));
  assert.equal(reread.sessions['claude:kept'].days[dayKey(3)].session.totalTokens, 20);
});

test('a range adds back a session whose source is gone, from its days in range only', () => {
  const archive = capture(normalizeSessionUsageArchive({}), fullTick({
    allTime: period(row('gone', 1000, { title: 'Deleted transcript', projectId: 'p1', projectLabel: 'Project' })),
    days: { [dayKey(2)]: period(row('gone', 40)), [dayKey(10)]: period(row('gone', 900)) }
  }));
  const summary = last7(row('live', 5));
  const before = JSON.stringify(summary);
  const next = applySessionDayArchive(summary, archive, { now: NOW });
  const range = next.nativeRanges.last7;
  const restored = range.sessions['claude:gone'];
  // Day 10 is outside Last 7 days; the All Time total never leaks in.
  assert.equal(restored.totalTokens, 40);
  assert.equal(restored.archived, true);
  assert.equal(restored.title, 'Deleted transcript');
  assert.equal(restored.projectId, 'p1');
  assert.equal(range.totalTokens, summary.nativeRanges.last7.totalTokens + 40);
  assert.equal(range.clients.claude, (summary.nativeRanges.last7.clients.claude || 0) + 40);
  // The summary it was given is untouched.
  assert.equal(JSON.stringify(summary), before);
});

test('a session the range still lists keeps its scanned row', () => {
  const archive = capture(normalizeSessionUsageArchive({}), fullTick({
    allTime: period(row('live', 100)),
    days: { [dayKey(1)]: period(row('live', 60)) }
  }));
  const summary = last7(row('live', 7));
  assert.equal(applySessionDayArchive(summary, archive, { now: NOW }), summary);
});

test('a live session no longer reported on a day loses that day', () => {
  let archive = capture(normalizeSessionUsageArchive({}), fullTick({
    allTime: period(row('moved', 50)),
    days: { [dayKey(1)]: period(row('moved', 20)), [dayKey(2)]: period(row('moved', 30)) }
  }));
  const later = new Date(NOW.getTime() + 60_000);
  archive = capture(archive, fullTick({
    allTime: period(row('moved', 50)),
    days: { [dayKey(1)]: period(row('moved', 50)), [dayKey(2)]: period() },
    updatedAt: later
  }), later);
  assert.deepEqual(Object.keys(archive.sessions['claude:moved'].days), [dayKey(1)]);
  assert.equal(archive.sessions['claude:moved'].days[dayKey(1)].session.totalTokens, 50);
});

test('a session missing from the whole scan keeps its days', () => {
  let archive = capture(normalizeSessionUsageArchive({}), fullTick({
    allTime: period(row('gone', 20)),
    days: { [dayKey(1)]: period(row('gone', 20)) }
  }));
  const later = new Date(NOW.getTime() + 60_000);
  archive = capture(archive, fullTick({ allTime: period(), days: { [dayKey(1)]: period() }, updatedAt: later }), later);
  assert.equal(archive.sessions['claude:gone'].days[dayKey(1)].session.totalTokens, 20);
});

test('an older capture never replaces a newer day', () => {
  const later = new Date(NOW.getTime() + 60_000);
  let archive = capture(normalizeSessionUsageArchive({}), fullTick({
    allTime: period(row('s', 9)), days: { [dayKey(1)]: period(row('s', 9)) }, updatedAt: later
  }), later);
  archive = capture(archive, fullTick({ allTime: period(row('s', 4)), days: { [dayKey(1)]: period(row('s', 4)) } }));
  assert.equal(archive.sessions['claude:s'].days[dayKey(1)].session.totalTokens, 9);
});

test('days older than the longest range are pruned when the day advances', () => {
  let archive = capture(normalizeSessionUsageArchive({}), fullTick({
    allTime: period(row('s', 30)),
    days: { [dayKey(29)]: period(row('s', 10)), [dayKey(1)]: period(row('s', 20)) }
  }));
  const tomorrow = new Date(2026, 10, 25, 12, 0, 0);
  archive = updateSessionUsageArchive(archive, null, tomorrow).archive;
  assert.deepEqual(Object.keys(archive.sessions['claude:s'].days), [dayKey(1)]);
});

test('watch ticks without past days leave the retained days alone', () => {
  const archive = capture(normalizeSessionUsageArchive({}), fullTick({
    allTime: period(row('s', 30)), days: { [dayKey(1)]: period(row('s', 30)) }
  }));
  const later = new Date(NOW.getTime() + 60_000);
  const watched = capture(archive, {
    updatedAt: later.toISOString(), sessionUsageArchiveFullScan: false,
    today: period(row('other', 1)), month: period(row('other', 1)), allTime: period(row('other', 1))
  }, later);
  assert.equal(watched.sessions['claude:s'].days[dayKey(1)].session.totalTokens, 30);
});

test('the SQLite store keeps the days and the transform publishes no past-day input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-session-days-'));
  try {
    const store = createSessionUsageArchiveStore({ databasePath: path.join(dir, 'archive.sqlite'), path: path.join(dir, 'archive.json') });
    const transform = createUsageTransform({ store, getSettings: () => ({ clients: 'claude' }) });
    const record = fullTick({
      allTime: period(row('gone', 40, { title: 'Gone' })),
      days: { [dayKey(2)]: period(row('gone', 40)) }
    });
    const first = transform.transform({ ...record, ...last7(row('gone', 40)) });
    assert.equal(first.nativeRangeDays, undefined);
    assert.equal(first.nativeRanges.last7.sessions['claude:gone'].archived, undefined);
    store.close();

    // A restart reads the days back and fills the range the scan no longer can.
    const reopened = createSessionUsageArchiveStore({ databasePath: path.join(dir, 'archive.sqlite'), path: path.join(dir, 'archive.json') });
    const later = createUsageTransform({ store: reopened, getSettings: () => ({ clients: 'claude' }) });
    const projected = later.project({ updatedAt: NOW.toISOString(), today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod(), ...last7() },
      later.ensureLoaded(), NOW);
    assert.equal(projected.nativeRanges.last7.sessions['claude:gone'].totalTokens, 40);
    assert.equal(projected.nativeRanges.last7.sessions['claude:gone'].title, 'Gone');
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
