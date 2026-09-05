'use strict';

const { buildAccountQuotaSummary } = require('./accountSummary');
const { estimateRateLimitCapacities } = require('./capacityEstimator');
const {
  QUOTA_CONTRACT_VERSION,
  QUOTA_ENGINE_VERSION,
  sanitizeAccountingSampleList,
  sanitizeObservationList
} = require('./contract');

function safeProfileId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeProvider(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function latestWindows(observations) {
  const windows = new Map();
  for (const observation of observations) {
    windows.set(`${observation.kind || ''}|${observation.limitId || ''}`, observation);
  }
  return [...windows.values()];
}

function buildProfileQuotaSnapshot({
  provider,
  profileId,
  observations,
  accountingSamples
} = {}) {
  const requestedProfile = safeProfileId(profileId);
  const requestedProvider = safeProvider(provider);
  if (!requestedProfile || !requestedProvider) {
    return {
      capacityEstimates: [],
      accountQuotaSummaries: [],
      engineVersion: QUOTA_ENGINE_VERSION,
      contractVersion: QUOTA_CONTRACT_VERSION
    };
  }
  const samples = sanitizeAccountingSampleList(accountingSamples);
  const profileObservations = sanitizeObservationList(observations)
    .filter((row) => row.provider === requestedProvider && row.profileId === requestedProfile);
  const profileSamples = samples.filter((sample) => sample.provider === requestedProvider && sample.profileId === requestedProfile);
  const capacityEstimates = estimateRateLimitCapacities(profileSamples, requestedProfile);
  const accountQuotaSummaries = latestWindows(profileObservations).map((window) => buildAccountQuotaSummary({
    provider: requestedProvider,
    profileId: requestedProfile,
    window,
    samples: profileSamples,
    estimates: capacityEstimates
  }));
  return {
    capacityEstimates,
    accountQuotaSummaries,
    engineVersion: QUOTA_ENGINE_VERSION,
    contractVersion: QUOTA_CONTRACT_VERSION
  };
}

module.exports = {
  buildProfileQuotaSnapshot
};
