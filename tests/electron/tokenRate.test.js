'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const tokenRatePresentation = fs.readFileSync(path.join(rendererDir, 'tokenRatePresentation.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const tokenRateApi = require(path.join(rendererDir, 'tokenRatePresentation.js'));
const trayLayout = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', 'trayLayout.js'), 'utf8');
const trayComposer = fs.readFileSync(path.join(rendererDir, 'trayComposer.js'), 'utf8');
const i18n = fs.readFileSync(path.join(rendererDir, 'i18n.js'), 'utf8');
const traySource = fs.readFileSync(path.join(rendererDir, '..', 'tray.js'), 'utf8');

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
  const speedBody = tokenRatePerSecond.toString();
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

test('live rate is derived from one successful snapshot delta', () => {
  let now = 1000;
  const tracker = tokenRateApi.createLiveTokenRateTracker({ now: () => now });
  assert.equal(tracker.observe({ timedTokens: 1000, timedOutputTokens: 100, timedDurationMs: 2000 }), null);

  now = 2500;
  const sample = tracker.observe({ timedTokens: 1600, timedOutputTokens: 148, timedDurationMs: 3200 });
  assert.equal(sample.speed, 40);
  assert.equal(sample.burn, 30000);
  assert.equal(sample.sampledAt, 2500);
  assert.equal(sample.timedTokens, 600);
  assert.equal(sample.timedOutputTokens, 48);
  assert.equal(sample.timedDurationMs, 1200);
  assert.equal(tracker.value('speed'), 40);
  assert.equal(tracker.value('burn'), 30000);
});

test('duplicate live snapshots retain the last sample without making it look fresh', () => {
  let now = 100;
  const tracker = tokenRateApi.createLiveTokenRateTracker({ now: () => now });
  tracker.observe({ timedTokens: 10, timedOutputTokens: 2, timedDurationMs: 100 });
  now = 200;
  const first = tracker.observe({ timedTokens: 30, timedOutputTokens: 10, timedDurationMs: 500 });
  now = 5000;
  const duplicate = tracker.observe({ timedTokens: 30, timedOutputTokens: 10, timedDurationMs: 500 });
  assert.equal(duplicate, first);
  assert.equal(duplicate.sampledAt, 200);
  assert.equal(duplicate.revision, 1);
});

test('live rate resets on counter regression and waits for a fresh delta', () => {
  const tracker = tokenRateApi.createLiveTokenRateTracker({ now: () => 100 });
  tracker.observe({ timedTokens: 100, timedOutputTokens: 20, timedDurationMs: 1000 });
  assert.ok(tracker.observe({ timedTokens: 200, timedOutputTokens: 40, timedDurationMs: 1500 }));

  assert.equal(tracker.observe({ timedTokens: 5, timedOutputTokens: 1, timedDurationMs: 20 }), null);
  assert.equal(tracker.getSample(), null);
  assert.equal(tracker.observe({ timedTokens: 5, timedOutputTokens: 1, timedDurationMs: 20 }), null);
  const recovered = tracker.observe({ timedTokens: 65, timedOutputTokens: 13, timedDurationMs: 620 });
  assert.equal(recovered.speed, 20);
  assert.equal(recovered.burn, 6000);
});

test('live rate waits for two complete timing snapshots', () => {
  const tracker = tokenRateApi.createLiveTokenRateTracker({ now: () => 100 });
  assert.equal(tracker.observe({ totalTokens: 5000 }), null);
  assert.equal(tracker.observe({ timedTokens: 5000, timedOutputTokens: 500, timedDurationMs: 5000 }), null);
  const sample = tracker.observe({ timedTokens: 5060, timedOutputTokens: 512, timedDurationMs: 5600 });
  assert.equal(sample.speed, 20);
  assert.equal(sample.burn, 6000);
});

test('normalized legacy timing defaults never become a live-rate baseline', () => {
  const tracker = tokenRateApi.createLiveTokenRateTracker({ now: () => 100 });
  const legacy = {
    capabilities: { throughput: false },
    timedTokens: 0,
    timedOutputTokens: 0,
    timedDurationMs: 0
  };
  assert.equal(tracker.observe(legacy), null);
  assert.equal(tracker.observe({ timedTokens: 5000, timedOutputTokens: 500, timedDurationMs: 5000 }), null);
});

test('an incomplete timing snapshot clears a stale live sample and baseline', () => {
  const tracker = tokenRateApi.createLiveTokenRateTracker({ now: () => 100 });
  tracker.observe({ timedTokens: 10, timedOutputTokens: 2, timedDurationMs: 100 });
  assert.ok(tracker.observe({ timedTokens: 30, timedOutputTokens: 10, timedDurationMs: 500 }));
  assert.equal(tracker.observe({ totalTokens: 1000 }), null);
  assert.equal(tracker.getSample(), null);
  assert.equal(tracker.observe({ timedTokens: 1000, timedOutputTokens: 100, timedDurationMs: 1000 }), null);
});

test('live rate ignores untimed changes but keeps the baseline current', () => {
  const tracker = tokenRateApi.createLiveTokenRateTracker();
  tracker.observe({ timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 });
  assert.equal(tracker.observe({ timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 }), null);
  assert.equal(tracker.getSample(), null);
  const sample = tracker.observe({ timedTokens: 120, timedOutputTokens: 24, timedDurationMs: 600 });
  assert.equal(sample.speed, 40);
  assert.equal(sample.burn, 12000);
});

test('live rate sums active device samples, then retains the last value dimmed for three minutes', () => {
  let now = 0;
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker({ now: () => now, activeMs: 8000, clearMs: 180000 });
  const baseA = { timedTokens: 100, timedOutputTokens: 10, timedDurationMs: 100 };
  const baseB = { timedTokens: 200, timedOutputTokens: 20, timedDurationMs: 1000 };
  tracker.reset([
    { id: 'device:a', period: baseA },
    { id: 'device:b', period: baseB }
  ]);
  assert.equal(tracker.getSample(), null);

  now = 100;
  const first = tracker.observe([
    { id: 'device:a', period: { timedTokens: 160, timedOutputTokens: 22, timedDurationMs: 700 } },
    { id: 'device:b', period: baseB }
  ]);
  assert.equal(first.changed, true);
  assert.deepEqual(first.sample, {
    speed: 20,
    burn: 6000,
    sampledAt: 100,
    expiresAt: 8100,
    devices: [],
    deviceCount: 1,
    revision: 1,
    idle: false
  });

  now = 200;
  const second = tracker.observe([
    { id: 'device:a', period: { timedTokens: 160, timedOutputTokens: 22, timedDurationMs: 700 } },
    { id: 'device:b', period: { timedTokens: 320, timedOutputTokens: 50, timedDurationMs: 2000 } }
  ]);
  assert.equal(second.changed, true);
  assert.deepEqual(second.sample, {
    speed: 50,
    burn: 13200,
    sampledAt: 200,
    expiresAt: 8100,
    devices: [],
    deviceCount: 2,
    revision: 2,
    idle: false
  });
  assert.equal(tracker.nextExpiryAt(), 8100);

  now = 8100;
  assert.deepEqual(tracker.getSample(), {
    speed: 30,
    burn: 7200,
    sampledAt: 200,
    expiresAt: 8200,
    devices: [],
    deviceCount: 1,
    revision: 2,
    idle: false
  });
  now = 8200;
  assert.deepEqual(tracker.getSample(), {
    speed: 30,
    burn: 7200,
    sampledAt: 200,
    expiresAt: 180200,
    devices: [],
    deviceCount: 1,
    revision: 2,
    idle: true
  });
  assert.equal(tracker.nextExpiryAt(), 180200);
  now = 180200;
  assert.equal(tracker.getSample(), null);
  assert.equal(tracker.nextExpiryAt(), null);
});

