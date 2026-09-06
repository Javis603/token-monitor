'use strict';

// Antigravity keeps its usage in a cache tokscale reads but cannot populate, so
// the collector spawns `tokscale antigravity sync` before it scans. Everything
// that spawn has to be careful about — deciding there is anything to sync at
// all, and the lock the subprocess can leave behind — lives with the provider
// rather than in the collector that schedules it.

// Reached through the module object rather than destructured: the collector's
// tests patch child_process.spawn and then re-require only the collector, so a
// spawn bound here at load time would outlive the patch and silently keep the
// real binary.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abortReason, throwIfAborted } = require('../../abortSignal');
const { MAX_SYNC_DETAIL_INPUT_LENGTH, classifyClientSyncDetailCode } = require('../../clientHealth');
const { normalizeClientsCsv } = require('../../clientTracking');
const {
  createSubprocessTermination,
  terminationUnconfirmedError
} = require('../../subprocessTermination');
const { tokscaleConfigDir } = require('../../tokscaleConfig');

// tokscale's antigravity sync reads the IDE's native session roots under
// ~/.gemini/; when none exist there is nothing to sync, so don't spawn at all.
const ANTIGRAVITY_DATA_ROOTS = ['antigravity', 'antigravity-ide', 'antigravity-backup'];
const ANTIGRAVITY_SYNC_LOCK_MAX_BYTES = 128;

function antigravityDataRoots(home = os.homedir()) {
  return ANTIGRAVITY_DATA_ROOTS.map((name) => path.join(home, '.gemini', name));
}

function antigravityDataPresent(home) {
  return antigravityDataRoots(home).some((dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
  });
}

function antigravitySyncLockPath(home, env = process.env, platform = process.platform) {
  return path.join(
    tokscaleConfigDir({ env, platform, homeDir: home }),
    'antigravity-cache',
    'sync.lock'
  );
}

// Tokscale deliberately preserves an unknown sync.lock after a crash: an older
// binary may still own it during a rolling upgrade, so reclaiming arbitrary
// dead-PID records here would undo that safety boundary. We can make one much
// narrower claim after a child we terminated has emitted close: a regular file
// naming that exact child, created during this spawn, is our orphan. Recheck the
// inode and contents immediately before unlinking so a successor or user edit
// is preserved instead of mistaken for the record we observed.
function removeOwnedAntigravitySyncLock({
  lockPath,
  childPid,
  childStartedAt,
  fsApi = fs,
  now = Date.now
} = {}) {
  if (!lockPath || !Number.isSafeInteger(childPid) || childPid <= 0) return false;
  if (!Number.isFinite(childStartedAt)) return false;
  try {
    const firstStat = fsApi.lstatSync(lockPath);
    if (!firstStat.isFile() || firstStat.isSymbolicLink() || firstStat.size > ANTIGRAVITY_SYNC_LOCK_MAX_BYTES) {
      return false;
    }
    const record = fsApi.readFileSync(lockPath, 'utf8');
    const match = record.match(/^(\d+)\s+(\d+)\s*$/);
    if (!match || Number(match[1]) !== childPid) return false;
    const recordedAt = Number(match[2]);
    const earliest = Math.floor(childStartedAt / 1000) - 1;
    const latest = Math.floor(now() / 1000) + 1;
    if (!Number.isSafeInteger(recordedAt) || recordedAt < earliest || recordedAt > latest) return false;

    const finalStat = fsApi.lstatSync(lockPath);
    if (firstStat.dev !== finalStat.dev || firstStat.ino !== finalStat.ino) return false;
    if (fsApi.readFileSync(lockPath, 'utf8') !== record) return false;
    fsApi.unlinkSync(lockPath);
    return true;
  } catch (_) {
    return false;
  }
}

function processIdIsAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // A permission error still proves that the process exists. Every other
    // normal failure means there is no process for this user to signal.
    return error?.code === 'EPERM' || error?.code === 'EACCES';
  }
}

