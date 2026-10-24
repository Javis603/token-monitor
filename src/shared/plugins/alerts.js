'use strict';

// Background alert rules: a threshold on one numeric reading, held for a
// minimum duration, with a cooldown between notifications. The evaluator is
// pure; the manager owns timers, sampling cadence and the notification call.

function compare(op, value, threshold) {
  if (op === '>') return value > threshold;
  if (op === '>=') return value >= threshold;
  if (op === '<') return value < threshold;
  if (op === '<=') return value <= threshold;
  return false;
}

// state: { phase: 'idle' | 'pending' | 'firing', since, lastFiredAt }.
// Returns the next state and whether this evaluation should notify. A rule
// that stays true notifies once; it re-arms only after the reading recovers,
// and never sooner than its cooldown after the previous notification.
function evaluateAlert(rule, value, nowMs, state = {}) {
  const current = { phase: state.phase || 'idle', since: state.since || 0, lastFiredAt: state.lastFiredAt || 0 };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // A missing reading proves nothing: a pending hold restarts, an active
    // alert stays active until a real reading recovers.
    return { state: current.phase === 'pending' ? { ...current, phase: 'idle', since: 0 } : current, fire: false };
  }
  if (!compare(rule.op, value, rule.value)) {
    return { state: { ...current, phase: 'idle', since: 0 }, fire: false };
  }
  if (current.phase === 'firing') return { state: current, fire: false };
  const since = current.phase === 'pending' ? current.since : nowMs;
  if (nowMs - since < (rule.forMs || 0)) {
    return { state: { ...current, phase: 'pending', since }, fire: false };
  }
  const coolingDown = current.lastFiredAt && nowMs - current.lastFiredAt < (rule.cooldownMs || 0);
  return {
    state: { phase: 'firing', since, lastFiredAt: coolingDown ? current.lastFiredAt : nowMs },
    fire: !coolingDown
  };
}

function alertMessage(template, formattedValue) {
  return String(template || '').replace(/\{value\}/g, formattedValue);
}

module.exports = { alertMessage, compare, evaluateAlert };
