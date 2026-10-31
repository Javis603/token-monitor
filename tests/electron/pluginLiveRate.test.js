'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createLiveRateResource } = require('../../src/electron/plugins/liveRate');

function clock() {
  let time = 100000, id = 0;
  const timers = new Map();
  return { now: () => time, timers,
    setTimer(fn, ms) { timers.set(++id, { fn, at: time + ms }); return id; },
    clearTimer(key) { timers.delete(key); },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > target) break;
        time = entry[1].at; timers.delete(entry[0]); entry[1].fn();
      }
      time = target;
    }
  };
}
const period = (n = 0, duration = 0, output = n) => ({ capabilities: { throughput: true },
  timedTokens: n, timedOutputTokens: output, timedDurationMs: duration });
const stats = p => ({ updatedAt: '2026-10-31T00:00:00Z', periods: { today: p } });
const owner = { key: 'sub', subscription: 'sub', owner: 'window', pluginId: 'plugin' };

test('live-rate demand baselines once, retains idle values, and expires without another publication', () => {
  const time = clock(); let changes = 0;
  const resource = createLiveRateResource({ ...time, leaseMs: 60000, onChange: () => changes++ });
  resource.publish(stats(period()), {});
  assert.deepEqual(resource.inspect(), { groups: 0, owners: 0, timer: false });
  assert.equal(resource.read(null, owner).reason, 'waitingForSample');
  time.advance(3000);
  resource.publish(stats(period(100, 1000, 40)), {});
  const live = resource.read(null, owner);
  assert.deepEqual([live.state, live.speed, live.burn, live.deviceCount], ['live', 40, 6000, 1]);
  resource.publish(stats(period(100, 1000, 40)), {});
  assert.equal(resource.read(null, owner).sampleRevision, live.sampleRevision, 'identical snapshots are not new samples');
  time.advance(8001);
  const idle = resource.read(null, owner);
  assert.equal(idle.state, 'idle'); assert.equal(idle.speed, 40);
  assert.equal(idle.sampledAt, live.sampledAt);
  assert.equal(changes, 1);
  time.advance(172000);
  const expired = resource.read(null, owner);
  assert.deepEqual([expired.state, expired.reason, expired.speed], ['unavailable', 'expired', null]);
  assert.equal(changes, 2); assert.equal(time.timers.size, 0);
  resource.dispose();
});

test('unsupported, missing, stale, reset and measured-zero readings remain distinct', () => {
  const time = clock();
  const resource = createLiveRateResource({ ...time, leaseMs: 60000, onChange() {} });
  resource.publish(stats({ ...period(), capabilities: { throughput: false } }), {});
  assert.equal(resource.read(null, owner).reason, 'unsupportedTiming');
  resource.publish(stats(period()), {});
  time.advance(1000); resource.publish(stats(period(100, 1000, 0)), {});
  assert.deepEqual([resource.read(null, owner).state, resource.read(null, owner).speed], ['live', 0]);
  resource.publish(stats(period()), {});
  assert.equal(resource.read(null, owner).reason, 'waitingForSample', 'counter regression clears previous samples');
  resource.publish({ ...stats(period()), stale: true }, {});
  assert.equal(resource.read(null, owner).reason, 'stale');
  resource.publish(null, {});
  assert.equal(resource.read(null, owner).reason, 'missingData');
  resource.dispose();
});

test('shared-source rate sums independently active devices and clears on source switches', () => {
  const time = clock();
  const resource = createLiveRateResource({ ...time, leaseMs: 60000, onChange() {} });
  const context = { sourceId: 'a', liveRateContext: { hubMode: 'client' } };
  const fleet = (a, b) => ({ devices: [{ deviceId: 'a', periods: { today: a } }, { deviceId: 'b', periods: { today: b } }] });
  resource.publish(fleet(period(), period()), context); resource.read(null, owner);
  resource.publish(fleet(period(100, 1000, 40), period(200, 2000, 100)), context);
  assert.equal(resource.read(null, owner).speed, 90, '40 + 50 tok/s, not a ratio of fleet totals');
  resource.publish({ devices: fleet(period(100, 1000, 40), period(200, 2000, 100)).devices.reverse() }, context);
  assert.equal(resource.read(null, owner).speed, 90, 'device ordering is not a new scope');
  resource.publish(fleet(period(100, 1000, 40), period(200, 2000, 100)), { ...context, sourceId: 'b' });
  assert.equal(resource.read(null, owner).reason, 'waitingForSample');
  resource.publish({ devices: [] }, context);
  assert.equal(resource.read(null, owner).reason, 'missingData', 'sync mode never falls back to aggregate counters');
  resource.dispose();
});

