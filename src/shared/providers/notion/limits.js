'use strict';

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { errorWithStatus, statusForHttp } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');

const NOTION_FETCH_TIMEOUT_MS = 12_000;
const NOTION_SPACES_URL = 'https://app.notion.com/api/v3/getSpaces';
const NOTION_ALLOWANCE_URL = 'https://app.notion.com/api/v3/getCreditRateLimitStatus';
const COOKIE_ENV = ['TOKEN_MONITOR_NOTION_COOKIE', 'NOTION_COOKIE'];
const WORKSPACE_ENV = ['TOKEN_MONITOR_NOTION_WORKSPACE_ID', 'NOTION_WORKSPACE_ID'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalUuid(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return '';
  const raw = value.trim().toLowerCase();
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(raw)) return raw;
  if (!/^[a-f0-9]{32}$/u.test(raw)) return '';
  return [raw.slice(0, 8), raw.slice(8, 12), raw.slice(12, 16), raw.slice(16, 20), raw.slice(20)].join('-');
}

function normalizeNotionWorkspaceId(value) {
  if (value === '' || value === undefined || value === null) return '';
  const normalized = canonicalUuid(value);
  if (normalized) return normalized;
  const error = new Error('Notion requires a valid workspace UUID');
  error.code = 'NOTION_WORKSPACE_ID_INVALID';
  throw error;
}

// RFC 6265 cookie-octet: forbid whitespace, quotes, separators and controls.
function isCookieValue(value) {
  return /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/u.test(value);
}

function normalizeNotionCookieHeader(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return '';
  let raw = value.trim();
  if (!raw || /^curl(?:\s|$)/iu.test(raw)) return '';
  const prefixed = /^cookie\s*:/iu.test(raw);
  if (prefixed) raw = raw.replace(/^cookie\s*:/iu, '').trim();
  if (!prefixed && !raw.includes(';') && !raw.startsWith('token_v2=') && !/=.*[^=]/u.test(raw)) {
    return isCookieValue(raw) ? `token_v2=${raw}` : '';
  }
  let token = '';
  for (const part of raw.split(';')) {
    const pair = part.trim();
    const separator = pair.indexOf('=');
    if (separator <= 0) return '';
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || !isCookieValue(cookieValue)) return '';
    if (name === 'token_v2') {
      if (token) return '';
      token = cookieValue;
    }
  }
  return token ? `token_v2=${token}` : '';
}

function configuredValue(env, options, key, names) {
  const explicit = options[key];
  if (explicit !== undefined && explicit !== null && explicit !== '') return explicit;
  for (const name of names) {
    if (env?.[name] !== undefined && env[name] !== null && env[name] !== '') return env[name];
  }
  return '';
}

function notionCookie(env = process.env, options = {}) {
  return normalizeNotionCookieHeader(configuredValue(env, options, 'notionCookie', COOKIE_ENV));
}

function notionWorkspaceId(env = process.env, options = {}) {
  return canonicalUuid(configuredValue(env, options, 'notionWorkspaceId', WORKSPACE_ENV));
}

function invalidResponse() {
  return errorWithStatus('unavailable', 'Notion allowance response is unavailable');
}

// getSpaces wraps record values once or twice. Identity requires corroborating
// table keys and record ids; a supplied email/name is never an identity signal.
function recordValue(record) {
  let value = record;
  for (let depth = 0; depth < 2 && isObject(value) && Object.hasOwn(value, 'value'); depth += 1) {
    value = value.value;
  }
  return isObject(value) ? value : null;
}

function parseNotionSpaces(body, workspaceId) {
  workspaceId = canonicalUuid(workspaceId);
  if (!isObject(body) || !workspaceId) throw invalidResponse();
  const keys = Object.keys(body);
  if (keys.length !== 1) throw invalidResponse();
  const userId = canonicalUuid(keys[0]);
  const container = body[keys[0]];
  if (!userId || !isObject(container) || !isObject(container.notion_user) || !isObject(container.space)) {
    throw invalidResponse();
  }
  const users = Object.entries(container.notion_user)
    .filter(([key]) => canonicalUuid(key) === userId);
  if (users.length !== 1 || canonicalUuid(recordValue(users[0][1])?.id) !== userId) throw invalidResponse();
  const selected = Object.entries(container.space)
    .filter(([key]) => canonicalUuid(key) === workspaceId);
  if (selected.length !== 1) throw invalidResponse();
  const workspace = recordValue(selected[0][1]);
  if (!workspace || canonicalUuid(workspace.id) !== workspaceId) throw invalidResponse();
  const tier = typeof workspace.subscription_tier === 'string' ? workspace.subscription_tier.toLowerCase() : '';
  return {
    accountKey: hashKey('notion', userId + workspaceId),
    planLabel: tier === 'business' ? 'Business' : tier === 'enterprise' ? 'Enterprise' : ''
  };
}

function optionalReset(value, present, minimum = 0) {
  if (!present) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw invalidResponse();
  return value;
}

function resetIso(ms) {
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) throw invalidResponse();
  return new Date(ms).toISOString();
}

