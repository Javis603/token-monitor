'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_ANIMATED_BREAKDOWN_ROWS,
  SESSION_BREAKDOWN_PAGE_SIZE,
  barScaleMax,
  breakdownPage,
  rowRenderFingerprint,
  rowWidth,
  shouldAnimateBreakdownRows,
  toolIconsEnabled
} = require('../../src/electron/renderer/breakdownRenderPolicy');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

test('bar scale follows the largest rendered value, including fractional costs', () => {
  const tokenRows = [{ value: 9_000 }, { value: 3_000 }];
  assert.equal(barScaleMax(tokenRows), 9_000);
  assert.equal(rowWidth(9_000, barScaleMax(tokenRows)), 100);
  assert.equal(Number(rowWidth(3_000, barScaleMax(tokenRows)).toFixed(6)), 33.333333);

  // Cost-ranked bars are USD and routinely below $1. A scale floored at 1 rendered
  // this pair as 30% / 10% instead of a full bar and a third of it.
  const costRows = [{ value: 9_000, barValue: 0.3 }, { value: 3_000, barValue: 0.1 }];
  assert.equal(barScaleMax(costRows), 0.3);
  assert.equal(rowWidth(0.3, barScaleMax(costRows)), 100);
  assert.equal(Number(rowWidth(0.1, barScaleMax(costRows)).toFixed(6)), 33.333333);
});

test('sub-cent costs stay proportional instead of collapsing onto the minimum width', () => {
  const rows = [{ barValue: 0.008 }, { barValue: 0.002 }];
  const max = barScaleMax(rows);

  assert.equal(rowWidth(0.008, max), 100);
  assert.equal(rowWidth(0.002, max), 25);
});

test('bar scale ignores unusable values and collapses bars when nothing is measurable', () => {
  assert.equal(barScaleMax([]), 0);
  assert.equal(barScaleMax(null), 0);
  assert.equal(barScaleMax([{ value: Number.NaN }, { value: 5 }]), 5);
  assert.equal(barScaleMax([{ value: -4 }]), 0);
  assert.equal(rowWidth(0, barScaleMax([{ value: 0 }])), 0);
});

test('a non-zero row keeps a visible bar even when it rounds below the minimum', () => {
  assert.equal(rowWidth(1, 1_000_000), 2);
  assert.equal(rowWidth(0, 1_000), 0);
});

test('small breakdowns keep motion while large breakdowns skip it', () => {
  assert.equal(shouldAnimateBreakdownRows(MAX_ANIMATED_BREAKDOWN_ROWS), true);
  assert.equal(shouldAnimateBreakdownRows(MAX_ANIMATED_BREAKDOWN_ROWS + 1), false);
});

test('reduced motion skips layout capture even for small breakdowns', () => {
  assert.equal(shouldAnimateBreakdownRows(1, { reducedMotion: true }), false);
});

test('tool icon state uses the same strict normalization as row rendering', () => {
  assert.equal(toolIconsEnabled(undefined), false);
  assert.equal(toolIconsEnabled(false), false);
  assert.equal(toolIconsEnabled(true), true);
});

test('session pages keep the rendered row count bounded and clamp stale pages', () => {
  const rows = Array.from({ length: SESSION_BREAKDOWN_PAGE_SIZE * 2 + 7 }, (_, index) => ({ key: `session:${index}` }));
  const first = breakdownPage(rows, { breakdown: 'session', page: 0 });
  assert.equal(first.rows.length, SESSION_BREAKDOWN_PAGE_SIZE);
  assert.equal(first.start, 1);
  assert.equal(first.end, SESSION_BREAKDOWN_PAGE_SIZE);
  assert.equal(first.total, rows.length);
  assert.equal(first.paginated, true);

  const clamped = breakdownPage(rows, { breakdown: 'session', page: 99 });
  assert.equal(clamped.page, 2);
  assert.equal(clamped.rows.length, 7);
  assert.equal(clamped.start, SESSION_BREAKDOWN_PAGE_SIZE * 2 + 1);
  assert.equal(clamped.end, rows.length);
});

test('small session lists and other breakdowns remain unpaged', () => {
  const small = Array.from({ length: 3 }, (_, index) => ({ key: String(index) }));
  assert.equal(breakdownPage(small, { breakdown: 'session', page: 2 }).paginated, false);
  assert.equal(breakdownPage(small, { breakdown: 'session', page: 2 }).rows, small);
  const models = Array.from({ length: SESSION_BREAKDOWN_PAGE_SIZE + 1 }, (_, index) => ({ key: String(index) }));
  assert.equal(breakdownPage(models, { breakdown: 'model' }).rows, models);
});

