'use strict';

const { hashKey } = require('./hashKey');

function cleanIdentity(value) {
  return String(value || '').trim().slice(0, 256);
}

function decodeJwtPayload(accessToken) {
  const token = String(accessToken || '').trim();
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_) {
    return null;
  }
}

// Trae refreshes Cloud-IDE-JWT credentials while an account remains signed in.
// Hashing the raw token would therefore create a new pseudo-account on every
// refresh. Prefer the stable account id carried by Trae's JWT and use the raw
// token only as a deterministic fallback for opaque credentials.
function traeTokenAccountId(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  return cleanIdentity(
    payload?.data?.id
    || payload?.data?.user_id
    || payload?.user_id
    || payload?.uid
    || payload?.sub
  );
}

function traeAccountKey(accessToken, accountId = '') {
  const identity = cleanIdentity(accountId)
    || traeTokenAccountId(accessToken)
    || String(accessToken || '').trim();
  return identity ? hashKey('trae', identity) : '';
}

module.exports = {
  decodeJwtPayload,
  traeAccountKey,
  traeTokenAccountId
};
