// @ts-check
'use strict';

// Product IDs describe the entitlement, independently of read source, region,
// account identity and window period. Unknown IDs remain forward compatible.
/** @param {unknown} value @returns {string} */
function normalizeLimitProductId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,63}$/.test(id) ? id : '';
}

module.exports = { normalizeLimitProductId };
