'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const budget = require('../../src/electron/renderer/homeRowBudget');

const appSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

// Synthetic geometry close to the real Home: a fixed limits panel, the activity
// chart's minimum, and four preview lists whose row heights grow on narrow
// windows because their meta lines wrap.
function fixture({ sessionRow = 56, speedRow = 44, modelRow = 20 } = {}) {
  return [
    { id: 'limits', chromeHeight: 300, rowHeight: 0, innerGap: 0, minRows: 0, maxRows: 0, fixed: true },
    { id: 'model', chromeHeight: 40, rowHeight: modelRow, innerGap: 6, minRows: 1, maxRows: 11 },
    { id: 'trends', chromeHeight: 130, rowHeight: 0, innerGap: 0, minRows: 0, maxRows: 0, fixed: true },
    { id: 'session', chromeHeight: 60, rowHeight: sessionRow, innerGap: 6, minRows: 1, maxRows: 11 },
    { id: 'modelspeed', chromeHeight: 50, rowHeight: speedRow, innerGap: 6, minRows: 1, maxRows: 11 }
  ];
}

function planFor(panelHeight, { columns = 1, rowHeights = {} } = {}) {
  const entries = fixture(rowHeights);
  return budget.allocateHomeRows({
    panelHeight,
    gap: 12,
    columns,
    entries,
    groups: budget.layoutGroups(entries.length, columns)
  });
}

function rowsById(plan, entries) {
  const result = {};
  entries.forEach((entry, index) => { result[entry.id] = plan.rows[index]; });
  return result;
}

test('previewCount keeps the old base cap as the preview floor and stays data-bounded', () => {
  assert.equal(budget.previewCount(5, 100), 5 + budget.DEFAULT_MAX_EXTRA);
  assert.equal(budget.previewCount(4, 100), 10, 'the device list keeps its base-4 allowance');
  assert.equal(budget.previewCount(5, 3), 3, 'never more rows than the data carries');
  assert.equal(budget.previewCount(5, 0), 0, 'an empty list renders no rows');
  assert.equal(budget.previewCount(5, undefined), 11);
});

