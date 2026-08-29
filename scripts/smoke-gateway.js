#!/usr/bin/env node
'use strict';

// End-to-end smoke test for the LAN gateway: starts it, posts a synthetic
// device to the data plane, then reads the view plane with no credentials and
// asserts the redaction held. Run with `node scripts/smoke-gateway.js`.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createGateway } = require('../src/gateway/server');

const SECRET = 'smoke-secret';
const NOW = new Date().toISOString();

const device = {
  deviceId: 'smoke-mac',
  hostname: 'smoke-mac.local',
  platform: 'darwin-arm64',
  osName: 'macOS',
  osVersion: '26.0',
  agentVersion: '0.49.0',
  agentRuntime: 'headless-agent',
  updatedAt: NOW,
  // Windows must end in the future: the aggregate drops a device period whose
  // window has already closed, which is how an offline device stops
  // contributing a stale day to the total.
  periodWindows: {
    timeZone: 'Asia/Hong_Kong',
    today: { key: NOW.slice(0, 10), endsAt: new Date(Date.now() + 86_400_000).toISOString() }
  },
  clientHealth: {
    version: 1, observedAt: NOW,
    clients: { antigravity: { source: { state: 'missing', detectedCount: 0, checkedCount: 2 }, overall: 'unavailable' } }
  },
  today: { totalTokens: 1234, costUsd: 0.42, clients: { codex: 1234 }, models: { 'gpt-5': 1234 } },
  month: { totalTokens: 5600, costUsd: 1.9 },
  allTime: {
    totalTokens: 9900, costUsd: 3.1,
    projects: { 'acme-vault': { label: 'Acme Vault', tokens: 9900, costUsd: 3.1, clients: { codex: 9900 } } }
  },
  limits: {
    updatedAt: NOW,
    refreshMs: 300000,
    providers: [{
      provider: 'opencode',
      accountKey: 'sha256:private',
      accountEmail: 'work@example.com',
      accountName: 'work',
      planLabel: 'Zen',
      status: 'ok',
      source: 'web',
      updatedAt: NOW,
      windows: [{ kind: 'weekly', usedPercent: 30, remainingPercent: 70 }],
      balance: { amount: 12.5, currency: 'USD', tranches: [{ amount: 12.5, currency: 'USD' }], quotaGroup: 'team-a' }
    }]
  }
};

async function main() {
  const dataFile = path.join(os.tmpdir(), `tm-gateway-smoke-${process.pid}.json`);
  const gateway = createGateway({
    dataPort: 0,
    viewPort: 0,
    host: '127.0.0.1',
    secret: SECRET,
    dataFile,
    mdnsEnabled: false,
    logger: { error: () => {}, warn: () => {} }
  });

  try {
    await gateway.start();
    const { port: dataPort } = gateway.hub.server.address();
    const { port: viewPort } = gateway.view.address();

    // 1. The data plane refuses an unauthenticated ingest.
    const rejected = await fetch(`http://127.0.0.1:${dataPort}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(device)
    });
    assert.equal(rejected.status, 401, 'unauthenticated ingest must be refused');

    // 2. An authenticated ingest lands.
    const accepted = await fetch(`http://127.0.0.1:${dataPort}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(device)
    });
    assert.equal(accepted.status, 200, 'authenticated ingest must be accepted');

    // 3. The view plane serves it with no credentials at all.
    const view = await (await fetch(`http://127.0.0.1:${viewPort}/api/view/stats`)).json();
    assert.equal(view.deviceCount, 1);
    assert.equal(view.periods.today.totalTokens, 1234);
    assert.equal(view.periods.today.costUsd, 0.42);

    // 4. Redaction held on the unauthenticated surface.
    const json = JSON.stringify(view);
    for (const leak of ['accountKey', 'accountEmail', 'accountName', 'planLabel', 'clientHealth', 'antigravity', 'Acme Vault', 'acme-vault', 'sha256:private', 'team-a']) {
      assert.doesNotMatch(json, new RegExp(leak, 'i'), `${leak} must not be readable without the secret`);
    }
    assert.equal(Object.hasOwn(view.periods.allTime, 'projects'), false);

    // 5. What a viewer came for is still there.
    assert.equal(view.limits.providers[0].windows[0].usedPercent, 30);
    assert.equal(view.devices[0].hostname, 'smoke-mac.local');
    assert.equal(view.devices[0].limits.providers[0].balance.amount, 12.5);
    assert.equal(Object.hasOwn(view.devices[0].limits.providers[0].balance, 'tranches'), false);

    // 6. Nothing on the view plane can write.
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`http://127.0.0.1:${viewPort}/api/view/stats`, {
        method, headers: { 'content-type': 'application/json' }, body: '{}'
      });
      assert.equal(response.status, 404, `${method} on the view plane must be 404`);
    }

    console.log(`smoke: data plane 127.0.0.1:${dataPort} (secret), view plane 127.0.0.1:${viewPort} (open)`);
    console.log('smoke: ok');
  } finally {
    await gateway.stop();
    fs.rmSync(dataFile, { force: true });
  }
}

main().catch((error) => {
  console.error(`smoke: FAILED — ${error.message}`);
  process.exit(1);
});
