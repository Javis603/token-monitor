'use strict';

const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const MIMO_CONSOLE_URL = 'https://platform.xiaomimimo.com/#/console/balance';

// What a MiMo client sends. One definition, because both the console reads and the
// service-login walk answer to the same question — and the walk learned it the hard
// way: a request that reaches the SSO without these does not merely fail, it takes
// the signed-in session with it, so MiMo Desktop itself asks for a login
// afterwards. The evidence is a clean record for thirteen consecutive exchanges
// that sent this set, against two sessions lost the moment a request went out
// without a `User-Agent`.
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

module.exports = { MIMO_CONSOLE_URL, mimoRequestHeaders };