test('two columns pair modules and an odd last module spans the full row', () => {
  assert.deepEqual(budget.layoutGroups(3, 1), [[0], [1], [2]]);
  assert.deepEqual(budget.layoutGroups(3, 2), [[0, 1], [2]]);
  assert.deepEqual(budget.layoutGroups(5, 2), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(budget.layoutGroups(4, 2), [[0, 1], [2, 3]]);
});

test('a grid row costs its tallest member, so the shorter one can grow for free', () => {
  const entries = [
    { chromeHeight: 40, rowHeight: 64, innerGap: 6, maxRows: 5 },
    { chromeHeight: 40, rowHeight: 20, innerGap: 6, maxRows: 5 }
  ];
  const groups = budget.layoutGroups(2, 2);
  assert.equal(budget.estimateHeight([1, 1], { entries, groups, gap: 12 }), 40 + 64);
  assert.equal(budget.estimateHeight([1, 2], { entries, groups, gap: 12 }), 40 + 64,
    'the short column rides along until it outgrows its partner');
  assert.equal(budget.estimateHeight([1, 4], { entries, groups, gap: 12 }), 40 + 4 * 20 + 3 * 6);
  assert.equal(budget.estimateHeight([4, 4], { entries, groups, gap: 12 }), 40 + 4 * 64 + 3 * 6);
  assert.equal(budget.estimateHeight([1, 1, 1], {
    entries: [...entries, { chromeHeight: 10, rowHeight: 0, innerGap: 0 }],
    groups: budget.layoutGroups(3, 2),
    gap: 12
  }), 40 + 64 + 10 + 12, 'the orphan row adds its own height and one gap');
});

test('single column sums module heights and the gaps between them', () => {
  const entries = [
    { chromeHeight: 100, rowHeight: 0, innerGap: 0 },
    { chromeHeight: 40, rowHeight: 30, innerGap: 6 }
  ];
  assert.equal(budget.estimateHeight([0, 2], { entries, groups: budget.layoutGroups(2, 1), gap: 12 }), 100 + 40 + 2 * 30 + 6 + 12);
});

test('a short panel still keeps one row per non-empty list and reports overflow', () => {
  const entries = fixture();
  const plan = budget.allocateHomeRows({ panelHeight: 100, gap: 12, entries, groups: budget.layoutGroups(entries.length, 1) });
  const rows = rowsById(plan, entries);
  assert.equal(plan.fitted, false);
  assert.equal(plan.overflow, true);
  assert.equal(rows.limits, 0, 'the configured limits panel is not a preview list');
  assert.equal(rows.model, 1);
  assert.equal(rows.session, 1);
  assert.equal(rows.modelspeed, 1, 'even at an impossible height a preview list keeps one row');
  assert.ok(plan.usedHeight > 100, 'the caller is told the minimum layout does not fit');
});

test('an empty list never receives rows and never blocks the others', () => {
  const entries = fixture();
  entries[3].maxRows = 0; // no sessions
  const plan = budget.allocateHomeRows({ panelHeight: 100, gap: 12, entries, groups: budget.layoutGroups(entries.length, 1) });
  assert.equal(plan.rows[3], 0);
  assert.equal(plan.rows[1], 1);
  assert.equal(plan.rows[4], 1);
});

test('rows decrease monotonically on the same width and recover when the window grows', () => {
  const heights = [1324, 1000, 800, 640];
  const entries = fixture();
  const ladder = heights.map((height) => rowsById(
    budget.allocateHomeRows({ panelHeight: height, gap: 12, entries, groups: budget.layoutGroups(entries.length, 1) }),
    entries
  ));
  for (let step = 1; step < ladder.length; step += 1) {
    for (const id of ['model', 'session', 'modelspeed']) {
      assert.ok(ladder[step][id] <= ladder[step - 1][id], `${id} must not grow when the window shrinks (${heights[step]})`);
    }
  }
  const recovered = rowsById(
    budget.allocateHomeRows({ panelHeight: 1324, gap: 12, entries, groups: budget.layoutGroups(entries.length, 1) }),
    entries
  );
  assert.deepEqual(recovered, ladder[0], 'the same height restores the same plan');
  assert.ok(recovered.modelspeed > ladder[ladder.length - 1].modelspeed, 'a taller window restores deeper previews');
});

test('narrow widths with wrapped rows buy fewer rows for the same height', () => {
  const panelHeight = 1324;
  const narrow = planFor(panelHeight, { rowHeights: { sessionRow: 56, speedRow: 44 } });
  const wide = planFor(panelHeight, { rowHeights: { sessionRow: 24, speedRow: 24 } });
  assert.ok(narrow.rows[3] <= wide.rows[3], 'the wrapped session list never shows more rows than the compact one');
  assert.ok(narrow.rows[4] <= wide.rows[4]);
  assert.ok(wide.rows[3] > 1 && wide.rows[4] > 1, 'the wide window shows a real preview');
});

test('the plan fits the measured panel and stays inside every bound', () => {
  const entries = fixture();
  const groups = budget.layoutGroups(entries.length, 1);
  for (const panelHeight of [640, 800, 1000, 1180, 1324]) {
    const plan = budget.allocateHomeRows({ panelHeight, gap: 12, entries, groups });
    assert.equal(budget.estimateHeight(plan.rows, { entries, groups, gap: 12 }), plan.usedHeight);
    plan.rows.forEach((rows, index) => {
      assert.ok(rows >= 0 && rows <= entries[index].maxRows, `row ${index} stays inside 0..maxRows`);
    });
    if (plan.fitted) {
      assert.ok(plan.usedHeight <= panelHeight, `a fitted plan stays inside ${panelHeight}`);
    } else {
      assert.deepEqual(plan.rows, [0, 1, 0, 1, 1], `only the minimum layout survives ${panelHeight}`);
      assert.ok(plan.usedHeight > panelHeight, 'overflow means even the minimum cannot fit');
    }
  }
  const ample = budget.allocateHomeRows({ panelHeight: 4000, gap: 12, entries, groups });
  assert.deepEqual(ample.rows.slice(1, 2).concat(ample.rows.slice(3)), [11, 11, 11], 'ample space restores bounded deeper previews');
});

test('no list starves: growable lists stay within one row of each other', () => {
  // Session rows are far more expensive than model rows; a naive cheapest-first
  // allocator would deepen the model list and leave sessions at the floor.
  const entries = fixture({ sessionRow: 120, speedRow: 90, modelRow: 16 });
  const groups = budget.layoutGroups(entries.length, 1);
  const plan = budget.allocateHomeRows({ panelHeight: 760, gap: 12, entries, groups });
  const lists = [1, 3, 4].map((index) => plan.rows[index]);
  assert.ok(Math.max(...lists) - Math.min(...lists) <= 1, `preview lists stay level (${lists.join(',')})`);
  assert.ok(Math.min(...lists) >= 1);
});

test('two columns deepen both members of an equal pair together', () => {
  const entries = [
    { id: 'left', chromeHeight: 40, rowHeight: 40, innerGap: 6, minRows: 1, maxRows: 5 },
    { id: 'right', chromeHeight: 40, rowHeight: 40, innerGap: 6, minRows: 1, maxRows: 5 }
  ];
  const groups = budget.layoutGroups(2, 2);
  const plan = budget.allocateHomeRows({ panelHeight: 180, gap: 12, entries, groups });
  assert.deepEqual(plan.rows, [3, 3], 'neither column runs ahead of its partner');
  assert.equal(plan.usedHeight, 40 + 3 * 40 + 2 * 6);
});

test('two columns spend shared row height on the shorter member for free', () => {
  const entries = [
    { id: 'tall', chromeHeight: 40, rowHeight: 64, innerGap: 6, minRows: 1, maxRows: 5 },
    { id: 'short', chromeHeight: 40, rowHeight: 20, innerGap: 6, minRows: 1, maxRows: 5 }
  ];
  const groups = budget.layoutGroups(2, 2);
  const plan = budget.allocateHomeRows({ panelHeight: 200, gap: 12, entries, groups });
  assert.equal(plan.rows[0], 2, 'the tall list deepens one level while the pair height allows it');
  assert.equal(plan.rows[1], 5, 'the short list fills the shared row height for free, up to its max');
  assert.equal(plan.usedHeight, 40 + 2 * 64 + 6, 'free rows never spend panel height');
});

test('allocation is pure: no input mutation, same input gives the same plan', () => {
  const entries = fixture();
  const before = JSON.stringify(entries);
  const groups = budget.layoutGroups(entries.length, 1);
  const first = budget.allocateHomeRows({ panelHeight: 900, gap: 12, entries, groups });
  const second = budget.allocateHomeRows({ panelHeight: 900, gap: 12, entries, groups });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(entries), before, 'the allocator only reads its inputs');
  assert.deepEqual(budget.allocateHomeRows({ panelHeight: Number.NaN, entries }), {
    rows: [0, 1, 0, 1, 1], usedHeight: budget.estimateHeight([0, 1, 0, 1, 1], {
      entries: budget.allocateHomeRows({ panelHeight: Number.NaN, entries }).rows.length ? entries : entries,
      groups: budget.layoutGroups(entries.length, 1),
      gap: budget.DEFAULT_GAP
    }), fitted: false, overflow: true
  });
});

