'use strict';

const { localDayKey } = require('../../shared/history');

// Historical colour attribution comes from full History, never apportioned
// from today's mix. A source/revision change fences in-flight reads as well
// as the cached answer, including a backend switch with the same revision.
function createNotchHistory({ load, changed, onError = () => {} }) {
  let key = '', value = null, epoch = 0;
  function read(stats, { enabled = true, generation = 0, now = new Date() } = {}) {
    if (!enabled) { key = ''; value = null; epoch++; return null; }
    const next = JSON.stringify([generation, localDayKey(now), stats?.deviceHistoryRevision || stats?.historyRevision || '',
      (stats?.devices || []).map((device) => device.deviceId).sort()]);
    if (next !== key) {
      key = next;
      value = null;
      const request = ++epoch;
      Promise.resolve().then(load).then((history) => {
        if (request !== epoch) return;
        value = { daily: (history?.daily || []).slice(-7), complete: history?.fixedPeriods?.historyTransportAvailable === true };
        changed();
      }).catch((error) => {
        if (request !== epoch) return;
        key = '';
        onError(error);
      });
    }
    return value;
  }
  return { read };
}

module.exports = { createNotchHistory };
