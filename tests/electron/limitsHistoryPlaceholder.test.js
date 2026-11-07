'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLimitsHistoryStore } = require('../../src/electron/limits/historyStore');

test('a quota window with no numeric reading keeps a 0% placeholder card', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-placeholder-'));
  const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'));
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const provider = {
    provider: 'antigravity', accountKey: 'account-a', status: 'ok',
    updatedAt: new Date().toISOString(),
    windows: [{
      kind: 'session', label: 'Claude/GPT 5-hour', usedPercent: null, remainingPercent: null,
      showMeter: false, resetsAt: new Date(Date.now() + 3_600_000).toISOString()
    }]
  };
  await store.record('local', { providers: [provider] });
  const result = await store.query('local', provider);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].placeholder, true);
  assert.equal(result.windows[0].unit, 'pp');
  assert.deepEqual(result.windows[0].points, []);
});
