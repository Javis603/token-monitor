'use strict';

// A StepFun Oasis session token is a pair of JWTs joined by "...": a
// short-lived access half (30 minutes, observed live) and a long-lived
// refresh half (~30 days). The browser front end swaps the access half
// through PassportService/RefreshToken when it expires; this module replays
// that same protocol so a pasted token stops failing every half hour.
// Protocol facts (reverse-engineered from the platform front end and
// confirmed against the live endpoint):
//   - POST /passport/proto.api.passport.v1.PassportService/RefreshToken,
//     connect-JSON, an empty body, authenticated by the Oasis-Token cookie;
//   - the response's accessToken.raw / refreshToken.raw are bare JWTs;
//   - the refresh half is not rotated: the same token refreshes repeatedly
//     and both refreshes answer the same refreshToken.raw. A runtime without
//     the renewal callback (the agent) therefore keeps working by refreshing
//     from the stored value every poll; persisting only saves a round trip.

const { errorWithStatus, statusForHttp } = require('../../limits/providerHelpers');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const ORIGIN = 'https://platform.stepfun.com';
const REFRESH_URL = `${ORIGIN}/passport/proto.api.passport.v1.PassportService/RefreshToken`;

// The fetcher classifies 401/403 and body-level login refusals as
// unauthorized — the same set the browser interceptor refreshes on
// (TOKEN_EXPIRED / TOKEN_ILLEGAL / 120000). Other failures say the
// credential is fine, so refreshing cannot help them.
function isStepfunAuthFailure(error) {
  return error?.status === 'unauthorized';
}

// Rebuilds the cookie's paired form from a refresh response. The server does
// not rotate the refresh half, but the protocol does not promise one back; a
// missing half falls back to the previous token's so the cookie stays whole.
function combineStepfunToken(accessTokenRaw, refreshTokenRaw, previousToken) {
  const access = String(accessTokenRaw || '').trim();
  if (!access || access.includes(';')) return '';
  const refresh = String(refreshTokenRaw || '').trim()
    || String(previousToken || '').split('...').slice(1).join('...');
  return refresh ? `${access}...${refresh}` : access;
}

// Spends the current token (expired access half included) on a fresh one.
// Returns the combined pair on success; null only on an authentication
// rejection. Transient failures keep their retryable status so an outage
// cannot reject a valid credential or suppress the runtime's retry policy.
async function refreshStepfunToken(token, webid, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  let response;
  try {
    response = await fetchFn(REFRESH_URL, {
      method: 'POST', body: '{}', redirect: 'error', credentials: 'omit',
      signal: deps.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        'User-Agent': BROWSER_USER_AGENT, 'oasis-appid': '10300', 'oasis-platform': 'web',
        'oasis-webid': webid, Cookie: `Oasis-Token=${token}; Oasis-Webid=${webid}` }
    });
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    throw errorWithStatus('unavailable', 'StepFun refresh request failed');
  }
  if (!response.ok) {
    const status = statusForHttp(response.status);
    if (status === 'unauthorized') return null;
    throw errorWithStatus(status, `StepFun refresh returned ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    // Preserve the original body-read rejection on cancellation, matching the fetch catch.
    if (deps.signal?.aborted) throw error;
    throw errorWithStatus('unavailable', 'Invalid StepFun refresh response');
  }
  const renewed = combineStepfunToken(body?.accessToken?.raw, body?.refreshToken?.raw, token);
  if (!renewed) throw errorWithStatus('unavailable', 'StepFun refresh token missing');
  return renewed;
}

module.exports = { REFRESH_URL, combineStepfunToken, isStepfunAuthFailure, refreshStepfunToken };
