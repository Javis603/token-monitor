'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { sameDestination } = require('../../src/electron/syncContentRuntime');

function harness() {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf('async function postToHub(summary) {');
  const end = source.indexOf('\nlet syncContentRuntime = null;', start);
  assert.ok(start >= 0 && end > start);
  let context = { mode: 'client', url: 'https://first.example', secret: 'first', deviceId: 'one' };
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const posts = [];
  let captured = null;
  let opaqueIdentity = 'first-id';
  const status = () => {
    if (captured && !sameDestination(captured, context)) opaqueIdentity = 'second-id';
    captured = { ...context };
    return { identity: opaqueIdentity };
  };
  const sandbox = vm.createContext({
    settings: {}, console, AbortSignal, sameDestination,
    effectiveHubConfig: () => context, syncContentContext: () => context,
    getSyncContentRuntime: () => ({ prepareUpload: () => held, status }),
    postSyncPayload: async (_fetch, url, options) => {
      posts.push({ url, options });
      return { response: { ok: true, json: async () => ({ ok: true }) } };
    },
    fetch: async () => {}, saveSettings: () => {},
    HUB_RESPONSE_HEADER: 'x-token-monitor-response', HUB_RESPONSE_MINIMAL: 'minimal'
  });
  vm.runInContext(source.slice(start, end), sandbox);
  return {
    posts, context: () => context,
    setContext: next => { context = next; },
    release: (aborted = false) => release({ identity: status().identity,
      syncSessionTitles: true, sessionTitleSyncGeneration: 1, signal: { aborted } }),
    post: () => sandbox.postToHub({ deviceId: 'one' })
  };
}

test('an upload waiting for consent cannot send to the previously captured destination', async () => {
  const fixture = harness();
  const upload = fixture.post();
  fixture.setContext({ ...fixture.context(), url: 'https://second.example', secret: 'second' });
  fixture.release();
  await assert.rejects(upload, /hub_changed/);
  assert.equal(fixture.posts.length, 0);
});

test('revocation while an upload waits stops serialization even at the same destination', async () => {
  const fixture = harness();
  const upload = fixture.post();
  fixture.release(true);
  await assert.rejects(upload, /hub_changed/);
  assert.equal(fixture.posts.length, 0);
});

test('a consented upload at the unchanged destination keeps the negotiated generation', async () => {
  const fixture = harness();
  const upload = fixture.post();
  fixture.release();
  await upload;
  assert.equal(fixture.posts[0].url, 'https://first.example/api/ingest');
  assert.equal(fixture.posts[0].options.sessionTitleSyncGeneration, 1);
});

