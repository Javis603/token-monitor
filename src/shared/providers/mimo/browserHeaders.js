'use strict';

const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const MIMO_CONSOLE_URL = 'https://platform.xiaomimimo.com/#/console/balance';
const MIMO_CONSOLE_HOST = 'platform.xiaomimimo.com';

// What a MiMo client sends. One definition, because both the console reads and the
// service-login walk answer to the same question, and the walk depends on it: a
// request that reaches the SSO without these does not merely fail, it takes the
// signed-in session with it, so MiMo Desktop itself asks for a login afterwards.
// The header set protects the session; a missing `User-Agent` loses one.
function mimoRequestHeaders(cookieHeader) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cookieHeader,
    Origin: 'https://platform.xiaomimimo.com',
    Referer: MIMO_CONSOLE_URL,
    'User-Agent': BROWSER_USER_AGENT
  };
}

// The console's own web UI calls its API from the console page, so those requests
// carry the page's Origin and Referer — which is what `mimoRequestHeaders` sends,
// and what the console lane still uses. The app's own calls send neither: its
// membership request is a bare `fetch(url, { method, signal })` through a session
// wrapper that adds only `X-Client-Version`. So the exchange takes these headers
// to the console host and leaves the two origin headers behind everywhere else,
// which is what the account host and the membership host see from the real client.
function mimoExchangeRequestHeaders(cookieHeader, url) {
  const headers = mimoRequestHeaders(cookieHeader);
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch (_) {
    host = '';
  }
  if (host !== MIMO_CONSOLE_HOST) {
    delete headers.Origin;
    delete headers.Referer;
  }
  return headers;
}

module.exports = { MIMO_CONSOLE_URL, mimoExchangeRequestHeaders, mimoRequestHeaders };
