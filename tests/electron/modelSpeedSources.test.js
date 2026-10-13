'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../../src/electron/modelSpeedHistory');
const sources = require('../../src/electron/modelSpeedSources');
const { createModelSpeedRuntime } = require('../../src/electron/modelSpeedRuntime');

const start = new Date(2026, 9, 8, 12).getTime();
const source = 'a'.repeat(64), model = 'shared-model';
const range = { start: start - 60000, end: start + 1800000 };
const row = (account, accessType, out = 1000, ms = 10000, platform = 'platform-a') => ({
  model, client: 'dsh', platform, accountId: `sha256:${account.repeat(64)}`, accountLabel: 'Same name', accessType,
  timedOutputTokens: out, timedDurationMs: ms
});
function observation(rows, at = start) {
  const map = Object.fromEntries(rows.map((value, index) => [index, value]));
  const period = { modelSourceThroughput: map,
    modelThroughput: { [model]: { timedOutputTokens: rows.reduce((sum, value) => sum + value.timedOutputTokens, 0),
      timedDurationMs: rows.reduce((sum, value) => sum + value.timedDurationMs, 0) } },
    modelUsageSources: Object.fromEntries(rows.map((value, index) => [index, { ...value, outputTokens: value.timedOutputTokens,
      lastUsedAt: new Date(at).toISOString() }])) };
  return { source, day: '2026-10-08', at, allTime: period, today: period };
}
test('same model separates platform, account and subscription/API without credentials', () => {
  const rows = [row('a', 'subscription'), row('b', 'subscription'), row('a', 'api'), row('a', 'api', 1000, 10000, 'platform-b')];
  let state = sources.ingest(sources.fresh(), observation(rows)).state;
  state = sources.ingest(state, observation(rows.map(value => ({ ...value, timedOutputTokens: 1300, timedDurationMs: 13000 })), start + 300000)).state;
  const detail = sources.project(state, { source, model, range });
  assert.equal(detail.length, 4);
  assert.equal(new Set(detail.map(value => value.id)).size, 4);
  assert.equal(new Set(detail.map(value => value.accountTag)).size, 3);
  for (const value of detail) {
    assert.equal(value.weightedTps, null);
    assert.equal(value.samples, 0);
    assert.equal(value.timedOutputTokens, 0);
    assert.equal(value.timedDurationMs, 0);
    assert.equal(value.referenceOnly, true);
    assert.equal(Object.hasOwn(value, 'accountId'), false);
  }
  assert.equal(JSON.stringify(state).includes(rows[0].accountId), false);
  assert.equal(sources.normalize(state).valid, true);
});
test('sources use selected window, duplicates survive restart without becoming samples', () => {
  let state = sources.ingest(sources.fresh(), observation([row('a', 'api')])).state;
  const second = observation([row('a', 'api', 2000, 20000)], start + 300000);
  state = sources.ingest(state, second).state;
  state = sources.normalize(JSON.parse(JSON.stringify(state))).state;
  const replay = sources.ingest(state, { ...second, at: start + 300001 });
  assert.equal(replay.changed, false);
  const detail = sources.project(replay.state, { source, model, range });
  assert.equal(detail[0].samples, 1);
  assert.equal(detail[0].timedOutputTokens, 1000);
  const outside = sources.project(replay.state, { source, model, range: { start: start + 3600000, end: start + 7200000 } });
  assert.deepEqual(outside, []);
});
test('missing identity stays unknown, labels cannot expose credentials', () => {
  const unidentified = { model, client: 'dsh', platform: 'magpie', timedOutputTokens: 1000, timedDurationMs: 10000,
    accountLabel: 'Bearer sk-secret-account-do-not-display', apiKey: 'do-not-display' };
  let state = sources.ingest(sources.fresh(), observation([unidentified])).state;
  state = sources.ingest(state, observation([{ ...unidentified, timedOutputTokens: 2000, timedDurationMs: 20000 }], start + 300000)).state;
  const detail = sources.project(state, { source, model, range });
  assert.equal(detail[0].platform, 'magpie');
  assert.equal(detail[0].accessType, 'unknown');
  assert.equal(detail[0].accountTag, '');
  assert.equal(detail[0].accountLabel, '');
  assert.equal(JSON.stringify(state).includes('do-not-display'), false);
});
test('attribution absence does not bridge unobserved counters or erase prior source samples', () => {
  let state = sources.ingest(sources.fresh(), observation([row('a', 'api')])).state;
  state = sources.ingest(state, observation([row('a', 'api', 2000, 20000)], start + 300000)).state;
  state = sources.ingest(state, { ...observation([], start + 600000), allTime: {}, today: {} }).state;
  state = sources.ingest(state, observation([row('a', 'api', 6000, 60000)], start + 900000)).state;
  const detail = sources.project(state, { source, model, range });
  assert.equal(detail[0].samples, 1);
  assert.equal(detail[0].timedOutputTokens, 1000);
});
test('historical ownership transfers and masked transfers never create source speed samples', () => {
  for (const next of [
    [row('a', 'api', 1000, 10000)],
    [row('a', 'api', 300, 3000), row('b', 'unknown', 1100, 11000)]
  ]) {
    let state = sources.ingest(sources.fresh(), observation([row('a', 'api', 100, 1000), row('b', 'unknown', 900, 9000)])).state;
    state = sources.ingest(state, observation(next, start + 300000)).state;
    const detail = sources.project(state, { source, model, range });
    assert.ok(detail.every(value => value.samples === 0 && value.weightedTps === null));
    assert.ok(Object.values(state.history.series).every(value => value.points.length === 0));
    assert.equal(sources.normalize(state).valid, true);
  }
});
test('owner changes and invalid snapshots clear pending and survive restart without bridging', () => {
  let state = sources.ingest(sources.fresh(), observation([row('a', 'api')])).state;
  state = sources.ingest(state, observation([row('a', 'api', 1030, 10300)], start + 60000)).state;
  assert.equal(Object.values(state.history.series)[0].pending.out, 30);
  const invalid = observation([row('a', 'api', 1200, 12000)], start + 120000);
  invalid.today.modelThroughput[model].timedOutputTokens = 1100;
  state = sources.ingest(state, invalid).state;
  state = sources.normalize(JSON.parse(JSON.stringify(state))).state;
  assert.equal(state.totals.models[model].owner, null);
  assert.equal(Object.values(state.history.series)[0].pending.out, 0);
  state = sources.ingest(state, observation([row('a', 'api', 2000, 20000)], start + 180000)).state;
  assert.equal(sources.project(state, { source, model, range })[0].samples, 0);
  state = sources.ingest(state, observation([row('a', 'api', 2300, 23000)], start + 300000)).state;
  assert.equal(sources.project(state, { source, model, range })[0].timedOutputTokens, 300);
});
test('native counter high-water reset cannot become an account sample on recovery', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-speed-sources-reset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let at = start;
  const runtime = createModelSpeedRuntime({ directory, now: () => at });
  for (const out of [1000, 500, 1000, 1300]) {
    const period = observation([row('a', 'api', out, out * 10)], at).allTime;
    runtime.observe({ allTime: period, today: period, month: period }, { source: 'fixture' });
    at += 300000;
  }
  const id = runtime.list().models[0].id;
  const detail = runtime.detail(id, { period: 'allTime' });
  assert.equal(detail.samples, 1);
  assert.equal(detail.sources.find(value => value.accessType === 'api').timedOutputTokens, 300);
});
test('legacy samples retain explicit unknown attribution and speed history compatibility', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-speed-sources-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let at = start;
  const runtime = createModelSpeedRuntime({ directory, now: () => at });
  function record(out, ms, sourceRows) {
    const period = { models: { [model]: out }, modelOutputs: { [model]: out },
      modelThroughput: { [model]: { timedOutputTokens: out, timedDurationMs: ms } },
      ...(sourceRows ? { modelSourceThroughput: sourceRows } : {}) };
    return { today: period, allTime: period, month: period };
  }
  runtime.observe(record(1000, 10000), { source: 'fixture' });
  at += 300000; runtime.observe(record(2000, 20000), { source: 'fixture' });
  const id = runtime.list().models[0].id;
  let detail = runtime.detail(id, { period: 'allTime' });
  assert.equal(detail.weightedTps, 100);
  assert.equal(detail.sources[0].id, 'unattributed');
  at += 300000; runtime.observe(record(2000, 20000, { a: row('a', 'api', 2000, 20000) }), { source: 'fixture' });
  at += 300000; runtime.observe(record(3000, 30000, { a: row('a', 'api', 3000, 30000) }), { source: 'fixture' });
  detail = runtime.detail(id, { period: 'allTime' });
  assert.equal(detail.sources.length, 2);
  assert.equal(detail.sources.find(value => value.accessType === 'api').timedOutputTokens, 1000);
  assert.equal(detail.sources.find(value => value.id === 'unattributed').timedOutputTokens, 1000);
  const restarted = createModelSpeedRuntime({ directory, now: () => at });
  assert.deepEqual(restarted.detail(id, { period: 'allTime' }).sources, detail.sources);
  const stored = JSON.parse(fs.readFileSync(runtime.file, 'utf8'));
  assert.equal(core.normalize(stored).valid, true);
  delete stored.sources;
  fs.writeFileSync(runtime.file, JSON.stringify(stored));
  const legacy = createModelSpeedRuntime({ directory, now: () => at });
  assert.equal(legacy.detail(id, { period: 'allTime' }).weightedTps, 100);
  assert.equal(legacy.detail(id, { period: 'allTime' }).sources[0].timedOutputTokens, 2000);
});

