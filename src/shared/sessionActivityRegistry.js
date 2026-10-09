'use strict';

const { SESSION_ACTIVITY_PROVIDERS } = require('./sessionActivityProviders');

// Explicit lazy bindings follow the limits registry convention. A disabled
// client loads no native activity adapter; portable consumers never load this
// module. Keep file discovery and identity verification inside each adapter.
const loaders = {
  claude: () => require('./providers/claude/sessionActivity'),
  codex: () => require('./providers/codex/sessionActivity')
};
const SESSION_ACTIVITY_REGISTRY = Object.freeze(SESSION_ACTIVITY_PROVIDERS.map((entry) => {
  const load = loaders[entry.id];
  if (!load) throw new Error(`activity registry: missing adapter for ${entry.id}`);
  return Object.freeze({
    ...entry,
    read: (summary, options) => load().readActivity(summary, options),
    project: (summary, activity, now) => load().projectActivity(summary, activity, now),
    watchTargets: (options) => load().activityWatchTargets?.(options) || []
  });
}));

function sessionActivityProvidersFor(clients) {
  const enabled = new Set(clients);
  return SESSION_ACTIVITY_REGISTRY.filter((entry) => enabled.has(entry.id));
}

// Both normal collection and the lightweight patch lane use this sequential
// dispatch. A replacement/usage tick can retire a read before its projection.
async function refreshSessionActivity(summary, providers, options, shared, {
  isCurrent = () => true, now = () => Date.now()
} = {}) {
  let next = summary;
  for (const entry of providers) {
    if (!isCurrent()) return null;
    const activity = await entry.read(next, { ...options.sessionMetadataDeps?.[entry.metadataDepsKey], ...shared });
    if (!isCurrent()) return null;
    next = entry.project(next, activity, now()) || next;
  }
  return next;
}

module.exports = { SESSION_ACTIVITY_REGISTRY, sessionActivityProvidersFor, refreshSessionActivity };
