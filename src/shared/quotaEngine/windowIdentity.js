'use strict';

// Display-only reset timestamps drift by seconds to minutes inside one cycle
// (server rounding, refresh alignment). Session/weekly cycles are hours/days;
// this bound must stay far below those durations so a successor window never
// collapses into the previous one.
const RESET_CYCLE_JITTER_MS = 2 * 60 * 1000;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeText(value, max = 240) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseTimeMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function cycleTimeMs(value) {
  const ms = Date.parse(safeText(value, 40));
  return Number.isFinite(ms) ? ms : null;
}

function resetTimesClose(left, right) {
  const previousReset = parseTimeMs(left);
  const nextReset = parseTimeMs(right);
  if (previousReset === null || nextReset === null) return true;
  return Math.abs(previousReset - nextReset) <= RESET_CYCLE_JITTER_MS;
}

// Display resetsAt is not cycle identity. A successor cycle is only a later
// reset seen after the previous boundary, and unused 0% sliding / first rise
// stay in-cycle.
function isSuccessorQuotaCycle(previous, next) {
  if (resetTimesClose(previous.resetsAt, next.resetsAt)) return false;
  if (previous.usedPercent === 0) return false;
  const previousReset = parseTimeMs(previous.resetsAt);
  const nextReset = parseTimeMs(next.resetsAt);
  const observedAt = parseTimeMs(next.observedAt);
  if (previousReset === null || nextReset === null || observedAt === null) return false;
  const crossed = observedAt >= previousReset - RESET_CYCLE_JITTER_MS;
  const successor = nextReset > previousReset + RESET_CYCLE_JITTER_MS;
  return crossed && successor;
}

// Accounting samples can carry a binding suffix on the archived segment
// (`segment-xxx|binding-y`). Only the head describes the quota cycle.
function cycleSegmentId(value) {
  const segment = safeText(value?.segmentId, 240);
  if (!segment) return '';
  const cut = segment.indexOf('|');
  return cut > 0 ? segment.slice(0, cut) : segment;
}

// Window compatibility: same account, same window kind/limit, compatible
// window length. This deliberately ignores `windowIdentity`, which describes
// window type and length only and is never a quota-cycle identity.
function sameWindow(left, right) {
  if (!left || !right) return false;
  if (safeText(left.provider) !== safeText(right.provider)) return false;
  if (safeText(left.profileId) !== safeText(right.profileId)) return false;
  if (safeText(left.kind) !== safeText(right.kind)) return false;
  const leftLimit = safeText(left.limitId);
  const rightLimit = safeText(right.limitId);
  if (leftLimit && rightLimit && leftLimit !== rightLimit) return false;
  const leftMinutes = finiteNumber(left.windowMinutes);
  const rightMinutes = finiteNumber(right.windowMinutes);
  return leftMinutes === null || rightMinutes === null || leftMinutes === rightMinutes;
}

// Current-cycle compatibility: window-compatible *and* provably the same
// quota cycle as the live observation. Reset times within RESET_CYCLE_JITTER_MS
// stay in-cycle; anything beyond that boundary is a different cycle. This is
// the symmetric half of `isSuccessorQuotaCycle()`, which only ever needs to
// recognise a strictly later reset.
function sameQuotaCycle(live, candidate) {
  if (!sameWindow(live, candidate)) return false;
  const liveReset = cycleTimeMs(live?.resetsAt);
  const candidateReset = cycleTimeMs(candidate?.resetsAt);
  if (liveReset !== null && candidateReset !== null) {
    return Math.abs(liveReset - candidateReset) <= RESET_CYCLE_JITTER_MS;
  }
  const liveSegment = cycleSegmentId(live);
  const candidateSegment = cycleSegmentId(candidate);
  if (liveSegment && candidateSegment) return liveSegment === candidateSegment;
  // Without any cycle boundary on either side there is nothing to prove, so
  // fail closed instead of assuming one cycle.
  return false;
}

module.exports = {
  RESET_CYCLE_JITTER_MS,
  cycleSegmentId,
  isSuccessorQuotaCycle,
  resetTimesClose,
  sameQuotaCycle,
  sameWindow
};