// This is deliberately user-mediated rather than startup cleanup. Tokscale's
// visible lock remains compatible with older binaries that do not participate
// in sync.os.lock, so absence of a new-format OS owner is not enough evidence
// to reclaim it in the background. Once the user confirms that no sync is
// running, accept only the exact legacy record shape, refuse a live pid, and
// repeat the inode/content checks immediately before removing the one path.
function repairAntigravitySyncLock({
  lockPath,
  fsApi = fs,
  pidIsAlive = processIdIsAlive
} = {}) {
  if (!lockPath) return { ok: false, code: 'unsafe-lock' };
  try {
    const firstStat = fsApi.lstatSync(lockPath);
    if (!firstStat.isFile() || firstStat.isSymbolicLink() || firstStat.size > ANTIGRAVITY_SYNC_LOCK_MAX_BYTES) {
      return { ok: false, code: 'unsafe-lock' };
    }
    const record = fsApi.readFileSync(lockPath, 'utf8');
    const match = record.match(/^(\d+)\s+(\d+)\s*$/);
    const pid = Number(match?.[1]);
    const recordedAt = Number(match?.[2]);
    if (
      !match
      || !Number.isSafeInteger(pid)
      || pid <= 0
      || !Number.isSafeInteger(recordedAt)
      || recordedAt <= 0
    ) {
      return { ok: false, code: 'unsafe-lock' };
    }
    if (pidIsAlive(pid)) return { ok: false, code: 'owner-active' };

    const finalStat = fsApi.lstatSync(lockPath);
    if (firstStat.dev !== finalStat.dev || firstStat.ino !== finalStat.ino) {
      return { ok: false, code: 'unsafe-lock' };
    }
    if (fsApi.readFileSync(lockPath, 'utf8') !== record) {
      return { ok: false, code: 'unsafe-lock' };
    }
    fsApi.unlinkSync(lockPath);
    return { ok: true, code: 'repaired' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, code: 'not-found' };
    return { ok: false, code: 'repair-failed' };
  }
}

