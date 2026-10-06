'use strict';

const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const MIMO_CONSOLE_URL = 'https://platform.xiaomimimo.com/#/console/balance';
const MIMO_CONSOLE_HOST = 'platform.xiaomimimo.com';

// Keep the measured browser header shape for console reads and session exchange.
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

// Origin and Referer describe the console page. Desktop's membership calls omit
// them, so do not forward them to the SSO or membership host.
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
