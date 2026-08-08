'use strict';

// The lifecycle of one "install this update now" request.
//
// autoUpdater.quitAndInstall() returns void, and neither install path reports
// back that it started: NsisUpdater and AppImageUpdater reset their own state and
// emit nothing when install() returns false, and MacUpdater can return having
// only asked Squirrel to check. Meanwhile the caller has already stood the app's
// forced exit down, because otherwise the exit would pre-empt the installer. If
// the hand-off never happens, that leaves an app nothing can quit.
//
// So a request is a claim on the quit flags that nothing has confirmed yet:
//
//   idle       no claim outstanding
//   requested  quitAndInstall() called, nothing heard since
//   handoff    before-quit-for-update arrived; the installer owns the exit
//
// Only `requested` expires. Promotion to `handoff` cancels the grace period,
// because handing the flags back once the installer is swapping the app out is
// the one thing they exist to prevent. `handoff` has no timer of its own: macOS
// reaches the real quit whenever a native check completes, with no upper bound.
function createUpdateInstallQuitGuard({
  graceMs,
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

  // Refused while a claim is outstanding, and not only to avoid redundant work:
  // MacUpdater adds a nativeUpdater 'update-downloaded' listener per
  // quitAndInstall() and never removes it, so a second request leaves two
  // listeners that each re-enter the install once Squirrel answers.
  function request() {
    if (phase !== 'idle') return false;
    phase = 'requested';
    claim();
    clearTimer();
    timer = setTimeoutFn(() => {
      timer = null;
      // The hand-off cancels this timer, so reaching it in any other phase means
      // the claim it was armed for is already gone.
      if (phase !== 'requested') return;
      phase = 'idle';
      release();
      onStalled();
    }, graceMs);
    // The fallback must never be the reason the process stays up.
    timer?.unref?.();
    return true;
  }

  // Re-claims instead of assuming the claim survived: on macOS the hand-off can
  // arrive long after the grace period already gave the flags back.
  function noteHandoff() {
    phase = 'handoff';
    clearTimer();
    claim();
  }

  // A terminal failure, from a synchronous throw or an updater error. Releases
  // from `handoff` too: reaching here after the hand-off means the installer
  // reported failure rather than restarting us, so the app has to be quittable
  // again. Reports whether a claim was outstanding, which is what tells an
  // updater error that belongs to an install from one that belongs to a check.
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