// The throttle and the tokscale command are the collector's, not this module's:
// one process-wide allowance rations cursor and antigravity together, and
// resolving the binary is the collector's job. Both are injected once, so a
// collector rebuilt by a settings change keeps driving the allowance it
// inherited instead of quietly starting a second one.
function createAntigravitySelfSync({ selfSyncThrottle, tokscaleCommand }) {
  async function maybeSyncAntigravity(clientsCsv, logger, home = os.homedir(), options = {}) {
    throwIfAborted(options.signal);
    const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
    if (!enabled.has('antigravity')) return;
    if (!antigravityDataPresent(home)) return;
    if (!selfSyncThrottle.claim('antigravity', options.minIntervalMs)) return;
    const attempt = selfSyncThrottle.beginAttempt('antigravity');
    if (typeof options.run === 'function') {
      const cancelAttempt = () => selfSyncThrottle.cancelAttempt('antigravity', attempt);
      options.signal?.addEventListener('abort', cancelAttempt, { once: true });
      if (options.signal?.aborted) cancelAttempt();
      try {
        await options.run({ signal: options.signal });
        selfSyncThrottle.completeAttempt('antigravity', attempt, false);
      } catch (err) {
        if (options.signal?.aborted) {
          cancelAttempt();
          throw abortReason(options.signal);
        }
        if (typeof logger === 'function') logger(`antigravity sync failed: ${err.message}`);
        selfSyncThrottle.completeAttempt('antigravity', attempt, true, '', {
          failureStage: err?.syncFailureStage,
          detailCode: err?.syncDetailCode || classifyClientSyncDetailCode({ client: 'antigravity', text: err?.message }),
          exitCode: err?.syncExitCode
        });
        options.onFailure?.('antigravity');
      } finally {
        options.signal?.removeEventListener('abort', cancelAttempt);
      }
      return;
    }
    const { bin, prefixArgs, env } = tokscaleCommand();
    const syncLockPath = options.syncLockPath || antigravitySyncLockPath(home, env);
    // Every outcome resolves — a stuck sync must not hold the tick open — so a
    // failure is only visible through onFailure. The caller needs it: the tick has
    // already consumed the source event that asked for this sync, and silently
    // scanning the unchanged cache would put the refresh back on the fallback
    // interval, which is the latency this whole path exists to remove.
    await new Promise((resolve) => {
      const childStartedAt = Date.now();
      const child = childProcess.spawn(bin, [...prefixArgs, 'antigravity', 'sync'], { env, windowsHide: true });
      const termination = createSubprocessTermination(child, {
        ...(options.terminationOptions || {}),
        onUnconfirmed() {
          const error = terminationUnconfirmedError(null, 'tokscale antigravity sync');
          try { options.onTerminationUnconfirmed?.(error); } catch (_) {}
          if (terminalOutcome?.cancelled) return settle(false, '', {}, false, true);
          settle(
            true,
            terminalOutcome?.code || 'sync-failed',
            terminalOutcome?.details || { failureStage: 'process-exit' }
          );
        }
      });
      let stderr = '';
      // One outcome per spawn. A child reports more than once — a SIGTERM'd
      // timeout still emits close afterwards, and error is usually followed by
      // close — which was harmless while every path only resolved a promise, but
      // onFailure has a side effect: re-arming the catch-up. A late duplicate could
      // land after a subsequent catch-up already succeeded and put the same source
      // event back into a set that no longer has anything to collect.
      let settled = false;
      let timer = null;
      let terminalOutcome = null;
      // The failure code reaches the health record; stderr only ever reaches the
      // local log, since it is neither translatable nor reliably free of the
      // user's paths.
      const settle = (failed, code = '', details = {}, notifyFailure = true, cancelled = false) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (cancelled) selfSyncThrottle.cancelAttempt('antigravity', attempt);
        else selfSyncThrottle.completeAttempt('antigravity', attempt, failed, code, details);
        if (failed && notifyFailure) options.onFailure?.('antigravity');
        resolve();
      };
      const onAbort = () => {
        if (terminalOutcome) return;
        terminalOutcome = { cancelled: true };
        if (timer) clearTimeout(timer);
        timer = null;
        termination.request();
      };
      timer = setTimeout(() => {
        if (terminalOutcome) return;
        terminalOutcome = {
          failed: true,
          code: 'sync-timeout',
          details: { failureStage: 'timeout' }
        };
        timer = null;
        termination.request();
      }, options.timeoutMs ?? 30000);
      child.stderr.on('data', (chunk) => {
        if (terminalOutcome || stderr.length >= MAX_SYNC_DETAIL_INPUT_LENGTH) return;
        const remaining = MAX_SYNC_DETAIL_INPUT_LENGTH - stderr.length;
        stderr += chunk.toString().slice(0, remaining);
      });
      child.on('error', (err) => {
        if (terminalOutcome) return;
        settle(true, 'sync-spawn-failed', {
          failureStage: 'spawn',
          detailCode: classifyClientSyncDetailCode({ client: 'antigravity', text: err?.message })
        });
      });
      child.on('close', (code) => {
        termination.confirmClosed();
        if (terminalOutcome) {
          removeOwnedAntigravitySyncLock({
            lockPath: syncLockPath,
            childPid: child.pid,
            childStartedAt
          });
        }
        if (settled) return;
        if (terminalOutcome?.cancelled) return settle(false, '', {}, false, true);
        if (terminalOutcome) {
          return settle(
            terminalOutcome.failed,
            terminalOutcome.code,
            terminalOutcome.details
          );
        }
        if (code !== 0 && !settled && typeof logger === 'function') {
          logger(`antigravity sync exited ${code}: ${stderr.trim().slice(0, 200)}`);
        }
        settle(code !== 0, 'sync-exit-error', {
          failureStage: code !== 0 ? 'process-exit' : null,
          detailCode: code !== 0
            ? classifyClientSyncDetailCode({ client: 'antigravity', text: stderr })
            : null,
          exitCode: code
        });
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      child.stdin?.end();
    });
    throwIfAborted(options.signal);
  }

  return { maybeSyncAntigravity };
}

module.exports = {
  ANTIGRAVITY_DATA_ROOTS,
  antigravityDataPresent,
  antigravityDataRoots,
  antigravitySyncLockPath,
  createAntigravitySelfSync,
  processIdIsAlive,
  removeOwnedAntigravitySyncLock,
  repairAntigravitySyncLock
};
