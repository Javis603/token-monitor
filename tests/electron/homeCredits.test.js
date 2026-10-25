'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { creditsSpentToday, homeDeviceRows } = require('../../src/electron/renderer/homeOverview');
const { createCreditsAttacher } = require('../../src/shared/credits/attach');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { aggregateDevices } = require('../../src/shared/usage');

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
