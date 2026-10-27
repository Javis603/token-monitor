'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { createHub } = require('../../src/hub/server');

class SlowResponse extends Writable {
  constructor(blocked = false) {
    super({ highWaterMark: 1 });
    this.blocked = blocked;
    this.writes = [];
    this.pendingWrite = null;
    this.on('error', () => {});
  }

  writeHead() {}

  write(chunk, ...args) {
    this.writes.push(String(chunk));
    return super.write(chunk, ...args);
  }

  _write(_chunk, _encoding, callback) {
    if (this.blocked) this.pendingWrite = callback;
    else callback();
  }

  async release() {
    this.blocked = false;
    const callback = this.pendingWrite;
    this.pendingWrite = null;
    callback?.();
    await new Promise(setImmediate);
  }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 0, 1, 12) });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sse-backpressure-'));
  const hub = createHub({
    dataFile: path.join(directory, 'devices.json'),
    broadcastDelayMs: 10,
    persistIntervalMs: 300000,
    logger: { error() {} }
  });
  const responses = [];
  t.after(async () => {
    for (const res of responses) res.destroy();
    await hub.stop();
    fs.rmSync(directory, { recursive: true });
  });
  return {
    hub,
    open(blocked = false) {
      const res = new SlowResponse(blocked);
      responses.push(res);
      hub.server.emit('request', {
        method: 'GET', url: '/api/stats/stream', headers: { 'x-token-monitor-stream': '3' }
      }, res);
      return res;
    },
    publish(totalTokens) {
      t.mock.timers.tick(1);
      hub.ingest({ deviceId: 'a', updatedAt: new Date().toISOString(), today: { totalTokens } });
      t.mock.timers.tick(10);
    }
  };
}

function event(frame) {
  return JSON.parse(frame.match(/^data: (.+)$/m)[1]);
}

test('a blocked initial snapshot bounds the writable queue and catches up with the latest full stats', async (t) => {
  const { hub, open, publish } = fixture(t);
  publish(1);
  const slow = open(true);
  const fast = open();
  const initialBytes = slow.writableLength;
  assert.equal(slow.writableNeedDrain, true);

  publish(2);
  publish(2);
  publish(3);
  publish(3);

  assert.deepEqual(fast.writes.map((frame) => event(frame).type), ['stats', 'stats', 'freshness', 'stats', 'freshness']);
  assert.equal(slow.writes.length, 1);
  assert.equal(slow.writableLength, initialBytes);

  await slow.release();
  assert.equal(slow.writes.length, 2);
  assert.match(slow.writes[1], /^event: stats\n/);
  assert.deepEqual(event(slow.writes[1]).stats, JSON.parse(JSON.stringify(hub.getStats())));
  assert.equal(fast.writes.length, 5);

  publish(4);
  assert.equal(slow.writes.length, 3);
  assert.equal(event(slow.writes[2]).stats.periods.today.totalTokens, 4);
});

test('backpressure on a later stats frame also coalesces updates until drain', async (t) => {
  const { hub, open, publish } = fixture(t);
  publish(1);
  const res = open();
  res.blocked = true;
  publish(2);
  const bufferedBytes = res.writableLength;
  assert.equal(res.writableNeedDrain, true);

  publish(2);
  publish(3);
  assert.equal(res.writes.length, 2);
  assert.equal(res.writableLength, bufferedBytes);

  await res.release();
  assert.equal(res.writes.length, 3);
  assert.match(res.writes[2], /^event: stats\n/);
  assert.deepEqual(event(res.writes[2]).stats, JSON.parse(JSON.stringify(hub.getStats())));
});

test('drain restores device deletions and subscription revisions made while blocked', async (t) => {
  const { hub, open, publish } = fixture(t);
  publish(1);
  const res = open(true);
  hub.ingest({ deviceId: 'b', today: { totalTokens: 9 } });
  hub.deleteDevice('a');
  const subscriptions = hub.setSubscriptions([], '');
  assert.notEqual(subscriptions.updatedAt, '');
  assert.equal(res.writes.length, 1);

  await res.release();
  assert.equal(res.writes.length, 2);
  const stats = event(res.writes[1]).stats;
  assert.deepEqual(stats.devices.map((device) => device.deviceId), ['b']);
  assert.equal(stats.periods.today.totalTokens, 9);
  assert.equal(stats.subscriptionsUpdatedAt, subscriptions.updatedAt);
});

test('draining an accepted snapshot without newer stats does not send it twice', async (t) => {
  const { open, publish } = fixture(t);
  publish(1);
  const res = open(true);
  await res.release();
  assert.equal(res.writes.length, 1);
  publish(2);
  assert.equal(res.writes.length, 2);
});

test('heartbeats respect backpressure and a blocked heartbeat can catch up with full stats', async (t) => {
  const { hub, open, publish } = fixture(t);
  publish(1);
  const res = open();
  res.blocked = true;
  t.mock.timers.tick(30000);
  assert.equal(res.writes[1], ': hb\n\n');
  assert.equal(res.writableNeedDrain, true);
  const bufferedBytes = res.writableLength;

  t.mock.timers.tick(60000);
  publish(2);
  publish(2);
  assert.equal(res.writes.length, 2);
  assert.equal(res.writableLength, bufferedBytes);

  await res.release();
  assert.equal(res.writes.length, 3);
  assert.match(res.writes[2], /^event: stats\n/);
  assert.deepEqual(event(res.writes[2]).stats, JSON.parse(JSON.stringify(hub.getStats())));
  t.mock.timers.tick(30000);
  assert.equal(res.writes[3], ': hb\n\n');
});

test('a throwing initial write leaves no heartbeat or drain work', async (t) => {
  const { hub, publish } = fixture(t);
  const res = new SlowResponse();
  t.after(() => res.destroy());
  let writes = 0;
  res.write = () => { writes += 1; throw new Error('connection lost'); };
  hub.server.emit('request', {
    method: 'GET', url: '/api/stats/stream', headers: {}
  }, res);
  await new Promise(setImmediate);
  assert.equal(res.listenerCount('drain'), 0);
  publish(1);
  t.mock.timers.tick(90000);
  assert.equal(writes, 1);
});

for (const reason of ['close', 'error', 'stop']) {
  test(`${reason} removes blocked-response drain work and heartbeat timers`, async (t) => {
    const { hub, open, publish } = fixture(t);
    publish(1);
    const res = open(true);
    publish(2);
    if (reason === 'stop') await hub.stop();
    else {
      res.destroy(reason === 'error' ? new Error('connection lost') : undefined);
      await new Promise(setImmediate);
    }

    assert.equal(res.listenerCount('drain'), 0);
    const writes = res.writes.length;
    res.emit('drain');
    t.mock.timers.tick(90000);
    assert.equal(res.writes.length, writes);
  });
}
