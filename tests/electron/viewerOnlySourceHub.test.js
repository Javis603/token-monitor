'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { createHub } = require('../../src/hub/server');
const { classifySettingsChange, clientCollectsLocally } = require('../../src/electron/runtimeConfig');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

function extractFunction(signature, nextMarker) {
  const start = main.indexOf(signature);
  assert.ok(start >= 0, `${signature} exists`);
  const end = main.indexOf(nextMarker, start);
  assert.ok(end > start, `${nextMarker} follows ${signature}`);
  return main.slice(start, end);
}

function runSyncCollector(settings) {
  const calls = [];
  const sandbox = {
    settings,
    lastCollectedDevice: { deviceId: 'stale-local' },
    deviceRuntimeHandle: null,
    hubModeGeneration: 1,
    clientCollectsLocally,
    stopSyncCollector() { calls.push('stop'); },
    effectiveHubConfig() { return { url: 'http://host-a.test', secret: 'shared-secret' }; },
    captureMacWidgetProducerOwner() { return null; },
    syncUploadIntervalMs() { return 0; },
    createSyncUploadScheduler() { calls.push('scheduler'); return { enqueue() {}, flush() {}, stop() {} }; },
    postToHub() {},
    seedInitialLimitProviders() {},
    isExternalAgentActive() { return false; },
    usageTransform: { forget() {} },
    requestSyncDisplayStats() { calls.push('overlay'); },
    electronUsageConfig() { calls.push('usage-config'); return {}; },
    electronDeviceEnvelope() { return {}; },
    electronLimitsConfig() { calls.push('limits-config'); return {}; },
    createDeviceRuntime() { calls.push('runtime'); return {}; },
    createElectronUsageRuntime() {},
    electronLimitsDeps() { return {}; },
    usageRuntimeReconciler: { setActiveKey() {} },
    usageConfigFingerprint() { return ''; },
    drainPendingRuntimeActions() {},
    publishLocalSessionActivity() {},
    recordDiagnosticEvent() {},
    console: { log() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('function startSyncCollector()', '\n// Host mode:'), sandbox);
  sandbox.startSyncCollector();
  return { calls, lastCollectedDevice: sandbox.lastCollectedDevice, deviceRuntimeHandle: sandbox.deviceRuntimeHandle };
}

function runMode(settings) {
  const calls = [];
  const sandbox = {
    settings,
    hubModeGeneration: 0,
    modeQueue: Promise.resolve(),
    getSyncContentRuntime() { return { invalidate() {}, refresh() { calls.push('refresh'); } }; },
    advanceMacWidgetProducerAndSourceEpoch() {},
    clearLatestHubStatsCache() {},
    edgeDockManualStats: null,
    stopIcloudRuntime() { calls.push('stop-icloud'); return Promise.resolve(); },
    stopLocalCollector() { calls.push('stop-local'); },
    stopStatsStream() { calls.push('stop-stream'); },
    stopHostStats() { calls.push('stop-host-stats'); },
    stopSyncCollector() { calls.push('stop-sync'); },
    syncStatsPublication: { cancel() {} },
    stopEmbeddedHub() { return Promise.resolve(); },
    effectiveHubConfig() { return { url: settings.hubUrl ?? 'http://host-a.test' }; },
    startStatsStream() { calls.push('stream'); },
    startSyncCollector() { calls.push('sync-collector'); },
    reconcileSharedSubscriptions() { calls.push('subscriptions'); },
    startLocalCollector() { calls.push('local-collector'); },
    startIcloudCollector() { calls.push('icloud-collector'); return Promise.resolve(); },
    startEmbeddedHub() { return Promise.resolve({}); },
    startHostStats() { calls.push('host-stats'); },
    startHostCollector() { calls.push('host-collector'); },
    console: { log() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('function startMode()', '\n// Reconciled on every mode change'), sandbox);
  sandbox.startMode();
  return sandbox.modeQueue.then(() => calls);
}

function runRestart(settings) {
  const calls = [];
  const sandbox = {
    settings,
    mode: 'sync',
    embeddedHub: null,
    clientCollectsLocally,
    effectiveHubConfig() { return { url: settings.hubUrl ?? 'http://host-a.test' }; },
    startLocalCollector() { calls.push('local-collector'); },
    startSyncCollector() { calls.push('sync-collector'); },
    startHostCollector() { calls.push('host-collector'); },
    startIcloudCollector() { calls.push('icloud-collector'); return Promise.resolve(); },
    recordDiagnosticEvent() {},
    console: { log() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('function restartDeviceRuntimeForMode()', '\nfunction usageCollectorNameForMode()'), sandbox);
  sandbox.restartDeviceRuntimeForMode();
  return calls;
}

async function runViewerOnlyManualRefresh() {
  const calls = [];
  const settings = { hubMode: 'client', viewerOnly: true, hubUrl: '' };
  const sandbox = {
    settings,
    mode: 'sync',
    deviceRuntimeHandle: {},
    hubModeGeneration: 1,
    clientCollectsLocally,
    isExternalAgentActive() { return false; },
    canRefreshUsageRuntime() { return true; },
    effectiveHubConfig() { return { url: settings.hubUrl, secret: '' }; },
    currentHubStatsIdentity() { return 'none'; },
    runManualDeviceRefresh() { calls.push('manual-device-refresh'); },
    withHistoryPreview(stats) { return stats; },
    aggregateDevices() { return { empty: true }; },
    fetch() { throw new Error('unexpected network request'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunction('function ownsUsageRuntime()', '\nasync function deleteDeviceFromHub(')}
${extractFunction('async function fetchStats(options = {})', '\nfunction managedPricingSidecarPath()')}`,
    sandbox
  );
  await sandbox.fetchStats({ force: true, forceHistory: true, forceSelfSync: true });
  return calls;
}

function tempDataFile(store) {
  const file = path.join(os.tmpdir(), `tm-viewer-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  if (store) fs.writeFileSync(file, JSON.stringify(store));
  return file;
}

function deviceRecord(deviceId, tokens) {
  return {
    deviceId,
    receivedAt: new Date().toISOString(),
    today: { totalTokens: tokens, costUsd: 0 },
    history: { daily: [{ date: '2026-10-01', tokens }], monthly: [], summary: { totalTokens: tokens } }
  };
}

const quiet = { error() {}, warn() {} };

test('viewer-only client is opt-in and structurally restarts when changed', () => {
  assert.equal(clientCollectsLocally({ hubMode: 'client' }), true);
  assert.equal(clientCollectsLocally({ hubMode: 'client', viewerOnly: false }), true);
  assert.equal(clientCollectsLocally({ hubMode: 'client', viewerOnly: true }), false);
  assert.equal(clientCollectsLocally({ hubMode: 'host', viewerOnly: true }), true);
  assert.equal(classifySettingsChange({ viewerOnly: false }, { viewerOnly: true }).modeStructural, true);
  assert.equal(classifySettingsChange({ hubSourceDeviceId: '' }, { hubSourceDeviceId: 'host-a' }).modeStructural, true);
});

test('viewer-only client keeps remote reads but does not create local usage, limits, upload, or overlay work', () => {
  const viewer = runSyncCollector({ hubMode: 'client', viewerOnly: true });
  assert.deepEqual(viewer.calls, ['stop']);
  assert.equal(viewer.lastCollectedDevice, null);
  assert.equal(viewer.deviceRuntimeHandle, null);

  const defaultClient = runSyncCollector({ hubMode: 'client', viewerOnly: false });
  assert.deepEqual(defaultClient.calls, ['stop', 'scheduler', 'usage-config', 'limits-config', 'runtime']);
  assert.ok(defaultClient.deviceRuntimeHandle);
});

test('viewer-only client keeps the remote stats stream while collection stays opt-in', async () => {
  const calls = await runMode({ hubMode: 'client', viewerOnly: true });
  assert.ok(calls.includes('stream'));
  assert.ok(calls.includes('sync-collector'));
  assert.ok(!calls.includes('local-collector'));
});

test('viewer-only client with an empty Hub URL does not fall back to a local collector', async () => {
  const calls = await runMode({ hubMode: 'client', viewerOnly: true, hubUrl: '' });
  assert.ok(!calls.includes('local-collector'));
  assert.ok(!calls.includes('sync-collector'));
});

test('viewer-only client restart with an empty Hub URL does not fall back to a local collector', () => {
  assert.deepEqual(runRestart({ hubMode: 'client', viewerOnly: true, hubUrl: '' }), []);
  assert.deepEqual(runRestart({ hubMode: 'client', viewerOnly: false, hubUrl: '' }), ['local-collector']);
});

test('viewer-only client manual refresh with an empty Hub URL does not refresh a local runtime', async () => {
  assert.deepEqual(await runViewerOnlyManualRefresh(), []);
});

test('single-source embedded host hides stored foreign records without deleting them', () => {
  const dataFile = tempDataFile({
    version: 1,
    devices: { 'host-a': deviceRecord('host-a', 5), 'client-b': deviceRecord('client-b', 1000) }
  });
  try {
    const hub = createHub({ port: 0, secret: 'shared-secret', sourceDeviceId: 'host-a', dataFile, logger: quiet });
    assert.deepEqual(hub.getStats().devices.map((device) => device.deviceId), ['host-a']);
    assert.equal(hub.getStats().periods.today.totalTokens, 5);
    assert.deepEqual(hub.getDevices().map((device) => device.deviceId), ['host-a']);
    assert.equal(hub.getHistory().daily.find((day) => day.date === '2026-10-01')?.tokens, 5);
    assert.ok(JSON.parse(fs.readFileSync(dataFile, 'utf8')).devices['client-b']);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('single-source health reports only visible devices while stats remain authenticated', async () => {
  const dataFile = tempDataFile({
    version: 1,
    devices: { 'host-a': deviceRecord('host-a', 5), 'client-b': deviceRecord('client-b', 1000) }
  });
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shared-secret', sourceDeviceId: 'host-a', dataFile, logger: quiet });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).deviceCount, 1);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(unauthorized.status, 401);
    const stats = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      headers: { authorization: 'Bearer shared-secret' }
    });
    assert.equal(stats.status, 200);
    assert.deepEqual((await stats.json()).devices.map((device) => device.deviceId), ['host-a']);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('single-source host rejects authenticated HTTP writers but retains in-process host ingest', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shared-secret', sourceDeviceId: 'host-a', dataFile, logger: quiet });
  hub.ingest(deviceRecord('host-a', 25));
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer shared-secret' },
      body: JSON.stringify(deviceRecord('host-a', 0))
    });
    assert.equal(response.status, 403);
    assert.equal(hub.getStats().periods.today.totalTokens, 25);
    hub.ingest(deviceRecord('host-a', 30));
    assert.equal(hub.getStats().periods.today.totalTokens, 30);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('single-source host rejects remote device deletion without removing stored records', async () => {
  const dataFile = tempDataFile({
    version: 1,
    devices: { 'host-a': deviceRecord('host-a', 25), 'client-b': deviceRecord('client-b', 7) }
  });
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shared-secret', sourceDeviceId: 'host-a', dataFile, logger: quiet });
  await hub.start();
  try {
    const { port } = hub.server.address();
    for (const id of ['host-a', 'client-b']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/devices/${id}`, {
        method: 'DELETE', headers: { authorization: 'Bearer shared-secret' }
      });
      assert.equal(response.status, 403);
    }
    assert.equal(hub.getStats().periods.today.totalTokens, 25);
    const stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.ok(stored.devices['host-a']);
    assert.ok(stored.devices['client-b']);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('default hub still accepts network producers', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shared-secret', dataFile, logger: quiet });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer shared-secret' },
      body: JSON.stringify(deviceRecord('client-b', 7))
    });
    assert.equal(response.status, 200);
    assert.equal(hub.getStats().periods.today.totalTokens, 7);
    const removed = await fetch(`http://127.0.0.1:${port}/api/devices/client-b`, {
      method: 'DELETE', headers: { authorization: 'Bearer shared-secret' }
    });
    assert.equal(removed.status, 200);
    assert.equal(hub.getDevices().length, 0);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});
