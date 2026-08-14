'use strict';

const registry = require('./hubBuildRegistry.json');

const RUNTIMES = new Set(['node-hub', 'cloudflare-worker']);

function latestEntry(component) {
  const entries = registry?.components?.[component];
  return Array.isArray(entries) && entries.length > 0 ? entries.at(-1) : null;
}

function normalizeRuntime(value) {
  const runtime = String(value || '').trim().toLowerCase();
  if (runtime === 'node' || runtime === 'hub') return 'node-hub';
  if (runtime === 'worker') return 'cloudflare-worker';
  return RUNTIMES.has(runtime) ? runtime : '';
}

function currentHubBuild(runtime) {
  const normalizedRuntime = normalizeRuntime(runtime);
  const core = latestEntry('core');
  const adapter = latestEntry(normalizedRuntime);
  if (!normalizedRuntime || !core || !adapter) return null;
  return Object.freeze({
    schemaVersion: registry.schemaVersion,
    runtime: normalizedRuntime,
    coreRevision: core.revision,
    coreBuildId: core.buildId,
    runtimeRevision: adapter.revision,
    runtimeBuildId: adapter.buildId
  });
}

const api = { currentHubBuild, normalizeRuntime };

if (typeof module === 'object' && module.exports) module.exports = api;
