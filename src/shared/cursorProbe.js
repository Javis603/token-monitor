'use strict';

const https = require('node:https');
const { abortError } = require('./probeDeadline');

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const AUTH_ME_URL = 'https://cursor.com/api/auth/me';
const REQUEST_USAGE_URL = 'https://cursor.com/api/usage';

const DEFAULT_HEADERS = {
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.cursor.com/settings',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

function clampPercent(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function centsToUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(value) / 100;
}

function percentFromUsedLimit(used, limit) {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  return clampPercent((used / limit) * 100);
}

function hasAnyNumber(...values) {
  return values.some((value) => typeof value === 'number' && Number.isFinite(value));
}

function parseRequestUsage(input) {
  const usage = input && typeof input === 'object' ? input : {};
  const gpt4 = usage['gpt-4'] || usage.gpt4 || {};
  const requestsUsed = numberOrNull(gpt4.numRequestsTotal) ?? numberOrNull(gpt4.numRequests);
  const requestsLimit = numberOrNull(gpt4.maxRequestUsage);
  return {
    requestsUsed,
    requestsLimit
  };
}

function parseUsageSummary(input, { requestUsage = null } = {}) {
  const summary = input && typeof input === 'object' ? input : {};
  const individual = summary.individualUsage && typeof summary.individualUsage === 'object' ? summary.individualUsage : {};
  const plan = individual.plan && typeof individual.plan === 'object' ? individual.plan : {};
  const onDemand = individual.onDemand && typeof individual.onDemand === 'object' ? individual.onDemand : {};
  const overall = individual.overall && typeof individual.overall === 'object' ? individual.overall : {};
  const team = summary.teamUsage && typeof summary.teamUsage === 'object' ? summary.teamUsage : {};
  const teamOnDemand = team.onDemand && typeof team.onDemand === 'object' ? team.onDemand : {};
  const teamPooled = team.pooled && typeof team.pooled === 'object' ? team.pooled : {};
  const planUsed = numberOrNull(plan.used) ?? 0;
  const planLimit = numberOrNull(plan.limit) ?? 0;
  const overallUsed = numberOrNull(overall.used);
  const overallLimit = numberOrNull(overall.limit);
  const overallRemaining = numberOrNull(overall.remaining);
  const autoPercent = clampPercent(numberOrNull(plan.autoPercentUsed));
  const apiPercent = clampPercent(numberOrNull(plan.apiPercentUsed));
  const onDemandUsed = numberOrNull(onDemand.used) ?? 0;
  const onDemandLimit = numberOrNull(onDemand.limit);
  const onDemandRemaining = numberOrNull(onDemand.remaining);
  const teamOnDemandUsed = numberOrNull(teamOnDemand.used);
  const teamOnDemandLimit = numberOrNull(teamOnDemand.limit);
  const teamOnDemandRemaining = numberOrNull(teamOnDemand.remaining);
  const teamPooledUsed = numberOrNull(teamPooled.used);
  const teamPooledLimit = numberOrNull(teamPooled.limit);
  const teamPooledRemaining = numberOrNull(teamPooled.remaining);

  let planPercent = clampPercent(numberOrNull(plan.totalPercentUsed));
  if (planPercent === null) {
    if (autoPercent !== null && apiPercent !== null) planPercent = clampPercent((autoPercent + apiPercent) / 2);
    else if (apiPercent !== null) planPercent = apiPercent;
    else if (autoPercent !== null) planPercent = autoPercent;
    else if (planLimit > 0) planPercent = percentFromUsedLimit(planUsed, planLimit);
    else if (overallLimit !== null && overallLimit > 0) planPercent = percentFromUsedLimit(overallUsed, overallLimit);
    else if (teamPooledLimit !== null && teamPooledLimit > 0) planPercent = percentFromUsedLimit(teamPooledUsed, teamPooledLimit);
    else planPercent = 0;
  }

  let resolvedPlanUsed = planUsed;
  let resolvedPlanLimit = planLimit;
  let resolvedPlanRemaining = plan.remaining === undefined ? null : numberOrNull(plan.remaining);
  if (resolvedPlanLimit <= 0 && resolvedPlanUsed <= 0) {
    if (overallUsed !== null && overallLimit !== null) {
      resolvedPlanUsed = overallUsed;
      resolvedPlanLimit = overallLimit;
      resolvedPlanRemaining = overallRemaining;
    } else if (teamPooledUsed !== null && teamPooledLimit !== null) {
      resolvedPlanUsed = teamPooledUsed;
      resolvedPlanLimit = teamPooledLimit;
      resolvedPlanRemaining = teamPooledRemaining;
    }
  }

  const parsedRequestUsage = parseRequestUsage(requestUsage);
  return {
    planPercent,
    autoPercent,
    apiPercent,
    planUsedUsd: centsToUsd(resolvedPlanUsed),
    planLimitUsd: centsToUsd(resolvedPlanLimit),
    planRemainingUsd: resolvedPlanRemaining === null ? null : centsToUsd(resolvedPlanRemaining),
    onDemandPercent: percentFromUsedLimit(onDemandUsed, onDemandLimit),
    onDemandUsedUsd: centsToUsd(onDemandUsed),
    onDemandLimitUsd: onDemandLimit === null ? null : centsToUsd(onDemandLimit),
    onDemandRemainingUsd: onDemandRemaining === null ? null : centsToUsd(onDemandRemaining),
    teamOnDemandPercent: percentFromUsedLimit(teamOnDemandUsed, teamOnDemandLimit),
    teamOnDemandUsedUsd: teamOnDemandUsed === null ? null : centsToUsd(teamOnDemandUsed),
    teamOnDemandLimitUsd: teamOnDemandLimit === null ? null : centsToUsd(teamOnDemandLimit),
    teamOnDemandRemainingUsd: teamOnDemandRemaining === null ? null : centsToUsd(teamOnDemandRemaining),
    teamPooledPercent: percentFromUsedLimit(teamPooledUsed, teamPooledLimit),
    teamPooledUsedUsd: teamPooledUsed === null ? null : centsToUsd(teamPooledUsed),
    teamPooledLimitUsd: teamPooledLimit === null ? null : centsToUsd(teamPooledLimit),
    teamPooledRemainingUsd: teamPooledRemaining === null ? null : centsToUsd(teamPooledRemaining),
    billingCycleEnd: typeof summary.billingCycleEnd === 'string' ? summary.billingCycleEnd : null,
    membershipType: typeof summary.membershipType === 'string' ? summary.membershipType : null,
    limitType: typeof summary.limitType === 'string' ? summary.limitType : null,
    isUnlimited: typeof summary.isUnlimited === 'boolean' ? summary.isUnlimited : false,
    hasPlanUsage: hasAnyNumber(plan.used, plan.limit, plan.remaining, plan.totalPercentUsed, plan.autoPercentUsed, plan.apiPercentUsed),
    hasOverallUsage: Boolean(overall && typeof overall === 'object' && hasAnyNumber(overall.used, overall.limit, overall.remaining)),
    hasOnDemandUsage: Boolean(onDemand && typeof onDemand === 'object' && hasAnyNumber(onDemand.used, onDemand.limit, onDemand.remaining)),
    hasTeamOnDemandUsage: Boolean(teamOnDemand && typeof teamOnDemand === 'object' && hasAnyNumber(teamOnDemand.used, teamOnDemand.limit, teamOnDemand.remaining)),
    hasTeamPooledUsage: Boolean(teamPooled && typeof teamPooled === 'object' && hasAnyNumber(teamPooled.used, teamPooled.limit, teamPooled.remaining)),
    ...parsedRequestUsage
  };
}

function parseUserInfo(input) {
  const info = input && typeof input === 'object' ? input : {};
  return {
    email: typeof info.email === 'string' ? info.email : null,
    name: typeof info.name === 'string' ? info.name : null,
    sub: typeof info.sub === 'string' ? info.sub : null
  };
}

function requestJson(url, sessionToken, { timeoutMs = 15000, httpsLib = https, signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve) => {
    const parsed = new URL(url);
    let settled = false;
    let req = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      const error = abortError(signal);
      try { req?.destroy?.(error); } catch (_) {}
      finish({ ok: false, error: { kind: 'network', message: error.message } });
    };
    req = httpsLib.request({
      method: 'GET',
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        ...DEFAULT_HEADERS,
        'Cookie': `WorkosCursorSessionToken=${sessionToken}`
      }
    }, (res) => {
      // Short-circuit on auth failures so we don't depend on the response stream emitting 'end'.
      if (res.statusCode === 401 || res.statusCode === 403) {
        return finish({ ok: false, error: { kind: 'unauthorized', message: `HTTP ${res.statusCode}` } });
      }
      if (typeof res.statusCode !== 'number' || res.statusCode < 200 || res.statusCode >= 300) {
        return finish({ ok: false, error: { kind: 'network', message: `HTTP ${res.statusCode}` } });
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString('utf8'); });
      res.on('end', () => {
        try {
          finish({ ok: true, json: JSON.parse(body) });
        } catch (err) {
          finish({ ok: false, error: { kind: 'parse', message: err.message } });
        }
      });
      res.on('error', (err) => finish({ ok: false, error: { kind: 'network', message: err.message } }));
    });
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timeout after ${timeoutMs}ms`));
      });
    }
    req.on('error', (err) => finish({ ok: false, error: { kind: 'network', message: err.message } }));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    req.end();
  });
}

async function probe(sessionToken, opts = {}) {
  if (!sessionToken) return { ok: false, error: { kind: 'unauthorized', message: 'no session token' } };
  const [usageResult, userResult] = await Promise.all([
    requestJson(USAGE_SUMMARY_URL, sessionToken, opts),
    requestJson(AUTH_ME_URL, sessionToken, opts)
  ]);
  if (!usageResult.ok) return usageResult;
  const user = userResult.ok ? parseUserInfo(userResult.json) : { email: null, name: null, sub: null };
  let requestUsage = null;
  if (user.sub) {
    const url = `${REQUEST_USAGE_URL}?user=${encodeURIComponent(user.sub)}`;
    const requestUsageResult = await requestJson(url, sessionToken, opts);
    if (requestUsageResult.ok) requestUsage = requestUsageResult.json;
  }
  const usage = parseUsageSummary(usageResult.json, { requestUsage });
  return { ok: true, usage, user };
}

module.exports = {
  parseUsageSummary,
  parseRequestUsage,
  parseUserInfo,
  probe,
  requestJson,
  USAGE_SUMMARY_URL,
  AUTH_ME_URL,
  REQUEST_USAGE_URL
};
