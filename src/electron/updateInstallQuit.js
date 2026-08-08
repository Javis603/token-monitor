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
// together. The claim on the quit flags is ours and can be given back on a timer.
// The updater's own request is not ours: on macOS Squirrel may still be working
// long after we stop waiting, and electron-updater offers no way to cancel it or
// to detach the listener it added. So the states are:
//
//   idle       nothing outstanding
//   requested  quitAndInstall() called, nothing heard since
//   handoff    before-quit-for-update arrived; the installer owns the exit
//   waiting    the grace period expired; the quit flags are back, but the
//              updater's request may still be live, so no new one is allowed
//
// `waiting` is terminal for the process unless the updater reports an error,
// which is the one signal that its request really ended. Anything else would let
// a second quitAndInstall() stack another MacUpdater listener on top of the first,
// and both would re-enter the install when Squirrel finally answers. On Windows
// and Linux a retry after expiry would in fact be safe, since BaseUpdater resets
// itself when install() returns false, but the stalled report already blocks the
// button there, so the distinction buys nothing and costs a branch.
function createUpdateInstallQuitGuard({
  graceMs,
  watchdogEnabled = () => true,
  claim,
  release,
  onStalled = () => {},
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

  // Refused unless nothing is outstanding, and not only to avoid redundant work:
  // MacUpdater adds a nativeUpdater 'update-downloaded' listener per
  // quitAndInstall() and never removes it.
  function request() {
    if (phase !== 'idle') return false;
    phase = 'requested';
    claim();
    clearTimer();
    // Armed only when the hand-off can actually be observed. Without that
    // listener an expiry would hand the flags back with nothing able to take them
    // again, and a late hand-off would then race a forced exit. Holding the claim
    // for the session is the lesser failure, and is what shipped before this.
    if (!watchdogEnabled()) return true;
    timer = setTimeoutFn(() => {
      timer = null;
      // The hand-off cancels this timer, so reaching it in any other phase means
      // the claim it was armed for is already gone.
      if (phase !== 'requested') return;
      phase = 'waiting';
      release();
      onStalled();
    }, graceMs);
    // The fallback must never be the reason the process stays up.
    timer?.unref?.();
    return true;
  }

  // Re-claims instead of assuming the claim survived: the hand-off can arrive
  // after the grace period already gave the flags back.
  function noteHandoff() {
    phase = 'handoff';
    clearTimer();
    claim();
  }

  // A terminal failure, from a synchronous throw or an updater error. This is the
  // only thing that ends `waiting`, because it is the only evidence that the
  // updater's own request is over rather than merely slow. Releasing from
  // `handoff` too: an error after the hand-off means the installer reported
  // failure rather than restarting us, so the app has to be quittable again.
  // Reports whether anything was outstanding, which is what tells an updater error
  // that belongs to an install from one that belongs to a check.
  function abort() {
    if (phase === 'idle') return false;
    phase = 'idle';
    clearTimer();
    release();
    return true;
  }

  return {
    request,
    noteHandoff,
    abort,
    phase: () => phase,
    isOutstanding: () => phase !== 'idle'
  };
}

module.exports = { createUpdateInstallQuitGuard };
