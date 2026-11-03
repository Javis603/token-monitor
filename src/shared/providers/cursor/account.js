'use strict';

// Cursor limits account wiring. Leaf module: no requires.
// normalizeCursorAccountIds is the canonical copy — runtimeConfig re-exports it.
function normalizeCursorAccountIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((id) => String(id || '').trim())
    .filter((id) => id && id.length <= 256))];
}

// Digests of removed desktop sign-ins (see auth.cursorTokenFingerprint). Only
// the newest few matter: each one blocks a single desktop token.
const CURSOR_DISMISSED_TOKEN_LIMIT = 20;
function normalizeCursorDismissedTokenFingerprints(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => /^[0-9a-f]{64}$/.test(entry)))]
    .slice(-CURSOR_DISMISSED_TOKEN_LIMIT);
}

module.exports = {
  id: 'cursor',
  fetch: 'fetchCursorLimits',
  fields: [
    {
      key: 'cursorDisabledAccountIds',
      kind: 'setting',
      configNormalize: normalizeCursorAccountIds,
      persist: 'spread',
      initial: []
    }
  ],
  normalizeCursorAccountIds,
  normalizeCursorDismissedTokenFingerprints,
  urlPolicy: [
    { hosts: ['cursor.com', 'www.cursor.com'], pathPrefixes: ['/settings'], exactPaths: ['/', '/dashboard'] }
  ]
};