function parseAllowanceWindow(raw, rolling, resets, nowMs) {
  if (raw === undefined) return null;
  if (!isObject(raw)
    || raw.creditType !== 'basic_ai_credits'
    || raw.scope !== 'per_user'
    || typeof raw.used !== 'number' || !Number.isFinite(raw.used) || raw.used < 0
    || typeof raw.limit !== 'number' || !Number.isFinite(raw.limit) || raw.limit <= 0
    || (rolling ? raw.window !== '6h' : raw.cadence !== 'billing_period')
  ) throw invalidResponse();
  const usedPercent = raw.used / raw.limit * 100;
  if (!Number.isFinite(usedPercent)) throw invalidResponse();
  const end = optionalReset(raw.periodEndMs, Object.hasOwn(raw, 'periodEndMs'), Number.MIN_VALUE);
  const window = {
    kind: rolling ? 'session' : 'billing',
    label: rolling ? 'Rolling' : 'Monthly',
    used: raw.used,
    limit: raw.limit,
    usedPercent,
    remaining: Math.max(0, raw.limit - raw.used),
    showMeter: true
  };
  if (rolling) {
    if (Object.hasOwn(raw, 'cadence') || end !== null) throw invalidResponse();
    window.windowMinutes = 360;
    if (resets !== null) window.resetsAt = resetIso(nowMs + resets * 1000);
  } else {
    if (Object.hasOwn(raw, 'window')) throw invalidResponse();
    window.resetDescription = 'Monthly';
    if (end !== null) window.resetsAt = resetIso(end);
  }
  return window;
}

function parseNotionAllowance(body, nowMs = Date.now()) {
  if (!isObject(body)) throw invalidResponse();
  if (body.status === 'not_applicable') {
    const error = invalidResponse();
    error.code = 'NOTION_ALLOWANCE_NOT_APPLICABLE';
    throw error;
  }
  // The reference documents within_limit only. Unknown statuses (including
  // possible future quota enforcement states) are schema changes, not HTTP 429.
  if (body.status !== 'within_limit'
    || (Object.hasOwn(body, 'enforcement') && typeof body.enforcement !== 'string')) throw invalidResponse();
  const resets = optionalReset(body.resetsInSeconds, Object.hasOwn(body, 'resetsInSeconds'));
  if (resets !== null) resetIso(nowMs + resets * 1000);
  const windows = [
    parseAllowanceWindow(body.window, true, resets, nowMs),
    parseAllowanceWindow(body.billingPeriodWindow, false, null, nowMs)
  ].filter(Boolean);
  if (!windows.length) throw invalidResponse();
  return { windows };
}

async function fetchNotionLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const nowMs = (deps.now || Date.now)();
  const base = { provider: 'notion', source: 'web', updatedAt: new Date(nowMs).toISOString(), windows: [] };
  const rawCookie = configuredValue(env, options, 'notionCookie', COOKIE_ENV);
  const cookie = notionCookie(env, options);
  const workspaceId = notionWorkspaceId(env, options);
  if (!rawCookie) return normalizeLimitProvider({ ...base, status: 'notConfigured' });
  if (!cookie || !workspaceId) return normalizeLimitProvider({ ...base, status: 'unavailable' });
  let identity = {};
  try {
    const parsed = await runWithProbeDeadline(async ({ signal }) => {
      const post = async (url, body) => {
        if (signal.aborted) throw invalidResponse();
        const response = await (deps.fetch || fetch)(url, {
          method: 'POST',
          headers: { Cookie: cookie, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'omit',
          redirect: 'error',
          signal
        });
        if (signal.aborted) throw invalidResponse();
        if (response.status !== 200) {
          // Match the shared web transport: an explicit anti-bot challenge is
          // a source outage, not evidence that the submitted session expired.
          const sourceChallenge = response.status === 403
            && String(response.headers?.get?.('cf-mitigated') || '').toLowerCase() === 'challenge';
          throw errorWithStatus(sourceChallenge ? 'unavailable' : statusForHttp(response.status), 'Notion request failed');
        }
        return response.json();
      };
      const spaces = await post(NOTION_SPACES_URL, {});
      if (signal.aborted) throw invalidResponse();
      identity = parseNotionSpaces(spaces, workspaceId);
      const usage = await post(NOTION_ALLOWANCE_URL, { spaceId: workspaceId });
      if (signal.aborted) throw invalidResponse();
      return parseNotionAllowance(usage, nowMs);
    }, { signal: deps.signal, deadlineMs: deps.notionFetchTimeoutMs || NOTION_FETCH_TIMEOUT_MS });
    return normalizeLimitProvider({ ...base, ...identity, ...parsed, status: 'ok' });
  } catch (error) {
    // Only statuses created by the HTTP classifier are carried. Transport
    // errors and response text may contain credentials and stay out of the wire.
    const status = ['unauthorized', 'sourceRateLimited'].includes(error?.status) ? error.status : 'unavailable';
    return normalizeLimitProvider({ ...base, ...identity, status });
  }
}

module.exports = {
  NOTION_FETCH_TIMEOUT_MS,
  NOTION_SPACES_URL,
  NOTION_ALLOWANCE_URL,
  fetchNotionLimits,
  normalizeNotionCookieHeader,
  normalizeNotionWorkspaceId,
  notionCookie,
  notionWorkspaceId,
  parseNotionAllowance,
  parseNotionSpaces
};
