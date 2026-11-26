'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHub } = require('../../src/hub/server');
const { encodeFixedRangeSnapshot, decodeFixedRangePeriod } = require('../../src/shared/fixedRangeSync');
const { fetchFixedRange, fixedRangeRequestBodies, uploadFixedRanges } = require('../../src/shared/fixedRangeClient');
const { createSyncPayloadUploader } = require('../../src/shared/syncPayload');
const { mergePeriods, mergeSyncDeviceRecord } = require('../../src/shared/usage');

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
}

async function backend(kind, t, titlesEnabled = false) {
  if (kind === 'Worker') {
    const { HubDO } = await import(pathToFileURL(join(__dirname, '../../worker/src/index.js')).href);
    const values = new Map();
    const hub = new HubDO({ storage: {
      async get(key) { return structuredClone(values.get(key)); },
      async put(key, value) { values.set(key, structuredClone(value)); },
      async delete(key) { values.delete(key); },
      async list({ prefix } = {}) {
        return new Map([...values].filter(([key]) => !prefix || key.startsWith(prefix)));
      }
    } }, { TOKEN_MONITOR_SECRET: 'fixture', TOKEN_MONITOR_SYNC_SESSION_TITLES: titlesEnabled ? '1' : '0', PUBLIC_STATS_ENABLED: '1' });
    return { base: 'https://hub.invalid', send: (url, options) => hub.fetch(new Request(url, options)) };
  }
  const directory = await mkdtemp(join(tmpdir(), 'tm-fixed-range-uploads-'));
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'fixture', syncSessionTitles: titlesEnabled, dataFile: join(directory, 'hub.json') });
  await hub.start();
  t.after(async () => {
    await hub.stop();
    await rm(directory, { recursive: true });
  });
  return { base: `http://127.0.0.1:${hub.server.address().port}`, send: fetch };
}

