'use strict';

const os = require('node:os');

const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;

// Give foreground work priority during short scans, then let a longer scan
// compete at its starting priority again under sustained CPU load.
const RESTORE_PRIORITY_AFTER_MS = 10_000;

// On Windows, lower scanner priority to reduce CPU competition with foreground
// work (#1007).
//
// Windows schedules priority classes almost strictly: while normal-priority
// work keeps every core busy, a below-normal scan only advances through the
// scheduler's anti-starvation boosts and can run past the command timeout. A
// scan still running after RESTORE_PRIORITY_AFTER_MS therefore returns to the
// priority it started with. Leave POSIX unchanged: an unprivileged process
// generally cannot restore a lowered nice value, so sustained contention can
// delay the scan or sync beyond its timeout.
//
// A child inherits the app's priority. When someone already runs the app at
// below normal or lower, the scan starts there too and is left alone: neither
// the lowering nor the restore may raise it above what they chose.
//
// Node cannot spawn at a lower priority, so the child is lowered right after
// spawn. Best effort: a child that already exited, or a platform that refuses
// the change, keeps its current priority rather than failing the scan.
function lowerSubprocessPriority(child, {
  platform = process.platform,
  getPriority = os.getPriority,
  setPriority = os.setPriority,
  restoreAfterMs = RESTORE_PRIORITY_AFTER_MS
} = {}) {
  if (platform !== 'win32') return false;
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let initial;
  try {
    // Larger values are lower priorities, as with POSIX nice levels.
    initial = getPriority(pid);
    if (initial >= BELOW_NORMAL) return false;
    setPriority(pid, BELOW_NORMAL);
  } catch (_) {
    return false;
  }
  const restore = setTimeout(() => {
    try { setPriority(pid, initial); } catch (_) {}
  }, restoreAfterMs);
  restore.unref?.();
  child.once?.('exit', () => clearTimeout(restore));
  return true;
}

module.exports = { RESTORE_PRIORITY_AFTER_MS, lowerSubprocessPriority };
