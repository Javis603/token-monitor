'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluate } = require('../../plugins/quota-alerts/evaluator.cjs');
const { createBackend } = require('../../plugins/quota-alerts/backend.cjs');
const { createPreferences } = require('../../plugins/quota-alerts/preferences.cjs');
const { createBusinessDataService } = require('../../src/electron/plugins/businessData');
const start = Date.parse('2026-10-30T02:00:00Z');
const window = (displayLabel, remainingPercent, resetsAt) => ({ kind: 'session', displayLabel, remainingPercent, resetsAt });
function sequence() {
  const alerted = new Set(), observations = new Map();
  return (windows, seconds) => evaluate([{ provider: 'codex', providerLabel: 'Codex', accountId: 'fixture', identityAvailable: true,
    status: 'ok', updatedAt: new Date(start + seconds * 1000).toISOString(), windows }], 10, alerted, start + seconds * 1000, observations).triggered.map(a => a.event);
}
test('removed and returning session windows establish new baselines rather than proving recovery', () => {
  const scan = sequence();
  assert.deepEqual(scan([window('5-hour', 7), window('Named pool', 100)], 0), ['low']);
  assert.deepEqual(scan([window('Named pool', 100)], 1), []);
  assert.deepEqual(scan([window('Named pool', 100)], 2), []);
  assert.deepEqual(scan([window('5-hour', 100), window('Named pool', 100)], 3), []);
  assert.deepEqual(scan([window('5-hour', 80), window('Named pool', 100)], 4), []);
  assert.deepEqual(scan([window('5-hour', 100), window('Named pool', 100)], 5), ['full']);
});
test('adding a session pool does not announce recovery but later transitions still notify', () => {
  const scan = sequence();
  assert.deepEqual(scan([window('Session', 7)], 0), ['low']);
  assert.deepEqual(scan([window('Session', 100), window('New pool', 100)], 1), []);
  assert.deepEqual(scan([window('New pool', 90), window('Session', 100)], 2), []);
  assert.deepEqual(scan([window('Session', 100), window('New pool', 100)], 3), ['full']);
});
test('reordering duplicates and normal reset-time changes preserve recovery comparisons', () => {
  const scan = sequence();
  assert.deepEqual(scan([window('Pool', 100), window('Session', 7, new Date(start + 60000).toISOString()), window('Pool', 100)], 0), ['low']);
  assert.deepEqual(scan([window('Pool', 100), window('Session', 100, new Date(start + 3600000).toISOString()), window('Pool', 100)], 90), ['full']);
});
test('removing a same-name session window establishes a silent baseline and later full transitions still notify', () => {
  const scan = sequence();
  assert.deepEqual(scan([window('Session', 7), window('Session', 100)], 0), ['low']);
  assert.deepEqual(scan([window('Session', 100)], 1), []);
  assert.deepEqual(scan([window('Session', 100)], 2), []);
  assert.deepEqual(scan([window('Session', 80)], 3), []);
  assert.deepEqual(scan([window('Session', 100)], 4), ['full']);
});
test('adding an indistinguishable session window establishes a new baseline', () => {
  const scan = sequence();
  assert.deepEqual(scan([window('Session', 7)], 0), ['low']);
  assert.deepEqual(scan([window('Session', 100), window('Session', 100)], 1), []);
  assert.deepEqual(scan([window('Session', 100), window('Session', 80)], 2), []);
  assert.deepEqual(scan([window('Session', 100), window('Session', 100)], 3), ['full']);
});
test('removing a request quota cannot announce that the remaining token quota recovered', () => {
  const quota = (metric, remainingPercent) => ({ ...window('Session', remainingPercent), metric, windowMinutes: 300 });
  const scan = sequence();
  assert.deepEqual(scan([quota('requests', 5), quota('tokens', 100)], 0), ['low']);
  assert.deepEqual(scan([quota('tokens', 100)], 1), []);
});
test('request and token session quotas stay distinct even with equal labels, durations and counts', () => {
  const quota = (metric, remainingPercent) => ({ ...window('Session', remainingPercent), metric, windowMinutes: 300 });
  const replacement = sequence();
  assert.deepEqual(replacement([quota('requests', 5)], 0), ['low']);
  assert.deepEqual(replacement([quota('tokens', 100)], 1), []);
  assert.deepEqual(replacement([quota('tokens', 80)], 2), []);
  assert.deepEqual(replacement([quota('tokens', 100)], 3), ['full']);
});
test('web/local source changes do not change pool identity or prevent legitimate recovery', () => {
  const scan = sequence();
  assert.deepEqual(scan([{ ...window('Session', 7), metric: 'tokens', source: 'web' }], 0), ['low']);
  assert.deepEqual(scan([{ ...window('Session', 100), metric: 'tokens', source: 'local' }], 1), ['full']);
});
for (const usageTime of [new Date(start).toISOString(), null]) test(`fresh quota updates work independently of the usage snapshot clock (${usageTime})`, async t => {
  let now = start;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fresh-limits-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const service = createBusinessDataService({ now: () => now }); t.after(() => service.dispose());
  const notices = [];
  const publish = (remaining, updatedAt = now) => service.publish({ updatedAt: usageTime, limits: { providers: [{ provider: 'codex', accountKey: 'fixture', status: 'ok', updatedAt: new Date(updatedAt).toISOString(), windows: [window('Session', remaining)] }] } });
  const auth = () => ({ pluginId: 'quota-alerts', active: true, revision: 1 });
  const preferences = createPreferences(directory); preferences.update({ expectedRevision: 0, patch: { lowQuota: true, recovery: true } });
  const backend = createBackend({ dataDirectory: directory, publish() {}, host: { async call(method, args) {
    if (method === 'app.settings') return { language: 'en' };
    if (method === 'data.query') return service.query({ version: 1, ...args }, auth);
    assert.equal(method, 'notify'); notices.push(args); return true;
  } } }, { now: () => now, intervalMs: 0 }); t.after(() => backend.dispose());
  publish(5); await backend.start(); assert.equal(notices.length, 1);
  now += 180000; publish(100);
  const envelope = await service.query({ version: 1, resource: 'limits' }, auth);
  assert.equal(envelope.freshness.state, usageTime ? 'stale' : 'unknown');
  await backend.call('refresh'); assert.equal(backend.call('status').state, 'monitoring');
  assert.equal(notices.length, 2); assert.match(notices[1].title, /quota full/);
  now += 1000; publish(5, now - 16 * 60000); await backend.call('refresh');
  assert.equal(notices.length, 2, 'stale quota rows themselves must still be rejected');
});