for (const kind of ['Node', 'Worker']) test(`${kind} publishes complete range pages for two devices`, async (t) => {
  const { base, send } = await backend(kind, t);
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-token-monitor-fixed-ranges': '1' };
  const observedAt = '2026-11-25T01:00:00.000Z';
  const today = { key: '2026-11-25', endsAt: '2026-11-26T00:00:00.000Z' };
  const receivedPeriods = [];
  for (const [deviceId, multiplier] of [['mac', 1], ['pc', 2]]) {
    const totalTokens = 30 * multiplier;
    const record = { deviceId, updatedAt: observedAt, periodWindows: { today, timeZone: 'UTC' },
      today: { totalTokens }, month: { totalTokens }, allTime: { totalTokens } };
    const ingest = await send(base + '/api/ingest', { method: 'POST', headers, body: JSON.stringify(record) });
    assert.equal(ingest.status, 200);
    assert.equal((await ingest.json()).fixedRanges, 1);
    const sessions = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`claude:s${i}`, {
      client: 'claude', sessionId: `s${i}`, totalTokens: 10 * multiplier,
      title: 'private title', projectLabel: 'Project'
    }]));
    const rangeRecord = {
      ...record,
      nativeRanges: { last7: { totalTokens, clients: { claude: totalTokens },
        models: { first: totalTokens - 1, second: 1 }, sessions } },
      nativeRangeWindows: { last7: { start: '2026-11-19', end: '2026-11-25' } }
    };
    const { ranges, pages } = encodeFixedRangeSnapshot(rangeRecord, { maxPageBytes: 1000, preserveSessionTitles: true });
    assert.ok(pages.length >= 2);
    const endpoint = `${base}/api/fixed-ranges?deviceId=${deviceId}`;
    const revision = `00000000-0000-0000-0000-00000000000${multiplier}`;
    const put = payload => send(endpoint, { method: 'PUT', headers, body: JSON.stringify(payload) });
    for (const [page, rows] of pages.entries()) {
      const payload = { revision, observedAt, page, rows, ...(page === 0 ? { ranges, totalPages: pages.length } : {}) };
      const response = await put(payload);
      assert.equal(response.status, 200);
      const { complete } = await response.json();
      assert.equal(complete, page === pages.length - 1);
      if (!complete) assert.equal((await send(endpoint, { headers })).status, 404);
      if (page === 0 && !complete) {
        assert.deepEqual(await (await put(reverseObjectKeys(payload))).json(), { complete: false });
        const conflicting = structuredClone(payload);
        conflicting.rows[0][3].totalTokens += 1;
        assert.equal((await put(conflicting)).status, 409);
      }
    }
    assert.equal((await send(endpoint)).status, 401);
    assert.equal((await send(endpoint + '&page=0&revision=wrong', { headers })).status, 409);
    const index = await (await send(endpoint, { headers })).json();
    const replay = {
      revision, observedAt, page: 0, rows: pages[0], ranges, totalPages: pages.length
    };
    assert.deepEqual(await (await put(reverseObjectKeys(replay))).json(), { complete: true });
    const conflicting = structuredClone(replay);
    conflicting.ranges.last7.totals.totalTokens += 1;
    assert.equal((await put(conflicting)).status, 409);
    const changedRows = structuredClone(pages[0]);
    changedRows[0][3].totalTokens += 1;
    assert.equal((await put({ ...replay, rows: changedRows })).status, 409);
    const received = await Promise.all(pages.map(async (_, page) => {
      return (await (await send(endpoint + `&page=${page}&revision=${index.revision}`, { headers })).json()).rows;
    }));
    const period = decodeFixedRangePeriod(index.ranges, received, 'last7');
    assert.equal(period.totalTokens, totalTokens);
    assert.equal(Object.keys(period.sessions).length, 3);
    assert.equal(period.sessions['claude:s0'].title, '');
    assert.equal(Object.values(period.projects)[0].tokens, totalTokens);
    const upload = createSyncPayloadUploader();
    const requests = [];
    const traced = (url, options) => {
      requests.push([new URL(url).pathname, options.method]);
      return send(url, options);
    };
    assert.equal((await upload(traced, base + '/api/ingest', { headers, summary: rangeRecord })).response.ok, true);
    assert.ok(requests.some(([pathname, method]) => pathname === '/api/fixed-ranges' && method === 'PUT'));
    requests.length = 0;
    const repeated = await upload(traced, base + '/api/ingest', { headers, summary: rangeRecord });
    assert.equal(repeated.response.status, 200);
    const ack = await repeated.response.json();
    assert.equal(ack.fixedRanges, 1);
    assert.equal(requests.some(([pathname]) => pathname === '/api/fixed-ranges'), false);
    const replacement = await (await send(endpoint, { headers })).json();
    assert.notEqual(replacement.revision, revision);
    assert.equal(ack.fixedRangeRevision, replacement.revision);
    assert.equal((await put(conflicting)).status, 409, 'a superseded upload may not publish under its old revision');
    assert.equal((await (await send(endpoint, { headers })).json()).revision, replacement.revision);
    const loaded = await fetchFixedRange(send, base, deviceId, 'last7', rangeRecord.nativeRangeWindows.last7, headers);
    assert.deepEqual(loaded, period);
    receivedPeriods.push(loaded);
    assert.equal(await fetchFixedRange(send, base, deviceId, 'last7', { start: '2026-11-18', end: '2026-11-24' }, headers, replacement.revision), null);

    const limited = await send(base + '/api/ingest', {
      method: 'POST', headers,
      body: JSON.stringify({ deviceId, limitsOnly: true, updatedAt: '2026-11-25T01:15:00.000Z' })
    });
    assert.equal(limited.status, 200);
    assert.equal((await limited.json()).fixedRangeRevision, replacement.revision);
    assert.equal((await send(endpoint, { headers })).status, 200);

    const { ranges: empty } = encodeFixedRangeSnapshot({
      ...rangeRecord, nativeRanges: { last7: { totalTokens } }
    }, { maxPageBytes: 1000 });
    const zeroPages = {
      revision: '00000000-0000-0000-0000-000000000003', observedAt,
      page: 0, ranges: empty, totalPages: 0, rows: []
    };
    assert.equal((await put({ ...zeroPages, rows: pages[0] })).status, 400);
    assert.deepEqual(await (await put(zeroPages)).json(), { complete: true });
    assert.deepEqual(await (await put(zeroPages)).json(), { complete: true });

    const pushUsage = updatedAt => send(base + '/api/ingest', {
      method: 'POST', headers: { authorization: headers.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ ...record, updatedAt })
    });
    assert.equal((await pushUsage('2026-11-25T02:00:00.000Z')).status, 200);
    assert.equal((await pushUsage(observedAt)).status, 200);
    assert.equal((await send(endpoint, { headers })).status, 404);
    const stats = await (await send(base + '/api/stats', { headers })).json();
    assert.equal(Object.hasOwn(stats.fixedRangeRevisions, deviceId), false);
    const devices = await (await send(base + '/api/devices', { headers })).json();
    assert.equal(Object.hasOwn(devices.devices.find(row => row.deviceId === deviceId), 'fixedRangeObservedAt'), false);
    assert.equal((await put(zeroPages)).status, 409);
  }
  assert.equal(mergePeriods(...receivedPeriods).totalTokens, 90);
});

