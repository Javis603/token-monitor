'use strict';

// Cursor limits provider: per-account billing and on-demand windows, using the
// session/auth helpers in this folder. Reached through providerFetchers() in
// src/shared/limits/collector.js.

const cursorAuth = require('./auth');
const cursorProbe = require('./probe');
const { hashKey } = require('../../hashKey');
const {
  cleanPlanText,
  displayPlanText
} = require('../../limits/providerHelpers');

function hashCursorAccountKey(account, resolvedUserId = '') {
  const accountId = String(account?.id || '').trim();
  const canonicalUserId = [resolvedUserId, account?.userId, accountId]
    .map(cursorAuth.canonicalCursorUserId)
    .find(Boolean) || '';
  if (canonicalUserId) return hashKey('cursor', canonicalUserId);
  return hashKey('cursor-local', accountId || 'unknown');
}

function formatCursorMembership(type) {
  if (!type || typeof type !== 'string') return '';
  const raw = type.trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'pro+' || raw === 'pro_plus') return 'Pro+';
  if (raw === 'unified_ultra') return 'Ultra';
  return displayPlanText(cleanPlanText(raw, []), Infinity);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function percentFromUsedLimit(used, limit) {
  const safeUsed = finiteNumber(used);
  const safeLimit = finiteNumber(limit);
  if (safeUsed === null || safeLimit === null || safeLimit <= 0) return null;
  return Math.max(0, Math.min(100, (safeUsed / safeLimit) * 100));
}

