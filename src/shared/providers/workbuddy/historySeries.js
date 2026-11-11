'use strict';

// Reconstruct a 14-day absolute Credits balance curve from two provider facts:
// exact remaining balances on days the collector ran (anchors), and the
// per-request ledger's daily credit spend. A day on which Token Monitor was
// closed still has a real spend figure behind it, so the gap is filled rather
// than left blank. Values are absolute Credits, never a percentage of a limit
// that moves whenever a package is granted or expires.

const { localDayKey, startOfLocalDay, dayKeyToAt, round2 } = require('./balanceAnchors');

const MAX_SERIES_DAYS = 14;

/**
 * @param anchors - `{ 'YYYY-MM-DD': { at, remaining } }` from balanceAnchors.
 * @param dailySpend - `{ 'YYYY-MM-DD': credit }` from usageRecords.
 * @param currentRemaining - the live balance from this collection.
 * @param now - observation time in epoch milliseconds.
 * @param days - window length (bounded at 14).
 * @returns `{ points, unattributed, inferredDays }`, or `null` when unusable.
 */
function buildOfficialSeries({ anchors = {}, dailySpend = {}, currentRemaining, now, days = MAX_SERIES_DAYS } = {}) {
  if (currentRemaining === null || currentRemaining === undefined || currentRemaining === ''
    || now === null || now === undefined || now === '') return null;
  const remaining = Number(currentRemaining);
  const nowMs = Number(now);
  const count = Number.isFinite(Number(days)) ? Math.max(1, Math.min(MAX_SERIES_DAYS, Math.trunc(Number(days)))) : MAX_SERIES_DAYS;
  if (!Number.isFinite(remaining) || remaining < 0
    || !Number.isFinite(new Date(nowMs).getTime())) return null;

  // Calendar arithmetic, not fixed 24-hour steps: a daylight-saving day is 23
  // or 25 hours long, so subtracting `i * DAY_MS` from local midnight lands at
  // 23:00 of the previous day after a spring-forward and drops that day's key.
  const today = startOfLocalDay(nowMs);
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    keys.push(localDayKey(date.getTime()));
  }

  // Exact points: captured anchors inside the window plus today's live answer.
  const exact = {};
  for (const key of keys) {
    const value = Number(anchors?.[key]?.remaining);
    if (Number.isFinite(value) && value >= 0) exact[key] = round2(value);
  }
  exact[keys.at(-1)] = round2(remaining);

  const spend = key => {
    const value = Number(dailySpend?.[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const sumBetween = (from, to) => keys.reduce((total, key) => (key > from && key <= to ? total + spend(key) : total), 0);

  // Exact points keep their provider-reported value. Days before the first
  // exact anchor can only be extrapolated backwards from it.
  const balances = {};
  const exactKeys = keys.filter(key => Object.hasOwn(exact, key));
  for (const key of exactKeys) balances[key] = exact[key];
  const firstExact = exactKeys[0];
  for (const key of keys) {
    if (key >= firstExact) break;
    balances[key] = round2(exact[firstExact] + sumBetween(key, firstExact));
  }

  // Between two exact anchors the balance should fall by exactly the recorded
  // spend. Any difference is a grant, an expiry or a reset that happened while
  // the collector was away. Spread it linearly across the inferred days so the
  // curve still joins both exact endpoints, flag those days as uncertain, and
  // report the amount instead of pretending the interpolation is exact.
  let unattributed = 0;
  const uncertain = new Set();
  for (let i = 1; i < exactKeys.length; i += 1) {
    const from = exactKeys[i - 1], to = exactKeys[i];
    const between = keys.filter(key => key > from && key < to);
    const delta = round2(exact[from] - exact[to] - sumBetween(from, to));
    if (Math.abs(delta) > 0.01) {
      unattributed += Math.abs(delta);
      for (const key of between) uncertain.add(key);
    }
    const span = between.length + 1;
    between.forEach((key, index) => {
      const adjustment = delta * (index + 1) / span;
      balances[key] = round2(exact[from] - sumBetween(from, key) - adjustment);
    });
  }

  const points = keys.map(key => ({
    day: key,
    at: dayKeyToAt(key),
    balance: Math.max(0, balances[key]),
    kind: Object.hasOwn(exact, key) ? 'exact' : 'inferred',
    uncertain: uncertain.has(key)
  }));
  return {
    points,
    unattributed: round2(unattributed),
    inferredDays: points.filter(point => point.kind === 'inferred').length
  };
}

module.exports = { buildOfficialSeries, MAX_SERIES_DAYS };
