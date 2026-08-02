'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const tokenRatePresentation = fs.readFileSync(path.join(rendererDir, 'tokenRatePresentation.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const tokenRateApi = require(path.join(rendererDir, 'tokenRatePresentation.js'));

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

function tokenRateSource() {
  return tokenRatePresentation;
}

function tokenRateFunctions() {
  return tokenRateApi;
}

function createBoostHarness({ rate = 100, mode = 'speed', reducedMotion = false, canStart = true } = {}) {
  let now = 0;
  let nextFrameId = 0;
  let enabled = canStart;
  let controller;
  const frames = new Map();
  const changes = [];
  const value = { rate, mode };
  controller = tokenRateApi.createTokenRateBoostController({
    readValue: () => value,
    canStart: () => enabled,
    prefersReducedMotion: () => reducedMotion,
    now: () => now,
    requestFrame: (callback) => {
      const frameId = ++nextFrameId;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelFrame: (frameId) => frames.delete(frameId),
    onChange: () => changes.push(controller.getSnapshot())
  });
  return {
    advance(ms) { now += ms; },
    changes,
    controller,
    frame() {
      const [frameId, callback] = frames.entries().next().value || [];
      assert.notEqual(frameId, undefined, 'a frame should be scheduled');
      frames.delete(frameId);
      callback();
    },
    frames,
    setCanStart(value) { enabled = value; },
    value
  };
}

test('token rate is timed output tokens per second of timed model duration', () => {
  const { tokenRatePerSecond } = tokenRateFunctions();
  // 1200 output tokens, all of them timed, over 30s of model-busy time is 40 tok/s.
  assert.equal(tokenRatePerSecond({ outputTokens: 1200, timedOutputTokens: 1200, timedDurationMs: 30_000 }), 40);
});

test('token rate divides matched numerator and denominator, never the whole period output', () => {
  // Half the period's output came from a client that reports no durations. The collector
  // gates that away per entry, so the renderer must read timedOutputTokens and not
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
  // divides one matched pair straight through: 4500 / 30s = 9000 tok/min.
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

test('holding the title mark accelerates from the real rate and keeps rising', () => {
  const { tokenRateBoostValue, tokenRateSettleValue, tokenRatePerSecond, tokenBurnPerMinute } = tokenRateFunctions();
  assert.equal(tokenRateBoostValue(0, 0), 0);
  assert.equal(tokenRateBoostValue(100, -1), 100);
  assert.ok(tokenRateBoostValue(100, 520) >= 200);
  assert.ok(tokenRateBoostValue(100, 1000) > 300);
  assert.ok(tokenRateBoostValue(100, 2000) > tokenRateBoostValue(100, 1000));
  const boosted = tokenRateBoostValue(100, 2000);
  assert.ok(tokenRateSettleValue(boosted, 100, 360) < boosted);
  assert.ok(tokenRateSettleValue(boosted, 100, 360) > 100);
  assert.equal(tokenRateSettleValue(boosted, 100, 720), 100);
  assert.equal(tokenRateBoostValue(100, Number.POSITIVE_INFINITY), tokenRateApi.TOKEN_RATE_MAX_DISPLAY_RATE);
  assert.ok(Number.isFinite(tokenRateBoostValue(100, 30_000)));
  assert.equal(tokenRatePerSecond({ timedOutputTokens: Number.MAX_VALUE, timedDurationMs: 1 }), tokenRateApi.TOKEN_RATE_MAX_DISPLAY_RATE);
  assert.equal(tokenBurnPerMinute({ timedTokens: Number.MAX_VALUE, timedDurationMs: 1 }), tokenRateApi.TOKEN_RATE_MAX_DISPLAY_RATE);
  assert.equal(tokenRateSettleValue(Number.POSITIVE_INFINITY, 100, 0), tokenRateApi.TOKEN_RATE_MAX_DISPLAY_RATE);
});

test('the boost controller cancels pointercancel and blur immediately', () => {
  for (const cancelEvent of [{ type: 'pointercancel', pointerId: 7 }, undefined]) {
    const harness = createBoostHarness();
    assert.equal(harness.controller.start({ button: 0, pointerId: 7 }), true);
    harness.advance(300);
    assert.equal(harness.controller.cancel(cancelEvent), true);
    assert.equal(harness.controller.getSnapshot(), null);
    assert.equal(harness.frames.size, 0);
    assert.equal(harness.controller.consumeClick(), true);
    assert.equal(harness.controller.consumeClick(), false);
  }
});

test('a canceled gesture without a click does not suppress the next short click', () => {
  const harness = createBoostHarness();
  assert.equal(harness.controller.start({ button: 0, pointerId: 1 }), true);
  harness.advance(300);
  assert.equal(harness.controller.cancel({ type: 'pointercancel', pointerId: 1 }), true);
  assert.equal(harness.controller.getSnapshot(), null);

  assert.equal(harness.controller.start({ button: 0, pointerId: 2 }), true);
  harness.advance(100);
  assert.equal(harness.controller.release({ type: 'pointerup', pointerId: 2 }), false);
  assert.equal(harness.controller.consumeClick(), false);
});

test('the boost controller does not start without a usable rate', () => {
  const harness = createBoostHarness({ rate: 0 });
  assert.equal(harness.controller.start({ button: 0, pointerId: 1 }), false);
  assert.equal(harness.controller.getSnapshot(), null);
  assert.equal(harness.frames.size, 0);
});

test('reduced motion disables the transient boost', () => {
  const harness = createBoostHarness({ reducedMotion: true });
  assert.equal(harness.controller.start({ button: 0, pointerId: 1 }), false);
  assert.equal(harness.controller.getSnapshot(), null);
  assert.equal(harness.frames.size, 0);
});

test('a short click clears the transient state without suppressing the mode toggle', () => {
  const harness = createBoostHarness();
  assert.equal(harness.controller.start({ button: 0, pointerId: 1 }), true);
  harness.advance(100);
  assert.equal(harness.controller.release({ type: 'pointerup', pointerId: 1 }), false);
  assert.equal(harness.controller.getSnapshot(), null);
  assert.equal(harness.controller.consumeClick(), false);
});

test('a held pointer settles to the latest rate and suppresses only the next click', () => {
  const harness = createBoostHarness();
  assert.equal(harness.controller.start({ button: 0, pointerId: 1 }), true);
  harness.advance(2_000);
  harness.value.rate = 40;
  assert.equal(harness.controller.release({ type: 'pointerup', pointerId: 1 }), true);
  assert.equal(harness.controller.getSnapshot().phase, 'settling');
  assert.equal(harness.controller.getSnapshot().settleToRate, 40);
  assert.equal(harness.controller.consumeClick(), true);
  assert.equal(harness.controller.consumeClick(), false);
  harness.advance(360);
  harness.frame();
  assert.equal(harness.controller.getSnapshot().phase, 'settling');
  harness.advance(360);
  harness.frame();
  assert.equal(harness.controller.getSnapshot(), null);
});

test('settling retargets from the current display to a live rate without extending the animation', () => {
  const harness = createBoostHarness();
  assert.equal(harness.controller.start({ button: 0, pointerId: 1 }), true);
  harness.advance(1_000);
  assert.equal(harness.controller.release({ type: 'pointerup', pointerId: 1 }), true);

  harness.advance(240);
  const beforeRetarget = harness.controller.getSnapshot();
  const currentDisplayRate = beforeRetarget.displayRate;
  harness.value.rate = 500;
  assert.equal(harness.controller.refresh(), true);

  const afterRetarget = harness.controller.getSnapshot();
  assert.equal(afterRetarget.settleToRate, 500);
  assert.equal(afterRetarget.settleFromRate, currentDisplayRate);
  assert.equal(afterRetarget.displayRate, currentDisplayRate);
  assert.equal(afterRetarget.settleDurationMs, 480);

  harness.advance(480);
  harness.frame();
  assert.equal(harness.controller.getSnapshot(), null);
});

test('a new hold interrupts settling and suppresses its own click', () => {
  const harness = createBoostHarness();
  assert.equal(harness.controller.start({ button: 0, pointerId: 1 }), true);
  harness.advance(1_000);
  assert.equal(harness.controller.release({ type: 'pointerup', pointerId: 1 }), true);
  assert.equal(harness.controller.consumeClick(), true);

  assert.equal(harness.controller.start({ button: 0, pointerId: 2 }), true);
  harness.advance(300);
  assert.equal(harness.controller.release({ type: 'pointerup', pointerId: 2 }), true);
  assert.equal(harness.controller.getSnapshot().phase, 'settling');
  assert.equal(harness.controller.consumeClick(), true);
});

test('a failed new hold does not clear settling without a repaint', () => {
  const harness = createBoostHarness();
  assert.equal(harness.controller.start({ button: 0, pointerId: 1 }), true);
  harness.advance(1_000);
  assert.equal(harness.controller.release({ type: 'pointerup', pointerId: 1 }), true);
  const changesBeforeFailedStart = harness.changes.length;

  harness.setCanStart(false);
  assert.equal(harness.controller.start({ button: 0, pointerId: 2 }), false);
  assert.equal(harness.controller.getSnapshot().phase, 'settling');
  assert.equal(harness.changes.length, changesBeforeFailedStart);
});

test('a new hold with no rate does not clear settling without a repaint', () => {
  const harness = createBoostHarness();
  assert.equal(harness.controller.start({ button: 0, pointerId: 1 }), true);
  harness.advance(1_000);
  assert.equal(harness.controller.release({ type: 'pointerup', pointerId: 1 }), true);
  const changesBeforeFailedStart = harness.changes.length;
  assert.equal(harness.frames.size, 1);

  harness.value.rate = 0;
  assert.equal(harness.controller.start({ button: 0, pointerId: 2 }), false);
  assert.equal(harness.controller.getSnapshot().phase, 'settling');
  assert.equal(harness.changes.length, changesBeforeFailedStart);
  assert.equal(harness.frames.size, 1);
});

test('lost pointer capture cancels boosting but preserves a normal release settlement', () => {
  const canceled = createBoostHarness();
  assert.equal(canceled.controller.start({ button: 0, pointerId: 1 }), true);
  canceled.advance(300);
  assert.equal(canceled.controller.cancel({ type: 'lostpointercapture', pointerId: 1 }, { preserveSettling: true }), true);
  assert.equal(canceled.controller.getSnapshot(), null);

  const released = createBoostHarness();
  assert.equal(released.controller.start({ button: 0, pointerId: 1 }), true);
  released.advance(300);
  assert.equal(released.controller.release({ type: 'pointerup', pointerId: 1 }), true);
  assert.equal(released.controller.cancel({ type: 'lostpointercapture', pointerId: 1 }, { preserveSettling: true }), false);
  assert.equal(released.controller.getSnapshot().phase, 'settling');
});

test('mode changes cancel settling before the next interaction uses the new unit', () => {
  const harness = createBoostHarness();
  assert.equal(harness.controller.start({ button: 0, pointerId: 1 }), true);
  harness.advance(1_000);
  assert.equal(harness.controller.release({ type: 'pointerup', pointerId: 1 }), true);
  assert.equal(harness.controller.getSnapshot().mode, 'speed');
  assert.equal(harness.controller.cancel(undefined, { suppressClick: false }), true);
  harness.value.mode = 'burn';
  assert.equal(harness.controller.start({ button: 0, pointerId: 2 }), true);
  assert.equal(harness.controller.getSnapshot().mode, 'burn');
});

test('the reveal mode is a persisted setting that defaults to speed', () => {
  assert.match(main, /tokenRateMode: 'speed',/);
  assert.match(main, /function normalizeTokenRateMode\(value\) \{\s*return value === 'burn' \? 'burn' : 'speed';/);
  assert.match(main, /merged\.tokenRateMode = normalizeTokenRateMode\(merged\.tokenRateMode\);/);
  assert.match(main, /tokenRateMode: normalizeTokenRateMode\(patch\.tokenRateMode \?\? settings\.tokenRateMode\)/);
  // Hover and click must cover the same surface, so both reveal triggers toggle.
  assert.match(app, /els\.appTitleMark\?\.addEventListener\('click', toggleTokenRateMode\)/);
  assert.match(app, /els\.liveDot\?\.addEventListener\('click', toggleTokenRateMode\)/);
  const presentationIndex = html.indexOf('<script src="tokenRatePresentation.js"></script>');
  const appIndex = html.indexOf('<script src="app.js"></script>');
  assert.notEqual(presentationIndex, -1);
  assert.ok(presentationIndex < appIndex);
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
  // with the pointer nowhere near the title. Pointer-only is the design, so the markup must stay
  // inert; the separate visibility cancellation path only protects transient hold state.
  //
  // This asserts the markup rather than the behaviour because the behaviour is not observable
  // from here — it needs a real Electron window. Making these focusable is not banned forever:
  // it needs evidence that a hidden-then-shown window no longer opens the reveal or draws a ring
  // on its own.
  const reason = 'focusable here reopens the reveal on window show; see the comment above';
  const triggers = [...html.matchAll(/<(\w+)([^>]*\bclass="(?:app-title-mark|live-dot)"[^>]*)>/g)];
  assert.equal(triggers.length, 2, 'both reveal triggers are present in the title');
  for (const [, tag, attrs] of triggers) {
    assert.notEqual(tag, 'button', reason);
    assert.doesNotMatch(attrs, /tabindex/, reason);
  }
  assert.doesNotMatch(css, /app-title-mark:focus/, reason);
});

test('the token-rate hold has release, cancellation, reduced-motion, and click-guard paths', () => {
  assert.match(app, /function startTokenRateBoost\(event\)/);
  assert.match(app, /function releaseTokenRateBoost\(event\)/);
  assert.match(app, /function cancelTokenRateBoost\(event, options\)/);
  assert.match(tokenRatePresentation, /const TOKEN_RATE_BOOST_DOUBLING_MS = 520/);
  assert.match(tokenRatePresentation, /const TOKEN_RATE_SETTLE_MS = 720/);
  assert.match(tokenRatePresentation, /function tokenRateSettleValue\(fromRate, toRate, elapsedMs, durationMs/);
  assert.match(tokenRatePresentation, /phase: 'settling'/);
  assert.match(tokenRatePresentation, /requestFrame\(step\)/);
  assert.match(app, /tokenRateBoost\.refresh\(\);\s*const \{ burn, rate \} = currentTokenRateValue\(\)/);
  assert.match(app, /document\.addEventListener\('pointercancel', \(event\) => \{\s*cancelTokenRateBoost\(event\)/);
  assert.match(app, /window\.addEventListener\('blur', \(\) => \{\s*cancelTokenRateBoost\(\)/);
  assert.match(app, /if \(document\.hidden\) cancelTokenRateBoost\(\)/);
  assert.match(tokenRatePresentation, /const enabled = canStart\(\);/);
  assert.match(tokenRatePresentation, /const reduced = prefersReducedMotion\(\);/);
  assert.match(tokenRatePresentation, /if \(!enabled \|\| reduced\) return false/);
  assert.match(tokenRatePresentation, /if \(!\(value\.rate > 0\)\) return false/);
  assert.match(tokenRatePresentation, /if \(state\?\.phase === 'settling'\) \{[\s\S]*?cancelScheduledFrame\(\)/);
  assert.match(app, /cancelTokenRateBoost\(event, \{ preserveSettling: true \}\)/);
  assert.match(app, /function suppressTokenRateClickAfterHold\(event\)/);
  assert.match(tokenRatePresentation, /function consumeClick\(\)/);
  assert.match(app, /tokenRateBoost\.cancel\(undefined, \{ suppressClick: false \}\)/);
  assert.match(css, /\.shell\.title-icon-only \.token-rate-reveal\.boosting/);
  assert.match(css, /\.shell\.title-icon-only \.token-rate-reveal\.settling/);
  assert.match(css, /color: var\(--accent\)/);
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