test('unsubscribe/release/revoke drop demand and one-shot leases never create expiry timers', () => {
  const time = clock();
  const resource = createLiveRateResource({ ...time, leaseMs: 60000, onChange() {} });
  resource.publish(stats(period()), {}); resource.read(null, owner);
  resource.publish(stats(period(100, 1000)), {});
  assert.equal(time.timers.size, 1);
  resource.releaseSubscription('sub');
  assert.deepEqual(resource.inspect(), { groups: 0, owners: 0, timer: false });
  resource.read(null, { ...owner, subscription: undefined });
  resource.publish(stats(period(200, 2000)), {});
  assert.equal(time.timers.size, 0);
  time.advance(60001); resource.publish(stats(period(300, 3000)), {});
  assert.equal(resource.inspect().groups, 0);
  resource.read(null, owner); resource.releaseOwner('window');
  assert.equal(resource.inspect().owners, 0);
  resource.read(null, owner); resource.revoke('plugin');
  assert.deepEqual(resource.inspect(), { groups: 0, owners: 0, timer: false });
  resource.dispose();
});

function setup(t) {
  const time = clock(), module = { exports: {} };
  const file = path.resolve(__dirname, '../../src/electron/plugins/businessData.js');
  const requireService = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
    require: name => name === './liveRate' ? { createLiveRateResource: options => createLiveRateResource({ ...options, setTimer: time.setTimer, clearTimer: time.clearTimer }) } : requireService(name),
    Buffer, AbortController, setTimeout: time.setTimer, clearTimeout: time.clearTimer });
  const service = module.exports.createBusinessDataService({ now: time.now });
  t.after(() => service.dispose());
  const auth = { active: true, pluginId: 'example' };
  return { service, time, auth, read: async (query = {}, as = auth) => JSON.parse(JSON.stringify(await service.query({ version: 1, resource: 'liveRate', ...query }, as, { owner: 'window' }))) };
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test('formal API projects state and device scope without raw IDs and keeps permissions/periods strict', async t => {
  const { service, time, auth, read } = setup(t);
  const publish = p => service.publish({ devices: [{ deviceId: 'PRIVATE_DEVICE', periods: { today: p } }] }, { liveRateContext: { hubMode: 'client' } });
  publish(period());
  const devices = await service.query({ version: 1, resource: 'devices' }, auth);
  const filter = { deviceId: devices.rows[0].id };
  assert.equal((await read({ filter })).rows[0].reason, 'waitingForSample');
  time.advance(1000); publish(period(100, 1000, 40));
  const result = await read({ filter });
  assert.deepEqual([result.availability, result.rows[0].speed, result.rows[0].state], ['available', 40, 'live']);
  assert.equal(result.rows[0].deviceId, filter.deviceId);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DEVICE/);
  assert.equal((await read({ filter }, { ...auth, pluginId: 'other' })).availability, 'scopeUnavailable');
  assert.equal((await read({ period: 'month' })).availability, 'invalidPeriod');
  assert.equal((await read({}, { ...auth, active: false })).availability, 'denied');
  assert.equal((await read({ filter: { deviceId: 'missing' } })).availability, 'scopeUnavailable');
});

test('formal subscriptions invalidate on live/idle/expiry, reset on source change, and stop all timers', async t => {
  const { service, time, auth, read } = setup(t), events = [], usageEvents = [];
  service.publish(stats(period()));
  const id = service.subscribe('window', { version: 1, resource: 'liveRate' }, auth, e => events.push(e));
  service.subscribe('usage', { version: 1, resource: 'usage' }, auth, e => usageEvents.push(e));
  await flush(); time.advance(101); events.length = 0;
  service.publish(stats(period(100, 1000, 40)));
  time.advance(101);
  assert.equal(events.at(-1).type, 'invalidate'); assert.equal((await read()).rows[0].state, 'live');
  const usageCount = usageEvents.length;
  time.advance(8100);
  assert.equal(events.at(-1).reset, false); assert.equal((await read()).rows[0].state, 'idle');
  assert.equal(usageEvents.length, usageCount, 'time transitions do not invalidate accounting');
  time.advance(172000);
  assert.equal((await read()).rows[0].reason, 'expired');
  service.publish(stats(period(200, 2000)), { sourceId: 'new' }); time.advance(101);
  assert.equal(events.at(-1).reset, true); assert.equal((await read()).rows[0].reason, 'waitingForSample');
  service.publish(stats(period(300, 3000)), { sourceId: 'new' }); time.advance(101); await read();
  assert.equal(service.unsubscribe('window', id), true);
  service.releaseOwner('usage');
  assert.equal(time.timers.size, 0);
});

test('two subscriptions in the same window retain independent live-rate demand', async t => {
  const { service, time, auth, read } = setup(t), remaining = [];
  const request = { version: 1, resource: 'liveRate' };
  service.publish(stats(period()));
  const first = service.subscribe('window', request, auth, () => {});
  const second = service.subscribe('window', request, auth, event => remaining.push(event));
  await flush(); time.advance(101);
  service.publish(stats(period(100, 1000))); time.advance(101);
  assert.equal((await read()).rows[0].state, 'live');
  service.unsubscribe('window', first);
  const count = remaining.length;
  service.publish(stats(period(300, 2000))); time.advance(101);
  assert.ok(remaining.length > count, 'the remaining subscription still receives updates');
  assert.equal((await read()).rows[0].speed, 200, 'removing one subscription must not reset the other baseline');
  service.unsubscribe('window', second);
  assert.equal(time.timers.size, 0);
});