for (const kind of ['Node', 'Worker']) test(`${kind} revokes titles in range pages and in the capability map`, async (t) => {
  const { base, send } = await backend(kind, t, true);
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
  const deviceId = 'private-device';
  const day = '2026-11-25';
  const window = { start: '2026-11-24', end: '2026-11-24' };
  const summary = {
    deviceId, updatedAt: day + 'T01:00:00.000Z',
    periodWindows: { today: { key: day, endsAt: '2026-11-26T00:00:00.000Z' }, timeZone: 'UTC' },
    today: { totalTokens: 10 },
    nativeRangeWindows: { yesterday: window },
    nativeRanges: { yesterday: { totalTokens: 10, sessions: { 'claude:a': {
      client: 'claude', sessionId: 'a', totalTokens: 10, title: 'allowed title', preview: 'local preview'
    } } } }
  };
  const endpoint = base + '/api/sync/titles/' + deviceId;
  const setTitles = (enabled) => send(endpoint, { method: 'PUT', headers, body: JSON.stringify({ enabled }) });
  const { generation } = await (await setTitles(true)).json();
  const options = { syncSessionTitles: true, sessionTitleSyncGeneration: generation };
  const upload = createSyncPayloadUploader();
  await upload(send, base + '/api/ingest', { ...options, headers, summary });
  const revisions = (await (await send(base + '/api/stats', { headers })).json()).fixedRangeRevisions;
  assert.ok(revisions[deviceId]);
  const readUrl = base + '/api/fixed-ranges?deviceId=' + deviceId;
  const admittedIndex = await (await send(readUrl, { headers })).json();
  const admittedPage = await (await send(readUrl + '&page=0&revision=' + admittedIndex.revision, { headers })).json();
  const initial = await fetchFixedRange(send, base, deviceId, 'yesterday', window, headers, revisions[deviceId]);
  assert.equal(initial.sessions['claude:a'].title, 'allowed title');
  assert.equal(initial.sessions['claude:a'].preview, undefined);
  assert.equal((await setTitles(false)).ok, true);
  assert.equal(await fetchFixedRange(send, base, deviceId, 'yesterday', window, headers, revisions[deviceId]), null);
  assert.deepEqual((await (await send(base + '/api/stats', { headers })).json()).fixedRangeRevisions, {});
  const staleUpload = {
    revision: admittedIndex.revision, observedAt: summary.updatedAt,
    ranges: admittedIndex.ranges, totalPages: 1, page: 0, rows: admittedPage.rows,
    sessionTitleSyncGeneration: generation
  };
  assert.equal((await send(readUrl, { method: 'PUT', headers, body: JSON.stringify(staleUpload) })).status, 409);
  assert.equal(await uploadFixedRanges(send, base, summary, headers, options), true);
  const replacement = await fetchFixedRange(send, base, deviceId, 'yesterday', window, headers);
  assert.equal(replacement.sessions['claude:a'].title, '');
  if (kind === 'Worker') {
    const response = await send(base + '/api/public/stats');
    assert.equal(response.status, 200);
    const publicStats = await response.json();
    assert.equal(Object.hasOwn(publicStats, 'fixedRangeRevisions'), false);
  }
});

test('Worker keeps its device budget unchanged when it stores a delayed observation watermark', async (t) => {
  const { base, send } = await backend('Worker', t);
  const headers = {
    authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-token-monitor-response': 'minimal'
  };
  const upload = record => send(base + '/api/ingest', { method: 'POST', headers, body: JSON.stringify(record) });
  const deviceId = 'storage-budget';
  const earlier = '2026-11-25T01:00:00.000Z';
  const later = '2026-11-25T02:00:00.000Z';
  const previous = { deviceId, updatedAt: later };
  const sessions = Object.fromEntries(Array.from({ length: 16500 }, (_, i) => [`codex:s${i}`, {
    client: 'codex', sessionId: `s${i}`, totalTokens: 1
  }]));
  const delayed = {
    deviceId, updatedAt: earlier, hostname: 'fixture', projectsEnabled: false,
    today: { totalTokens: 16500, sessions }
  };
  const bytes = () => Buffer.byteLength(`dev:${deviceId}`)
    + Buffer.byteLength(JSON.stringify(mergeSyncDeviceRecord(previous, { ...delayed, receivedAt: later })));
  const budget = 7 * 1024 * 1024;
  delayed.hostname += 'a'.repeat(budget - bytes());
  assert.equal(bytes(), budget);
  assert.ok(Buffer.byteLength(JSON.stringify(delayed)) < 2 * 1024 * 1024);
  assert.equal((await upload(previous)).status, 200);
  assert.equal((await upload(delayed)).status, 200);
  assert.equal((await upload({ ...delayed, hostname: delayed.hostname + 'a' })).status, 413);
});

