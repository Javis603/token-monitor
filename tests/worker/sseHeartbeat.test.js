'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setImmediate: settle } = require('node:timers/promises');
const test = require('node:test');

async function fixture(t) {
  const { HubDO } = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const records = new Map();
  let current = true;
  let readGate = null;
  let reads = 0;
  let writes = 0;
  const state = { storage: {
    async get(key) {
      reads++;
      if (readGate) await readGate;
      if (!current) throw new Error('Durable Object instance has been replaced');
      return records.get(key);
    },
    async put(key, value) { writes++; records.set(key, structuredClone(value)); },
    async delete(key) { records.delete(key); },
    async list({ prefix = '' } = {}) { return new Map([...records].filter(([key]) => key.startsWith(prefix))); }
  } };
  const hub = new HubDO(state, { TOKEN_MONITOR_SECRET: 'fixture-secret' });
  await hub.ready;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const abort = new AbortController();
  const response = await hub.fetch(new Request('https://fixture.invalid/api/stats/stream', {
    headers: { authorization: 'Bearer fixture-secret', 'x-token-monitor-stream': '4' }, signal: abort.signal
  }));
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /^event: snapshot/);
  await settle();
  const baselineWrites = writes;
  reads = 0;
  t.after(async () => { abort.abort(); await reader.cancel().catch(() => {}); });
  return { hub, reader, reads: () => reads, writes: () => writes - baselineWrites,
    retire: () => { current = false; }, blockReads: gate => { readGate = gate; } };
}

test('Worker heartbeats check storage authority before keeping a quiet stream alive', async t => {
  const f = await fixture(t);
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(new TextDecoder().decode((await f.reader.read()).value), ': hb\n\n');
  assert.ok(f.reads() > 0, 'a heartbeat must verify that this Durable Object still owns its storage');
  assert.equal(f.writes(), 0, 'liveness verification must not write persisted data');
  assert.equal(f.hub.sseClients.size, 1);
});

test('a replaced Worker instance aborts its old SSE stream instead of sending heartbeats forever', async t => {
  const f = await fixture(t);
  f.retire();
  const pendingRead = f.reader.read();
  pendingRead.catch(() => {});
  t.mock.timers.tick(30_000);
  await assert.rejects(pendingRead, /instance has been replaced/);
  assert.equal(f.hub.sseClients.size, 0);
  assert.equal(f.hub.heartbeatTimer, null);
});

test('a slow storage authority check does not queue overlapping heartbeats', async t => {
  const f = await fixture(t);
  let release;
  f.blockReads(new Promise(resolve => { release = resolve; }));
  t.mock.timers.tick(90_000);
  assert.equal(f.reads(), 1);
  release();
  await settle();
  assert.equal(new TextDecoder().decode((await f.reader.read()).value), ': hb\n\n');
  assert.equal(f.hub.sseClients.size, 1);
});

test('a replaced instance aborts a backpressured stream without waiting for its reader to drain', async t => {
  const f = await fixture(t);
  const client = [...f.hub.sseClients][0];
  f.hub.writeEncoded(client, new TextEncoder().encode('event: stats\ndata: {}\n\n'));
  await settle();
  assert.ok(client.pendingBytes > 0);
  f.retire();
  t.mock.timers.tick(30_000);
  await settle();
  await assert.rejects(f.reader.read(), /instance has been replaced/);
  assert.equal(f.hub.sseClients.size, 0);
});
