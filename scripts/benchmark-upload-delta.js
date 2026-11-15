#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSyncPayloadUploader, postSyncPayload } = require('../src/shared/syncPayload');
const { summaryForUpload } = require('../tests/fixtures/syncUpload');

async function replay(records, optimized) {
  const { HubDO } = await import(pathToFileURL(path.resolve(__dirname, '../worker/src/index.js')).href);
  const data = new Map();
  const hub = new HubDO({ storage: {
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix } = {}) { return new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix))); }
  } }, { TOKEN_MONITOR_SECRET: 'benchmark', TOKEN_MONITOR_SYNC_SESSION_TITLES: '1' });
  const headers = { authorization: 'Bearer benchmark', 'content-type': 'application/json', 'x-token-monitor-response': 'minimal' };
  const policy = await (await hub.fetch(new Request(`https://local.invalid/api/sync/titles/${encodeURIComponent(records[0].deviceId)}`, {
    method: 'PUT', headers, body: JSON.stringify({ enabled: true })
  }))).json();
  const upload = optimized ? createSyncPayloadUploader() : postSyncPayload;
  const requests = [];
  for (const summary of records) {
    const { response } = await upload(async (url, options) => {
      const requestHeaders = new Headers(options.headers);
      if (optimized === 'history') requestHeaders.delete('x-token-monitor-upload');
      const response = await hub.fetch(new Request(url, { ...options, headers: requestHeaders }));
      requests.push({ bytes: Buffer.byteLength(options.body), delta: url.endsWith('/delta'), status: response.status });
      return response;
    }, 'https://local.invalid/api/ingest', { summary, headers, syncSessionTitles: true, sessionTitleSyncGeneration: policy.generation });
    assert.equal(response.status, 200);
  }
  return { requests, record: data.get(`dev:${records[0].deviceId}`) };
}

async function main() {
  let groups;
  if (process.argv[2]) {
    const { snapshots } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    groups = [];
    const deviceIds = new Set(snapshots.flatMap(snapshot => snapshot.devices.map(device => device.deviceId)));
    for (const deviceId of deviceIds) {
      const records = [];
      let receipt;
      for (const snapshot of snapshots) {
        const current = snapshot.devices.find(row => row.deviceId === deviceId);
        if (!current || current.receivedAt === receipt) continue;
        receipt = current.receivedAt;
        const { periods, receivedAt: _receivedAt, ...rest } = current;
        records.push({ ...rest, ...periods });
      }
      if (records.length > 1) groups.push({ name: deviceId, records });
    }
  } else {
    groups = [{ name: 'synthetic-151-days', records: Array.from({ length: 75 }, (_, tick) => summaryForUpload({ tick })) }];
  }
  const results = [];
  for (const { name, records } of groups) {
    const before = await replay(records, false);
    const after = await replay(records, true);
    const historyOnly = await replay(records, 'history');
    historyOnly.record.receivedAt = before.record.receivedAt;
    assert.deepEqual(historyOnly.record, before.record);
    before.record.receivedAt = after.record.receivedAt;
    assert.deepEqual(after.record, before.record, 'final Worker state must exactly match full ingestion');
    const total = rows => rows.reduce((sum, row) => sum + row.bytes, 0);
    const warmBefore = total(before.requests.slice(1));
    const warmAfter = total(after.requests.slice(1));
    results.push({ deviceId: name, snapshots: records.length,
      coldBytes: after.requests[0].bytes,
      beforeTotalBytes: total(before.requests), afterTotalBytes: total(after.requests),
      totalSavedPercent: Number(((1 - total(after.requests) / total(before.requests)) * 100).toFixed(2)),
      historyOnlyTotalBytes: total(historyOnly.requests),
      historyOnlyWarmMeanBytes: Math.round(total(historyOnly.requests.slice(1)) / (records.length - 1)),
      historyOnlyWarmSavedPercent: Number(((1 - total(historyOnly.requests.slice(1)) / warmBefore) * 100).toFixed(2)),
      warmBeforeBytes: warmBefore, warmAfterBytes: warmAfter,
      warmBeforeMeanBytes: Math.round(warmBefore / (records.length - 1)),
      warmAfterMeanBytes: Math.round(warmAfter / (records.length - 1)),
      warmSavedPercent: Number(((1 - warmAfter / warmBefore) * 100).toFixed(2)),
      requests: after.requests, identicalFinalState: true });
  }
  console.log(JSON.stringify({
    basis: process.argv[2]
      ? 'Read-only live Worker snapshots replayed locally through the real Worker ingest handlers. Unchanged receivedAt samples skipped. Reconstructed producer payloads, not captured original uploads; warm excludes first full bootstrap. No remote ingest.'
      : 'Synthetic fixture replayed through the real Worker ingest handlers.', results
  }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