function cursorResetIso(usage) {
  if (!usage.billingCycleEnd) return null;
  const date = new Date(usage.billingCycleEnd);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cursorBillingWindow(label, fields = {}) {
  return {
    kind: 'billing',
    label,
    ...fields
  };
}

// The X Subscription (Plus, Premium, Super, unified Ultra) replaces the two model
// pools with one included pool shared with Grok and Grok Bot, so the separate
// Grok Bot allowance would count the same pool twice.
// Plan info is authoritative, as in Cursor's own settings; the sand status's
// unified flag only stands in when plan info is unavailable.
function cursorPlanType(usage) {
  if (usage.planInfo) return usage.planInfo.isMerged === true ? 'unified' : 'legacy';
  if (usage.grokBot) return usage.grokBot.isUnified === true ? 'unified' : 'legacy';
  // A failed lookup is not a proto3 response with an omitted false flag.
  return 'unknown';
}

function cursorIncludedWindow(usage, billingResetsAt) {
  if (finiteNumber(usage.planPercent) === null) return null;
  // Unified pools default to weekly; only an explicit monthly period may use
  // the billing reset. Missing weekly reset dates stay unknown.
  const weekly = usage.planInfo?.includedUsagePeriod !== 'monthly';
  return {
    kind: weekly ? 'weekly' : 'billing',
    label: 'Included usage',
    usedPercent: usage.planPercent,
    resetsAt: weekly ? usage.planInfo?.includedUsageResetsAt || null : billingResetsAt,
    windowMinutes: weekly ? 7 * 24 * 60 : null,
    resetDescription: '',
    showMeter: true
  };
}

function cursorPrepaidWindow(usage) {
  const available = finiteNumber(usage.prepaid?.availableUsd);
  if (available === null || available <= 0) return null;
  return cursorBillingWindow('Prepaid balance', {
    metric: 'credits',
    currency: 'USD',
    remaining: available,
    resetsAt: null,
    windowMinutes: null,
    resetDescription: '',
    showMeter: false
  });
}

function cursorOnDemandWindow(usage, resetsAt) {
  const personalUsed = finiteNumber(usage.onDemandUsedUsd) ?? 0;
  const personalLimit = finiteNumber(usage.onDemandLimitUsd);
  const teamUsed = finiteNumber(usage.teamOnDemandUsedUsd) ?? 0;
  const teamLimit = finiteNumber(usage.teamOnDemandLimitUsd);
  let used;
  let limit = null;
  let remaining = null;

  if (personalLimit !== null && personalLimit > 0) {
    used = personalUsed;
    limit = personalLimit;
    remaining = finiteNumber(usage.onDemandRemainingUsd);
  } else if (teamLimit !== null && teamLimit > 0) {
    used = teamUsed;
    limit = teamLimit;
    remaining = finiteNumber(usage.teamOnDemandRemainingUsd);
  } else if (personalUsed > 0) {
    used = personalUsed;
  } else if (teamUsed > 0) {
    used = teamUsed;
  } else {
    return null;
  }

  if (limit !== null && remaining === null) remaining = Math.max(0, limit - used);
  return cursorBillingWindow('On-demand spend', {
    metric: 'spend',
    currency: 'USD',
    usedPercent: percentFromUsedLimit(used, limit),
    used,
    limit,
    remaining,
    resetsAt,
    windowMinutes: null,
    resetDescription: '',
    showMeter: false
  });
}

async function fetchCursorAccountLimits(account, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const updatedAt = new Date(nowMs).toISOString();
  const probe = deps.probe || cursorProbe.probe;
  if (!account) {
    return {
      provider: 'cursor',
      accountKey: '',
      accountLabel: '',
      status: 'notConfigured',
      source: 'web',
      updatedAt,
      windows: []
    };
  }

  const result = await probe(account.sessionToken, deps);
  if (!result.ok) {
    const kind = result.error?.kind === 'unauthorized' ? 'unauthorized' : 'unavailable';
    return {
      provider: 'cursor',
      accountKey: hashCursorAccountKey(account),
      accountLabel: account.label || '',
      status: kind,
      source: 'web',
      updatedAt,
      windows: []
    };
  }

  const { usage } = result;
  const resetsAt = cursorResetIso(usage) || usage.planInfo?.billingCycleEnd || null;
  const planType = cursorPlanType(usage);
  const unified = planType === 'unified';
  const legacy = planType === 'legacy';
  const hasRequestUsage = finiteNumber(usage.requestsUsed) !== null
    && finiteNumber(usage.requestsLimit) !== null
    && usage.requestsLimit > 0;
  const windows = [];

  if (unified) {
    const includedWindow = cursorIncludedWindow(usage, resetsAt);
    if (includedWindow) windows.push(includedWindow);
  } else if (legacy && hasRequestUsage) {
    windows.push(cursorBillingWindow('Requests', {
      usedPercent: percentFromUsedLimit(usage.requestsUsed, usage.requestsLimit),
      used: usage.requestsUsed,
      limit: usage.requestsLimit,
      remaining: Math.max(0, usage.requestsLimit - usage.requestsUsed),
      resetsAt,
      windowMinutes: null,
      resetDescription: usage.membershipType ? `Cursor ${usage.membershipType}` : ''
    }));
  } else if (legacy && (finiteNumber(usage.autoPercent) !== null || finiteNumber(usage.apiPercent) !== null)) {
    if (finiteNumber(usage.autoPercent) !== null) windows.push(cursorBillingWindow('Cursor Models', {
      usedPercent: usage.autoPercent,
      resetsAt,
      windowMinutes: null
    }));
    if (finiteNumber(usage.apiPercent) !== null) windows.push(cursorBillingWindow('Other Models', {
      usedPercent: usage.apiPercent,
      resetsAt,
      windowMinutes: null
    }));
  } else if (legacy && usage.hasOverallUsage && finiteNumber(usage.planPercent) !== null) {
    windows.push(cursorBillingWindow('Overall', {
      usedPercent: usage.planPercent,
      used: usage.planUsedUsd,
      limit: usage.planLimitUsd,
      remaining: usage.planRemainingUsd,
      resetsAt,
      windowMinutes: null
    }));
  }

  if (!unified && usage.grokBot?.hasNonZeroIncludedLimit === true && finiteNumber(usage.grokBot.usedPercent) !== null) {
    windows.push({
      kind: 'weekly',
      label: 'Grok Bot',
      usedPercent: usage.grokBot.usedPercent,
      resetsAt: usage.grokBot.resetsAt || null,
      windowMinutes: finiteNumber(usage.grokBot.windowMinutes),
      resetDescription: '',
      showMeter: true
    });
  }

  if (usage.hasTeamPooledUsage || finiteNumber(usage.teamPooledLimitUsd) !== null || (finiteNumber(usage.teamPooledUsedUsd) !== null && usage.teamPooledUsedUsd > 0)) {
    const remaining = finiteNumber(usage.teamPooledRemainingUsd)
      ?? (finiteNumber(usage.teamPooledLimitUsd) !== null
        ? Math.max(0, usage.teamPooledLimitUsd - (finiteNumber(usage.teamPooledUsedUsd) || 0))
        : null);
    windows.push(cursorBillingWindow('Team pool', {
      usedPercent: finiteNumber(usage.teamPooledPercent) ?? percentFromUsedLimit(usage.teamPooledUsedUsd, usage.teamPooledLimitUsd),
      used: usage.teamPooledUsedUsd,
      limit: usage.teamPooledLimitUsd,
      remaining,
      resetsAt,
      windowMinutes: null,
      resetDescription: 'Shared team usage pool.'
    }));
  }

  const prepaidWindow = unified ? cursorPrepaidWindow(usage) : null;
  if (prepaidWindow) windows.push(prepaidWindow);

  const onDemandWindow = unified ? null : cursorOnDemandWindow(usage, resetsAt);
  if (onDemandWindow) windows.push(onDemandWindow);

  return {
    provider: 'cursor',
    accountKey: hashCursorAccountKey(account, result.user?.sub),
    accountLabel: result.user?.email || account.label || formatCursorMembership(usage.membershipType) || '',
    accountEmail: result.user?.email || '',
    planLabel: formatCursorMembership(usage.membershipType) || (unified ? usage.planInfo?.planName || '' : ''),
    status: planType === 'unknown' && windows.length === 0 ? 'unavailable' : 'ok',
    // Runtime-only: these legacy seat quotas are untrusted even in lastGood.
    ...(planType === 'unknown' ? {
      invalidateCachedWindowLabels: ['Requests', 'Cursor Models', 'Other Models', 'Overall']
    } : {}),
    source: 'web',
    updatedAt,
    windows
  };
}

async function fetchCursorLimits(options = {}, deps = {}) {
  let accounts;
  if (typeof deps.listAccounts === 'function') {
    accounts = deps.listAccounts();
  } else if (typeof deps.readActiveAccount === 'function') {
    accounts = [deps.readActiveAccount()].filter(Boolean);
  } else {
    accounts = cursorAuth.listAccounts();
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return fetchCursorAccountLimits(null, deps);
  }
  const disabled = new Set((Array.isArray(options.cursorDisabledAccountIds) ? options.cursorDisabledAccountIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  const enabledAccounts = accounts.filter((account) => !disabled.has(account.id));
  if (enabledAccounts.length === 0) return fetchCursorAccountLimits(null, deps);
  const providers = await Promise.all(enabledAccounts.map((account) => fetchCursorAccountLimits(account, deps)));
  return providers.length === 1 ? providers[0] : providers;
}

module.exports = {
  fetchCursorLimits
};
