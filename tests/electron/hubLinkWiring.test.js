'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  discoveryStatusPayload,
  hubIdentityView,
  linksView,
  normalizeHubLink,
  pairingStatusView,
  pairingView,
  resolveClientHubUrl
} = require('../../src/electron/lanLink');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const mainSource = read('src/electron/main.js');
const preloadSource = read('src/electron/preload.js');
const appSource = read('src/electron/renderer/app.js');
const htmlSource = read('src/electron/renderer/index.html');

const HUB_ID = '0123456789abcdef';
const HOST_SECRET = 'host-shared-secret';
const CLIENT_SECRET = 'client-shared-secret';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : source.length;
  assert.ok(!nextName || end > start, `${nextName} should follow ${name}`);
  return source.slice(start, end);
}

function lanLinkSandbox(overrides = {}) {
  const calls = [];
  const httpClient = {
    startPairing: async () => ({ ok: true, pairing: null, hub: null }),
    pairingStatus: async () => ({ ok: true, pairing: { active: false } }),
    cancelPairing: async () => ({ ok: true }),
    listLinks: async () => ({ ok: true, links: [] }),
    revokeLink: async (id) => ({ ok: true, id }),
    getLink: async () => ({ ok: false, error: 'not_supported', status: 404 }),
    ...(overrides.httpClient || {})
  };
  const sandbox = {
    settings: {},
    embeddedHub: null,
    lanLinkRuntime: null,
    clientHubHttpClient: null,
    hubLinkLearnPromise: null,
    streamConnected: false,
    sseRetryTimer: null,
    console: { log() {}, warn() {} },
    normalizeHubLink,
    hubIdentityView,
    linksView,
    pairingView,
    pairingStatusView,
    discoveryStatusPayload,
    resolveClientHubUrl,
    sendHubPush: (payload) => calls.push({ push: payload }),
    getHubInfo: () => ({ port: 17321, listeningPort: 17321, lanAddresses: [{ address: '192.168.1.5' }] }),
    effectiveHubConfig: () => ({ url: 'http://127.0.0.1:17321', secret: HOST_SECRET }),
    createHubHttpClient: () => { calls.push({ createHttp: true }); return httpClient; },
    createLanLinkRuntime: () => ({ isRunning: () => false, hubs: () => [], start() {}, recompute() { calls.push({ recompute: true }); } }),
    createLanBrowser: () => null,
    saveSettings: () => { calls.push({ save: true }); },
    pushSettingsToRenderer: () => calls.push({ settingsPush: true }),
    getHubBuildStatus: async () => ({ status: 'current', runtime: 'node-hub', hubUrl: 'http://127.0.0.1:17321' }),
    startStatsStream: () => calls.push({ streamStart: true }),
    stopStatsStream: () => calls.push({ streamStop: true }),
    ...overrides
  };
  const source = mainSource.slice(
    mainSource.indexOf('function currentLanLinkHubs() {'),
    mainSource.indexOf('function getHubDiscoveryStatus() {')
  );
  vm.runInNewContext(`${source}
    globalThis.startHubPairing = startHubPairing;
    globalThis.getHubPairingStatus = getHubPairingStatus;
    globalThis.cancelHubPairing = cancelHubPairing;
    globalThis.revokeHubLink = revokeHubLink;
    globalThis.persistHubLink = persistHubLink;
    globalThis.learnHubLinkIdentity = learnHubLinkIdentity;
    globalThis.handleResolvedHubUrlChange = handleResolvedHubUrlChange;
    globalThis.retryOfflineStatsStream = retryOfflineStatsStream;
  `, sandbox);
  return { sandbox, calls, httpClient };
}