for (const kind of ['Node', 'Worker']) test(`${kind} cannot publish project rows staged before Projects was disabled`, async (t) => {
  const { base, send } = await backend(kind, t);
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
  const record = {
    deviceId: 'projects-setting', updatedAt: '2026-11-25T01:00:00.000Z',
    periodWindows: { today: { key: '2026-11-25', endsAt: '2026-11-26T00:00:00.000Z' }, timeZone: 'UTC' },
    today: { totalTokens: 10 }
  };
  const ingest = fields => send(base + '/api/ingest', { method: 'POST', headers, body: JSON.stringify({ ...record, ...fields }) });
  assert.equal((await ingest({})).status, 200);

  const rangeRecord = {
    ...record, nativeRangeWindows: { yesterday: { start: '2026-11-24', end: '2026-11-24' } },
    nativeRanges: { yesterday: { totalTokens: 10, sessions: { 'claude:a': {
      client: 'claude', sessionId: 'a', totalTokens: 10, projectLabel: 'Project'
    } } } }
  };
  const { ranges, pages } = encodeFixedRangeSnapshot(rangeRecord, { maxPageBytes: 4096 });
  const endpoint = base + '/api/fixed-ranges?deviceId=projects-setting';
  const common = { revision: '00000000-0000-0000-0000-000000000001', observedAt: record.updatedAt };
  const put = (page, rows, fields = {}) => send(endpoint, {
    method: 'PUT', headers, body: JSON.stringify({ ...common, page, rows, ...fields })
  });
  const rows = pages.flat();
  ranges.yesterday.pageCount = 2;

  assert.equal(rows.filter(row => row[1] === 'projects').length, 1);
  const staged = await put(0, rows.filter(row => row[1] === 'projects'), { ranges, totalPages: 2 });
  assert.equal(staged.status, 200);
  assert.deepEqual(await staged.json(), { complete: false });

  assert.equal((await ingest({ projectsEnabled: false })).status, 200);
  assert.equal((await ingest({ projectsEnabled: true })).status, 200);
  assert.equal((await put(1, rows.filter(row => row[1] === 'sessions'))).status, 409);
  assert.equal((await send(endpoint, { headers })).status, 404);
  assert.equal(await uploadFixedRanges(send, base, rangeRecord, headers), true);
  assert.equal((await send(endpoint, { headers })).status, 200);
  assert.equal((await ingest({ projectsEnabled: false })).status, 200);
  assert.equal((await send(endpoint, { headers })).status, 404);
  const stats = await (await send(base + '/api/stats', { headers })).json();
  assert.equal(Object.hasOwn(stats.fixedRangeRevisions, record.deviceId), false);
  assert.equal(await uploadFixedRanges(send, base, { ...rangeRecord, projectsEnabled: false }, headers), true);
});

for (const kind of ['Node', 'Worker']) test(`${kind} discards staged fixed ranges when the device day changes at the same usage timestamp`, async (t) => {
  const { base, send } = await backend(kind, t);
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-token-monitor-fixed-ranges': '1' };
  const deviceId = 'day-change';
  const observedAt = '2026-11-25T23:30:00.000Z';
  const record = {
    deviceId, updatedAt: observedAt, today: { totalTokens: 10 },
    periodWindows: { today: { key: '2026-11-25', endsAt: '2026-11-26T00:00:00.000Z' }, timeZone: 'UTC' },
    nativeRangeWindows: { yesterday: { start: '2026-11-24', end: '2026-11-24' } },
    nativeRanges: { yesterday: { totalTokens: 10, sessions: { 'claude:a': {
      client: 'claude', sessionId: 'a', totalTokens: 10, projectLabel: 'Project'
    } } } }
  };
  const ingest = summary => send(base + '/api/ingest', { method: 'POST', headers, body: JSON.stringify(summary) });
  assert.equal((await ingest(record)).status, 200);
  const { ranges, pages } = encodeFixedRangeSnapshot(record, { maxPageBytes: 4096 });
  const endpoint = base + '/api/fixed-ranges?deviceId=day-change';
  const put = payload => send(endpoint, { method: 'PUT', headers, body: JSON.stringify({
    observedAt, revision: '00000000-0000-0000-0000-000000000001', ...payload
  }) });
  const rows = pages.flat();
  ranges.yesterday.pageCount = 2;
  const staged = await put({ page: 0, rows: rows.slice(0, 1), ranges, totalPages: 2 });
  assert.equal(staged.status, 200);
  assert.deepEqual(await staged.json(), { complete: false });

  const shifted = { ...record,
    periodWindows: { today: { key: '2026-11-26', endsAt: '2026-11-26T23:00:00.000Z' }, timeZone: 'Europe/Paris' },
    nativeRangeWindows: { yesterday: { start: '2026-11-25', end: '2026-11-25' } }
  };
  const moved = await ingest(shifted);
  assert.equal(moved.status, 200);
  assert.equal((await put({ page: 1, rows: rows.slice(1) })).status, 409);
  const repeated = await ingest(shifted);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).fixedRangeRevision, null);
  assert.equal(await uploadFixedRanges(send, base, shifted, headers), true);
  assert.equal((await fetchFixedRange(send, base, deviceId, 'yesterday', shifted.nativeRangeWindows.yesterday, headers)).totalTokens, 10);
});

