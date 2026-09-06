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
  const resetsAt = cursorResetIso(usage);
  const hasRequestUsage = finiteNumber(usage.requestsUsed) !== null
    && finiteNumber(usage.requestsLimit) !== null
    && usage.requestsLimit > 0;
  const windows = [];

  if (hasRequestUsage) {
    windows.push(cursorBillingWindow('Requests', {
      usedPercent: percentFromUsedLimit(usage.requestsUsed, usage.requestsLimit),
      used: usage.requestsUsed,
      limit: usage.requestsLimit,
      remaining: Math.max(0, usage.requestsLimit - usage.requestsUsed),
      resetsAt,
      windowMinutes: null,
      resetDescription: usage.membershipType ? `Cursor ${usage.membershipType}` : ''
    }));
  } else if (finiteNumber(usage.autoPercent) !== null || finiteNumber(usage.apiPercent) !== null) {
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
  } else if (usage.hasOverallUsage && finiteNumber(usage.planPercent) !== null) {
    windows.push(cursorBillingWindow('Overall', {
      usedPercent: usage.planPercent,
      used: usage.planUsedUsd,
      limit: usage.planLimitUsd,
      remaining: usage.planRemainingUsd,
      resetsAt,
      windowMinutes: null
    }));
  }

  if (usage.grokBot?.hasNonZeroIncludedLimit === true && finiteNumber(usage.grokBot.usedPercent) !== null) {
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

  const onDemandWindow = cursorOnDemandWindow(usage, resetsAt);
  if (onDemandWindow) windows.push(onDemandWindow);

  return {
    provider: 'cursor',
    accountKey: hashCursorAccountKey(account, result.user?.sub),
    accountLabel: result.user?.email || account.label || formatCursorMembership(usage.membershipType) || '',
    accountEmail: result.user?.email || '',
    planLabel: formatCursorMembership(usage.membershipType),
    status: 'ok',
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
