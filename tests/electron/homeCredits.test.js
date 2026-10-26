'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { creditsSpentToday, creditsCalibrationLines, homeDeviceRows } = require('../../src/electron/renderer/homeOverview');
const { createCreditsAttacher } = require('../../src/shared/credits/attach');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { aggregateDevices } = require('../../src/shared/usage');
const { normalizeCreditsSummary } = require('../../src/shared/credits/summary');

const NOON = new Date('2026-10-25T12:00:00').getTime();
function atHour(hour) {
  return new Date(`2026-10-25T${String(hour).padStart(2, '0')}:00:00`).getTime();
}

function ledger(events) {
  return {
    available: true,
    tool: 'workbuddy',
    updatedAt: '2026-10-25T12:00:00.000Z',
    totals: { credits: events.length, requests: events.length },
    recentEvents: events
  };
}

test('creditsSpentToday sums only today spend from the bounded event window', () => {
  const credits = ledger([
    { dedupKey: 'a', credits: -3.7, updatedAt: atHour(9) },
    { dedupKey: 'b', credits: -25.78, updatedAt: atHour(11) },
    { dedupKey: 'c', credits: -151, updatedAt: new Date('2026-10-24T23:00:00').getTime() },
    { dedupKey: 'd', credits: 5, updatedAt: atHour(10) },
    { dedupKey: 'e', credits: -1, updatedAt: null }
  ]);
  const spend = creditsSpentToday(credits, NOON);
  assert.equal(Math.round(spend * 100) / 100, 29.48);
});

test('creditsSpentToday returns null for unavailable ledgers or empty days', () => {
  assert.equal(creditsSpentToday(null, NOON), null);
  assert.equal(creditsSpentToday({ available: false, reason: 'x' }, NOON), null);
  assert.equal(creditsSpentToday(ledger([]), NOON), null);
  assert.equal(creditsSpentToday(
    ledger([{ credits: -2, updatedAt: new Date('2026-10-20T09:00:00').getTime() }]),
    NOON
  ), null);
});

test('homeDeviceRows carries creditsToday alongside tokens', () => {
  const rows = homeDeviceRows([
    {
      deviceId: 'local',
      periods: { today: { totalTokens: 500 } },
      credits: ledger([{ credits: -38.2, updatedAt: atHour(14) }])
    },
    { deviceId: 'other', periods: { today: { totalTokens: 900 } } }
  ], { localDeviceId: 'local', now: NOON });
  assert.equal(rows.length, 2);
  const local = rows.find((row) => row.key === 'local');
  assert.equal(local.creditsToday, 38.2);
  const other = rows.find((row) => row.key === 'other');
  assert.equal(other.creditsToday, null);
});

