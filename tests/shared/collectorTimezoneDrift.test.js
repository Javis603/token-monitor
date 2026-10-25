'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectorAnchorTrust } = require('../../src/shared/collector');
const { localDayKey } = require('../../src/shared/history');

test('collectorAnchorTrust declines anchor with different utcOffsetMinutes', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const todayKey = localDayKey(now);
  const currentOffset = -now.getTimezoneOffset();

  const validAnchor = {
    dateKey: todayKey,
    utcOffsetMinutes: currentOffset,
    today: { totalTokens: 100 },
    month: { totalTokens: 500 },
    allTime: { totalTokens: 1000 },
    configFingerprint: 'dummy',
    fullScanAt: now.toISOString()
  };

  const options = {
    now,
    pricingRevision: 'test'
  };

  // With a mismatched offset, trust is declined (returns null) so a full rescan runs
  const driftedAnchor = {
    ...validAnchor,
    utcOffsetMinutes: currentOffset + 120
  };

  assert.equal(collectorAnchorTrust(driftedAnchor, options), null);
});

test('startCollector clears anchor and forces full scan when timezone offset changes', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-collector-tz-'));
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;

  let scans = 0;
  let handle;
  const updates = [];
  const baseDate = new Date('2026-10-10T12:00:00Z');
  const todayKey = localDayKey(baseDate);

  const options = {
    clients: 'claude',
    projectsEnabled: false,
    intervalMs: 60 * 60 * 1000,
    watchEnabled: false,
    wslScanEnabled: false,
    historyEnabled: false,
    now: baseDate,
    homeDir: tmpShared,
    runTokscale: async () => {
      scans++;
      return { entries: [{ client: 'claude', sessionId: 's1', model: 'opus', input: 10, output: 0, cost: 0 }] };
    },
    onUpdate: (summary) => updates.push(summary)
  };

  try {
    const collector = require('../../src/shared/collector');
    handle = collector.startCollector(options);

    // Initial scan takes 3 queries (today, month, allTime)
    while (updates.length < 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(scans, 3, 'initial tick runs full 3-scan');

    const anchorPath = path.join(tmpShared, 'collector-anchor.json');
    assert.ok(fs.existsSync(anchorPath));
    const saved = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
    assert.equal(saved.dateKey, todayKey);
    assert.equal(typeof saved.utcOffsetMinutes, 'number');

    handle.stop();
    handle = null;
  } finally {
    if (handle) handle.stop();
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});
