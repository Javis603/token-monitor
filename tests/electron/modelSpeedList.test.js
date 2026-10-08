'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createModelSpeedRuntime } = require('../../src/electron/modelSpeedRuntime');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-speed-list-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clock = { at: Date.parse('2026-10-08T04:00:00Z') };
  return { directory, clock, runtime: createModelSpeedRuntime({ directory, now: () => clock.at }) };
}
test('all-model list includes lifetime and month usage without expanding the Home preview', t => {
  const { runtime, clock } = fixture(t);
  const allTime = { models: Object.fromEntries(Array.from({ length: 18 }, (_, i) => ['model-' + i, 100 + i])) };
  const record = { allTime, month: { models: { 'month-only': 100 } },
    today: { models: { active: 20 }, sessions: { one: { models: { active: 20 }, lastUsedAt: new Date(clock.at).toISOString() } } } };
  runtime.observe(record, { source: 'local' });
  const list = runtime.list(), summary = runtime.summary();
  assert.equal(list.models.length, 20); assert.equal(list.candidateCount, 20);
  assert.equal(summary.models.length, 5); assert.equal(summary.candidateCount, 20);
  assert.deepEqual(summary.models, list.models.slice(0, 5));
  assert.equal(list.models[0].model, 'active');
  const older = list.models.find(row => row.model === 'model-17');
  assert.equal(older.active, false); assert.equal(older.todayTokens, 0);
  assert.equal(older.lastTps, null); assert.equal(older.status, 'unmeasured');
  assert.equal(runtime.detail(older.id, { period: 'last7' }).weightedTps, null);
});
test('listing never changes private history or invents persisted untimed series', t => {
  const { runtime } = fixture(t);
  runtime.observe({ allTime: { models: { past: 100 } }, today: {} }, { source: 'local' });
  const bytes = fs.readFileSync(runtime.file), revision = runtime.revision();
  for (let i=0;i<5;i++) { const row=runtime.list().models[0]; runtime.detail(row.id, { period: 'last30' }); runtime.summary(); }
  assert.deepEqual(fs.readFileSync(runtime.file), bytes);
  assert.equal(runtime.revision(), revision);
  assert.deepEqual(JSON.parse(bytes).series, {});
  assert.equal(JSON.parse(bytes).version, 1);
});
test('a restart rebuilds historical membership from its own source and refuses old-source details', t => {
  const { runtime, directory, clock } = fixture(t);
  const record = { allTime: { models: { past: 100, 'provider/past': 200 } }, today: {} };
  runtime.observe(record, { source: 'A' });
  const oldId = runtime.list().models[0].id;
  const reloaded = createModelSpeedRuntime({ directory, now: () => clock.at });
  reloaded.observe(record, { source: 'A' });
  assert.equal(reloaded.list().models.length, 2);
  assert.equal(new Set(reloaded.list().models.map(row => row.id)).size, 2);
  assert.equal(reloaded.detail(oldId, { period: 'last7' }).status, 'unmeasured');
  reloaded.observe({ allTime: { models: { another: 10 } }, today: {} }, { source: 'B' });
  assert.deepEqual(reloaded.list().models.map(row => row.model), ['another']);
  assert.equal(reloaded.detail(oldId, { period: 'last7' }), null);
});
test('persisted source identity is opaque, stable on restart and cannot bridge a changed source', t => {
  const { runtime, directory, clock } = fixture(t);
  const source = 'fixture-private-device-and-client-scope';
  const record = out => { const p = { modelThroughput: { timed: { timedOutputTokens: out, timedDurationMs: out * 10 } } }; return { allTime: p, today: p }; };
  runtime.observe(record(100), { source }); clock.at += 1000; runtime.observe(record(300), { source });
  const old = runtime.list().models[0];
  assert.equal(old.samples, 1);
  assert.match(old.id, /^[a-f0-9]{64}:timed$/);
  assert.ok(!fs.readFileSync(runtime.file, 'utf8').includes(source));
  const reloaded = createModelSpeedRuntime({ directory, now: () => clock.at });
  reloaded.observe(record(300), { source });
  assert.equal(reloaded.list().models[0].id, old.id);
  assert.equal(reloaded.list().models[0].samples, 1);
  clock.at += 1000; reloaded.observe(record(900), { source: 'fixture-other-device' });
  assert.equal(reloaded.detail(old.id), null);
  assert.equal(reloaded.list().models[0].samples, 0, 'changed sources re-anchor instead of manufacturing output');
});
test('measured history remains visible even when current model usage maps omit it', t => {
  const { runtime, clock } = fixture(t);
  const record = out => { const p = { modelThroughput: { timed: { timedOutputTokens: out, timedDurationMs: out * 10 } } }; return { allTime: p, today: p }; };
  runtime.observe(record(100), { source: 'local' }); clock.at += 1000;
  runtime.observe(record(300), { source: 'local' });
  runtime.observe({ allTime: { models: { older: 10 } }, today: {} }, { source: 'local' });
  const rows = runtime.list().models;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.model === 'timed').lastTps, 100);
  assert.equal(rows.find(row => row.model === 'older').lastTps, null);
});
test('all-model IPC refuses untrusted senders before reading any data', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const handler = source.match(/ipcMain.handle\('modelSpeed:list'[\s\S]*?\n {2}\}\);/)?.[0];
  let callback, reads = 0, seenRange = null;
  vm.runInNewContext(handler, { ipcMain: { handle(_name, fn) { callback = fn; } },
    require: () => ({ trustedSender: event => event.allowed === true }), mainWindow: {}, path, __dirname,
    // The renderer's period is resolved into one range by main; the handler
    // must pass that range down rather than letting the list pick its own.
    modelSpeedRangeOptions: (period) => ({ period: period || 'today', weekStartsOn: 1 }),
    modelSpeedRuntime: { list(options) { reads++; seenRange = options; return { models: [] }; } } });
  assert.throws(() => callback({ allowed: false }), /UNTRUSTED_SPEED_SENDER/);
  assert.equal(reads, 0); assert.equal(callback({ allowed: true }).models.length, 0); assert.equal(reads, 1);
  assert.equal(seenRange.period, 'today');
  callback({ allowed: true }, { period: 'last30' });
  assert.equal(seenRange.period, 'last30', 'the requested period reaches the runtime');
});
