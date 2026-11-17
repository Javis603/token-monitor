// @ts-check
'use strict';
/** @param {any} row */
function freshnessKey(row) { return row.accountKey ? `opendesign:${row.accountKey}` : row.provider; }
module.exports = { freshnessKey };