test('the actual settings IPC handler rejects a destination change while publication waits', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('settings:update', async (_event, patch) => {");
  const end = source.indexOf('  // The settings:update body', start);
  assert.ok(start >= 0 && end > start);
  let handler;
  let context = { mode: 'client', url: 'https://first.example', secret: 'one', deviceId: 'one' };
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let applied = false;
  const sandbox = vm.createContext({ syncContentContext: () => context,
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    getSyncContentRuntime: () => ({ publishPatch: () => held, status: () => ({ identity: context.url }) }),
    applySettingsPatch: () => { applied = true; }, latestUsageHost: null });
  vm.runInContext(source.slice(start, end), sandbox);
  const edit = handler(null, { customModelPricing: [] });
  context = { ...context, url: 'https://second.example' };
  release();
  await assert.rejects(edit, /hub_changed/);
  assert.equal(applied, false);
});

test('the main-process persistence adapter rolls back failed sync state writes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf('function getSyncContentRuntime() {');
  const end = source.indexOf('\n// ---------------------------------------------------------------------------', start);
  assert.ok(start >= 0 && end > start);
  const original = { syncContentState: { enabled: { sessionTitles: false }, pendingTitleCleanup: ['old'] } };
  let dependencies;
  let failure = true;
  const sandbox = vm.createContext({
    settings: original, syncContentRuntime: null, applySyncSettingsPatch: null, mainWindow: null,
    syncContentContext: () => ({}), normalizeSharedSyncValue: value => value,
    ensureCredentialStore: () => {},
    createSyncContentCredentialQueue: () => ({ read: () => [], save: () => {}, remove: () => {} }),
    createSyncContentRuntime: value => { dependencies = value; return {}; },
    settingsPath: '/unused/settings.json', persistedSettingsSnapshot: original,
    stripCredentialSettings: value => value, cloneSettingsSnapshot: value => structuredClone(value),
    writePrivateJsonAtomic: () => { if (failure) throw new Error('disk full'); }
  });
  vm.runInContext(source.slice(start, end), sandbox);
  sandbox.getSyncContentRuntime();
  const next = { enabled: { sessionTitles: false }, pendingTitleCleanup: [] };
  assert.throws(() => dependencies.saveState(next), /disk full/);
  assert.equal(sandbox.settings, original, 'failed completion must retain the retry row');
  failure = false;
  dependencies.saveState(next);
  assert.equal(sandbox.settings.syncContentState, next);
});


test('actual main destination commit journals old context and OFF before saving replacement credentials', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf('    const nextSettingsState = settings;');
  const end = source.indexOf('    const receiverPermissionChanged =', start);
  assert.ok(start >= 0 && end > start, 'ordered destination commit extraction');
  for (const fault of ['journal', 'commit', null]) {
    const previous = { hubUrl: 'https://old.example', secret: 'old', syncContentState: { enabled: { sessionTitles: true } } };
    const next = { hubUrl: 'https://new.example', secret: 'new', syncContentState: previous.syncContentState };
    const events = [];
    const sandbox = vm.createContext({ settings: next, previousSettingsState: previous,
      persistedSettingsSnapshot: previous, normalizeSyncContentState: value => structuredClone(value),
      syncContentContext: value => value,
      contentRuntime: {
        beforeDestinationChange: replacement => {
          assert.equal(sandbox.settings.secret, 'old', 'preflight still sees old credentials');
          assert.equal(replacement.secret, 'new');
          events.push('journal');
          if (fault === 'journal') throw new Error('journal failed');
          sandbox.settings = { ...previous, syncContentState: { enabled: { sessionTitles: false }, pendingTitleCleanup: ['old'] } };
          sandbox.persistedSettingsSnapshot = structuredClone(sandbox.settings);
        },
        invalidate: () => events.push('invalidate')
      }, saveSettings: () => {
        events.push('commit');
        assert.equal(sandbox.settings.secret, 'new');
        assert.equal(sandbox.settings.syncContentState.enabled.sessionTitles, false);
        if (fault === 'commit') throw new Error('commit failed');
      }
    });
    if (fault) assert.throws(() => vm.runInContext(source.slice(start, end), sandbox), /failed/);
    else vm.runInContext(source.slice(start, end), sandbox);
    assert.deepEqual(events, fault === 'journal' ? ['journal'] : fault === 'commit' ? ['journal', 'commit'] : ['journal', 'commit', 'invalidate']);
    if (fault === 'commit') {
      assert.equal(sandbox.settings.secret, 'old');
      assert.equal(sandbox.settings.syncContentState.enabled.sessionTitles, false, 'rollback retains durable OFF');
      assert.deepEqual(Array.from(sandbox.settings.syncContentState.pendingTitleCleanup), ['old']);
    }
  }
});

test('embedded Host cleanup targets the shared local store after port/secret rotation without admitting old contexts', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf('function getSyncContentRuntime() {');
  const end = source.indexOf('\n// ---------------------------------------------------------------------------', start);
  assert.ok(start >= 0 && end > start);
  let dependencies;
  const calls = [];
  const sandbox = vm.createContext({ syncContentRuntime: null, ensureCredentialStore: () => {},
    createSyncContentCredentialQueue: () => ({}),
    createSyncContentRuntime: value => { dependencies = value; return {}; },
    syncContentContext: () => ({}), normalizeSharedSyncValue: () => {},
    embeddedHub: { port: 20000, secret: 'new-private', hub: {
      setSyncTitlePolicy: (device, enabled) => { calls.push([device, enabled]); return { enabled, generation: 2 }; }
    } },
    fetch: async () => ({ status: 401, json: async () => ({}) }), AbortSignal
  });
  vm.runInContext(source.slice(start, end), sandbox);
  sandbox.getSyncContentRuntime();
  const old = { mode: 'host', url: 'http://127.0.0.1:17321', secret: 'old-private', deviceId: 'old-device' };
  assert.equal((await dependencies.request(old, '/api/sync/titles/old-device', 'PUT', { enabled: false })).status, 200);
  assert.deepEqual(calls, [['old-device', false]]);
  assert.equal((await dependencies.request(old, '/api/sync/titles/old-device', 'PUT', { enabled: true })).status, 401);
  assert.equal((await dependencies.request(old, '/api/sync/content', 'GET')).status, 401);
  assert.deepEqual(calls, [['old-device', false]], 'old context gets only the local scrub exception');
});

