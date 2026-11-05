#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createSyncPayloadUploader, postSyncPayload } = require('../src/shared/syncPayload');
const { summaryForUpload } = require('../tests/fixtures/syncUpload');

async function measure({ days, sessions = 4, ticks = 75, changeHistory = false }, optimized) {
  let time = 0;
  const upload = optimized ? createSyncPayloadUploader({ now: () => time }) : postSyncPayload;
  let bytes = 0;
  let firstBytes = 0;
  let lastBytes = 0;
  let histories = 0;
  for (let tick = 0; tick < ticks; tick++) {
    time = tick * 2400;
    await upload(async (_url, request) => {
      const payload = JSON.parse(request.body);
      const size = Buffer.byteLength(request.body);
      bytes += size;
      if (tick === 0) firstBytes = size;
      lastBytes = size;
      histories += Object.hasOwn(payload, 'history') ? 1 : 0;
      assert.equal(payload.today.totalTokens, 200000 + tick);
      return Response.json({ ok: true, deviceId: payload.deviceId });
    }, 'https://benchmark.invalid/api/ingest', {
      summary: summaryForUpload({ days, sessions, tick, changeHistory }),
      headers: { 'x-token-monitor-response': 'minimal' }
    });
  }
  return { requests: ticks, bytes, firstBytes, lastBytes, histories };
}

async function main() {
  const scenarios = [
    { name: '30 days, 3 minutes', days: 30 },
    { name: '151 days, 3 minutes', days: 151 },
    { name: '370 days, 3 minutes', days: 370 },
    { name: '151 days, 30 minutes with reconciliation', days: 151, ticks: 750 },
    { name: '151 days, 450 live sessions, 3 minutes', days: 151, sessions: 450 },
    { name: '151 days, History changes every tick, 3 minutes', days: 151, changeHistory: true }
  ];
  const results = [];
  for (const scenario of scenarios) {
    const before = await measure(scenario, false);
    const after = await measure(scenario, true);
    assert.equal(before.requests, after.requests);
    assert.equal(before.firstBytes, after.firstBytes);
    assert.equal(after.histories, scenario.changeHistory ? before.requests : scenario.ticks === 750 ? 2 : 1);
    assert.ok(after.bytes <= before.bytes);
    results.push({ ...scenario, before, after, savedPercent: Number(((1 - after.bytes / before.bytes) * 100).toFixed(2)) });
  }
  console.log(JSON.stringify({
    basis: 'Synthetic request-body bytes from production upload functions; 25 uploads/minute; no HTTP/TLS overhead, gzip or real user traffic. Same live updates before and after.',
    results
  }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