test('row fingerprints stay stable until visible row output changes', () => {
  const row = {
    key: 'session:codex:s1',
    kind: 'session',
    name: 'Codex · gpt-5.6-sol',
    subtitle: '21:53 · 465 calls',
    detail: 's1',
    value: 1234,
    cost: 0.42,
    color: '#49a3b0',
    client: 'codex'
  };
  const context = { breakdown: 'session', currency: 'USD', locale: 'en-US', showToolIcons: true };

  const fingerprint = rowRenderFingerprint(row, 5000, context);
  assert.equal(rowRenderFingerprint({ ...row }, 5000, { ...context }), fingerprint);
  assert.notEqual(rowRenderFingerprint({ ...row, value: 1235 }, 5000, context), fingerprint);
  assert.notEqual(rowRenderFingerprint(row, 6000, context), fingerprint);
  assert.notEqual(rowRenderFingerprint(row, 5000, { ...context, currency: 'HKD' }), fingerprint);
});

test('renderer applies the policy before touching breakdown rows', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

  assert.ok(html.indexOf('<script src="breakdownRenderPolicy.js"></script>') < html.indexOf('<script src="app.js"></script>'));
  assert.match(app, /shouldAnimateBreakdownRows\(rows\.length, \{ reducedMotion: prefersReducedMotion\(\) \}\)/);
  assert.match(app, /if \(rowRenderFingerprints\.get\(row\) === fingerprint\) continue;/);
  assert.match(app, /row\.dataset\.tokenDataUnavailable === 'true'/);
  assert.match(app, /cancelRowNumberAnimation\(row\.querySelector\('\.row-value'\)\)/);
  assert.match(app, /row\.dataset\.tokenDataUnavailable = 'true'/);
  assert.match(app, /showToolIcons:\s*toolIconsEnabled\(state\.settings\?\.showToolIcons\)/);
  assert.match(app, /const page = breakdownPage\(rows, \{ breakdown: state\.breakdown, page: state\.sessionPage \}\)/);
  assert.match(app, /const visibleRows = page\.rows;/);
  assert.match(app, /visibleRows\.map\(\(row\) => existing\.get\(row\.key\) \|\| rowTemplate\(row\)\)/);
  assert.match(html, /<div id="sessionPagerHost" class="session-pager-host hidden"><\/div>/);
  assert.ok(html.indexOf('id="trendsPanel"') < html.indexOf('id="sessionPagerHost"'));
  assert.ok(html.indexOf('id="sessionPagerHost"') < html.indexOf('<footer class="footer">'));
  assert.match(app, /sessionPagerHost: document\.getElementById\('sessionPagerHost'\)/);
  assert.match(app, /renderSessionPager\(page\);/);
  assert.doesNotMatch(app, /nodes\.(?:unshift|push)\(sessionPager\(page\)\)/);
  assert.match(app, /let pager = els\.sessionPagerHost\.querySelector\('\.session-pager'\);/);
  assert.match(app, /if \(!pager\) \{\s*pager = sessionPager\(\);\s*els\.sessionPagerHost\.append\(pager\);\s*\}/);
  assert.match(app, /state\.sessionPage \+= direction === 'previous' \? -1 : 1;/);
  assert.doesNotMatch(app, /replaceChildren\([^)]*sessionPager/);
  assert.match(css, /\.session-pager-host\s*\{[^}]*display:\s*flex;[^}]*flex:\s*0 0 24px;[^}]*justify-content:\s*center;/s);
  assert.match(css, /\.session-pager\s*\{[^}]*width:\s*min\(208px, 100%\);/s);
  assert.match(css, /\.session-pager\s*\{[^}]*grid-template-columns:\s*24px minmax\(0, 1fr\) 24px;/s);
  assert.match(css, /\.session-pager\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  assert.doesNotMatch(css, /\.session-pager\s*\{[^}]*(?:position:\s*sticky|border-radius|box-shadow|backdrop-filter|--panel-rgb|--control-alpha)/s);
  assert.match(css, /\.session-page-button\s*\{[^}]*color:\s*var\(--muted\);/s);
  assert.doesNotMatch(css, /\.session-page-(?:previous|next)\s*\{/);
  assert.doesNotMatch(app, /largeSessionContainmentScheduler|updateLargeSessionContainment/);
});