test('live rate removes a missing device sample while retaining the other device', () => {
  let now = 0;
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker({ now: () => now, activeMs: 8000 });
  tracker.reset([
    { id: 'device:a', period: { timedTokens: 10, timedOutputTokens: 2, timedDurationMs: 100 } },
    { id: 'device:b', period: { timedTokens: 20, timedOutputTokens: 4, timedDurationMs: 200 } }
  ]);
  now = 100;
  tracker.observe([
    { id: 'device:a', period: { timedTokens: 70, timedOutputTokens: 14, timedDurationMs: 700 } },
    { id: 'device:b', period: { timedTokens: 80, timedOutputTokens: 16, timedDurationMs: 800 } }
  ]);

  now = 200;
  const result = tracker.observe([
    { id: 'device:b', period: { timedTokens: 80, timedOutputTokens: 16, timedDurationMs: 800 } }
  ]);
  assert.equal(result.changed, true);
  assert.equal(result.sample.deviceCount, 1);
  assert.equal(result.sample.speed, 20);
  assert.equal(result.sample.burn, 6000);
});

test('live rate retains the last aggregate when its only device becomes stale', () => {
  let now = 0;
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker({ now: () => now, activeMs: 8000, clearMs: 180000 });
  tracker.reset([
    { id: 'device:a', period: { timedTokens: 10, timedOutputTokens: 2, timedDurationMs: 100 } }
  ]);
  now = 100;
  tracker.observe([
    { id: 'device:a', period: { timedTokens: 70, timedOutputTokens: 14, timedDurationMs: 700 } }
  ]);

  now = 200;
  assert.deepEqual(tracker.observe([]), {
    changed: true,
    sample: {
      speed: 20,
      burn: 6000,
      sampledAt: 100,
      expiresAt: 180100,
      devices: [],
      deviceCount: 1,
      revision: 1,
      idle: true
    }
  });
  now = 180100;
  assert.equal(tracker.getSample(), null);
});

test('live rate group revisions stay monotonic across scope resets', () => {
  let now = 0;
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker({ now: () => now, activeMs: 8000 });
  tracker.reset([
    { id: 'device:a', period: { timedTokens: 10, timedOutputTokens: 2, timedDurationMs: 100 } }
  ]);
  now = 100;
  assert.equal(tracker.observe([
    { id: 'device:a', period: { timedTokens: 70, timedOutputTokens: 14, timedDurationMs: 700 } }
  ]).sample.revision, 1);

  tracker.reset([
    { id: 'device:b', period: { timedTokens: 20, timedOutputTokens: 4, timedDurationMs: 200 } }
  ]);
  assert.equal(tracker.getSample(), null);
  now = 200;
  assert.equal(tracker.observe([
    { id: 'device:b', period: { timedTokens: 80, timedOutputTokens: 16, timedDurationMs: 800 } }
  ]).sample.revision, 2);
});

