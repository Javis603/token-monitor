// @ts-check
'use strict';
// region carries the full console + plan variant, not geography alone.
/** @param {any} row @param {string} key */
function aggregateKey(row, key) { return `${key}:${row.region || ''}`; }
module.exports = { aggregateKey };
