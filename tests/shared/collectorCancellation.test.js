'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { startCollector } = require('../../src/shared/collector');

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('stopping superseded collectors aborts their physical scan before the next period', async () => {
  let active = 0;
  let maxActive = 0;
  let aborted = 0;
  let completed = 0;
  const calls = [];

  function runTokscale({ flags, signal }) {
    calls.push(flags);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        active -= 1;
        completed += 1;
        signal.removeEventListener('abort', onAbort);
        resolve({ entries: [] });
      }, 1000);
      function onAbort() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active -= 1;
        aborted += 1;
        reject(signal.reason);
      }
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  const options = {
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 5000,
    deviceId: 'cancellation-test',
    agentVersion: 'test',
    agentRuntime: 'test',
    historyEnabled: false,
    dailyHistoryArchiveEnabled: false,
    projectsEnabled: false,
    wslScanEnabled: false,
    watchEnabled: false,
    anchorPersistenceEnabled: false,
    homeDir: '/nonexistent-token-monitor-cancellation-test-home',
    osInfo: {},
    runTokscale,
    onUpdate() {}
  };

  let runtime = startCollector(options);
  await nextTurn();
  for (let index = 0; index < 30; index += 1) {
    runtime.stop();
    runtime = startCollector(options);
    await nextTurn();
  }
  runtime.stop();
  await nextTurn();

  assert.equal(calls.length, 31);
  assert.ok(calls.every((flags) => flags.includes('--today')), 'no superseded collector may advance to month/all-time');
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.equal(aborted, 31);
  assert.equal(completed, 0);
});
