'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPreferences } = require('../../plugins/quota-alerts/preferences.cjs');
const { createBackend } = require('../../plugins/quota-alerts/backend.cjs');
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-prefs-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('durable preferences validate patches and revision conflicts without enabling on startup', t => {
  const dir = directory(t), prefs = createPreferences(dir);
  assert.equal(prefs.get().values.lowQuota, false);
  assert.equal(prefs.get().values.recovery, false);
  const saved = prefs.update({ expectedRevision: 0, patch: { lowQuota: true, threshold: 15 } });
  assert.deepEqual(createPreferences(dir).get(), saved);
  assert.throws(() => prefs.update({ expectedRevision: 0, patch: { recovery: true } }));
  for (const patch of [{ threshold: 0 }, { threshold: '' }, { removedField: true }, { lowQuota: 'yes' }, { privateHostKey: true }]) {
    assert.throws(() => prefs.update({ expectedRevision: 1, patch }));
    assert.deepEqual(prefs.get(), saved);
  }
});
test('failed durable write leaves revision/value unchanged', t => {
  const dir = directory(t), prefs = createPreferences(dir), before = prefs.get();
  fs.mkdirSync(path.join(dir, 'preferences.json'));
  assert.throws(() => prefs.update({ expectedRevision: 0, patch: { lowQuota: true } }));
  assert.deepEqual(prefs.get(), before);
  assert.equal(fs.existsSync(path.join(dir, 'preferences.json.tmp')), false);
});
test('formal backend autosave immediately reevaluates quotas without host settings mutations', async t => {
  const dir = directory(t), calls = [];
  const backend = createBackend({ dataDirectory: dir, publish() {}, host: { async call(method) {
    calls.push(method);
    if (method === 'app.settings') return { language: 'en' };
    if (method === 'notify') return true;
    if (method === 'data.query') return { availability: 'available', freshness: { state: 'fresh' }, aggregateCoverage: { kind: 'authorizedCollection' }, rows: [{ provider: 'codex', providerLabel: 'Codex', accountId: 'fixture', identityAvailable: true, status: 'ok', updatedAt: new Date().toISOString(), windows: [{ kind: 'session', displayLabel: 'Session', remainingPercent: 7 }] }], pageInfo: { hasMore: false } };
    throw Error('Unexpected host authority');
  } } }, { intervalMs: 0 });
  await backend.start(); assert.equal(calls.includes('data.query'), false);
  const snapshot = backend.call('preferences.get');
  const saved = await backend.call('preferences.update', { expectedRevision: snapshot.revision, patch: { lowQuota: true } });
  assert.equal(saved.values.lowQuota, true); assert.ok(calls.includes('data.query'));
  assert.equal(calls.filter(method => method === 'notify').length, 1, 'enabling low-quota alerts alone delivers the low reading');
  await backend.call('refresh');
  assert.equal(calls.filter(method => method === 'notify').length, 1, 'the repeated low reading stays deduplicated');
  assert.equal(backend.call('status').state, 'monitoring');
  await backend.dispose();
});
test('ordinary repeated host contexts keep off state stable and do not start repeated scans', async t => {
  const dir = directory(t), states = [], calls = [];
  const backend = createBackend({ dataDirectory: dir, publish(value) { states.push(value.state); }, host: { async call(method) {
    calls.push(method); if (method === 'app.settings') return { language: 'en' }; throw Error('Unexpected operation');
  } } }, { intervalMs: 0 });
  await backend.start();
  await backend.update({ source: 'local', background: false, visible: true });
  const count = calls.length;
  for (let i=0;i<10;i++) await backend.update({ source: 'local', background: false, visible: true });
  assert.equal(calls.length, count);
  assert.equal(states.includes('updating'), false);
  assert.equal(backend.call('status').state, 'off');
  await backend.dispose();
});
test('manual notification test works with both alerts off without querying quota or changing preferences and dedup', async t => {
  const dir = directory(t), notices = [];
  const backend = createBackend({ dataDirectory: dir, publish() {}, host: { async call(method, value) {
    if (method === 'app.settings') return { language: 'zh-TW' };
    if (method === 'notify') { notices.push(value); return true; }
    throw Error('No quota/network calls allowed');
  } } }, { intervalMs: 0 });
  t.after(() => backend.dispose());
  const before = backend.call('preferences.get');
  assert.equal(before.values.lowQuota, false); assert.equal(before.values.recovery, false);
  const result = await backend.call('notification.test');
  assert.equal(result[0].status, 'submitted');
  assert.match(notices[0].title, /測試通知/); assert.match(notices[0].body, /不代表實際配額不足/);
  assert.deepEqual(backend.call('preferences.get'), before);
  assert.equal(fs.existsSync(path.join(dir, 'preferences.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'crossings.json')), false);
  assert.equal(notices.length, 1);
});
test('source changes clear old alerts and receipts before awaited replacement quota arrives', async t => {
  const dir = directory(t), prefs = createPreferences(dir);
  prefs.update({ expectedRevision: 0, patch: { lowQuota: true } });
  let pending = false, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const backend = createBackend({ dataDirectory: dir, publish() {}, host: { async call(method) {
    if (method === 'app.settings') return { language: 'en' };
    if (method === 'data.query') {
      if (pending) { entered(); return new Promise(resolve => { release = resolve; }); }
      return { availability: 'available', freshness: { state: 'fresh' }, aggregateCoverage: { kind: 'authorizedCollection' },
        rows: [{ provider: 'fixture', providerLabel: 'Fixture', identityAvailable: true, accountId: 'source-A', status: 'ok', updatedAt: new Date().toISOString(), windows: [{ kind: 'session', displayLabel: 'Session', remainingPercent: 3 }] }], pageInfo: { hasMore: false } };
    }
    throw Error('Unexpected host operation');
  } } }, { intervalMs: 0 });
  await backend.start(); await backend.update({ source: 'A' });
  assert.equal(backend.call('status').active.length, 1);
  assert.equal(backend.call('status').receipts.length, 1);
  pending = true; const refresh = backend.update({ source: 'B' }); await started;
  assert.deepEqual(backend.call('status').active, []);
  assert.deepEqual(backend.call('status').receipts, []);
  release({ availability: 'denied' }); await refresh; await backend.dispose();
});
