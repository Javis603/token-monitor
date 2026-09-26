'use strict';

// MiMo's payloads carry wall-clock timestamps with no zone
// (`2026-10-01T00:00:00`). `Date` would read one in the machine's locale — a
// different value on every device, and not what the server said — so a value that
// states a zone keeps it and one that does not is read as UTC. Both lanes answer
// to this: the console lane's `currentPeriodEnd` and the membership lane's
// `nextResetTime`.
function mimoEndpointTime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return NaN;
  const normalized = raw.includes(' ') ? raw.replace(' ', 'T') : raw;
  return Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
}

function mimoEndpointIso(value) {
  const parsed = mimoEndpointTime(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

module.exports = {
  mimoEndpointIso,
  mimoEndpointTime
};
