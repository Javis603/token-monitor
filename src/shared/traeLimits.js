'use strict';

const { BROWSER_USER_AGENT } = require('./browserUserAgent');
const { hashKey } = require('./hashKey');
const { normalizeLimitProvider } = require('./limits');
const { runWithProbeDeadline } = require('./probeDeadline');

const TRAE_FETCH_TIMEOUT_MS = 12_000;
const TRAE_API_ORIGIN = 'https://api.trae.cn';
const TRAE_ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';

function cleanSecret(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return /[\r\n]/.test(raw) ? '' : raw;
}

function firstSetting(options, env, settingName, envNames) {
  const explicit = cleanSecret(options?.[settingName]);
  if (explicit) return explicit;
  for (const name of envNames) {
    const value = cleanSecret(env?.[name]);
    if (value) return value;
  }
  return '';
}

function traeAccessToken(env = process.env, options = {}) {
  return firstSetting(options, env, 'traeAccessToken', [
    'TOKEN_MONITOR_TRAE_ACCESS_TOKEN',
    'TRAE_ACCESS_TOKEN'
  ])
    .replace(/^authorization\s*:\s*/i, '')
    .replace(/^cloud-ide-jwt\s+/i, '')
    .trim();
}

function traeDeviceId(env = process.env, options = {}) {
  return firstSetting(options, env, 'traeDeviceId', [
    'TOKEN_MONITOR_TRAE_DEVICE_ID',
    'TRAE_DEVICE_ID'
  ]);
}

function traeEntUsageUrl() {
  return `${TRAE_API_ORIGIN}${TRAE_ENT_USAGE_PATH}`;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function entitlementPacks(body) {
  if (Array.isArray(body?.user_entitlement_pack_list)) return body.user_entitlement_pack_list;
  if (Array.isArray(body?.userEntitlementPackList)) return body.userEntitlementPackList;
  throw new Error('Trae credits response has no entitlement pack list');
}

function parseTraeEntUsage(body) {
  const packs = entitlementPacks(body);
  let limit = 0;
  let used = 0;
  let activePackCount = 0;

  for (const pack of packs) {
    const rawLimit = pack?.entitlement_base_info?.quota?.credits_limit
      ?? pack?.entitlementBaseInfo?.quota?.creditsLimit;
    const rawUsed = pack?.usage?.credits_amount ?? pack?.usage?.creditsAmount;
    const packLimit = numberOrNull(rawLimit);
    const packUsed = numberOrNull(rawUsed);

    // Zero-limit rows do not contribute to the spendable balance. Any other
    // unusable row makes a partial aggregate unsafe to publish.
    if (packLimit === 0 && packUsed === 0) continue;
    activePackCount += 1;
    if (packLimit === null || packUsed === null || packLimit <= 0 || packUsed < 0) {
      throw new Error('Trae credits response contains an unusable active entitlement pack');
    }
    limit += packLimit;
    used += packUsed;
  }

  if (activePackCount === 0) throw new Error('Trae credits response has no usable entitlement packs');
  // Preserve reported usage even when it exceeds an individual pack or the
  // aggregate limit. Present the spendable balance as exhausted rather than
  // treating an otherwise numeric response as unavailable.
  const remaining = Math.max(0, limit - used);
  const usedPercent = Math.min(100, (used / limit) * 100);
  return {
    packCount: activePackCount,
    window: {
      kind: 'billing',
      label: 'Credits',
      metric: 'credits',
      currency: 'CREDITS',
      used,
      limit,
      remaining,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: null,
      showMeter: true
    }
  };
}

function fetchJsonWithDeadline(url, init, deps = {}) {
  const deadlineMs = Number(deps.traeFetchTimeoutMs || deps.fetchTimeoutMs || TRAE_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (deps.fetch || fetch)(url, { ...init, signal });
      const body = response.ok ? await response.json() : null;
      return { response, body };
    },
    { signal: deps.signal, deadlineMs }
  );
}

async function fetchTraeLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  const accessToken = traeAccessToken(env, options);
  if (!accessToken) {
    return normalizeLimitProvider({
      provider: 'trae',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: [],
      region: 'cn'
    });
  }

  const deviceId = traeDeviceId(env, options);
  try {
    const { response, body } = await fetchJsonWithDeadline(traeEntUsageUrl(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Cloud-IDE-JWT ${accessToken}`,
        'X-User-Region': 'CN',
        'User-Agent': BROWSER_USER_AGENT,
        ...(deviceId ? { 'X-Device-Id': deviceId } : {})
      },
      body: '{}',
      redirect: 'error',
      credentials: 'omit'
    }, deps);
    if (!response.ok) {
      const error = new Error(`Trae credits request returned ${response.status}`);
      error.status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw error;
    }
    const { window } = parseTraeEntUsage(body);
    return normalizeLimitProvider({
      provider: 'trae',
      accountKey: hashKey('trae', accessToken),
      source: 'api',
      status: 'ok',
      updatedAt,
      windows: [window],
      balance: {
        amount: window.remaining,
        currency: 'CREDITS'
      },
      region: 'cn'
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'trae',
      source: 'api',
      status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable',
      updatedAt,
      windows: [],
      region: 'cn'
    });
  }
}

module.exports = {
  TRAE_API_ORIGIN,
  TRAE_FETCH_TIMEOUT_MS,
  fetchTraeLimits,
  parseTraeEntUsage,
  traeAccessToken,
  traeDeviceId,
  traeEntUsageUrl
};
