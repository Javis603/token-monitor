'use strict';

const crypto = require('node:crypto');
const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');

const VOLCENGINE_FETCH_TIMEOUT_MS = 12_000;

const VOLCENGINE_CODING_PLAN_URL = 'https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01';
const VOLCENGINE_AGENT_PLAN_URL = 'https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01';
const VOLCENGINE_ARK_CHAT_COMPLETIONS_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions';
const VOLCENGINE_DEFAULT_REGION = 'cn-beijing';
const VOLCENGINE_SESSION_WINDOW_MINUTES = 5 * 60;
const VOLCENGINE_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const VOLCENGINE_MONTHLY_WINDOW_MINUTES = 30 * 24 * 60;
const VOLCENGINE_SERVICE = 'ark';
const VOLCENGINE_SIGNED_HEADERS = 'content-type;host;x-content-sha256;x-date';
const VOLCENGINE_ARK_PROBE_MODELS = [
  'doubao-seed-2.0-code',
  'doubao-1.5-pro-32k',
  'doubao-lite-32k'
];

function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function pickFirst(env, names) {
  for (const name of names) {
    const value = cleanSecret(env[name]);
    if (value) return value;
  }
  return '';
}

function isVolcengineAccessKeyId(value) {
  return /^AKLT/i.test(String(value || '').trim());
}

function volcengineCredentials(env = process.env, options = {}) {
  const inputKey = cleanSecret(options.volcengineAccessKeyId);
  const secretAccessKey = cleanSecret(options.volcengineSecretAccessKey)
    || pickFirst(env, [
      'VOLCENGINE_SECRET_ACCESS_KEY',
      'VOLCENGINE_SECRET_KEY',
      'VOLCENGINE_ACCESS_KEY_SECRET',
      'VOLC_SECRETKEY',
      'VOLC_SECRET_ACCESS_KEY',
      'DOUBAO_SECRET_ACCESS_KEY'
    ]);
  const region = cleanSecret(options.volcengineRegion)
    || pickFirst(env, ['VOLCENGINE_REGION', 'VOLCENGINE_REGION_ID', 'VOLC_REGION', 'DOUBAO_REGION'])
    || VOLCENGINE_DEFAULT_REGION;
  const envAccessKeyId = pickFirst(env, [
    'VOLCENGINE_ACCESS_KEY_ID',
    'VOLCENGINE_ACCESS_KEY',
    'VOLC_ACCESSKEY',
    'VOLC_ACCESS_KEY_ID',
    'DOUBAO_ACCESS_KEY_ID'
  ]);
  const envApiKey = pickFirst(env, ['ARK_API_KEY', 'VOLCENGINE_API_KEY', 'DOUBAO_API_KEY']);
  const combinedKey = inputKey || envAccessKeyId;
  if (combinedKey && !isVolcengineAccessKeyId(combinedKey)) return { mode: 'ark', apiKey: combinedKey, region };
  const accessKeyId = combinedKey;
  const apiKey = envApiKey;
  if (accessKeyId && secretAccessKey) {
    return {
      mode: 'signed',
      accessKeyId,
      secretAccessKey,
      apiKey,
      region
    };
  }
  if (apiKey) return { mode: 'ark', apiKey, region };
  return null;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampPercent(value) {
  const parsed = numberOrNull(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(100, parsed));
}

function epochToIso(value) {
  const parsed = numberOrNull(value);
  if (parsed === null || parsed <= 0) return null;
  const date = new Date(parsed < 20_000_000_000 ? parsed * 1000 : parsed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resetHeaderToIso(value, now = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const absolute = epochToIso(raw);
  if (absolute) return absolute;
  const isoDate = new Date(raw);
  if (!Number.isNaN(isoDate.getTime())) return isoDate.toISOString();
  let seconds = 0;
  for (const match of raw.toLowerCase().matchAll(/(\d+(?:\.\d+)?)([dhms])/g)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) continue;
    if (match[2] === 'd') seconds += amount * 86400;
    if (match[2] === 'h') seconds += amount * 3600;
    if (match[2] === 'm') seconds += amount * 60;
    if (match[2] === 's') seconds += amount;
  }
  if (seconds > 0) return new Date(now + (seconds * 1000)).toISOString();
  const relativeSeconds = Number(raw);
  if (Number.isFinite(relativeSeconds) && relativeSeconds > 0) {
    return new Date(now + (relativeSeconds * 1000)).toISOString();
  }
  return null;
}

function quotaWindow(quota) {
  const level = String(quota?.Level ?? quota?.level ?? '').trim().toLowerCase();
  const usedPercent = clampPercent(quota?.Percent ?? quota?.percent);
  if (usedPercent === null) return null;
  const resetsAt = epochToIso(quota?.ResetTimestamp ?? quota?.resetTimestamp ?? quota?.reset_time);
  if (['session', '5-hour', 'five_hour', '5h'].includes(level)) {
    return {
      kind: 'session',
      label: '5-hour',
      usedPercent,
      remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
      resetsAt,
      windowMinutes: VOLCENGINE_SESSION_WINDOW_MINUTES,
      showMeter: true
    };
  }
  if (['weekly', 'week'].includes(level)) {
    return {
      kind: 'weekly',
      label: 'Weekly',
      usedPercent,
      remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
      resetsAt,
      windowMinutes: VOLCENGINE_WEEKLY_WINDOW_MINUTES,
      showMeter: true
    };
  }
  if (['monthly', 'month'].includes(level)) {
    return {
      kind: 'billing',
      label: 'Monthly',
      usedPercent,
      remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
      resetsAt,
      windowMinutes: VOLCENGINE_MONTHLY_WINDOW_MINUTES,
      showMeter: true
    };
  }
  return null;
}

function displayPlanText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^PLAN_TIER_/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bAi\b/g, 'AI');
}

