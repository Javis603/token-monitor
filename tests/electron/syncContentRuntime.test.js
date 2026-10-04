'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncContentRuntime, destinationIdentity, normalizeSyncContentState } = require('../../src/electron/syncContentRuntime');
const { normalizeSharedSyncValue } = require('../../src/shared/syncContent');

function fixture(options = {}) {
  let context = { mode: 'client', url: 'https://hub.example', secret: 'private', deviceId: 'one' };
  let saved = normalizeSyncContentState({ identity: destinationIdentity(context), ...options.saved });
  const values = { modelAliases: { modelAliases: { 'vendor/a': 'a' }, modelAliasGrouping: 'off' },
    customPricing: [{ modelId: 'a', inputPerM: 0, outputPerM: 2 }] };
  const docs = { modelAliases: { version: 1, revision: 0, updatedAt: '', value: null },
    customPricing: { version: 1, revision: 0, updatedAt: '', value: null } };
  const requests = [];
  const applied = [];
  let policy = { enabled: false, generation: 1 };
  let unavailable = false;
  let serverEnabled = true;
  let pause = null;
  let supported = true;
  let time = 100_000;
  let failedWrites = [];
  const cleanup = new Map();
  const dependencies = {
    getContext: () => context, getState: () => saved, saveState: value => {
      if (failedWrites.includes('preferences')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      saved = value;
    },
    getLocalValue: kind => values[kind], normalizeValue: normalizeSharedSyncValue,
    applyLocalValue: (kind, value) => { applied.push([kind, value]); values[kind] = value; },
    now: () => time,
    loadCleanupContexts: () => [...cleanup], saveCleanupContext: ctx => {
      if (failedWrites.includes('credentials')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      cleanup.set(ctx.identity, ctx);
    },
    removeCleanupContext: id => {
      if (failedWrites.includes('credentialRemoval')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      cleanup.delete(id);
    },
    request: async (ctx, path, method, body) => {
      requests.push({ ctx, path, method, body });
      if (pause) await pause;
      if (unavailable) throw new Error('offline');
      if (!supported) return { status: 404 };
      if (path === '/api/sync/content') return { status: 200,
        body: { ok: true, version: 1, sharedSettings: true, sessionTitles: { enabled: serverEnabled } } };
      if (path.includes('/titles/')) {
        if (body.enabled && !serverEnabled) return { status: 403 };
        policy = { enabled: body.enabled, generation: policy.generation + 1 };
        return { status: 200, body: { ok: true, ...policy } };
      }
      const kind = path.split('/').at(-1);
      if (method === 'PUT') {
        if (body.baseRevision !== docs[kind].revision) return { status: 409, body: docs[kind] };
        docs[kind] = { version: 1, revision: docs[kind].revision + 1, updatedAt: 'now', value: body.value };
      }
      return { status: 200, body: structuredClone(docs[kind]) };
    }
  };
  let runtime = createSyncContentRuntime(dependencies);
  return {
    get runtime() { return runtime; }, requests, values, docs, applied, cleanup,
    get saved() { return saved; }, get policy() { return policy; },
    failWrites: kinds => { failedWrites = kinds; },
    offline: value => { unavailable = value; }, server: value => { serverEnabled = value; },
    supported: value => { supported = value; }, pause: value => { pause = value; },
    tick: ms => { time += ms; }, restart: () => { runtime = createSyncContentRuntime(dependencies); },
    switch: (patch) => { context = { ...context, ...patch }; runtime.invalidate(); }
  };
}

test('title uploads require explicit consent and the destination server permission', async () => {
  const f = fixture();
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, false);
  const identity = f.runtime.status().identity;
  assert.equal((await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity })).ok, false);
  assert.equal(f.saved.enabled.sessionTitles, false);
  assert.equal((await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true })).ok, true);
  const options = await f.runtime.prepareUpload();
  assert.equal(options.syncSessionTitles, true);
  assert.equal(options.sessionTitleSyncGeneration, f.policy.generation);
  f.server(false);
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, false, 'revalidate receiving permission before sending text');
});

for (const store of ['credentials', 'preferences']) test(`${store} write failure cannot keep title sends enabled after revocation`, async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  const upload = await f.runtime.prepareUpload();
  f.failWrites([store]);
  f.offline(true);
  const disabling = f.runtime.configure({ kind: 'sessionTitles', enabled: false, identity });
  assert.equal(upload.signal.aborted, true);
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  assert.equal((await disabling).status.pendingTitleCleanup, true);
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, false);
  f.failWrites([]);
  f.offline(false);
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  f.restart();
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  assert.equal(f.runtime.status().pendingTitleCleanup, false);
});

