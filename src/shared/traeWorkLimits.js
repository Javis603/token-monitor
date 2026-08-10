'use strict';

// Trae Work (字节跳动 trae.cn) credits limits provider.
//
// Credits balance comes from the endpoint used by the TRAE SOLO / Trae Work
// clients (also verified by the traework2api open-source project):
//   POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage
// with Authorization: Cloud-IDE-JWT <accessToken> and X-User-Region: CN.
//
// Credentials are entered manually in Settings (same pattern as the Qoder
// cookie provider). The accessToken can be obtained from a Trae Work login
// session (e.g. via the login flow documented by traework2api) and pasted in.

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');
const { BROWSER_USER_AGENT } = require('./browserUserAgent');

const TRAEWORK_FETCH_TIMEOUT_MS = 12_000;
const TRAEWORK_API_ORIGIN = 'https://api.trae.cn';
const TRAEWORK_ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';
const TRAEWORK_USER_REGION = 'CN';

function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function traeWorkAccessToken(env = process.env, options = {}) {
  const explicit = cleanSecret(options.traeWorkAccessToken);
  if (explicit) return explicit;
  for (const name of ['TRAEWORK_ACCESS_TOKEN', 'TOKEN_MONITOR_TRAEWORK_ACCESS_TOKEN']) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function traeWorkDeviceId(env = process.env, options = {}) {
  const explicit = cleanSecret(options.traeWorkDeviceId);
  if (explicit) return explicit;
  for (const name of ['TRAEWORK_DEVICE_ID', 'TOKEN_MONITOR_TRAEWORK_DEVICE_ID']) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function traeWorkEntUsageUrl() {
  return `${TRAEWORK_API_ORIGIN}${TRAEWORK_ENT_USAGE_PATH}`;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function read(obj, camel, snake) {
  return obj?.[camel] ?? obj?.[snake];
}

function parseTraeWorkEntUsage(body) {
  const packs = Array.isArray(body?.user_entitlement_pack_list)
    ? body.user_entitlement_pack_list
    : Array.isArray(body?.UserEntitlementPackList)
      ? body.UserEntitlementPackList
      : [];
  let total = 0;
  let used = 0;
  let packCount = 0;
  for (const pack of packs) {
    if (!pack || typeof pack !== 'object') continue;
    const limit = numberOrNull(pack?.entitlement_base_info?.quota?.credits_limit)
      ?? numberOrNull(pack?.entitlementBaseInfo?.quota?.creditsLimit);
    if (limit === null || limit <= 0) continue;
    const usedAmount = numberOrNull(pack?.usage?.credits_amount)
      ?? numberOrNull(pack?.usage?.creditsAmount)
      ?? 0;
    total += limit;
    used += usedAmount;
    packCount += 1;
  }
  if (packCount === 0) throw new Error('no usable credit packs');
  const remaining = Math.max(0, total - used);
  const usedPercent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return {
    window: {
      kind: 'billing',
      label: 'Credits',
      used: Math.max(0, used),
      limit: total,
      remaining,
      usedPercent: Math.max(0, usedPercent),
      remainingPercent: Math.max(0, 100 - usedPercent),
      showMeter: true
    },
    packCount
  };
}

function fetchJsonWithDeadline(url, init, deps = {}) {
  const deadlineMs = Number(deps.traeWorkFetchTimeoutMs || deps.fetchTimeoutMs || TRAEWORK_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (deps.fetch || fetch)(url, { ...init, signal });
      const body = response.ok ? await response.json() : null;
      return { response, body };
    },
    { signal: deps.signal, deadlineMs }
  );
}

async function fetchTraeWorkLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const accessToken = traeWorkAccessToken(env, options);
  if (!accessToken) {
    return normalizeLimitProvider({
      provider: 'traework',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }
  const deviceId = traeWorkDeviceId(env, options);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Cloud-IDE-JWT ${accessToken}`,
    'X-User-Region': TRAEWORK_USER_REGION,
    'User-Agent': BROWSER_USER_AGENT,
    ...(deviceId ? { 'X-Device-Id': deviceId } : {})
  };
  try {
    const { response, body } = await fetchJsonWithDeadline(traeWorkEntUsageUrl(), {
      method: 'POST',
      headers,
      body: '{}'
    }, deps);
    if (!response.ok) {
      const error = new Error(`Trae Work usage returned ${response.status}`);
      error.status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw error;
    }
    const { window, packCount } = parseTraeWorkEntUsage(body);
    return normalizeLimitProvider({
      provider: 'traework',
      accountKey: hashKey('traework', accessToken),
      accountLabel: '',
      source: 'api',
      status: 'ok',
      updatedAt,
      windows: [window]
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'traework',
      source: 'api',
      status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable',
      updatedAt,
      windows: []
    });
  }
}

module.exports = {
  TRAEWORK_FETCH_TIMEOUT_MS,
  TRAEWORK_API_ORIGIN,
  traeWorkAccessToken,
  traeWorkDeviceId,
  traeWorkEntUsageUrl,
  parseTraeWorkEntUsage,
  fetchTraeWorkLimits
};