function volcenginePlanLabel(result) {
  for (const field of ['PlanName', 'planName', 'PlanTier', 'planTier', 'ProductName', 'productName', 'PackageName', 'packageName']) {
    const label = displayPlanText(result?.[field]);
    if (label) return label;
  }
  return '';
}

function parseVolcengineCodingPlanUsage(body) {
  const result = body?.Result || body?.result || {};
  const quotas = Array.isArray(result.QuotaUsage || result.quotaUsage) ? (result.QuotaUsage || result.quotaUsage) : [];
  return {
    status: String(result.Status || result.status || '').trim(),
    plan: volcenginePlanLabel(result),
    updatedAt: epochToIso(result.UpdateTimestamp ?? result.updateTimestamp),
    windows: quotas.map(quotaWindow).filter(Boolean)
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return String(value || '').trim();
  }
  return '';
}

function parseVolcengineArkUsage({ headers, body = null, now = Date.now() }) {
  const remaining = numberOrNull(headerValue(headers, 'x-ratelimit-remaining-requests'));
  const limit = numberOrNull(headerValue(headers, 'x-ratelimit-limit-requests'));
  const reset = resetHeaderToIso(headerValue(headers, 'x-ratelimit-reset-requests'), now);
  if (remaining !== null && limit !== null && limit > 0) {
    return {
      updatedAt: new Date(now).toISOString(),
      windows: [{
        kind: 'session',
        label: 'Requests',
        used: Math.max(0, limit - Math.max(0, remaining)),
        limit,
        remaining: Math.max(0, remaining),
        resetsAt: reset,
        windowMinutes: null,
        showMeter: true
      }]
    };
  }
  const totalTokens = numberOrNull(body?.usage?.total_tokens ?? body?.usage?.totalTokens);
  if (totalTokens !== null) {
    return {
      updatedAt: new Date(now).toISOString(),
      windows: [{
        kind: 'session',
        label: 'Requests',
        used: totalTokens,
        limit: null,
        remaining: null,
        resetsAt: reset,
        windowMinutes: null,
        showMeter: false
      }]
    };
  }
  return { updatedAt: new Date(now).toISOString(), windows: [] };
}

function isAmbiguousVolcengineArkExhausted(responseStatus, usage) {
  if (responseStatus !== 200) return false;
  const window = usage?.windows?.[0];
  return window?.showMeter !== false
    && Number(window?.limit) > 0
    && Number(window?.remaining) === 0;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest();
}