test('a queued shared edit from the previous destination is rejected even after opt-ins reset', async () => {
  const f = fixture();
  const preview = await f.runtime.preview('customPricing');
  await f.runtime.configure({ ...preview, enabled: true, source: 'local' });
  const base = f.runtime.status();
  let release;
  f.pause(new Promise(resolve => { release = resolve; }));
  const pending = f.runtime.prepareUpload();
  const edit = f.runtime.publishPatch({ customModelPricing: [] }, base);
  f.switch({ url: 'https://second.example' });
  release();
  f.pause(null);
  await pending;
  await assert.rejects(edit, { code: 'hub_changed' });
  assert.equal(f.runtime.status().enabled.customPricing, false);
  assert.notDeepEqual(f.values.customPricing, []);
});

test('storage recovery saves the off choice even when the Hub remains offline', async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  f.failWrites(['preferences']);
  f.offline(true);
  await f.runtime.configure({ kind: 'sessionTitles', enabled: false, identity });
  assert.equal(f.saved.enabled.sessionTitles, true, 'disk still has the previous consent');
  f.failWrites([]);
  assert.equal((await f.runtime.retryCleanup()).ok, false, 'remote removal is still pending');
  assert.equal(f.saved.enabled.sessionTitles, false, 'save local revocation before networking');
  f.restart();
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  f.offline(false);
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, false);
});

test('storage recovery saves a previous connection before its offline cleanup and restart', async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  f.failWrites(['credentials']);
  f.switch({ url: 'https://second.example', secret: 'second' });
  assert.equal(f.cleanup.size, 0, 'the first credential write failed');
  f.offline(true);
  f.failWrites([]);
  await f.runtime.retryCleanup();
  assert.equal(f.cleanup.size, 1, 'old credentials are now durable while the Hub stays offline');
  f.restart();
  f.offline(false);
  await f.runtime.retryCleanup();
  assert.equal(f.requests.at(-1).ctx.url, 'https://hub.example');
  assert.equal(f.runtime.status().pendingTitleCleanup, false);
});

test('successful remote cleanup retains credentials until pending-row removal is durable', async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  f.switch({ url: 'https://second.example', secret: 'second' });
  f.failWrites(['preferences']);
  assert.equal((await f.runtime.retryCleanup()).ok, false);
  assert.equal(f.policy.enabled, false, 'remote revocation already succeeded');
  assert.equal(f.cleanup.size, 1, 'keep retry credentials after the preference save fails');
  f.failWrites([]);
  f.restart();
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.requests.at(-1).ctx.url, 'https://hub.example');
  assert.equal(f.cleanup.size, 0);
});

test('failed credential removal retains a retry row across restart', async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  f.switch({ url: 'https://second.example', secret: 'second' });
  f.failWrites(['credentialRemoval']);
  assert.equal((await f.runtime.retryCleanup()).ok, false);
  assert.equal(f.saved.pendingTitleCleanup.length, 1);
  f.failWrites([]);
  f.restart();
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.cleanup.size, 0);
});

test('restart removes orphaned credentials left after durable cleanup completion', async () => {
  const f = fixture();
  const previous = { mode: 'client', url: 'https://old.example', secret: 'old', deviceId: 'one' };
  previous.identity = destinationIdentity(previous);
  f.cleanup.set(previous.identity, previous);
  f.restart();
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.cleanup.size, 0);
  assert.equal(f.requests.length, 0, 'completed cleanup needs no repeated remote request');
});

test('failed title revocation stops uploads immediately and survives restart', async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  const upload = await f.runtime.prepareUpload();
  f.offline(true);
  const disabling = f.runtime.configure({ kind: 'sessionTitles', enabled: false, identity });
  assert.equal(upload.signal.aborted, true);
  assert.equal(f.saved.enabled.sessionTitles, false);
  assert.equal((await disabling).status.pendingTitleCleanup, true);
  f.restart();
  assert.equal(f.runtime.status().pendingTitleCleanup, true);
  f.offline(false);
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.policy.enabled, false);
  assert.equal(f.cleanup.size, 0);
});

test('connection changes clear consent and old credentials permit cleanup after restart', async () => {
  const f = fixture();
  const previous = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity: previous, confirmed: true });
  f.switch({ url: 'https://different.example', secret: 'different' });
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  assert.equal((await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity: previous, confirmed: true })).ok, false);
  f.restart();
  await f.runtime.retryCleanup();
  assert.equal(f.requests.at(-1).ctx.url, 'https://hub.example');
  assert.equal(f.saved.pendingTitleCleanup.length, 0);
});

test('first shared-settings enable requires a choice and preserves unknown prices and free rates', async () => {
  const f = fixture();
  const preview = await f.runtime.preview('customPricing');
  assert.equal(preview.hasServerValue, false);
  assert.equal(preview.serverCount, 0);
  const result = await f.runtime.configure({ ...preview, kind: 'customPricing', enabled: true, source: 'local' });
  assert.equal(result.ok, true);
  assert.equal(f.docs.customPricing.value[0].inputPerM, 0);
  assert.equal(Object.hasOwn(f.docs.customPricing.value[0], 'cacheWritePerM'), false);
  assert.equal(f.saved.enabled.customPricing, true);
});