const reference = (account, at, platform = 'platform-a') => ({ ...row(account, 'subscription', 1000, 10000, platform),
  outputTokens: 1000, ...(at === null ? {} : { lastUsedAt: new Date(at).toISOString() }) });
const catalog = rows => ({ modelUsageSources: Object.fromEntries(rows.map((value, index) => [index, value])) });

test('untimed sources persist as references and follow today, month and retained ranges', () => {
  const yesterday = start - 86400000, lastMonth = new Date(2026, 8, 30, 12).getTime();
  const observation = { source, day: '2026-10-08', at: start,
    today: catalog([reference('a', start - 1000)]),
    month: catalog([reference('a', start - 1000), reference('b', yesterday)]),
    allTime: catalog([reference('a', start - 1000), reference('b', yesterday), reference('c', lastMonth, 'platform-b')]) };
  const captured = sources.ingest(sources.fresh(), observation);
  const restarted = sources.normalize(JSON.parse(JSON.stringify(captured.state)));
  assert.equal(restarted.valid, true);
  const replay = sources.ingest(restarted.state, { ...observation, at: start + 300000 });
  assert.equal(replay.changed, false);
  assert.equal(replay.state.references.at, start);
  const query = (period, from) => sources.project(replay.state, { source, model,
    range: { period, start: from, end: start } });
  const today = query('today', new Date(2026, 9, 8).getTime());
  assert.equal(today.length, 1);
  assert.equal(query('month', new Date(2026, 9, 1).getTime()).length, 2);
  assert.equal(query('allTime', start - 89 * 86400000).length, 3);
  assert.equal(query('last7', start - 6 * 86400000).length, 2);
  assert.equal(today[0].referenceOnly, true);
  assert.equal(today[0].weightedTps, null);
  assert.equal(today[0].timedDurationMs, 0);
  assert.equal(Object.keys(replay.state.history.series).length, 0);
  assert.deepEqual(sources.project(replay.state, { source: 'b'.repeat(64), model, range }), []);
  assert.deepEqual(sources.project(replay.state, { source, model,
    range: { period: 'today', start: start + 86400000, end: start + 86500000 } }), []);
});