test('client mode uses the runtime-confirmed address, falling back to the saved URL', () => {
  const effective = functionSource(mainSource, 'effectiveHubConfig', 'hubDataFile');
  const sandbox = {
    settings: {},
    lanLinkRuntime: null,
    normalizeHubPort: (value) => {
      const port = Number(value);
      return Number.isInteger(port) && port > 0 ? port : 17321;
    },
    resolveClientHubUrl
  };
  vm.runInNewContext(`${effective}; globalThis.effectiveHubConfig = effectiveHubConfig;`, sandbox);
  // The runtime advances this only on a discovery event, never mid-stream.
  sandbox.lanLinkRuntime = { resolvedUrl: () => 'http://192.168.1.5:17321' };
  sandbox.settings = { hubMode: 'client', hubUrl: 'http://saved.local:17321', secret: CLIENT_SECRET, hubLink: { id: HUB_ID, name: 'Studio Mac' } };
  assert.deepEqual(plain(sandbox.effectiveHubConfig()), { url: 'http://192.168.1.5:17321', secret: CLIENT_SECRET });

  // No confirmation yet (binding just learned, hub not re-reported): saved URL.
  sandbox.lanLinkRuntime = { resolvedUrl: () => null };
  sandbox.settings = { hubMode: 'client', hubUrl: 'http://saved.local:17321', secret: CLIENT_SECRET, hubLink: { id: HUB_ID, name: 'Studio Mac' } };
  assert.deepEqual(plain(sandbox.effectiveHubConfig()), { url: 'http://saved.local:17321', secret: CLIENT_SECRET });

  // Bound hub expired off the network -> runtime resolves back to the saved URL.
  sandbox.lanLinkRuntime = { resolvedUrl: () => 'http://saved.local:17321' };
  assert.deepEqual(plain(sandbox.effectiveHubConfig()), { url: 'http://saved.local:17321', secret: CLIENT_SECRET });

  // No discovery runtime at all (module unavailable / not started): saved URL.
  sandbox.lanLinkRuntime = null;
  assert.deepEqual(plain(sandbox.effectiveHubConfig()), { url: 'http://saved.local:17321', secret: CLIENT_SECRET });

  // Host and local modes keep their existing contracts.
  sandbox.settings = { hubMode: 'host', hubHostPort: 18000, hubHostSecret: HOST_SECRET };
  assert.deepEqual(plain(sandbox.effectiveHubConfig()), { url: 'http://127.0.0.1:18000', secret: HOST_SECRET });
  sandbox.settings = { hubMode: 'local' };
  assert.deepEqual(plain(sandbox.effectiveHubConfig()), { url: null, secret: '' });
});

test('host mode pairing uses the embedded hub methods and returns display data only', async () => {
  const identity = { id: HUB_ID, name: 'Studio Mac', port: 17321, addresses: ['192.168.1.5'] };
  const pairing = {
    code: '123456',
    expiresAt: '2026-11-06T05:05:00.000Z',
    ttlMs: 300000,
    link: 'tokenmonitor://pair?v=1&id=0123456789abcdef&code=123456',
    hub: identity
  };
  const { sandbox } = lanLinkSandbox();
  sandbox.settings = { hubMode: 'host', hubHostSecret: HOST_SECRET };
  sandbox.embeddedHub = {
    port: 17321,
    hub: {
      getHubIdentity: () => identity,
      startPairing: () => pairing,
      pairingStatus: () => ({ active: false }),
      getLinks: () => [{ id: 'android-1', name: 'Pixel 9', platform: 'android', createdAt: '2026-11-06T04:00:00.000Z', lastSeenAt: null }],
      revokeLink: (id) => id === 'android-1',
      cancelPairing: () => true
    }
  };
  const started = await sandbox.startHubPairing();
  assert.equal(started.ok, true);
  assert.deepEqual(plain(started.pairing), {
    code: '123456',
    expiresAt: '2026-11-06T05:05:00.000Z',
    ttlMs: 300000,
    link: 'tokenmonitor://pair?v=1&id=0123456789abcdef&code=123456'
  });
  assert.deepEqual(plain(started.hub), identity);
  assert.deepEqual(plain(started.links), [{
    id: 'android-1',
    name: 'Pixel 9',
    platform: 'android',
    createdAt: '2026-11-06T04:00:00.000Z',
    lastSeenAt: null
  }]);
  assert.equal(JSON.stringify(started).includes(HOST_SECRET), false);

  assert.deepEqual(plain(await sandbox.getHubPairingStatus()), {
    ok: true,
    pairing: { active: false },
    links: [{
      id: 'android-1',
      name: 'Pixel 9',
      platform: 'android',
      createdAt: '2026-11-06T04:00:00.000Z',
      lastSeenAt: null
    }],
    hub: identity
  });
  assert.deepEqual(plain(await sandbox.revokeHubLink('android-1')), { ok: true, id: 'android-1' });
  assert.deepEqual(plain(await sandbox.revokeHubLink('android-2')), { ok: false, error: 'unknown_link', id: 'android-2' });
  assert.deepEqual(plain(await sandbox.cancelHubPairing()), { ok: true, cancelled: true });
  assert.deepEqual(plain(await sandbox.revokeHubLink('')), { ok: false, error: 'invalid_device_id' });
});

