'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncContentRuntime, normalizeSyncContentState } = require('../../src/electron/syncContentRuntime');
const { createSyncContentCredentialQueue } = require('../../src/electron/syncContentCredentials');
const { normalizeSharedSyncValue } = require('../../src/shared/syncContent');

function fixture(options = {}) {
  let context = { mode: 'client', url: 'https://hub.example', secret: 'private', deviceId: 'one' };
  let saved = normalizeSyncContentState(options.saved);
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
  let credentialDocument = { version: 1, credentials: {}, migrations: {} };
  const identityQueue = createSyncContentCredentialQueue(() => ({
    readDocument: () => structuredClone(credentialDocument),
    writeDocument: next => {
      if (failedWrites.includes('identity')) throw new Error('identity write failed');
      credentialDocument = structuredClone(next);
    }
  }));
  const dependencies = {
    resolveIdentity: identityQueue.resolveIdentity,
    getContext: () => context, getState: () => saved, saveState: value => {
      if (failedWrites.includes('preferences') || (failedWrites.includes('consent') && value.enabled.sessionTitles)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      saved = value;
    },
    getLocalValue: kind => values[kind], normalizeValue: normalizeSharedSyncValue,
    applyLocalValue: (kind, value) => { applied.push([kind, value]); values[kind] = value; },
    now: () => time,
    loadCleanupContexts: () => {
      if (failedWrites.includes('cleanupLoad')) throw new Error('malformed credentials');
      return [...cleanup];
    }, saveCleanupContext: ctx => {
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
    context: () => context,
    rawSwitch: patch => { context = { ...context, ...patch }; },
    switch: (patch) => {
      const next = { ...context, ...patch };
      runtime.beforeDestinationChange(next);
      context = next;
      runtime.invalidate();
    }
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
  assert.throws(() => f.switch({ url: 'https://second.example', secret: 'second' }), { code: 'cleanup_pending' });
  assert.equal(f.context().url, 'https://hub.example', 'refuse destination replacement');
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

test('restart conservatively revokes an orphan journal that may precede its preference row', async () => {
  const f = fixture();
  const previous = { mode: 'client', url: 'https://old.example', secret: 'old', deviceId: 'one' };
  previous.identity = require('node:crypto').randomUUID();
  f.cleanup.set(previous.identity, previous);
  f.restart();
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.cleanup.size, 0);
  assert.equal(f.requests.length, 1, 'journal without a row may be a crash before OFF persisted');
  assert.equal(f.requests[0].ctx.url, 'https://old.example');
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

test('opaque consent identity is stable on restart and changes with private destination binding', () => {
  const f = fixture();
  const first = f.runtime.status().identity;
  assert.match(first, /^[a-f0-9-]{36}$/);
  f.restart();
  assert.equal(f.runtime.status().identity, first);
  for (const patch of [{ secret: 'b' }, { deviceId: 'b' }, { url: 'https://hub.example/path?secret=b' }, { url: 'https://hub.example/other' }]) {
    const previous = f.runtime.status().identity;
    f.switch(patch);
    assert.notEqual(f.runtime.status().identity, previous);
  }
});

for (const store of ['cleanupLoad', 'identity', 'preferences']) test(`startup ${store} failure stays off and retries after storage recovery`, async () => {
  const f = fixture();
  const old = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity: old, confirmed: true });
  if (store !== 'cleanupLoad') f.rawSwitch({ deviceId: 'two' });
  f.failWrites([store]);
  assert.doesNotThrow(() => f.restart());
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  assert.equal(f.runtime.status().error, 'cleanup_pending');
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, false);
  f.failWrites([]);
  await f.runtime.retryCleanup();
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  assert.notEqual(f.runtime.status().error, 'cleanup_pending');
});

for (const url of ['bad url', 'ftp://hub.example', 'https://user:pass@hub.example']) test(`invalid destination ${url} leaves settings accessible`, async () => {
  const f = fixture();
  f.rawSwitch({ url });
  assert.doesNotThrow(() => f.restart());
  assert.equal(f.runtime.status().error, 'unsupported');
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, false);
  assert.equal(f.requests.length, 0);
});

for (const store of ['credentials', 'preferences']) test(`failed ${store} destination journal refuses replacement and survives immediate restart`, async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  const upload = await f.runtime.prepareUpload();
  f.failWrites([store]);
  assert.throws(() => f.switch({ url: 'https://second.example', secret: 'second', deviceId: 'two' }), { code: 'cleanup_pending' });
  assert.equal(upload.signal.aborted, true);
  assert.equal(f.context().url, 'https://hub.example');
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  f.failWrites([]);
  f.restart();
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  assert.equal(f.runtime.status().pendingTitleCleanup, true);
  const before = f.requests.length;
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.requests[before].ctx.url, 'https://hub.example');
  assert.equal(f.requests[before].ctx.secret, 'private');
});

