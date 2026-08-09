'use strict';

const { coerceHistory } = require('../shared/history');

function parseCompleteHistory(payload) {
  return coerceHistory(payload);
}

// Which of the four resolutions below a configuration selects. Callers that need
// to know how expensive a history read will be ask this rather than re-deriving
// the branches, so the cost model cannot drift from the resolver: only 'remote'
// is a network round trip, and the other three are in-process.
function completeHistorySource(options = {}) {
  const { embeddedHub, hubMode, hubUrl, mode, historyEnabled = true } = options;
  if (historyEnabled === false) return 'empty';
  if (mode === 'local') return 'local';
  if (hubMode === 'host' && embeddedHub) return 'embedded';
  if (!hubUrl) return 'empty';
  return 'remote';
}

async function resolveCompleteHistory(options = {}) {
  const {
    aggregateHistory,
    embeddedHub,
    fetchImpl = globalThis.fetch,
    hubUrl,
    localDevice,
    secret,
    timeoutMs = 15_000
  } = options;
  const aggregate = typeof aggregateHistory === 'function' ? aggregateHistory : () => parseCompleteHistory(null);
  switch (completeHistorySource(options)) {
    case 'empty':
      return parseCompleteHistory(aggregate([]));
    case 'local':
      return parseCompleteHistory(aggregate(localDevice ? [localDevice] : []));
    case 'embedded':
      return parseCompleteHistory(embeddedHub.hub.getHistory());
    default:
      break;
  }
  if (typeof fetchImpl !== 'function') throw new Error('History fetch is unavailable');

  const url = `${String(hubUrl).replace(/\/$/, '')}/api/history`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return parseCompleteHistory(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  completeHistorySource,
  parseCompleteHistory,
  resolveCompleteHistory
};
