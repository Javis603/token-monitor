// @ts-check
'use strict';
/** @param {any} row */
function freshnessKey(row) { return row.accountKey ? `opendesign:${row.accountKey}` : row.provider; }
/** @param {any[]} rows @param {boolean} multiAccount @param {(row: any) => boolean} configured */
function suppressCandidates(rows, multiAccount, configured) {
  if (!rows.some(configured)) return [];
  return rows.filter(row => !(multiAccount && row.accountKey) && ['notConfigured', 'disabled'].includes(row.status));
}
module.exports = { freshnessKey, suppressCandidates };
