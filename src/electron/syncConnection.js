'use strict';

// Classify why the sync stream is offline into a stable machine code. The main
// process knows the raw HTTP status / network errno; the renderer maps the code
// to a localized string. Pure and dependency-free so it is trivially testable.
const ERRNO_REASONS = {
  ECONNREFUSED: 'refused',
  ETIMEDOUT: 'timeout',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable'
};

function classifyStreamFailure({ status = null, errorCode = null, message = null, eof = false } = {}) {
  if (eof) return { reason: 'disconnected', detail: null };
  if (errorCode) {
    if (ERRNO_REASONS[errorCode]) return { reason: ERRNO_REASONS[errorCode], detail: null };
    return { reason: 'network', detail: errorCode };
  }
  if (status != null) {
    if (status === 401 || status === 403) return { reason: 'unauthorized', detail: null };
    return { reason: 'server_error', detail: String(status) };
  }
  return { reason: 'network', detail: message || null };
}

module.exports = { classifyStreamFailure };
