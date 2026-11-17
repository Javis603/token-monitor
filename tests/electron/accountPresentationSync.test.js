'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountPresentationSync } = require('../../src/electron/limits/accountPresentationSync');
const { normalizeSharedSyncValue } = require('../../src/shared/syncContent');
const { accountName, applyAccountOrder } = require('../../src/electron/renderer/limits/accountSlotsPanel');
const value = () => ({ deepseek: { labels: { a: 'Personal' }, order: ['a', 'b'] } });
function fixture({ mode = 'client', status = 200, cache = '', document = { revision: 0, value: null }, conflict = false, localLabels = [] } = {}) {
  let local = value();
  const calls = [];
  const runtime = createAccountPresentationSync({
    getContext: () => ({ mode, url: 'https://hub' }), identity: () => 'hub',
    getCacheIdentity: () => cache, getSeed: () => local, getLocalLabels: () => localLabels,
    apply: next => { local = next; cache = 'hub'; },
    request: async (_context, _path, method, body) => {
      calls.push({ method, body });
      if (status !== 200) return { status };
      if (method === 'GET') return { status: 200, body: structuredClone(document) };
      if (conflict) {
        conflict = false;
        document = { revision: 2, value: { deepseek: { labels: { c: 'Remote' }, order: ['c', 'a', 'b'] } } };
        return { status: 409 };
      }
      document = { revision: document.revision + 1, value: body.value };
      return { status: 200, body: structuredClone(document) };
    }
  });
  return { runtime, calls, local: () => local };
}
test('presentation normalization refuses malformed, secret and oversized replacements', () => {
  const normalize = input => normalizeSharedSyncValue('limitAccountPresentation', input);
  assert.deepEqual(normalize(value()), value());
  for (const input of [null, [], { unknown: { labels: {}, order: [] } },
    { deepseek: { labels: {}, order: [], token: 'secret' } },
    { deepseek: { labels: { a: 'user@example.com' }, order: [] } },
    { deepseek: { labels: { a: 'a'.repeat(33) }, order: [] } },
    { deepseek: { labels: {}, order: Array.from({ length: 201 }, (_, i) => String(i)) } },
    { deepseek: { labels: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [String(i), 'A'])), order: [] } }]) assert.throws(() => normalize(input));
  assert.deepEqual(normalize({ deepseek: { labels: { a: '' }, order: [] } }).deepseek.labels, { a: '' });
});
test('409 refetches and replays rename and move while preserving remote names', async () => {
  const f = fixture({ conflict: true });
  await f.runtime.publish([{ provider: 'deepseek', type: 'rename', key: 'a', label: 'Work' }, { provider: 'deepseek', type: 'order', order: ['b', 'a'] }]);
  assert.deepEqual(f.local().deepseek, { labels: { c: 'Remote', a: 'Work' }, order: ['b', 'a', 'c'] });
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'PUT', 'GET', 'PUT']);
  assert.equal(f.calls.at(-1).body.baseRevision, 2);
});
test('only a never-written document accepts a local seed; caches and clears never reseed', async () => {
  const fresh = fixture(); await fresh.runtime.refresh(); assert.equal(fresh.calls.length, 2);
  for (const options of [{ cache: 'old-hub' }, { document: { revision: 3, value: {} } }]) {
    const f = fixture(options); await f.runtime.refresh();
    assert.deepEqual(f.calls.map(call => call.method), ['GET']); assert.deepEqual(f.local(), {});
  }
});
test('local mode and old Hub rejection keep local editing silent and usable', async () => {
  for (const options of [{ mode: 'local' }, { status: 400 }, { status: 404 }]) {
    const f = fixture(options); await f.runtime.publish([{ provider: 'deepseek', type: 'rename', key: 'a', label: 'Work' }]);
    assert.deepEqual(f.local(), value());
    assert.equal(f.calls.length, options.mode === 'local' ? 0 : 1);
  }
});
test('stats marker refreshes incoming names and order using the local owner precedence', async () => {
  const f = fixture({ document: { revision: 5, value: { deepseek: { labels: { a: 'Remote choice' }, order: ['b', 'a'] } } } });
  f.runtime.notifyStats({ syncSettingsRevisions: { limitAccountPresentation: 5 } });
  await f.runtime.refresh();
  const slots = [{ id: '1', accountKey: 'a', label: 'Old slot' }, { id: '2', accountKey: 'b', label: '' }];
  const rows = applyAccountOrder([{ provider: 'deepseek', accountKey: 'a' }, { provider: 'deepseek', accountKey: 'b' }], { deepseek: slots }, '', f.local());
  assert.deepEqual(rows.map(row => row.accountKey), ['b', 'a']);
  assert.equal(rows[1].accountDisplayName, 'Remote choice');
  assert.equal(accountName(slots[0], null, undefined, f.local().deepseek), 'Remote choice');
  assert.notEqual(accountName(slots[0], null, undefined, { labels: { a: '' } }), 'Old slot');
});

