'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { createSyncContentCredentialQueue } = require('../../src/electron/syncContentCredentials');

test('pending title cleanup stores old connection credentials only in the existing private store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-content-credentials-'));
  try {
    const store = new CredentialStore(dir);
    store.replaceSettingsCredentials({ secret: 'current-hub-secret' });
    const context = { mode: 'client', url: 'https://old.example', secret: 'old-hub-secret', deviceId: 'one' };
    const queue = createSyncContentCredentialQueue(() => store);
    context.identity = queue.resolveIdentity(context);
    queue.save(context);
    assert.equal(new CredentialStore(dir).settingsCredentials().secret, 'current-hub-secret');
    assert.deepEqual(new Map(createSyncContentCredentialQueue(() => new CredentialStore(dir)).read()).get(context.identity), context);
    assert.equal(Object.values(store.settingsCredentials()).includes('old-hub-secret'), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
    queue.resolveIdentity({ ...context, url: 'https://current.example', secret: 'current-hub-secret' });
    queue.remove(context.identity);
    assert.deepEqual(queue.read(), []);
    assert.doesNotMatch(fs.readFileSync(store.filePath, 'utf8'), /old-hub-secret/);
    assert.equal(store.settingsCredentials().secret, 'current-hub-secret');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an invalid cleanup identity cannot substitute another server context', () => {
  let document = { version: 1, credentials: { hub: { syncTitleCleanup: { forged: {
    mode: 'client', url: 'https://other.example', secret: 'secret', deviceId: 'one'
  } } } }, migrations: {} };
  const queue = createSyncContentCredentialQueue(() => ({ readDocument: () => structuredClone(document),
    writeDocument: next => { document = next; } }));
  assert.deepEqual(queue.read(), []);
});

