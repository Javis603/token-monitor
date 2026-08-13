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

function entryForRevision(component, revision) {
  const entries = registry?.components?.[component];
  return Array.isArray(entries)
    ? entries.find((entry) => finiteRevision(entry?.revision) === revision) || null
    : null;
}

function knownRevisionMatches(component, revision, buildId, expectedRevision) {
  const entry = entryForRevision(component, revision);
  if (entry) return entry.buildId === buildId;
  return revision > expectedRevision;
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

  if (!knownRevisionMatches('core', remoteCoreRevision, remoteBuild.coreBuildId, expected.coreRevision)
    || !knownRevisionMatches(runtime, remoteRuntimeRevision, remoteBuild.runtimeBuildId, expected.runtimeRevision)) {
    return { status: 'unknown', runtime };
  }

  const directions = [
    Math.sign(remoteCoreRevision - expected.coreRevision),
    Math.sign(remoteRuntimeRevision - expected.runtimeRevision)
  ];
  const hasOlder = directions.includes(-1);
  const hasNewer = directions.includes(1);
  if (hasOlder && hasNewer) return { status: 'unknown', runtime };
  if (hasOlder) return { status: 'updateAvailable', runtime };
  if (hasNewer) return { status: 'remoteNewer', runtime };
  return { status: 'current', runtime };
}

module.exports = { compareHubBuild, entryForRevision, validBuildId };
