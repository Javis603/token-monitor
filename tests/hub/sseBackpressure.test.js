'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { createHub } = require('../../src/hub/server');
const { SSE_BACKLOG_LIMIT_BYTES, createStatsStreamReceiver } = require('../../src/shared/hubProtocol');

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
    open(blocked = false, version = '3') {
      const res = new SlowResponse(blocked);
      responses.push(res);
      hub.server.emit('request', {
        method: 'GET', url: '/api/stats/stream', headers: { 'x-token-monitor-stream': version }
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

function frameType(frame) {
  return frame.match(/^event: (\w+)$/m)[1];
}

// Replays a connection's frames the way a widget does; every frame must apply.
function decode(writes) {
  const receiver = createStatsStreamReceiver();
  let stats;
  for (const frame of writes.filter((write) => write.startsWith('event: '))) stats = receiver.receive(frameType(frame), event(frame));
  return stats;
}

// Each model entry adds about 40 bytes to a full stats frame.
function padding(bytes) {
  const models = {};
  for (let index = 0; index * 40 < bytes; index += 1) models[`padding-${String(index).padStart(6, '0')}`] = { totalTokens: 1 };
  return { deviceId: 'padding', today: { totalTokens: 1, models } };
}

for (const version of ['3', '4']) {
  test(`stream v${version}: idle updates queue behind a large in-flight snapshot instead of forcing another`, async (t) => {
    const { hub, open, publish } = fixture(t);
    hub.ingest(padding(SSE_BACKLOG_LIMIT_BYTES * 1.25));
    publish(1);
    const res = open(true, version);
    assert.ok(res.writableLength > SSE_BACKLOG_LIMIT_BYTES);

    // Timestamp-only uploads, as from idle collectors while the snapshot drains.
    for (let index = 0; index < 8; index += 1) publish(1);
    if (version === '4') publish(2);

    const queued = res.writes.slice(1).map(frameType);
    assert.deepEqual(queued.slice(0, 8), Array(8).fill('freshness'));
    if (version === '4') assert.deepEqual(queued.slice(8), ['delta']);
    assert.ok(res.writableLength < res.writes[0].length + SSE_BACKLOG_LIMIT_BYTES);

    const written = res.writes.length;
    await res.release();
    assert.equal(res.writes.length, written, 'a connection that skipped nothing needs no resync');
    assert.deepEqual(decode(res.writes), JSON.parse(JSON.stringify(hub.getStats())));
  });

  test(`stream v${version}: a backlog past the budget is coalesced into one resync that later updates build on`, async (t) => {
    const { hub, open, publish } = fixture(t);
    hub.ingest(padding(SSE_BACKLOG_LIMIT_BYTES * 0.6));
    for (const deviceId of ['x1', 'x2', 'x3']) hub.ingest({ deviceId, today: { totalTokens: 1 } });
    publish(1);
    const res = open(false, version);
    await new Promise(setImmediate);
    res.blocked = true;

    // Device deletion always sends a complete stats frame.
    hub.deleteDevice('x1');
    const limit = res.writableLength + SSE_BACKLOG_LIMIT_BYTES;
    hub.deleteDevice('x2');
    hub.deleteDevice('x3');
    publish(2);
    assert.deepEqual(res.writes.map(frameType), ['snapshot', 'stats', 'stats']);
    assert.ok(res.writableLength <= limit);

    await res.release();
    assert.equal(res.writes.length, 4);
    const resync = event(res.writes[3]);
    assert.equal(frameType(res.writes[3]), 'stats');
    assert.equal(Number.isSafeInteger(resync.revision), version === '4');
    assert.deepEqual(resync.stats.devices.map((device) => device.deviceId).sort(), ['a', 'padding']);
    assert.equal(resync.stats.periods.today.totalTokens, 3);

    publish(2);
    assert.equal(frameType(res.writes[4]), 'freshness');
    if (version === '4') assert.equal(event(res.writes[4]).baseRevision, resync.revision);
    publish(3);
    assert.equal(frameType(res.writes[5]), version === '4' ? 'delta' : 'stats');
    assert.deepEqual(decode(res.writes), JSON.parse(JSON.stringify(hub.getStats())));
  });
}

test('the backlog budget counts UTF-8 bytes, not string length', async (t) => {
  const { hub, open, publish } = fixture(t);
  publish(1);
  const res = open(true);
  const limit = res.writableLength + SSE_BACKLOG_LIMIT_BYTES;
  const models = {};
  for (let index = 0; index < 6000; index += 1) models[`${'模'.repeat(40)}${index}`] = { totalTokens: 1 };
  hub.ingest({ deviceId: 'cjk', today: { totalTokens: 1, models } });
  const json = JSON.stringify(hub.getStats());
  assert.ok(json.length < SSE_BACKLOG_LIMIT_BYTES && Buffer.byteLength(json) > SSE_BACKLOG_LIMIT_BYTES);
  t.mock.timers.tick(10);
  assert.equal(res.writes.length, 1);
  assert.ok(res.writableLength <= limit);
});

test('updates queued while blocked carry device deletions and subscription revisions in order', async (t) => {
  const { hub, open, publish } = fixture(t);
  publish(1);
  const res = open(true);
  hub.ingest({ deviceId: 'b', today: { totalTokens: 9 } });
  hub.deleteDevice('a');
  const subscriptions = hub.setSubscriptions([], '');
  assert.notEqual(subscriptions.updatedAt, '');

  await res.release();
  const stats = decode(res.writes);
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

test('heartbeats respect backpressure while updates queue behind a blocked heartbeat', async (t) => {
  const { hub, open, publish } = fixture(t);
  publish(1);
  const res = open();
  res.blocked = true;
  t.mock.timers.tick(30000);
  assert.equal(res.writes[1], ': hb\n\n');
  assert.equal(res.writableNeedDrain, true);

  t.mock.timers.tick(60000);
  assert.equal(res.writes.length, 2, 'heartbeats do not accumulate behind a blocked write');
  publish(2);
  publish(2);
  assert.deepEqual(res.writes.slice(2).map(frameType), ['stats', 'freshness']);

  await res.release();
  assert.equal(res.writes.length, 4);
  assert.deepEqual(decode(res.writes), JSON.parse(JSON.stringify(hub.getStats())));
  t.mock.timers.tick(30000);
  assert.equal(res.writes[4], ': hb\n\n');
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