for (const kind of ['Node', 'Worker']) test(`${kind} synchronizes changed fixed-range rows and recovers from a stale baseline`, async (t) => {
  const { base, send } = await backend(kind, t);
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
  const uploader = createSyncPayloadUploader();
  const window = { start: '2026-11-19', end: '2026-11-25' };
  const deviceId = 'fixed-range-delta';
  const requests = [];
  let staleBaseline = false;
  let staleIndex = false;
  const transport = async (url, options) => {
    if (options.method !== 'PUT') return send(url, options);
    const payload = JSON.parse(options.body);
    requests.push(payload);
    if ((staleBaseline || staleIndex) && payload.pages) {
      const delta = staleIndex ? payload.pages[0].indexDelta : payload.pages[1].delta;
      delta.baseRevision = '00000000-0000-4000-8000-000000000000';
      const response = await send(url, { ...options, body: JSON.stringify(payload) });
      assert.equal(response.status, 409);
      const unpublished = await send(url, { headers });
      assert.equal(unpublished.status, 404);
      await unpublished.arrayBuffer();
      return response;
    }
    return send(url, options);
  };
  const sessions = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`claude:s${i}`, {
    sessionId: `s${i}`, client: 'claude', totalTokens: 10, projectLabel: 'Project'
  }]));
  const makeRecord = (hour, rows) => {
    const totalTokens = Object.values(rows).reduce((sum, row) => sum + row.totalTokens, 0);
    const period = { totalTokens, clients: { claude: totalTokens }, sessions: rows };
    return {
      deviceId, updatedAt: `2026-11-25T0${hour}:00:00.000Z`,
      periodWindows: { timeZone: 'UTC', today: { key: window.end, endsAt: '2026-11-26T00:00:00.000Z' } },
      today: period, month: period, allTime: period,
      nativeRanges: { last7: period }, nativeRangeWindows: { last7: window }
    };
  };
  const upload = async summary => {
    const result = await uploader(transport, base + '/api/ingest', { summary, headers });
    assert.equal((await result.response.json()).fixedRangeBatch, 1);
    const published = await fetchFixedRange(send, base, deviceId, 'last7', window, headers);
    const { ranges, pages } = encodeFixedRangeSnapshot(summary, { maxPageBytes: 512 * 1024 });
    assert.deepEqual(published, JSON.parse(JSON.stringify(decodeFixedRangePeriod(ranges, pages, 'last7'))));
  };
  await upload(makeRecord(1, sessions));
  const first = requests[0];
  assert.ok(first.rows);
  assert.ok(requests.length > 1);
  requests.length = 0;
  const next = { ...sessions, 'claude:s0': { ...sessions['claude:s0'], totalTokens: 15 },
    'claude:added': { ...sessions['claude:s1'], sessionId: 'added' } };
  delete next['claude:s1'];
  await upload(makeRecord(2, next));
  assert.equal(requests.length, 1);
  assert.ok(requests[0].pages.length > 1);
  const firstPage = requests[0].pages[0];
  assert.equal(firstPage.indexDelta.baseRevision, first.revision);
  assert.equal(Object.hasOwn(firstPage, 'ranges'), false);
  const delta = firstPage.delta;
  assert.equal(delta.baseRevision, first.revision);
  assert.deepEqual(delta.remove, ['["last7","sessions","claude:s1"]']);
  assert.ok(delta.upsert.some(row => row[2] === 'claude:added'));
  assert.ok(delta.upsert.some(row => row[2] === 'claude:s0' && row[3].totalTokens === 15));
  assert.ok(JSON.stringify(requests[0]).length < JSON.stringify(first).length / 4);

  requests.length = 0;
  staleBaseline = true;
  await upload(makeRecord(3, next));
  assert.ok(requests[0].pages[0].delta);
  assert.ok(requests[1].rows);
  assert.equal(requests[1].page, 0);
  assert.notEqual(requests[0].pages[0].revision, requests[1].revision);

  staleBaseline = false;
  staleIndex = true;
  requests.length = 0;
  await upload(makeRecord(4, next));
  assert.ok(requests[0].pages[0].indexDelta);
  assert.ok(requests[1].rows);
  assert.notEqual(requests[0].pages[0].revision, requests[1].revision);
  staleIndex = false;

  const deleted = await send(base + '/api/devices/' + deviceId, { method: 'DELETE', headers });
  assert.equal(deleted.status, 200);
  staleBaseline = false;
  requests.length = 0;
  await upload(makeRecord(4, next));
  assert.ok(requests.length, 'the same observation is republished after device deletion');

  requests.length = 0;
  const shifted = makeRecord(4, next);
  shifted.periodWindows.today = { key: '2026-11-26', endsAt: '2026-11-27T00:00:00.000Z' };
  shifted.nativeRangeWindows.last7 = { start: '2026-11-20', end: '2026-11-26' };
  const moved = await uploader(transport, base + '/api/ingest', { summary: shifted, headers });
  assert.equal(moved.response.status, 200);
  assert.equal((await moved.response.json()).fixedRangeRevision, null, 'the earlier calendar revision cannot be advertised');
  assert.ok(requests.length, 'a changed calendar window is republished at the same timestamp');
  assert.ok(await fetchFixedRange(send, base, deviceId, 'last7', shifted.nativeRangeWindows.last7, headers));
});


