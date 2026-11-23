'use strict';

const { compareHubBuild } = require('../shared/hubBuildComparison');
const { normalizeRuntime } = require('../shared/hubBuildIdentity');

function healthRuntime(payload) {
  return normalizeRuntime(payload?.hubBuild?.runtime || payload?.runtime || '');
}

async function probeHubBuild(hubUrl, options = {}) {
  const base = String(hubUrl || '').trim().replace(/\/$/, '');
  if (!base) return { status: 'notConfigured', runtime: '', hubUrl: '' };
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || 5000);
  const signal = options.signal || AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(`${base}/api/health`, { signal });
    if (!response.ok) return { status: 'unavailable', runtime: '', hubUrl: base };
    const payload = await response.json();
    if (payload?.role !== 'hub') return { status: 'unavailable', runtime: '', hubUrl: base };
    const compared = compareHubBuild(payload?.hubBuild);
    const runtime = compared.status === 'legacy' ? healthRuntime(payload) : compared.runtime;
    const deployment = payload.deployment;
    return {
      ...compared,
      runtime,
      ...(runtime === 'node-hub' && (deployment === 'app' || deployment === 'standalone') ? { deployment } : {}),
      hubUrl: base
    };
  } catch (_) {
    return { status: 'unavailable', runtime: '', hubUrl: base };
  }
}

module.exports = { healthRuntime, probeHubBuild };
