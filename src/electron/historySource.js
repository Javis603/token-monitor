'use strict';

const { coerceHistory } = require('../shared/history');

function parseCompleteHistory(payload) {
  return coerceHistory(payload);
}

async function resolveCompleteHistory(options = {}) {
  const {
    aggregateHistory,
    embeddedHub,
    fetchImpl = globalThis.fetch,
    hubMode,
    hubUrl,
    localDevice,
    mode,
    secret,
    historyEnabled = true,
    timeoutMs = 15_000
  } = options;
  const aggregate = typeof aggregateHistory === 'function' ? aggregateHistory : () => parseCompleteHistory(null);
  if (historyEnabled === false) return parseCompleteHistory(aggregate([]));
  if (mode === 'local') {
    return parseCompleteHistory(aggregate(localDevice ? [localDevice] : []));
  }
  if (hubMode === 'host' && embeddedHub) {
    return parseCompleteHistory(embeddedHub.hub.getHistory());
  }
  if (!hubUrl) return parseCompleteHistory(aggregate([]));
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
  parseCompleteHistory,
  resolveCompleteHistory
};