test('simultaneous first initialization keeps both devices chosen names', async () => {
  const f = fixture({ conflict: true });
  await f.runtime.refresh();
  assert.equal(f.local().deepseek.labels.a, 'Personal');
  assert.equal(f.local().deepseek.labels.c, 'Remote');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 2);
});


test('first connection publishes locally owned slot names missing from an initialized Hub', async () => {
  const f = fixture({ document: { revision: 2, value: {} }, localLabels: [
    { provider: 'deepseek', type: 'rename', key: 'own', label: 'Laptop' }
  ] });
  await f.runtime.refresh();
  assert.equal(f.local().deepseek.labels.own, 'Laptop');
  assert.equal(f.local().deepseek.labels.a, undefined, 'the presentation cache does not reseed an initialized Hub');
});

test('a stream marker arriving during a read schedules a fresh follow-up read', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let finish;
  const caughtUp = new Promise(resolve => { finish = resolve; });
  let reads = 0;
  const runtime = createAccountPresentationSync({
    getContext: () => ({ mode: 'client', url: 'https://hub' }), identity: () => 'hub',
    getCacheIdentity: () => 'hub', getSeed: () => ({}),
    request: async () => {
      reads++;
      if (reads === 1) await held;
      return { status: 200, body: { revision: reads, value: {} } };
    },
    apply: () => { if (reads === 2) finish(); }
  });
  const first = runtime.refresh();
  await Promise.resolve();
  runtime.notifyStats({ syncSettingsRevisions: { limitAccountPresentation: 2 } });
  release();
  await first;
  await caughtUp;
  assert.equal(reads, 2);
});

test('a pending edit retries on the next stats frame even when the Hub revision is unchanged', async () => {
  let failPut = true;
  let document = { revision: 1, value: { deepseek: { labels: {}, order: [] } } };
  const puts = [];
  const runtime = createAccountPresentationSync({
    getContext: () => ({ mode: 'client', url: 'https://hub' }), identity: () => 'hub',
    getCacheIdentity: () => 'hub', getSeed: () => ({}), getLocalLabels: () => [], apply: () => {},
    request: async (_context, _path, method, body) => {
      if (method === 'GET') return { status: 200, body: structuredClone(document) };
      puts.push(body.value);
      if (failPut) { failPut = false; return { status: 503 }; }
      document = { revision: document.revision + 1, value: body.value };
      return { status: 200, body: structuredClone(document) };
    }
  });
  await runtime.refresh();
  await runtime.publish([{ provider: 'deepseek', type: 'rename', key: 'a', label: 'Work' }]);
  assert.equal(document.revision, 1, 'the first write failed');
  runtime.notifyStats({ syncSettingsRevisions: { limitAccountPresentation: 1 } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(document.value.deepseek.labels.a, 'Work');
});

test('slot names fill gaps on the first connection to another Hub despite an older Hub cache', async () => {
  const f = fixture({ cache: 'previous-hub', document: { revision: 3, value: { deepseek: { labels: {}, order: [] } } },
    localLabels: [{ provider: 'deepseek', type: 'rename', key: 'mine', label: 'Mine' }] });
  await f.runtime.refresh();
  const put = f.calls.find(call => call.method === 'PUT');
  assert.equal(put?.body.value.deepseek.labels.mine, 'Mine');
  assert.equal(Object.hasOwn(put.body.value.deepseek.labels, 'a'), false, 'the old Hub cache never seeds');
});

test('an aliased reading takes the shared name and position of the account that owns it', () => {
  const slots = [{ id: '1', accountKey: 'current-a', accountKeyAliases: ['old-a'], label: '' }, { id: '2', accountKey: 'b', label: '' }];
  const presentation = { deepseek: { labels: { 'current-a': 'Shared A' }, order: ['b', 'current-a'] } };
  const rows = applyAccountOrder([{ provider: 'deepseek', accountKey: 'old-a' }, { provider: 'deepseek', accountKey: 'b' }], { deepseek: slots }, '', presentation);
  assert.deepEqual(rows.map(row => row.accountKey), ['b', 'old-a']);
  assert.equal(rows[1].accountDisplayName, 'Shared A');
});

test('a rename becomes the newest label, and providers sort by code point', () => {
  const { replayPresentation } = require('../../src/electron/limits/accountPresentationSync');
  const labels = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 'A']));
  const next = replayPresentation({ deepseek: { labels, order: [] } }, [
    { provider: 'deepseek', type: 'rename', key: 'k0', label: 'Fresh' },
    { provider: 'deepseek', type: 'rename', key: 'new', label: 'New' }
  ]);
  assert.equal(next.deepseek.labels.k0, 'Fresh', 'the renamed key survives the cap');
  assert.equal(Object.hasOwn(next.deepseek.labels, 'k1'), false, 'the oldest untouched label is trimmed');
  assert.deepEqual(Object.keys(normalizeSharedSyncValue('limitAccountPresentation', { qoder: { labels: {}, order: [] }, deepseek: { labels: {}, order: [] } })), ['deepseek', 'qoder']);
});