test('createCreditsAttacher rides a real fixture and fails soft when absent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-attach-'));
  try {
    const attach = createCreditsAttacher({ home });
    const absent = attach({ deviceId: 'd', today: { totalTokens: 1 } });
    assert.equal(absent.credits.available, false);
    assert.deepEqual(absent.deviceId, 'd');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('usageTransform applies attachCredits after projection', () => {
  const attach = (summary) => ({ ...summary, credits: { available: true, tool: 'workbuddy', updatedAt: 'x', totals: { credits: 1, requests: 1 } } });
  const transform = createUsageTransform({
    getSettings: () => ({ sessionUsageArchiveEnabled: false, projectsEnabled: false }),
    attachCredits: attach
  });
  const out = transform.transform({ deviceId: 'd', today: { totalTokens: 2 } }, 'test', {});
  assert.equal(out.credits.tool, 'workbuddy');
  assert.equal(out.today.totalTokens, 2);
});

test('aggregateDevices passes the ledger through per device only', () => {
  const credits = { available: true, tool: 'workbuddy', updatedAt: 'x', totals: { credits: 9, requests: 2 } };
  const stats = aggregateDevices([
    { deviceId: 'a', today: { totalTokens: 5 }, credits },
    { deviceId: 'b', today: { totalTokens: 1 } }
  ], 60_000, NOON);
  const deviceA = stats.devices.find((d) => d.deviceId === 'a');
  const deviceB = stats.devices.find((d) => d.deviceId === 'b');
  assert.deepEqual(deviceA.credits, credits);
  assert.equal(deviceB.credits, undefined);
  assert.equal('credits' in stats, false);
});

test('creditsCalibrationLines bounds and sanitizes tooltip entries', () => {
  const lines = creditsCalibrationLines({
    profiles: [{ model: 'hy4-preview', creditsPerMTok: 5884.1, r2: 0.97, samples: 52 }],
    pending: [
      { model: 'space-bunny', r2: 0.99, samples: 4 },
      { model: 'zero', samples: 0 },
      ...Array.from({ length: 5 }, (_, i) => ({ model: 'm' + i, samples: 3 }))
    ]
  }, { pendingLimit: 3 });
  assert.equal(lines.profiles.length, 1);
  assert.equal(lines.profiles[0].creditsPerMTok, 5884.1);
  assert.equal(lines.pending.length, 3);
  assert.deepEqual(creditsCalibrationLines(null), { profiles: [], pending: [] });
});

test('homeDeviceRows carries the calibration block for tooltip rendering', () => {
  const calibration = { profiles: [], pending: [{ model: 'm', samples: 2, r2: null }] };
  const rows = homeDeviceRows([
    {
      deviceId: 'local',
      periods: { today: { totalTokens: 5 } },
      credits: {
        available: true,
        totals: { credits: 6348.06, requests: 192 },
        recentEvents: [{ credits: -3, updatedAt: atHour(9) }],
        calibration
      }
    }
  ], { now: NOON });
  assert.deepEqual(rows[0].creditsCalibration, calibration);
  assert.equal(rows[0].creditsAvailable, true);
  assert.equal(rows[0].creditsTotal, 6348.06);
});

test('a connected ledger with no spend today still surfaces availability', () => {
  const rows = homeDeviceRows([
    {
      deviceId: 'local',
      periods: { today: { totalTokens: 5 } },
      credits: {
        available: true,
        totals: { credits: 12.5, requests: 3 },
        recentEvents: [{ credits: -2, updatedAt: atHour(9) - 7 * 24 * 3600 * 1000 }]
      }
    }
  ], { now: NOON });
  assert.equal(rows[0].creditsToday, null);
  assert.equal(rows[0].creditsAvailable, true);
  assert.equal(rows[0].creditsTotal, 12.5);
});

test('normalizeCreditsSummary keeps a bounded calibration block, drops junk', () => {
  const normalized = normalizeCreditsSummary({
    available: true,
    totals: { credits: 1, requests: 1 },
    calibration: {
      profiles: [{ model: 'ok', creditsPerMTok: 1.2, r2: 0.95, samples: 60 }],
      pending: [{ junk: true }, { model: 'p', samples: 'x' }, { model: 'good', samples: 3, reason: 'insufficient_samples' }]
    }
  });
  assert.equal(normalized.calibration.profiles.length, 1);
  assert.equal(normalized.calibration.pending.length, 1);
  assert.equal(normalized.calibration.pending[0].model, 'good');
  assert.equal(normalizeCreditsSummary({ available: true, totals: { credits: 1 }, calibration: { profiles: [], pending: [] } }).calibration, undefined);
});

test('the attacher produces a fitted calibration end to end', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-attach-cal-'));
  try {
    const sqlite = require('node:sqlite');
    const dir = path.join(home, '.workbuddy');
    fs.mkdirSync(dir, { recursive: true });
    const db = new sqlite.DatabaseSync(path.join(dir, 'workbuddy.db'));
    db.exec('CREATE TABLE session_usage (session_id TEXT, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT);');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT, created_at INTEGER, updated_at INTEGER);');
    const ins = db.prepare('INSERT INTO sessions (id, model) VALUES (?, ?)');
    const usage = db.prepare('INSERT INTO session_usage VALUES (?, ?, ?, ?, ?)');
    // 55 exact-linear sessions on one model: 1.25 credits per Mtok.
    for (let i = 0; i < 55; i++) {
      const tokens = 100_000 + i * 20_000;
      ins.run('s' + i, 'hy4-preview');
      usage.run('s' + i, tokens, 1_000_000, NOON, JSON.stringify({ r: tokens * 0.00000125 }));
    }
    db.close();
    const attach = createCreditsAttacher({ home, now: new Date(NOON) });
    const out = attach({ deviceId: 'd', today: { totalTokens: 1 } });
    assert.equal(out.credits.available, true);
    assert.equal(out.credits.calibration.profiles.length, 1);
    assert.equal(out.credits.calibration.profiles[0].model, 'hy4-preview');
    assert.equal(out.credits.calibration.profiles[0].creditsPerMTok, 1.25);
    assert.equal(out.credits.calibration.profiles[0].r2, 1);
    // The wire normalization round-trips what the attacher produced.
    const round = normalizeCreditsSummary(out.credits);
    assert.equal(round.calibration.profiles[0].creditsPerMTok, 1.25);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
