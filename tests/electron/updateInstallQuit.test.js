'use strict';

// An install request stands the app's forced exit down, and quitAndInstall()
// never reports back whether the installer took over. If nothing gives the quit
// flags back, the user is left in an app that only a restart can close.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createUpdateInstallQuitGuard,
  observeUpdateInstallHandoff
} = require('../../src/electron/updateInstallQuit');
const { updateInstallQuitPolicy } = require('../../src/shared/appUpdater');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

// Records the flag movements as an ordered log and hands the grace period back as
// something the test fires by hand, so every transition is observable. Defaults to
// the macOS shape, where a spent attempt can never be repeated.
function harness({ graceMs = 10_000, watchdogEnabled = true, singleUseAttempt = true } = {}) {
  const events = [];
  const timers = [];
  const guard = createUpdateInstallQuitGuard({
    graceMs,
    singleUseAttempt,
    watchdogEnabled: () => watchdogEnabled,
    claim: () => events.push('claim'),
    release: () => events.push('release'),
    onStalled: () => events.push('stalled'),
    setTimeoutFn: (fn, ms) => {
      const handle = {
        fn,
        ms,
        cleared: false,
        unrefCount: 0,
        unref() { this.unrefCount += 1; }
      };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => { if (handle) handle.cleared = true; }
  });
  return { guard, events, timers, fire: (index = timers.length - 1) => timers[index].fn() };
}

test('a request claims the flags and arms exactly one grace period', () => {
  const { guard, events, timers } = harness();
  assert.equal(guard.request(), true);
  assert.deepEqual(events, ['claim']);
  assert.equal(guard.phase(), 'requested');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10_000);
  // The fallback must never be the reason the process stays up.
  assert.equal(timers[0].unrefCount, 1);
});

test('a second request while one is outstanding changes nothing', () => {
  const { guard, events, timers } = harness();
  guard.request();
  assert.equal(guard.request(), false);
  assert.deepEqual(events, ['claim']);
  assert.equal(timers.length, 1);
  assert.equal(guard.phase(), 'requested');
});

test('an expired claim gives the flags back before it reports', () => {
  const { guard, events, fire } = harness();
  guard.request();
  fire();
  // Release first: the app has to be quittable whether or not anyone is watching
  // the error that follows.
  assert.deepEqual(events, ['claim', 'release', 'stalled']);
});

test('the hand-off cancels the grace period', () => {
  const { guard, events, timers } = harness();
  guard.request();
  assert.equal(guard.noteHandoff(), true);
  assert.equal(timers[0].cleared, true);
  assert.equal(guard.phase(), 'handoff');
  assert.deepEqual(events, ['claim', 'claim']);
});

test('an expiry that fires after the hand-off releases nothing', () => {
  const { guard, events, timers, fire } = harness();
  guard.request();
  guard.noteHandoff();
  events.length = 0;
  // The timer is cancelled, so this is the belt: releasing here would let the
  // forced exit pre-empt an installer already swapping the app out.
  fire(0);
  assert.deepEqual(events, []);
  assert.equal(guard.phase(), 'handoff');
  assert.equal(timers.length, 1);
});

test('a stray hand-off with nothing outstanding is ignored', () => {
  const { guard, events } = harness();
  // Honouring it would stand the forced exit down for the session with no install
  // running and nothing ever coming to release it.
  assert.equal(guard.noteHandoff(), false);
  assert.equal(guard.phase(), 'idle');
  assert.deepEqual(events, []);
});

test('the watchdog is not armed when the hand-off cannot be observed', () => {
  const { guard, events, timers } = harness({ watchdogEnabled: false });
  // Expiring with nothing able to re-claim would let a late hand-off race the
  // forced exit. Holding the claim is the lesser failure.
  assert.equal(guard.request(), true);
  assert.equal(timers.length, 0);
  assert.equal(guard.phase(), 'requested');
  assert.deepEqual(events, ['claim']);
});

// A single-use attempt is the macOS shape: MacUpdater attaches an anonymous
// nativeUpdater 'update-downloaded' listener before starting Squirrel and nothing
// ever detaches it, so the call cannot be repeated however it ends.

test('a spent attempt keeps the flags released and refuses another install', () => {
  const { guard, events, timers, fire } = harness();
  guard.request();
  fire();
  assert.equal(guard.phase(), 'spent');
  assert.equal(guard.request(), false);
  assert.deepEqual(events, ['claim', 'release', 'stalled']);
  assert.equal(timers.length, 1);
});

