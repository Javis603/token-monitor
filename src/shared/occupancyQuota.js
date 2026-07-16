'use strict';

const crypto = require('node:crypto');

function text(value) {
  return String(value ?? '').trim();
}

function providerId(value) {
  return text(value).toLowerCase();
}

function accountEmailHash(provider, email) {
  const id = providerId(provider);
  const normalized = text(email).toLowerCase();
  if (!id || !normalized || !normalized.includes('@')) return '';
  return `sha256:${crypto.createHash('sha256').update(`${id}\0${normalized}`).digest('hex')}`;
}

function maskEmail(value) {
  const email = text(value).toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0) return '';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return '';
  if (local.length === 1) return `${local}***@${domain}`;
  return `${local[0]}***${local.at(-1)}@${domain}`;
}

function normalizeQuotaLink(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('quotaLink_invalid');
  const provider = providerId(value.provider);
  const accountKey = text(value.accountKey);
  const accountEmailHashValue = text(value.accountEmailHash);
  const accountLabel = text(value.accountLabel).slice(0, 32);
  if (!provider) throw new Error('quotaLink_provider_required');
  if (!accountKey && !accountEmailHashValue) throw new Error('quotaLink_identity_required');
  if (accountEmailHashValue && !/^sha256:[0-9a-f]{64}$/i.test(accountEmailHashValue)) {
    throw new Error('quotaLink_email_hash_invalid');
  }
  return { provider, accountKey, accountEmailHash: accountEmailHashValue.toLowerCase(), accountLabel };
}

function timestampMs(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function preferredCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    if (left.stale !== right.stale) return left.stale ? 1 : -1;
    return timestampMs(right.updatedAt) - timestampMs(left.updatedAt);
  })[0] || null;
}

function candidateFrom(provider, device, limits, nowMs) {
  const id = providerId(provider?.provider);
  const emailHash = accountEmailHash(id, provider?.accountEmail);
  const updatedAt = text(provider?.updatedAt || limits?.updatedAt);
  const refreshMs = Number(limits?.refreshMs);
  const updatedMs = timestampMs(updatedAt);
  const refreshStale = Number.isFinite(refreshMs) && refreshMs > 0 && updatedMs > 0
    ? nowMs - updatedMs > refreshMs * 2
    : false;
  return {
    provider: id,
    accountKey: text(provider?.accountKey),
    accountEmailHash: emailHash,
    maskedEmail: maskEmail(provider?.accountEmail),
    accountLabel: text(provider?.accountLabel),
    status: text(provider?.status),
    source: text(provider?.source),
    sourceDetail: text(provider?.sourceDetail),
    updatedAt,
    sourceDeviceId: text(device?.deviceId || provider?.sourceDeviceId),
    stale: provider?.stale === true || device?.stale === true || refreshStale,
    windows: Array.isArray(provider?.windows) ? provider.windows.map((window) => ({ ...window })) : [],
    balanceUsd: Number.isFinite(Number(provider?.balanceUsd)) ? Number(provider.balanceUsd) : null,
    balance: provider?.balance && typeof provider.balance === 'object' ? { ...provider.balance } : null,
    resetCredits: provider?.resetCredits && typeof provider.resetCredits === 'object' ? { ...provider.resetCredits } : null,
    region: text(provider?.region)
  };
}

function candidateIdentity(candidate, index) {
  if (candidate.accountKey) return `${candidate.provider}:key:${candidate.accountKey}`;
  // An email is a fallback hint, not proof that two provider rows represent
  // the same account/workspace. Keep keyless rows distinct so resolution can
  // report ambiguity instead of silently collapsing them.
  return `${candidate.provider}:unknown:${index}`;
}

function collectQuotaCandidates(stats) {
  const raw = [];
  const nowMs = timestampMs(stats?.updatedAt) || Date.now();
  for (const device of Array.isArray(stats?.devices) ? stats.devices : []) {
    const limits = device?.limits && typeof device.limits === 'object' ? device.limits : {};
    for (const provider of Array.isArray(limits.providers) ? limits.providers : []) {
      if (!providerId(provider?.provider)) continue;
      raw.push(candidateFrom(provider, device, limits, nowMs));
    }
  }
  if (raw.length === 0) {
    const limits = stats?.limits && typeof stats.limits === 'object' ? stats.limits : {};
    for (const provider of Array.isArray(limits.providers) ? limits.providers : []) {
      if (!providerId(provider?.provider)) continue;
      raw.push(candidateFrom(provider, null, limits, nowMs));
    }
  }

  const byIdentity = new Map();
  raw.forEach((candidate, index) => {
    const key = candidateIdentity(candidate, index);
    const current = byIdentity.get(key);
    byIdentity.set(key, preferredCandidate(current ? [current, candidate] : [candidate]));
  });
  return [...byIdentity.values()].sort((left, right) => {
    const providerSort = left.provider.localeCompare(right.provider);
    if (providerSort !== 0) return providerSort;
    return (left.maskedEmail || left.accountLabel || left.accountKey)
      .localeCompare(right.maskedEmail || right.accountLabel || right.accountKey);
  });
}

