'use strict';

const { syncLimits } = require('./limits');

function syncPayload(summary) {
  if (!summary || typeof summary !== 'object') return summary;
  const payload = { ...summary, limits: syncLimits(summary.limits) };
  if (summary.allTime && typeof summary.allTime === 'object') {
    payload.allTime = { ...summary.allTime };
    delete payload.allTime.sessions;
  }
  return payload;
}

module.exports = { syncPayload };