test('host pairing degrades to not_ready and to the loopback HTTP fallback', async () => {
  const { sandbox, calls } = lanLinkSandbox();
  sandbox.settings = { hubMode: 'host', hubHostSecret: HOST_SECRET };
  sandbox.embeddedHub = null;
  assert.deepEqual(plain(await sandbox.startHubPairing()), { ok: false, error: 'not_ready' });
  assert.deepEqual(plain(await sandbox.cancelHubPairing()), { ok: false, error: 'not_ready' });
  assert.deepEqual(plain(await sandbox.revokeHubLink('android-1')), { ok: false, error: 'not_ready' });

  // An older embedded hub object without the pairing methods still answers the
  // HTTP endpoints, so the same flow falls back instead of reporting not_supported.
  sandbox.embeddedHub = { port: 17321, hub: { getHubIdentity: () => ({ id: HUB_ID, name: 'Studio Mac', port: 17321, addresses: [] }) } };
  calls.length = 0;
  const result = await sandbox.startHubPairing();
  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => call.createHttp), true);
});

test('client mode pairing uses authenticated HTTP and never surfaces credentials', async () => {
  const calls = [];
  const { sandbox } = lanLinkSandbox({
    httpClient: {
      startPairing: async () => ({ ok: true, pairing: { code: '654321', expiresAt: null, ttlMs: null, link: null }, hub: { id: HUB_ID, name: 'Studio Mac', port: 17321, addresses: ['192.168.1.5'] } }),
      pairingStatus: async () => ({ ok: true, pairing: { active: true, code: '654321', expiresAt: null, ttlMs: null, link: null } }),
      listLinks: async () => ({ ok: true, links: [{ id: 'android-1', name: 'Pixel 9', platform: 'android', createdAt: null, lastSeenAt: null }] }),
      getLink: async () => ({ ok: true, hub: { id: HUB_ID, name: 'Studio Mac', port: 17321, addresses: ['192.168.1.5'] }, role: 'admin', link: null }),
      cancelPairing: async () => ({ ok: true }),
      revokeLink: async (id) => ({ ok: true, id })
    }
  });
  sandbox.settings = { hubMode: 'client', hubUrl: 'https://hub.example', secret: CLIENT_SECRET };
  const started = await sandbox.startHubPairing();
  assert.equal(started.ok, true);
  assert.equal(started.pairing.code, '654321');
  const status = await sandbox.getHubPairingStatus();
  assert.deepEqual(plain(status), {
    ok: true,
    pairing: { active: true, code: '654321', expiresAt: null, ttlMs: null, link: null },
    links: [{ id: 'android-1', name: 'Pixel 9', platform: 'android', createdAt: null, lastSeenAt: null }],
    hub: { id: HUB_ID, name: 'Studio Mac', port: 17321, addresses: ['192.168.1.5'] }
  });
  assert.equal(JSON.stringify(started).includes(CLIENT_SECRET), false);
  assert.equal(JSON.stringify(status).includes(CLIENT_SECRET), false);
  assert.deepEqual(await sandbox.cancelHubPairing(), { ok: true });
  assert.deepEqual(await sandbox.revokeHubLink('android-1'), { ok: true, id: 'android-1' });
  calls.push('checked');
});

test('an old hub without pairing endpoints reports not_supported', async () => {
  const { sandbox } = lanLinkSandbox({
    httpClient: {
      pairingStatus: async () => ({ ok: false, error: 'not_supported', status: 404 }),
      listLinks: async () => ({ ok: false, error: 'not_supported', status: 404 }),
      getLink: async () => ({ ok: false, error: 'not_supported', status: 404 })
    }
  });
  sandbox.settings = { hubMode: 'client', hubUrl: 'https://worker.example', secret: CLIENT_SECRET };
  const status = await sandbox.getHubPairingStatus();
  assert.deepEqual(plain(status), { ok: false, error: 'not_supported', pairing: { active: false }, links: [], hub: null });
  // The connection itself is never failed just because pairing is unavailable.
  assert.equal(mainSource.match(/void learnHubLinkIdentity\(\);/g).length, 2);
});