function resolveQuotaLink(linkValue, candidates) {
  let link;
  try { link = normalizeQuotaLink(linkValue); }
  catch (_) { return { linkState: 'missing', matchBasis: 'none', candidate: null }; }
  if (!link) return { linkState: 'unlinked', matchBasis: 'none', candidate: null };
  const sameProvider = (candidates || []).filter((candidate) => candidate.provider === link.provider);

  if (link.accountKey) {
    const keyMatches = sameProvider.filter((candidate) => candidate.accountKey === link.accountKey);
    if (keyMatches.length > 0) {
      const candidate = preferredCandidate(keyMatches);
      return { linkState: candidate.stale ? 'stale' : 'linked', matchBasis: 'account_key', candidate };
    }
  }

  if (link.accountEmailHash) {
    let emailMatches = sameProvider.filter((candidate) => candidate.accountEmailHash === link.accountEmailHash);
    if (emailMatches.length > 1 && link.accountLabel) {
      const label = link.accountLabel.toLowerCase();
      emailMatches = emailMatches.filter((candidate) => candidate.accountLabel.toLowerCase() === label);
    }
    if (emailMatches.length > 1) {
      const keys = emailMatches.map((candidate) => candidate.accountKey);
      const distinctKeys = new Set(keys.filter(Boolean));
      if (keys.some((key) => !key) || distinctKeys.size !== 1) {
        return { linkState: 'ambiguous', matchBasis: 'account_email', candidate: null };
      }
    }
    if (emailMatches.length > 0) {
      const candidate = preferredCandidate(emailMatches);
      return { linkState: candidate.stale ? 'stale' : 'linked', matchBasis: 'account_email', candidate };
    }
  }

  return { linkState: 'missing', matchBasis: 'none', candidate: null };
}

function minimumRemainingPercent(candidate) {
  const values = (candidate?.windows || [])
    .filter((window) => window?.showMeter !== false)
    .map((window) => Number(window?.remainingPercent))
    .filter(Number.isFinite)
    .map((value) => Math.max(0, Math.min(100, value)));
  return values.length > 0 ? Math.min(...values) : null;
}

function quotaLight(candidate, linkState) {
  if (!candidate || linkState !== 'linked') return 'gray';
  if (candidate.status === 'rateLimited') return 'red';
  const remaining = minimumRemainingPercent(candidate);
  if (remaining === 0) return 'red';
  if (remaining !== null && remaining <= 10) return 'yellow';
  return candidate.status === 'ok' ? 'green' : 'gray';
}

function presentQuota(resolution) {
  const candidate = resolution.candidate;
  if (!candidate) {
    return { linkState: resolution.linkState, matchBasis: resolution.matchBasis, light: 'gray' };
  }
  return {
    linkState: resolution.linkState,
    matchBasis: resolution.matchBasis,
    provider: candidate.provider,
    status: candidate.status,
    stale: candidate.stale,
    updatedAt: candidate.updatedAt,
    sourceDeviceId: candidate.sourceDeviceId,
    accountLabel: candidate.accountLabel,
    maskedEmail: candidate.maskedEmail,
    windows: candidate.windows,
    balanceUsd: candidate.balanceUsd,
    balance: candidate.balance,
    resetCredits: candidate.resetCredits,
    region: candidate.region,
    minimumRemainingPercent: minimumRemainingPercent(candidate),
    light: quotaLight(candidate, resolution.linkState)
  };
}

function publicCandidate(candidate) {
  return {
    provider: candidate.provider,
    accountKey: candidate.accountKey,
    accountEmailHash: candidate.accountEmailHash,
    maskedEmail: candidate.maskedEmail,
    accountLabel: candidate.accountLabel,
    status: candidate.status,
    stale: candidate.stale,
    updatedAt: candidate.updatedAt,
    sourceDeviceId: candidate.sourceDeviceId
  };
}

function enrichOccupancyWithLimits(snapshot, stats) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const candidates = collectQuotaCandidates(stats);
  const accounts = (Array.isArray(snapshot.accounts) ? snapshot.accounts : []).map((account) => ({
    ...account,
    quota: presentQuota(resolveQuotaLink(account.quotaLink, candidates))
  }));
  return { ...snapshot, quotaIntegration: true, quotaCandidates: candidates.map(publicCandidate), accounts };
}

module.exports = {
  accountEmailHash,
  collectQuotaCandidates,
  enrichOccupancyWithLimits,
  maskEmail,
  minimumRemainingPercent,
  normalizeQuotaLink,
  quotaLight,
  resolveQuotaLink
};
