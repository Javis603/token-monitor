'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { captureCandidates, projectCandidates } = require('../../src/electron/modelSpeedCandidates');
const { createModelSpeedRuntime } = require('../../src/electron/modelSpeedRuntime');

const at = Date.parse('2026-10-08T04:00:00Z');
const source = 'a'.repeat(64);
const running = (models, extra = {}) => ({ models, lastUsedAt: new Date(at).toISOString(), ...extra });
const measured = (model, lastTps = 500) => ({
  id: `${source}:${model}`, model, lastTps, outputTpm: lastTps * 60,
  samples: 100, lastAt: at, status: 'stable', trend: []
});

test('an active untimed model participates ahead of an idle timed model without inventing a speed', () => {
  const candidates = captureCandidates({ today: {
    models: { quiet: 90000, muse: 5000 }, sessions: { child: running({ muse: 5000 }) }
  } }, source, at);
  const rows = projectCandidates([measured('quiet')], candidates, at);
  assert.deepEqual(rows.map((row) => row.model), ['muse', 'quiet']);
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].status, 'unmeasured');
  assert.equal(rows[0].lastTps, null);
  assert.equal(rows[0].outputTpm, null);
  assert.equal(rows[0].samples, 0);
  assert.deepEqual(rows[0].trend, []);
  assert.equal(rows[1].lastTps, 500);
});

test('candidate priority uses current usage rather than TPS, and preserves distinct raw model identities', () => {
  const candidates = captureCandidates({ today: { models: { a: 900, 'provider/a': 1000, c: 10 } } }, source, at);
  const rows = projectCandidates([measured('a', 5), measured('provider/a', 10), measured('c', 500)], candidates, at);
  assert.deepEqual(rows.map((row) => row.model), ['provider/a', 'a', 'c']);
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
});

test('multi-model, ended, archived and old sessions cannot promote an old model as currently active', () => {
  const candidates = captureCandidates({ today: {
    models: { old: 500, fresh: 50, ended: 100, archived: 100, stale: 100 },
    sessions: {
      mixed: running({ old: 500, fresh: 50 }), ended: running({ ended: 100 }, { turnEnded: true }),
      archived: running({ archived: 100 }, { archived: true }),
      stale: running({ stale: 100 }, { lastUsedAt: new Date(at - 3600000).toISOString() }),
      child: running({ fresh: 50 })
    }
  } }, source, at);
  const rows = projectCandidates([], candidates, at);
  assert.deepEqual(rows.filter((row) => row.active).map((row) => row.model), ['fresh']);
  assert.equal(projectCandidates([], candidates, at + 3600000).some((row) => row.active), false);
});

test('today ended and multi-model snapshots replace a monthly session before active attribution', () => {
  for (const newer of [
    running({ old: 500 }, { turnEnded: true }),
    running({ old: 500, fresh: 50 }),
    running({ old: 500 }, { archived: true })
  ]) {
    const record = {
      month: { sessions: { shared: running({ old: 500 }) } },
      today: { models: { old: 500, fresh: 50 }, sessions: { shared: newer } }
    };
    const rows = projectCandidates([], captureCandidates(record, source, at), at);
    assert.equal(rows.some(row => row.active), false, 'an older monthly running snapshot cannot override today');
    assert.deepEqual(rows.map(row => row.model), ['old', 'fresh']);
  }
});

test('invalid and empty usage identifiers never become candidate detail IDs', () => {
  const rows = captureCandidates({ today: { models: {
    '': 50, ['x'.repeat(201)]: 20, ['bad\nname']: 10, negative: -1, nan: NaN, zero: 0, valid: 10
  } } }, source, at);
  assert.deepEqual([...rows.values()].map((row) => row.model), ['valid']);
});

test('runtime keeps untimed candidates out of persisted history and promotes the same detail ID when timing arrives', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-candidates-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = at;
  const runtime = createModelSpeedRuntime({ directory, now: () => clock });
  const record = (out, ms) => {
    const throughput = out === undefined ? {} : { muse: { timedTokens: out + 2000, timedOutputTokens: out, timedDurationMs: ms } };
    const period = { models: { muse: 5000 }, sessions: { child: running({ muse: 5000 }) }, modelThroughput: throughput };
    return { today: period, allTime: period };
  };
  runtime.observe(record(), { source: 'local' });
  const id = runtime.summary().models[0].id;
  assert.equal(runtime.summary().models[0].status, 'unmeasured');
  assert.equal(runtime.detail(id, { period: 'last7' }).weightedTps, null);
  assert.equal(runtime.detail(id, { period: 'last7' }).status, 'unmeasured');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(runtime.file)).series).length, 0);
  const persisted = fs.readFileSync(runtime.file, 'utf8');
  assert.equal(runtime.observe(record(), { source: 'local' }), false);
  assert.equal(fs.readFileSync(runtime.file, 'utf8'), persisted);
  clock += 1000;
  runtime.observe(record(100, 1000), { source: 'local' });
  assert.equal(runtime.summary().models[0].id, id);
  assert.equal(runtime.detail(id, { period: 'last7' }).samples, 0, 'the first paired reading is only an anchor');
  clock += 1000;
  runtime.observe(record(300, 3000), { source: 'local' });
  assert.equal(runtime.detail(id, { period: 'last7' }).samples, 1);
  assert.equal(runtime.detail(id, { period: 'last7' }).weightedTps, 100);
});

test('preview and collector-source changes cannot leak an old candidate into a new context', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-candidates-context-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = createModelSpeedRuntime({ directory, now: () => at });
  const record = { today: { models: { muse: 5000 } }, allTime: {} };
  assert.equal(runtime.observe(record, { source: 'A', preview: true }), false);
  assert.equal(runtime.summary().models.length, 0);
  runtime.observe(record, { source: 'A' });
  const id = runtime.summary().models[0].id;
  runtime.observe({ today: { models: { another: 4000 } }, allTime: {} }, { source: 'B' });
  assert.deepEqual(runtime.summary().models.map((row) => row.model), ['another']);
  assert.equal(runtime.detail(id, { period: 'last7' }), null);
});

test('an expired anchor without measured samples stays unmeasured when its candidate detail opens', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-candidates-expired-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = at;
  const runtime = createModelSpeedRuntime({ directory, now: () => clock });
  const period = { models: { muse: 500 }, modelThroughput: {
    muse: { timedTokens: 100, timedOutputTokens: 100, timedDurationMs: 1000 }
  } };
  runtime.observe({ today: period, allTime: period }, { source: 'local' });
  const id = runtime.summary().models[0].id;
  assert.equal(runtime.summary().models[0].lastTps, 100);
  clock += 2 * 86400000;
  runtime.observe({ today: { models: { muse: 800 } }, allTime: {} }, { source: 'local' });
  const summary = runtime.summary().models[0];
  const detail = runtime.detail(id, { period: 'last7' });
  assert.equal(summary.status, 'unmeasured');
  assert.equal(detail.status, summary.status);
  assert.equal(detail.lastTps, null);
  assert.equal(detail.weightedTps, null);
  assert.equal(detail.samples, 0);
  assert.deepEqual(detail.trend, []);
});