test('hubLink persistence is main-owned, deduplicated and never restarts the stream directly', async () => {
  const { sandbox, calls } = lanLinkSandbox();
  sandbox.settings = { hubMode: 'client', hubUrl: 'http://saved.local:17321', secret: CLIENT_SECRET, hubLink: null };
  sandbox.lanLinkRuntime = {
    hubs: () => [],
    isAvailable: () => true,
    resolvedUrl: () => 'http://saved.local:17321',
    recompute: () => calls.push({ recompute: true })
  };
  assert.equal(sandbox.persistHubLink({ id: HUB_ID, name: 'Studio Mac' }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.settings.hubLink)), { id: HUB_ID, name: 'Studio Mac' });
  assert.equal(calls.filter((call) => call.save).length, 1);
  assert.equal(calls.some((call) => call.settingsPush), true);

  // Same identity: no second write.
  assert.equal(sandbox.persistHubLink({ id: HUB_ID, name: 'Studio Mac' }), false);
  assert.equal(calls.filter((call) => call.save).length, 1);
  // A renamed hub updates the display name.
  assert.equal(sandbox.persistHubLink({ id: HUB_ID, name: 'Renamed Mac' }), true);
  assert.equal(sandbox.settings.hubLink.name, 'Renamed Mac');

  // Learning from /api/link persists but never starts a stream by itself.
  sandbox.settings = { hubMode: 'client', hubUrl: 'http://saved.local:17321', secret: CLIENT_SECRET, hubLink: null };
  sandbox.clientHubHttpClient = { getLink: async () => ({ ok: true, hub: { id: HUB_ID, name: 'Studio Mac' } }) };
  assert.equal(await sandbox.learnHubLinkIdentity(), true);
  assert.equal(sandbox.settings.hubLink.id, HUB_ID);
  assert.equal(calls.some((call) => call.streamStart), false);
  assert.equal(calls.some((call) => call.recompute), false, 'learning must not move the address under the open stream');

  // 404 (old hub / Worker) leaves the binding untouched.
  sandbox.settings.hubLink = null;
  sandbox.clientHubHttpClient = { getLink: async () => ({ ok: false, error: 'not_supported' }) };
  assert.equal(await sandbox.learnHubLinkIdentity(), false);
  assert.equal(sandbox.settings.hubLink, null);
});

test('a resolved address change restarts the client stream and refreshes statuses', async () => {
  const { sandbox, calls } = lanLinkSandbox();
  sandbox.settings = { hubMode: 'client', hubUrl: 'http://saved.local:17321', secret: CLIENT_SECRET };
  sandbox.handleResolvedHubUrlChange();
  assert.equal(calls.some((call) => call.streamStart), true);
  assert.equal(calls.some((call) => call.push?.type === 'discovery'), true);
});

test('main wires discovery, learning and the binding into the settings lifecycle', () => {
  // Embedded hub advertises on the LAN per contract.
  assert.match(mainSource, /secret: settings\.hubHostSecret,\s*\n\s*discovery: true,/);
  // Additive, main-owned setting.
  assert.match(mainSource, /hubLink: null,/);
  assert.match(mainSource, /merged\.hubLink = normalizeHubLink\(merged\.hubLink\);/);
  // The renderer can never write the binding through a generic patch.
  assert.match(mainSource, /delete normalizedPatch\.hubLink;/);
  assert.match(mainSource, /hubLink: normalizeHubLink\(settings\.hubLink\),/);
  // Cleared before commit when the destination changes.
  const clear = mainSource.indexOf('if (hubLinkDestinationChanged(previousSettingsState, settings)) settings.hubLink = null;');
  assert.ok(clear > 0, 'destination-change clear exists');
  assert.ok(clear < mainSource.indexOf('const nextSettingsState = settings;'));
  // Discovery lifecycle follows mode transitions and quits.
  assert.match(mainSource, /startMode\(\);\s*\n\s*syncLanLinkRuntimeForMode\(\);/);
  assert.equal([...mainSource.matchAll(/startMode\(\);\n\s*syncLanLinkRuntimeForMode\(\);/g)].length, 2);
  assert.match(mainSource, /stopStatsStream\(\);\n\s*stopLanLinkRuntime\(\);/);
  // Learning happens on stream open and REST refresh, not on unrelated pushes.
  assert.equal([...mainSource.matchAll(/void learnHubLinkIdentity\(\);/g)].length, 2);
  assert.match(mainSource, /sendStatus\(true\);\n\s*\/\/ A successful connection is the trigger[\s\S]*?void learnHubLinkIdentity\(\);/);
  // Build status probes the address actually in use.
  assert.match(mainSource, /async function getHubBuildStatus\(\)[\s\S]*?const \{ url \} = effectiveHubConfig\(\);[\s\S]*?probeHubBuild\(url\)/);
});