function hmacHex(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

function formatUtc(date, pattern) {
  const d = date instanceof Date ? date : new Date(date);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  if (pattern === 'date') return `${yyyy}${mm}${dd}`;
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function percentEncode(value, encodeSlash = true) {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return encodeSlash ? encoded : encoded.replace(/%2F/g, '/');
}

function canonicalQueryString(url) {
  const pairs = Array.from(url.searchParams.entries()).map(([key, value]) => ({
    key: percentEncode(key),
    value: percentEncode(value)
  }));
  pairs.sort((a, b) => (a.key === b.key ? a.value.localeCompare(b.value) : a.key.localeCompare(b.key)));
  return pairs.map((pair) => `${pair.key}=${pair.value}`).join('&');
}

function signVolcengineRequest({
  url,
  method = 'POST',
  body = '',
  accessKeyId,
  secretAccessKey,
  region = VOLCENGINE_DEFAULT_REGION,
  date = new Date(),
  contentType = 'application/x-www-form-urlencoded; charset=utf-8'
}) {
  const parsedUrl = new URL(url);
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const payloadHash = sha256Hex(payload);
  const timestamp = formatUtc(date);
  const dateStamp = formatUtc(date, 'date');
  const host = parsedUrl.host;
  const canonicalRequest = [
    method,
    percentEncode(parsedUrl.pathname || '/', false),
    canonicalQueryString(parsedUrl),
    `content-type:${contentType}`,
    `host:${host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${timestamp}`,
    '',
    VOLCENGINE_SIGNED_HEADERS,
    payloadHash
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/${VOLCENGINE_SERVICE}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');
  const dateKey = hmac(Buffer.from(secretAccessKey, 'utf8'), dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, VOLCENGINE_SERVICE);
  const signingKey = hmac(serviceKey, 'request');
  const signature = hmacHex(signingKey, stringToSign);
  // `host` stays in the canonical request and in SignedHeaders, but must not be
  // sent as a wire header: every transport derives Host from the URL itself, so
  // it was already redundant under undici (which overrides it), and Chromium
  // rejects the request outright with net::ERR_INVALID_ARGUMENT.
  return {
    body: payload,
    headers: {
      Accept: 'application/json',
      'Content-Type': contentType,
      'X-Date': timestamp,
      'X-Content-Sha256': payloadHash,
      Authorization: `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${VOLCENGINE_SIGNED_HEADERS}, Signature=${signature}`
    }
  };
}

function fetchJsonWithDeadline(url, init, deps = {}) {
  const deadlineMs = Number(deps.volcengineFetchTimeoutMs || deps.fetchTimeoutMs || VOLCENGINE_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (deps.fetch || fetch)(url, { ...init, signal });
      const body = await response.json().catch(() => null);
      return { response, body };
    },
    { signal: deps.signal, deadlineMs }
  );
}

// The Agent Plan and the Coding Plan are two subscriptions that normally sit on
// the SAME Volcengine account, so the Agent credentials are optional and fall
// back to the Coding Plan AK/SK. They only need filling in when the two plans
// were bought on different accounts. GetAFPUsage is OpenAPI-only: a plain Ark
// API key cannot sign it, so an ark-mode credential never reaches this path.
function volcengineAgentCredentials(env = process.env, options = {}) {
  const own = volcengineCredentials({
    VOLCENGINE_ACCESS_KEY_ID: pickFirst(env, ['VOLCENGINE_AGENT_ACCESS_KEY_ID', 'VOLC_AGENT_ACCESS_KEY_ID']),
    VOLCENGINE_SECRET_ACCESS_KEY: pickFirst(env, ['VOLCENGINE_AGENT_SECRET_ACCESS_KEY', 'VOLC_AGENT_SECRET_ACCESS_KEY']),
    VOLCENGINE_REGION: pickFirst(env, ['VOLCENGINE_AGENT_REGION'])
  }, {
    volcengineAccessKeyId: options.volcengineAgentAccessKeyId,
    volcengineSecretAccessKey: options.volcengineAgentSecretAccessKey,
    volcengineRegion: options.volcengineAgentRegion
  });
  // `explicit` records which of the two it is. An inherited key that cannot see
  // an Agent Plan is the normal case and stays silent; a key the user actually
  // typed in is a claim that a second account exists, so its failure is shown.
  if (own && own.mode === 'signed') return { ...own, explicit: true };
  const shared = volcengineCredentials(env, options);
  return shared && shared.mode === 'signed' ? { ...shared, explicit: false } : null;
}

function volcengineAgentAccountKey(credentials) {
  // Distinct from the Coding Plan key so `provider:accountKey` dedupe keeps both
  // rows, and derived from the key actually used so a separate Agent account
  // still gets a stable cross-device identity.
  return hashKey('volcengine', credentials.accessKeyId, credentials.region, 'agent-plan');
}

// Carries the real status on the Agent Plan's own identity. Without its own
// accountKey the runtime would read a bare failure row as the whole provider's
// and smear it onto the Coding Plan row that succeeded.
function volcengineAgentFailureRow(credentials, error, updatedAt) {
  return normalizeLimitProvider({
    provider: 'volcengine',
    accountKey: volcengineAgentAccountKey(credentials),
    accountLabel: 'Agent Plan',
    source: 'api',
    status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable',
    updatedAt,
    windows: [],
    region: credentials.region
  });
}

// GetAFPUsage reports absolute quota (Quota/Used/ResetTime) per window instead
// of the Coding Plan's percentages. AFPDaily is deliberately not mapped: the
// shared limits schema only carries session/weekly/billing, so a daily window
// would be dropped by normalizeWindowKind anyway.
const VOLCENGINE_AGENT_PLAN_WINDOWS = Object.freeze([
  ['AFPFiveHour', 'session', '5-hour', VOLCENGINE_SESSION_WINDOW_MINUTES],
  ['AFPWeekly', 'weekly', 'Weekly', VOLCENGINE_WEEKLY_WINDOW_MINUTES],
  ['AFPMonthly', 'billing', 'Monthly', VOLCENGINE_MONTHLY_WINDOW_MINUTES]
]);

function volcengineAgentPlanLabel(result) {
  for (const field of ['PlanType', 'planType', 'PlanName', 'planName', 'ProductName', 'productName']) {
    const label = displayPlanText(result?.[field]);
    if (label) return label;
  }
  return '';
}

function parseVolcengineAgentPlanUsage(body) {
  const result = body?.Result || body?.result || {};
  const windows = [];
  for (const [field, kind, label, windowMinutes] of VOLCENGINE_AGENT_PLAN_WINDOWS) {
    const window = result[field] || result[field.toLowerCase()];
    // Quota <= 0 means this plan tier does not include the window at all.
    const quota = numberOrNull(window?.Quota ?? window?.quota);
    if (quota === null || quota <= 0) continue;
    const used = numberOrNull(window?.Used ?? window?.used);
    const usedPercent = used === null ? null : clampPercent((used / quota) * 100);
    windows.push({
      kind,
      label,
      used,
      limit: quota,
      remaining: used === null ? null : Math.max(0, quota - used),
      usedPercent,
      resetsAt: epochToIso(window?.ResetTime ?? window?.resetTime ?? window?.resetTimestamp),
      windowMinutes,
      showMeter: usedPercent !== null
    });
  }
  return { plan: volcengineAgentPlanLabel(result), windows };
}

// Returns null rather than an error row when the account has no Agent Plan, so
// Coding-Plan-only users do not grow a permanently failing second row.
async function fetchVolcengineAgentPlanLimits(credentials, deps, now, updatedAt) {
  const signed = signVolcengineRequest({
    url: VOLCENGINE_AGENT_PLAN_URL,
    method: 'POST',
    body: '',
    date: new Date(now),
    ...credentials
  });
  const { response, body } = await fetchJsonWithDeadline(VOLCENGINE_AGENT_PLAN_URL, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body
  }, deps);
  if (!response.ok) {
    const error = new Error(`Volcengine Agent Plan returned ${response.status}`);
    error.status = response.status === 401 || response.status === 403
      ? 'unauthorized'
      : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
    throw error;
  }
  const usage = parseVolcengineAgentPlanUsage(body);
  if (!usage.windows.length) return null;
  return normalizeLimitProvider({
    provider: 'volcengine',
    accountKey: volcengineAgentAccountKey(credentials),
    accountLabel: usage.plan ? `Agent Plan ${usage.plan}` : 'Agent Plan',
    source: 'api',
    status: 'ok',
    updatedAt,
    windows: usage.windows,
    region: credentials.region
  });
}

async function fetchVolcengineLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const statusRow = (status) => normalizeLimitProvider({
    provider: 'volcengine',
    source: 'api',
    status,
    updatedAt,
    windows: [],
    ...(credentials ? { region: credentials.region } : {})
  });
  const credentials = volcengineCredentials(env, options);
  if (!credentials) return [statusRow('notConfigured')];

  const tryArkFallback = async () => {
    if (!credentials.apiKey) throw new Error('Volcengine Ark API key is not configured');
    return fetchVolcengineArkLimits(credentials, deps, now, updatedAt);
  };

  try {
    if (credentials.mode === 'ark') return [await tryArkFallback()];

    // Coding Plan and Agent Plan are independent subscriptions on the same
    // account, so query both and report whichever ones carry quota. Neither is
    // allowed to fail the other: an account with only one of them is normal.
    const agentCredentials = volcengineAgentCredentials(env, options);
    const [coding, agent] = await Promise.allSettled([
      fetchVolcengineCodingPlanLimits(credentials, deps, now, updatedAt),
      agentCredentials
        ? fetchVolcengineAgentPlanLimits(agentCredentials, deps, now, updatedAt)
        : Promise.resolve(null)
    ]);

    const agentRow = agent.status === 'fulfilled'
      ? agent.value
      : (agentCredentials?.explicit
        ? volcengineAgentFailureRow(agentCredentials, agent.reason, updatedAt)
        : null);
    const codingRow = coding.status === 'fulfilled' && coding.value.windows.length ? coding.value : null;
    if (codingRow) return agentRow ? [codingRow, agentRow] : [codingRow];

    if (agentRow) {
      // The Agent Plan answered, so a Coding lane with nothing to report is not
      // worth a row of its own — unless an Ark key can still answer for it.
      if (coding.status === 'rejected' && credentials.apiKey) {
        try {
          return [await tryArkFallback(), agentRow];
        } catch {
          return [agentRow];
        }
      }
      return [agentRow];
    }

    // Neither plan reported quota: keep the pre-Agent-Plan single-row behaviour
    // so existing Coding-Plan setups see exactly what they saw before.
    if (coding.status === 'rejected') {
      if (!credentials.apiKey) throw coding.reason;
      return [await tryArkFallback()];
    }
    return [coding.value];
  } catch (error) {
    return [statusRow(error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable')];
  }
}

async function fetchVolcengineCodingPlanLimits(credentials, deps, now, updatedAt) {
  const date = new Date(now);
  const signed = signVolcengineRequest({
    url: VOLCENGINE_CODING_PLAN_URL,
    method: 'POST',
    body: '',
    date,
    ...credentials
  });
  const { response, body } = await fetchJsonWithDeadline(VOLCENGINE_CODING_PLAN_URL, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body
  }, deps);
  if (!response.ok) {
    const error = new Error(`Volcengine Coding Plan returned ${response.status}`);
    error.status = response.status === 401 || response.status === 403
      ? 'unauthorized'
      : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
    throw error;
  }
  const usage = parseVolcengineCodingPlanUsage(body);
  return normalizeLimitProvider({
    provider: 'volcengine',
    accountKey: hashKey('volcengine', credentials.accessKeyId, credentials.region),
    accountLabel: usage.plan || 'Coding Plan',
    source: 'api',
    status: usage.windows.length ? 'ok' : 'unavailable',
    updatedAt: usage.updatedAt || updatedAt,
    windows: usage.windows,
    region: credentials.region
  });
}

async function fetchVolcengineArkLimits(credentials, deps, now, updatedAt) {
  let lastError = null;
  for (const model of VOLCENGINE_ARK_PROBE_MODELS) {
    const result = await probeVolcengineArkModel(credentials, deps, model, now);
    if (result.status === 403 || result.status === 404) {
      lastError = new Error(`Volcengine Ark probe model ${model} returned ${result.status}`);
      lastError.status = 'unavailable';
      continue;
    }
    if (result.status !== 200 && result.status !== 429) {
      const error = new Error(`Volcengine Ark returned ${result.status}`);
      error.status = result.status === 401 ? 'unauthorized' : result.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw error;
    }
    const usage = isAmbiguousVolcengineArkExhausted(result.status, result.usage)
      ? await confirmVolcengineArkExhausted(credentials, deps, model, now, result.usage)
      : result.usage;
    return normalizeLimitProvider({
      provider: 'volcengine',
      accountKey: hashKey('volcengine', credentials.apiKey, credentials.region),
      accountLabel: 'Ark API',
      source: 'api',
      status: usage.windows.length ? 'ok' : 'unavailable',
      updatedAt: usage.updatedAt || updatedAt,
      windows: usage.windows,
      region: credentials.region
    });
  }
  throw lastError || Object.assign(new Error('Volcengine Ark probe models failed'), { status: 'unavailable' });
}

async function probeVolcengineArkModel(credentials, deps, model, now) {
  const { response, body } = await fetchJsonWithDeadline(VOLCENGINE_ARK_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${credentials.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }]
    })
  }, deps);
  return {
    status: response.status,
    usage: parseVolcengineArkUsage({ headers: response.headers, body, now })
  };
}

async function confirmVolcengineArkExhausted(credentials, deps, model, now, initialUsage) {
  try {
    const confirmation = await probeVolcengineArkModel(credentials, deps, model, now);
    if (confirmation.status === 429) {
      return confirmation.usage.windows.length ? confirmation.usage : initialUsage;
    }
    if (isAmbiguousVolcengineArkExhausted(confirmation.status, confirmation.usage)) {
      return { updatedAt: confirmation.usage.updatedAt || new Date(now).toISOString(), windows: [] };
    }
    return confirmation.usage;
  } catch (_) {
    return initialUsage;
  }
}

module.exports = {
  VOLCENGINE_FETCH_TIMEOUT_MS,
  VOLCENGINE_CODING_PLAN_URL,
  VOLCENGINE_ARK_CHAT_COMPLETIONS_URL,
  volcengineCredentials,
  parseVolcengineArkUsage,
  parseVolcengineCodingPlanUsage,
  parseVolcengineAgentPlanUsage,
  signVolcengineRequest,
  fetchVolcengineLimits
};
