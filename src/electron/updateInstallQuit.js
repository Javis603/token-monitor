'use strict';

// The lifecycle of one "install this update now" request.
//
// autoUpdater.quitAndInstall() returns void, and neither install path reports
// back that it started: NsisUpdater and AppImageUpdater reset their own state and
// emit nothing when install() returns false, and MacUpdater can return having
// only asked Squirrel to begin. Meanwhile the caller has already stood the app's
// forced exit down, because otherwise the exit would pre-empt the installer. If
// the hand-off never happens, that leaves an app nothing can quit.
//
// Two different things are outstanding from that moment, and they do not end
// together. The claim on the quit flags is ours, and a timer can give it back.
// The updater's own request is not ours to end at all.
//
//   idle       nothing outstanding
//   requested  quitAndInstall() called, nothing heard since
//   handoff    before-quit-for-update arrived; the installer owns the exit
//   spent      the attempt ended without a hand-off, on a platform that cannot
//              safely make another; the quit flags are back, requests are not
//
// `spent` exists because on macOS the *call* is what cannot be repeated, whatever
// its outcome: MacUpdater attaches an anonymous nativeUpdater 'update-downloaded'
// listener before starting Squirrel and nothing ever detaches it, so a second
// quitAndInstall() leaves two listeners that each re-enter the install when
// Squirrel finally answers. That is why a timeout and an error land in the same
// place. Where the request leaves nothing behind, both land in `idle` instead and
// the user may try again. See updateInstallQuitPolicy for which is which.
function createUpdateInstallQuitGuard({
  graceMs,
  singleUseAttempt = false,
  watchdogEnabled = () => true,
  claim,
  release,
  onStalled = () => {},
  onHandoff = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  let phase = 'idle';
  let timer = null;

  function clearTimer() {
    if (timer === null) return;
    clearTimeoutFn(timer);
    timer = null;
  }

  // Where the attempt ends when it did not hand off.
  const endedPhase = () => (singleUseAttempt ? 'spent' : 'idle');

  function request() {
    if (phase !== 'idle') return false;
    phase = 'requested';
    claim();
    clearTimer();
    // Armed only when the hand-off can actually be observed. Without that listener
    // an expiry would hand the flags back with nothing able to take them again, and
    // a late hand-off would then race a forced exit.
    //
    // The install still goes ahead, because supervision is not what makes it work:
    // this only gives up the recovery, leaving that case exactly where it stands
    // today. Refusing outright would instead turn a rare failure a force quit gets
    // the user out of into an app that can never update itself. And it would buy
    // nothing: electron-updater emits the hand-off on that same emitter unguarded,
    // so an emitter we cannot observe is one its own install fails on regardless.
    // updateInstallQuitUpstream.test.js pins that; if it goes red, weigh this again.
    if (!watchdogEnabled()) return true;
    timer = setTimeoutFn(() => {
      timer = null;
      // The hand-off cancels this timer, so reaching it in any other phase means
      // the claim it was armed for is already gone.
      if (phase !== 'requested') return;
      phase = endedPhase();
      release();
      onStalled();
    }, graceMs);
    // The fallback must never be the reason the process stays up.
    timer?.unref?.();
    return true;
  }

  // Re-claims rather than assuming the claim survived, because the hand-off can
  // arrive after the grace period already gave the flags back. Refused from
  // `idle`, where no install of ours is running: honouring a stray event there
  // would stand the forced exit down for the rest of the session with nothing
  // ever coming to release it.
  function noteHandoff() {
    if (phase !== 'requested' && phase !== 'spent') return false;
    // Arriving from `spent` means the grace period ran out of patience and was
    // wrong: the install was slow, not stalled. Whoever reported that needs to
    // know, or the app tells the user to restart while it restarts them.
    const afterStalledReport = phase === 'spent';
    phase = 'handoff';
    clearTimer();
    claim();
    onHandoff(afterStalledReport);
    return true;
  }

  // A terminal failure, from a synchronous throw or an updater error. Reports
  // whether it ended something that was still outstanding, which is what tells an
  // updater error belonging to an install from one belonging to a check, and keeps
  // an already-reported stall from being reported twice.
  function abort() {
    if (phase !== 'requested' && phase !== 'handoff') return false;
    phase = endedPhase();
    clearTimer();
    release();
    return true;
  }

  return {
    request,
    noteHandoff,
    abort,
    phase: () => phase,
    // An install this process is still trying to complete, which is what makes the
    // Install control busy. Deliberately not `spent`: that one is over rather than
    // busy, and the controls it leaves working -- the release page above all --
    // would be disabled along with it.
    isInstalling: () => phase === 'requested' || phase === 'handoff',
    // An attempt that ended without a hand-off on a platform that cannot make
    // another. Nothing this process does can produce an install now, so the whole
    // in-app update path has to stand down, not just the Install control.
    isSpent: () => phase === 'spent',
    // Anything the guard has not finished with, which is what decides whether some
    // other updater operation may start. Wider than `isInstalling` on purpose:
    // `spent` still answers true, because it is not terminal -- a late hand-off
    // promotes it back and re-claims the flags, and an operation begun in that
    // window would be in flight during a real hand-off with its failures
    // indistinguishable from the install's.
    isOutstanding: () => phase !== 'idle'
  };
}

// Registration has to be verified rather than merely attempted. Optional chaining
// over a missing emitter no-ops in silence, and a watchdog armed on that lie would
// release the quit flags with nothing able to reclaim them on a late hand-off.
// Returns whether a listener is genuinely attached.
function observeUpdateInstallHandoff(emitter, onHandoff) {
  if (!emitter || typeof emitter.on !== 'function') return false;
  try {
    emitter.on('before-quit-for-update', onHandoff);
  } catch (_) {
    return false;
  }
  return true;
}

module.exports = { createUpdateInstallQuitGuard, observeUpdateInstallHandoff };
