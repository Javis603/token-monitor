'use strict';

const { localDayKey, dayKeyAddDays } = require('../../shared/history');
const { NOTCH_WEEK_DAYS } = require('./panel');

// Historical colour attribution comes from full History, never apportioned
// from today's mix. A backend generation or a new local day fences in-flight
// reads and drops the cached answer. A History revision or device change keeps
// showing the previous answer until the new read lands, so the chart does not
// flash back to unknown on every collection; remote reloads are throttled.
function createNotchHistory({ load, changed, onError = () => {}, minIntervalMs = () => 0,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let hardKey = '', softKey = '', value = null, epoch = 0, loadedAt = -Infinity, timer = null;

  function cancelTimer() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function start(stats, date) {
    cancelTimer();
    // The week is this device's local days. A remote source can already hold a
    // later day, so the rows are picked by date rather than by position.
    const last = localDayKey(date);
    const first = dayKeyAddDays(last, 1 - NOTCH_WEEK_DAYS);
    loadedAt = now();
    const request = ++epoch;
    Promise.resolve().then(() => load(stats)).then((history) => {
      if (request !== epoch) return;
      // Absent days count as zero only when every source answered for its History.
      value = { daily: (history?.daily || []).filter((day) => {
        const key = String(day?.date || '').slice(0, 10);
        return key >= first && key <= last;
      }),
        complete: history?.fixedPeriods?.historyTransportAvailable === true && history?.devicesComplete !== false };
      changed();
    }).catch((error) => {
      if (request !== epoch) return;
      softKey = '';
      onError(error);
    });
  }

  function read(stats, { enabled = true, generation = 0, now: date = new Date() } = {}) {
    if (!enabled) { hardKey = softKey = ''; value = null; epoch++; cancelTimer(); return null; }
    const hard = JSON.stringify([generation, localDayKey(date)]);
    const soft = JSON.stringify([stats?.deviceHistoryRevision || stats?.historyRevision || '',
      (stats?.devices || []).map((device) => device.deviceId).sort()]);
    if (hard !== hardKey) {
      hardKey = hard; softKey = soft; value = null;
      start(stats, date);
    } else if (soft !== softKey) {
      const wait = loadedAt + Math.max(0, Number(minIntervalMs()) || 0) - now();
      if (wait <= 0) { softKey = soft; start(stats, date); }
      else if (!timer) timer = setTimer(() => { timer = null; changed(); }, wait);
    }
    return value;
  }
  return { read };
}

module.exports = { createNotchHistory };
