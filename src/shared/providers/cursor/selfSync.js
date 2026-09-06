'use strict';

// Cursor's tokscale cache is self-synced the same way antigravity's is, but the
// spawn itself already belongs to providers/cursor/auth — it needs the signed
// session, not a bare binary. What is left here is the part the collector used
// to own: deciding whether this tick may sync at all, and recording the outcome
// against the shared allowance.

const { abortReason, throwIfAborted } = require('../../abortSignal');
const { classifyClientSyncDetailCode } = require('../../clientHealth');
const { normalizeClientsCsv } = require('../../clientTracking');
const cursorAuth = require('./auth');

// See createAntigravitySelfSync for why the throttle is injected rather than
// created here: cursor and antigravity ration one process-wide allowance.
function createCursorSelfSync({ selfSyncThrottle }) {
  async function maybeSyncCursor(clientsCsv, logger, options = {}) {
    throwIfAborted(options.signal);
    const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
    if (!enabled.has('cursor')) return;
    if (!selfSyncThrottle.claim('cursor', options.minIntervalMs)) return;
    const attempt = selfSyncThrottle.beginAttempt('cursor');
    const cancelAttempt = () => selfSyncThrottle.cancelAttempt('cursor', attempt);
    options.signal?.addEventListener('abort', cancelAttempt, { once: true });
    if (options.signal?.aborted) cancelAttempt();
    try {
      await cursorAuth.runCursorSync({
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        terminationOptions: options.terminationOptions,
        onTerminationUnconfirmed: options.onTerminationUnconfirmed
      });
      selfSyncThrottle.completeAttempt('cursor', attempt, false);
    } catch (err) {
      if (options.signal?.aborted) {
        cancelAttempt();
        throw abortReason(options.signal);
      }
      if (typeof logger === 'function') logger(`cursor sync failed: ${err.message}`);
      selfSyncThrottle.completeAttempt('cursor', attempt, true, '', {
        failureStage: err?.syncFailureStage,
        detailCode: err?.syncDetailCode || classifyClientSyncDetailCode({ client: 'cursor', text: err?.message }),
        exitCode: err?.syncExitCode
      });
      options.onFailure?.('cursor');
    } finally {
      options.signal?.removeEventListener('abort', cancelAttempt);
    }
  }

  return { maybeSyncCursor };
}

module.exports = { createCursorSelfSync };