// ---------------------------------------------------------------------------
// Seam: the app-side measurement/apply controller against a fake panel whose
// geometry mirrors the real DOM (rows lay out sequentially inside their body).
// ---------------------------------------------------------------------------
const ROW_GAP = 6;

function layoutRows(rows, height) {
  let top = 40;
  for (const row of rows) {
    const rowTop = top;
    row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + height, height });
    top += height + ROW_GAP;
  }
}

function makeRows(count, height) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      style: { display: '' },
      parentElement: null,
      contains: () => false,
      getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 })
    });
  }
  layoutRows(rows, height);
  const body = { style: {}, computed: { rowGap: `${ROW_GAP}px` } };
  for (const row of rows) row.parentElement = body;
  return rows;
}

function makeModule(id, { rows = [], chrome = 40, flexGrow = '0' } = {}) {
  return {
    dataset: { homeModule: id },
    style: { flexGrow: '', alignSelf: '' },
    computed: { flexGrow },
    querySelectorAll: () => rows,
    getBoundingClientRect: () => {
      if (!rows.length) return { height: chrome };
      // Same shape as the real DOM: chrome plus the vertical span of the rows.
      const first = rows[0].getBoundingClientRect();
      const last = rows[rows.length - 1].getBoundingClientRect();
      return { height: chrome + (last.bottom - first.top) };
    }
  };
}

function makePanel(children, { height = 640, display = 'flex' } = {}) {
  return {
    style: {},
    children,
    childElementCount: children.length,
    clientWidth: 704,
    clientHeight: height,
    computed: { display, gridTemplateRows: 'none', rowGap: '12px' },
    classList: { contains: () => false }
  };
}

