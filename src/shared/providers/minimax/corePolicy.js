// @ts-check
'use strict';
/** @param {any} row */
function freshnessKey(row) { return `${row.provider}:${row.source}`; }
module.exports = { preserveAccount: true, freshnessKey };
