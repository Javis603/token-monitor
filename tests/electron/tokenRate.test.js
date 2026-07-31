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
     this.tokenRatePerSecond = tokenRatePerSecond;
     this.tokenBurnPerMinute = tokenBurnPerMinute;`,
    context
  );
  return context;
}

test('token rate is timed output tokens per second of timed model duration', () => {
  const { tokenRatePerSecond } = tokenRateFunctions();
  // 1200 output tokens, all of them timed, over 30s of model-busy time is 40 tok/s.
  assert.equal(tokenRatePerSecond({ outputTokens: 1200, timedOutputTokens: 1200, timedDurationMs: 30_000 }), 40);
});

test('token rate divides matched numerator and denominator, never the whole period output', () => {
  // Half the period's output came from a client that reports no durations. The collector
  // apportions that away per entry, so the renderer must read timedOutputTokens and not
  // re-derive anything from outputTokens or totalTokens — doing so would report 40 tok/s for
  // work that actually ran at 20.
  const { tokenRatePerSecond } = tokenRateFunctions();
  const period = { outputTokens: 1200, totalTokens: 9000, timedOutputTokens: 600, timedTokens: 4500, timedDurationMs: 30_000 };
  assert.equal(tokenRatePerSecond(period), 20);
  const code = tokenRateSource().replace(/^\s*\/\/.*$/gm, '');
  const speedBody = code.slice(code.indexOf('function tokenRatePerSecond('));
  assert.doesNotMatch(speedBody, /totalTokens/, 'the speed reading must not rebuild coverage from period totals');
});

test('token rate reads zero when throughput data is missing or unusable', () => {
  const { tokenRatePerSecond } = tokenRateFunctions();
  const base = { outputTokens: 1200, timedOutputTokens: 1200, timedDurationMs: 30_000 };
  // An older hub payload carries no throughput fields at all.
  assert.equal(tokenRatePerSecond({ outputTokens: 1200, totalTokens: 9000 }), 0);
  assert.equal(tokenRatePerSecond({ ...base, timedDurationMs: 0 }), 0);
  assert.equal(tokenRatePerSecond({ ...base, timedOutputTokens: 0 }), 0);
  assert.equal(tokenRatePerSecond(undefined), 0);
});

test('the burn reading uses the token pair rather than the output one', () => {
  const { tokenBurnPerMinute, tokenRatePerSecond } = tokenRateFunctions();
  // timedTokens already describes exactly the messages that produced timedDurationMs, so burn
  // divides one matched pair with no apportioning at all: 4500 / 30s = 9000 tok/min.
  const period = { outputTokens: 1200, totalTokens: 9000, timedOutputTokens: 600, timedTokens: 4500, timedDurationMs: 30_000 };
  assert.equal(tokenBurnPerMinute(period), 9000);
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

test('the reveal triggers stay non-focusable', () => {
  // Making either trigger focusable reopens the reveal on its own: the window assigns focus to
  // a control when it is shown, and Chromium derives :focus-visible from that activation rather
  // than from any click, so the reading and a focus ring appear on a freshly summoned window
  // with the pointer nowhere near the title. The renderer cannot undo it either — it receives
  // no blur, focus or visibilitychange event across a real hide and show. Pointer-only is the
  // design, so the markup must stay inert.
  const triggers = [...html.matchAll(/<(\w+)([^>]*\bclass="(?:app-title-mark|live-dot)"[^>]*)>/g)];
  assert.equal(triggers.length, 2, 'both reveal triggers are present in the title');
  for (const [, tag, attrs] of triggers) {
    assert.notEqual(tag, 'button', 'a button here takes focus on window show');
    assert.doesNotMatch(attrs, /tabindex/, 'a tabindex here takes focus on window show');
  }
  assert.doesNotMatch(css, /app-title-mark:focus/, 'no focus styling implies nothing focusable');
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
