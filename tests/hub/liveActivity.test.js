'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHub } = require('../../src/hub/server');

function tempDataFile() {
  return path.join(os.tmpdir(), `tm-live-activity-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

test('Hub registers a Live Activity and pushes the latest state after ingest', async () => {
  const dataFile = tempDataFile();
  const pushes = [];
  const hub = createHub({
    dataFile,
    logger: { error() {}, warn() {} },
    apns: {
      enabled: true,
      minIntervalMs: 0,
      async send(token, state) {
        pushes.push({ token, state });
        return { sent: true };
      }
    }
  });
  try {
    hub.registerLiveActivity({
      activityID: 'activity-1',
      token: 'b'.repeat(64),
      locale: 'en-US',
      preferences: {
        liveActivityEnabled: true,
        livePrimaryMetric: 'tokens',
        livePeriod: 'today',
        liveShowsSecondaryMetric: false,
        liveShowsProgress: false
      }
    });
    hub.ingest({
      deviceId: 'device-1',
      periods: {
        today: { totalTokens: 1200, costUsd: 0.25, models: { 'gpt-5': 1200 } }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].token, 'b'.repeat(64));
    assert.equal(pushes[0].state.primaryValue, '1.2K');
    assert.equal(hub.unregisterLiveActivity('activity-1'), true);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});
