'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createHub } = require('../../src/hub/server');

function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-occupancy-hub-'));
  return {
    dir,
    dataFile: path.join(dir, 'devices.json'),
    occupancyDataFile: path.join(dir, 'occupancy.json')
  };
}

test('hub exposes authenticated account, lease, heartbeat, status, and release APIs', async () => {
  const paths = files();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: 'test-secret',
    dataFile: paths.dataFile,
    occupancyDataFile: paths.occupancyDataFile,
    logger: { error() {}, warn() {} }
  });
  await hub.start();
  try {
    const base = `http://127.0.0.1:${hub.server.address().port}/api/occupancy`;
    assert.equal((await fetch(`${base}/status`)).status, 401);

    const headers = { authorization: 'Bearer test-secret', 'content-type': 'application/json' };
    const accountResponse = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'chatgpt-personal', provider: 'chatgpt', alias: 'Personal', capacity: 1 })
    });
    assert.equal(accountResponse.status, 201);
    const accountBody = await accountResponse.json();
    assert.equal(accountBody.account.alias, 'Personal');
    assert.deepEqual(accountBody.account.quota, accountBody.occupancy.accounts[0].quota);

    const leaseResponse = await fetch(`${base}/leases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ accountId: 'chatgpt-personal', deviceId: 'pc', taskLabel: 'Build' })
    });
    assert.equal(leaseResponse.status, 201);
    const lease = (await leaseResponse.json()).lease;
    assert.ok(lease.fenceToken);

    const aboveThresholdResponse = await fetch(`${base}/leases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ accountId: 'chatgpt-personal', deviceId: 'laptop' })
    });
    assert.equal(aboveThresholdResponse.status, 201);
    const aboveThresholdLease = (await aboveThresholdResponse.json()).lease;

    const heartbeatResponse = await fetch(`${base}/leases/${encodeURIComponent(lease.id)}/heartbeat`, {
      method: 'POST',
      headers: { ...headers, 'x-occupancy-fence-token': lease.fenceToken },
      body: '{}'
    });
    assert.equal(heartbeatResponse.status, 200);

    const status = await fetch(`${base}/status`, { headers });
    const snapshot = await status.json();
    assert.equal(snapshot.accounts[0].light, 'red');
    assert.equal(snapshot.accounts[0].tasks.length, 2);
    assert.equal(snapshot.accounts[0].advisoryThresholdReached, true);
    assert.equal(snapshot.leases[0].fenceToken, undefined);

    const releaseResponse = await fetch(`${base}/leases/${encodeURIComponent(lease.id)}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ fenceToken: lease.fenceToken })
    });
    assert.equal(releaseResponse.status, 200);
    assert.equal((await releaseResponse.json()).occupancy.accounts[0].light, 'red');

    await fetch(`${base}/leases/${encodeURIComponent(aboveThresholdLease.id)}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ fenceToken: aboveThresholdLease.fenceToken })
    });
  } finally {
    await hub.stop();
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('both occupancy SSE paths send a canonical snapshot event', async () => {
  const paths = files();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    dataFile: paths.dataFile,
    occupancyDataFile: paths.occupancyDataFile,
    logger: { error() {}, warn() {} }
  });
  await hub.start();
  try {
    const base = `http://127.0.0.1:${hub.server.address().port}/api/occupancy`;
    for (const suffix of ['events', 'stream']) {
      const response = await fetch(`${base}/${suffix}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/event-stream/);
      const reader = response.body.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert.match(text, /event: snapshot/);
      assert.match(text, /"type":"occupancy"/);
      await reader.cancel();
    }
  } finally {
    await hub.stop();
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('a Hub without a secret rejects cross-origin browser access', async () => {
  const paths = files();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    dataFile: paths.dataFile,
    occupancyDataFile: paths.occupancyDataFile,
    logger: { error() {}, warn() {} }
  });
  await hub.start();
  try {
    const port = hub.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const crossOrigin = await fetch(`${base}/api/occupancy/accounts`, {
      headers: { origin: 'https://malicious.example' }
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error, 'cross_origin_secret_required');

    const preflight = await fetch(`${base}/api/occupancy/accounts`, {
      method: 'OPTIONS',
      headers: { origin: 'https://malicious.example' }
    });
    assert.equal(preflight.status, 403);

    const rebound = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/occupancy/accounts',
        headers: { host: 'attacker.example', origin: 'http://attacker.example' }
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, json: () => JSON.parse(body) }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(rebound.status, 403);
    assert.equal(rebound.json().error, 'loopback_host_required');

    const sameOrigin = await fetch(`${base}/api/occupancy/accounts`, {
      headers: { origin: base }
    });
    assert.equal(sameOrigin.status, 200);
  } finally {
    await hub.stop();
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('occupancy changes trigger existing hub stats listeners', () => {
  const paths = files();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    dataFile: paths.dataFile,
    occupancyDataFile: paths.occupancyDataFile,
    logger: { error() {}, warn() {} }
  });
  try {
    const reasons = [];
    hub.onStats((_stats, reason) => reasons.push(reason));
    hub.occupancy.createAccount({ provider: 'claude', alias: 'Work', capacity: 2 });
    assert.deepEqual(reasons, ['occupancy']);
    assert.equal(hub.getStats().occupancy.accounts.length, 1);
  } finally {
    hub.occupancy.close();
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('Hub derives linked per-account quota from participating device snapshots', async () => {
  const paths = files();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: 'test-secret',
    dataFile: paths.dataFile,
    occupancyDataFile: paths.occupancyDataFile,
    logger: { error() {}, warn() {} }
  });
  hub.ingest({
    deviceId: 'mac-mini',
    hostname: 'Mac mini',
    updatedAt: new Date().toISOString(),
    limits: {
      updatedAt: new Date().toISOString(),
      providers: [{
        provider: 'codex',
        accountKey: 'sha256:gpt-pro-one',
        accountEmail: 'primary@example.com',
        accountLabel: 'Pro',
        status: 'ok',
        updatedAt: new Date().toISOString(),
        windows: [{ kind: 'weekly', usedPercent: 58 }]
      }]
    }
  });
  hub.occupancy.createAccount({
    id: 'gpt-pro',
    provider: 'chatgpt',
    alias: 'GPT Pro',
    capacity: 2,
    quotaLink: { provider: 'codex', accountKey: 'sha256:gpt-pro-one' }
  });
  await hub.start();
  try {
    const stats = hub.getStats();
    assert.equal(stats.occupancy.accounts[0].light, 'green');
    assert.equal(stats.occupancy.accounts[0].quota.linkState, 'linked');
    assert.equal(stats.occupancy.accounts[0].quota.minimumRemainingPercent, 42);
    assert.equal(stats.occupancy.accounts[0].quota.sourceDeviceId, 'mac-mini');
    assert.equal(stats.occupancy.accounts[0].quota.accountKey, undefined);

    const response = await fetch(`http://127.0.0.1:${hub.server.address().port}/api/occupancy/status`, {
      headers: { authorization: 'Bearer test-secret' }
    });
    const occupancy = await response.json();
    assert.equal(occupancy.accounts[0].quota.minimumRemainingPercent, 42);
    assert.equal(occupancy.quotaCandidates[0].maskedEmail, 'p***y@example.com');
  } finally {
    await hub.stop();
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});
