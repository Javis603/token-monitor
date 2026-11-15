'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSyncPayloadUploader, serializeSyncPayload } = require('../../src/shared/syncPayload');
const { mergeSyncDeviceRecord } = require('../../src/shared/usage');
const { summaryForUpload } = require('../fixtures/syncUpload');

function harness() {
  let time = 0;
  let failure = null;
  const requests = [];
  const upload = createSyncPayloadUploader({ now: () => time });
  const fetchFn = async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    if (failure instanceof Error) throw failure;
    if (failure) return new Response('{}', { status: failure });
    return Response.json({ ok: true, deviceId: body.deviceId });
  };
  return {
    requests, upload,
    time: value => { time = value; }, fail: value => { failure = value; },
    send: (summary = summaryForUpload(), url = 'https://hub.invalid/api/ingest', headers = {}) => upload(fetchFn, url, { summary, headers })
  };
}

test('unchanged History is omitted while live periods stay current and both Hub cores retain identical data', async () => {
  const fixture = harness();
  const nodeMerge = mergeSyncDeviceRecord;
  const workerMerge = require('../../worker/src/shared/usage').mergeSyncDeviceRecord;
  let beforeNode, afterNode, beforeWorker, afterWorker;
  for (let tick = 0; tick < 4; tick++) {
    const summary = summaryForUpload({ tick });
    const baseline = serializeSyncPayload(summary).payload;
    const result = await fixture.send(summary);
    beforeNode = nodeMerge(beforeNode, baseline);
    afterNode = nodeMerge(afterNode, result.payload);
    beforeWorker = workerMerge(beforeWorker, baseline);
    afterWorker = workerMerge(afterWorker, result.payload);
    // Normalization fills wall-clock fields; pin them before comparing.
    for (const record of [beforeNode, afterNode, beforeWorker, afterWorker]) record.receivedAt = '2026-11-05T00:00:00Z';
    assert.deepEqual(afterNode, beforeNode);
    assert.deepEqual(afterWorker, beforeWorker);
    assert.equal(Object.hasOwn(result.payload, 'history'), tick === 0);
    assert.equal(result.payload.today.totalTokens, 200000 + tick);
    assert.equal((await result.response.json()).ok, true, 'caller can still read ACK');
  }
});

test('changed historical dates and explicit clears are sent immediately without mutating the input', async () => {
  const fixture = harness();
  await fixture.send();
  const summary = summaryForUpload();
  summary.history.daily[0].tokens -= 100;
  const copy = structuredClone(summary);
  assert.ok((await fixture.send(summary)).payload.history);
  assert.deepEqual(summary, copy);
  assert.equal((await fixture.send({ ...summary, history: null })).payload.history, null);
  assert.equal(Object.hasOwn((await fixture.send({ ...summary, history: null })).payload, 'history'), false);
});

test('reconciliation is measured from last full ACK, not extended by successful omissions', async () => {
  const fixture = harness();
  await fixture.send();
  fixture.time(14 * 60 * 1000);
  assert.equal(Object.hasOwn((await fixture.send()).payload, 'history'), false);
  fixture.time(15 * 60 * 1000);
  assert.ok((await fixture.send()).payload.history);
  fixture.time(1);
  assert.ok((await fixture.send()).payload.history, 'clock rollback forces a full resend');
});

test('destination, credentials, device and reconnect changes require a full History', async () => {
  const fixture = harness();
  await fixture.send();
  assert.ok((await fixture.send(undefined, 'https://other.invalid/api/ingest')).payload.history);
  assert.ok((await fixture.send(undefined, undefined, { Authorization: 'Bearer changed' })).payload.history);
  assert.ok((await fixture.send({ ...summaryForUpload(), deviceId: 'new-device' })).payload.history);
  fixture.upload.resetHistory();
  assert.ok((await fixture.send({ ...summaryForUpload(), deviceId: 'new-device' })).payload.history);
});

