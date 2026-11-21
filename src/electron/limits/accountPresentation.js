// @ts-check
'use strict';
const { LIMIT_PROVIDER_REGISTRY } = require('../../shared/limits/registry');
const { normalizeLimitProvider } = require('../../shared/limits/core');
const PROVIDERS = new Set(LIMIT_PROVIDER_REGISTRY.filter(entry => entry.accountSlots || ['codex', 'cursor', 'opencode', 'mimo', 'thirdparty', 'grok', 'kiro'].includes(entry.id)).map(entry => entry.id));
const MAX_ENTRIES = 200;
/** @param {any} value */
const object = value => value && typeof value === 'object' && !Array.isArray(value);
/** @param {any} key */
const validKey = key => typeof key === 'string' && key.trim() === key && key.length > 0 && key.length <= 256;
/** @param {any} input @returns {Record<string, {labels: Record<string, string>, order: string[]}>} */
function normalizeAccountPresentation(input) {
  if (!object(input)) return {};
  return Object.fromEntries(Object.entries(input).filter(([id, group]) => PROVIDERS.has(id) && object(group)).map(([id, group]) => {
    // Normalize before bounding so invalid entries never take a place, and keep
    // the most recent entries so a new rename is not the one dropped at the cap.
    const labels = Object.fromEntries((object(group.labels) ? Object.entries(group.labels) : []).filter(([key, label]) => validKey(key) && typeof label === 'string').map(([key, label]) => [key, normalizeLimitProvider({ provider: id, accountLabel: label })?.accountLabel || '']).filter(([key, label]) => label || group.labels[key] === '').slice(-MAX_ENTRIES));
    const order = Array.isArray(group.order) ? [...new Set(group.order.filter(validKey))].slice(0, MAX_ENTRIES) : [];
    return [id, { labels, order }];
  }));
}
module.exports = { normalizeAccountPresentation, validKey };
