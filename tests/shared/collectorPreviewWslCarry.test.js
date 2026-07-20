'use strict';

// Regression: during a warm full scan the progressive preview must keep the
// frozen WSL contribution in BOTH today and month. The partials from
// collectUsageOnce are host-only (WSL is merged later), so without carrying the
// previous tick's wslAnchor the today/month cards would briefly drop their WSL
// usage until the final update. allTime and clientStatus are never part of a
// preview (carried forward in main.js), so they must not appear in one.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the shared data dir so startCollector's persisted collector-anchor.json
// neither writes the real user data dir nor leaks a stale anchor into this test's
// "cold" first tick (which would turn it into an anchored, preview-less tick).
const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-preview-wsl-'));
process.env.TOKEN_MONITOR_SHARED_DIR = sharedDir;
process.on('exit', () => { try { fs.rmSync(sharedDir, { recursive: true, force: true }); } catch (_) {} });

const { startCollector, wslPeriodsForPreview } = require('../../src/shared/collector');
const { emptyPeriod } = require('../../src/shared/usage');

test('wslPeriodsForPreview gates the frozen WSL snapshot by day and month', () => {
  const anchor = {
    today: { ...emptyPeriod(), totalTokens: 10 },
    month: { ...emptyPeriod(), totalTokens: 30 },
    allTime: { ...emptyPeriod(), totalTokens: 100 }
  };

  // Same day (and month): both today and month are valid to merge.
  let r = wslPeriodsForPreview(anchor, '2026-06-23', '2026-06-23');
  assert.equal(r.today, anchor.today);
  assert.equal(r.month, anchor.month);

  // Cross day, same month: today must drop, month still valid.
  r = wslPeriodsForPreview(anchor, '2026-06-22', '2026-06-23');
  assert.equal(r.today, null);
  assert.equal(r.month, anchor.month);

  // Cross month: both drop.
  r = wslPeriodsForPreview(anchor, '2026-05-31', '2026-06-01');
  assert.equal(r.today, null);
  assert.equal(r.month, null);

  // No anchor: both null, never throws.
  r = wslPeriodsForPreview(null, '2026-06-23', '2026-06-23');
  assert.equal(r.today, null);
  assert.equal(r.month, null);
});

// Host-only tokscale results per period (totalTokens = input + output).
function hostScan({ flags }) {
  if (flags.includes('--today')) return { entries: [{ client: 'claude', sessionId: 'h', model: 'm', input: 100, output: 0, cost: 1 }] };
  if (flags.includes('--month')) return { entries: [{ client: 'claude', sessionId: 'h', model: 'm', input: 300, output: 0, cost: 3 }] };
  return { entries: [{ client: 'claude', sessionId: 'h', model: 'm', input: 1000, output: 0, cost: 10 }] };
}

function wslBundle() {
  return {
    today: { ...emptyPeriod(), totalTokens: 10, clients: { claude: 10 } },
    month: { ...emptyPeriod(), totalTokens: 30, clients: { claude: 30 } },
    allTime: { ...emptyPeriod(), totalTokens: 100, clients: { claude: 100 } }
  };
}

function waitForUpdates(updates, count) {
  if (updates.length >= count) return Promise.resolve();
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (updates.length >= count) { clearInterval(interval); resolve(); }
    }, 5);
  });
}

test('warm progressive preview keeps the frozen WSL contribution in today and month', async () => {
  const previews = [];
  const updates = [];
  const handle = startCollector({
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    agentVersion: 'test',
    osInfo: { name: 'macOS', version: '26.5.2' },
    intervalMs: 60 * 60 * 1000,
    watchEnabled: false,
    historyEnabled: false,
    limitsEnabled: false,
    runTokscale: hostScan,
    collectWslUsage: async () => ({ bundle: wslBundle(), detected: ['claude'] }),
    onPreview: (p) => previews.push(p),
    onUpdate: (summary) => updates.push(summary)
  });

  try {
    // First (cold) tick establishes the WSL anchor. Its previews have no anchor
    // to merge yet, so today is host-only.
    await waitForUpdates(updates, 1);
    const cold = previews.slice();
    assert.ok(cold.length >= 1, 'cold tick should emit at least one preview');
    assert.equal(cold[0].osName, 'macOS', 'preview carries the friendly OS name immediately');
    assert.equal(cold[0].osVersion, '26.5.2', 'preview carries static OS metadata immediately');
    assert.equal(cold[0].today.totalTokens, 100, 'cold preview today is host-only (no WSL anchor yet)');

    // Second (warm) tick: previews must merge the frozen WSL snapshot captured on
    // the first tick into today and month.
    const before = previews.length;
    await handle.tick('manual');
    await waitForUpdates(updates, 2);
    const warm = previews.slice(before);
    assert.equal(warm.length, 2, 'warm full tick emits two previews (today, then today+month)');

    // today-stage preview
    assert.equal(warm[0].today.totalTokens, 110, 'warm today carries WSL (host 100 + WSL 10)');
    assert.equal('month' in warm[0], false, 'today-stage preview omits month');
    assert.equal('allTime' in warm[0], false, 'preview never carries allTime');
    assert.equal('clientStatus' in warm[0], false, 'preview never carries clientStatus');

    // month-stage preview
    assert.equal(warm[1].today.totalTokens, 110, 'warm today still carries WSL after the month scan');
    assert.equal(warm[1].month.totalTokens, 330, 'warm month carries WSL (host 300 + WSL 30)');
    assert.equal('allTime' in warm[1], false, 'preview never carries allTime');
    assert.equal('clientStatus' in warm[1], false, 'preview never carries clientStatus');

    // Final update is complete: today/month/allTime all include WSL.
    assert.equal(updates[1].today.totalTokens, 110, 'final today = host 100 + WSL 10');
    assert.equal(updates[1].month.totalTokens, 330, 'final month = host 300 + WSL 30');
    assert.equal(updates[1].allTime.totalTokens, 1100, 'final allTime = host 1000 + WSL 100');
  } finally {
    handle.stop();
  }
});
