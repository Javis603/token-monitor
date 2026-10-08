'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const range = require('../../src/shared/modelSpeedRange');
const core = require('../../src/electron/modelSpeedHistory');
const { createModelSpeedRuntime } = require('../../src/electron/modelSpeedRuntime');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { translate } = require('../../src/electron/renderer/i18n');

// Wednesday 2026-10-07 15:00 local, so "this week" and "today" differ.
const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const at = options => range.rangeForPeriod(options.period, { now: NOW, weekStartsOn: 1, ...options });
const day = key => new Date(`${key}T00:00:00`).getTime();

test('every period resolves to the same kind of window the top selector shows', () => {
  assert.equal(range.normalizePeriod('last30'), 'last30');
  assert.equal(range.normalizePeriod('nonsense'), 'today', 'an unknown selection cannot invent a range');
  assert.equal(range.normalizePeriod(undefined), 'today');

  // DAY is local midnight to now, never a rolling 24 hours: at 15:00 the window
  // is 15 hours wide, not 24.
  const today = at({ period: 'today' });
  assert.equal(today.start, day('2026-10-07'));
  assert.equal(today.end, NOW);
  assert.equal(today.spanDays, 15 / 24);

  assert.equal(at({ period: 'week' }).start, day('2026-10-05'), 'ISO Monday');
  assert.equal(at({ period: 'week', weekStartsOn: 0 }).start, day('2026-10-04'), 'locale Sunday start');
  assert.equal(at({ period: 'last7' }).start, day('2026-10-01'));
  assert.equal(at({ period: 'month' }).start, day('2026-10-01'));
  assert.equal(at({ period: 'last30' }).start, day('2026-09-08'));
});

test('TOTAL stops at the retention floor instead of implying earlier history', () => {
  const all = at({ period: 'allTime' });
  assert.equal(all.start, day('2026-07-10'), 'the 90th retained day');
  assert.equal(all.end, NOW);
  assert.equal(range.RETENTION_DAYS, core.RETENTION_DAYS, 'the range floor matches the pruner');
  // Every other window sits inside the floor, so no selection can outrun what
  // the history file still holds.
  for (const period of range.PERIODS) {
    const window = at({ period });
    assert.ok(window.start >= all.start, `${period} starts at or after the floor`);
    assert.ok(window.end >= window.start, `${period} is not inverted`);
    assert.ok(window.labelKey, `${period} is labelable`);
  }
});

test('the average and the curve read exactly the same window', () => {
  const points = [
    { at: day('2026-10-05'), span: core.HOUR, out: 1000, ms: 10000, n: 2 },
    { at: day('2026-10-06'), span: core.HOUR, out: 2000, ms: 10000, n: 3 },
    { at: day('2026-10-07'), span: core.HOUR, out: 4000, ms: 10000, n: 5 }
  ];
  const week = at({ period: 'week' });
  const weekPoints = points.filter(p => p.at + p.span > week.start && p.at <= week.end);
  assert.equal(weekPoints.length, 3, 'Monday onward is inside the week');
  assert.equal(core.rateOverRange(points, week), 233.33333333333334);
  // A window that excludes Monday cannot be averaged with Monday's samples.
  const today = at({ period: 'today' });
  assert.equal(core.rateOverRange(points, today), 400);
  const trend = core.chartRange(points, week);
  assert.deepEqual(trend.map(p => p.samples), [2, 3, 5], 'the curve carries the same samples as the average');
  assert.equal(core.chartRange(points, { start: week.end, end: week.start }).length, 0, 'an inverted window draws nothing');
});

test('a range stops a runtime detail from describing a window the top tabs do not show', () => {
  const directory = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'speed-range-'));
  const clock = { at: NOW };
  const runtime = createModelSpeedRuntime({ directory, now: () => clock.at });
  const model = 'group/auto-deepseek-v4-1-flash';
  const day0 = Math.floor(day('2026-10-05') / core.FIVE_MINUTES) * core.FIVE_MINUTES;
  // Two paired readings two days back plus a today anchor, so the windows
  // differ: the week holds samples, today holds none.
  const history = { version: 1, kind: 'model-output-speed-history', retentionDays: 90, activeSource: null, series: {} };
  const source = 'a'.repeat(64);
  history.activeSource = source;
  history.series[`${source}:${model}`] = {
    model, source,
    anchor: { out: 3000, ms: 30000, todayOut: 1000, todayMs: 10000, day: '2026-10-07', at: NOW },
    reference: null, referenceAt: NOW, lastSampleAt: NOW, pending: { out: 0, ms: 0 },
    points: [
      { at: day0, span: core.HOUR, out: 1000, ms: 10000, n: 2 },
      { at: day0 + core.HOUR, span: core.HOUR, out: 1000, ms: 10000, n: 2 }
    ],
    gaps: 0, rejected: 0
  };
  require('node:fs').writeFileSync(runtime.file, JSON.stringify(history));
  const reloaded = createModelSpeedRuntime({ directory, now: () => clock.at });
  const id = `${source}:${model}`;
  const week = reloaded.detail(id, { period: 'week' });
  assert.equal(week.weightedTps, 100, 'the week-average includes the Monday samples');
  assert.equal(week.trend.length, 2);
  const today = reloaded.detail(id, { period: 'today' });
  assert.equal(today.weightedTps, null, 'today holds no sample, so it reports no average rather than the week one');
  assert.equal(today.trend.length, 0);
  assert.equal(today.range.start, day('2026-10-07'));
  require('node:fs').rmSync(directory, { recursive: true, force: true });
});

