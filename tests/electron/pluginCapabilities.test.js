'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPluginCapabilities } = require('../../src/electron/plugins/capabilities');
const { createBusinessDataService } = require('../../src/electron/plugins/businessData');

test('capability owners isolate IDs and release cancels delayed replies across resume', async () => {
  let resolve;
  const registrations = new Map(); let sequence = 0;
  const service = {
    query: () => new Promise(done => { resolve = done; }),
    subscribe(owner, query, auth, send) { const id = ++sequence; registrations.set(id, { owner, auth, send }); return id; },
    unsubscribe(owner, id) { if (registrations.get(id)?.owner === owner) registrations.delete(id); },
    releaseOwner(owner) { for (const [id, value] of registrations) if (value.owner === owner) registrations.delete(id); }
  };
  const api = createPluginCapabilities({ businessData: service });
  const a = {}, b = {}, received = [];
  let revision = 1;
  const context = { auth: () => ({ pluginId: 'alpha', active: true, revision, permissions: ['tm.data.usage'] }), send: event => received.push(event) };
  await api.call(a, 'data.subscribe', { id: 'same', query: {} }, context);
  await api.call(b, 'data.subscribe', { id: 'same', query: {} }, context);
  assert.equal(registrations.size, 2);
  const stale = [...registrations.values()][0];
  const pending = api.call(a, 'data.query', {}, context);
  api.release(a);
  assert.equal(registrations.size, 1);
  await api.call(a, 'data.subscribe', { id: 'same', query: {} }, context);
  stale.send({ secret: 'late' }); assert.deepEqual(received, []);
  resolve({ secret: 'late' }); await assert.rejects(pending, /revoked/);
  revision++;
  for (const value of registrations.values()) value.send({ secret: 'old generation' });
  assert.deepEqual(received, []);
  api.dispose(); assert.equal(registrations.size, 0);
});

test('structured settings errors survive Rich envelope and awaited writes are fenced', async () => {
  const api = createPluginCapabilities({ businessData: { releaseOwner() {} } });
  let active = true, finish;
  const context = { auth: () => ({ active, pluginId: 'alpha', revision: 1 }), settings: {
    get() { throw Object.assign(new Error('invalid'), { code: 'invalid-settings-values', fields: { count: 'range' } }); },
    update() { return new Promise(done => { finish = done; }); }
  } };
  const result = await api.invoke({}, 'settings.get', {}, context);
  assert.deepEqual(result, { __tmCapability: 1, ok: false, error: { message: 'invalid', code: 'invalid-settings-values', fields: { count: 'range' } } });
  const pending = api.call({}, 'settings.update', {}, context); active = false; finish({ revision: 2 });
  await assert.rejects(pending, /revoked/); api.dispose();
});

test('release before initial subscription delivery prevents cache reads', async () => {
  let reads = 0;
  const businessData = createBusinessDataService({ loadHistory: () => { reads++; return {}; } });
  businessData.publish({});
  const api = createPluginCapabilities({ businessData }); const owner = {};
  const pending = api.call(owner, 'data.subscribe', { id: 'history', query: { version: 1, resource: 'history' } }, {
    auth: () => ({ active: true, pluginId: 'alpha', permissions: ['tm.data.history'] }), send() { assert.fail('late delivery'); }
  });
  api.release(owner); await pending; await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0); api.dispose(); businessData.dispose();
});

