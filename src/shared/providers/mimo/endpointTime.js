'use strict';

// MiMo's payloads carry wall-clock timestamps with no zone (`2026-10-01T00:00:00`).
// Reading one through `Date` would make the answer depend on the machine's
// locale, which is a different value on every device and is not what the server
// said. The zone is therefore pinned: a value that states one keeps it, and one
// that does not is read as UTC.
//
// Both MiMo lanes answer to this, the console lane's `currentPeriodEnd` and the
// membership lane's `nextResetTime`, so it is one function rather than two
// copies of the same expression.
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
