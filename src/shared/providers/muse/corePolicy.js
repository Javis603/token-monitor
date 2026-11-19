// @ts-check
'use strict';
/** @param {any} row @param {string} key */
function aggregateKey(row, key) {
  const sourceKey = `${key}:source:${row.source || ''}`;
  return row.source === 'web' ? sourceKey : `${sourceKey}:device:${row.sourceDeviceId || ''}`;
}
/** @param {any} row @param {string} key */
function collapseKey(row, key) { return row.source === 'web' ? `${row.provider}:source:web` : key; }
/** @param {any} row */
function freshnessKey(row) { return `${row.provider}:${row.source}`; }
module.exports = { aggregateKey, collapseKey, freshnessKey };