test('actual secret regeneration IPC uses the same journaled settings path', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('hub:regenerateSecret', () => {");
  const end = source.indexOf("  ipcMain.handle('appearance:getNativeMaterial'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  let patch;
  const sandbox = vm.createContext({ ipcMain: { handle: (_name, callback) => { handler = callback; } },
    generateHubSecret: () => 'new-private', applySettingsPatch: value => { patch = value; }, getHubInfo: () => 'info' });
  vm.runInContext(source.slice(start, end), sandbox);
  assert.equal(handler(), 'info');
  assert.equal(patch.hubHostSecret, 'new-private');
});

for (const failure of ['cleanup', 'preferences', 'bind']) test(`host ${failure} startup failure surfaces an error and keeps local collection running`, async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const extract = (startText, endText) => {
    const start = source.indexOf(startText);
    const end = source.indexOf(endText, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  const events = [];
  let failing = true;
  const originalState = { identity: 'old', enabled: { sessionTitles: true }, pendingTitleCleanup: [] };
  const sandbox = vm.createContext({
    settings: { hubMode: 'host', hubHostPort: 17321, hubHostSecret: '', syncContentState: originalState },
    embeddedHub: null, embeddedHubError: null, modeQueue: Promise.resolve(), hubModeGeneration: 0,
    console: { log: () => {} }, normalizeHubPort: value => value,
    normalizeSyncContentState: value => structuredClone(value), generateHubSecret: () => 'generated-secret',
    syncContentContext: value => value,
    getSyncContentRuntime: () => ({
      invalidate: () => {}, refresh: async () => {},
      beforeDestinationChange: () => {
        sandbox.settings = { ...sandbox.settings, syncContentState: {
          ...originalState, enabled: { sessionTitles: false }, pendingTitleCleanup: [{ identity: 'old', deviceId: 'one' }]
        } };
        if (failing && failure === 'cleanup') throw Object.assign(new Error('cleanup_pending'), { code: 'cleanup_pending' });
      }
    }),
    saveSettings: () => {
      events.push('save');
      if (failing && failure === 'preferences') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    },
    hubDataFile: () => '/unused',
    createHub: () => { events.push('create'); return {
      start: async () => { if (failing && failure === 'bind') throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }); }, stop: async () => {}
    }; },
    getHubInfo: () => ({ error: sandbox.embeddedHubError, listening: Boolean(sandbox.embeddedHub), secret: sandbox.settings.hubHostSecret }),
    sendHubPush: payload => events.push(payload),
    advanceMacWidgetProducerAndSourceEpoch: () => {}, clearLatestHubStatsCache: () => {},
    stopIcloudRuntime: async () => {}, stopLocalCollector: () => events.push('stopLocal'),
    stopStatsStream: () => {}, stopHostStats: () => {}, stopSyncCollector: () => {},
    syncStatsPublication: { cancel: () => {} },
    startLocalCollector: () => events.push('local'), startHostStats: () => events.push('hostStats'),
    startHostCollector: () => events.push('hostCollector'), reconcileSharedSubscriptions: () => {}
  });
  vm.runInContext(extract('async function startEmbeddedHub() {', '\nfunction isExternalAgentActive()')
    + extract('function startMode() {', '\n// Reconciled on every mode change'), sandbox);
  sandbox.startMode();
  await sandbox.modeQueue;
  assert.ok(events.includes('local'), 'failed Hub must reach the real mode reconciliation fallback');
  assert.equal(sandbox.embeddedHub, null);
  assert.equal(sandbox.embeddedHubError.code, { cleanup: 'cleanup_pending', preferences: 'ENOSPC', bind: 'EADDRINUSE' }[failure]);
  const notification = events.find(event => event?.type === 'error');
  assert.ok(notification, 'renderer receives the startup error');
  assert.equal(notification.info.listening, false);
  assert.equal(sandbox.settings.syncContentState.enabled.sessionTitles, false, 'keep preflight OFF state');
  assert.equal(sandbox.settings.syncContentState.pendingTitleCleanup.length, 1, 'keep cleanup obligation');
  if (failure !== 'bind') {
    assert.equal(sandbox.settings.hubHostSecret, '', 'unsaved generated secret cannot remain active');
    assert.ok(!events.includes('create'), 'do not create a Hub before durable secret save');
  }
  failing = false;
  sandbox.startMode();
  await sandbox.modeQueue;
  assert.ok(sandbox.embeddedHub);
  assert.equal(sandbox.embeddedHubError, null);
  assert.ok(events.includes('hostCollector'));
});
