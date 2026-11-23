// @ts-check
'use strict';

const crypto = require('node:crypto');
const { hashKey } = require('../../hashKey');

// Credential-local fallback, not proof that two browser sessions share an account.
/** @param {string} cookie */
function openCodeCookieAccountKey(cookie) {
  if (!cookie) return '';
  const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12);
  return hashKey('opencode', `cookie:${cookieHash}`);
}

module.exports = { openCodeCookieAccountKey };