test('random identity survives CredentialStore reload, compares private credentials and has no deterministic verifier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-content-identity-'));
  try {
    const context = { mode: 'client', url: 'https://hub.example/path?q=one', secret: 'weak-secret', deviceId: 'one' };
    const queue = () => createSyncContentCredentialQueue(() => new CredentialStore(dir));
    const first = queue().resolveIdentity(context);
    assert.match(first, /^[a-f0-9-]{36}$/);
    assert.equal(queue().resolveIdentity({ ...context }), first);
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-content-independent-'));
    try {
      const independent = createSyncContentCredentialQueue(() => new CredentialStore(otherDir));
      assert.notEqual(independent.resolveIdentity(context), first, 'same credential has independent random identities');
    } finally { fs.rmSync(otherDir, { recursive: true, force: true }); }
    for (const patch of [{ secret: 'different' }, { deviceId: 'two' }, { mode: 'host' }, { url: 'https://hub.example/path?q=two' }]) {
      const before = queue().resolveIdentity(context);
      assert.notEqual(queue().resolveIdentity({ ...context, ...patch }), before);
    }
    const document = new CredentialStore(dir).readDocument();
    assert.equal(Object.values(document.credentials.hub).some(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy cleanup journal migrates to random IDs privately and survives immediate restart', () => {
  let document = { version: 1, credentials: { hub: { syncTitleCleanup: { ['a'.repeat(64)]: {
    mode: 'client', url: 'https://old.example', secret: 'private', deviceId: 'one'
  } } } }, migrations: {} };
  const queue = () => createSyncContentCredentialQueue(() => ({ readDocument: () => structuredClone(document),
    writeDocument: next => { document = structuredClone(next); } }));
  const first = queue().read();
  assert.equal(first.length, 1);
  assert.match(first[0][0], /^[a-f0-9-]{36}$/);
  assert.equal(first[0][1].legacyIdentity, 'a'.repeat(64));
  assert.deepEqual(queue().read(), first);
  assert.equal(Object.hasOwn(document.credentials.hub.syncTitleCleanup, 'a'.repeat(64)), false);
});

for (const fault of ['journal', 'off', 'replacement-credentials', 'replacement-preferences', 'cleanup-completion']) {
  test(`actual CredentialStore + preferences survive ${fault} failure and immediate restart`, async () => {
    const { createSyncContentRuntime, normalizeSyncContentState } = require('../../src/electron/syncContentRuntime');
    const { persistSettingsAndCredentials, writePrivateJsonAtomic } = require('../../src/shared/credentialStore');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-content-cross-store-'));
    const settingsPath = path.join(dir, 'settings.json');
    const old = { hubMode: 'client', hubUrl: 'https://old.example', secret: 'old-private', deviceId: 'one' };
    let settings = { ...old, syncContentState: normalizeSyncContentState(null) };
    const store = new CredentialStore(dir);
    let phase = '';
    const remote = [];
    const writeDocument = store.writeDocument.bind(store);
    store.writeDocument = value => {
      if (phase === fault && ['journal', 'replacement-credentials'].includes(phase)) throw new Error('injected private write failure');
      return writeDocument(value);
    };
    const writeSettings = (file, value) => {
      if (phase === fault && ['off', 'replacement-preferences', 'cleanup-completion'].includes(phase)) throw new Error('injected preferences write failure');
      writePrivateJsonAtomic(file, value);
    };
    function save(next) {
      persistSettingsAndCredentials({ store, settingsPath, settings: next, previousSettings: settings, writeSettings });
      settings = next;
    }
    function context(source = settings) {
      return { mode: source.hubMode, url: source.hubUrl, secret: source.secret, deviceId: source.deviceId };
    }
    function boot() {
      const queue = createSyncContentCredentialQueue(() => store);
      return createSyncContentRuntime({ getContext: context, getState: () => settings.syncContentState,
        saveState: next => {
          const { stripCredentialSettings } = require('../../src/shared/credentialStore');
          const updated = { ...settings, syncContentState: next };
          writeSettings(settingsPath, stripCredentialSettings(updated));
          settings = updated;
        },
        resolveIdentity: queue.resolveIdentity, loadCleanupContexts: queue.read,
        saveCleanupContext: value => { const previous = phase; if (phase === 'off') phase = 'journal';
          try { queue.save(value); } finally { phase = previous; } }, removeCleanupContext: queue.remove,
        request: async (captured, route, _method, body) => {
          remote.push({ ...captured, route, body });
          return { status: 200, body: route === '/api/sync/content'
            ? { version: 1, sharedSettings: true, sessionTitles: { enabled: true } }
            : { enabled: body.enabled, generation: 1 } };
        }
      });
    }
    try {
      save(settings);
      let runtime = boot();
      assert.equal((await runtime.configure({ kind: 'sessionTitles', enabled: true,
        identity: runtime.status().identity, confirmed: true })).ok, true);
      const replacement = { ...settings, hubUrl: 'https://new.example', secret: 'new-private', deviceId: 'two' };
      phase = ['journal', 'off'].includes(fault) ? fault : '';
      if (phase) assert.throws(() => runtime.beforeDestinationChange(context(replacement)), { code: 'cleanup_pending' });
      else {
        runtime.beforeDestinationChange(context(replacement));
        replacement.syncContentState = settings.syncContentState;
        phase = fault.startsWith('replacement-') ? fault : '';
        if (phase) assert.throws(() => save(replacement), /injected/);
        else save(replacement);
      }
      // Abandon all volatile state immediately: reconstruct from real disk.
      phase = '';
      settings = { ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')), ...new CredentialStore(dir).settingsCredentials() };
      runtime = boot();
      assert.equal(runtime.status().enabled.sessionTitles, false);
      assert.equal(runtime.status().pendingTitleCleanup, true);
      assert.doesNotMatch(fs.readFileSync(settingsPath, 'utf8'), /old-private|new-private/);
      phase = fault === 'cleanup-completion' ? fault : '';
      const before = remote.length;
      const result = await runtime.retryCleanup();
      assert.equal(remote[before].url, old.hubUrl);
      assert.equal(remote[before].secret, old.secret);
      assert.equal(remote[before].deviceId, old.deviceId);
      if (phase) {
        assert.equal(result.ok, false);
        assert.equal(Object.keys(store.readDocument().credentials.hub.syncTitleCleanup).length, 1);
        phase = '';
        settings = { ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')), ...new CredentialStore(dir).settingsCredentials() };
        runtime = boot();
        assert.equal((await runtime.retryCleanup()).ok, true);
      } else assert.equal(result.ok, true);
      assert.equal(runtime.status().pendingTitleCleanup, false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

// Exercise the production private store and atomic preferences writer, not an
// in-memory snapshot. The Node Hub core persists the remote policy before the
// transport deliberately loses the response, exactly as a process crash does.
function admissionDiskFixture() {
  const { createSyncContentRuntime, normalizeSyncContentState } = require('../../src/electron/syncContentRuntime');
  const { persistSettingsAndCredentials, writePrivateJsonAtomic, stripCredentialSettings } = require('../../src/shared/credentialStore');
  const { createHub } = require('../../src/hub/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-title-admission-'));
  const settingsPath = path.join(dir, 'settings.json');
  const hub = createHub({ dataFile: path.join(dir, 'hub.json'), syncSessionTitles: true });
  let store = new CredentialStore(dir);
  let settings = { hubMode: 'client', hubUrl: 'https://old.example', secret: 'old-private',
    deviceId: 'one', syncContentState: normalizeSyncContentState(null) };
  persistSettingsAndCredentials({ store, settingsPath, settings });
  const requests = [];
  let checkpoint = () => {};
  let enableResponseHold = null;
  let removalFails = false;
  const context = source => ({ mode: source.hubMode, url: source.hubUrl, secret: source.secret, deviceId: source.deviceId });
  function boot() {
    const queue = createSyncContentCredentialQueue(() => store);
    return createSyncContentRuntime({
      getContext: () => context(settings), getState: () => settings.syncContentState,
      saveState: next => {
        const updated = { ...settings, syncContentState: next };
        writePrivateJsonAtomic(settingsPath, stripCredentialSettings(updated));
        settings = updated;
        checkpoint(next.enabled.sessionTitles ? 'consent' : 'off');
      },
      resolveIdentity: queue.resolveIdentity, loadCleanupContexts: queue.read,
      saveCleanupContext: value => { queue.save(value); checkpoint('journal'); },
      removeCleanupContext: id => {
        if (removalFails) throw new Error('private deletion failed');
        queue.remove(id); checkpoint('deletion');
      },
      request: async (captured, route, method, body) => {
        requests.push({ ...captured, route, method, body });
        if (route === '/api/sync/content') return { status: 200, body: hub.getSyncContent() };
        const policy = hub.setSyncTitlePolicy(captured.deviceId, body.enabled);
        if (body.enabled && enableResponseHold) {
          const held = enableResponseHold;
          checkpoint('remote-on');
          return held.then(() => ({ status: 200, body: policy }));
        }
        return { status: 200, body: policy };
      }
    });
  }
  function reload() {
    store = new CredentialStore(dir);
    settings = { ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')), ...store.settingsCredentials() };
    return boot();
  }
  return {
    dir, settingsPath, hub, requests, boot, reload,
    checkpoint: fn => { checkpoint = fn; }, hold: () => {
      let release;
      enableResponseHold = new Promise(resolve => { release = resolve; });
      return () => { enableResponseHold = null; release(); };
    },
    failRemoval: value => { removalFails = value; },
    privateDocument: () => store.readDocument(), saved: () => settings.syncContentState,
    remotePolicy: () => JSON.parse(fs.readFileSync(path.join(dir, 'hub.json'), 'utf8')).syncTitlePolicies.one,
    switch(runtime) {
      const replacement = { ...settings, hubUrl: 'https://new.example', secret: 'new-private', deviceId: 'two' };
      runtime.beforeDestinationChange(context(replacement));
      replacement.syncContentState = settings.syncContentState;
      persistSettingsAndCredentials({ store, settingsPath, settings: replacement, previousSettings: settings });
      settings = replacement;
      runtime.invalidate();
    }
  };
}

test('actual private-store restart revokes held remote admission after switching Hub before any upload', async () => {
  const f = admissionDiskFixture();
  try {
    let runtime = f.boot();
    let committed;
    const serverCommitted = new Promise(resolve => { committed = resolve; });
    f.hold();
    f.checkpoint(phase => { if (phase === 'remote-on') committed(); });
    void runtime.configure({ kind: 'sessionTitles', enabled: true, confirmed: true, identity: runtime.status().identity });
    await serverCommitted;
    assert.equal(f.remotePolicy().enabled, true);
    assert.equal(f.saved().enabled.sessionTitles, false);
    assert.equal(f.saved().pendingTitleCleanup.length, 1);
    assert.equal(Object.keys(f.privateDocument().credentials.hub.syncTitleCleanup).length, 1);
    f.checkpoint(() => {});
    runtime = f.reload(); // Do not settle the abandoned response or run a catch.
    assert.equal(runtime.status().pendingTitleCleanup, true);
    f.switch(runtime); // No prepareUpload/refresh/cleanup against the old Hub first.
    const before = f.requests.length;
    assert.equal((await runtime.retryCleanup()).ok, true);
    assert.ok(f.requests.length > before);
    for (const request of f.requests.slice(before)) {
      assert.equal(request.url, 'https://old.example');
      assert.equal(request.secret, 'old-private');
      assert.equal(request.deviceId, 'one');
      assert.equal(request.body.enabled, false);
    }
    assert.equal(f.remotePolicy().enabled, false);
    assert.equal(runtime.status().enabled.sessionTitles, false);
    assert.equal(runtime.status().pendingTitleCleanup, false);
    assert.doesNotMatch(fs.readFileSync(f.settingsPath, 'utf8'), /old-private|new-private/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

for (const boundary of ['journal', 'off', 'consent', 'deletion']) {
  test(`actual private-store restart at admission ${boundary} boundary reconciles consent safely`, async () => {
    const f = admissionDiskFixture();
    try {
      let runtime = f.boot();
      let snapshot;
      f.checkpoint(phase => {
        if (phase !== boundary || snapshot) return;
        snapshot = {
          preferences: fs.readFileSync(f.settingsPath),
          credentials: fs.readFileSync(path.join(f.dir, 'credentials.json'))
        };
      });
      assert.equal((await runtime.configure({ kind: 'sessionTitles', enabled: true, confirmed: true,
        identity: runtime.status().identity })).ok, true);
      assert.ok(snapshot, 'captured the exact durable boundary before the next write');
      f.checkpoint(() => {});
      fs.writeFileSync(f.settingsPath, snapshot.preferences);
      fs.writeFileSync(path.join(f.dir, 'credentials.json'), snapshot.credentials);
      runtime = f.reload();
      const committed = ['consent', 'deletion'].includes(boundary);
      assert.equal(runtime.status().enabled.sessionTitles, committed);
      const before = f.requests.length;
      assert.equal((await runtime.retryCleanup()).ok, true);
      assert.equal(f.remotePolicy().enabled, committed);
      if (committed) {
        assert.equal(f.requests.length, before, 'successful consent must not be revoked');
        assert.equal((await runtime.prepareUpload()).syncSessionTitles, true);
      } else assert.ok(f.requests.slice(before).some(row => row.body.enabled === false));
      assert.equal(runtime.status().pendingTitleCleanup, false);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test('actual private-store restart retains committed consent when journal deletion fails and still honors later OFF', async () => {
  const f = admissionDiskFixture();
  try {
    let runtime = f.boot();
    f.failRemoval(true);
    assert.equal((await runtime.configure({ kind: 'sessionTitles', enabled: true, confirmed: true,
      identity: runtime.status().identity })).ok, true);
    runtime = f.reload();
    assert.equal(runtime.status().enabled.sessionTitles, true);
    const before = f.requests.length;
    assert.equal((await runtime.prepareUpload()).syncSessionTitles, true);
    assert.equal(f.requests.slice(before).some(row => row.body?.enabled === false), false);
    assert.equal((await runtime.configure({ kind: 'sessionTitles', enabled: false,
      identity: runtime.status().identity })).ok, false, 'failed deletion leaves OFF cleanup pending');
    assert.equal(f.saved().enabled.sessionTitles, false);
    f.failRemoval(false);
    runtime = f.reload();
    assert.equal(runtime.status().enabled.sessionTitles, false);
    assert.equal((await runtime.retryCleanup()).ok, true);
    assert.equal(f.remotePolicy().enabled, false);
    assert.equal(runtime.status().pendingTitleCleanup, false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('actual private-store local OFF defeats a delayed response after the server commits admission ON', async () => {
  const f = admissionDiskFixture();
  let release;
  try {
    let runtime = f.boot();
    const identity = runtime.status().identity;
    let committed;
    const serverCommitted = new Promise(resolve => { committed = resolve; });
    release = f.hold();
    f.checkpoint(phase => { if (phase === 'remote-on') committed(); });
    const enable = runtime.configure({ kind: 'sessionTitles', enabled: true, confirmed: true, identity });
    await serverCommitted;
    const off = runtime.configure({ kind: 'sessionTitles', enabled: false, identity });
    assert.equal(f.saved().enabled.sessionTitles, false);
    assert.equal(runtime.status().pendingTitleCleanup, true);
    release();
    assert.equal((await enable).ok, false);
    assert.equal((await off).ok, true);
    f.checkpoint(() => {});
    runtime = f.reload();
    assert.equal(runtime.status().enabled.sessionTitles, false);
    assert.equal((await runtime.retryCleanup()).ok, true);
    assert.equal(f.remotePolicy().enabled, false);
    assert.equal((await runtime.prepareUpload()).syncSessionTitles, false);
  } finally {
    if (release) release();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
