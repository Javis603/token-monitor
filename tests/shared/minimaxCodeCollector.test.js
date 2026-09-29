'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startCollector } = require('../../src/shared/collector');

function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for collector'));
      }
    }, 10);
  });
}

function row(tokens, createdAt) {
  return {
    sessionId: 's1',
    model: 'model-a',
    createdAt,
    input: 0,
    output: tokens,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0
  };
}

function minimaxTokens(summary) {
  return summary?.allTime?.clients?.minimaxcode || 0;
}

function historyTokens(summary) {
  const day = summary?.history?.daily?.find((entry) => entry?.perClient?.minimaxcode);
  return day?.perClient?.minimaxcode?.tokens || 0;
}

test('a disappeared MiniMax database stays at zero after another client refreshes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimaxcode-gone-'));
  const updates = [];
  const scans = [];
  let snapshot = { ok: true, sourcePath: path.join(home, 'missing.sqlite'), rows: [row(9, Date.now())] };
  const handle = startCollector({
    clients: 'claude,minimaxcode',
    allTimeSince: '2020-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'device',
    agentVersion: 'test',
    intervalMs: 60 * 60 * 1000,
    watchEnabled: false,
    historyEnabled: false,
    anchorPersistenceEnabled: false,
    wslScanEnabled: false,
    env: { MINIMAX_DATA_DIR: home },
    homeDir: home,
    readMiniMaxCodeSnapshot: () => snapshot,
    lookupModelPricing: async () => null,
    runTokscale: async (input) => {
      scans.push(input);
      return { entries: [{ client: 'claude', model: 'claude', input: 1, output: 1, totalTokens: 2 }] };
    },
    onUpdate: (summary) => updates.push(summary)
  });
  try {
    await waitFor(() => updates.length === 1);
    assert.equal(minimaxTokens(updates[0]), 9);

    snapshot = { ok: false, code: 'no-database', sourcePath: path.join(home, 'missing.sqlite') };
    await handle.tick('manual');
    await waitFor(() => updates.length === 2);
    assert.equal(minimaxTokens(updates[1]), 0);

    const scansBefore = scans.length;
    await handle.refreshClient('claude');
    await waitFor(() => updates.length === 3);
    assert.equal(minimaxTokens(updates[2]), 0);
    const targeted = scans.slice(scansBefore);
    assert.ok(targeted.length > 0);
    assert.ok(targeted.every((call) => String(call.clients).split(',').includes('claude')));
    assert.ok(targeted.every((call) => !String(call.clients).split(',').includes('minimaxcode')));
    assert.ok(targeted.every((call) => (call.flags || []).includes('--today')));
  } finally {
    handle.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('refreshing only MiniMax does not scan the other tracked clients', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimaxcode-target-'));
  const updates = [];
  const scans = [];
  const handle = startCollector({
    clients: 'claude,minimaxcode',
    allTimeSince: '2020-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'device',
    agentVersion: 'test',
    intervalMs: 60 * 60 * 1000,
    watchEnabled: false,
    historyEnabled: false,
    anchorPersistenceEnabled: false,
    wslScanEnabled: false,
    env: { MINIMAX_DATA_DIR: home },
    homeDir: home,
    readMiniMaxCodeSnapshot: () => ({ ok: true, sourcePath: path.join(home, 'db.sqlite'), rows: [row(4, Date.now())] }),
    lookupModelPricing: async () => null,
    runTokscale: async (input) => {
      scans.push(input);
      return { entries: [] };
    },
    onUpdate: (summary) => updates.push(summary)
  });
  try {
    await waitFor(() => updates.length === 1);
    const before = scans.length;
    await handle.refreshClient('minimaxcode');
    await waitFor(() => updates.length === 2);
    assert.equal(scans.length, before);
    assert.equal(minimaxTokens(updates[1]), 4);
  } finally {
    handle.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('manual refresh publishes the corrected history before the update, and a watch does not rewrite the archive', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimaxcode-history-'));
  const archivePath = path.join(home, 'daily-history-archive.json');
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  fs.writeFileSync(archivePath, JSON.stringify({
    version: 1,
    days: {
      [todayKey]: {
        date: todayKey,
        activeTimeMs: 0,
        observations: {
          mini: {
            client: 'minimaxcode',
            modelId: 'model-a',
            tokens: 100,
            cost: 0,
            messages: 1,
            tokenComponentsAvailable: true,
            outputTokens: 100
          }
        }
      }
    }
  }));
  let rows = [row(100, now.getTime())];
  const updates = [];
  let diskDuringUpdate = null;
  const handle = startCollector({
    clients: 'minimaxcode',
    allTimeSince: '2020-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'device',
    agentVersion: 'test',
    intervalMs: 60 * 60 * 1000,
    historyIntervalMs: 60 * 60 * 1000,
    watchEnabled: false,
    historyEnabled: true,
    dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveWriteEnabled: true,
    dailyHistoryArchiveOptions: { path: archivePath },
    anchorPersistenceEnabled: false,
    wslScanEnabled: false,
    env: { MINIMAX_DATA_DIR: home },
    homeDir: home,
    readMiniMaxCodeSnapshot: () => ({ ok: true, sourcePath: path.join(home, 'db.sqlite'), rows }),
    lookupModelPricing: async () => null,
    runTokscale: async () => ({ entries: [] }),
    onUpdate: (summary) => {
      diskDuringUpdate = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
      updates.push(summary);
    }
  });
  try {
    await waitFor(() => updates.length === 1);
    assert.equal(minimaxTokens(updates[0]), 100);
    assert.equal(historyTokens(updates[0]), 100);

    rows = [row(40, now.getTime())];
    await handle.refreshClient('minimaxcode');
    await waitFor(() => updates.length === 2);
    assert.equal(minimaxTokens(updates[1]), 40);
    assert.equal(historyTokens(updates[1]), 40);
    const watchDay = diskDuringUpdate.days[todayKey];
    const watchTokens = Object.values(watchDay.observations).find((entry) => entry.client === 'minimaxcode').tokens;
    assert.equal(watchTokens, 100);

    await handle.tick('manual');
    await waitFor(() => updates.length === 3);
    assert.equal(historyTokens(updates[2]), 40);
    const manualDay = diskDuringUpdate.days[todayKey];
    const manualTokens = Object.values(manualDay.observations).find((entry) => entry.client === 'minimaxcode').tokens;
    assert.equal(manualTokens, 40);
  } finally {
    handle.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
