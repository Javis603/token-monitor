// @ts-check
'use strict';

/** @param {{id: string}} account */
function sourcePreferenceKey(account) { return `${account.id}SourcePreference`; }

/** Unknown persisted preferences restore the legacy automatic behavior.
 * @param {{sourceSelection?: {sources: string[]}}} account @param {unknown} value */
function normalizeSourcePreference(account, value) {
  return typeof value === 'string' && account.sourceSelection?.sources.includes(value) ? value : 'auto';
}

/** Providers call this before reading any credential or transport. Probes always
 * validate the submitted draft, independent of the collector preference.
 * @param {string} id @param {Record<string, any>} options @param {Record<string, any>} deps */
function selectedSource(id, options, deps) {
  return deps.probe === true ? 'auto' : options[`${id}SourcePreference`] || 'auto';
}
module.exports = { sourcePreferenceKey, normalizeSourcePreference, selectedSource };