const { createCapabilityLane, isCapabilityRequest } = require('../../src/electron/plugins/capabilities');
const cursorArgs = { query: { version: 1, resource: 'sessions', page: { cursor: 'opaque-cursor' } } };
const pageContext = { auth: () => ({ active: true, pluginId: 'alpha', permissions: ['tm.data.sessions'], revision: 1 }) };
const flush = () => new Promise(resolve => setImmediate(resolve));
function laneClock() {
  let time = 0;
  const timers = new Map();
  const lane = createCapabilityLane({ now: () => time,
    setTimer(fn, ms) { const id = {}; timers.set(id, { fn, at: time + ms }); return id; }, clearTimer(id) { timers.delete(id); } });
  return { lane, timers, async advance(ms) {
    time += ms;
    for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    await flush();
  } };
}
test('capability adapter adds no cursor sleep: 2000 limit-one pages finish inside unchanged TTL', async t => {
  let time = 0;
  const service = createBusinessDataService({ now: () => time });
  service.publish({ periods: { today: { sessions: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [i, { sessionId: String(i), client: 'codex', totalTokens: i }])) } } });
  const api = createPluginCapabilities({ businessData: service, now: () => time,
    setTimer(fn, ms) { time += ms; queueMicrotask(fn); return {}; }, clearTimer() {} });
  t.after(() => { api.dispose(); service.dispose(); });
  const ids = new Set(), owner = {};
  let cursor;
  do {
    const value = await api.call(owner, 'data.query', { query: { version: 1, resource: 'sessions', page: { limit: 1, ...(cursor ? { cursor } : {}) } } }, pageContext);
    assert.equal(value.availability, 'available');
    assert.equal(value.rows.length, 1); ids.add(value.rows[0].id);
    cursor = value.pageInfo.nextCursor;
  } while (cursor);
  assert.equal(ids.size, 2000); assert.equal(time, 0, 'adapter must not advance the clock');
});
test('lane validates complete bounded request envelopes, not cursor presence', () => {
  for (const [op, args] of [['data.query', { query: { page: { cursor: 'anything' } } }], ['data.query', { query: { ...cursorArgs.query, page: { limit: 0, cursor: 'anything' } } }], ['data.subscribe', { id: '!', query: cursorArgs.query }], ['settings.get', { binary: new Uint8Array(2) }], ['settings.get', { extra: 'x'.repeat(65537) }], ['data.unknown', {}]]) assert.equal(isCapabilityRequest(op, args), false);
  assert.equal(isCapabilityRequest('data.query', cursorArgs), true, 'cursor authentication remains in service');
});
test('request lane bounds active and queued work, rejects duplicate IDs, and cancels before service invocation', async () => {
  const { lane, timers } = laneClock(); let starts = 0, finish;
  const first = lane.run('settings.get', {}, () => { starts++; return new Promise(resolve => { finish = resolve; }); }, 1).catch(e => e.message);
  await flush();
  const queued = Array.from({ length: 31 }, (_, i) => lane.run('data.query', cursorArgs, () => { starts++; return {}; }, i + 2).catch(e => e.message));
  assert.throws(() => lane.run('settings.get', {}, () => ({}), 33), /request limit/);
  assert.equal(starts, 1); assert.equal(timers.size, 0);
  lane.close();
  assert.deepEqual(await Promise.all([first, ...queued]), Array(32).fill('capability revoked'));
  finish({ private: 'late' }); await flush(); assert.equal(starts, 1);
  const other = createCapabilityLane();
  const pending = other.run('settings.get', {}, () => new Promise(() => {}), 1).catch(e => e.message);
  assert.throws(() => other.run('settings.get', {}, () => ({}), 1), /request limit/); other.close(); await pending;
});
test('byte/work debt schedules only future starts and release clears the single wait timer', async () => {
  const { lane, timers, advance } = laneClock(); let starts = 0;
  const large = { data: 'x'.repeat(56000) };
  for (let i = 0; i < 3; i++) { assert.deepEqual(await lane.run('settings.get', {}, () => large), large); await flush(); }
  const pending = lane.run('data.query', cursorArgs, () => { starts++; return {}; }).catch(e => e.message);
  assert.equal(timers.size, 1); assert.equal(starts, 0);
  lane.close(); assert.equal(timers.size, 0); assert.equal(await pending, 'capability revoked');
  await advance(100); assert.equal(starts, 0);
});
test('adapter release cancels running queries immediately, including first pages', async () => {
  for (const args of [{ query: { version: 1, resource: 'sessions' } }, cursorArgs]) {
    let finish;
    const api = createPluginCapabilities({ businessData: { query: () => new Promise(resolve => { finish = resolve; }), releaseOwner() {} } });
    const owner = {}, pending = api.invoke(owner, 'data.query', args, pageContext);
    api.release(owner); assert.equal((await pending).error.message, 'capability revoked');
    finish({ private: 'late' }); await flush(); api.dispose();
  }
});
for (const change of ['privacy', 'source']) test(`queued cursor checks ${change} fence at service entry`, async () => {
  const service = createBusinessDataService();
  const stats = { periods: { today: { sessions: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [i, { sessionId: String(i), client: 'codex', title: 'Private' }])) } } };
  service.publish(stats);
  const api = createPluginCapabilities({ businessData: service }), lane = createCapabilityLane(), owner = {};
  const context = { auth: () => ({ ...pageContext.auth(), permissions: ['tm.data.sessions', 'tm.data.identities'] }) };
  const first = await api.call(owner, 'data.query', { query: { version: 1, resource: 'sessions', page: { limit: 1 } } }, context);
  let finish;
  const blocking = lane.run('settings.get', {}, () => new Promise(resolve => { finish = resolve; })); await flush();
  const args = { query: { version: 1, resource: 'sessions', page: { limit: 1, cursor: first.pageInfo.nextCursor } } };
  const queued = lane.run('data.query', args, () => api.call(owner, 'data.query', args, context));
  service.publish(stats, change === 'privacy' ? { preferences: { sessionTitlesEnabled: false } } : { sourceId: 'new' });
  finish({}); await blocking;
  assert.equal((await queued).availability, 'snapshotExpired');
  lane.close(); api.dispose(); service.dispose();
});

test('synchronous capability work incurs adaptive debt; asynchronous waiting does not', async () => {
  let wall = 0, work = 0;
  const timers = new Map();
  const lane = createCapabilityLane({ now: () => wall, workNow: () => work,
    setTimer(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; }, clearTimer(id) { timers.delete(id); } });
  let finish;
  const waiting = lane.run('settings.get', {}, () => new Promise(resolve => { finish = resolve; }));
  await flush(); wall += 10000; finish({}); await waiting; await flush();
  await lane.run('settings.get', {}, () => { work += 20; return {}; }); await flush();
  let started = false;
  const pending = lane.run('settings.get', {}, () => { started = true; return {}; }).catch(e => e.message);
  assert.equal(started, false); assert.equal(timers.size, 1);
  assert.ok([...timers.values()][0].ms < 100, '20ms slice creates bounded work debt, not 10s async wait debt');
  lane.close(); assert.equal(await pending, 'capability revoked');
});
