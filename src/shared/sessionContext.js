'use strict';

/**
 * Context-window occupancy for a session that is still open.
 *
 * Tokscale reports what a session *spent* (input/output/cache tokens, cost,
 * message count) but nothing about what its context window currently holds —
 * no `ModelUsage`, `ModelPerformance` or `SessionMeta` field carries a window
 * size. That pair (`contextTokens`, `contextWindow`) is the only thing a live
 * session view needs that the scan cannot answer, so it is read from the
 * client's own transcript by the provider adapters under `providers/<id>/`.
 *
 * Only two decisions live here, because both must stay identical across
 * providers: when a session is recent enough for the read to be worth doing,
 * and what a valid pair looks like.
 */

// A transcript read is only worth doing for a session that could still be
// resumed: occupancy is a *current* fact, and reading it for every historical
// session would add a transcript read per session per tick on top of the
// timestamp pass that already stats them all. Recent files are also the ones
// whose content actually changed, so the per-provider size/mtime caches turn
// the steady state back into one stat per session either way.
const CONTEXT_READ_WINDOW_MS = 30 * 60 * 1000;

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldReadSessionContext(lastUsedAt, now = Date.now()) {
  const last = timestampMs(lastUsedAt);
  if (!last) return false;
  // A clock skew that puts the transcript in the future still means "just
  // written", so only the past side is bounded.
  return last >= now - CONTEXT_READ_WINDOW_MS;
}

function positiveInteger(value) {
  // Reject non-scalars before coercion: the Codex reader hands parsed
  // transcript fields straight through, and `Number(true)` is 1 while
  // `Number([200])` is 200, so a malformed record would otherwise read as a
  // real measurement. Rounding stays as it was, since the DSH parser shares
  // this policy and tightening it to safe integers would change that.
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  if (typeof value === 'string' && value.trim() === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

// Both halves are required: a window with no occupancy cannot be drawn, and an
// occupancy with no window is a bare token count the session row already shows.
// Occupancy above the window is kept as reported rather than clamped — it means
// the transcript and the configured window disagree, and silently pinning it to
// 100% would hide that.
function normalizeSessionContext(input) {
  const contextTokens = positiveInteger(input?.contextTokens);
  const contextWindow = positiveInteger(input?.contextWindow);
  return contextTokens > 0 && contextWindow > 0 ? { contextTokens, contextWindow } : null;
}

module.exports = {
  CONTEXT_READ_WINDOW_MS,
  normalizeSessionContext,
  shouldReadSessionContext
};