test('a rename published while a refresh awaits the Hub survives that refresh', async () => {
  let releaseGet;
  let document = { revision: 4, value: { deepseek: { labels: { a: 'Old' }, order: [] } } };
  const applied = [];
  const runtime = createAccountPresentationSync({
    getContext: () => ({ mode: 'client', url: 'https://hub' }), identity: () => 'hub',
    getCacheIdentity: () => 'hub', getSeed: () => ({}), getLocalLabels: () => [],
    apply: value => { applied.push(value.deepseek?.labels?.a); },
    request: async (_context, _path, method) => {
      if (method === 'GET') {
        if (!releaseGet) await new Promise(resolve => { releaseGet = resolve; });
        return { status: 200, body: structuredClone(document) };
      }
      return { status: 503 };
    }
  });
  const refresh = runtime.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const publish = runtime.publish([{ provider: 'deepseek', type: 'rename', key: 'a', label: 'New' }]);
  releaseGet();
  await refresh; await publish;
  assert.equal(applied[0], 'New', 'the in-flight refresh replays the queued rename');
  assert.ok(!applied.includes('Old'));
});

test('an edit queued for one Hub is never written to the next one', async () => {
  let hub = 'a';
  let releaseGet;
  const puts = [];
  const runtime = createAccountPresentationSync({
    getContext: () => ({ mode: 'client', url: `https://${hub}` }), identity: context => context.url,
    getCacheIdentity: () => `https://${hub}`, getSeed: () => ({}), getLocalLabels: () => [], apply: () => {},
    request: async (context, _path, method, body) => {
      if (method === 'GET') {
        if (context.url === 'https://a' && !releaseGet) await new Promise(resolve => { releaseGet = resolve; });
        return { status: 200, body: { revision: 1, value: { deepseek: { labels: { k: 'Existing' }, order: [] } } } };
      }
      puts.push({ url: context.url, value: body.value });
      return { status: 200, body: { revision: 2, value: body.value } };
    }
  });
  const refresh = runtime.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const publish = runtime.publish([{ provider: 'deepseek', type: 'rename', key: 'k', label: 'Meant for A' }]);
  hub = 'b';
  releaseGet();
  await refresh; await publish;
  await runtime.refresh();
  assert.equal(puts.some(put => put.url === 'https://b' && put.value.deepseek?.labels?.k === 'Meant for A'), false);
});

test('a Hub upgraded in place is used once its stats advertise the group', async () => {
  let upgraded = false;
  const calls = [];
  const runtime = createAccountPresentationSync({
    getContext: () => ({ mode: 'client', url: 'https://hub' }), identity: () => 'hub',
    getCacheIdentity: () => '', getSeed: () => ({ deepseek: { labels: { k: 'Mine' }, order: [] } }), getLocalLabels: () => [], apply: () => {},
    request: async (_context, _path, method, body) => {
      calls.push(method);
      if (!upgraded) return { status: 404 };
      if (method === 'GET') return { status: 200, body: { revision: 0, value: null } };
      return { status: 200, body: { revision: 1, value: body.value } };
    }
  });
  await runtime.refresh();
  assert.deepEqual(calls, ['GET']);
  upgraded = true;
  runtime.notifyStats({ syncSettingsRevisions: { limitAccountPresentation: 0 } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(calls.includes('PUT'), 'the upgraded Hub receives the local names');
});
