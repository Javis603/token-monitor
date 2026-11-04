'use strict';

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { errorWithStatus, planLabelFromParts } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');

const OPENDESIGN_API = 'https://amr-api.open-design.ai/api/v1/workspaces/';

// The session is opaque: accept a complete Cookie header rather than guessing
// a token name or forwarding a cookie from a different website host.
function normalizeOpendesignCookieHeader(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return '';
  const raw = value.trim().replace(/^cookie\s*:\s*/iu, '');
  if (!raw) return '';
  const names = new Set();
  for (const pair of raw.split(';')) {
    const match = pair.trim().match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/u);
    if (!match || names.has(match[1])) return '';
    names.add(match[1]);
  }
  return raw;
}

function opendesignCookie(env = process.env, options = {}) {
  return normalizeOpendesignCookieHeader(options.opendesignCookie
    || env.TOKEN_MONITOR_OPENDESIGN_COOKIE || env.OPENDESIGN_COOKIE || '');
}

function invalidResponse() {
  return errorWithStatus('unavailable', 'OpenDesign subscription usage is unavailable');
}

function credits(value) {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/u.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw invalidResponse();
  }
  return value;
}

function parseOpendesignUsage(usage, workspaceId) {
  if (usage?.workspaceId !== workspaceId || usage.eligible !== true || !Array.isArray(usage.windows)) {
    throw invalidResponse();
  }
  const windows = [];
  for (const [seconds, kind, label] of [[18000, 'session', 'Session'], [604800, 'weekly', 'Weekly']]) {
    const matches = usage.windows.filter((window) => window?.durationSeconds === seconds);
    if (!matches.length) continue;
    if (matches.length !== 1) throw invalidResponse();
    const raw = matches[0];
    const used = credits(raw.usedCredits);
    const limit = credits(raw.limitCredits);
    const usedPercent = used / limit * 100;
    if (limit <= 0 || !Number.isFinite(usedPercent)) throw invalidResponse();
    const reset = typeof raw.resetsAt === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(raw.resetsAt)
      && Number.isFinite(Date.parse(raw.resetsAt)) ? raw.resetsAt : null;
    // Subscription credits are allowance units, not a monetary balance. Do not
    // set metric: 'credits', which opts into the money/balance display contract.
    windows.push({ kind, label, used, limit, remaining: Math.max(0, limit - used), usedPercent,
      windowMinutes: seconds / 60, resetsAt: reset, showMeter: true });
  }
  if (!windows.length) throw invalidResponse();
  return windows;
}

async function fetchOpendesignLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const base = { provider: 'opendesign', source: 'web', windows: [],
    updatedAt: new Date((deps.now || Date.now)()).toISOString() };
  const raw = options.opendesignCookie || env.TOKEN_MONITOR_OPENDESIGN_COOKIE || env.OPENDESIGN_COOKIE;
  if (!raw) return normalizeLimitProvider({ ...base, status: 'notConfigured' });
  const cookie = opendesignCookie(env, options);
  if (!cookie) return normalizeLimitProvider({ ...base, status: 'unavailable' });
  let identity = {};
  try {
    const windows = await runWithProbeDeadline(async ({ signal }) => {
      const get = async (path, workspaceId) => {
        if (signal.aborted) throw invalidResponse();
        const response = await (deps.fetch || fetch)(OPENDESIGN_API + path, {
          method: 'GET', credentials: 'omit', redirect: 'error', signal,
          headers: { Accept: 'application/json', Cookie: cookie,
            ...(workspaceId ? { 'X-Vela-Workspace-Id': workspaceId } : {}) }
        });
        if (signal.aborted) throw invalidResponse();
        if (response.status !== 200) {
          // A denied billing permission does not prove that a session expired.
          throw errorWithStatus(response.status === 401 ? 'unauthorized'
            : response.status === 429 ? 'sourceRateLimited' : 'unavailable', 'OpenDesign request failed');
        }
        return response.json();
      };
      const workspace = await get('current');
      const id = workspace?.workspaceId;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw invalidResponse();
      identity = { accountKey: hashKey('opendesign', id), accountName: workspace.workspaceName };
      const usage = await get(`${id}/billing/coding-plan-usage`, id);
      if (signal.aborted) throw invalidResponse();
      const parsed = parseOpendesignUsage(usage, id);
      identity.planLabel = planLabelFromParts(
        typeof usage.tier === 'string' ? usage.tier : '',
        typeof workspace.personalMembershipTier === 'string' ? workspace.personalMembershipTier : ''
      );
      return parsed;
    }, { signal: deps.signal, deadlineMs: deps.opendesignFetchTimeoutMs || 12000 });
    return normalizeLimitProvider({ ...base, ...identity, windows, status: 'ok' });
  } catch (error) {
    const status = ['unauthorized', 'sourceRateLimited'].includes(error?.status) ? error.status : 'unavailable';
    return normalizeLimitProvider({ ...base, ...identity, status });
  }
}

module.exports = { OPENDESIGN_API, fetchOpendesignLimits, normalizeOpendesignCookieHeader,
  opendesignCookie, parseOpendesignUsage };
