'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHub } = require('../../src/hub/server');
const { encodeFixedRangeSnapshot, decodeFixedRangePeriod } = require('../../src/shared/fixedRangeSync');
const { fetchFixedRange, uploadFixedRanges } = require('../../src/shared/fixedRangeClient');
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
    await upload(traced, base + '/api/ingest', { headers, summary: rangeRecord });
    assert.equal(requests.some(([pathname]) => pathname === '/api/fixed-ranges'), false);
    const replacement = await (await send(endpoint, { headers })).json();
    assert.notEqual(replacement.revision, revision);
    assert.equal((await put(conflicting)).status, 409, 'a superseded upload may not publish under its old revision');
    assert.equal((await (await send(endpoint, { headers })).json()).revision, replacement.revision);
    const loaded = await fetchFixedRange(send, base, deviceId, 'last7', rangeRecord.nativeRangeWindows.last7, headers);
    assert.deepEqual(loaded, period);
    receivedPeriods.push(loaded);

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
    assert.equal(await fetchFixedRange(send, base, deviceId, 'last7', { start: '2026-11-18', end: '2026-11-24' }, headers), null);
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
    const publicStats = await (await send(base + '/api/public/stats')).json();
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

  assert.equal((await ingest({ limitsOnly: true, projectsEnabled: false })).status, 200);
  assert.equal((await put(1, rows.filter(row => row[1] === 'sessions'))).status, 409);
  assert.equal((await send(endpoint, { headers })).status, 404);
  assert.equal(await uploadFixedRanges(send, base, { ...rangeRecord, projectsEnabled: false }, headers), true);
});

for (const kind of ['Node', 'Worker']) test(`${kind} synchronizes changed fixed-range rows and recovers from a stale baseline`, async (t) => {
  const { base, send } = await backend(kind, t);
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
  const uploader = createSyncPayloadUploader();
  const window = { start: '2026-11-19', end: '2026-11-25' };
  const deviceId = 'fixed-range-delta';
  const requests = [];
  let staleBaseline = false;
  const transport = async (url, options) => {
    if (options.method !== 'PUT') return send(url, options);
    const payload = JSON.parse(options.body);
    requests.push(payload);
    if (staleBaseline && payload.delta && payload.page === 1) {
      payload.delta.baseRevision = '00000000-0000-4000-8000-000000000000';
      const response = await send(url, { ...options, body: JSON.stringify(payload) });
      assert.equal(response.status, 409);
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
    assert.equal((await result.response.json()).fixedRangeDelta, 1);
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
  const delta = requests[0].delta;
  assert.equal(delta.baseRevision, first.revision);
  assert.deepEqual(delta.remove, ['["last7","sessions","claude:s1"]']);
  assert.ok(delta.upsert.some(row => row[2] === 'claude:added'));
  assert.ok(delta.upsert.some(row => row[2] === 'claude:s0' && row[3].totalTokens === 15));
  assert.ok(JSON.stringify(requests[0]).length < JSON.stringify(first).length / 4);

  requests.length = 0;
  staleBaseline = true;
  await upload(makeRecord(3, next));
  assert.ok(requests[0].delta);
  assert.ok(requests[1].delta);
  assert.ok(requests[2].rows);
  assert.equal(requests[2].page, 0);
  assert.notEqual(requests[0].revision, requests[2].revision);
});
