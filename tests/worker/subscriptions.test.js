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
    },
    map
  };
}

async function hubDO(env = { TOKEN_MONITOR_SECRET: 'shh' }) {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const state = fakeState();
  return { hub: new worker.HubDO(state, env), state };
}

function request(method, body) {
  return new Request('https://hub.example/api/subscriptions', {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer shh' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

const RECORD = {
  id: 'sub_1', provider: 'codex', planName: 'Plus',
  amountMinor: 9000, currency: 'HKD', startDate: '2026-05-31'
};

test('the Worker hub keeps one shared subscription list with the same contract as the Node hub', async () => {
  const { hub, state } = await hubDO();

  const empty = await (await hub.fetch(request('GET'))).json();
  assert.deepEqual(empty.subscriptions, []);
  assert.equal(empty.updatedAt, '');

  const written = await (await hub.fetch(request('PUT', { subscriptions: [RECORD], baseUpdatedAt: '' }))).json();
  assert.equal(written.subscriptions.length, 1);
  assert.notEqual(written.updatedAt, '');
  assert.deepEqual((await (await hub.fetch(request('GET'))).json()).subscriptions, written.subscriptions);

  // The document is one key outside the `dev:` prefix, so listDevices() — and
  // therefore every stats aggregate built from it — never sees it.
  assert.deepEqual([...state.map.keys()], ['subscriptions']);
  assert.deepEqual(await hub.listDevices(), []);

  const stale = await hub.fetch(request('PUT', { subscriptions: [], baseUpdatedAt: '' }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'stale_write');
  assert.equal((await (await hub.fetch(request('GET'))).json()).subscriptions.length, 1);

  const cleared = await (await hub.fetch(request('PUT', { subscriptions: [], baseUpdatedAt: written.updatedAt }))).json();
  assert.deepEqual(cleared.subscriptions, []);
});

test('the Worker refuses subscription reads without the secret and never publishes them', async () => {
  const { hub } = await hubDO();
  const anonymous = await hub.fetch(new Request('https://hub.example/api/subscriptions'));
  assert.equal(anonymous.status, 401);

  // A Worker is internet-facing with no trusted-LAN fallback, so an unset secret
  // refuses the route outright rather than serving it open.
  const { hub: openHub } = await hubDO({ TOKEN_MONITOR_SECRET: '' });
  assert.equal((await openHub.fetch(new Request('https://hub.example/api/subscriptions'))).status, 503);

  // Public stats are built from device records alone; hand-entered money must
  // never reach them even when the shared list is populated.
  const { hub: publicHub } = await hubDO({ TOKEN_MONITOR_SECRET: 'shh', PUBLIC_STATS_ENABLED: 'true' });
  await publicHub.fetch(request('PUT', { subscriptions: [RECORD], baseUpdatedAt: '' }));
  const stats = await (await publicHub.fetch(new Request('https://hub.example/api/public/stats'))).json();
  assert.doesNotMatch(JSON.stringify(stats), /subscription/i);
  assert.doesNotMatch(JSON.stringify(stats), /amountMinor/);
});
