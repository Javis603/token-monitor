'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHub } = require('../../src/hub/server');

test('fifty simultaneous devices are all recorded beyond the advisory threshold', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-occupancy-concurrency-'));
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(dir, 'devices.json'),
    occupancyDataFile: path.join(dir, 'occupancy.json'),
    logger: { error() {}, warn() {} }
  });
  hub.occupancy.createAccount({ id: 'shared', provider: 'claude', alias: 'Shared', capacity: 3 });
  await hub.start();
  try {
    const endpoint = `http://127.0.0.1:${hub.server.address().port}/api/occupancy/leases`;
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'shared',
        deviceId: `device-${index}`,
        idempotencyKey: `attempt-${index}`,
        fenceToken: `fence-token-${String(index).padStart(8, '0')}`
      })
    })));
    const statuses = responses.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 201).length, 50);
    assert.equal(statuses.filter((status) => status === 409).length, 0);
    const snapshot = hub.occupancy.snapshot();
    assert.equal(snapshot.accounts[0].activeCount, 50);
    assert.equal(snapshot.accounts[0].light, 'red');
    assert.equal(snapshot.accounts[0].advisoryThresholdReached, true);
  } finally {
    await hub.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
