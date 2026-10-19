'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cursorAuth = require('../../src/shared/providers/cursor/auth');
const { collectUsageOnce } = require('../../src/shared/collector');

test('collector routes forced Cursor refresh to the explicit budget without extending source syncs', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-budget-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  t.mock.method(cursorAuth, 'runCursorSync', async options => calls.push(options.timeoutMs));
  const options = {
    clients: 'cursor', homeDir: home, osInfo: {}, env: {}, deviceId: 'test', agentVersion: 'test',
    historyEnabled: false, includeHistory: false, projectsEnabled: false, wslScanEnabled: false,
    codexLocalUsageEnabled: false, runTokscale: async () => ({ entries: [] })
  };
  for (const selection of [
    { sourceSelfSync: ['cursor'] },
    { forceSelfSync: ['cursor'] },
    { forceSelfSync: true },
    { forceSelfSync: ['antigravity'], sourceSelfSync: ['cursor'] },
    { forceSelfSync: ['cursor'], selfSyncTimeoutMs: 1234 }
  ]) {
    // Each case uses a new clock instant beyond both sync floors.
    t.mock.method(Date, 'now', () => 2_000_000 + calls.length * 1_000_000);
    await collectUsageOnce({ ...options, ...selection });
  }
  assert.deepEqual(calls, [150_000, 1_830_000, 1_830_000, 150_000, 1234]);
});