test('timestamp-free references only belong to their current calendar scan', () => {
  const period = catalog([reference('a', null)]);
  const state = sources.ingest(sources.fresh(), { source, day: '2026-10-08', at: start,
    today: period, month: period, allTime: period }).state;
  for (const selected of ['today', 'month']) {
    assert.equal(sources.project(state, { source, model, range: { ...range, period: selected } }).length, 1);
  }
  assert.deepEqual(sources.project(state, { source, model, range: { ...range, period: 'last30' } }), []);
  assert.deepEqual(sources.project(state, { source, model,
    range: { period: 'month', start: new Date(2026, 10, 1).getTime(), end: new Date(2026, 10, 2).getTime() } }), []);
  const invalid = JSON.parse(JSON.stringify(state));
  Object.values(invalid.references.periods.today)[0].lastUsedAt = '2026-10-08';
  assert.equal(sources.normalize(invalid).valid, false);
});

test('runtime exposes untimed historical sources without fabricating a speed sample', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-speed-reference-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = createModelSpeedRuntime({ directory, now: () => start });
  const period = { ...catalog([reference('a', start - 1000), reference('b', start - 2000, 'platform-b')]),
    models: { [model]: 2000 }, modelOutputs: { [model]: 2000 } };
  runtime.observe({ today: period, month: period, allTime: period }, { source: 'fixture' });
  const id = runtime.list({ period: 'today' }).models[0].id;
  const detail = runtime.detail(id, { period: 'today' });
  assert.equal(detail.weightedTps, null);
  assert.equal(detail.sources.length, 2);
  assert.ok(detail.sources.every(value => value.referenceOnly && value.weightedTps === null));
  const persisted = JSON.parse(fs.readFileSync(runtime.file, 'utf8'));
  assert.equal(core.normalize(persisted).valid, true);
  assert.equal(sources.normalize(persisted.sources).valid, true);
  assert.equal(Object.keys(persisted.series).length, 0);
  assert.equal(JSON.stringify(persisted).includes('sha256:'), false);
});
