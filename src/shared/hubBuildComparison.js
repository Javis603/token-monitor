'use strict';

const registry = require('./hubBuildRegistry.json');
const { currentHubBuild, normalizeRuntime } = require('./hubBuildIdentity');

function finiteRevision(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision > 0 ? revision : null;
}

function validBuildId(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function entriesForComponent(component, registrySnapshot = registry) {
  const entries = registrySnapshot?.components?.[component];
  return Array.isArray(entries) ? entries : [];
}

function entryForRevision(component, revision, registrySnapshot = registry) {
  const entries = entriesForComponent(component, registrySnapshot);
  return Array.isArray(entries)
    ? entries.find((entry) => finiteRevision(entry?.revision) === revision) || null
    : null;
}

function canonicalRevision(component, revision, buildId, expectedRevision) {
  const exactEntry = entryForRevision(component, revision);
  if (exactEntry?.buildId === buildId) return revision;

  // Registry histories from branches that diverged at the same revision are
  // reindexed when merged. A hash already in the registry remains a known
  // build even when its original wire revision is no longer canonical.
  const entries = entriesForComponent(component);
  const matchingEntry = [...entries].reverse().find((entry) => entry?.buildId === buildId);
  if (matchingEntry) return finiteRevision(matchingEntry.revision);

  // Keep accepting builds newer than this registry. The hash is not known yet,
  // but the higher revision is the existing signal that the sender is ahead.
  if (revision > expectedRevision) return revision;
  return null;
}

function compareHubBuild(remoteBuild, expectedBuild = null) {
  if (remoteBuild === undefined) return { status: 'legacy', runtime: '' };
  if (!remoteBuild || typeof remoteBuild !== 'object' || Array.isArray(remoteBuild)) {
    return { status: 'unknown', runtime: '' };
  }
  const runtime = normalizeRuntime(remoteBuild.runtime);
  if (!runtime) return { status: 'unknown', runtime: '' };
  const expected = expectedBuild || currentHubBuild(runtime);
  if (!expected) return { status: 'unknown', runtime };

  const remoteSchema = finiteRevision(remoteBuild.schemaVersion);
  if (!remoteSchema) return { status: 'unknown', runtime };
  if (remoteSchema > registry.schemaVersion) return { status: 'remoteNewer', runtime };
  if (remoteSchema < registry.schemaVersion) return { status: 'updateAvailable', runtime };

  const remoteCoreRevision = finiteRevision(remoteBuild.coreRevision);
  const remoteRuntimeRevision = finiteRevision(remoteBuild.runtimeRevision);
  if (!remoteCoreRevision || !remoteRuntimeRevision
    || !validBuildId(remoteBuild.coreBuildId)
    || !validBuildId(remoteBuild.runtimeBuildId)) {
    return { status: 'unknown', runtime };
  }

  const coreRevision = canonicalRevision('core', remoteCoreRevision, remoteBuild.coreBuildId, expected.coreRevision);
  const runtimeRevision = canonicalRevision(runtime, remoteRuntimeRevision, remoteBuild.runtimeBuildId, expected.runtimeRevision);
  if (!coreRevision || !runtimeRevision) {
    return { status: 'unknown', runtime };
  }

  const directions = [
    Math.sign(coreRevision - expected.coreRevision),
    Math.sign(runtimeRevision - expected.runtimeRevision)
  ];
  const hasOlder = directions.includes(-1);
  const hasNewer = directions.includes(1);
  if (hasOlder && hasNewer) return { status: 'unknown', runtime };
  if (hasOlder) return { status: 'updateAvailable', runtime };
  if (hasNewer) return { status: 'remoteNewer', runtime };
  return { status: 'current', runtime };
}

module.exports = { compareHubBuild, entryForRevision, validBuildId };
