// @ts-check
'use strict';

const GROUPED_QUOTA_LABEL = /^(.+) (?:5-hour|weekly)$/i;
const QUOTA_GROUP_ORDER = ['gemini', 'gemini 4 argon', 'claude/gpt'];

/** @param {string} name */
function quotaGroupRank(name) {
  const rank = QUOTA_GROUP_ORDER.indexOf(name.toLowerCase());
  return rank < 0 ? QUOTA_GROUP_ORDER.length : rank;
}

/** @param {string} label */
function quotaGroupFromLabel(label) {
  return GROUPED_QUOTA_LABEL.exec(label)?.[1] || '';
}

/** @param {any} window @param {string[]} order */
function windowRank(window, order) {
  const label = window.label.toLowerCase();
  const name = quotaGroupFromLabel(label);
  if (!name) {
    // Keep the order of legacy model pools reported by OAuth and older devices.
    const group = label.includes('gemini') ? 0 : label.includes('claude') || label.includes('gpt') ? 1 : 2;
    return group * order.length + order.indexOf(window.kind);
  }
  const group = quotaGroupRank(name);
  // The summary parser groups unknown pools in service order. A stable sort
  // must keep each new pool's two periods adjacent.
  return group * order.length + (group === QUOTA_GROUP_ORDER.length ? 0 : order.indexOf(window.kind));
}
// Anonymous RPC observations belong to their source device.
/** @param {any} row @param {string} key @param {boolean} configured */
function aggregateKey(row, key, configured) {
  return row.accountEmail && configured ? key : `${key}:device:${row.sourceDeviceId || ''}`;
}
/** @param {any} row @param {string} key */
function collapseKey(row, key) { return key; }
module.exports = {
  windowRank,
  aggregateKey,
  collapseKey,
  quotaGroupRank,
  quotaGroupFromLabel
};