function loadSeam() {
  const start = appSource.indexOf('// [home-row-budget]');
  const end = appSource.indexOf('// [/home-row-budget]');
  assert.ok(start > 0 && end > start, 'the budget controller is delimited in app.js');
  const source = appSource.slice(start, end);
  const state = { breakdown: 'home', homeRowBudgetSize: '', homeRowBudgetPlan: null };
  const els = { homePanel: null };
  const frames = [];
  const api = Function(
    'window', 'document', 'getComputedStyle', 'requestAnimationFrame', 'els', 'state',
    `${source}\nreturn { measureHomeRowBudget, applyHomeRowBudget, scheduleHomeRowBudgetRefresh };`
  )(
    { TokenMonitorHomeRowBudget: budget },
    { activeElement: null },
    (element) => element.computed || {},
    (callback) => { frames.push(callback); return frames.length; },
    els,
    state
  );
  return {
    ...api,
    state,
    els,
    setPanel(panel) { els.homePanel = panel; },
    flushFrame() { const callback = frames.shift(); if (callback) callback(); return frames.length; }
  };
}

function seamPanel({ height, sessionRows = 8, speedRows = 8, modelRows = 8, sessionHeight = 56, speedHeight = 44 }) {
  const limits = makeModule('limits', { chrome: 300 });
  limits.getBoundingClientRect = () => ({ height: 300 });
  const trends = makeModule('trends', { chrome: 130, flexGrow: '1' });
  trends.getBoundingClientRect = () => ({ height: 130 });
  const model = makeModule('model', { rows: makeRows(modelRows, 20), chrome: 40 });
  const session = makeModule('session', { rows: makeRows(sessionRows, sessionHeight), chrome: 60 });
  const speed = makeModule('modelspeed', { rows: makeRows(speedRows, speedHeight), chrome: 50 });
  const panel = makePanel([limits, model, trends, session, speed], { height });
  return { panel, limits, model, trends, session, speed };
}

function visibleCount(module) {
  return module.querySelectorAll().filter((row) => row.style.display !== 'none').length;
}

test('seam: a short panel hides trailing preview rows, a taller one restores them', () => {
  const seam = loadSeam();
  const short = seamPanel({ height: 900 });
  seam.setPanel(short.panel);
  const shortPlan = seam.applyHomeRowBudget(short.panel);
  assert.ok(shortPlan);
  assert.equal(shortPlan.fitted, true);
  for (const module of [short.model, short.session, short.speed]) {
    const rows = module.querySelectorAll();
    const visible = visibleCount(module);
    assert.ok(visible >= 1, 'a non-empty list keeps at least one row');
    assert.ok(visible < rows.length, 'a short panel does trim rows below the rendered candidate set');
    rows.forEach((row, index) => {
      assert.equal(row.style.display === 'none', index >= visible, 'only a trailing suffix is hidden');
    });
  }
  assert.equal(short.limits.style.flexGrow, '', 'fixed modules are untouched');
  assert.equal(short.trends.style.flexGrow, '', 'the growth neutralisation is restored');

  const tall = { ...short.panel, clientHeight: 1324 };
  seam.setPanel(tall);
  const tallPlan = seam.applyHomeRowBudget(tall);
  for (const module of [short.model, short.session, short.speed]) {
    assert.ok(visibleCount(module) >= 1);
  }
  const tallRows = rowsById(tallPlan, short.panel.children.map((child) => ({ id: child.dataset.homeModule })));
  const shortRows = rowsById(shortPlan, short.panel.children.map((child) => ({ id: child.dataset.homeModule })));
  for (const id of ['model', 'session', 'modelspeed']) {
    assert.ok(tallRows[id] >= shortRows[id], `${id} recovers rows as the panel grows`);
  }
  assert.ok(tallRows.modelspeed > shortRows.modelspeed, 'the taller panel restores at least one more preview row');
});

test('seam: width-induced wrap changes the measured cost and the row plan', () => {
  const seam = loadSeam();
  const narrow = seamPanel({ height: 900, sessionHeight: 56, speedHeight: 44, sessionRows: 4, speedRows: 4, modelRows: 4 });
  seam.setPanel(narrow.panel);
  const narrowPlan = seam.applyHomeRowBudget(narrow.panel);

  const wide = { ...narrow.panel, clientWidth: 1200 };
  // A wider panel unwraps the session and speed meta lines: same rows, shorter.
  layoutRows(narrow.session.querySelectorAll(), 24);
  layoutRows(narrow.speed.querySelectorAll(), 24);
  seam.setPanel(wide);
  const widePlan = seam.applyHomeRowBudget(wide);
  const ids = wide.children.map((child) => ({ id: child.dataset.homeModule }));
  const narrowRows = rowsById(narrowPlan, ids);
  const wideRows = rowsById(widePlan, ids);
  assert.ok(wideRows.session >= narrowRows.session, 'compact rows never show fewer session rows than wrapped rows');
  assert.ok(wideRows.modelspeed >= narrowRows.modelspeed);
  assert.ok(wideRows.model + wideRows.session + wideRows.modelspeed
    > narrowRows.model + narrowRows.session + narrowRows.modelspeed,
  'the wider panel buys more visible rows for the same height');
});

