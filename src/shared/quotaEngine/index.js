'use strict';

const accountSummary = require('./accountSummary');
const capacityEstimator = require('./capacityEstimator');
const contract = require('./contract');
const pricing = require('./pricing');
const { buildProfileQuotaSnapshot } = require('./profileSnapshot');
const windowIdentity = require('./windowIdentity');

module.exports = {
  QUOTA_CONTRACT_VERSION: contract.QUOTA_CONTRACT_VERSION,
  QUOTA_ENGINE_VERSION: contract.QUOTA_ENGINE_VERSION,
  buildProfileQuotaSnapshot,
  // 输入 allowlist 也由核心拥有并公开：适配层（quotaAdapters）用它把 fork 的
  // archive 行收敛成合同允许的输入，而不是自己抄一份字段白名单。
  sanitizeAccountingSample: contract.sanitizeAccountingSample,
  sanitizeAccountingSampleList: contract.sanitizeAccountingSampleList,
  sanitizeObservation: contract.sanitizeObservation,
  sanitizeObservationList: contract.sanitizeObservationList,

  RESET_CYCLE_JITTER_MS: windowIdentity.RESET_CYCLE_JITTER_MS,
  cycleSegmentId: windowIdentity.cycleSegmentId,
  isSuccessorQuotaCycle: windowIdentity.isSuccessorQuotaCycle,
  resetTimesClose: windowIdentity.resetTimesClose,
  sameQuotaCycle: windowIdentity.sameQuotaCycle,
  sameWindow: windowIdentity.sameWindow,

  BASELINE_PERCENT_EPSILON: accountSummary.BASELINE_PERCENT_EPSILON,
  buildAccountQuotaSummary: accountSummary.buildAccountQuotaSummary,
  chooseCapacityCandidate: accountSummary.chooseCapacityCandidate,
  compatibleCapacityEvidence: accountSummary.compatibleCapacityEvidence,
  currentCycleSamples: accountSummary.currentCycleSamples,
  deriveQuotaAmounts: accountSummary.deriveQuotaAmounts,
  dropSamplesBeforePercentRollback: accountSummary.dropSamplesBeforePercentRollback,
  locallyObservedDelta: accountSummary.locallyObservedDelta,
  withinCurrentRun: accountSummary.withinCurrentRun,

  CAPACITY_ESTIMATE_METHOD: capacityEstimator.CAPACITY_ESTIMATE_METHOD,
  COMPLETE_COVERAGE_EPSILON: capacityEstimator.COMPLETE_COVERAGE_EPSILON,
  FULL_CYCLE_END_MIN_PERCENT: capacityEstimator.FULL_CYCLE_END_MIN_PERCENT,
  FULL_CYCLE_ESTIMATE_METHOD: capacityEstimator.FULL_CYCLE_ESTIMATE_METHOD,
  FULL_CYCLE_START_MAX_PERCENT: capacityEstimator.FULL_CYCLE_START_MAX_PERCENT,
  MIN_STABLE_PERCENT_SPAN: capacityEstimator.MIN_STABLE_PERCENT_SPAN,
  STABLE_NORMALIZED_RMSE: capacityEstimator.STABLE_NORMALIZED_RMSE,
  STABLE_R_SQUARED: capacityEstimator.STABLE_R_SQUARED,
  canJoinMappedProfileCycle: capacityEstimator.canJoinMappedProfileCycle,
  cycleGapEvidence: capacityEstimator.cycleGapEvidence,
  cycleObservedTokens: capacityEstimator.cycleObservedTokens,
  deriveApiEquivalentQuota: capacityEstimator.deriveApiEquivalentQuota,
  deriveCapacityQuota: capacityEstimator.deriveCapacityQuota,
  estimateCapacityGroup: capacityEstimator.estimateCapacityGroup,
  estimateHasCycleGap: capacityEstimator.estimateHasCycleGap,
  estimateRateLimitCapacities: capacityEstimator.estimateRateLimitCapacities,
  fullCycleDirectCapacity: capacityEstimator.fullCycleDirectCapacity,
  sampleGroupKey: capacityEstimator.sampleGroupKey,
  samplePricingIdentity: capacityEstimator.samplePricingIdentity,
  sampleWindowIdentity: capacityEstimator.sampleWindowIdentity,
  selectLatestValidRun: capacityEstimator.selectLatestValidRun,
  selectQuotaEvidenceStatus: capacityEstimator.selectQuotaEvidenceStatus,

  ALL_CATEGORIES: pricing.ALL_CATEGORIES,
  DEFAULT_API_PRICING_SNAPSHOT: pricing.DEFAULT_API_PRICING_SNAPSHOT,
  INCONSISTENT_COMPONENT_DELTA_REASON: pricing.INCONSISTENT_COMPONENT_DELTA_REASON,
  LEGACY_COMPONENT_BASELINE_REASON: pricing.LEGACY_COMPONENT_BASELINE_REASON,
  PRICING_SNAPSHOT_VERSION: pricing.PRICING_SNAPSHOT_VERSION,
  STANDARD_SHORT_CONTEXT_ASSUMPTION_ID: pricing.STANDARD_SHORT_CONTEXT_ASSUMPTION_ID,
  TOKEN_CATEGORIES: pricing.TOKEN_CATEGORIES,
  lookupPrice: pricing.lookupPrice,
  normalizePricingSnapshot: pricing.normalizePricingSnapshot,
  priceTokenComponents: pricing.priceTokenComponents,
  providerForClient: pricing.providerForClient,
  snapshotPublicMeta: pricing.snapshotPublicMeta
};
