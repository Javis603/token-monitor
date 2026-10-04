'use strict';

// MiMo's payloads can carry wall-clock timestamps with no zone. The existing
// console provider normalized those as UTC; keep that compatibility rule for
// both lanes so synced devices agree. The membership timezone remains unverified
// until an active live response supplies one.
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
