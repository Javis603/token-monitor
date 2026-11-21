// @ts-check
'use strict';

const { aggregateLimits, hiddenLinkedLimitReadings, withLimitAccountLinks } = require('../../shared/limits/core');
const { normalizeSharedSyncValue } = require('../../shared/syncContent');
const KIND = 'limitAccountLinks';

/** @param {any} stats @param {any} input @param {Record<string, {labels?: Record<string,string>}>} presentation @param {(payload: any) => Promise<any>} write */
async function changeLimitAccountLink(stats, input, presentation, write) {
  const revision = stats?.syncSettingsRevisions?.[KIND];
  if (!Number.isSafeInteger(revision) || revision !== input?.revision
    || !['link', 'split'].includes(input.operation)) return { ok: false };
  try {
    const [pair] = /** @type {{provider: string, scope: string, keys: string[]}[]} */ (normalizeSharedSyncValue(KIND, [input.pair]));
    /** @type {{provider: string, scope: string, keys: string[]}[]} */
    const links = stats.limitAccountLinks || [];
    const matches = (/** @type {any} */ link) => link.provider === pair.provider && link.scope === pair.scope && link.keys.every((/** @type {string} */ key) => pair.keys.includes(key));
    if (input.operation === 'split' && !links.some(matches)) return { ok: false };
    if (input.operation === 'link') {
      const [first, second] = pair.keys.map(key => stats.limitAccountLinkCandidates?.find(
        (/** @type {any} */ row) => row.provider === pair.provider && row.scope === pair.scope && row.accountKey === key));
      const labels = presentation[pair.provider]?.labels || {};
      const [a, b] = [first, second].map(row => labels[row?.labelKey]?.trim().toLowerCase());
      if (!first?.deviceId || !second?.deviceId || first.deviceId === second.deviceId || !a || a !== b) return { ok: false };
    }
    const value = normalizeSharedSyncValue(KIND, input.operation === 'link' ? [...links, pair] : links.filter(link => !matches(link)));
    const response = await write({ baseRevision: revision, value });
    return { ok: response.status === 200 };
  } catch (_) {
    return { ok: false };
  }
}

/**
 * Include the observation a confirmed pair hid when writing quota history.
 * Its original account and device keys let it keep collecting points while
 * the user sees a single quota in Limits.
 * @param {any} stats
 */
function limitsForAccountHistory(stats) {
  const { limits } = stats;
  if (!stats.limitAccountLinks?.length || !limits?.providers) return limits;
  let hidden = stats[hiddenLinkedLimitReadings];
  if (!hidden && stats.devices?.length) {
    // A remote snapshot cannot carry the process-local readings. Rebuild the
    // pair from its devices so same-account observations can contribute a
    // balance or other carried data before choosing the hidden reading.
    const links = stats.limitAccountLinks;
    const nowMs = Date.parse(limits.updatedAt) || Date.now();
    const unlinked = aggregateLimits(stats.devices, stats.staleAfterMs || 0, nowMs, {}, links);
    hidden = withLimitAccountLinks({ limits: unlinked }, { value: links })[hiddenLinkedLimitReadings];
  }
  return hidden?.length ? { ...limits, providers: [...limits.providers, ...hidden] } : limits;
}

module.exports = { changeLimitAccountLink, limitsForAccountHistory };
