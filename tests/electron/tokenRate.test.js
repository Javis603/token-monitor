'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

function tokenRateSource() {
  const start = app.indexOf('function positiveNumber(');
  const end = app.indexOf('function renderTokenRate(', start);
  assert.notEqual(start, -1, 'token-rate helpers should exist');
  assert.notEqual(end, -1, 'renderTokenRate should follow the rate helpers');
  return app.slice(start, end);
}

function tokenRateFunctions() {
  const context = {};
  vm.runInNewContext(
    `${tokenRateSource()}
     this.tokenRateCoverage = tokenRateCoverage;
     this.tokenRatePerSecond = tokenRatePerSecond;
     this.tokenBurnPerMinute = tokenBurnPerMinute;`,
    context
  );
  return context;
}

test('token rate is output tokens per second of timed model duration', () => {
  const { tokenRatePerSecond } = tokenRateFunctions();
  // Full coverage: 1200 output tokens over 30s of model-busy time is 40 tok/s.
  assert.equal(tokenRatePerSecond({ outputTokens: 1200, totalTokens: 9000, timedTokens: 9000, timedDurationMs: 30_000 }), 40);
});

test('token rate scales by coverage so untimed messages do not inflate it', () => {
  const { tokenRateCoverage, tokenRatePerSecond } = tokenRateFunctions();
  // Half the period's tokens carried no duration, so only half the output belongs over this
  // denominator: 1200 * 0.5 / 30s = 20 tok/s rather than the uncorrected 40.
  const period = { outputTokens: 1200, totalTokens: 9000, timedTokens: 4500, timedDurationMs: 30_000 };
  assert.equal(tokenRateCoverage(period), 0.5);
  assert.equal(tokenRatePerSecond(period), 20);
});

test('token rate reads zero when throughput data is missing or unusable', () => {
  const { tokenRatePerSecond } = tokenRateFunctions();
  const base = { outputTokens: 1200, totalTokens: 9000, timedTokens: 9000, timedDurationMs: 30_000 };
  // An older hub payload carries no throughput pair at all.
  assert.equal(tokenRatePerSecond({ outputTokens: 1200, totalTokens: 9000 }), 0);
  assert.equal(tokenRatePerSecond({ ...base, timedDurationMs: 0 }), 0);
  assert.equal(tokenRatePerSecond({ ...base, outputTokens: 0 }), 0);
  assert.equal(tokenRatePerSecond({ ...base, timedTokens: 0 }), 0);
  assert.equal(tokenRatePerSecond(undefined), 0);
});

test('the burn reading needs no coverage correction', () => {
  const { tokenBurnPerMinute, tokenRatePerSecond } = tokenRateFunctions();
  // Only half the tokens were timed. timedTokens already describes exactly the messages that
  // produced timedDurationMs, so burn divides one matched pair: 4500 / 30s = 9000 tok/min.
  const period = { outputTokens: 1200, totalTokens: 9000, timedTokens: 4500, timedDurationMs: 30_000 };
  assert.equal(tokenBurnPerMinute(period), 9000);
  // The speed reading has to scale, because output is not broken out per timed message.
  assert.equal(tokenRatePerSecond(period), 20);
});

test('the burn reading reads zero without throughput data', () => {
  const { tokenBurnPerMinute } = tokenRateFunctions();
  assert.equal(tokenBurnPerMinute({ totalTokens: 9000 }), 0);
  assert.equal(tokenBurnPerMinute({ timedTokens: 4500, timedDurationMs: 0 }), 0);
  assert.equal(tokenBurnPerMinute(undefined), 0);
});

test('the reveal mode is a persisted setting that defaults to speed', () => {
  assert.match(main, /tokenRateMode: 'speed',/);
  assert.match(main, /function normalizeTokenRateMode\(value\) \{\s*return value === 'burn' \? 'burn' : 'speed';/);
  assert.match(main, /merged\.tokenRateMode = normalizeTokenRateMode\(merged\.tokenRateMode\);/);
  assert.match(main, /tokenRateMode: normalizeTokenRateMode\(patch\.tokenRateMode \?\? settings\.tokenRateMode\)/);
  // Hover and click must cover the same surface, so both reveal triggers toggle.
  assert.match(app, /els\.appTitleMark\?\.addEventListener\('click', toggleTokenRateMode\)/);
  assert.match(app, /els\.liveDot\?\.addEventListener\('click', toggleTokenRateMode\)/);
});

test('every element that reveals on hover is also clickable and shows a pointer', () => {
  // An asymmetry here reads as a broken control: you hover the dot, see the number, click,
  // and nothing happens.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector, body }));
  const namesIn = (selector) => (selector.match(/\.(?:app-title-mark|live-dot)\b/g) || []).map((n) => n.slice(1));
  const collect = (predicate) => new Set(rules.filter(predicate).flatMap((rule) => namesIn(rule.selector)));
  const hoverTriggers = collect((rule) => /:hover ~ \.token-rate-reveal/.test(rule.selector));
  const pointerTargets = collect((rule) => /cursor: pointer/.test(rule.body));
  assert.deepEqual([...hoverTriggers].sort(), ['app-title-mark', 'live-dot']);
  for (const trigger of hoverTriggers) {
    assert.ok(pointerTargets.has(trigger), `${trigger} reveals on hover but has no pointer cursor`);
  }
});

test('token rate never divides a live total by a History active time', () => {
  // The numerator and denominator must come from the same tokscale scan. Reading History
  // activeTimeMs would put a 15-minute-stale denominator under a per-tick numerator, which
  // overstates the rate between history ticks.
  const code = tokenRateSource().replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /activeTimeMs/);
  assert.doesNotMatch(code, /homeHistory|historyPreview/);
});

test('token rate is a hover-only reveal beside the compact title mark', () => {
  assert.match(html, /<span id="tokenRateReveal" class="token-rate-reveal" aria-hidden="true"><\/span>/);
  assert.match(app, /tokenRateReveal: document\.getElementById\('tokenRateReveal'\)/);
  assert.match(css, /\.shell\.title-icon-only \.app-title-mark:hover ~ \.token-rate-reveal\.has-value/);
  assert.match(css, /\.shell\.title-collapsed \.live-dot:hover ~ \.token-rate-reveal\.has-value/);
});

test('the no-drag hit area stays scoped to the collapsed title states', () => {
  // Unscoped, the always-visible live dot punches a permanent hole in the frameless
  // window's drag region for users who can never see the reveal.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter(({ selector, body }) => /app-title-mark|live-dot/.test(selector) && /-webkit-app-region:\s*no-drag/.test(body));
  assert.ok(rules.length > 0, 'the title mark and live dot still opt out of the drag region');
  for (const { selector } of rules) {
    assert.match(selector, /\.shell\.title-(collapsed|icon-only)/, `unscoped no-drag rule: ${selector}`);
  }
});