test('HTTP errors, network errors and invalid ACKs cannot establish or retain an omission baseline', async () => {
  const fixture = harness();
  for (const failure of [500, new Error('offline')]) {
    await fixture.send();
    fixture.fail(failure);
    await fixture.send().catch(() => {});
    fixture.fail(null);
    assert.ok((await fixture.send()).payload.history);
  }
  for (const ack of [{ ok: false }, { ok: true, deviceId: 'wrong-device' }, null]) {
    const upload = createSyncPayloadUploader();
    const bodies = [];
    const fetchFn = async (_url, options) => { bodies.push(JSON.parse(options.body)); return Response.json(ack); };
    await upload(fetchFn, 'https://hub.invalid', { summary: summaryForUpload() });
    await upload(fetchFn, 'https://hub.invalid', { summary: summaryForUpload() });
    assert.ok(bodies.every(body => Object.hasOwn(body, 'history')));
  }
});

test('a reset during an in-flight full upload fences its late ACK', async () => {
  const fixture = harness();
  let release;
  const pending = fixture.upload(() => new Promise(resolve => { release = resolve; }), 'https://hub.invalid/api/ingest', { summary: summaryForUpload() });
  fixture.upload.resetHistory();
  release(Response.json({ ok: true, deviceId: 'bandwidth-fixture' }));
  await pending;
  assert.ok((await fixture.send()).payload.history);
});

test('413 reduction acknowledges only accepted history detail, permitting later restoration', async () => {
  const upload = createSyncPayloadUploader();
  const summary = summaryForUpload();
  summary.history.daily.at(-1).outputTokens = 123;
  const bodies = [];
  const fetchFn = async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    return bodies.length === 1 ? new Response('{}', { status: 413 }) : Response.json({ ok: true, deviceId: summary.deviceId });
  };
  const reduced = await upload(fetchFn, 'https://hub.invalid', { summary });
  assert.equal(reduced.retried, true);
  assert.equal(reduced.payload.history.daily.at(-1).outputTokens, undefined);
  const restored = await upload(fetchFn, 'https://hub.invalid', { summary });
  assert.equal(restored.payload.history.daily.at(-1).outputTokens, 123);
});

test('negotiated delta baselines never cross destination, device or either credential header', async () => {
  const upload = createSyncPayloadUploader();
  const bodies = [];
  const fetchFn = async (url, request) => {
    const body = JSON.parse(request.body);
    bodies.push({ url, body });
    return Response.json({ ok: true, deviceId: body.deviceId,
      upload: { version: 1, revision: `revision-${bodies.length}` } });
  };
  let url = 'https://first.invalid/api/ingest';
  let summary = summaryForUpload();
  let headers = { Authorization: 'Bearer first', 'X-Token-Monitor-Secret': 'first' };
  const send = () => upload(fetchFn, url, { summary, headers });
  await send();
  await send();
  assert.equal(bodies.at(-1).url.endsWith('/delta'), true);
  for (const change of [
    () => { headers = { ...headers, Authorization: 'Bearer rotated' }; },
    () => { headers = { ...headers, 'X-Token-Monitor-Secret': 'rotated' }; },
    () => { url = 'https://second.invalid/api/ingest'; },
    () => { summary = { ...summary, deviceId: 'second-device' }; }
  ]) {
    change();
    await send();
    assert.equal(bodies.at(-1).url.endsWith('/delta'), false);
    assert.ok(bodies.at(-1).body.history);
    await send();
    assert.equal(bodies.at(-1).url.endsWith('/delta'), true);
  }
});

test('SSE retries preserve a negotiated upload baseline but reconcile legacy History', async () => {
  const upload = createSyncPayloadUploader();
  const urls = [];
  const fetchFn = async (url, request) => {
    urls.push(url);
    const { deviceId } = JSON.parse(request.body);
    return Response.json({ ok: true, deviceId, upload: { version: 1, revision: `revision-${urls.length}` } });
  };
  const send = () => upload(fetchFn, 'https://hub.invalid/api/ingest', { summary: summaryForUpload() });
  await send();
  upload.resetHistory({ preserveDelta: true });
  await send();
  assert.equal(urls.at(-1).endsWith('/delta'), true);
  upload.resetHistory();
  await send();
  assert.equal(urls.at(-1).endsWith('/delta'), false);

  const legacy = harness();
  await legacy.send();
  assert.equal(Object.hasOwn((await legacy.send()).payload, 'history'), false);
  legacy.upload.resetHistory({ preserveDelta: true });
  assert.ok((await legacy.send()).payload.history);
});
