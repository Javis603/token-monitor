// @ts-check
'use strict';

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

module.exports = { changeLimitAccountLink };
