'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createGateway } = require('../../src/gateway/server');

const SECRET = 'gateway-test-secret';
const NOW = '2026-08-28T09:00:00.000Z';

function tempDataFile() {
  return path.join(os.tmpdir(), `tm-gateway-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

// mDNS is off in every test here: it would bind port 5353, which is shared with
// whatever responder the host already runs. Its own tests cover the protocol.
async function withGateway(options, run) {
  const dataFile = tempDataFile();
  const gateway = createGateway({
    dataPort: 0,
    viewPort: 0,
    host: '127.0.0.1',
    secret: SECRET,
    dataFile,
    mdnsEnabled: false,
    logger: { error() {}, warn() {}, log() {} },
    ...options
  });
  try {
    await gateway.start();
    return await run({
      gateway,
      dataPort: gateway.hub.server.address().port,
      viewPort: gateway.view.address().port
    });
  } finally {
    await gateway.stop();
    fs.rmSync(dataFile, { force: true });
  }
}

function device() {
  return {
    deviceId: 'macbook',
    hostname: 'macbook.local',
    platform: 'darwin-arm64',
    updatedAt: NOW,
    today: { totalTokens: 100, costUsd: 0.5, clients: { codex: 100 } },
    month: { totalTokens: 500, costUsd: 2 },
    allTime: { totalTokens: 900, costUsd: 4, projects: { 'acme-vault': { label: 'Acme Vault', tokens: 900 } } },
    clientHealth: {
      version: 1, observedAt: NOW,
      clients: { antigravity: { source: { state: 'missing' }, overall: 'unavailable' } }
    },
    limits: {
      updatedAt: NOW,
      refreshMs: 300000,
      providers: [{
        provider: 'opencode', accountKey: 'sha256:private', accountEmail: 'work@example.com',
        status: 'ok', updatedAt: NOW, windows: [{ kind: 'weekly', usedPercent: 25, remainingPercent: 75 }]
      }]
    }
  };
}

test('a gateway without a secret refuses to start rather than binding loopback', () => {
  // The whole point of a gateway is being reached from other machines. Silently
  // degrading to localhost, as the plain hub does, would look like a running
  // gateway and be a hub no device can find.
  assert.throws(() => createGateway({ secret: '' }), (error) => error.code === 'secret_required');
  assert.throws(() => createGateway({ secret: '   ' }), (error) => error.code === 'secret_required');
});

test('a gateway can run with the read-only view plane disabled', async () => {
  const dataFile = tempDataFile();
  const gateway = createGateway({
    dataPort: 0,
    viewPort: 0,
    host: '127.0.0.1',
    secret: SECRET,
    dataFile,
    mdnsEnabled: false,
    viewEnabled: false,
    logger: { error() {}, warn() {}, log() {} }
  });
  try {
    await gateway.start();
    assert.equal(gateway.view, null, 'the view server must not be created when disabled');
    assert.equal(gateway.viewEnabled, false);

    // The data plane is unaffected: ingest + authenticated read still work.
    const dataPort = gateway.hub.server.address().port;
    await fetch(`http://127.0.0.1:${dataPort}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token-monitor-secret': SECRET },
      body: JSON.stringify(device())
    });
    const stats = await (await fetch(`http://127.0.0.1:${dataPort}/api/stats`, {
      headers: { 'x-token-monitor-secret': SECRET }
    })).json();
    assert.ok(stats);
  } finally {
    await gateway.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('the view plane serves stats with no credentials at all', async () => {
  await withGateway({}, async ({ dataPort, viewPort }) => {
    await fetch(`http://127.0.0.1:${dataPort}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(device())
    });
    const response = await fetch(`http://127.0.0.1:${viewPort}/api/view/stats`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.deviceCount, 1);
    assert.equal(payload.periods.today.totalTokens, 100);
  });
});

test('the view plane redacts account identity, diagnostics and projects', async () => {
  await withGateway({}, async ({ dataPort, viewPort }) => {
    await fetch(`http://127.0.0.1:${dataPort}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(device())
    });
    const payload = await (await fetch(`http://127.0.0.1:${viewPort}/api/view/stats`)).json();
    const json = JSON.stringify(payload);
    for (const leak of ['accountKey', 'accountEmail', 'clientHealth', 'antigravity', 'Acme Vault', 'acme-vault', 'sha256:private']) {
      assert.doesNotMatch(json, new RegExp(leak.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${leak} must not reach the unauthenticated surface`);
    }
    // What is left is the thing a viewer came for.
    assert.equal(payload.limits.providers[0].windows[0].usedPercent, 25);
    assert.equal(payload.devices[0].hostname, 'macbook.local');
  });
});

test('the view plane answers 404 to every write method', async () => {
  await withGateway({}, async ({ viewPort }) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`http://127.0.0.1:${viewPort}/api/view/stats`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'forged', today: { totalTokens: 999999 } })
      });
      // 404, never 405: a 405 tells an unauthenticated caller that a write
      // route exists at this path.
      assert.equal(response.status, 404, `${method} must not be routable`);
      const payload = await response.json();
      assert.equal(payload.error, 'not_found');
    }
  });
});

test('the view plane does not serve the authenticated hub routes', async () => {
  await withGateway({}, async ({ viewPort }) => {
    for (const route of ['/api/stats', '/api/devices', '/api/ingest', '/api/subscriptions', '/api/stats/stream']) {
      const response = await fetch(`http://127.0.0.1:${viewPort}${route}`);
      assert.equal(response.status, 404, `${route} must not exist on the view plane`);
    }
  });
});

test('the data plane still requires the secret', async () => {
  await withGateway({}, async ({ dataPort }) => {
    const unauthorized = await fetch(`http://127.0.0.1:${dataPort}/api/stats`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`http://127.0.0.1:${dataPort}/api/stats`, {
      headers: { authorization: `Bearer ${SECRET}` }
    });
    assert.equal(authorized.status, 200);
    // The authenticated route is the one that keeps the diagnostics.
    await fetch(`http://127.0.0.1:${dataPort}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(device())
    });
    const stats = await (await fetch(`http://127.0.0.1:${dataPort}/api/stats`, {
      headers: { authorization: `Bearer ${SECRET}` }
    })).json();
    assert.ok(stats.devices[0].clientHealth, 'diagnostics stay on the authenticated surface');
  });
});

test('the view plane health route needs no secret and reports both ports', async () => {
  await withGateway({}, async ({ viewPort }) => {
    const health = await (await fetch(`http://127.0.0.1:${viewPort}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.role, 'gateway');
    assert.equal(health.readOnly, true);
    assert.equal(health.deviceCount, 0);
    assert.equal(typeof health.dataPort, 'number');
    assert.equal(typeof health.viewPort, 'number');
  });
});

test('the view plane stream pushes a snapshot and then every ingest', async () => {
  await withGateway({}, async ({ dataPort, viewPort }) => {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${viewPort}/api/view/stats/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const events = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      const pump = (async () => {
        while (events.length < 2) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf('\n\n');
          while (index !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
            if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
            index = buffer.indexOf('\n\n');
          }
        }
      })();

      await fetch(`http://127.0.0.1:${dataPort}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
        body: JSON.stringify(device())
      });
      await pump;

      assert.equal(events[0].reason, 'snapshot');
      assert.equal(events[0].stats.deviceCount, 0);
      assert.equal(events[1].reason, 'ingest');
      assert.equal(events[1].stats.deviceCount, 1);
      // The pushed frame is the redacted view, not the hub's own stats object.
      assert.equal(Object.hasOwn(events[1].stats.devices[0], 'clientHealth'), false);
    } finally {
      controller.abort();
    }
  });
});

test('stopping the gateway closes both planes', async () => {
  const dataFile = tempDataFile();
  const gateway = createGateway({
    dataPort: 0, viewPort: 0, host: '127.0.0.1', secret: SECRET, dataFile,
    mdnsEnabled: false, logger: { error() {}, warn() {} }
  });
  try {
    await gateway.start();
    const dataPort = gateway.hub.server.address().port;
    const viewPort = gateway.view.address().port;
    await gateway.stop();
    await assert.rejects(() => fetch(`http://127.0.0.1:${viewPort}/api/view/stats`));
    await assert.rejects(() => fetch(`http://127.0.0.1:${dataPort}/api/health`));
    // Idempotent, because shutdown runs from signal handlers as well as tests.
    await gateway.stop();
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});
