'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const zlib = require('node:zlib');

function fakeState() {
  const map = new Map();
  return {
    storage: {
      async get(key) { return map.get(key); },
      async put(key, value) { map.set(key, JSON.parse(JSON.stringify(value))); },
      async delete(key) { map.delete(key); },
      async list({ prefix } = {}) {
        return new Map([...map].filter(([key]) => !prefix || key.startsWith(prefix)));
      }
    }
  };
}

async function createHub() {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  return new worker.HubDO(fakeState(), { TOKEN_MONITOR_SECRET: 'shh', STALE_AFTER_MS: '600000' });
}

function ingestRequest(payload, extraHeaders = {}) {
  return new Request('https://hub.example/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer shh', ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for Worker SSE event'));
      setTimeout(check, 10);
    };
    check();
  });
}

function utcTodayAt(time) {
  return `${new Date().toISOString().slice(0, 10)}T${time}Z`;
}

function collectSse(response, events) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  return (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.startsWith(':')) continue;
        const event = frame.match(/^event:\s*(.+)$/m)?.[1];
        const data = frame.match(/^data:\s*(.+)$/m)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })();
}

test('the Worker negotiates compact ingest acknowledgements and gzip JSON', async () => {
  const hub = await createHub();
  const sampleAt = utcTodayAt('10:00:00.000');
  const sessions = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
    `session-${index}`,
    { totalTokens: index + 1, costUsd: 0.01, model: 'gpt-test', lastUsedAt: sampleAt }
  ]));
  const payload = { deviceId: 'dev-a', updatedAt: sampleAt, today: { totalTokens: 3240, sessions } };

  const minimal = await hub.fetch(ingestRequest(payload, { 'x-token-monitor-response': 'minimal' }));
  assert.deepEqual(await minimal.json(), { ok: true, deviceId: 'dev-a' });

  const compressed = await hub.fetch(ingestRequest(payload, { 'accept-encoding': 'gzip' }));
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  const body = JSON.parse(zlib.gunzipSync(Buffer.from(await compressed.arrayBuffer())).toString('utf8'));
  assert.equal(body.ok, true);
  assert.equal(body.stats.devices[0].deviceId, 'dev-a');
});

test('the Worker stream matches the Node Hub freshness and coalescing behavior', async () => {
  const hub = await createHub();
  const initialAt = utcTodayAt('10:00:00.000');
  const refreshedAt = utcTodayAt('10:01:00.000');
  const changedAt = utcTodayAt('10:02:00.000');
  const base = {
    deviceId: 'dev-a',
    updatedAt: initialAt,
    today: { totalTokens: 1, sessions: { a: { totalTokens: 1, lastUsedAt: initialAt } } }
  };
  await hub.fetch(ingestRequest(base, { 'x-token-monitor-response': 'minimal' }));

  const modernAbort = new AbortController();
  const legacyAbort = new AbortController();
  const modernResponse = await hub.fetch(new Request('https://hub.example/api/stats/stream', {
    headers: { authorization: 'Bearer shh', 'x-token-monitor-stream': '2' },
    signal: modernAbort.signal
  }));
  const legacyResponse = await hub.fetch(new Request('https://hub.example/api/stats/stream', {
    headers: { authorization: 'Bearer shh' },
    signal: legacyAbort.signal
  }));
  const modern = [];
  const legacy = [];
  const modernPump = collectSse(modernResponse, modern);
  const legacyPump = collectSse(legacyResponse, legacy);
  try {
    await waitFor(() => modern.length === 1 && legacy.length === 1);
    assert.equal(modern[0].event, 'snapshot');
    assert.equal(legacy[0].event, 'snapshot');
    modern.length = 0;
    legacy.length = 0;

    await hub.fetch(ingestRequest({ ...base, updatedAt: refreshedAt }, {
      'x-token-monitor-response': 'minimal'
    }));
    await waitFor(() => modern.length === 1 && legacy.length === 1);
    assert.equal(modern[0].event, 'freshness');
    assert.equal(modern[0].data.stats.devices[0].updatedAt, refreshedAt);
    assert.equal(legacy[0].event, 'stats');
    assert.equal(legacy[0].data.stats.devices[0].updatedAt, refreshedAt);
    modern.length = 0;
    legacy.length = 0;

    await hub.fetch(ingestRequest({
      ...base,
      updatedAt: changedAt,
      today: { ...base.today, totalTokens: 2 }
    }, { 'x-token-monitor-response': 'minimal' }));
    await waitFor(() => modern.length === 1 && legacy.length === 1);
    assert.equal(modern[0].event, 'stats');
    assert.equal(legacy[0].event, 'stats');
    assert.equal(modern[0].data.stats.periods.today.totalTokens, 2);
    modern.length = 0;
    legacy.length = 0;

    for (let totalTokens = 3; totalTokens <= 12; totalTokens += 1) {
      await hub.fetch(ingestRequest({
        ...base,
        updatedAt: utcTodayAt(`10:02:${String(totalTokens).padStart(2, '0')}.000`),
        today: { ...base.today, totalTokens }
      }, { 'x-token-monitor-response': 'minimal' }));
    }
    await waitFor(() => modern.length === 1 && legacy.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(modern.length, 1);
    assert.equal(legacy.length, 1);
    assert.equal(modern[0].data.stats.periods.today.totalTokens, 12);
  } finally {
    modernAbort.abort();
    legacyAbort.abort();
    await Promise.all([modernPump, legacyPump]);
  }
});
