'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHub } = require('../../src/hub/server');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-credits-hub-'));
  const dataFile = path.join(dir, 'devices.json');
  const hub = createHub({ port: 0, host: '127.0.0.1', dataFile, persistIntervalMs: 300000 });
  t.after(async () => {
    await hub.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return hub;
}

function creditBlock() {
  return {
    available: true,
    tool: 'workbuddy',
    updatedAt: '2026-10-25T00:00:00.000Z',
    totals: { credits: 48.77, requests: 3, byModel: { 'hy4-preview': 3.7 } },
    recentEvents: [{ dedupKey: 's1:a1', sessionId: 's1', model: 'ds', credits: -25.78, updatedAt: 3 }],
    warnings: 1
  };
}

test('ingest stores the credit ledger on the device record', (t) => {
  const hub = fixture(t);
  hub.ingest({ deviceId: 'dev1', today: { totalTokens: 10 }, credits: creditBlock() });
  const [device] = hub.getDevices();
  assert.equal(device.credits.available, true);
  assert.equal(device.credits.totals.credits, 48.77);
  assert.equal(device.credits.recentEvents.length, 1);
});

test('a full update without credits clears the previous ledger', (t) => {
  const hub = fixture(t);
  hub.ingest({ deviceId: 'dev1', today: { totalTokens: 10 }, credits: creditBlock() });
  hub.ingest({ deviceId: 'dev1', today: { totalTokens: 20 } });
  const [device] = hub.getDevices();
  assert.equal(device.credits, undefined);
});

test('limits-only updates preserve the last credit ledger', (t) => {
  const hub = fixture(t);
  hub.ingest({ deviceId: 'dev1', today: { totalTokens: 10 }, credits: creditBlock() });
  hub.ingest({ deviceId: 'dev1', limitsOnly: true, limits: { providers: [] } });
  const [device] = hub.getDevices();
  assert.equal(device.credits?.totals?.credits, 48.77);
});

test('oversized or malformed credit blocks are normalized, never fatal', (t) => {
  const hub = fixture(t);
  hub.ingest({
    deviceId: 'dev1',
    today: { totalTokens: 1 },
    credits: {
      available: true,
      totals: { credits: 5, requests: 2, byModel: { junk: 'x' } },
      recentEvents: [{ credits: -1, extra: 'dropped' }, { credits: {} }]
    }
  });
  const [device] = hub.getDevices();
  assert.equal(device.credits.available, true);
  assert.equal(device.credits.recentEvents.length, 1);
  assert.equal(device.credits.recentEvents[0].extra, undefined);
});
