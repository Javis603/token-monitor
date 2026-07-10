'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
const { emptyPeriod } = require('../../src/shared/usage');

function bundleWith(clientTokens) {
  const mk = () => { const p = emptyPeriod(); p.totalTokens = clientTokens; p.clients = { gemini: clientTokens }; return p; };
  return { today: mk(), month: mk(), allTime: mk() };
}

// Stub tokscale so the Windows scan reports only claude usage.
async function windowsTokscale() {
  return { entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus-4-8', input: 20, output: 0, cost: 0 }] };
}

test('full tick merges WSL bundle and marks WSL-only client active', async () => {
  let anchorCaptured = null;
  const summary = await collectUsageOnce({
    clients: 'claude,gemini',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    runTokscale: windowsTokscale,
    collectWslUsage: async () => ({ bundle: bundleWith(9), detected: ['gemini'] }),
    onAnchorComputed: (x) => { anchorCaptured = x; }
  });
  // merged totals: windows 20 + wsl 9
  assert.equal(summary.today.totalTokens, 29);
  assert.deepEqual(summary.today.clients, { claude: 20, gemini: 9 });
  // gemini has no Windows data dir but has WSL usage -> active
  assert.equal(summary.clientStatus.gemini, 'active');
  // anchor basis is Windows-only
  assert.equal(anchorCaptured.windowsPeriods.today.totalTokens, 20);
  assert.equal(anchorCaptured.wslBundle.today.totalTokens, 9);
});

test('WSL scans exclude locally parsed Proma while retaining it for marker detection', async () => {
  let wslOptions = null;
  const collectedAt = '2026-07-10T08:00:00.000Z';
  await collectUsageOnce({
    clients: 'claude,proma',
    allTimeSince: '2025-01-01',
    now: collectedAt,
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    runTokscale: windowsTokscale,
    collectWslUsage: async (options) => {
      wslOptions = options;
      return { bundle: { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() }, detected: [] };
    }
  });
  assert.equal(wslOptions.clients, 'claude');
  assert.equal(wslOptions.trackedClients, 'claude,proma');
  assert.equal(wslOptions.now.toISOString(), collectedAt);
});

test('watch tick reuses wslAnchor and does not rescan WSL', async () => {
  let wslCalls = 0;
  const anchor = { dateKey: localTodayKey(), today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
  const summary = await collectUsageOnce({
    clients: 'claude,gemini',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    runTokscale: windowsTokscale,
    todayOnlyAnchor: anchor,
    wslAnchor: bundleWith(9),
    collectWslUsage: async () => { wslCalls += 1; return { bundle: bundleWith(0), detected: [] }; }
  });
  assert.equal(wslCalls, 0); // reused, not rescanned
  assert.equal(summary.today.clients.gemini, 9); // frozen WSL contribution present
});

test('interval anchored tick with refreshWsl rescans WSL and updates anchor', async () => {
  let wslCalls = 0;
  let capturedWsl = null;
  const anchor = { dateKey: localTodayKey(), today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
  const firstBundle = bundleWith(9);
  const secondBundle = bundleWith(15);
  let useSecond = false;

  const summary = await collectUsageOnce({
    clients: 'claude,gemini',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    runTokscale: windowsTokscale,
    todayOnlyAnchor: anchor,
    wslAnchor: bundleWith(3),     // frozen snapshot that would be used by a watch tick
    refreshWsl: true,             // interval tick: refresh WSL independently
    collectWslUsage: async () => {
      wslCalls += 1;
      const b = useSecond ? secondBundle : firstBundle;
      useSecond = true;
      return { bundle: b, detected: ['gemini'] };
    },
    onAnchorComputed: (x) => { capturedWsl = x.wslBundle; }
  });

  // WSL was rescanned (not reused from wslAnchor)
  assert.equal(wslCalls, 1, 'interval anchored tick must rescan WSL');

  // The frozen anchor had gemini=3, but fresh scan returned gemini=9
  assert.equal(summary.today.clients.gemini, 9, 'fresh WSL data must be used');

  // onAnchorComputed must reflect the freshly scanned WSL data
  assert.equal(capturedWsl.today.clients.gemini, 9, 'anchor callback must have fresh WSL');

  // Second call: verify refreshWsl=false (watch mode) reuses wslAnchor instead
  wslCalls = 0;
  await collectUsageOnce({
    clients: 'claude,gemini',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    runTokscale: windowsTokscale,
    todayOnlyAnchor: anchor,
    wslAnchor: capturedWsl,        // updated anchor from the interval refresh
    collectWslUsage: async () => { wslCalls += 1; return { bundle: bundleWith(0), detected: [] }; }
  });
  assert.equal(wslCalls, 0, 'watch tick must reuse wslAnchor, not rescan');
});

test('wslScanEnabled:false skips the WSL scan entirely', async () => {
  let wslCalls = 0;
  const summary = await collectUsageOnce({
    clients: 'claude,gemini',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    wslScanEnabled: false,
    runTokscale: windowsTokscale,
    collectWslUsage: async () => { wslCalls += 1; return { bundle: bundleWith(9), detected: ['gemini'] }; }
  });
  assert.equal(wslCalls, 0); // WSL scan never invoked
  assert.equal(summary.today.totalTokens, 20); // windows-only, no WSL contribution
  assert.deepEqual(summary.today.clients, { claude: 20 }); // gemini (WSL-only) absent
  assert.notEqual(summary.clientStatus.gemini, 'active'); // not active without WSL usage
});

test('wslStatus active lists detected and withData when WSL has usage', async () => {
  const summary = await collectUsageOnce({
    clients: 'claude,gemini',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    platform: 'win32',
    runTokscale: windowsTokscale,
    collectWslUsage: async () => ({ bundle: bundleWith(9), detected: ['gemini'] }),
    probeWslState: () => 'ok'
  });
  assert.equal(summary.wslStatus.state, 'active');
  assert.deepEqual(summary.wslStatus.detected, ['gemini']);
  assert.deepEqual(summary.wslStatus.withData, ['gemini']);
});

test('wslStatus is null on non-Windows platforms', async () => {
  const summary = await collectUsageOnce({
    clients: 'claude,gemini',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    platform: 'darwin',
    runTokscale: windowsTokscale,
    collectWslUsage: async () => ({ bundle: bundleWith(9), detected: ['gemini'] }),
    probeWslState: () => 'ok'
  });
  assert.equal(summary.wslStatus, null);
});

test('wslStatus is not-installed when WSL is absent (still a non-null panel state)', async () => {
  const summary = await collectUsageOnce({
    clients: 'claude',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    platform: 'win32',
    runTokscale: windowsTokscale,
    collectWslUsage: async () => ({ bundle: bundleWith(0), detected: [] }),
    probeWslState: () => 'not-installed'
  });
  assert.deepEqual(summary.wslStatus, { state: 'not-installed', detected: [], withData: [] });
});

test('watch tick preserves wslStatus.detected from the frozen anchor', async () => {
  const summary = await collectUsageOnce({
    clients: 'claude,gemini',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    runTokscale: windowsTokscale,
    platform: 'win32',
    todayOnlyAnchor: { dateKey: localTodayKey(), today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() },
    wslAnchor: bundleWith(9),
    wslStatus: { state: 'active', detected: ['gemini'], withData: ['gemini'] }, // frozen from the last full scan
    collectWslUsage: async () => ({ bundle: bundleWith(0), detected: [] }),
    probeWslState: () => 'ok'
  });
  assert.deepEqual(summary.wslStatus.detected, ['gemini']); // not [] despite frozen tick
});

test('anchored watch tick reuses frozen wslStatus without re-probing', async () => {
  let probes = 0;
  const frozen = { state: 'no-data', detected: ['hermes'], withData: [] };
  const summary = await collectUsageOnce({
    clients: 'claude,gemini',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    runTokscale: windowsTokscale,
    platform: 'win32',
    todayOnlyAnchor: { dateKey: localTodayKey(), today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() },
    wslAnchor: bundleWith(9),
    wslStatus: frozen,                // frozen snapshot from the last full scan
    collectWslUsage: async () => ({ bundle: bundleWith(0), detected: [] }),
    probeWslState: () => { probes += 1; return 'ok'; }
  });
  assert.equal(probes, 0, 'anchored watch tick must NOT spawn the WSL readiness probe');
  assert.deepEqual(summary.wslStatus, frozen); // reused verbatim, not recomputed
});

test('wslStatus disabled when wslScanEnabled is false (no scan run)', async () => {
  let called = 0;
  const summary = await collectUsageOnce({
    clients: 'claude',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    wslScanEnabled: false,
    platform: 'win32',
    runTokscale: windowsTokscale,
    collectWslUsage: async () => { called += 1; return { bundle: bundleWith(9), detected: ['gemini'] }; }
  });
  assert.equal(called, 0);
  assert.deepEqual(summary.wslStatus, { state: 'disabled', detected: [], withData: [] });
});
