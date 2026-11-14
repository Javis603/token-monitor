'use strict';

// Why a limits attempt failed, for the diagnostic report only. The published
// status deliberately collapses outages, Cloudflare challenges, timeouts and
// network errors into `unavailable`; a report needs them apart. Every field is
// an enum, an HTTP status or a platform error code — never a URL, a message or
// an account value — so the result can go into a redacted report as is.

const FAILURE_KINDS = Object.freeze([
  'http', 'challenge', 'timeout', 'network', 'response', 'error', 'not-returned', 'stale-windows'
]);
const STAGE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SOURCE_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,47}$/;
// Node/undici transport failures. File-system codes (ENOENT, EACCES, …) stay
// plain `error`: a missing credential file is not a network problem.
const NETWORK_CODE_PATTERN = /^(?:ECONN[A-Z]+|ENOTFOUND|EAI_[A-Z]+|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|EPROTO|UND_ERR_[A-Z_]+|ERR_TLS_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/;
const TIMEOUT_CODES = new Set(['PROBE_TIMEOUT', 'REQUEST_TIMEOUT']);
const CHALLENGE_CODES = new Set(['CLAUDE_WEB_SOURCE_CHALLENGE']);
const MAX_CAUSE_DEPTH = 3;

function validStage(value) {
  return typeof value === 'string' && STAGE_PATTERN.test(value) ? value : '';
}

function validCode(value) {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value) ? value : '';
}

function validHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

// Chromium (net.fetch / net.request) reports `net::ERR_*` in the message; Node
// and undici put the code on the error itself.
function networkCode(error) {
  const chromium = String(error?.message || '').match(/net::(ERR_[A-Z0-9_]+)/);
  if (chromium) return chromium[1];
  const code = String(error?.code || '');
  return NETWORK_CODE_PATTERN.test(code) ? code : '';
}

function classify(error, depth) {
  const stage = validStage(error?.limitStage);
  const withStage = (detail) => (stage ? { ...detail, stage } : detail);
  if (!error || typeof error !== 'object') return withStage({ kind: 'error' });
  const code = validCode(error.code);
  if (TIMEOUT_CODES.has(code) || error.status === 'timeout') return withStage({ kind: 'timeout' });
  const httpStatus = validHttpStatus(error.httpStatus);
  if (CHALLENGE_CODES.has(code)) return withStage({ kind: 'challenge', ...(httpStatus ? { httpStatus } : {}) });
  if (httpStatus) return withStage({ kind: 'http', httpStatus });
  const network = networkCode(error);
  if (network) return withStage({ kind: 'network', code: network });
  if (error.name === 'SyntaxError') return withStage({ kind: 'response' });
  // A wrapper (undici's `fetch failed`, an identity lookup that failed) carries
  // the transport fact on its cause; the outer stage still names the step.
  if (error.cause && depth < MAX_CAUSE_DEPTH) {
    const inner = classify(error.cause, depth + 1);
    if (inner.kind !== 'error' || inner.code) {
      return { ...inner, ...(stage || inner.stage ? { stage: stage || inner.stage } : {}) };
    }
  }
  return withStage({ kind: 'error', ...(code ? { code } : {}) });
}

/**
 * @param {unknown} error
 * @param {{ source?: string, stage?: string }} [meta]
 * @returns {{ kind: string, source?: string, stage?: string, httpStatus?: number, code?: string }}
 */
function limitFailureDetail(error, meta = {}) {
  const detail = classify(error, 0);
  const stage = detail.stage || validStage(meta.stage);
  const source = typeof meta.source === 'string' && SOURCE_PATTERN.test(meta.source) ? meta.source : '';
  const { stage: _ignored, ...rest } = detail;
  return { ...(source ? { source } : {}), ...(stage ? { stage } : {}), ...rest };
}

// Names the step a provider call belongs to, for limitFailureDetail. Used as a
// rejection handler: `fetchJson(...).catch(limitStage('oauth-usage'))`. The
// innermost step wins, so a wrapper never relabels the request that failed.
function limitStage(stage) {
  return (error) => {
    if (error && typeof error === 'object' && !error.limitStage) {
      try { error.limitStage = stage; } catch (_) { /* frozen errors keep no stage */ }
    }
    throw error;
  };
}

module.exports = {
  FAILURE_KINDS,
  limitFailureDetail,
  limitStage
};