test('seam: a hidden panel (zero height) is left completely alone', () => {
  const seam = loadSeam();
  const fixturePanel = seamPanel({ height: 0 });
  seam.setPanel(fixturePanel.panel);
  for (const module of [fixturePanel.model, fixturePanel.session, fixturePanel.speed]) {
    for (const row of module.querySelectorAll()) row.style.display = 'none';
  }
  const plan = seam.applyHomeRowBudget(fixturePanel.panel);
  assert.equal(plan, null);
  for (const module of [fixturePanel.model, fixturePanel.session, fixturePanel.speed]) {
    for (const row of module.querySelectorAll()) assert.equal(row.style.display, 'none', 'no writes while hidden');
  }
});

test('seam: a grid panel measures its two-column groups and applies the plan', () => {
  const seam = loadSeam();
  const grid = seamPanel({ height: 900 });
  grid.panel.computed.display = 'grid';
  grid.panel.computed.gridTemplateRows = 'max-content max-content minmax(max-content, 1fr)';
  grid.panel.style.gridTemplateRows = '';
  for (const child of grid.panel.children) child.style.alignSelf = '';
  // Browser grid rows stretch both members to their tallest neighbour. A
  // budget must measure their independent sizes before pairing their costs.
  const modelIntrinsic = grid.model.getBoundingClientRect;
  grid.model.getBoundingClientRect = () => ({ height:
    grid.model.style.alignSelf === 'start' ? modelIntrinsic().height : 300 });
  seam.setPanel(grid.panel);
  const measured = seam.measureHomeRowBudget(grid.panel);
  assert.equal(measured.entries[1].chromeHeight, 40, 'paired empty space does not inflate model chrome');
  const plan = seam.applyHomeRowBudget(grid.panel);
  assert.ok(plan);
  assert.ok(plan.usedHeight <= 900);
  assert.deepEqual(plan.rows.map((_, index) => index), [0, 1, 2, 3, 4]);
  assert.equal(plan.rows[0], 0, 'the fixed limits panel never previews rows');
  assert.equal(grid.panel.style.gridTemplateRows, '', 'the neutralised track list is restored');
  for (const child of grid.panel.children) assert.equal(child.style.alignSelf, '', 'stretch is restored');
  assert.ok(visibleCount(grid.model) >= 1 && visibleCount(grid.session) >= 1);
});

test('app wiring: renderHome plans synchronously and resize re-plans without data', () => {
  assert.match(appSource, /els\.homePanel\.replaceChildren\(\.\.\.nodes\);\n(?:[^\n]*\n){0,4}?\s*applyHomeRowBudget\(els\.homePanel\);/);
  assert.match(appSource, /if \(!state\.homeRowBudgetObserver\) ensureHomeRowBudgetObserver\(\);/);
  assert.match(appSource, /new ResizeObserver\(\(\) => scheduleHomeRowBudgetRefresh\(\)\)/);
  assert.match(appSource, /state\.homeRowBudgetObserver\.observe\(els\.homePanel\)/);
  assert.match(appSource, /window\.addEventListener\('resize', scheduleHomeRowBudgetRefresh\)/);
  assert.match(appSource, /current\.replaceWith\(next\);\n\s*if \(hadFocus\) next\.focus\(\);\n(?:[^\n]*\n){0,2}?\s*state\.homeRowBudgetRefresh\?\.\(\);/);
  assert.match(appSource, /state\.homeRowBudgetRefresh = \(\) => scheduleHomeRowBudgetRefresh\(true\);/);
  assert.match(appSource, /function scheduleHomeRowBudgetRefresh\(force = false\)/);
  assert.match(appSource, /speedModule\.dataset\.homeModule = 'modelspeed';/);
  assert.doesNotMatch(appSource, /extraRows\(/, 'the fixed base-height budget is gone');
  assert.doesNotMatch(appSource, /homeRowBudgetExtra/, 'no caller depends on the fixed 640px base');
});