test('an error spends the attempt too, so a retry cannot stack a listener', () => {
  const { guard, events, timers } = harness();
  guard.request();
  // The error path used to return straight to idle, which reopened exactly the
  // hole the expiry path had just been fixed for.
  assert.equal(guard.abort(), true);
  assert.equal(guard.phase(), 'spent');
  assert.equal(guard.request(), false);
  assert.deepEqual(events, ['claim', 'release']);
  assert.equal(timers.length, 1);
});

test('a hand-off still lands on a spent attempt', () => {
  const { guard, events, fire } = harness();
  guard.request();
  fire();
  // Squirrel finishing after we stopped waiting still has to win: the installer is
  // about to swap the app out.
  assert.equal(guard.noteHandoff(), true);
  assert.equal(guard.phase(), 'handoff');
  assert.deepEqual(events, ['claim', 'release', 'stalled', 'claim']);
});

test('a second error on a spent attempt is not reported again', () => {
  const { guard, events, fire } = harness();
  guard.request();
  fire();
  events.length = 0;
  // The stall was already reported; a late error must not surface a second time.
  assert.equal(guard.abort(), false);
  assert.equal(guard.phase(), 'spent');
  assert.deepEqual(events, []);
});

// Where the request leaves nothing behind, a failed attempt may be retried:
// BaseUpdater resets quitAndInstallCalled whenever install() returns false.

test('a repeatable attempt returns to idle on expiry and allows a retry', () => {
  const { guard, events, timers, fire } = harness({ singleUseAttempt: false });
  guard.request();
  fire();
  assert.equal(guard.phase(), 'idle');
  assert.deepEqual(events, ['claim', 'release', 'stalled']);
  assert.equal(guard.request(), true);
  assert.equal(timers.length, 2);
});

test('a repeatable attempt returns to idle on an error and allows a retry', () => {
  const { guard, timers } = harness({ singleUseAttempt: false });
  guard.request();
  assert.equal(guard.abort(), true);
  assert.equal(guard.phase(), 'idle');
  assert.equal(guard.request(), true);
  assert.equal(timers.length, 2);
});

test('abort reports whether anything was outstanding', () => {
  const { guard, events, timers } = harness();
  // An updater error with no install pending belongs to a check, not an install.
  assert.equal(guard.abort(), false);
  assert.deepEqual(events, []);

  guard.request();
  assert.equal(guard.abort(), true);
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(events, ['claim', 'release']);
});

test('abort releases from the hand-off too', () => {
  const { guard, events } = harness();
  guard.request();
  guard.noteHandoff();
  // An error after the hand-off means the installer reported failure instead of
  // restarting us, so the app has to be quittable again.
  assert.equal(guard.abort(), true);
  assert.deepEqual(events, ['claim', 'claim', 'release']);
});

test('the same-tick install paths get a short bound and stay retryable', () => {
  // NsisUpdater and AppImageUpdater run install() synchronously and emit the
  // hand-off from a setImmediate, so a working install is gone within a tick, and
  // a failed one leaves electron-updater reset.
  for (const platform of ['win32', 'linux']) {
    const policy = updateInstallQuitPolicy(platform);
    assert.equal(policy.singleUseAttempt, false, platform);
    assert.ok(policy.graceMs >= 5_000, `${platform} must not race a next-tick quit`);
    assert.ok(policy.graceMs <= 60_000, `${platform} must not leave an unquittable app sitting`);
  }
});

test('macOS gets a long bound and a single-use attempt', () => {
  // With autoInstallOnAppQuit off, quitAndInstall() is where Squirrel starts from
  // scratch: pull the zip back through the local proxy, validate the signature,
  // stage the swap. Seconds to tens of seconds is normal, so a bound anywhere near
  // the same-tick one would expire on working installs. And the call attaches a
  // listener nothing can detach, so it may not be repeated.
  const policy = updateInstallQuitPolicy('darwin');
  assert.equal(policy.singleUseAttempt, true);
  assert.ok(policy.graceMs >= 2 * 60 * 1000, 'a normal install must never reach the bound');
  assert.ok(policy.graceMs > updateInstallQuitPolicy('win32').graceMs * 10);
});

// The observer has to report a listener that is genuinely attached. Optional
// chaining over a missing emitter no-ops in silence, and a watchdog armed on that
// would release the quit flags with nothing able to reclaim them.

test('the observer refuses anything that is not an event emitter', () => {
  const onHandoff = () => {};
  assert.equal(observeUpdateInstallHandoff(undefined, onHandoff), false);
  assert.equal(observeUpdateInstallHandoff(null, onHandoff), false);
  assert.equal(observeUpdateInstallHandoff({}, onHandoff), false);
  assert.equal(observeUpdateInstallHandoff({ on: 'not a function' }, onHandoff), false);
});

