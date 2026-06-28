'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createHub, resolveBindHost } = require('../../src/hub/server');

function tempDataFile() {
  return path.join(os.tmpdir(), `tm-hub-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

test('resolveBindHost keeps the requested host when a secret is set', () => {
  assert.equal(resolveBindHost('0.0.0.0', 's3cret'), '0.0.0.0');
  assert.equal(resolveBindHost('192.168.1.10', 's3cret'), '192.168.1.10');
});

test('resolveBindHost forces localhost when no secret and a non-loopback host is requested', () => {
  assert.equal(resolveBindHost('0.0.0.0', ''), '127.0.0.1');
  assert.equal(resolveBindHost('192.168.1.10', ''), '127.0.0.1');
  assert.equal(resolveBindHost('', ''), '127.0.0.1');
});

test('resolveBindHost leaves an already-loopback host unchanged without a secret', () => {
  assert.equal(resolveBindHost('127.0.0.1', ''), '127.0.0.1');
  assert.equal(resolveBindHost('localhost', ''), 'localhost');
  assert.equal(resolveBindHost('::1', ''), '::1');
});

test('a hub without a secret binds to localhost only even when asked to bind every interface', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '0.0.0.0', secret: '', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    assert.equal(hub.bindHost, '127.0.0.1');
    assert.equal(hub.server.address().address, '127.0.0.1');
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('ingest inserts a device and is visible in getStats', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    const record = hub.ingest({ deviceId: 'dev-a', today: { totalTokens: 5, costUsd: 0.1 } });
    assert.equal(record.deviceId, 'dev-a');
    assert.equal(hub.getStats().devices.length, 1);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('ingest without a deviceId throws', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    assert.throws(() => hub.ingest({ today: { totalTokens: 1 } }), /deviceId/);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('onStats fires on ingest and on deleteDevice, and unsubscribe stops it', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    let calls = 0;
    let lastDeviceCount = -1;
    const unsub = hub.onStats((stats) => { calls += 1; lastDeviceCount = stats.devices.length; });
    hub.ingest({ deviceId: 'dev-a', today: { totalTokens: 5 } });
    assert.equal(calls, 1);
    assert.equal(lastDeviceCount, 1);
    hub.deleteDevice('dev-a');
    assert.equal(calls, 2);
    assert.equal(lastDeviceCount, 0);
    unsub();
    hub.ingest({ deviceId: 'dev-b', today: { totalTokens: 1 } });
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('HTTP ingest accepts payloads larger than the old 256KB default', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const payload = {
      deviceId: 'large-device',
      today: {
        totalTokens: 1,
        sessions: {
          'codex:large': {
            client: 'codex',
            sessionId: 'large',
            totalTokens: 1,
            models: { 'gpt-5': 1 },
            transcriptPreview: 'x'.repeat(300 * 1024)
          }
        }
      }
    };
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.deviceId, 'large-device');
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('HTTP ingest returns 413 when a configured body limit is exceeded', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', maxBodyBytes: 128, dataFile, logger: { error() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'too-large', today: { totalTokens: 1 }, padding: 'x'.repeat(256) })
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error, 'request_body_too_large');
    assert.equal(body.maxBytes, 128);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});
