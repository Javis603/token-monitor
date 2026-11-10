'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHub } = require('../../src/hub/server');
const { MAX_UPLOAD_BYTES } = require('../../src/shared/uploadDelta');
const { createSyncPayloadUploader, serializeSyncPayload } = require('../../src/shared/syncPayload');
const { mergeSyncDeviceRecord } = require('../../src/shared/usage');
const { summaryForUpload } = require('../fixtures/syncUpload');

async function backend(kind, t) {
  let send;
  if (kind === 'Node') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-delta-'));
    const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'fixture', syncSessionTitles: true, dataFile: path.join(directory, 'devices.json') });
    await hub.start();
    t.after(async () => { await hub.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
    const local = `http://127.0.0.1:${hub.server.address().port}`;
    send = (url, options) => fetch(url.replace('https://hub.invalid', local), options);
  } else {
    const { HubDO } = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
    const data = new Map();
    const hub = new HubDO({ storage: {
      async get(key) { return structuredClone(data.get(key)); },
      async put(key, value) { data.set(key, structuredClone(value)); },
      async delete(key) { data.delete(key); },
      async list({ prefix } = {}) { return new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix))); }
    } }, { TOKEN_MONITOR_SECRET: 'fixture', TOKEN_MONITOR_SYNC_SESSION_TITLES: '1' });
    send = (url, options) => hub.fetch(new Request(url, options));
  }
  const requests = [];
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-token-monitor-response': 'minimal' };
  const fetchFn = async (url, options) => {
    const response = await send(url, options);
    requests.push({ url, status: response.status, bytes: Buffer.byteLength(options.body || '') });
    return response;
  };
  return {
    requests, headers, fetchFn, send,
    async request(route, body, method = 'POST', extra = {}) {
      return fetchFn(`https://hub.invalid${route}`, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    async device() { return (await (await send('https://hub.invalid/api/devices', { headers })).json()).devices[0]; }
  };
}

for (const kind of ['Node', 'Worker']) {
  test(`${kind} full/delta ingest matches full snapshots including zeroes, deletions and historical corrections`, async t => {
    const hub = await backend(kind, t);
    const upload = createSyncPayloadUploader();
    let expected;
    for (let tick = 0; tick < 4; tick++) {
      const summary = summaryForUpload({ tick });
      if (tick === 2) {
        summary.today.totalTokens = 0;
        delete summary.month.sessions['codex:s1'];
        summary.history.daily[0].tokens = 1;
      }
      const wire = serializeSyncPayload(summary).payload;
      expected = mergeSyncDeviceRecord(expected, wire);
      const result = await upload(hub.fetchFn, 'https://hub.invalid/api/ingest', { summary, headers: hub.headers });
      const ack = await result.response.json();
      assert.equal(ack.upload.version, 1);
      const actual = await hub.device();
      expected.receivedAt = actual.receivedAt;
      assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)));
      assert.equal(hub.requests.at(-1).url.endsWith('/delta'), tick > 0);
      if (tick > 0) assert.ok(hub.requests.at(-1).bytes < Buffer.byteLength(JSON.stringify(wire)) / 2);
    }
  });

  test(`${kind} old-client writes, lost ACKs, device deletion and downgrade recover with one full upload`, async t => {
    const hub = await backend(kind, t);
    const upload = createSyncPayloadUploader();
    const send = (tick, fetchFn = hub.fetchFn) => upload(fetchFn, 'https://hub.invalid/api/ingest', { summary: summaryForUpload({ tick }), headers: hub.headers });
    await send(0);
    await hub.request('/api/ingest', summaryForUpload({ tick: 1 }));
    let offset = hub.requests.length;
    await send(2);
    assert.deepEqual(hub.requests.slice(offset).map(r => r.status), [409, 200]);
    let lost = false;
    await assert.rejects(send(3, async (url, options) => { await hub.fetchFn(url, options); lost = true; throw new Error('ACK lost'); }), /ACK lost/);
    assert.ok(lost);
    offset = hub.requests.length;
    await send(4);
    assert.equal(hub.requests.length - offset, 1);
    assert.equal(hub.requests.at(-1).url.endsWith('/delta'), false);
    await hub.request('/api/devices/bandwidth-fixture', undefined, 'DELETE');
    offset = hub.requests.length;
    await send(5);
    assert.deepEqual(hub.requests.slice(offset).map(r => r.status), [409, 200]);
    let oldFull = 0;
    await send(6, async (url, options) => {
      if (url.endsWith('/delta')) return new Response('{}', { status: 404 });
      oldFull++;
      return Response.json({ ok: true, deviceId: JSON.parse(options.body).deviceId });
    });
    assert.equal(oldFull, 1);
    await send(7, async (url, options) => {
      assert.equal(url.endsWith('/delta'), false);
      return Response.json({ ok: true, deviceId: JSON.parse(options.body).deviceId });
    });
  });

  test(`${kind} title revocation invalidates a baseline and deltas cannot resurrect saved text`, async t => {
    const hub = await backend(kind, t);
    const policy = await (await hub.request('/api/sync/titles/bandwidth-fixture', { enabled: true }, 'PUT')).json();
    const summary = summaryForUpload();
    summary.today.sessions['codex:s0'].title = 'Private title';
    const upload = createSyncPayloadUploader();
    const send = () => upload(hub.fetchFn, 'https://hub.invalid/api/ingest', { summary, headers: hub.headers, syncSessionTitles: true, sessionTitleSyncGeneration: policy.generation });
    await send();
    assert.equal((await hub.device()).periods.today.sessions['codex:s0'].title, 'Private title');
    await hub.request('/api/sync/titles/bandwidth-fixture', { enabled: false }, 'PUT');
    const offset = hub.requests.length;
    await send();
    assert.deepEqual(hub.requests.slice(offset).map(r => r.status), [409, 200]);
    assert.ok(!(await hub.device()).periods.today.sessions['codex:s0'].title);
    await send();
    assert.ok(!(await hub.device()).periods.today.sessions['codex:s0'].title);
  });
}