test('crash immediately after preflight keeps old cleanup despite a committed replacement context', async () => {
  const f = fixture();
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity: f.runtime.status().identity, confirmed: true });
  const replacement = { ...f.context(), url: 'https://second.example', secret: 'second', deviceId: 'two' };
  f.runtime.beforeDestinationChange(replacement);
  f.rawSwitch(replacement);
  f.restart();
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  const before = f.requests.length;
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.requests[before].ctx.url, 'https://hub.example');
});

test('missing cleanup context stays visibly pending', async () => {
  const f = fixture({ saved: { pendingTitleCleanup: [{ identity: 'unknown', deviceId: 'old', destination: 'old.example' }] } });
  assert.equal((await f.runtime.retryCleanup()).ok, false);
  assert.equal(f.runtime.status().error, 'cleanup_pending');
  assert.equal(f.saved.pendingTitleCleanup.length, 1);
});

test('unrelated patches bypass a held upload while opted-out shared edits retain their original destination', async () => {
  const f = fixture();
  let release;
  f.pause(new Promise(resolve => { release = resolve; }));
  const upload = f.runtime.prepareUpload();
  await new Promise(resolve => setImmediate(resolve));
  const unrelated = f.runtime.publishPatch({ showLiveDot: false });
  const alias = f.runtime.publishPatch({ modelAliases: {} });
  const price = f.runtime.publishPatch({ customModelPricing: [] });
  let timeout;
  try {
    await Promise.race([unrelated, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('unrelated patch blocked')), 100); })]);
    f.switch({ url: 'https://second.example' });
  } finally { clearTimeout(timeout); f.pause(null); release(); }
  await upload;
  await assert.rejects(alias, { code: 'hub_changed' });
  await assert.rejects(price, { code: 'hub_changed' });
});

test('401 authentication failure is distinct from 403 receiving permission denial', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'titles_not_allowed']]) {
    let saved;
    const runtime = createSyncContentRuntime({ getContext: () => ({ mode: 'client', url: 'https://hub.example', deviceId: 'one' }),
      getState: () => saved, saveState: value => { saved = value; }, request: async () => ({ status }) });
    assert.equal((await runtime.refresh()).error, expected);
  }
});

test('receiving ON refreshes capabilities without changing sender choice; OFF revokes and ON never reenables', async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  f.runtime.receiverPermissionChanged(true);
  assert.equal(f.runtime.status().enabled.sessionTitles, true);
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, true);
  f.runtime.receiverPermissionChanged(false);
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  await f.runtime.retryCleanup();
  f.runtime.receiverPermissionChanged(true);
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, false);
});


test('local OFF while title admission is pending cannot be overwritten by its delayed response', async () => {
  const f = fixture();
  await f.runtime.refresh();
  let release;
  f.pause(new Promise(resolve => { release = resolve; }));
  const identity = f.runtime.status().identity;
  const enable = f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  await new Promise(resolve => setImmediate(resolve));
  const off = f.runtime.configure({ kind: 'sessionTitles', enabled: false, identity });
  try { assert.equal(f.runtime.status().enabled.sessionTitles, false); }
  finally { f.pause(null); release(); }
  assert.equal((await enable).ok, false);
  assert.equal((await off).ok, true);
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, false);
  f.restart();
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
});


test('failed consent save journals the admitted policy and clears it after immediate restart', async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  f.failWrites(['consent']);
  const result = await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(f.policy.enabled, true);
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  assert.equal(f.cleanup.size, 1);
  f.failWrites([]);
  f.restart();
  assert.equal(f.runtime.status().pendingTitleCleanup, true);
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.policy.enabled, false);
});


test('OFF with a failed private journal cannot lose its old context on the next destination change after restart', async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  f.failWrites(['credentials']);
  f.offline(true);
  await f.runtime.configure({ kind: 'sessionTitles', enabled: false, identity });
  assert.equal(f.saved.enabled.sessionTitles, false);
  assert.equal(f.cleanup.size, 0);
  f.failWrites([]);
  f.restart();
  f.switch({ url: 'https://second.example', secret: 'second' });
  assert.equal(f.cleanup.size, 1, 'pending cleanup alone requires journaling old credentials');
  f.restart();
  f.offline(false);
  const before = f.requests.length;
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.requests[before].ctx.url, 'https://hub.example');
  assert.equal(f.requests[before].ctx.secret, 'private');
});

