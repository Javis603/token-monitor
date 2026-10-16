'use strict';

const os = require('node:os');

// Long enough to cover the multi-second CPU bursts that starved input in #1007,
// and short enough that a scan cannot approach the collector's command timeout.
const RESTORE_NORMAL_PRIORITY_AFTER_MS = 10_000;

// tokscale parses on every logical core, so a scan started at normal priority
// competes with the foreground on equal terms and can starve input on Windows
// (#1007). Below normal lets interactive work preempt it. Results are unchanged,
// and on an idle machine the scan still gets the whole CPU.
//
// Windows schedules priority classes almost strictly: while normal-priority
// work keeps every core busy, a below-normal scan only advances through the
// scheduler's anti-starvation boosts and can run past the command timeout. A
// scan still running after RESTORE_NORMAL_PRIORITY_AFTER_MS is therefore raised
// back to normal. POSIX nice levels share the CPU in proportion instead, and an
// unprivileged process may not raise one back, so there the refusal is ignored.
//
// Node cannot spawn at a lower priority, so the child is lowered right after
// spawn. Best effort: a child that already exited, or a platform that refuses
// the change, keeps its current priority rather than failing the scan.
function lowerSubprocessPriority(child, {
  setPriority = os.setPriority,
  restoreAfterMs = RESTORE_NORMAL_PRIORITY_AFTER_MS
} = {}) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (_) {
    return false;
  }
  const restore = setTimeout(() => {
    try { setPriority(pid, os.constants.priority.PRIORITY_NORMAL); } catch (_) {}
  }, restoreAfterMs);
  restore.unref?.();
  child.once?.('exit', () => clearTimeout(restore));
  return true;
}

module.exports = { RESTORE_NORMAL_PRIORITY_AFTER_MS, lowerSubprocessPriority };