test('the list reports the resolved range so the renderer never guesses it', () => {
  const directory = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'speed-list-range-'));
  const runtime = createModelSpeedRuntime({ directory, now: () => NOW });
  runtime.observe({ allTime: { models: { active: 20 } }, today: { models: { active: 20 } } }, { source: 'local' });
  const list = runtime.list({ period: 'last30' });
  assert.equal(list.range.period, 'last30');
  assert.equal(list.range.start, day('2026-09-08'));
  assert.equal(list.range.labelKey, 'home.modelSpeed.range.last30');
  const summary = runtime.summary({ period: 'today' });
  assert.equal(summary.range.period, 'today');
  assert.equal(summary.range.start, day('2026-10-07'));
  require('node:fs').rmSync(directory, { recursive: true, force: true });
});

// Exercise the complete browser module with the same small DOM seam as session
// detail tests. Only the IPC response timing is controlled by this fixture.
function detailHarness(t, selected = 'last30') {
  function element() {
    const node = {
      children: [], className: '', attributes: {},
      get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this._text || ''; },
      set textContent(value) { this.children = []; this._text = value; },
      append(...nodes) { this.children.push(...nodes); nodes.forEach(child => { child.parentElement = this; }); },
      replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); },
      querySelector(selector) {
        for (const child of this.children) {
          if (child.className.split(' ').includes(selector.slice(1))) return child;
          const found = child.querySelector(selector);
          if (found) return found;
        }
        return null;
      }
    };
    node.classList = {
      add: name => { node.className += ` ${name}`; },
      remove: name => { node.className = node.className.split(' ').filter(value => value !== name).join(' '); }
    };
    return node;
  }
  const window = { TokenMonitorUsageCharts: require('../../src/electron/renderer/usageCharts'), TokenMonitorModelSpeedRange: range };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/modelSpeedView.js'), 'utf8'), {
    window, document: { createElement: element }, setInterval: () => 1, clearInterval() {}
  });
  const requests = [];
  const detail = window.TokenMonitorModelSpeedView.createDetail('fixture-model', 'fixture-model', {
    t: (key, params) => translate('zh-CN', key, params), rangeFor: () => selected,
    get: request => new Promise((resolve, reject) => { requests.push({ request, resolve, reject }); })
  });
  t.after(() => detail.dispose());
  return { detail, requests, select: period => { selected = period; },
    caption: () => detail.element.querySelector('.model-speed-range').textContent,
    figures: () => detail.element.querySelector('.model-speed-figures'),
    note: () => detail.element.querySelector('.model-speed-body').textContent };
}
const detailData = period => ({ status: 'steady', weightedTps: 50, trend: [], range: at({ period }) });

test('a failed poll superseding a range change labels the selected range and ignores the late response', async t => {
  const h = detailHarness(t);
  h.requests[0].resolve(detailData('last30'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.caption(), '近30天');
  assert.ok(h.figures());
  h.select('today');
  const changing = h.detail.setRange();
  const polling = h.detail.refresh();
  assert.equal(h.requests[1].request.period, 'today');
  assert.equal(h.requests[2].request.period, 'today');
  h.requests[2].reject(new Error('temporary failure'));
  await polling;
  assert.equal(h.figures(), null, 'a new range failure clears the previous numbers');
  assert.equal(h.caption(), '今天');
  assert.equal(h.note(), translate('zh-CN', 'home.modelSpeed.error'));
  h.requests[1].resolve(detailData('today'));
  await changing;
  assert.equal(h.figures(), null, 'the superseded success cannot resurrect numbers');
  assert.equal(h.caption(), '今天');
});

test('empty details and first-load errors name each selected window', async t => {
  for (const [period, caption] of [['today', '今天'], ['week', '本周'], ['last7', '近7天'],
    ['month', '本月'], ['last30', '近30天'], ['allTime', '全部保留（90 天）']]) {
    for (const empty of [false, true]) {
      const h = detailHarness(t, period);
      if (empty) h.requests[0].resolve(null);
      else h.requests[0].reject(new Error('first-load failure'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.caption(), caption, `${period} ${empty ? 'empty' : 'error'}`);
      assert.equal(h.figures(), null);
      assert.equal(h.note(), translate('zh-CN', `home.modelSpeed.${empty ? 'empty' : 'error'}`));
    }
  }
});

test('successful detail ranges stay authoritative during a same-range failed poll', async t => {
  const h = detailHarness(t, 'today');
  h.requests[0].resolve(detailData('last7'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.caption(), '近7天', 'the response range labels successful figures');
  const figures = h.figures();
  const polling = h.detail.refresh();
  h.requests[1].reject(new Error('temporary failure'));
  await polling;
  assert.equal(h.figures(), figures, 'same-range polling retains the successful figures');
  assert.equal(h.caption(), '近7天', 'retained figures retain their authoritative response label');
});
