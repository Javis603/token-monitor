// @ts-check
'use strict';

// Stable server identities survive missing credentials and refresh rotation.
const { isWorkbuddyPlaceholder } = require('./identity');
/** @param {any[]} rows */
function suppressCandidates(rows) {
  return rows.some(row => row.accountKey && !isWorkbuddyPlaceholder(row)) ? rows.filter(isWorkbuddyPlaceholder) : [];
}
/** @param {any} row */
function preserveStaleAccount(row) { return !isWorkbuddyPlaceholder(row); }
module.exports = { preserveAccount: true, isPlaceholder: isWorkbuddyPlaceholder, preserveStaleAccount, suppressCandidates };
