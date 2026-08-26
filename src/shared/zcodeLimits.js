'use strict';

// ZCode (GLM) plan quota lookup from the local ZCode CLI login.
//
// ZCode stores its provider credentials under ~/.zcode/v2: config.json holds
// the active provider's API key (a plain JWT for Start Plan, an API key for
// Coding Plan), credentials.json holds AES-256-GCM encrypted fallbacks, and
// setting.json / coding-plan-cache.json say which plan provider is selected or
// available. The quota endpoints reject requests that do not carry the ZCode
// client headers and an app_version, so those are always attached (upstream
// TokenTracker issue #279: missing client headers turn the balance endpoint
// into a 401/404).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');

const ZCODE_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_BILLING_BASE_URL = 'https://zcode.z.ai/api/v1/zcode-plan';
const DEFAULT_ZAI_MONITOR_BASE_URL = 'https://api.z.ai';
const DEFAULT_BIGMODEL_MONITOR_BASE_URL = 'https://bigmodel.cn';
const ZCODE_MONITOR_QUOTA_PATH = '/api/monitor/usage/quota/limit';
// The billing endpoint requires a client app_version even though the value is
// not used for accounting. CLI-only installs have no app bundle to read, so a
// conservative recent version is the fallback.
const DEFAULT_ZCODE_APP_VERSION = '3.2.5';

