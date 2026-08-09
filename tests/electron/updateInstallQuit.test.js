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
const { installFailureErrorKind, updateInstallQuitPolicy } = require('../../src/shared/appUpdater');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

// Records the flag movements as an ordered log and hands the grace period back as
// something the test fires by hand, so every transition is observable. Defaults to
// the macOS shape, where a spent attempt can never be repeated.
function harness({ graceMs = 10_000, watchdogEnabled = true, singleUseAttempt = true } = {}) {
  const events = [];
  const timers = [];
  const handoffs = [];
  const guard = createUpdateInstallQuitGuard({
    graceMs,
    singleUseAttempt,
    watchdogEnabled: () => watchdogEnabled,
    claim: () => events.push('claim'),
    release: () => events.push('release'),
    onStalled: () => events.push('stalled'),
    onHandoff: (afterStalledReport) => handoffs.push(afterStalledReport),
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
  return { guard, events, timers, handoffs, fire: (index = timers.length - 1) => timers[index].fn() };
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

test('a hand-off still lands on a spent attempt, and says the report was wrong', () => {
  const { guard, events, handoffs, fire } = harness();
  guard.request();
  fire();
  // Squirrel finishing after we stopped waiting still has to win: the installer is
  // about to swap the app out.
  assert.equal(guard.noteHandoff(), true);
  assert.equal(guard.phase(), 'handoff');
  assert.deepEqual(events, ['claim', 'release', 'stalled', 'claim']);
  // The bound was a decision to stop waiting, not proof the installer was dead, so
  // whoever reported the stall has to be told it was withdrawn.
  assert.deepEqual(handoffs, [true]);
});

test('a hand-off within the grace period withdraws nothing', () => {
  const { guard, handoffs } = harness();
  guard.request();
  guard.noteHandoff();
  assert.deepEqual(handoffs, [false]);
});

test('a refused hand-off reports nothing at all', () => {
  const { guard, handoffs } = harness();
  assert.equal(guard.noteHandoff(), false);
  assert.deepEqual(handoffs, []);
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

test('a spent attempt is reported as blocked, and nothing else is', () => {
  const { guard, fire } = harness();
  assert.equal(guard.isSpent(), false);
  guard.request();
  assert.equal(guard.isSpent(), false);
  fire();
  assert.equal(guard.isSpent(), true);

  const handed = harness();
  handed.guard.request();
  handed.guard.noteHandoff();
  assert.equal(handed.guard.isSpent(), false);

  // A platform that can retry never reaches it at all.
  const retryable = harness({ singleUseAttempt: false });
  retryable.guard.request();
  retryable.fire();
  assert.equal(retryable.guard.isSpent(), false);
});

test('only an install this process can still finish counts as busy', () => {
  const { guard } = harness();
  assert.equal(guard.isInstalling(), false);
  guard.request();
  assert.equal(guard.isInstalling(), true);
  guard.noteHandoff();
  assert.equal(guard.isInstalling(), true);

  const stalled = harness();
  stalled.guard.request();
  stalled.fire();
  // Spent is over, not busy: treating it as busy would disable checking for
  // updates for the rest of the session.
  assert.equal(stalled.guard.phase(), 'spent');
  assert.equal(stalled.guard.isInstalling(), false);
  // But still outstanding, which is what the download boundary asks: nothing this
  // process downloads can be installed now, and starting the lifecycle again is
  // what re-enters MacUpdater against a listener that never came off.
  assert.equal(stalled.guard.isOutstanding(), true);
});

test('a spent attempt still holds the updater, because it can come back', () => {
  // The sequence this rules out, all of it reachable: an install stalls past the
  // bound and goes `spent`, a check starts because the install looks over, the slow
  // Squirrel finally answers and the late hand-off re-claims the flags, and then
  // the check fails. Its failure arrives on the same event an install failure does,
  // so it aborts a hand-off that was real and releases skipForcedQuit with the
  // installer owning the exit.
  const { guard, events, fire } = harness();
  guard.request();
  fire();
  assert.equal(guard.phase(), 'spent');
  assert.equal(guard.isInstalling(), false, 'the install is over as far as the UI goes');
  // But not as far as the updater goes, which is the distinction the gate needs.
  assert.equal(guard.isOutstanding(), true, 'a check must not start here');

  guard.noteHandoff();
  assert.equal(guard.phase(), 'handoff');
  assert.deepEqual(events.slice(-1), ['claim'], 'the late hand-off takes the flags back');

  // And this is what a check error would have done to it.
  assert.equal(guard.abort(), true);
  assert.deepEqual(events.slice(-1), ['release']);
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

test('a terminal failure advises a restart only where nothing else is left', () => {
  // Restarting is the recovery of last resort. An attempt the guard handed back is
  // one press from another install, and sending that user through a restart is the
  // long way round to the same place.
  assert.equal(installFailureErrorKind({ spent: false, stalled: true }), 'installer-did-not-start');
  assert.equal(installFailureErrorKind({ spent: true, stalled: true }), 'installer-did-not-start-spent');
  assert.equal(installFailureErrorKind({ spent: true }), 'install-spent-by-failure');
  // A reported failure that left the attempt intact has nothing to add: the panel
  // still offers the update, so the updater's own message is the whole story.
  assert.equal(installFailureErrorKind({ spent: false }), null);
  assert.equal(installFailureErrorKind(), null);
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
  const from = start + signature.length;
  const ends = [main.indexOf('\nfunction ', from), main.indexOf('\nasync function ', from)]
    .filter((at) => at >= 0);
  return main.slice(start, ends.length ? Math.min(...ends) : main.length);
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
  // A refusal must not be a button that quietly does nothing, and the reason has to
  // travel as a kind, since the renderer never shows the raw message.
  assert.match(install, /phase\(\) === 'spent'/);
  assert.match(install, /errorKind: 'attempt-spent'/);
  // A synchronous throw leaves the app running, so it has to give the flags back.
  assert.match(
    install,
    /try \{[\s\S]*?autoUpdater\.quitAndInstall\([\s\S]*?\} catch \(error\) \{[\s\S]*?updateInstallQuit\.abort\(\);/
  );
});

test('an in-flight install is reported as busy and its reason as a kind', () => {
  const derive = functionSource('function deriveAppUpdateState()');
  // Without this the Install control stays live through the whole macOS wait, and a
  // second press is a refusal nobody can see.
  assert.match(derive, /installBusy: [\s\S]*?updateInstallQuit\.isInstalling\(\)/);
  // The renderer maps the kind to a localized string; the raw message never shows.
  assert.match(derive, /installErrorKind: appUpdateNativeState\.errorKind/);
  // And the hand-off window is the state machine's own answer, not a conjunction
  // reassembled downstream.
  assert.match(derive, /installStarting: updateInstallQuit\.isInstalling\(\)/);
  // And the spent state has to reach the action policy and the automatic
  // downloader, or both go on offering an install this process cannot perform.
  assert.match(derive, /installRetryBlocked: updateInstallQuit\.isSpent\(\)/);

  const start = main.indexOf('onHandoff: (afterStalledReport) => {');
  assert.ok(start >= 0, 'a late hand-off has to be handled');
  const handler = main.slice(start, main.indexOf('\n  }', start));
  // Only the late case clears anything; a normal hand-off has no report to withdraw.
  assert.match(handler, /if \(!afterStalledReport\) return;/);
  assert.match(handler, /error: null/);

  const stalled = main.slice(main.indexOf('onStalled: () => {'));
  // Not a fixed kind: a stall on a platform that handed the attempt back leaves the
  // update one press away, and advising a restart there sends the user the long way
  // round for no reason.
  assert.match(
    stalled.slice(0, stalled.indexOf('\n  }')),
    /errorKind: installFailureErrorKind\(\{ spent: updateInstallQuit\.isSpent\(\), stalled: true \}\)/
  );
});

// electron-updater reports a failed check by emitting on the same global 'error'
// event an install failure arrives on, and nothing on the event says which it was.
// So `wasInstalling` is only sound provenance while an outstanding install is the
// one thing driving the updater. That is not a property of the error handler; it
// is these three boundaries, and it is why they are tested as one invariant.

test('an outstanding install is the only thing driving the updater', () => {
  const enclosing = (index) => {
    const head = main.slice(0, index);
    const start = Math.max(head.lastIndexOf('\nfunction '), head.lastIndexOf('\nasync function '));
    assert.ok(start >= 0, 'every updater call has to sit in a named function');
    return main.slice(start).match(/^\n(?:async )?function ([A-Za-z0-9_$]+)/)[1];
  };

  const owners = new Set();
  for (const match of main.matchAll(/autoUpdater\.(checkForUpdates|downloadUpdate|quitAndInstall)\(/g)) {
    owners.add(enclosing(match.index));
  }
  // A new entry point fails here rather than silently inheriting none of the rules
  // below, which is the only way this stays enforced as the file grows.
  assert.deepEqual(
    [...owners].sort(),
    ['checkAppUpdateProvider', 'downloadAndPrepareAppUpdate', 'installDownloadedAppUpdate']
  );

  // The check path is gated one level up, in its only caller, so that the cooldown
  // and in-flight bookkeeping are skipped along with the check itself.
  const callers = [...main.matchAll(/checkAppUpdateProvider\(\)/g)]
    .map((match) => enclosing(match.index))
    .filter((name) => name !== 'checkAppUpdateProvider');
  assert.deepEqual([...new Set(callers)], ['runAppUpdateCheck']);

  const check = functionSource('async function runAppUpdateCheck(');
  const gate = check.indexOf('if (updateInstallQuit.isOutstanding()) return deriveAppUpdateState();');
  assert.ok(gate >= 0, 'a check must not start while an install is outstanding');
  // Ahead of the in-flight join, or a check already running would be awaited and
  // its result reported as though this call had made it.
  assert.ok(gate < check.indexOf('if (appUpdateCheckPromise)'), 'the gate has to come first');

  // Downloading refuses more than the check does: `isOutstanding` covers a spent
  // attempt as well, since re-entering the lifecycle rebuilds MacUpdater's proxy
  // against a listener that is still attached. The renderer and the automatic
  // predicate both decline it too, but an IPC action queued before the attempt
  // ended arrives here regardless -- this is the boundary, they are the policy.
  const download = functionSource('async function downloadAndPrepareAppUpdate()');
  assert.match(download, /if \(updateInstallQuit\.isOutstanding\(\)\) return deriveAppUpdateState\(\);/);
  // Both use the same predicate. An earlier revision let the check through on
  // `spent`, to keep checking available for the session, and that is the hole the
  // test below describes: `spent` is not terminal, so "the install is over" and
  // "the updater is free" are not the same statement.
  assert.doesNotMatch(check, /isInstalling\(\)/);

  // And the other direction: refusing new work only holds the boundary if nothing
  // was already running when the install began. This one waits instead of
  // refusing, because it is a button press and dropping it is not an option.
  const install = functionSource('async function installDownloadedAppUpdate()');
  const join = install.indexOf('await appUpdateCheckPromise');
  assert.ok(join >= 0, 'an install has to let an in-flight check finish first');
  assert.ok(join < install.indexOf('updateInstallQuit.request()'), 'and before it claims the flags');
});

test('all three terminal failures ask the same question the same way', () => {
  // Three call sites answering "can this process try again" separately is how the
  // stall report came to advise a restart on platforms the guard had already
  // handed the attempt back to. The shared helper is what keeps them from drifting
  // apart again, so each has to be seen using it.
  const stalled = main.slice(main.indexOf('onStalled: () => {'));
  assert.match(stalled.slice(0, stalled.indexOf('\n  }')), /installFailureErrorKind\(/);

  const reported = main.slice(main.indexOf("autoUpdater.on('error'"));
  assert.match(reported.slice(0, reported.indexOf('\n  });')), /installFailureErrorKind\(/);

  // The synchronous throw is the one that was missed: the abort spends the attempt
  // exactly as the reported error does, so it owes the user the same recovery.
  const install = functionSource('function installDownloadedAppUpdate()');
  const thrown = install.slice(install.indexOf('} catch (error) {'));
  assert.match(thrown, /updateInstallQuit\.abort\(\);/);
  assert.match(thrown, /errorKind: installFailureErrorKind\(\{ spent: updateInstallQuit\.isSpent\(\) \}\)/);
});

test('an error kind never outlives the error it arrived with', () => {
  const setter = functionSource('function setNativeAppUpdateState(patch = {}) {');
  // Every other updater failure has to stay generic without each call site saying so.
  assert.match(setter, /'error' in patch && !\('errorKind' in patch\)/);
  assert.match(setter, /next\.errorKind = null;/);
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

test('a failed install that spent the attempt says a restart brings it back', () => {
  const handler = main.slice(main.indexOf("autoUpdater.on('error'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  const kind = body.slice(body.indexOf('errorKind:'));
  const expression = kind.slice(0, kind.indexOf('\n    });'));
  // Both conditions are load-bearing, and they belong to different layers. Whether
  // the attempt was spent decides the recovery, and the helper owns that; whether
  // this failure belongs to an install at all is local, and without it a later
  // check failure borrows the explanation from an attempt long since ended.
  assert.match(expression, /wasInstalling/);
  assert.match(expression, /installFailureErrorKind\(\{ spent: updateInstallQuit\.isSpent\(\) \}\)/);
});