test('first identity preference save failure does not escape construction and can recover', async () => {
  let failed = true;
  let saved;
  const runtime = createSyncContentRuntime({ getContext: () => ({ mode: 'client', url: 'https://hub.example', deviceId: 'one' }),
    getState: () => saved, saveState: next => { if (failed) throw new Error('ENOSPC'); saved = next; },
    request: async (_context, route, _method, body) => ({ status: 200, body: route === '/api/sync/content'
      ? { version: 1, sharedSettings: true, sessionTitles: { enabled: true } } : { enabled: body.enabled, generation: 1 } }) });
  assert.deepEqual(runtime.status().enabled, { sessionTitles: false, modelAliases: false, customPricing: false });
  assert.equal(runtime.status().error, 'cleanup_pending');
  assert.equal((await runtime.prepareUpload()).syncSessionTitles, false);
  failed = false;
  assert.equal((await runtime.retryCleanup()).ok, true);
  assert.equal(saved.identity, runtime.status().identity);
});

test('legacy local consent resets without exposing its deterministic verifier', async () => {
  const legacy = 'a'.repeat(64);
  const f = fixture({ saved: { identity: legacy,
    enabled: { sessionTitles: true, modelAliases: true, customPricing: true } } });
  assert.equal(JSON.stringify(f.runtime.status()).includes(legacy), false);
  assert.equal(JSON.stringify(f.saved).includes(legacy), false);
  assert.deepEqual(f.runtime.status().enabled, { sessionTitles: false, modelAliases: false, customPricing: false });
  assert.equal(f.runtime.status().pendingTitleCleanup, true);
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.policy.enabled, false);
});

for (const store of ['credentials', 'preferences']) test(`failed ${store} admission journal prevents remote enable`, async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  f.failWrites([store]);
  const result = await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(f.requests.some(row => row.body?.enabled === true), false);
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  f.failWrites([]);
  f.restart();
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.runtime.status().pendingTitleCleanup, false);
});

test('successful title admission survives restart without revocation', async () => {
  const f = fixture();
  assert.equal((await f.runtime.configure({ kind: 'sessionTitles', enabled: true,
    identity: f.runtime.status().identity, confirmed: true })).ok, true);
  f.restart();
  const before = f.requests.length;
  assert.equal(f.runtime.status().enabled.sessionTitles, true);
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.requests.length, before);
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, true);
});

test('committed admission journal deletion retries without erasing consent or a later OFF', async () => {
  const f = fixture();
  const identity = f.runtime.status().identity;
  f.failWrites(['credentialRemoval']);
  assert.equal((await f.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true })).ok, true);
  assert.equal(f.cleanup.size, 1);
  f.restart();
  const before = f.requests.length;
  assert.equal(f.runtime.status().enabled.sessionTitles, true);
  assert.equal((await f.runtime.prepareUpload()).syncSessionTitles, true);
  assert.equal(f.requests.slice(before).some(row => row.body?.enabled === false), false);
  f.offline(true);
  await f.runtime.configure({ kind: 'sessionTitles', enabled: false, identity });
  assert.equal(f.cleanup.size, 2, 'OFF has a separate revocation journal');
  f.failWrites([]);
  f.restart();
  assert.equal(f.runtime.status().enabled.sessionTitles, false);
  assert.equal(f.runtime.status().pendingTitleCleanup, true);
  f.offline(false);
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal(f.policy.enabled, false);
});

test('restart refuses new admission until its interrupted journal has been revoked', async () => {
  const f = fixture();
  f.failWrites(['consent']);
  assert.equal((await f.runtime.configure({ kind: 'sessionTitles', enabled: true, confirmed: true,
    identity: f.runtime.status().identity })).ok, false);
  assert.equal(f.policy.enabled, true);
  f.failWrites([]);
  f.restart();
  const before = f.requests.filter(row => row.body?.enabled === true).length;
  assert.equal((await f.runtime.configure({ kind: 'sessionTitles', enabled: true, confirmed: true,
    identity: f.runtime.status().identity })).error, 'cleanup_pending');
  assert.equal(f.requests.filter(row => row.body?.enabled === true).length, before);
  assert.equal((await f.runtime.retryCleanup()).ok, true);
  assert.equal((await f.runtime.configure({ kind: 'sessionTitles', enabled: true, confirmed: true,
    identity: f.runtime.status().identity })).ok, true);
});
