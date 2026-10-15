'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { createHub } = require('../../src/hub/server');
const { rendererStats } = require('../../src/electron/statsPublisher');
const { summarizeQoderCnCredits } = require('../../src/shared/providers/qodercn/creditUsage');
const { syncPayload } = require('../../src/shared/syncPayload');

const credits = { days: { '2026-10-15': { qfmodel: { credits: 1.25, requests: 3 } } } };
const record = () => ({
  deviceId: 'cli-mac', today: { totalTokens: 0, costUsd: 0 }, month: {}, allTime: {}, qoderCnCredits: credits,
  clientHealth: { version: 1, clients: { qodercn: {
    source: { detectedCount: 1, checkedCount: 1 }, collection: { state: 'direct' },
    data: { liveTokens: 0, creditRequests: 3 }
  } } }
});

function fakeState() {
  const map = new Map();
  return { storage: {
    async get(key) { return map.get(key); },
    async put(key, value) { map.set(key, JSON.parse(JSON.stringify(value))); },
    async delete(key) { map.delete(key); },
    async list({ prefix } = {}) { return new Map([...map].filter(([key]) => !prefix || key.startsWith(prefix))); }
  } };
}

test('authenticated Node HTTP ingest → persistence → stats → renderer carries independent credits', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-credit-hub-'));
  const options = { host: '127.0.0.1', port: 0, secret: 'test-secret', dataFile: path.join(dir, 'devices.json') };
  let hub = createHub(options);
  t.after(async () => { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const headers = { authorization: 'Bearer test-secret', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/ingest`, { method: 'POST', headers, body: JSON.stringify(syncPayload(record())) })).status, 200);
  const stats = rendererStats(await (await fetch(`${base}/api/stats`, { headers })).json());
  assert.equal(stats.periods.today.totalTokens, 0);
  assert.equal(stats.periods.today.costUsd, 0);
  assert.deepEqual(stats.devices[0].qoderCnCredits, credits);
  assert.equal(summarizeQoderCnCredits(stats.devices).credits, 1.25);
  assert.equal(stats.devices[0].clientHealth.clients.qodercn.overall, 'healthy');
  await hub.stop();
  hub = createHub(options);
  await hub.start();
  assert.equal(summarizeQoderCnCredits(hub.getStats().devices).credits, 1.25);
});

test('Worker preserves credits on authenticated stats/limits updates, strips private extras and keeps public stats token-only', async () => {
  const { HubDO } = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const hub = new HubDO(fakeState(), { TOKEN_MONITOR_SECRET: 'test-secret', PUBLIC_STATS_ENABLED: '1' });
  const request = (route, body) => new Request(`https://hub.example${route}`, {
    headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {})
  });
  const payload = record();
  payload.qoderCnCredits = { ...credits, request_id: 'private', source_path: '/private/project', content: 'private' };
  assert.equal((await hub.fetch(request('/api/ingest', payload))).status, 200);
  assert.equal((await hub.fetch(request('/api/ingest', { deviceId: 'cli-mac', limitsOnly: true, limits: { providers: [] } }))).status, 200);
  const stats = await (await hub.fetch(request('/api/stats'))).json();
  assert.deepEqual(stats.devices[0].qoderCnCredits, credits);
  assert.equal(stats.devices[0].clientHealth.clients.qodercn.overall, 'healthy');
  assert.equal(stats.periods.allTime.totalTokens, 0);
  assert.equal(stats.periods.allTime.costUsd, 0);
  assert.doesNotMatch(JSON.stringify(stats), /private/);
  const publicStats = await (await hub.fetch(new Request('https://hub.example/api/public/stats'))).json();
  assert.doesNotMatch(JSON.stringify(publicStats), /qoderCnCredits|qfmodel|1\.25/);
  assert.equal((await hub.fetch(request('/api/ingest', { ...record(), qoderCnCredits: null }))).status, 200);
  const disabled = await (await hub.fetch(request('/api/stats'))).json();
  assert.equal(disabled.devices[0].qoderCnCredits, null);
});
