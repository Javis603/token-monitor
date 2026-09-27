'use strict';

// Cursor limits account wiring. Leaf module: no requires.
// normalizeCursorAccountIds is the canonical copy — runtimeConfig re-exports it.
function normalizeCursorAccountIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((id) => String(id || '').trim())
    .filter((id) => id && id.length <= 256))];
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
  urlPolicy: [
    { hosts: ['cursor.com', 'www.cursor.com'], pathPrefixes: ['/settings'] }
  ]
};