test('server adoption uses the local application pipeline; disabled devices retain their prices', async () => {
  const f = fixture();
  f.docs.customPricing = { version: 1, revision: 3, updatedAt: 'now', value: [{ modelId: 'b', inputPerM: 4 }] };
  const preview = await f.runtime.preview('customPricing');
  assert.equal((await f.runtime.configure({ ...preview, enabled: true, source: 'server' })).ok, true);
  assert.deepEqual(f.applied[0], ['customPricing', [{ modelId: 'b', inputPerM: 4 }]]);
  await f.runtime.configure({ kind: 'customPricing', enabled: false, identity: preview.identity });
  f.docs.customPricing = { version: 1, revision: 4, updatedAt: 'later', value: [] };
  await f.runtime.refresh();
  assert.equal(f.values.customPricing[0].modelId, 'b');
  assert.equal(f.applied.length, 1);
});

test('a stale first-enable choice never overwrites shared or newly edited local settings', async () => {
  const f = fixture();
  const preview = await f.runtime.preview('modelAliases');
  f.docs.modelAliases = { version: 1, revision: 1, updatedAt: 'later', value: { modelAliases: {}, modelAliasGrouping: 'prefix' } };
  assert.equal((await f.runtime.configure({ ...preview, enabled: true, source: 'local' })).error, 'conflict');
  assert.equal(f.saved.enabled.modelAliases, false);
  const next = await f.runtime.preview('modelAliases');
  f.values.modelAliases.modelAliasGrouping = 'duplicates';
  assert.equal((await f.runtime.configure({ ...next, enabled: true, source: 'server' })).error, 'conflict');
  assert.equal(f.values.modelAliases.modelAliasGrouping, 'duplicates');
});

test('shared edits keep the renderer edit revision and refuse offline forks', async () => {
  const f = fixture();
  const preview = await f.runtime.preview('modelAliases');
  await f.runtime.configure({ ...preview, enabled: true, source: 'local' });
  const old = f.runtime.status();
  f.docs.modelAliases.revision = 2;
  await assert.rejects(f.runtime.publishPatch({ modelAliases: {} }, { identity: old.identity, revisions: old.revisions }), { code: 'conflict' });
  assert.equal(f.values.modelAliases.modelAliases['vendor/a'], 'a');
  f.offline(true);
  await assert.rejects(f.runtime.publishPatch({ modelAliases: {} }, { identity: old.identity, revisions: { modelAliases: 2 } }));
  assert.equal(f.values.modelAliases.modelAliases['vendor/a'], 'a');
});

test('a delayed document from the previous Hub cannot change local preferences', async () => {
  const f = fixture();
  let release;
  f.pause(new Promise(resolve => { release = resolve; }));
  const preview = f.runtime.preview('modelAliases');
  await new Promise(resolve => setImmediate(resolve));
  f.switch({ deviceId: 'two' });
  release();
  assert.equal((await preview).error, 'hub_changed');
  assert.equal(f.applied.length, 0);
});

test('legacy Hubs never receive title text and probes have a bounded retry rate', async () => {
  const f = fixture();
  f.supported(false);
  for (let i = 0; i < 5; i++) assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, false);
  assert.equal(f.requests.length, 1);
  f.tick(60_001);
  await f.runtime.prepareUpload();
  assert.equal(f.requests.length, 2);
});

test('each new shared revision catches up immediately rather than waiting a minute', async () => {
  const f = fixture();
  const preview = await f.runtime.preview('modelAliases');
  await f.runtime.configure({ ...preview, enabled: true, source: 'local' });
  for (const revision of [2, 3]) {
    f.docs.modelAliases = { version: 1, revision, value: { modelAliases: {}, modelAliasGrouping: revision === 2 ? 'prefix' : 'duplicates' } };
    f.runtime.notifyStats({ syncSettingsRevisions: { modelAliases: revision, customPricing: 0 } });
    await f.runtime.refresh();
    assert.equal(f.runtime.status().revisions.modelAliases, revision);
  }
});

test('consent identity includes device, credentials and URL path/query without exposing them', () => {
  const base = { mode: 'client', url: 'https://hub.example/path?secret=a', secret: 'a', deviceId: 'a' };
  const id = destinationIdentity(base);
  assert.match(id, /^[a-f0-9]{64}$/);
  for (const patch of [{ secret: 'b' }, { deviceId: 'b' }, { url: 'https://hub.example/path?secret=b' }, { url: 'https://hub.example/other' }]) {
    assert.notEqual(destinationIdentity({ ...base, ...patch }), id);
  }
});
