'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

function fakeState() {
  const map = new Map();
  return {
    storage: {
      async get(key) { return map.get(key); },
      async put(key, value) { map.set(key, JSON.parse(JSON.stringify(value))); },
      async delete(key) { map.delete(key); },
      async list({ prefix } = {}) {
        const out = new Map();
        for (const [key, value] of map) {
          if (!prefix || key.startsWith(prefix)) out.set(key, value);
        }
        return out;
      }
    }
  };
}

async function hubDO(env = { TOKEN_MONITOR_SECRET: 'shh' }) {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  return new worker.HubDO(fakeState(), env);
}

function request(url, headers = {}, init = {}) {
  return new Request(url, { headers, ...init });
}

test('Worker health stays open; data routes refuse a missing secret', async () => {
  const hub = await hubDO();
  assert.equal((await hub.fetch(request('https://hub.example/api/health'))).status, 200);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats'))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/devices'))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/history'))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/subscriptions'))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/ingest', {
    'content-type': 'application/json'
  }, { method: 'POST', body: JSON.stringify({ deviceId: 'a' }) }))).status, 401);
});

test('Worker refuses every data route when TOKEN_MONITOR_SECRET is unset', async () => {
  const hub = await hubDO({ TOKEN_MONITOR_SECRET: '' });
  const stats = await hub.fetch(request('https://hub.example/api/stats'));
  assert.equal(stats.status, 503);
  assert.equal((await stats.json()).error, 'secret_required');
  assert.equal((await hub.fetch(request('https://hub.example/api/health'))).status, 200);
});

test('Worker accepts Bearer and x-token-monitor-secret on stats and ingest', async () => {
  const hub = await hubDO();
  const ingest = async (headers) => hub.fetch(request('https://hub.example/api/ingest', {
    'content-type': 'application/json',
    ...headers
  }, { method: 'POST', body: JSON.stringify({ deviceId: 'dev-a', today: { totalTokens: 1 } }) }));

  assert.equal((await hub.fetch(request('https://hub.example/api/stats', {
    authorization: 'Bearer shh'
  }))).status, 200);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats', {
    authorization: 'bearer shh'
  }))).status, 200);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats', {
    authorization: 'Bearer  shh  '
  }))).status, 200);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats', {
    'X-Token-Monitor-Secret': 'shh'
  }))).status, 200);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats', {
    'x-token-monitor-secret': '  shh  '
  }))).status, 200);

  assert.equal((await ingest({ authorization: 'Bearer shh' })).status, 200);
  assert.equal((await ingest({ 'x-token-monitor-secret': 'shh' })).status, 200);
  assert.equal((await ingest({ authorization: 'Bearer nope' })).status, 401);
});

test('Worker keeps query secret as a compatibility path and prefers a header', async () => {
  const hub = await hubDO();

  assert.equal((await hub.fetch(request('https://hub.example/api/stats?secret=shh'))).status, 200);
  assert.equal((await hub.fetch(request('https://hub.example/api/devices?secret=shh'))).status, 200);
  assert.equal((await hub.fetch(request('https://hub.example/api/history?secret=shh'))).status, 200);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats?secret=nope'))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats?secret='))).status, 401);

  const ingest = await hub.fetch(request('https://hub.example/api/ingest?secret=shh', {
    'content-type': 'application/json'
  }, { method: 'POST', body: JSON.stringify({ deviceId: 'dev-q', today: { totalTokens: 2 } }) }));
  assert.equal(ingest.status, 200);

  assert.equal((await hub.fetch(request('https://hub.example/api/stats?secret=shh', {
    authorization: 'Bearer nope'
  }))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats?secret=shh', {
    'x-token-monitor-secret': 'nope'
  }))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/ingest?secret=shh', {
    'content-type': 'application/json',
    authorization: 'Bearer nope'
  }, { method: 'POST', body: JSON.stringify({ deviceId: 'dev-x' }) }))).status, 401);
});

test('Worker rejects a wrong, empty, or length-mismatched header secret', async () => {
  const hub = await hubDO();
  assert.equal((await hub.fetch(request('https://hub.example/api/stats', {
    authorization: 'Bearer nope'
  }))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats', {
    authorization: 'Bearer sh'
  }))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats', {
    authorization: 'Bearer shhh'
  }))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats', {
    authorization: 'Bearer'
  }))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/stats', {
    authorization: 'Basic shh'
  }))).status, 401);
  assert.equal((await hub.fetch(request('https://hub.example/api/devices', {
    'x-token-monitor-secret': 'nope'
  }))).status, 401);
});