test('live rate selects every active hub device or only this device by scope', () => {
  const aggregate = { timedTokens: 9000, timedOutputTokens: 900, timedDurationMs: 9000 };
  const local = { timedTokens: 120, timedOutputTokens: 24, timedDurationMs: 600 };
  const other = { timedTokens: 300, timedOutputTokens: 60, timedDurationMs: 1500 };
  const stale = { timedTokens: 600, timedOutputTokens: 120, timedDurationMs: 3000 };
  const stats = {
    periods: { today: aggregate },
    devices: [
      { deviceId: 'other', periods: { today: other } },
      { deviceId: 'this-device', periods: { today: local } },
      { deviceId: 'stale', stale: true, periods: { today: stale } }
    ]
  };

  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods(stats, 'this-device', 'client'), {
    entries: [
      { id: 'device:other', name: 'other', period: other },
      { id: 'device:this-device', name: 'this-device', period: local }
    ],
    source: 'devices:all'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods(stats, 'this-device', 'host', 'all'), {
    entries: [
      { id: 'device:other', name: 'other', period: other },
      { id: 'device:this-device', name: 'this-device', period: local }
    ],
    source: 'devices:all'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods(stats, 'this-device', 'icloud', 'all'), {
    entries: [
      { id: 'device:other', name: 'other', period: other },
      { id: 'device:this-device', name: 'this-device', period: local }
    ],
    source: 'devices:all'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods(stats, 'this-device', 'client', 'device'), {
    entries: [{ id: 'device:this-device', name: 'this-device', period: local }],
    source: 'device:this-device'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods(stats, 'missing', 'client', 'device'), {
    entries: [],
    source: 'device:missing'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods(stats, 'missing', 'icloud', 'device'), {
    entries: [],
    source: 'device:missing'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods(stats, 'this-device', 'local'), {
    entries: [{ id: 'device:this-device', name: 'this-device', period: local }],
    source: 'device:this-device'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods(stats, 'missing', 'local'), {
    entries: [{ id: 'device:missing', name: 'missing', period: aggregate }],
    source: 'device:missing'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods({ periods: { today: aggregate }, devices: [] }, 'this-device', 'local'), {
    entries: [{ id: 'device:this-device', name: 'this-device', period: aggregate }],
    source: 'device:this-device'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods({
    periods: { today: aggregate },
    devices: [{ deviceId: 'old-device', periods: { today: other } }]
  }, 'this-device', 'local'), {
    entries: [{ id: 'device:this-device', name: 'this-device', period: aggregate }],
    source: 'device:this-device'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods({
    periods: { today: aggregate },
    devices: [{ deviceId: 'old-device', periods: { today: other } }]
  }, 'this-device', 'client', 'device'), {
    entries: [],
    source: 'device:this-device'
  });
  assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods({
    periods: { today: aggregate },
    devices: [{ deviceId: 'old-device', periods: { today: other } }]
  }, 'this-device', 'icloud', 'device'), {
    entries: [],
    source: 'device:this-device'
  });
});

test('all live-rate surfaces use shared scope for iCloud', () => {
  assert.equal(tokenRateApi.isSharedSyncMode('icloud'), true);
  assert.equal(tokenRateApi.isSharedSyncMode('local'), false);
  assert.match(app, /function effectiveLiveTokenRateScope\(\)[\s\S]*?tokenRateApi\.isSharedSyncMode\(hubMode\)/);
  assert.match(app, /function effectiveDisplayLiveTokenRateScope\(scope\)[\s\S]*?tokenRateApi\.isSharedSyncMode\(hubMode\)/);
  assert.match(app, /const liveRateHasScope = state\.settings\.showLiveTokenRate === true\s*&& tokenRateApi\.isSharedSyncMode\(state\.settings\.hubMode\)/);
  assert.match(main, /function edgeDockLiveRateSample\(visibleStats\)[\s\S]*?tokenRateApi\.isSharedSyncMode\(hubMode\)/);
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

test('the live footer rate is opt-in, accessible, and shares the persisted mode', () => {
  assert.match(main, /showLiveTokenRate: false,/);
  assert.match(main, /liveTokenRateScope: 'all',/);
  assert.match(main, /merged\.showLiveTokenRate = parseBoolean\(merged\.showLiveTokenRate, false\)/);
  assert.match(main, /merged\.liveTokenRateScope = normalizeLiveTokenRateScope\(merged\.liveTokenRateScope\)/);
  assert.match(main, /showLiveTokenRate: parseBoolean\(patch\.showLiveTokenRate \?\? settings\.showLiveTokenRate, false\)/);
  assert.match(main, /liveTokenRateScope: normalizeLiveTokenRateScope\(patch\.liveTokenRateScope \?\? settings\.liveTokenRateScope\)/);
  assert.match(html, /id="showLiveTokenRateInput" type="checkbox"/);
  assert.match(html, /id="liveTokenRateScopeRow" class="settings-item hidden"/);
  assert.match(html, /id="liveTokenRateScopeInput"/);
  assert.match(html, /<option value="all"[^>]*>All devices<\/option><option value="device"[^>]*>This device<\/option>/);
  assert.match(html, /<button id="liveTokenRate" class="live-token-rate hidden is-idle" type="button"[^>]*aria-label=/);
  assert.match(app, /showLiveTokenRateInput: document\.getElementById\('showLiveTokenRateInput'\)/);
  assert.match(app, /liveTokenRateScopeInput: document\.getElementById\('liveTokenRateScopeInput'\)/);
  assert.match(app, /showLiveTokenRate: Boolean\(els\.showLiveTokenRateInput\.checked\)/);
  assert.match(app, /liveTokenRateScope: els\.liveTokenRateScopeInput\?\.value === 'device' \? 'device' : 'all'/);
  assert.match(app, /els\.showLiveTokenRateInput\.checked = state\.settings\.showLiveTokenRate === true/);
  assert.match(app, /els\.liveTokenRateScopeInput\.value = state\.settings\.liveTokenRateScope === 'device' \? 'device' : 'all'/);
  const clickBinding = app.match(/els\.liveTokenRate\?\.addEventListener\('click',[\s\S]*?\n\}\);/);
  assert.ok(clickBinding, 'the footer must register its click handler');
  let footerClick, modeChanges = 0;
  vm.runInNewContext(clickBinding[0], {
    els: { liveTokenRate: { addEventListener(event, listener) {
      assert.equal(event, 'click');
      footerClick = listener;
    } } },
    toggleTokenRateMode: () => { modeChanges += 1; }
  });
  assert.equal(typeof footerClick, 'function');
  const tooltip = {};
  footerClick({ target: { closest(selector) {
    assert.equal(selector, '.limit-detail-tooltip');
    return tooltip;
  } } });
  assert.equal(modeChanges, 0, 'clicking a tooltip row must leave the displayed rate mode unchanged');
  footerClick({ target: { closest: () => null } });
  assert.equal(modeChanges, 1, 'clicking the footer button must still switch rate mode');
  footerClick({ target: { closest: () => null } });
  assert.equal(modeChanges, 2, 'ordinary button descendants must retain the same click action');
  assert.match(app, /state\.stats = sessionStatsForDisplay\(allTimeSessions\.attach\(payload\.data\.stats\)\);\s*observeLiveTokenRate\(state\.stats\);/);
  assert.match(app, /observeLiveTokenRate\(nextStats\);\s*allTimeSessions\.invalidate\(\);\s*state\.stats = sessionStatsForDisplay\(allTimeSessions\.attach\(nextStats\)\);/);
  assert.match(app, /createLiveTokenRateGroupTracker\([\s\S]*activeMs: LIVE_TOKEN_RATE_ACTIVE_MS[\s\S]*\)/);
  assert.match(app, /const LIVE_TOKEN_RATE_ACTIVE_MS = 8000;/);
  assert.match(app, /const LIVE_TOKEN_RATE_CLEAR_MS = 3 \* 60 \* 1000;/);
  assert.match(app, /clearMs: LIVE_TOKEN_RATE_CLEAR_MS/);
  assert.match(app, /selectLiveTokenRatePeriods\([\s\S]*stats,[\s\S]*state\.settings\?\.deviceId,[\s\S]*state\.settings\?\.hubMode,[\s\S]*effectiveLiveTokenRateScope\(\)[\s\S]*\)/);
  assert.match(app, /return syncMode && state\.settings\?\.liveTokenRateScope !== 'device' \? 'all' : 'device';/);
  assert.match(app, /function observeLiveTokenRate\(stats\) \{\s*if \(state\.settings\?\.showLiveTokenRate !== true\) return;/);
  assert.match(app, /const result = liveTokenRateTracker\.observe\(selection\.entries\);\s*if \(result\.changed\) scheduleLiveTokenRateExpiry\(\);\s*renderLiveTokenRate\(stats\);/);
  assert.match(app, /const idle = !sample \|\| sample\.idle === true;/);
  assert.match(app, /idle && sample[\s\S]*home\.liveTokenRate\.burnIdleTitle[\s\S]*home\.liveTokenRate\.speedIdleTitle/);
  assert.match(app, /els\.liveTokenRate\.tabIndex = enabled && !obscured \? 0 : -1;/);
  assert.match(app, /els\.liveTokenRate\.setAttribute\('aria-hidden', String\(!enabled \|\| obscured\)\);/);
  assert.match(app, /if \(!enabled\) \{\s*resetLiveTokenRateTracking\(\);/);
  assert.match(app, /if \(state\.settings\.showLiveTokenRate\) observeLiveTokenRate\(state\.stats\);/);
  assert.match(app, /els\.liveTokenRateScopeInput\?\.addEventListener\('change'/);
  assert.match(css, /\.live-token-rate-icon[\s\S]*icons\/actions\/zap\.svg/);
  assert.match(css, /--view-switcher-max-width: min\(112px, max\(0px, calc\(50% - 66px\)\)\)/);
  assert.match(css, /\.footer\.live-token-rate-obscured \.live-token-rate,[\s\S]*visibility: hidden;/);
});

test('compact display surfaces can render live rates independently of the footer setting', () => {
  assert.match(trayLayout, /'liveTokenRate'/);
  assert.match(trayLayout, /rateMode: 'speed'/);
  assert.match(trayLayout, /rateScope: 'all'/);
  assert.match(trayLayout, /options\.liveTokenRates\?\./);
  assert.match(trayLayout, /available: Boolean\(sample && sample\.idle !== true\)/);
  assert.match(trayComposer, /styles: \['percent',[\s\S]*'liveTokenRate'/);
  assert.match(trayComposer, /function liveTokenRateEditor\(item, rowIndex = 0\)/);
  assert.match(trayComposer, /for \(const style of group\.styles\)/);
  assert.match(trayComposer, /function textMetricChoices\(\)/);
  assert.match(trayComposer, /const metrics = textMetricChoices\(\)/);
  assert.match(trayComposer, /if \(metric === 'liveTokenRate'\) \{[\s\S]*liveTokenRateEditor\(item, rowIndex\)/);
  assert.match(trayComposer, /rateMode\.speed/);
  assert.match(trayComposer, /rateScope\.device/);
  assert.match(main, /const TRAY_CONTENT_VALUES = new Set\([\s\S]*'liveTokenRate'/);
  assert.doesNotMatch(main, /FLOATING_BUBBLE_CONTENT_VALUES/);
  assert.match(main, /floatingBubbleContent: normalizeTrayContent\([^\n]+, 'icon'\)/);
  assert.match(main, /const trayImageMode = \(mode === 'limitsAllSessions'[\s\S]*mode === 'liveTokenRate'/);
  assert.match(traySource, /\['liveTokenRate', 'trayMenu\.content\.liveTokenRate'\]/);
  assert.match(app, /const displayLiveTokenRateTrackers = new Map\(\)/);
  assert.match(app, /const BUBBLE_CONTENT_VALUES = \[[^\n]*'liveTokenRate'/);
  assert.match(app, /function observeDisplayLiveTokenRates\(stats\)/);
  assert.match(app, /floatingBubbleEnabled === true/);
  assert.match(app, /floatingBubbleCustomLayout/);
  assert.match(app, /trayLayoutApi\.liveTokenRateItemsForSurfaces\(\[/);
  assert.match(app, /function liveTokenRateTrayLayout\(\)/);
  assert.match(app, /if \(mode === 'liveTokenRate'\) \{[\s\S]*liveTokenRateTrayLayout\(\)/);
  assert.match(app, /if \(isSettingsSurfaceVisible\(\)\) refreshTrayComposers\(\)/);
  assert.match(app, /state\.stats = sessionStatsForDisplay\(allTimeSessions\.attach\(nextStats\)\);\s*observeDisplayLiveTokenRates\(nextStats\)/);
  assert.match(app, /state\.stats = sessionStatsForDisplay\(allTimeSessions\.attach\(payload\.data\.stats\)\);\s*observeLiveTokenRate\(state\.stats\);\s*observeDisplayLiveTokenRates\(state\.stats\)/);
  assert.match(app, /liveTokenRates: options\.liveTokenRates \|\| displayLiveTokenRateSamples\(\)/);
  assert.match(app, /renderFloatingBubbleContent\(\);\s*if \(isSettingsSurfaceVisible\(\)\) refreshTrayComposers\(\)/);
  assert.match(app, /trayContentInput\.value = \['tokens',[\s\S]*'liveTokenRate'/);
  const bubbleOptions = html.slice(html.indexOf('id="floatingBubbleContentInput"'), html.indexOf('id="floatingBubbleComposer"'));
  const trayOptions = html.slice(html.indexOf('id="trayContentInput"'), html.indexOf('id="trayComposer"'));
  assert.match(bubbleOptions, /<option value="liveTokenRate" data-i18n="settings\.tray\.liveTokenRate">/);
  assert.match(trayOptions, /<option value="liveTokenRate" data-i18n="settings\.tray\.liveTokenRate">/);
  assert.equal((i18n.match(/'trayComposer\.style\.liveTokenRate'/g) || []).length, 6);
});

test('the live footer rate uses matched timed deltas rather than scan wall time', () => {
  const source = tokenRateSource().replace(/^\s*\/\/.*$/gm, '');
  const trackerBody = source.slice(source.indexOf('function createLiveTokenRateTracker('));
  assert.match(trackerBody, /timedOutputTokens: current\.timedOutputTokens - baseline\.timedOutputTokens/);
  assert.match(trackerBody, /timedDurationMs: current\.timedDurationMs - baseline\.timedDurationMs/);
  assert.match(trackerBody, /speed: tokenRatePerSecond\(delta\)/);
  assert.match(trackerBody, /burn: tokenBurnPerMinute\(delta\)/);
  assert.doesNotMatch(trackerBody, /setInterval/);
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
  assert.match(app, /if \(isRendererWindowHidden\(\)\) cancelTokenRateBoost\(\)/);
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

function modelRatePeriod(models) {
  const counters = { timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 };
  for (const entry of Object.values(models)) {
    for (const field of Object.keys(counters)) counters[field] += entry[field];
  }
  return { ...counters, modelThroughput: models };
}

test('live model rates use matched model deltas and follow device expiry', () => {
  let now = 0;
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker({ now: () => now });
  const base = modelRatePeriod({});
  const a = modelRatePeriod({ alpha: { timedTokens: 100, timedOutputTokens: 40, timedDurationMs: 1000 }, beta: { timedTokens: 200, timedOutputTokens: 20, timedDurationMs: 2000 } });
  const b = modelRatePeriod({ alpha: { timedTokens: 50, timedOutputTokens: 30, timedDurationMs: 1000 } });
  tracker.reset([{ id: 'a', period: base }, { id: 'b', period: base }]);
  now = 100;
  tracker.observe([{ id: 'a', period: a }, { id: 'b', period: base }]);
  assert.deepEqual(tracker.getSample().devices[0].models, [{ model: 'alpha', speed: 40, burn: 6000 }, { model: 'beta', speed: 10, burn: 6000 }]);
  assert.equal(tracker.getSample().speed, 20, 'headline remains the matched overall ratio');
  now = 200;
  tracker.observe([{ id: 'a', period: a }, { id: 'b', period: b }]);
  assert.deepEqual(tracker.getSample().devices.map((device) => device.models), [[{ model: 'alpha', speed: 40, burn: 6000 }, { model: 'beta', speed: 10, burn: 6000 }], [{ model: 'alpha', speed: 30, burn: 3000 }]]);
  const beforeDuplicate = tracker.getSample();
  const duplicate = tracker.observe([{ id: 'a', period: a }, { id: 'b', period: b }]);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(duplicate.sample, beforeDuplicate);
  now = 8100;
  assert.deepEqual(tracker.getSample().devices[0].models, [{ model: 'alpha', speed: 30, burn: 3000 }]);
  now = 8200;
  assert.equal(tracker.getSample().idle, true);
  assert.deepEqual(tracker.getSample().devices[0].models, [{ model: 'alpha', speed: 30, burn: 3000 }]);
  now = 180200;
  assert.equal(tracker.getSample(), null);
});

test('legacy model attribution establishes a baseline and regressions reset it', () => {
  const tracker = tokenRateApi.createLiveTokenRateTracker({ now: () => 100 });
  tracker.reset({ timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 });
  const first = modelRatePeriod({ alpha: { timedTokens: 100, timedOutputTokens: 40, timedDurationMs: 1000 } });
  assert.deepEqual(tracker.observe(first).models, []);
  const second = modelRatePeriod({ alpha: { timedTokens: 200, timedOutputTokens: 60, timedDurationMs: 2000 } });
  assert.deepEqual(tracker.observe(second).models, [{ model: 'alpha', speed: 20, burn: 6000 }]);
  assert.equal(tracker.observe(first), null);
  assert.deepEqual(tracker.observe(second).models, [{ model: 'alpha', speed: 20, burn: 6000 }]);
});

test('live hover keeps the same model separate by device and simplifies a single device', () => {
  let now = 0;
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker({ now: () => now });
  const base = modelRatePeriod({});
  const a = modelRatePeriod({ alpha: { timedTokens: 100, timedOutputTokens: 40, timedDurationMs: 1000 } });
  const b = modelRatePeriod({ alpha: { timedTokens: 100, timedOutputTokens: 30, timedDurationMs: 1000 } });
  tracker.reset([{ id: 'a', name: 'MacBook', period: base }, { id: 'b', name: 'Desktop', period: base }]);
  now = 100;
  tracker.observe([{ id: 'a', name: 'MacBook', period: a }, { id: 'b', name: 'Desktop', period: base }]);
  const entries = (mode = 'speed') => tokenRateApi.liveTokenRateTooltipEntries(tracker.getSample(), mode, String);
  assert.deepEqual(entries(), [['alpha', '40 tok/s']]);
  now = 200;
  tracker.observe([{ id: 'a', name: 'MacBook', period: a }, { id: 'b', name: 'Desktop', period: b }]);
  assert.deepEqual(entries(), [{ full: 'MacBook', separated: false }, ['alpha', '40 tok/s'], { full: 'Desktop', separated: true }, ['alpha', '30 tok/s']]);
  assert.equal(tracker.getSample().speed, 70);
  assert.deepEqual(entries('burn').filter(Array.isArray), [['alpha', '6000 TPM'], ['alpha', '6000 TPM']]);
  now = 8100;
  assert.deepEqual(entries(), [['alpha', '30 tok/s']]);
  now = 8200;
  assert.deepEqual(entries(), [['alpha', '30 tok/s']]);
  now = 180200;
  assert.deepEqual(entries(), []);
});

test('live rate groups use configured device names with hostname fallback', () => {
  const period = modelRatePeriod({});
  const devices = [
    { deviceId: 'imac-m1', hostname: 'Javiss-iMac.local', periods: { today: period } },
    { deviceId: 'macbook-m5', hostname: 'Javiss-MacBook-Air.local', periods: { today: period } }
  ];
  const stats = { devices };
  for (const mode of ['client', 'host', 'icloud']) {
    assert.deepEqual(tokenRateApi.selectLiveTokenRatePeriods(stats, 'imac-m1', mode, 'all').entries.map(({ name }) => name), ['imac-m1', 'macbook-m5']);
    assert.equal(tokenRateApi.selectLiveTokenRatePeriods(stats, 'imac-m1', mode, 'device').entries[0].name, 'imac-m1');
  }
  assert.equal(tokenRateApi.selectLiveTokenRatePeriods(stats, 'imac-m1', 'local', 'device').entries[0].name, 'imac-m1');
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker({ now: () => 100 });
  tracker.reset(tokenRateApi.selectLiveTokenRatePeriods(stats, 'imac-m1', 'client', 'all').entries);
  const fresh = { devices: devices.map((device) => ({
    ...device,
    periods: { today: modelRatePeriod({ alpha: { timedTokens: 100, timedOutputTokens: 40, timedDurationMs: 1000 } }) }
  })) };
  tracker.observe(tokenRateApi.selectLiveTokenRatePeriods(fresh, 'imac-m1', 'client', 'all').entries);
  assert.equal(tracker.getSample().speed, 80);
  assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(tracker.getSample(), 'speed', String), [
    { full: 'imac-m1', separated: false }, ['alpha', '40 tok/s'],
    { full: 'macbook-m5', separated: true }, ['alpha', '40 tok/s']
  ]);
  const legacy = { devices: [{ hostname: 'Legacy.local', periods: { today: period } }] };
  assert.equal(tokenRateApi.selectLiveTokenRatePeriods(legacy, '', 'client', 'all').entries[0].name, 'Legacy.local');
});

test('live device names update with the existing tracker and reset with its identity', () => {
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker();
  const base = modelRatePeriod({});
  const fresh = modelRatePeriod({ alpha: { timedTokens: 100, timedOutputTokens: 40, timedDurationMs: 1000 } });
  tracker.reset([{ id: 'a', name: 'Old name', period: base }]);
  tracker.observe([{ id: 'a', name: 'Old name', period: fresh }]);
  const revision = tracker.getSample().revision;
  tracker.observe([{ id: 'a', name: 'New name', period: fresh }]);
  assert.equal(tracker.getSample().devices[0].name, 'New name');
  assert.equal(tracker.getSample().revision, revision);
  tracker.reset([{ id: 'b', name: 'Replacement', period: base }]);
  tracker.observe([{ id: 'b', name: 'Replacement', period: fresh }]);
  assert.deepEqual(tracker.getSample().devices.map(({ id, name }) => ({ id, name })), [{ id: 'b', name: 'Replacement' }]);
});

test('a merged legacy snapshot establishes the first model-aware baseline without an all-day rate', () => {
  const { mergePeriods } = require('../../src/shared/usage');
  const tracker = tokenRateApi.createLiveTokenRateTracker();
  const legacy = { timedTokens: 10000, timedOutputTokens: 4000, timedDurationMs: 100000, outputTokens: 4000 };
  tracker.reset(mergePeriods(legacy));
  const fresh = { ...modelRatePeriod({ alpha: { timedTokens: 10100, timedOutputTokens: 4020, timedDurationMs: 101000 } }), outputTokens: 4020 };
  const first = tracker.observe(mergePeriods(fresh));
  assert.equal(first.speed, 20);
  assert.deepEqual(first.models, []);
  const next = { ...modelRatePeriod({ alpha: { timedTokens: 10200, timedOutputTokens: 4060, timedDurationMs: 102000 } }), outputTokens: 4060 };
  assert.deepEqual(tracker.observe(mergePeriods(next)).models, [{ model: 'alpha', speed: 40, burn: 6000 }]);
});

test('mixed legacy devices retain the reporting device heading without inventing missing model rows', () => {
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker();
  tracker.reset([{ id: 'a', name: 'MacBook', period: modelRatePeriod({}) },
    { id: 'b', name: 'Desktop', period: { timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 } }]);
  tracker.observe([{ id: 'a', name: 'MacBook', period: modelRatePeriod({ alpha: { timedTokens: 100, timedOutputTokens: 40, timedDurationMs: 1000 } }) },
    { id: 'b', name: 'Desktop', period: { timedTokens: 100, timedOutputTokens: 30, timedDurationMs: 1000 } }]);
  const sample = tracker.getSample();
  assert.equal(sample.deviceCount, 2);
  assert.equal(sample.devices.length, 1);
  assert.equal(sample.devices[0].name, 'MacBook');
  assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(sample, 'speed', String), [{ full: 'MacBook', separated: false }, ['alpha', '40 tok/s']]);
});

test('changing a model alias cannot turn historical counters into a live model delta', () => {
  const { projectModelAliasStats } = require('../../src/electron/modelAliasPresentation');
  const tracker = tokenRateApi.createLiveTokenRateTracker();
  const raw = (tokens, output, duration) => modelRatePeriod({ alpha: { timedTokens: tokens, timedOutputTokens: output, timedDurationMs: duration } });
  tracker.reset(raw(10000, 4000, 100000));
  const aliased = (period) => projectModelAliasStats({ periods: { today: period } }, { alpha: 'GPT' }).periods.today;
  const first = tracker.observe(aliased(raw(10100, 4020, 101000)));
  assert.equal(first.speed, 20);
  assert.deepEqual(first.models, []);
  assert.deepEqual(tracker.observe(aliased(raw(10200, 4060, 102000))).models, [{ model: 'GPT', speed: 40, burn: 6000 }]);
});

function timedCoveragePeriod({ output = 100, timed = output, duration = 1000, model = 'gpt-6-astra', client = 'codex' } = {}) {
  return {
    capabilities: { tokenComponents: true, throughput: true },
    totalTokens: output * 2,
    outputTokens: output,
    timedTokens: timed * 2,
    timedOutputTokens: timed,
    timedDurationMs: duration,
    modelOutputs: { [model]: output },
    modelThroughput: duration > 0 ? { [model]: { timedTokens: timed * 2, timedOutputTokens: timed, timedDurationMs: duration } } : {},
    clientModels: { [client]: { [model]: output * 2 } }
  };
}

const coverageLabels = {
  timed: '最近计时样本', coverage: '今日有用量但暂无/部分耗时',
  untimed: '暂无耗时', partial: '部分计时', unknown: '耗时覆盖未知'
};

test('today coverage includes untimed DSH usage beside a recent timed model without fabricating a rate', () => {
  const period = timedCoveragePeriod();
  period.totalTokens += 800;
  period.outputTokens += 400;
  period.modelOutputs.Muse = 400;
  period.clientModels.dsh = { Muse: 800 };
  const coverage = tokenRateApi.liveTokenRateCoverage([{ id: 'mac', name: 'Mac', period }]);
  assert.equal(coverage.state, 'partial');
  assert.equal(coverage.outputTokens, 500);
  assert.equal(coverage.timedOutputTokens, 100);
  assert.deepEqual(coverage.devices[0].models.find((model) => model.model === 'Muse'), {
    model: 'Muse', clients: ['dsh'], state: 'partial', outputTokens: 400, timedOutputTokens: 0
  });
  const sample = { devices: [{ id: 'mac', name: 'Mac', models: [{ model: 'gpt-6-astra', speed: 2, burn: 13 }] }], deviceCount: 1 };
  assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(sample, 'speed', String, coverage, coverageLabels), [
    { full: '最近计时样本' }, ['gpt-6-astra', '2 tok/s'],
    { full: '今日有用量但暂无/部分耗时', separated: true }, ['Muse · dsh', '暂无耗时']
  ]);
  const burn = tokenRateApi.liveTokenRateTooltipEntries(sample, 'burn', String, coverage, coverageLabels);
  assert.deepEqual(burn[1], ['gpt-6-astra', '13 TPM']);
  assert.deepEqual(burn[3], ['Muse · dsh', '暂无耗时']);
});

test('coverage marks a raw model with timed and untimed output partial without assigning rates to its clients', () => {
  const period = timedCoveragePeriod({ output: 400, timed: 100, model: 'Muse' });
  period.clientModels = { codex: { Muse: 200 }, dsh: { Muse: 600 } };
  const coverage = tokenRateApi.liveTokenRateCoverage([{ id: 'mac', period }]);
  assert.deepEqual(coverage.devices[0].models, [{
    model: 'Muse', clients: ['codex', 'dsh'], state: 'partial', outputTokens: 400, timedOutputTokens: 100
  }]);
  assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(null, 'speed', String, coverage, coverageLabels), [
    { full: '今日有用量但暂无/部分耗时', separated: false }, ['Muse · codex · dsh', '部分计时']
  ]);
});

test('legacy throughput defaults are unknown coverage, never exact untimed or fully timed claims', () => {
  for (const timed of [0, 100]) {
    const period = timedCoveragePeriod({ timed });
    period.capabilities.throughput = false;
    const coverage = tokenRateApi.liveTokenRateCoverage([{ id: 'legacy', period }]);
    assert.equal(coverage.state, 'unknown');
    assert.equal(coverage.timedOutputTokens, null);
    assert.equal(coverage.devices[0].models[0].state, 'unknown');
    assert.equal(coverage.devices[0].models[0].timedOutputTokens, null);
    assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(null, 'speed', String, coverage, coverageLabels)[1],
      ['gpt-6-astra · codex', '耗时覆盖未知']);
  }
});

test('missing model attribution stays unknown while a genuine empty timing map proves no timed model output', () => {
  const period = timedCoveragePeriod({ timed: 0, duration: 0 });
  const known = tokenRateApi.liveTokenRateCoverage([{ id: 'mac', period }]);
  assert.equal(known.devices[0].models[0].state, 'partial');
  assert.equal(known.devices[0].models[0].timedOutputTokens, 0);
  delete period.modelThroughput;
  const unknown = tokenRateApi.liveTokenRateCoverage([{ id: 'mac', period }]);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.devices[0].models[0].timedOutputTokens, null);
});

test('today coverage follows the existing live-rate scope and stale-device selection exactly', () => {
  const local = timedCoveragePeriod();
  const remote = timedCoveragePeriod({ model: 'Muse', client: 'dsh', timed: 0, duration: 0 });
  const unrelated = timedCoveragePeriod({ model: 'outside-scope', output: 9999 });
  const stats = {
    periods: { today: unrelated, month: unrelated, allTime: unrelated },
    devices: [
      { deviceId: 'local', hostname: 'Mac', periods: { today: local, month: unrelated } },
      { deviceId: 'remote', hostname: 'Worker', periods: { today: remote } },
      { deviceId: 'old', stale: true, periods: { today: unrelated } }
    ]
  };
  for (const mode of ['client', 'host', 'icloud']) {
    const all = tokenRateApi.liveTokenRateCoverage(tokenRateApi.selectLiveTokenRatePeriods(stats, 'local', mode, 'all').entries);
    assert.deepEqual(all.devices.map((device) => device.id), ['device:local', 'device:remote']);
    assert.equal(all.outputTokens, 200);
    assert.equal(all.state, 'partial');
    const device = tokenRateApi.liveTokenRateCoverage(tokenRateApi.selectLiveTokenRatePeriods(stats, 'local', mode, 'device').entries);
    assert.deepEqual(device.devices.map((item) => item.id), ['device:local']);
    assert.equal(device.state, 'complete');
    assert.equal(device.outputTokens, 100);
    const missing = tokenRateApi.liveTokenRateCoverage(tokenRateApi.selectLiveTokenRatePeriods(stats, 'missing', mode, 'device').entries);
    assert.deepEqual(missing.devices, []);
    assert.equal(missing.state, 'unknown');
  }
});

test('untimed-only and duplicate pushes update coverage without refreshing the timed sample', () => {
  let now = 1000;
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker({ now: () => now });
  const entry = (period) => [{ id: 'mac', name: 'Mac', period }];
  tracker.reset(entry(timedCoveragePeriod()));
  now = 2000;
  const fresh = timedCoveragePeriod({ output: 150, timed: 150, duration: 1500 });
  const measured = tracker.observe(entry(fresh)).sample;
  assert.equal(measured.speed, 100);
  assert.equal(measured.sampledAt, 2000);
  const later = structuredClone(fresh);
  later.outputTokens += 5000;
  later.totalTokens += 10000;
  later.modelOutputs.Muse = 5000;
  later.clientModels.dsh = { Muse: 10000 };
  for (now of [3000, 4000]) {
    const result = tracker.observe(entry(later));
    assert.equal(result.changed, false);
    assert.equal(result.sample.sampledAt, measured.sampledAt);
    assert.equal(result.sample.revision, measured.revision);
    assert.equal(result.sample.speed, measured.speed);
    const coverage = tokenRateApi.liveTokenRateCoverage(entry(later));
    assert.equal(coverage.state, 'partial');
    assert.equal(coverage.outputTokens, 5150);
  }
  now = 10001;
  assert.equal(tracker.getSample().idle, true);
  const stale = tracker.observe(entry(later)).sample;
  assert.equal(stale.idle, true);
  assert.equal(stale.sampledAt, 2000);
  assert.equal(stale.revision, measured.revision);
  now = 182001;
  assert.equal(tracker.getSample(), null);
  const tooltip = tokenRateApi.liveTokenRateTooltipEntries(null, 'speed', String,
    tokenRateApi.liveTokenRateCoverage(entry(later)), coverageLabels);
  assert.deepEqual(tooltip[1], ['Muse · dsh', '暂无耗时']);
});

test('coverage groups missing timing by device even when the same model appears on both', () => {
  const period = timedCoveragePeriod({ model: 'Muse', client: 'dsh', timed: 0, duration: 0 });
  const coverage = tokenRateApi.liveTokenRateCoverage([
    { id: 'a', name: 'Mac', period }, { id: 'b', name: 'Worker', period }
  ]);
  assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(null, 'speed', String, coverage, coverageLabels), [
    { full: '今日有用量但暂无/部分耗时', separated: false },
    { full: 'Mac' }, ['Muse · dsh', '暂无耗时'], { full: 'Worker' }, ['Muse · dsh', '暂无耗时']
  ]);
});

test('coverage treats incomplete components and impossible timing as unknown instead of claiming completeness', () => {
  for (const mutate of [
    (period) => { period.capabilities.tokenComponents = false; },
    (period) => { period.timedOutputTokens = 200; period.modelThroughput['gpt-6-astra'].timedOutputTokens = 200; },
    (period) => { period.timedDurationMs = 0; period.modelThroughput['gpt-6-astra'].timedDurationMs = 0; },
    (period) => { period.outputTokens = null; period.modelOutputs['gpt-6-astra'] = null; }
  ]) {
    const period = timedCoveragePeriod();
    mutate(period);
    const coverage = tokenRateApi.liveTokenRateCoverage([{ id: 'mac', period }]);
    assert.equal(coverage.state, 'unknown');
    assert.equal(coverage.devices[0].models[0].state, 'unknown');
  }
});

test('coverage is deterministic, deduplicates selected device identities, and does not mutate input', () => {
  const period = timedCoveragePeriod();
  const entries = [{ id: 'mac', period }, { id: 'mac', period }, { id: '', period }];
  const before = structuredClone(entries);
  const first = tokenRateApi.liveTokenRateCoverage(entries);
  assert.deepEqual(tokenRateApi.liveTokenRateCoverage(entries), first);
  assert.deepEqual(entries, before);
  assert.equal(first.devices.length, 1);
  assert.equal(first.outputTokens, 100);
  assert.equal(first.state, 'complete');
  assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(null, 'speed', String, first, coverageLabels), []);
  assert.deepEqual(tokenRateApi.liveTokenRateCoverage(null), {
    state: 'unknown', outputTokens: null, timedOutputTokens: null, devices: []
  });
});

test('known usage without model attribution or output timing stays visible when no live sample exists', () => {
  const period = timedCoveragePeriod({ timed: 0, duration: 0 });
  delete period.modelOutputs;
  delete period.modelThroughput;
  delete period.clientModels;
  const coverage = tokenRateApi.liveTokenRateCoverage([{ id: 'mac', name: 'Mac', period }]);
  assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(null, 'speed', String, coverage, coverageLabels), [
    { full: '今日有用量但暂无/部分耗时', separated: false }, ['Mac', '耗时覆盖未知']
  ]);
  const inputOnly = timedCoveragePeriod({ output: 0, timed: 0, duration: 0 });
  inputOnly.totalTokens = 400;
  inputOnly.clientModels = { dsh: { Muse: 400 } };
  inputOnly.modelOutputs = {};
  const inputs = tokenRateApi.liveTokenRateCoverage([{ id: 'mac', period: inputOnly }]);
  assert.equal(inputs.state, 'unknown');
  assert.deepEqual(inputs.devices[0].models[0], {
    model: 'Muse', clients: ['dsh'], state: 'unknown', outputTokens: 0, timedOutputTokens: 0
  });
});

test('untimed stats refresh footer coverage immediately without refreshing or relighting the last measured rate', () => {
  let now = 1000;
  const tracker = tokenRateApi.createLiveTokenRateGroupTracker({ now: () => now });
  const statsFor = (period) => ({ periods: { today: period } });
  const select = (stats) => tokenRateApi.selectLiveTokenRatePeriods(stats, 'mac', 'local', 'device').entries;
  tracker.reset(select(statsFor(timedCoveragePeriod())));
  now = 2000;
  const previousStats = statsFor(timedCoveragePeriod({ output: 150, timed: 150, duration: 1500 }));
  const measured = tracker.observe(select(previousStats)).sample;
  const incoming = structuredClone(previousStats);
  incoming.periods.today.outputTokens += 400;
  incoming.periods.today.totalTokens += 800;
  incoming.periods.today.modelOutputs.Muse = 400;
  incoming.periods.today.clientModels.dsh = { Muse: 800 };
  let expirySchedules = 0, timerClears = 0, flashes = 0, tooltip = [];
  const classes = new Set();
  const element = {
    dataset: {},
    classList: {
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      remove: (name) => classes.delete(name),
      add: (name) => { classes.add(name); if (name === 'is-fresh') flashes += 1; }
    },
    querySelectorAll: () => [],
    setAttribute(name, value) { this[name] = value; }
  };
  const context = {
    tokenRateApi,
    state: { stats: previousStats, settings: { showLiveTokenRate: true, deviceId: 'mac', hubMode: 'local', tokenRateMode: 'speed' } },
    els: { liveTokenRate: element, liveTokenRateValue: {} },
    liveTokenRateTracker: tracker,
    liveTokenRateContext: 'device:mac',
    liveTokenRateRenderedRevision: measured.revision,
    liveTokenRateSourceKey: (source) => source,
    effectiveLiveTokenRateScope: () => 'device',
    clearLiveTokenRateTimers: () => { timerClears += 1; },
    scheduleLiveTokenRateExpiry: () => { expirySchedules += 1; },
    syncLiveTokenRateFooterState() {},
    formatLiveTokenRate: String,
    t: (key) => key,
    limitWindowsView: { setDetailTooltip: (_element, entries) => { tooltip = entries || []; } },
    setTimeout: () => { throw new Error('coverage must not restart the freshness animation'); }
  };
  const observer = app.slice(app.indexOf('function observeLiveTokenRate('), app.indexOf('function formatLiveTokenRate('));
  const renderer = app.slice(app.indexOf('function renderLiveTokenRate('), app.indexOf('function syncLiveTokenRateFooterState('));
  vm.runInNewContext(`${observer}\n${renderer}`, context);
  for (now of [3000, 4000, 10001]) {
    context.observeLiveTokenRate(incoming);
    assert.equal(element.dataset.coverage, 'partial');
    assert.ok(tooltip.some((entry) => !Array.isArray(entry) && entry.full === 'home.liveTokenRate.coverageCompact'));
    assert.ok(element['aria-label'].includes('home.liveTokenRate.coverageCompact'));
    assert.equal(element['aria-label'].includes('Muse · dsh'), false);
    assert.equal(context.els.liveTokenRateValue.textContent, '100 tok/s');
    assert.equal(tracker.getSample().sampledAt, measured.sampledAt);
    assert.equal(tracker.getSample().revision, measured.revision);
    assert.equal(context.state.stats, previousStats, 'render must use its supplied snapshot without mutating global stats');
  }
  assert.equal(classes.has('is-idle'), true);
  assert.equal(flashes, 0);
  assert.equal(expirySchedules, 0);
  assert.equal(timerClears, 0);
  context.renderLiveTokenRate();
  assert.equal(element.dataset.coverage, 'complete', 'ordinary renders still default to state.stats');
  context.liveTokenRateContext = 'previous-scope';
  context.observeLiveTokenRate(incoming);
  assert.equal(timerClears, 1);
  assert.equal(tracker.getSample(), null);
  assert.equal(element.dataset.coverage, 'partial', 'a new source also renders its incoming snapshot');
  assert.equal(context.els.liveTokenRateValue.textContent, '— tok/s');
  assert.deepEqual(tooltip, [{ full: 'home.liveTokenRate.noRateData' }]);
});


function compactRateFixture(untimedCount = 12) {
  const models = ['measured-a', 'measured-b', 'measured-c', 'measured-d']
    .map((model, index) => ({ model, speed: 10 + index * 10, burn: 6000 - index * 1200 }));
  const period = {
    capabilities: { tokenComponents: true, throughput: true },
    totalTokens: 280 + untimedCount * 10,
    outputTokens: 100 + untimedCount * 2,
    timedTokens: 280, timedOutputTokens: 100, timedDurationMs: 4000,
    modelOutputs: Object.fromEntries(models.map((entry) => [entry.model, entry.speed])),
    modelThroughput: Object.fromEntries(models.map((entry) => [entry.model, {
      timedTokens: entry.burn / 60, timedOutputTokens: entry.speed, timedDurationMs: 1000
    }])),
    clientModels: { codex: Object.fromEntries(models.map((entry) => [entry.model, entry.burn / 60])), dsh: {} }
  };
  for (let i = 0; i < untimedCount; i += 1) {
    period.modelOutputs['untimed-' + i] = 2;
    period.clientModels.dsh['untimed-' + i] = 10;
  }
  return {
    sample: { sampledAt: 1000, revision: 3, idle: false, deviceCount: 1, devices: [{ id: 'mac', name: 'Mac', models }] },
    coverage: tokenRateApi.liveTokenRateCoverage([{ id: 'mac', name: 'Mac', period }])
  };
}

const compactRateLabels = { partialSummary: '部分模型暂无速率', unavailable: '暂无速率数据' };

test('compact rate tooltip shows only three measured models and one short coverage note', () => {
  const fixture = compactRateFixture();
  const before = structuredClone(fixture);
  const entries = tokenRateApi.liveTokenRateTooltipEntries(
    fixture.sample, 'speed', String, fixture.coverage, compactRateLabels, { compact: true, maxModels: 3 }
  );
  assert.deepEqual(entries, [
    ['measured-d', '40 tok/s'], ['measured-c', '30 tok/s'], ['measured-b', '20 tok/s'],
    { full: '部分模型暂无速率' }
  ]);
  assert.equal(fixture.coverage.devices[0].models.length, 16, 'all measured and untimed models remain in the coverage DTO');
  assert.equal(fixture.coverage.state, 'partial');
  assert.deepEqual(fixture, before, 'a compact presentation must not mutate measurement, freshness or coverage');
  assert.equal(JSON.stringify(entries).includes('untimed-'), false);
});

test('compact rate rows retain device identity without merging the same model across devices', () => {
  const { sample, coverage } = compactRateFixture(0);
  sample.deviceCount = 2;
  sample.devices.push({
    id: 'worker', name: 'Worker',
    models: [{ model: 'measured-d', speed: 45, burn: 2700 }, { model: 'remote', speed: 55, burn: 3300 }]
  });
  assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(
    sample, 'speed', String, coverage, compactRateLabels, { compact: true }
  ), [
    ['remote · Worker', '55 tok/s'], ['measured-d · Worker', '45 tok/s'], ['measured-d · Mac', '40 tok/s']
  ]);
  const singleAttributedDevice = { ...sample, devices: [sample.devices[0]] };
  const entries = tokenRateApi.liveTokenRateTooltipEntries(
    singleAttributedDevice, 'speed', String, coverage, compactRateLabels, { compact: true }
  );
  assert.equal(entries[0][0], 'measured-d · Mac', 'a legacy unattributed device does not erase the reporting device name');
});

test('compact rate tooltip without a sample shows one absence message regardless of untimed model count', () => {
  const { coverage } = compactRateFixture();
  for (const sample of [null, undefined, { deviceCount: 1, devices: [] }]) {
    const entries = tokenRateApi.liveTokenRateTooltipEntries(
      sample, 'speed', () => { throw new Error('no numeric rate may be manufactured'); },
      coverage, compactRateLabels, { compact: true }
    );
    assert.deepEqual(entries, [{ full: '暂无速率数据' }]);
  }
});

test('compact burn mode sorts its measured numerator and does not confuse truncation with missing timing', () => {
  const { sample, coverage } = compactRateFixture(0);
  assert.equal(coverage.state, 'complete');
  assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(
    sample, 'burn', String, coverage, compactRateLabels, { compact: true }
  ), [
    ['measured-a', '6000 TPM'], ['measured-b', '4800 TPM'], ['measured-c', '3600 TPM']
  ]);
});

test('compact presentation enforces a three-row ceiling while honoring a smaller requested count', () => {
  const { sample, coverage } = compactRateFixture(0);
  for (const [maxModels, expected] of [[18, 3], [3, 3], [2, 2], [1, 1], [0, 3], [undefined, 3]]) {
    const entries = tokenRateApi.liveTokenRateTooltipEntries(
      sample, 'speed', String, coverage, compactRateLabels, { compact: true, maxModels }
    );
    assert.equal(entries.length, expected);
    assert.ok(entries.every(Array.isArray));
  }
});

test('compact presentation omits unusable rates while preserving a measured numeric zero', () => {
  const sample = { devices: [{ id: 'mac', models: [
    { model: 'missing' }, { model: 'infinite', speed: Infinity }, { model: 'invalid', speed: NaN },
    { model: 'negative', speed: -1 }, { model: 'null', speed: null }, { model: 'measured-zero', speed: 0 }
  ] }] };
  assert.deepEqual(tokenRateApi.liveTokenRateTooltipEntries(
    sample, 'speed', String, undefined, compactRateLabels, { compact: true }
  ), [['measured-zero', '0 tok/s']]);
});
