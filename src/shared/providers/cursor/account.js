// @ts-check
'use strict';

// Cursor limits account wiring. Leaf module: no requires.
// normalizeCursorAccountIds is the canonical copy — runtimeConfig re-exports it.
/** @param {unknown} value */
function normalizeCursorAccountIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((id) => String(id || '').trim())
    .filter((id) => id && id.length <= 256))];
}

// A desktop-detected account follows the Cursor desktop sign-in. It leaves the
// account list once Cursor rejects its token, the desktop is signed out, or the
// desktop is signed in as a different user. An unknown desktop state or a
// temporary probe failure keeps it listed. Its stored usage history is untouched.
/** @param {{desktop?: {state: string, userId?: string}, userId?: string, unauthorized?: boolean}} [input] */
function isCursorDetectedAccountCurrent({ desktop, userId = '', unauthorized = false } = {}) {
  if (unauthorized) return false;
  if (desktop?.state === 'signed-out') return false;
  if (desktop?.state === 'signed-in' && userId && desktop.userId && desktop.userId !== userId) return false;
  return true;
}

module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration & {isCursorDetectedAccountCurrent: typeof isCursorDetectedAccountCurrent, normalizeCursorAccountIds: typeof normalizeCursorAccountIds}} */ ({
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
  isCursorDetectedAccountCurrent,
  normalizeCursorAccountIds,
  urlPolicy: [
    { hosts: ['cursor.com', 'www.cursor.com'], pathPrefixes: ['/settings'], exactPaths: ['/', '/dashboard'] }
  ]
});
