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

test('Worker SSE fan-out serializes the stats payload once for every subscriber', async () => {
  const hub = await createHub();
  const initialAt = utcTodayAt('10:00:00.000');
  const changedAt = utcTodayAt('10:03:00.000');
  const base = {
    deviceId: 'dev-a',
    updatedAt: initialAt,
    today: { totalTokens: 1, sessions: { a: { totalTokens: 1, lastUsedAt: initialAt } } }
  };
  await hub.fetch(ingestRequest(base, { 'x-token-monitor-response': 'minimal' }));

  const aborts = [new AbortController(), new AbortController(), new AbortController()];
  const events = [[], [], []];
  const pumps = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await hub.fetch(new Request('https://hub.example/api/stats/stream', {
      headers: { authorization: 'Bearer shh' },
      signal: aborts[index].signal
    }));
    pumps.push(collectSse(response, events[index]));
  }
  const original = JSON.stringify;
  const ingestPayloads = [];
  try {
    await waitFor(() => events.every((list) => list.length === 1));
    for (const list of events) list.length = 0;

    JSON.stringify = (value, replacer, space) => {
      if (value && value.type === 'stats' && value.reason === 'ingest') ingestPayloads.push(value);
      return original(value, replacer, space);
    };
    await hub.fetch(ingestRequest({
      ...base,
      updatedAt: changedAt,
      today: { ...base.today, totalTokens: 4 }
    }, { 'x-token-monitor-response': 'minimal' }));
    await waitFor(() => events.every((list) => list.length === 1));
    assert.equal(ingestPayloads.length, 1);
    assert.equal(events[0][0].data.stats.periods.today.totalTokens, 4);
    assert.equal(events[2][0].data.stats.periods.today.totalTokens, 4);
  } finally {
    JSON.stringify = original;
    for (const abort of aborts) abort.abort();
    await Promise.all(pumps);
  }
});

function spyTypedStringify() {
  const original = JSON.stringify;
  const typed = [];
  JSON.stringify = (value, replacer, space) => {
    if (value && typeof value === 'object' && value.type) {
      typed.push({ type: value.type, reason: value.reason });
    }
    return original(value, replacer, space);
  };
  return {
    typed,
    restore() { JSON.stringify = original; }
  };
}

test('Worker subscribers receive identical frames and delete/subscription writes stay full stats', async () => {
  const hub = await createHub();
  const initialAt = utcTodayAt('10:00:00.000');
  const refreshedAt = utcTodayAt('10:01:00.000');
  const base = {
    deviceId: 'dev-a',
    updatedAt: initialAt,
    today: { totalTokens: 1, sessions: { a: { totalTokens: 1, lastUsedAt: initialAt } } }
  };
  await hub.fetch(ingestRequest(base, { 'x-token-monitor-response': 'minimal' }));

  const modernAAbort = new AbortController();
  const modernBAbort = new AbortController();
  const legacyAbort = new AbortController();
  const modernA = [];
  const modernB = [];
  const legacy = [];
  const modernAResponse = await hub.fetch(new Request('https://hub.example/api/stats/stream', {
    headers: { authorization: 'Bearer shh', 'x-token-monitor-stream': '2' },
    signal: modernAAbort.signal
  }));
  const modernBResponse = await hub.fetch(new Request('https://hub.example/api/stats/stream', {
    headers: { authorization: 'Bearer shh', 'x-token-monitor-stream': '2' },
    signal: modernBAbort.signal
  }));
  const legacyResponse = await hub.fetch(new Request('https://hub.example/api/stats/stream', {
    headers: { authorization: 'Bearer shh' },
    signal: legacyAbort.signal
  }));
  const pumps = [
    collectSse(modernAResponse, modernA),
    collectSse(modernBResponse, modernB),
    collectSse(legacyResponse, legacy)
  ];
  try {
    await waitFor(() => modernA.length === 1 && modernB.length === 1 && legacy.length === 1);
    assert.deepEqual(modernA[0].data.stats.periods, modernB[0].data.stats.periods);
    assert.deepEqual(modernA[0].data.stats.periods, legacy[0].data.stats.periods);
    modernA.length = 0;
    modernB.length = 0;
    legacy.length = 0;

    await hub.fetch(ingestRequest({ ...base, updatedAt: refreshedAt }, {
      'x-token-monitor-response': 'minimal'
    }));
    await waitFor(() => modernA.length === 1 && modernB.length === 1 && legacy.length === 1);
    assert.equal(modernA[0].event, 'freshness');
    assert.equal(modernB[0].event, 'freshness');
    assert.deepEqual(modernA[0].data, modernB[0].data);
    assert.equal(legacy[0].event, 'stats');
    modernA.length = 0;
    modernB.length = 0;
    legacy.length = 0;

    const deleteSpy = spyTypedStringify();
    try {
      const deleted = await hub.fetch(new Request('https://hub.example/api/devices/dev-a', {
        method: 'DELETE',
        headers: { authorization: 'Bearer shh' }
      }));
      assert.equal(deleted.status, 200);
      await waitFor(() => modernA.length === 1 && modernB.length === 1 && legacy.length === 1);
      assert.deepEqual(deleteSpy.typed.filter((entry) => entry.reason === 'delete'), [
        { type: 'stats', reason: 'delete' }
      ]);
    } finally {
      deleteSpy.restore();
    }
    assert.equal(modernA[0].event, 'stats');
    assert.equal(legacy[0].event, 'stats');
    assert.equal(modernA[0].data.reason, 'delete');
    assert.deepEqual(modernA[0].data.stats.devices, []);
    assert.deepEqual(modernA[0].data, modernB[0].data);
    modernA.length = 0;
    modernB.length = 0;
    legacy.length = 0;

    const record = {
      id: 'sub_1', provider: 'codex', planName: 'Plus',
      amountMinor: 9000, currency: 'HKD', startDate: '2026-05-31'
    };
    const subSpy = spyTypedStringify();
    let written;
    try {
      written = await (await hub.fetch(new Request('https://hub.example/api/subscriptions', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: 'Bearer shh' },
        body: JSON.stringify({ subscriptions: [record], baseUpdatedAt: '' })
      }))).json();
      await waitFor(() => modernA.length === 1 && modernB.length === 1 && legacy.length === 1);
      assert.deepEqual(subSpy.typed.filter((entry) => entry.reason === 'subscriptions'), [
        { type: 'stats', reason: 'subscriptions' }
      ]);
    } finally {
      subSpy.restore();
    }
    assert.equal(modernA[0].event, 'stats');
    assert.equal(legacy[0].event, 'stats');
    assert.equal(modernA[0].data.reason, 'subscriptions');
    assert.equal(modernA[0].data.stats.subscriptionsUpdatedAt, written.updatedAt);
    assert.equal('subscriptions' in modernA[0].data.stats, false);
    assert.deepEqual(modernA[0].data, modernB[0].data);
  } finally {
    modernAAbort.abort();
    modernBAbort.abort();
    legacyAbort.abort();
    await Promise.all(pumps);
  }
});
