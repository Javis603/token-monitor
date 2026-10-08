'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('../../src/electron/modelSpeedHistory');
const { createModelSpeedRuntime } = require('../../src/electron/modelSpeedRuntime');
const source = 'a'.repeat(64), other = 'b'.repeat(64), model = 'group/auto-deepseek-v4-1-flash';
const t0 = Math.floor(new Date(2026, 9, 8, 10).getTime() / c.FIVE_MINUTES) * c.FIVE_MINUTES;
const period = (out, ms, name = model) => ({ modelThroughput: { [name]: { timedOutputTokens: out, timedDurationMs: ms, timedTokens: out + 1000000 } } });
const ingest = (s, out, ms, at, extra = {}) => c.ingest(s, { source, day: '2026-10-08', at,
  allTime: period(out, ms), today: period(out, ms), ...extra });
function populated() {
  const row = { model, source, anchor: { out: 10000, ms: 100000, todayOut: 10000, todayMs: 100000, day: '2026-10-08', at: t0 + 12 * c.FIVE_MINUTES },
    reference: { out: 10000, ms: 100000 }, referenceAt: t0, lastSampleAt: t0 + 12 * c.FIVE_MINUTES, pending: { out: 0, ms: 0 }, points: [], gaps: 0, rejected: 0 };
  for (let n = 0; n < 6; n++) row.points.push({ at: t0 + n * c.FIVE_MINUTES, span: c.FIVE_MINUTES, out: 1000, ms: 10000, n: 2 });
  return row;
}
test('first cumulative counters are references, not historical speed samples', () => {
  const r = ingest(c.fresh(), 100000, 1000000, t0);
  const view = c.project(r.state, t0)[0];
  assert.equal(view.samples, 0); assert.equal(view.status, 'learning'); assert.equal(view.lastTps, 100);
  assert.equal(view.outputTpm, 6000); assert.equal(view.trend.length, 0);
});
test('duplicates and persisted restart cannot add the same delta twice', () => {
  let s = ingest(c.fresh(), 100, 10000, t0).state;
  s = ingest(s, 300, 12000, t0 + 1000).state;
  assert.equal(c.project(s, t0 + 1000)[0].samples, 1);
  const reloaded = c.normalize(JSON.parse(JSON.stringify(s)));
  assert.equal(reloaded.valid, true);
  const dup = ingest(reloaded.state, 300, 12000, t0 + 2000);
  assert.equal(dup.changed, false); assert.equal(c.project(dup.state, t0 + 2000)[0].samples, 1);
});
test('output rate excludes input/cache and idle polls do not create zero rates', () => {
  let s = ingest(c.fresh(), 100, 1000, t0).state;
  s = ingest(s, 300, 5000, t0 + 1000).state;
  assert.equal(c.project(s, t0 + 1000)[0].lastTps, 50);
  for (let n = 2; n < 50; n++) s = ingest(s, 300, 5000, t0 + n * 1000).state;
  assert.equal(c.project(s, t0 + 50000)[0].samples, 1);
});
test('slow streaming increments accumulate instead of disappearing below the size threshold', () => {
  let s = ingest(c.fresh(), 100, 1000, t0).state;
  for (let n = 1; n <= 4; n++) s = ingest(s, 100 + n * 20, 1000 + n * 4000, t0 + n * 4000).state;
  const view = c.project(s, t0 + 16000)[0]; assert.equal(view.lastTps, 5); assert.equal(view.samples, 1);
});
test('100 -> 80 -> 100 does not replay a historical sample after reset', () => {
  let s = ingest(c.fresh(), 100, 1000, t0).state;
  s = ingest(s, 80, 800, t0 + 1000).state;
  s = ingest(c.normalize(JSON.parse(JSON.stringify(s))).state, 100, 1000, t0 + 2000).state;
  assert.equal(c.project(s, t0 + 2000)[0].samples, 0);
  s = ingest(s, 200, 2000, t0 + 3000).state;
  assert.equal(c.project(s, t0 + 3000)[0].samples, 1);
});
test('source changes and model namespaces never merge with aliases', () => {
  let s = ingest(c.fresh(), 100, 1000, t0).state;
  s = ingest(s, 1000, 10000, t0 + 1000, { source: other }).state;
  assert.equal(Object.keys(s.series).length, 2); assert.equal(c.project(s, t0 + 1000)[0].samples, 0);
  s = c.ingest(s, { source: other, day: '2026-10-08', at: t0 + 2000,
    allTime: { modelThroughput: { x: period(100, 1000).modelThroughput[model], 'provider/x': period(100, 1000).modelThroughput[model] } },
    today: { modelThroughput: { x: period(100, 1000).modelThroughput[model], 'provider/x': period(100, 1000).modelThroughput[model] } } }).state;
  assert.ok(Object.values(s.series).some(r => r.model === 'x')); assert.ok(Object.values(s.series).some(r => r.model === 'provider/x'));
});
test('historic imports and incomplete previews cannot masquerade as current generation', () => {
  const initial = ingest(c.fresh(), 100, 1000, t0).state;
  const r = ingest(initial, 300, 3000, t0 + 1000, { today: period(100, 1000) });
  assert.equal(c.project(r.state, t0 + 1000)[0].samples, 0);
  assert.equal(c.project(r.state, t0 + 1000)[0].status, 'insufficient');
});
test('midnight and long observation gaps re-anchor without fabricating dated samples', () => {
  let s = ingest(c.fresh(), 100, 1000, t0).state;
  s = ingest(s, 1000000, 10000000, t0 + c.HOUR).state;
  assert.equal(c.project(s, t0 + c.HOUR)[0].samples, 0);
  s = ingest(s, 1000100, 10001000, t0 + c.HOUR + 1000, { day: '2026-10-09', today: period(100, 1000) }).state;
  assert.equal(c.project(s, t0 + c.HOUR + 1000)[0].samples, 0);
});
test('weighted means combine measured output and durations rather than averaging rates', () => {
  const combined = c.sum([{ out: 100, ms: 1000, n: 1 }, { out: 100, ms: 10000, n: 1 }]);
  assert.equal(c.rate(combined), 200000 / 11000); assert.notEqual(c.rate(combined), 55);
});
test('three sustained slow windows flag a slowdown against sufficient disjoint baseline', () => {
  const r = populated();
  for (let n = 10; n < 13; n++) r.points.push({ at: t0 + n * c.FIVE_MINUTES, span: c.FIVE_MINUTES, out: 400, ms: 10000, n: 2 });
  const v = c.assess(r, t0 + 13 * c.FIVE_MINUTES);
  assert.equal(v.status, 'slower'); assert.equal(v.baselineTps, 100); assert.equal(v.changePercent, -60);
});
test('one transient slow window, sparse windows and idle never prove slowdown', () => {
  const r = populated();
  for (let n = 10; n < 13; n++) r.points.push({ at: t0 + n * c.FIVE_MINUTES, span: c.FIVE_MINUTES, out: n === 11 ? 400 : 1000, ms: 10000, n: 2 });
  assert.equal(c.assess(r, t0 + 13 * c.FIVE_MINUTES).status, 'stable');
  r.points.at(-1).at += c.FIVE_MINUTES;
  assert.equal(c.assess(r, t0 + 14 * c.FIVE_MINUTES).status, 'learning');
  assert.equal(c.assess(r, t0 + 10 * c.HOUR).status, 'insufficient');
});
test('recovered speeds clear the suspicion after three fresh windows', () => {
  const r = populated();
  for (let n = 10; n < 16; n++) r.points.push({ at: t0 + n * c.FIVE_MINUTES, span: c.FIVE_MINUTES, out: n < 13 ? 400 : 1000, ms: 10000, n: 2 });
  assert.equal(c.assess(r, t0 + 16 * c.FIVE_MINUTES).status, 'stable');
});
test('90-day retention prunes quiet series while keeping weighted hourly history', () => {
  const r = populated(), s = c.fresh(); s.activeSource = source; s.series[`${source}:${model}`] = r;
  const aged = c.ingest(s, { source, day: '2027-01-10', at: t0 + 94 * 86400000, allTime: {}, today: {} });
  assert.equal(aged.changed, true); assert.equal(aged.state.series[`${source}:${model}`].points.length, 0);
});
test('corrupt, unsafe and missing timings remain unavailable, never zero-speed evidence', () => {
  assert.equal(c.normalize({}).valid, false);
  for (const bad of [null, { timedOutputTokens: -1, timedDurationMs: 1000 }, { timedOutputTokens: Number.MAX_SAFE_INTEGER + 1, timedDurationMs: 1000 }, { timedOutputTokens: 100, timedDurationMs: '1000' }]) {
    const r = c.ingest(c.fresh(), { source, day: '2026-10-08', at: t0,
      allTime: { modelThroughput: { x: bad } }, today: { modelThroughput: { x: bad } } });
    assert.equal(c.project(r.state, t0).length, 0);
  }
});
test('main runtime persists privately and ignores preview; corrupt originals are preserved', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-speed-')); t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  let at = t0; const runtime = createModelSpeedRuntime({ directory, now: () => at });
  const record = { allTime: period(100, 1000), today: period(100, 1000) };
  assert.equal(runtime.observe(record, { source: 'local', preview: true }), false);
  assert.equal(fs.existsSync(runtime.file), false);
  runtime.observe(record, { source: 'local' });
  assert.equal(fs.statSync(runtime.file).mode & 0o777, 0o600);
  at += 1000; runtime.observe({ allTime: period(300, 3000), today: period(300, 3000) }, { source: 'local' });
  const reloaded = createModelSpeedRuntime({ directory, now: () => at });
  assert.equal(reloaded.summary().models[0].samples, 1);
  reloaded.observe({ allTime: period(300, 3000), today: period(300, 3000) }, { source: 'local' });
  assert.equal(reloaded.summary().models[0].samples, 1);
  fs.writeFileSync(runtime.file, 'not json');
  const corrupt = createModelSpeedRuntime({ directory, now: () => at });
  corrupt.observe(record, { source: 'local' }); assert.equal(corrupt.summary().state, 'paused');
  assert.equal(fs.readFileSync(runtime.file, 'utf8'), 'not json');
});