test('fixed range batches split by UTF-8 body size including their envelope', () => {
  const pages = [0, 1, 2].map(page => ({ page, rows: ['會話'.repeat(100)] }));
  const limit = Buffer.byteLength(JSON.stringify({ pages: pages.slice(0, 2) }));
  const exact = [...fixedRangeRequestBodies(pages, limit)].map(body => JSON.parse(body));
  assert.deepEqual(exact, [{ pages: pages.slice(0, 2) }, pages[2]]);
  const overflow = [...fixedRangeRequestBodies(pages, limit - 1)].map(body => JSON.parse(body));
  assert.deepEqual(overflow, pages);
});

for (const kind of ['Node', 'Worker']) test(`${kind} preserves the calendar and reconstructs Month from a 31-day upload`, async (t) => {
  const { base, send } = await backend(kind, t, true);
  const { dailyRangeKeys } = require('../../src/shared/fixedRangeSync');
  const { resolveSyncedSessionPeriod } = require('../../src/electron/syncedFixedPeriod');
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
  const window = { start: '2026-10-01', end: '2026-10-31' };
  const days = dailyRangeKeys(window);
  const sessions = Object.fromEntries(Array.from({ length: 90 }, (_, index) => [`claude:${index}`, {
    client: 'claude', sessionId: String(index), totalTokens: 10, projectLabel: 'Example', title: 'shared title',
    models: Object.fromEntries(Array.from({ length: 10 }, (_, model) => [`fixture-model-${model}-${String(index).padStart(3, '0')}`, 1]))
  }]));
  const daily = Object.fromEntries(days.map(day => [day, { totalTokens: 900, clients: { claude: 900 }, sessions }]));
  const month = mergePeriods(...Object.values(daily));
  const summary = {
    deviceId: 'calendar-first',
    trackedClients: ['claude'],
    updatedAt: '2026-10-31T12:00:00.000Z',
    periodWindows: { today: { key: window.end, endsAt: '2026-11-01T00:00:00.000Z' },
      month: { key: '2026-10', endsAt: '2026-11-01T00:00:00.000Z' }, timeZone: 'UTC' },
    today: daily[window.end],
    month,
    allTime: { totalTokens: month.totalTokens },
    nativeRangeWindows: { yesterday: { start: days[29], end: days[29] } },
    nativeRanges: { yesterday: daily[days[29]] },
    dailySessionPeriods: daily,
    history: {
      daily: [{ date: window.end, tokens: 900, cost: 0 }],
      dailyTotals: days.map(date => ({ date, tokens: 900, cost: 0 })),
      summary: { activeDays: 31, activeDaysComplete: true }
    }
  };
  const titleUrl = base + '/api/sync/titles/calendar-first';
  const titlePolicy = await send(titleUrl, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
  assert.equal(titlePolicy.status, 200);
  const { generation } = await titlePolicy.json();
  const upload = createSyncPayloadUploader();
  let sawUnpublishedPages = false;
  const inspectUpload = async (url, init) => {
    const response = await send(url, init);
    if (!sawUnpublishedPages && init.method === 'PUT' && response.ok && !(await response.clone().json()).complete) {
      const index = await send(base + '/api/fixed-ranges?deviceId=calendar-first&daily=1', { headers });
      assert.equal(index.status, 404);
      sawUnpublishedPages = true;
    }
    return response;
  };
  for (let i = 0; i < 2; i++) {
    const result = await upload(inspectUpload, base + '/api/ingest', { summary, headers, syncSessionTitles: true, sessionTitleSyncGeneration: generation });
    assert.equal(result.response.status, 200);
    assert.equal((await result.response.json()).dailySessionRanges, 1);
    assert.equal(Object.hasOwn(result.payload, 'dailySessionPeriods'), false);
    if (i === 1) {
      assert.equal(Object.keys(result.payload.month.sessions).length, 90);
      assert.equal(result.payload.history.dailyTotals.length, 31);
    }
  }
  assert.equal(sawUnpublishedPages, true);
  const response = await send(base + '/api/stats', { headers });
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.equal(Object.keys(stats.devices[0].periods.month.sessions).length, 90, 'older readers keep inline session detail');
  assert.equal(stats.historyPreview.summary.activeDaysComplete, true);
  assert.equal(stats.historyPreview.summary.activeDays, 31);
  const revision = stats.fixedRangeRevisions[summary.deviceId];
  assert.ok(revision);
  const actual = await fetchFixedRange(send, base, summary.deviceId, 'month', window, headers, revision);
  assert.equal(actual.totalTokens, 27_900);
  assert.equal(actual.sessions['claude:0'].totalTokens, 310);
  assert.equal(Object.keys(actual.sessions).length, 90);
  assert.deepEqual(actual.projects, month.projects);
  const legacyUrl = base + '/api/fixed-ranges?deviceId=calendar-first';
  const legacyIndex = await (await send(legacyUrl, { headers })).json();
  assert.deepEqual(Object.keys(legacyIndex.ranges), ['yesterday', 'week', 'last7', 'last30']);
  const oldLast30 = legacyIndex.ranges.last30;
  const legacyPage = await (await send(`${legacyUrl}&revision=${revision}&page=${oldLast30.firstPage}`, { headers })).json();
  assert.equal(legacyPage.rows[0][0], 'last30');
  const view = await resolveSyncedSessionPeriod('month', stats.devices, stats.fixedRangeRevisions, {
    now: Date.parse(summary.updatedAt),
    read: (id, name, bounds, current) => fetchFixedRange(send, base, id, name, bounds, headers, current)
  });
  assert.equal(view.detailsAvailable, true);
  assert.equal(view.period.sessions['claude:0'].sourceDevice.deviceId, summary.deviceId);

  assert.equal(actual.sessions['claude:0'].title, 'shared title');
  const { serializeSyncPayload } = require('../../src/shared/syncPayload');
  const legacyBody = serializeSyncPayload(summary, { syncSessionTitles: true, sessionTitleSyncGeneration: generation }).payload;
  delete legacyBody.month.sessions['claude:89'];
  legacyBody.sessionDetailsOmitted = { month: 1 };
  const completeHistory = legacyBody.history;
  legacyBody.history = { ...completeHistory, dailyTotalsOmitted: 31, summary: { ...completeHistory.summary, activeDaysComplete: false } };
  delete legacyBody.history.dailyTotals;
  const legacyIngest = await send(base + '/api/ingest', { method: 'POST',
    headers: { ...headers, 'x-token-monitor-upload': '1' }, body: JSON.stringify(legacyBody) });
  const { upload: baseline } = await legacyIngest.json();
  const compact = await send(base + '/api/ingest/compact', { method: 'POST', headers, body: JSON.stringify({
    deviceId: summary.deviceId, baseRevision: baseline.revision, patch: [
      { op: 'replace', path: '/history', value: completeHistory },
      { op: 'remove', path: '/today/sessions' },
      { op: 'remove', path: '/month/sessions' }
    ]
  }) });
  assert.equal(compact.status, 200);
  const restoredStats = (await compact.json()).stats;
  assert.equal(restoredStats.historyPreview.summary.activeDaysComplete, true);
  assert.equal(restoredStats.devices[0].periods.month.sessions['claude:0'].title, 'shared title');
  assert.equal(Object.keys(restoredStats.devices[0].periods.month.sessions).length, 89, 'the old reader keeps its accepted inline rows');
  const ingestHistory = async (history) => {
    const response = await send(base + '/api/ingest', { method: 'POST',
      headers: { ...headers, 'x-token-monitor-upload': '1' }, body: JSON.stringify({ ...legacyBody, history }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const retainedCalendar = await ingestHistory(legacyBody.history);
  assert.equal(retainedCalendar.historyCalendarRetained, true);
  assert.equal(retainedCalendar.stats.historyPreview.summary.activeDaysComplete, true);

  const changedHistory = { ...legacyBody.history, dailyTotalsRevision: 'a'.repeat(64) };
  const changedCalendar = await ingestHistory(changedHistory);
  assert.equal(changedCalendar.historyCalendarRetained, undefined);
  assert.equal(changedCalendar.stats.historyPreview.summary.activeDaysComplete, false);
  const revoked = await send(titleUrl, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
  assert.equal(revoked.status, 200);
  assert.equal(await fetchFixedRange(send, base, summary.deviceId, 'month', window, headers, revision), null);
  const untitled = await fetchFixedRange(send, base, summary.deviceId, 'month', window, headers);
  assert.equal(untitled.sessions['claude:0'].title, '');
  assert.equal(untitled.sessions['claude:0'].totalTokens, 310);

  const untracked = { ...summary, updatedAt: '2026-10-31T13:00:00.000Z', trackedClients: ['codex'],
    today: { totalTokens: 0 }, month: { totalTokens: 0 }, allTime: { totalTokens: 0 },
    nativeRanges: undefined, dailySessionPeriods: undefined };
  const untrackedResult = await upload(send, base + '/api/ingest', { summary: untracked, headers });
  assert.equal(untrackedResult.response.status, 200);
  const retained = (await (await send(base + '/api/stats', { headers })).json()).devices[0].periods.month;
  assert.equal(retained.totalTokens, 27_900);
  assert.equal(retained.sessions['claude:0'].totalTokens, 310);
  assert.equal(retained.sessions['claude:89'].totalTokens, 310, 'the Hub restores the omitted session before untracking');
  assert.equal(Object.keys(retained.sessions).length, 90);

  const legacyAck = async (url, init) => {
    const response = await send(url, init);
    if (init.method !== 'POST' || !response.ok) return response;
    const ack = await response.json();
    delete ack.dailySessionRanges;
    return Response.json(ack);
  };
  const downgraded = await upload(legacyAck, base + '/api/ingest', {
    summary: { ...summary, updatedAt: '2026-10-31T14:00:00.000Z' }, headers
  });
  assert.equal(downgraded.response.status, 200);
  assert.equal(Object.keys(downgraded.payload.month.sessions).length, 90);
  const downgradedIndex = await (await send(legacyUrl + '&daily=1', { headers })).json();
  assert.deepEqual(Object.keys(downgradedIndex.ranges), ['yesterday']);
  const rejectedDaily = async (url, init) => init.method === 'PUT' && Object.hasOwn(JSON.parse(init.body), 'firstPage')
    ? Response.json({ error: 'payload_too_large' }, { status: 413 }) : send(url, init);
  const recovered = await upload(rejectedDaily, base + '/api/ingest', {
    summary: { ...summary, updatedAt: '2026-10-31T14:30:00.000Z' }, headers
  });
  assert.equal(recovered.response.status, 200);
  const recoveredIndex = await (await send(legacyUrl + '&daily=1', { headers })).json();
  assert.deepEqual(Object.keys(recoveredIndex.ranges), ['yesterday']);

  const rejectedPages = async (url, init) => init.method === 'PUT'
    ? Response.json({ error: 'payload_too_large' }, { status: 413 }) : send(url, init);
  const incomplete = await upload(rejectedPages, base + '/api/ingest', {
    summary: { ...summary, updatedAt: '2026-10-31T15:00:00.000Z' }, headers
  });
  assert.equal(incomplete.response.status, 200);
  assert.equal(Object.keys(incomplete.payload.month.sessions).length, 90);
  assert.equal((await send(legacyUrl + '&daily=1', { headers })).status, 404);
});