for (const kind of ['Node', 'Worker']) {
  test(`${kind} rejected patches leave the committed revision usable and cannot change another device`, async t => {
    const hub = await backend(kind, t);
    const response = await hub.request('/api/ingest', summaryForUpload(), 'POST', { 'x-token-monitor-upload': '1' });
    const ack = await response.json();
    const envelope = { deviceId: 'bandwidth-fixture', baseRevision: ack.upload.revision, patch: [{ op: 'replace', path: '/today/totalTokens', value: 1 }] };
    const before = await hub.device();
    const invalid = await hub.request('/api/ingest/delta', { ...envelope, patch: [...envelope.patch, { op: 'remove', path: '/missing/child' }] });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await hub.device(), before);
    assert.equal((await hub.request('/api/ingest/delta', { ...envelope, patch: [{ op: 'replace', path: '/deviceId', value: 'another' }] })).status, 400);
    assert.equal((await hub.request('/api/ingest/delta', envelope)).status, 200);
    assert.equal((await hub.request('/api/ingest/delta', envelope)).status, 409);
    assert.equal((await hub.device()).periods.today.totalTokens, 1);
  });

  test(`${kind} a reduced 413 full retry establishes a baseline which later restores detail through delta`, async t => {
    const hub = await backend(kind, t);
    const upload = createSyncPayloadUploader();
    const summary = summaryForUpload();
    summary.history.daily.at(-1).outputTokens = 123;
    let reject = true;
    const fetchFn = async (url, request) => {
      if (reject) { reject = false; return new Response('{}', { status: 413 }); }
      return hub.fetchFn(url, request);
    };
    const first = await upload(fetchFn, 'https://hub.invalid/api/ingest', { summary, headers: hub.headers });
    assert.ok(first.retried);
    assert.equal((await hub.device()).history.daily.at(-1).outputTokens, undefined);
    await upload(fetchFn, 'https://hub.invalid/api/ingest', { summary, headers: hub.headers });
    assert.equal(hub.requests.at(-1).url.endsWith('/delta'), true);
    assert.equal((await hub.device()).history.daily.at(-1).outputTokens, 123);
  });
}

