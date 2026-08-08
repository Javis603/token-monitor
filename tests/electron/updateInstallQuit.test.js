'use strict';

// An install request stands the app's forced exit down, and quitAndInstall()
// never reports back whether the installer took over. If nothing gives the quit
// flags back, the user is left in an app that only a restart can close.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createUpdateInstallQuitGuard } = require('../../src/electron/updateInstallQuit');
const { updateInstallQuitPolicy } = require('../../src/shared/appUpdater');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

// Records the flag movements as an ordered log and hands the grace period back as
// something the test fires by hand, so every transition is observable.
function harness({ graceMs = 10_000, expiryIsConclusive = true } = {}) {
  const events = [];
  const timers = [];
  const stalledWith = [];
  const guard = createUpdateInstallQuitGuard({
    graceMs,
    expiryIsConclusive,
    claim: () => events.push('claim'),
    release: () => events.push('release'),
    onStalled: (conclusive) => { events.push('stalled'); stalledWith.push(conclusive); },
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
  return { guard, events, timers, stalledWith, fire: (index = timers.length - 1) => timers[index].fn() };
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

test('a second request while one is unconfirmed changes nothing', () => {
  const { guard, events, timers } = harness();
  guard.request();
  // MacUpdater adds a nativeUpdater listener per quitAndInstall() and never
  // removes it, so stacking attempts is not merely redundant work.
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
  assert.equal(guard.phase(), 'idle');
});

test('the hand-off cancels the grace period', () => {
  const { guard, events, timers } = harness();
  guard.request();
  guard.noteHandoff();
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

test('a hand-off arriving after the claim expired takes the flags back', () => {
  const { guard, events, fire } = harness();
  guard.request();
  // macOS: quitAndInstall() can return having only asked Squirrel to check, and
  // the real hand-off follows whenever that round-trip completes.
  fire();
  assert.equal(guard.phase(), 'idle');
  guard.noteHandoff();
  assert.deepEqual(events, ['claim', 'release', 'stalled', 'claim']);
  assert.equal(guard.phase(), 'handoff');
});

test('abort reports whether a claim was outstanding', () => {
  const { guard, events, timers } = harness();
  // An updater error with no install pending belongs to a check, not an install.
  assert.equal(guard.abort(), false);
  assert.deepEqual(events, []);

  guard.request();
  assert.equal(guard.abort(), true);
  assert.equal(guard.phase(), 'idle');
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(events, ['claim', 'release']);
});

test('abort releases from the hand-off too', () => {
  const { guard, events } = harness();
  guard.request();
  guard.noteHandoff();
  // Reaching a terminal error after the hand-off means the installer reported
  // failure instead of restarting us, so the app has to be quittable again.
  assert.equal(guard.abort(), true);
  assert.equal(guard.phase(), 'idle');
  assert.deepEqual(events, ['claim', 'claim', 'release']);
});

test('a request is possible again once the previous one ended', () => {
  const { guard, timers } = harness();
  guard.request();
  guard.abort();
  assert.equal(guard.request(), true);
  assert.equal(timers.length, 2);
});

test('expiry carries a verdict only where a working install could not reach it', () => {
  const { stalledWith, fire, guard } = harness({ expiryIsConclusive: false });
  guard.request();
  fire();
  assert.deepEqual(stalledWith, [false]);

  const conclusive = harness({ expiryIsConclusive: true });
  conclusive.guard.request();
  conclusive.fire();
  assert.deepEqual(conclusive.stalledWith, [true]);
});

test('the same-tick install paths get a short, conclusive bound', () => {
  // NsisUpdater and AppImageUpdater run install() synchronously and emit the
  // hand-off from a setImmediate, so a working install is gone within a tick.
  for (const platform of ['win32', 'linux']) {
    const policy = updateInstallQuitPolicy(platform);
    assert.equal(policy.expiryIsConclusive, true, platform);
    assert.ok(policy.graceMs >= 5_000, `${platform} must not race a next-tick quit`);
    assert.ok(policy.graceMs <= 60_000, `${platform} must not leave an unquittable app sitting`);
  }
});

test('macOS gets a bound that clears a real Squirrel transfer', () => {
  // With autoInstallOnAppQuit off, MacUpdater has Squirrel pull the whole app zip
  // through electron-updater's local proxy only once quitAndInstall() is called,
  // and hands off after the entire transfer. Tens of seconds is normal, so a bound
  // anywhere near the same-tick one would expire on working installs and hand the
  // quit flags back mid-install.
  const policy = updateInstallQuitPolicy('darwin');
  assert.equal(policy.expiryIsConclusive, false);
  assert.ok(policy.graceMs >= 2 * 60 * 1000, 'a normal transfer must never reach the bound');
  const sameTick = updateInstallQuitPolicy('win32');
  assert.ok(policy.graceMs > sameTick.graceMs * 10);
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
  // The bound and its verdict come from the shared policy, never inlined here:
  // a number written at the call site is one nobody can weigh against what the
  // install path actually does.
  assert.match(block, /\.\.\.updateInstallQuitPolicy\(\)/);
  // quitRequested predates the forced exit and on its own is already enough to
  // make requestAppQuit return early forever, so it cannot be left behind.
  for (const [role, value] of [['claim', 'true'], ['release', 'false']]) {
    const line = block.split('\n').find((candidate) => candidate.trimStart().startsWith(`${role}:`));
    assert.ok(line, `${role} has to be wired`);
    assert.match(line, new RegExp(`quitRequested = ${value}`));
    assert.match(line, new RegExp(`skipForcedQuit = ${value}`));
  }
});

test('the hand-off is observed on Electron own updater, not electron-updater', () => {
  const line = main.split('\n').find((candidate) => candidate.includes("'before-quit-for-update'"));
  assert.ok(line, 'the hand-off has to be observed');
  // BaseUpdater re-emits it on require('electron').autoUpdater to mimic what
  // Squirrel does natively. Listening on electron-updater's own emitter would
  // never fire, and the failure mode is silent.
  assert.match(line, /require\('electron'\)/);
  assert.match(line, /noteHandoff/);
});

test('the install request goes through the guard before quitAndInstall', () => {
  const install = functionSource('function installDownloadedAppUpdate()');
  const requestAt = install.indexOf('updateInstallQuit.request()');
  const callAt = install.indexOf('autoUpdater.quitAndInstall(');
  assert.ok(requestAt >= 0, 'the claim has to be taken through the guard');
  assert.ok(callAt >= 0, 'the install has to be requested');
  assert.ok(requestAt < callAt, 'the claim has to precede the hand-off');
  assert.match(install, /if \(!updateInstallQuit\.request\(\)\) return/);
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
  assert.ok(abortAt >= 0, 'an updater error has to release an outstanding claim');
  assert.ok(guardAt >= 0, 'the download guard has to still be there');
  // update-downloaded has already cleared appUpdateNativeBusy by the time an
  // install can fail, so a rollback behind that guard would never run.
  assert.ok(abortAt < guardAt, 'the abort has to come before the early return');
  assert.match(body, /const wasInstalling = updateInstallQuit\.abort\(\);/);
});