test('the observer reports a registration that threw as a failure', () => {
  const emitter = { on() { throw new Error('unsupported platform'); } };
  assert.equal(observeUpdateInstallHandoff(emitter, () => {}), false);
});

test('the observer attaches the hand-off event and reports success', () => {
  const attached = [];
  const emitter = { on: (event, listener) => attached.push([event, listener]) };
  const onHandoff = () => {};
  assert.equal(observeUpdateInstallHandoff(emitter, onHandoff), true);
  assert.deepEqual(attached, [['before-quit-for-update', onHandoff]]);
});

// main.js cannot be required outside Electron, so its wiring is pinned at the
// source level. Each assertion below is an invariant the guard cannot enforce on
// its own, not a restatement of the code's shape.

function functionSource(signature) {
  const start = main.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = main.indexOf('\nfunction ', start + signature.length);
  return main.slice(start, end === -1 ? main.length : end);
}

test('the guard moves both quit flags together, in the same direction', () => {
  const start = main.indexOf('createUpdateInstallQuitGuard({');
  assert.ok(start >= 0, 'the guard has to be constructed');
  const block = main.slice(start, main.indexOf('\n});', start));
  // The bound and the single-use rule come from the shared policy, never inlined
  // here: a value written at the call site is one nobody can weigh against what
  // the install path actually does.
  assert.match(block, /\.\.\.updateInstallQuitPolicy\(\)/);
  // And the watchdog stays gated on the hand-off actually being observable.
  assert.match(block, /watchdogEnabled: \(\) => updateHandoffObserved/);
  // quitRequested predates the forced exit and on its own is already enough to
  // make requestAppQuit return early forever, so it cannot be left behind.
  for (const [role, value] of [['claim', 'true'], ['release', 'false']]) {
    const line = block.split('\n').find((candidate) => candidate.trimStart().startsWith(`${role}:`));
    assert.ok(line, `${role} has to be wired`);
    assert.match(line, new RegExp(`quitRequested = ${value}`));
    assert.match(line, new RegExp(`skipForcedQuit = ${value}`));
  }
});

test('the observed flag is whatever the verified registration returned', () => {
  const line = main.split('\n').find((candidate) => candidate.includes('observeUpdateInstallHandoff('));
  assert.ok(line, 'the hand-off has to be observed');
  // Assignment, not a bare call followed by an optimistic true.
  assert.match(line, /updateHandoffObserved = observeUpdateInstallHandoff\(/);
  const call = main.slice(main.indexOf(line), main.indexOf('} catch', main.indexOf(line)));
  // BaseUpdater re-emits the hand-off on require('electron').autoUpdater to mimic
  // what Squirrel does natively. Listening on electron-updater's own emitter would
  // never fire, and the failure mode is silent.
  assert.match(call, /require\('electron'\)\.autoUpdater/);
  assert.match(call, /noteHandoff/);
  assert.doesNotMatch(call, /updateHandoffObserved = true/);
});

test('the install request goes through the guard before quitAndInstall', () => {
  const install = functionSource('function installDownloadedAppUpdate()');
  const requestAt = install.indexOf('updateInstallQuit.request()');
  const callAt = install.indexOf('autoUpdater.quitAndInstall(');
  assert.ok(requestAt >= 0, 'the claim has to be taken through the guard');
  assert.ok(callAt >= 0, 'the install has to be requested');
  assert.ok(requestAt < callAt, 'the claim has to precede the hand-off');
  // A refusal must not be a button that quietly does nothing.
  assert.match(install, /phase\(\) === 'spent'/);
  // A synchronous throw leaves the app running, so it has to give the flags back.
  assert.match(
    install,
    /try \{[\s\S]*?autoUpdater\.quitAndInstall\([\s\S]*?\} catch \(error\) \{[\s\S]*?updateInstallQuit\.abort\(\);/
  );
});

test('an updater error aborts ahead of the download guard', () => {
  const handler = main.slice(main.indexOf("autoUpdater.on('error'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  const abortAt = body.indexOf('updateInstallQuit.abort()');
  const guardAt = body.indexOf('if (!appUpdateNativeBusy');
  assert.ok(abortAt >= 0, 'an updater error has to end an outstanding attempt');
  assert.ok(guardAt >= 0, 'the download guard has to still be there');
  // update-downloaded has already cleared appUpdateNativeBusy by the time an
  // install can fail, so a rollback behind that guard would never run.
  assert.ok(abortAt < guardAt, 'the abort has to come before the early return');
  assert.match(body, /const wasInstalling = updateInstallQuit\.abort\(\);/);
});
