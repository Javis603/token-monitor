'use strict';

const QUOTA_ENGINE_VERSION = '1';
const QUOTA_CONTRACT_VERSION = 'profile-quota-snapshot-v1';

const OBSERVATION_KEYS = Object.freeze([
  'observedAt',
  'provider',
  'profileId',
  'limitId',
  'kind',
  'usedPercent',
  'windowMinutes',
  'resetsAt',
  'segmentId'
]);

const SAMPLE_KEYS = Object.freeze([
  'observedAt',
  'provider',
  'profileId',
  'limitId',
  'kind',
  'usedPercent',
  'windowMinutes',
  'resetsAt',
  'segmentId',
  'sampleId',
  'scopeVersion',
  'snapshotId',
  'observedTotalTokens',
  'pricedTokens',
  'unpricedTokens',
  'apiEquivalentCostUsd',
  'referenceEquivalentTokens',
  'pricingCoverage',
  'unsettled'
]);

const REFERENCE_KEYS = Object.freeze(['snapshotId', 'provider', 'model', 'category']);

function pickKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const picked = {};
  let any = false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) continue;
    picked[key] = value[key];
    any = true;
  }
  return any ? picked : null;
}

function sanitizeObservation(value) {
  return pickKeys(value, OBSERVATION_KEYS);
}

function sanitizeAccountingSample(value) {
  const sample = pickKeys(value, SAMPLE_KEYS);
  if (!sample) return null;
  const reference = pickKeys(value.reference, REFERENCE_KEYS);
  if (reference) sample.reference = reference;
  return sample;
}

function sanitizeObservationList(value) {
  return (Array.isArray(value) ? value : []).map(sanitizeObservation).filter(Boolean);
}

function sanitizeAccountingSampleList(value) {
  return (Array.isArray(value) ? value : []).map(sanitizeAccountingSample).filter(Boolean);
}

module.exports = {
  QUOTA_CONTRACT_VERSION,
  QUOTA_ENGINE_VERSION,
  sanitizeAccountingSample,
  sanitizeAccountingSampleList,
  sanitizeObservation,
  sanitizeObservationList
};