test('Worker bounds chunked delta input before JSON parsing and cancels an oversized body', async t => {
  const hub = await backend('Worker', t);
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (chunks++ < 3) controller.enqueue(new Uint8Array(Math.floor(MAX_UPLOAD_BYTES / 2) + 1));
      else controller.close();
    },
    cancel() { cancelled = true; }
  });
  const response = await hub.send('https://hub.invalid/api/ingest/delta', {
    method: 'POST', headers: hub.headers, body, duplex: 'half'
  });
  assert.equal(response.status, 413, 'unparseable oversized input is rejected before JSON.parse');
  assert.equal(cancelled, true);
  assert.equal(await hub.device(), undefined);

  const first = await hub.request('/api/ingest', summaryForUpload(), 'POST', { 'x-token-monitor-upload': '1' });
  const { upload } = await first.json();
  const encoded = new TextEncoder().encode(JSON.stringify({ deviceId: 'bandwidth-fixture', baseRevision: upload.revision, patch: [] }));
  const valid = new ReadableStream({ start(controller) {
    controller.enqueue(encoded.slice(0, 17)); controller.enqueue(encoded.slice(17)); controller.close();
  } });
  const accepted = await hub.send('https://hub.invalid/api/ingest/delta', { method: 'POST', headers: hub.headers, body: valid, duplex: 'half' });
  assert.equal(accepted.status, 200);
});

test('Worker bounds chunked full ingest before JSON parsing and cancels an oversized body', async t => {
  const hub = await backend('Worker', t);
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (chunks++ < 3) controller.enqueue(new Uint8Array(Math.floor(MAX_UPLOAD_BYTES / 2) + 1));
      else controller.close();
    },
    cancel() { cancelled = true; }
  });
  const response = await hub.send('https://hub.invalid/api/ingest', {
    method: 'POST', headers: hub.headers, body, duplex: 'half'
  });
  assert.equal(response.status, 413, 'unparseable oversized input is rejected before JSON.parse');
  assert.equal(cancelled, true);
  assert.equal(await hub.device(), undefined);

  const encoded = new TextEncoder().encode(JSON.stringify(summaryForUpload()));
  const valid = new ReadableStream({ start(controller) {
    controller.enqueue(encoded.slice(0, 17)); controller.enqueue(encoded.slice(17)); controller.close();
  } });
  const accepted = await hub.send('https://hub.invalid/api/ingest', {
    method: 'POST', headers: { ...hub.headers, 'x-token-monitor-upload': '1' }, body: valid, duplex: 'half'
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).upload.version, 1);
  assert.equal((await hub.device()).history.daily.length, 151);
});

test('Worker full ingest accepts a body at the UTF-8 ceiling and rejects one extra byte without invalidating its baseline', async t => {
  const hub = await backend('Worker', t);
  const limit = MAX_UPLOAD_BYTES;
  const payload = { ...summaryForUpload(), padding: '' };
  const paddingBytes = limit - Buffer.byteLength(JSON.stringify(payload));
  payload.padding = '字'.repeat(Math.floor(paddingBytes / 3)) + 'x'.repeat(paddingBytes % 3);
  const body = JSON.stringify(payload);
  assert.equal(Buffer.byteLength(body), limit);
  const send = value => hub.send('https://hub.invalid/api/ingest', {
    method: 'POST', headers: { ...hub.headers, 'x-token-monitor-upload': '1' }, body: value
  });
  const first = await send(body);
  assert.equal(first.status, 200);
  const { upload } = await first.json();
  const before = await hub.device();
  const rejected = await send(`${body} `);
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json()).error, 'payload_too_large');
  assert.deepEqual(await hub.device(), before);
  const delta = await hub.request('/api/ingest/delta', {
    deviceId: payload.deviceId, baseRevision: upload.revision, patch: []
  });
  assert.equal(delta.status, 200);
});