const ZCODE_ENV_TOKEN_NAMES = ['ZCODE_ACCESS_TOKEN', 'TOKEN_MONITOR_ZCODE_ACCESS_TOKEN'];
const ZCODE_PLAN_PROVIDER_KEYS = [
  'builtin:bigmodel-start-plan',
  'builtin:zai-start-plan',
  'builtin:bigmodel-coding-plan',
  'builtin:zai-coding-plan'
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

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 20_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Balance rows stamp period_end in seconds while coding-plan rows use
// nextResetTime in milliseconds; the magnitude check inside toIso handles both.
function secondsToIso(value) {
  const seconds = numberOrNull(value);
  if (seconds === null || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function clampPercent(value) {
  const parsed = numberOrNull(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(100, parsed));
}

function errorWithStatus(status, message) {
  const error = new Error(message || status);
  error.status = status;
  return error;
}

function resolveZcodeHome({ home, env = process.env } = {}) {
  for (const name of ['TOKEN_MONITOR_ZCODE_HOME', 'ZCODE_HOME']) {
    const raw = typeof env[name] === 'string' ? env[name].trim() : '';
    if (raw) return path.resolve(raw);
  }
  return path.join(home || os.homedir(), '.zcode');
}

function resolveZcodeAppVersion(env = process.env) {
  const raw = typeof env.TOKEN_MONITOR_ZCODE_APP_VERSION === 'string'
    ? env.TOKEN_MONITOR_ZCODE_APP_VERSION.trim()
    : '';
  return raw || DEFAULT_ZCODE_APP_VERSION;
}

function readJsonFile(filePath, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const existsSync = deps.existsSync || fs.existsSync;
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function zcodeConfigPath({ home, env } = {}) {
  return path.join(resolveZcodeHome({ home, env }), 'v2', 'config.json');
}

function zcodeSettingPath({ home, env } = {}) {
  return path.join(resolveZcodeHome({ home, env }), 'v2', 'setting.json');
}

function zcodeAvailabilityPath({ home, env } = {}) {
  return path.join(resolveZcodeHome({ home, env }), 'v2', 'coding-plan-cache.json');
}

function zcodeCredentialsPath({ home, env } = {}) {
  return path.join(resolveZcodeHome({ home, env }), 'v2', 'credentials.json');
}

function loadZcodeConfig({ home, env, ...deps } = {}) {
  const config = readJsonFile(zcodeConfigPath({ home, env }), deps);
  return config && typeof config === 'object' ? config : null;
}

// entryStatus.items maps each builtin plan provider to { status: "available" | ... }.
function loadZcodeProviderAvailability({ home, env, ...deps } = {}) {
  const cache = readJsonFile(zcodeAvailabilityPath({ home, env }), deps);
  const items = cache?.entryStatus?.items;
  return items && typeof items === 'object' ? items : {};
}

// setting.json records the selected plan as e.g. {"zai":"coding-plan:builtin:zai-start-plan"}.
function loadZcodeSelectedPlanProviderKeys({ home, env, ...deps } = {}) {
  const setting = readJsonFile(zcodeSettingPath({ home, env }), deps);
  const selected = setting?.modelProviderFamilySelectedKeys;
  if (!selected || typeof selected !== 'object') return [];
  const domain = typeof setting?.providerFamilyDomain === 'string' ? setting.providerFamilyDomain : '';
  const domains = [domain, ...Object.keys(selected)].filter(Boolean);
  const out = [];
  for (const key of domains) {
    const raw = typeof selected[key] === 'string' ? selected[key].trim() : '';
    const match = raw.match(/builtin:(?:bigmodel|zai)-(?:start|coding)-plan/);
    if (match && !out.includes(match[0])) out.push(match[0]);
  }
  return out;
}

function createZcodeCredentialSecret({ home, env = process.env } = {}) {
  if (typeof env.ZCODE_CREDENTIAL_SECRET === 'string' && env.ZCODE_CREDENTIAL_SECRET) {
    return env.ZCODE_CREDENTIAL_SECRET;
  }
  let username;
  try {
    username = os.userInfo().username || '';
  } catch (_) {
    username = '';
  }
  return `zcode-credential-fallback:${process.platform}:${home || os.homedir()}:${username}`;
}

// Credential values are either plaintext or "enc:v1:{iv}.{tag}.{ciphertext}"
// (base64url parts) sealed with AES-256-GCM under a machine-local key.
function decryptZcodeCredentialValue(value, { home, env = process.env } = {}) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('enc:v1:')) return value;
  const parts = value.slice('enc:v1:'.length).split('.');
  if (parts.length !== 3) return null;
  try {
    const [ivPart, tagPart, encryptedPart] = parts;
    const key = crypto.createHash('sha256')
      .update(createZcodeCredentialSecret({ home, env }))
      .digest();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivPart, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedPart, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch (_) {
    return null;
  }
}

function loadZcodeCredential(name, { home, env, ...deps } = {}) {
  const credentials = readJsonFile(zcodeCredentialsPath({ home, env }), deps);
  const decrypted = decryptZcodeCredentialValue(credentials?.[name], { home, env });
  return typeof decrypted === 'string' && decrypted.trim() ? decrypted.trim() : '';
}

function isZcodeCodingPlanProvider(providerKey) {
  return /^builtin:(bigmodel|zai)-coding-plan$/.test(providerKey);
}

// The credentials.json fallback applies to Start Plan providers whose oauth
// domain matches the active provider recorded there.
function resolveZcodeCredentialAuth(providerKey, { home, env, ...deps } = {}) {
  const activeProvider = loadZcodeCredential('oauth:active_provider', { home, env, ...deps });
  if (
    (providerKey === 'builtin:zai-start-plan' && activeProvider === 'zai')
    || (providerKey === 'builtin:bigmodel-start-plan' && activeProvider === 'bigmodel')
  ) {
    return loadZcodeCredential('zcodejwttoken', { home, env, ...deps });
  }
  return '';
}

function zcodeEnvToken(env = process.env) {
  for (const name of ZCODE_ENV_TOKEN_NAMES) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function zcodeQuotaUrl(providerKey) {
  const origin = providerKey === 'builtin:bigmodel-coding-plan'
    ? DEFAULT_BIGMODEL_MONITOR_BASE_URL
    : DEFAULT_ZAI_MONITOR_BASE_URL;
  return `${origin}${ZCODE_MONITOR_QUOTA_PATH}`;
}

// Ordered plan provider candidates: the selected provider first, then any the
// ZCode cache reports as available, then the default order.
function orderedZcodePlanProviderKeys(availability, selected) {
  const available = ZCODE_PLAN_PROVIDER_KEYS.filter((key) => availability?.[key]?.status === 'available');
  return [...selected, ...available, ...ZCODE_PLAN_PROVIDER_KEYS]
    .filter((key) => ZCODE_PLAN_PROVIDER_KEYS.includes(key))
    .filter((key, index, all) => all.indexOf(key) === index);
}

function loadZcodeAuthCandidates({ home, env = process.env, ...deps } = {}) {
  const config = loadZcodeConfig({ home, env, ...deps });
  const providers = config?.provider && typeof config.provider === 'object' ? config.provider : {};
  const availability = loadZcodeProviderAvailability({ home, env, ...deps });
  const hasAvailability = Object.keys(availability).length > 0;
  const selected = loadZcodeSelectedPlanProviderKeys({ home, env, ...deps });
  const candidates = [];
  for (const key of orderedZcodePlanProviderKeys(availability, selected)) {
    const provider = providers[key];
    if (!provider || typeof provider !== 'object') continue;
    if (provider.enabled === false) continue;
    if (hasAvailability && availability?.[key]?.status && availability[key].status !== 'available') continue;
    const configApiKey = cleanSecret(provider?.options?.apiKey);
    let apiKey = configApiKey;
    let authSource = 'provider:config';
    if (!apiKey) {
      apiKey = resolveZcodeCredentialAuth(key, { home, env, ...deps });
      authSource = 'credential:zcodejwttoken';
    }
    if (!apiKey) continue;
    candidates.push({
      apiKey,
      authSource,
      providerKey: key,
      planKind: isZcodeCodingPlanProvider(key) ? 'coding-plan' : 'start-plan'
    });
  }
  if (!candidates.length) {
    // Headless/CLI deployments have no local ZCode login; an env token still
    // allows quota lookup against the default Start Plan billing endpoint.
    const envToken = zcodeEnvToken(env);
    if (envToken) {
      candidates.push({
        apiKey: envToken,
        authSource: 'env',
        providerKey: 'builtin:zai-start-plan',
        planKind: 'start-plan'
      });
    }
  }
  return candidates;
}

function buildZcodeSourceHeaders(env = process.env) {
  const appVersion = resolveZcodeAppVersion(env);
  return {
    'User-Agent': `ZCode/${appVersion}`,
    'HTTP-Referer': 'https://zcode.z.ai/',
    'X-ZCode-App-Version': appVersion,
    'X-Release-Channel': 'stable'
  };
}

// The balance endpoint needs the app_version query parameter and the ZCode
// client headers; without them the API answers 401/404 (TokenTracker #279).
function zcodeBillingUrl(env = process.env) {
  const url = new URL(`${DEFAULT_BILLING_BASE_URL}/billing/balance`);
  url.searchParams.set('app_version', resolveZcodeAppVersion(env));
  return url.toString();
}

async function fetchZcodeBilling(apiKey, deps = {}) {
  const env = deps.env || process.env;
  const deadlineMs = Number(deps.zcodeFetchTimeoutMs || deps.fetchTimeoutMs || ZCODE_FETCH_TIMEOUT_MS);
  const platform = deps.platform || process.platform;
  return runWithProbeDeadline(async ({ signal }) => {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...buildZcodeSourceHeaders(env),
      'X-Platform': platform,
      'X-Os-Category': platform,
      'X-Os-Version': deps.osRelease || os.release(),
      'X-Client-Language': Intl.DateTimeFormat().resolvedOptions().locale || 'en-US',
      'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    };
    const response = await (deps.fetch || fetch)(zcodeBillingUrl(env), {
      method: 'GET',
      headers,
      signal
    });
    return responseWithBody(response, 'ZCode billing API');
  }, { signal: deps.signal, deadlineMs });
}

// The coding-plan quota endpoint takes the API key raw (no Bearer prefix).
async function fetchZcodeCodingPlanQuota(apiKey, providerKey, deps = {}) {
  const deadlineMs = Number(deps.zcodeFetchTimeoutMs || deps.fetchTimeoutMs || ZCODE_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(async ({ signal }) => {
    const response = await (deps.fetch || fetch)(zcodeQuotaUrl(providerKey), {
      method: 'GET',
      headers: {
        authorization: apiKey,
        Accept: 'application/json'
      },
      signal
    });
    return responseWithBody(response, 'ZCode coding plan API');
  }, { signal: deps.signal, deadlineMs });
}

async function responseWithBody(response, label) {
  if (response.status === 401 || response.status === 403) {
    throw errorWithStatus('unauthorized', `${label} is not authenticated. Run zcode in a terminal to log in.`);
  }
  let body;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }
  if (!response.ok) {
    const code = body?.code != null ? ` code=${body.code}` : '';
    const msg = body?.msg || body?.message ? ` msg=${body.msg || body.message}` : '';
    throw errorWithStatus(
      response.status === 429 ? 'sourceRateLimited' : 'unavailable',
      `${label} returned ${response.status}${code}${msg}`
    );
  }
  return body;
}

// Plan ids look like "zcode-v3-start-plan-0615"; only the human tier reads
// well as an account label.
function zcodePlanLabel(planId) {
  const match = String(planId || '').toLowerCase().match(/\b(lite|start|pro|max|team|enterprise)\b/);
  if (!match) return '';
  return match[1].charAt(0).toUpperCase() + match[1].slice(1);
}

// Start Plan balance rows are per-model daily unit grants; each becomes its own
// billing window labeled with the model name.
function parseZcodeBalance(body) {
  const data = body?.data;
  if (!data || typeof data !== 'object') {
    throw errorWithStatus('unavailable', 'Could not parse ZCode balance: missing data');
  }
  const apiCode = numberOrNull(body.code);
  if (apiCode !== null && apiCode !== 0) {
    throw errorWithStatus('unavailable', `ZCode billing API error: code=${apiCode} msg=${body?.msg || 'unknown'}`);
  }
  const balances = Array.isArray(data.balances) ? data.balances : [];
  const windows = [];
  for (const balance of balances) {
    if (!balance || typeof balance !== 'object') continue;
    const limit = numberOrNull(balance.total_units);
    const used = numberOrNull(balance.used_units);
    const remaining = numberOrNull(balance.remaining_units);
    let usedPercent = null;
    if (limit !== null && limit > 0 && used !== null) {
      usedPercent = (used / limit) * 100;
    } else if (limit !== null && limit > 0 && remaining !== null) {
      usedPercent = ((limit - remaining) / limit) * 100;
    }
    if (usedPercent === null) continue;
    const window = {
      kind: 'billing',
      label: String(balance.show_name || '').trim() || 'Start plan',
      used,
      limit,
      remaining,
      usedPercent,
      resetsAt: secondsToIso(numberOrNull(balance.period_end) ?? numberOrNull(balance.expires_at)),
      showMeter: true
    };
    windows.push(window);
  }
  windows.sort((a, b) => (b.limit || 0) - (a.limit || 0));
  const planId = typeof balances[0]?.plan_id === 'string' ? balances[0].plan_id : '';
  return { accountLabel: zcodePlanLabel(planId), planId, windows };
}

// Window encoding shared with the z.ai quota API: unit 5 = minutes, 3 = hours,
// 1 = days, 6 = weeks.
function zcodeWindowMinutes(unit, number) {
  if (!Number.isFinite(unit) || !Number.isFinite(number) || number <= 0) return null;
  if (unit === 5) return number;
  if (unit === 3) return number * 60;
  if (unit === 1) return number * 24 * 60;
  if (unit === 6) return number * 7 * 24 * 60;
  return null;
}

// Coding-plan rows expose `percentage` as the already-used percent. `unit` and
// `number` identify the window (5h / weekly / tools), not a token total, so
// used/limit are only reported when percentage is absent — deriving the meter
// from usage/number would turn an unused TIME_LIMIT (usage=100, number=1) into
// a false 100% bar.
function zcodeQuotaWindow(limit, { kind, label, windowMinutes = null }) {
  const percentage = numberOrNull(limit?.percentage);
  const total = numberOrNull(limit?.number);
  const used = numberOrNull(limit?.usage) ?? numberOrNull(limit?.currentValue);
  const remaining = numberOrNull(limit?.remaining);
  let usedPercent = null;
  if (percentage !== null) {
    usedPercent = percentage;
  } else if (total !== null && total > 0 && used !== null) {
    usedPercent = (used / total) * 100;
  } else if (total !== null && total > 0 && remaining !== null) {
    usedPercent = ((total - remaining) / total) * 100;
  }
  const percent = clampPercent(usedPercent);
  if (percent === null) return null;
  const window = {
    kind,
    label,
    usedPercent: percent,
    resetsAt: toIso(limit?.nextResetTime),
    showMeter: true
  };
  if (percentage === null) {
    window.used = used;
    window.limit = total;
    window.remaining = remaining;
  }
  if (windowMinutes !== null) window.windowMinutes = windowMinutes;
  return window;
}

function findZcodeQuotaLimit(limits, type, unit, number = null) {
  if (!Array.isArray(limits)) return null;
  return limits.find((limit) => {
    if (!limit || typeof limit !== 'object') return false;
    if (limit.type !== type) return false;
    if (numberOrNull(limit.unit) !== unit) return false;
    return number === null || numberOrNull(limit.number) === number;
  }) || null;
}

// Matches ZCode's own sidebar: TOKENS_LIMIT(unit=3,number=5)=5h,
// TOKENS_LIMIT(unit=6)=weekly, TIME_LIMIT(unit=5,number=1)=tool calls.
function parseZcodeCodingPlanQuota(body) {
  const apiCode = numberOrNull(body?.code);
  if (apiCode !== null && apiCode !== 0 && apiCode !== 200) {
    throw errorWithStatus('unavailable', `ZCode coding plan API error: code=${apiCode} msg=${body?.msg || body?.message || 'unknown'}`);
  }
  if (body?.success === false) {
    throw errorWithStatus('unavailable', `ZCode coding plan API error: msg=${body?.msg || body?.message || 'unknown'}`);
  }
  const data = body?.data;
  if (!data || typeof data !== 'object') {
    throw errorWithStatus('unavailable', 'Could not parse ZCode coding plan quota: missing data');
  }
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const fiveHour = findZcodeQuotaLimit(limits, 'TOKENS_LIMIT', 3, 5);
  const weekly = findZcodeQuotaLimit(limits, 'TOKENS_LIMIT', 6);
  const tools = findZcodeQuotaLimit(limits, 'TIME_LIMIT', 5, 1);
  let windows;
  if (fiveHour || weekly || tools) {
    const weeklyMinutes = weekly ? zcodeWindowMinutes(numberOrNull(weekly.unit), numberOrNull(weekly.number)) : null;
    windows = [
      fiveHour ? zcodeQuotaWindow(fiveHour, { kind: 'session', label: '5-hour', windowMinutes: 5 * 60 }) : null,
      weekly ? zcodeQuotaWindow(weekly, { kind: 'weekly', label: 'Weekly', windowMinutes: weeklyMinutes }) : null,
      tools ? zcodeQuotaWindow(tools, { kind: 'billing', label: 'Tools' }) : null
    ].filter(Boolean);
  } else {
    // Unknown window encodings still render: token windows map to the session
    // or weekly kind by their span, time windows to billing.
    windows = limits.map((limit) => {
      const minutes = zcodeWindowMinutes(numberOrNull(limit?.unit), numberOrNull(limit?.number));
      const type = String(limit?.type || '').toUpperCase();
      const kind = type === 'TIME_LIMIT' || minutes === null
        ? 'billing'
        : minutes <= 6 * 60 ? 'session' : 'weekly';
      const detail = Array.isArray(limit?.usageDetails)
        ? limit.usageDetails.find((item) => item && typeof item === 'object')
        : null;
      const label = String(detail?.displayName || detail?.modelCode || limit?.type || 'Coding plan').trim();
      return zcodeQuotaWindow(limit, { kind, label, windowMinutes: minutes });
    }).filter(Boolean);
  }
  const level = typeof data.level === 'string' ? data.level.trim() : '';
  return { accountLabel: zcodePlanLabel(level) || level, planId: level, windows };
}

async function fetchZcodeLimits(_options = {}, deps = {}) {
  const env = deps.env || process.env;
  const nowMs = (deps.now || Date.now)();
  const updatedAt = new Date(nowMs).toISOString();
  const home = deps.home || os.homedir();
  const candidates = loadZcodeAuthCandidates({ home, env, ...deps });
  if (!candidates.length) {
    return normalizeLimitProvider({
      provider: 'zcode',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }
  const errors = [];
  let emptyWindows = null;
  for (const auth of candidates) {
    try {
      const body = auth.planKind === 'coding-plan'
        ? await fetchZcodeCodingPlanQuota(auth.apiKey, auth.providerKey, deps)
        : await fetchZcodeBilling(auth.apiKey, deps);
      const parsed = auth.planKind === 'coding-plan'
        ? parseZcodeCodingPlanQuota(body)
        : parseZcodeBalance(body);
      if (!parsed.windows.length && candidates.length > 1) {
        emptyWindows = emptyWindows || { auth, parsed };
        continue;
      }
      return normalizeLimitProvider({
        provider: 'zcode',
        accountKey: hashKey('zcode', auth.apiKey),
        accountLabel: parsed.accountLabel,
        source: 'api',
        status: parsed.windows.length ? 'ok' : 'unavailable',
        updatedAt,
        windows: parsed.windows
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (emptyWindows) {
    return normalizeLimitProvider({
      provider: 'zcode',
      accountKey: hashKey('zcode', emptyWindows.auth.apiKey),
      accountLabel: emptyWindows.parsed.accountLabel,
      source: 'api',
      status: 'unavailable',
      updatedAt,
      windows: []
    });
  }
  const first = errors[0];
  return normalizeLimitProvider({
    provider: 'zcode',
    source: 'api',
    status: first?.status === 'timeout' ? 'unavailable' : first?.status || 'unavailable',
    updatedAt,
    windows: []
  });
}

module.exports = {
  ZCODE_FETCH_TIMEOUT_MS,
  DEFAULT_ZCODE_APP_VERSION,
  zcodeEnvToken,
  resolveZcodeHome,
  resolveZcodeAppVersion,
  zcodeBillingUrl,
  zcodeQuotaUrl,
  decryptZcodeCredentialValue,
  loadZcodeCredential,
  loadZcodeAuthCandidates,
  loadZcodeSelectedPlanProviderKeys,
  loadZcodeProviderAvailability,
  zcodePlanLabel,
  parseZcodeBalance,
  parseZcodeCodingPlanQuota,
  fetchZcodeLimits
};