test('new home module appears after Sessions without overwriting existing custom order', () => {
  const prefs = require('../../src/electron/renderer/homeModulePreferences');
  const options = ['limits', 'model', 'trends', 'session', 'modelspeed'].map(id => ({ id }));
  assert.deepEqual(prefs.normalizeHomeModuleOrder('limits,model,trends,session', options), ['limits', 'model', 'trends', 'session', 'modelspeed']);
  assert.deepEqual(prefs.normalizeHomeModuleOrder('session,limits,model,trends', options), ['session', 'modelspeed', 'limits', 'model', 'trends']);
  assert.deepEqual(prefs.normalizeHomeModuleOrder('modelspeed,session,limits,model,trends', options), ['modelspeed', 'session', 'limits', 'model', 'trends']);
});
test('main collector hookup observes full updates with footer disabled and forwards callback results', () => {
  const vm = require('node:vm');
  const sourceCode = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const body = sourceCode.match(/function createElectronUsageRuntime\([^]*?\n\}/)[0];
  const seen = []; let captured;
  const create = vm.runInNewContext(`(${body})`, { latestUsageHost: null, modelSpeedRuntime: { observe: (record, meta) => seen.push({ record, meta }) },
    settings: { showLiveTokenRate: false, deviceId: 'local', clients: 'codex', hubMode: 'local' },
    createUsageHost: opts => { captured = opts; return {}; }, AGENT_PID_PATH: 'test', usageTransformSettings: () => ({}) });
  const options = { onUpdate: () => 'original-result', onPreview: () => 'preview-result' };
  create(options);
  assert.equal(captured.onPreview(), 'preview-result'); assert.equal(seen.length, 0);
  assert.equal(captured.onUpdate({ today: {}, allTime: {} }, 'watch'), 'original-result');
  assert.equal(seen.length, 1); assert.equal(seen[0].meta.preview, false);
});
test('view formats output units and gaps without interpolating a zero-speed idle point', () => {
  const view = require('../../src/electron/renderer/modelSpeedView');
  assert.equal(view.number(null), '—'); assert.equal(view.change(-40), '-40%'); assert.equal(view.plot([]), '');
  const p = view.plot([{ at: t0, tps: 100 }, { at: t0 + 60000, tps: 90 }, { at: t0 + 10 * c.HOUR, tps: 80 }]);
  assert.equal((p.match(/M/g) || []).length, 2); assert.equal((p.match(/L/g) || []).length, 1);
});
test('speed curves keep actual time spacing and stay inside measured segment bounds', () => {
  const view = require('../../src/electron/renderer/modelSpeedView');
  const points = [
    { at: t0, tps: 1000 }, { at: t0 + 60000, tps: 0 },
    { at: t0 + 180000, tps: 0 }, { at: t0 + 600000, tps: 300 }
  ];
  const d = view.plot(points, 124, 60);
  const commands = [...d.matchAll(/([MLC])([^MLC]+)/g)]
    .map(([, kind, values]) => ({ kind, values: values.trim().split(/[ ,]+/).map(Number) }));
  assert.deepEqual(commands.map(command => command.kind), ['M', 'C', 'C', 'C']);
  assert.equal(commands[1].values[4], 14, 'the one-minute sample occupies one tenth of the ten-minute range');
  assert.equal(commands[2].values[4], 38, 'the three-minute sample keeps its actual timestamp');
  let [x0, y0] = commands[0].values;
  for (const { values: [cx1, cy1, cx2, cy2, x1, y1] } of commands.slice(1)) {
    const bezier = (a, b, c, e, u) => (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * b + 3 * (1 - u) * u ** 2 * c + u ** 3 * e;
    let previousX = x0;
    for (let step = 0; step <= 40; step += 1) {
      const u = step / 40;
      const x = bezier(x0, cx1, cx2, x1, u);
      const y = bezier(y0, cy1, cy2, y1, u);
      assert.ok(x >= previousX - 0.011 && x <= x1 + 0.011, 'a smooth time axis never loops backwards');
      assert.ok(y >= Math.min(y0, y1) - 0.011 && y <= Math.max(y0, y1) + 0.011, 'smoothing cannot invent a peak or a negative rate');
      assert.ok(y <= 58.011, 'the curve stays at or above its zero-rate baseline');
      previousX = x;
    }
    x0 = x1; y0 = y1;
  }
});
test('smooth speed paths preserve real gaps and never draw a lone sample as a line', () => {
  const view = require('../../src/electron/renderer/modelSpeedView');
  assert.equal(view.plot([{ at: t0, tps: 30 }]), '');
  assert.equal(view.plot([{ at: t0, tps: 30 }, { at: t0 + 1, tps: null }]), '');
  const points = [
    { at: t0, tps: 40 }, { at: t0 + 60000, tps: 60 }, { at: t0 + 180000, tps: 30 },
    { at: t0 + 10 * c.HOUR, tps: 70 }, { at: t0 + 10 * c.HOUR + 60000, tps: 90 }
  ];
  const d = view.plot(points);
  assert.equal((d.match(/M/g) || []).length, 2);
  assert.equal((d.match(/C/g) || []).length, 2);
  assert.equal((d.match(/L/g) || []).length, 1);
  assert.equal(view.plot([...points].reverse()), d, 'arrival order cannot reverse the time axis');
});
test('speed date ticks mark start middle and end without repeating one date for short ranges', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/modelSpeedView.js'), 'utf8');
  const fn = source.match(/ {2}function dateRange\(trend, locale\) \{[\s\S]*?\n {2}\}/)?.[0];
  assert.ok(fn);
  const dateRange = vm.runInNewContext(`(${fn})`, {
    el(tag, cls, text) { return { tag, cls, text, children: [], append(...nodes) { this.children.push(...nodes); } }; }
  });
  const first = new Date(2026, 9, 1, 12).getTime();
  const dates = dateRange([{ at: first }, { at: first + 6 * 86400000 }], 'en-GB');
  assert.deepEqual(dates.children.map(node => node.text), ['01/10', '04/10', '07/10']);
  const hours = dateRange([{ at: first }, { at: first + 6 * c.HOUR }], 'en-GB');
  assert.deepEqual(hours.children.map(node => node.text), ['12:00', '15:00', '18:00']);
  assert.ok(hours.children.every(node => node.title.includes('2026')));
  assert.equal(dateRange([{ at: first }], 'en-GB').children.length, 1);
  assert.equal(dateRange([], 'en-GB'), null);
});
test('zero-output request duration cannot slow the next actual output sample', () => {
  let state = ingest(c.fresh(), 100, 1000, t0).state;
  state = ingest(state, 100, 5000, t0 + 1000).state;
  state = ingest(state, 300, 7000, t0 + 2000).state;
  assert.equal(c.project(state, t0 + 2000)[0].lastTps, 100);
});
test('UI strings, settings, preload and sender gate expose only the numeric feature API', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../../src/electron/preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  assert.match(main, /trustedSender\(event, \[mainWindow\]/);
  assert.match(main, /createModelSpeedRuntime\(\{ directory: app.getPath\('userData'\)/);
  assert.match(preload, /getModelSpeedHistory.*modelSpeed:history/);
  assert.match(renderer, /id: 'modelspeed', labelKey: 'home.modelSpeed.title'/);
  const i18n = require('../../src/electron/renderer/i18n');
  assert.equal(i18n.translate('zh-CN', 'home.modelSpeed.slower'), '疑似降速');
  assert.equal(i18n.translate('en', 'home.modelSpeed.retention'), '90 days');
});