test('the pairing and discovery IPC surface is explicit in preload and main', () => {
  for (const channel of [
    'hub:pairing:start',
    'hub:pairing:status',
    'hub:pairing:cancel',
    'hub:links:revoke',
    'hub:discovery:start',
    'hub:discovery:status'
  ]) {
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\('${channel.replace(/:/g, ':')}'`), channel);
    assert.match(preloadSource, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`), channel);
  }
  assert.match(preloadSource, /startHubPairing: \(\) => ipcRenderer\.invoke\('hub:pairing:start'\)/);
  assert.match(preloadSource, /getHubPairingStatus: \(\) => ipcRenderer\.invoke\('hub:pairing:status'\)/);
  assert.match(preloadSource, /cancelHubPairing: \(\) => ipcRenderer\.invoke\('hub:pairing:cancel'\)/);
  assert.match(preloadSource, /revokeHubLink: \(deviceId\) => ipcRenderer\.invoke\('hub:links:revoke', deviceId\)/);
  assert.match(preloadSource, /startHubDiscovery: \(\) => ipcRenderer\.invoke\('hub:discovery:start'\)/);
  assert.match(preloadSource, /getHubDiscoveryStatus: \(\) => ipcRenderer\.invoke\('hub:discovery:status'\)/);
  // No blanket invoke helper and no credential in a discovery payload.
  assert.doesNotMatch(preloadSource, /invoke\s*\(\s*(?:channel|name)\b/);
  assert.match(mainSource, /function hubDiscoveryStatus\(\)[\s\S]*?discoveryStatusPayload\(\{/);
  // Nothing logs a pairing code, link or device token.
  assert.doesNotMatch(mainSource, /console\.(?:log|warn|error)\([^;\n]*(?:pairing|pairingLink|token)/i);
});

test('the renderer renders pairing, linked devices and nearby hubs from main pushes', () => {
  for (const id of [
    'hubPairingSection', 'hubPairingStart', 'hubPairingCard', 'hubPairingCode',
    'hubPairingCountdown', 'hubPairingCopyLink', 'hubPairingCancel',
    'hubLinkedDevices', 'hubLinkedDeviceList', 'syncLinkedStatus',
    'syncDiscoverySection', 'syncDiscoveryList', 'syncDiscoveryRefresh'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`), id);
  }
  // The pairing card carries the code/link only, never a secret input.
  const card = htmlSource.slice(htmlSource.indexOf('id="hubPairingCard"'), htmlSource.indexOf('id="hubLinkedDevices"'));
  assert.match(card, /id="hubPairingCode"/);
  assert.doesNotMatch(card, /type="password"|secretInput|hubSecretInput/);
  // All new copy exists in every bundled locale.
  const i18n = require('../../src/electron/renderer/i18n');
  const keys = Object.keys(i18n.MESSAGES.en).filter((key) => key.startsWith('settings.sync.link.') || key.startsWith('settings.sync.discovery.'));
  assert.ok(keys.length >= 20);
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'pt-BR']) {
    for (const key of keys) assert.ok(i18n.MESSAGES[locale][key], `${locale}: ${key}`);
  }
  // The renderer consumes the pushed payloads and copies through clipboard:write.
  assert.match(appSource, /function applyHubDiscoveryPayload\(payload\)/);
  assert.match(appSource, /function applyHubBuildStatusPayload\(payload\)/);
  assert.match(appSource, /payload\?\.type === 'discovery'/);
  assert.match(appSource, /payload\?\.type === 'buildStatus'/);
  assert.match(appSource, /copyToClipboard\(pairing\.link, els\.hubPairingCopyLink\)/);
  assert.match(appSource, /t\('settings\.sync\.link\.linkedTo'/);
  assert.match(appSource, /function stopHubPairingPoll\(\)/);
  // Pairing countdown/polling is scoped to an active card.
  assert.match(appSource, /function ensureHubPairingPoll\(\)[\s\S]*?if \(!activeHubPairing\(\)\) \{\s*stopHubPairingPoll\(\);/);
  assert.match(appSource, /if \(!hubPairingTimer\) return;[\s\S]*?clearInterval\(hubPairingTimer\)/);
});
