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
      showMeter: false, placeholder: true, resetsAt: new Date(Date.now() + 3_600_000).toISOString()
    }]
  };
  await store.record('local', { providers: [provider] });
  const result = await store.query('local', provider);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].placeholder, true);
  assert.equal(result.windows[0].unit, 'pp');
  assert.deepEqual(result.windows[0].points, []);
});

for (const mode of ['query', 'record']) test(`a verified placeholder adopts legacy percentage history on ${mode}`, async t => {
  const { createHash } = require('node:crypto');
  const { createHistoryDatabase } = require('../../src/electron/limits/historyDatabase');
  const { historyAccountKey } = require('../../src/electron/limits/historyIdentity');
  const { limitWindowKey } = require('../../src/shared/limits/usageItems');
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-placeholder-adoption-'));
  const file = path.join(directory, 'history.sqlite');
  const now = new Date(2026, 10, 3, 12).getTime();
  const provider = {
    provider: 'antigravity', accountKey: 'account-a', accountEmail: 'user@example.com', source: 'rpc',
    status: 'ok', updatedAt: new Date(now).toISOString(),
    windows: [{ kind: 'session', label: 'Claude/GPT 5-hour', placeholder: true, showMeter: false,
      usedPercent: null, remainingPercent: null, resetsAt: new Date(now + 3_600_000).toISOString() }]
  };
  const db = createHistoryDatabase(file);
  const legacy = hash(['local', historyAccountKey(provider), limitWindowKey(provider.windows[0]), 'pp']);
  db.record([{ account: hash(['local', historyAccountKey(provider)]), source: hash(['', 'rpc', '']),
    windows: [{ id: legacy, point: { at: now - 600_000, value: 30, unit: 'pp', balance: false,
      reset: Date.parse(provider.windows[0].resetsAt), interval: 300_000 } }] }], now);
  db.close();
  const store = createLimitsHistoryStore(file, { now: () => now });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  if (mode === 'record') await store.record('local', { providers: [provider] });
  const result = await store.query('local', provider);
  assert.equal(result.windows[0].placeholder, true);
  assert.deepEqual(result.windows[0].points.map(point => point.value), [30]);
  if (mode === 'record') assert.equal(result.windows[0].distribution.buckets.at(-1).uncertain, true);
});
